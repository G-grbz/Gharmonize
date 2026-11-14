import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawnSync } from 'node:child_process'
import express from 'express'
import { tmpDir, silentLogger } from './fixtures/playerAudio.mjs'

import { normalizePlayerListen, normalizePlayerPort, getPlayerListenConfig, createPlayerGate } from '../modules/player/gate.js'
import { classifyRequest, isNetworkAllowed } from '../modules/player/network.js'
import { parseStatus, parseServeStatus, interfaceTailscaleIps, createTailscaleProbe } from '../modules/player/tailscale.js'
import { buildConnectInfo, lanAddresses, normalizePublicUrl, isLoopbackHost } from '../modules/player/connect.js'
import { startPlayerService, normalizeConfig } from '../modules/player/service.js'
import { createPlayerRouter } from '../modules/player/router.js'
import { qrMatrix } from '../public/player/js/qr.js'

const IFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  eth0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }, { address: 'fd7a:115c:a1e0::1', family: 'IPv6', internal: false }]
}

const TS_STATUS = JSON.stringify({
  BackendState: 'Running',
  Self: { HostName: 'homebox', DNSName: 'homebox.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'], Online: true },
  CurrentTailnet: { Name: 'user@example.com', MagicDNSEnabled: true }
})

const fakeReq = (headers = {}, ip = '127.0.0.1') => ({ ip, socket: { remoteAddress: ip }, protocol: 'http', get: (name) => headers[String(name).toLowerCase()] })

// ---------------------------------------------------------------------------

test('listener settings normalize to safe values', () => {
  assert.equal(normalizePlayerListen('on'), '1')
  assert.equal(normalizePlayerListen('maybe'), '0')
  assert.equal(normalizePlayerPort('8080'), '8080')
  assert.equal(normalizePlayerPort('80'), '5175', 'privileged ports are refused')
  assert.equal(normalizePlayerPort('70000'), '5175')
  assert.equal(normalizePlayerPort('abc'), '5175')
  assert.deepEqual(getPlayerListenConfig({}), { enabled: false, port: 5175, host: '0.0.0.0' })
  assert.deepEqual(getPlayerListenConfig({ GHARMONIZE_PLAYER_LISTEN: '1', GHARMONIZE_PLAYER_PORT: '6000' }), { enabled: true, port: 6000, host: '0.0.0.0' })
})

test('Tailscale Funnel traffic counts as internet traffic, not home or tailnet', () => {
  assert.equal(classifyRequest(fakeReq({}, '127.0.0.1')), 'loopback')
  assert.equal(classifyRequest(fakeReq({}, '100.101.1.2')), 'tailscale')
  // Funnel proxies through tailscaled on loopback but marks the request.
  const funnel = fakeReq({ 'tailscale-funnel-request': '?1' }, '127.0.0.1')
  assert.equal(classifyRequest(funnel), 'public')
  assert.equal(isNetworkAllowed(classifyRequest(funnel), 'tailscale'), false)
  assert.equal(isNetworkAllowed(classifyRequest(funnel), 'any'), true)
})

test('tailscale status and serve output are parsed', () => {
  const status = parseStatus(TS_STATUS)
  assert.equal(status.running, true)
  assert.equal(status.dnsName, 'homebox.tail1234.ts.net')
  assert.equal(status.tailnet, 'user@example.com')
  assert.deepEqual(status.ips, ['100.101.102.103', 'fd7a:115c:a1e0::1'])
  assert.equal(parseStatus('not json'), null)

  const serve = parseServeStatus(JSON.stringify({
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: {
      'homebox.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:5175' } } },
      'homebox.tail1234.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:9999' } } }
    },
    AllowFunnel: { 'homebox.tail1234.ts.net:443': true }
  }), [5174, 5175])
  assert.deepEqual(serve.serve, ['https://homebox.tail1234.ts.net'])
  assert.deepEqual(serve.funnel, ['https://homebox.tail1234.ts.net'])
  assert.deepEqual(interfaceTailscaleIps(IFACES), ['100.101.102.103', 'fd7a:115c:a1e0::1'])
})

test('tailscale probe uses the CLI when present and caches the answer', async () => {
  const calls = []
  const runImpl = async (file, args) => {
    calls.push(`${file} ${args.join(' ')}`)
    if (file !== 'tailscale') return { ok: false, code: 'ENOENT', stdout: '' }
    if (args[0] === 'version') return { ok: true, stdout: '1.80.0' }
    if (args[0] === 'status') return { ok: true, stdout: TS_STATUS }
    return { ok: true, stdout: '{}' }
  }
  const probe = createTailscaleProbe({ runImpl, interfacesImpl: () => ({}), isDocker: () => false })
  const first = await probe.get([5174])
  assert.equal(first.running, true)
  assert.equal(first.cli, true)
  assert.equal(first.dnsName, 'homebox.tail1234.ts.net')
  const count = calls.length
  await probe.get([5174])
  assert.equal(calls.length, count, 'second call is served from cache')
  await probe.get([5174], { fresh: true })
  assert.ok(calls.length > count)

  const none = createTailscaleProbe({ runImpl: async () => ({ ok: false, code: 'ENOENT', stdout: '' }), interfacesImpl: () => IFACES, isDocker: () => false })
  const viaIface = await none.get([])
  assert.equal(viaIface.cli, false)
  assert.equal(viaIface.detected, true, 'interface address alone is enough to detect Tailscale')
  assert.deepEqual(viaIface.ips, ['100.101.102.103', 'fd7a:115c:a1e0::1'])
})

test('connection info lists reachable addresses and explains what is missing', () => {
  assert.deepEqual(lanAddresses(IFACES), ['192.168.1.20'], 'docker bridges, tailscale and loopback are skipped')
  assert.equal(isLoopbackHost('localhost'), true)
  assert.equal(isLoopbackHost('[::1]'), true)
  assert.equal(normalizePublicUrl('https://music.example.com/player/'), 'https://music.example.com')
  assert.equal(normalizePublicUrl('ftp://x'), null)
  assert.equal(normalizePublicUrl('https://user:pw@x.com'), null)

  const tailscale = { running: true, ips: ['100.101.102.103', 'fd7a:115c:a1e0::1'], dnsName: 'homebox.tail1234.ts.net', serveUrls: [], funnelUrls: [] }

  // Desktop: Gharmonize on 127.0.0.1, player port off → phones cannot connect.
  const local = buildConnectInfo({ req: fakeReq({ host: '127.0.0.1:5174' }), main: { host: '127.0.0.1', port: 5174 }, listener: { enabled: false, listening: false, port: 5175 }, tailscale, remoteAccess: 'off', interfaces: IFACES })
  assert.deepEqual(local.addresses, [])
  assert.ok(local.warnings.includes('LOCAL_ONLY'))
  assert.ok(local.warnings.includes('TAILSCALE_UNREACHABLE'))
  assert.ok(local.warnings.includes('REMOTE_OFF'))

  // Desktop with the player port on: LAN + Tailscale through port 5175.
  const lan = buildConnectInfo({ req: fakeReq({ host: '127.0.0.1:5174' }), main: { host: '127.0.0.1', port: 5174 }, listener: { enabled: true, listening: true, port: 5175 }, tailscale, remoteAccess: 'tailscale', interfaces: IFACES, publicUrls: ['https://music.example.com'] })
  const byUrl = Object.fromEntries(lan.addresses.map((a) => [a.url, a]))
  assert.equal(lan.addresses[0].url, 'http://192.168.1.20:5175')
  assert.equal(byUrl['http://192.168.1.20:5175'].blocked, false)
  assert.equal(byUrl['http://homebox.tail1234.ts.net:5175'].kind, 'tailscale-dns')
  assert.equal(byUrl['http://100.101.102.103:5175'].blocked, false)
  assert.equal(byUrl['https://music.example.com'].blocked, true, 'an internet address needs the "any" mode')
  assert.equal(lan.warnings.length, 0)

  // Docker: container addresses are useless; the address the browser used is kept.
  const docker = buildConnectInfo({ req: fakeReq({ host: '192.168.1.50:5174' }), main: { host: '0.0.0.0', port: 5174 }, listener: { enabled: false, listening: false, port: 5175 }, tailscale: null, remoteAccess: 'off', interfaces: { eth0: [{ address: '172.18.0.5', family: 'IPv4', internal: false }] }, docker: true })
  assert.deepEqual(docker.addresses.map((a) => [a.url, a.kind]), [['http://192.168.1.50:5174', 'current']])
  assert.equal(docker.warnings.includes('LOCAL_ONLY'), false)

  // Tailscale serve gives an HTTPS address even without a direct port.
  const served = buildConnectInfo({ main: { host: '127.0.0.1', port: 5174 }, listener: null, tailscale: { ...tailscale, serveUrls: ['https://homebox.tail1234.ts.net'], funnelUrls: ['https://homebox.tail1234.ts.net'] }, remoteAccess: 'tailscale', interfaces: {} })
  assert.equal(served.addresses[0].kind, 'tailscale-https')
  assert.equal(served.addresses[0].funnel, true)
  assert.ok(served.warnings.includes('FUNNEL_BLOCKED'))
})

test('custom public addresses are validated and capped', () => {
  const cfg = normalizeConfig({ publicUrls: 'https://a.example.com\nnot-a-url http://100.1.2.3:5174 https://a.example.com/' })
  assert.deepEqual(cfg.publicUrls, ['https://a.example.com', 'http://100.1.2.3:5174'])
  assert.equal(normalizeConfig({ publicUrls: Array.from({ length: 9 }, (_, i) => `https://h${i}.example.com`) }).publicUrls.length, 5)
})

// ---------------------------------------------------------------------------
// Player-only listener + QR sign-in

async function startService(t, env) {
  const root = tmpDir('remote')
  const downloads = path.join(root, 'outputs')
  fs.mkdirSync(downloads, { recursive: true })
  const service = await startPlayerService({
    env,
    logger: silentLogger,
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    defaultLibraryDir: downloads,
    initialScanDelayMs: -1,
    // Port 0 = any free port for the test.
    listenerOptions: { getConfig: () => ({ enabled: env.GHARMONIZE_PLAYER_LISTEN === '1', port: 0, host: '127.0.0.1' }) },
    tailscaleProbe: { get: async () => ({ cli: false, docker: false, detected: false, running: false, ips: [], serveUrls: [], funnelUrls: [] }) },
    // Keep the real Gharmonize settings module (and its .env) out of tests.
    routerOptions: { adminBridge: () => ({ getSession: () => false, verifyPassword: () => false }), getMode: () => 'off' }
  })
  t.after(async () => {
    await service.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return service
}

test('the player-only listener serves the player and nothing else of Gharmonize', async (t) => {
  const env = { GHARMONIZE_PLAYER_LISTEN: '1' }
  const service = await startService(t, env)
  const status = service.context.listener.status()
  assert.equal(status.listening, true)
  const base = `http://127.0.0.1:${status.port}`

  const page = await fetch(`${base}/player/`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /Gharmonize Player/)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  const redirect = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), '/player/')
  assert.equal((await fetch(`${base}/lang/tr.json`)).status, 200)
  assert.equal((await fetch(`${base}/i18n.js`)).status, 200)
  const api = await fetch(`${base}/api/player/status`)
  assert.equal(api.status, 200)
  assert.equal((await api.json()).setupRequired, true)
  // The downloader UI and API are not reachable through this port.
  for (const blocked of ['/index.html', '/ytlive.html', '/api/settings', '/api/jobs', '/ui/main.js', '/player/../index.html']) {
    assert.equal((await fetch(base + blocked)).status, 404, blocked)
  }
  // Cross-site state changes are refused.
  const csrf = await fetch(`${base}/api/player/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' })
  assert.equal(csrf.status, 403)

  // Turning the setting off closes the port.
  env.GHARMONIZE_PLAYER_LISTEN = '0'
  await service.applyNetworkSettings()
  assert.equal(service.context.listener.status().listening, false)
  await assert.rejects(fetch(`${base}/player/`))
})

test('gate refreshNetwork re-applies listener settings on the running service', async () => {
  let applied = 0
  const before = process.env.GHARMONIZE_PLAYER_ENABLED
  process.env.GHARMONIZE_PLAYER_ENABLED = '1'
  const gate = createPlayerGate({
    logger: silentLogger,
    loadService: async () => ({ startPlayerService: async () => ({ router: (_q, r) => r.end(), stop: async () => {}, applyNetworkSettings: async () => { applied += 1 } }) })
  })
  try {
    await gate.refreshNetwork()
    assert.equal(applied, 0, 'nothing to refresh before start')
    await gate.sync()
    await gate.refreshNetwork()
    assert.equal(applied, 1)
  } finally {
    await gate.stop()
    if (before === undefined) delete process.env.GHARMONIZE_PLAYER_ENABLED
    else process.env.GHARMONIZE_PLAYER_ENABLED = before
  }
})

test('a pairing QR link signs a browser in with a session; apps get a device token', async (t) => {
  const service = await startService(t, {})
  const { auth } = service.context
  const user = auth.createUser({ username: 'ayse', password: 'Ayse12345' })
  const router = createPlayerRouter(service.context, { adminBridge: () => ({ getSession: () => false, verifyPassword: () => false }), getMode: () => 'off' })
  const app = express()
  app.use(express.json())
  app.use('/api/player', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/api/player`
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

  // A URL code is only a credential to verify, never proof of a session.
  const invalid = await post('/pair', { code: 'ABCD2349', client: 'web' })
  assert.equal(invalid.status, 401)
  assert.equal(invalid.headers.get('set-cookie'), null)
  assert.equal((await fetch(`${base}/me`)).status, 401)
  assert.equal(auth.listTokens(user.id).length, 0)

  const webCode = auth.createPairingCode(user.id).code
  const web = await post('/pair', { code: webCode, client: 'web', deviceName: 'Chrome · Android' })
  assert.equal(web.status, 200)
  const body = await web.json()
  assert.equal(body.token, undefined, 'the browser never sees the raw token')
  const cookie = (web.headers.get('set-cookie') || '').match(/gharmonize_player_session=[^;]+/)?.[0]
  assert.ok(cookie)
  const me = await fetch(`${base}/me`, { headers: { cookie } })
  assert.equal(me.status, 200)
  const meBody = await me.json()
  assert.equal(meBody.user.username, 'ayse')
  const session = meBody.devices.find((d) => d.id === meBody.currentDeviceId)
  assert.equal(session.kind, 'session')
  assert.ok(session.expiresAt, 'web pairings expire like normal sessions')
  assert.equal(session.name, 'Chrome · Android')

  // A code works once.
  assert.equal((await post('/pair', { code: webCode, client: 'web' })).status, 401)

  const appCode = auth.createPairingCode(user.id).code
  const appRes = await post('/pair', { code: appCode, deviceName: 'Pixel', platform: 'android' })
  const appBody = await appRes.json()
  assert.match(appBody.token, /^ghp_/)
  const viaToken = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${appBody.token}` } })
  assert.equal(viaToken.status, 200)

  const connect = await fetch(`${base}/connect`, { headers: { cookie } })
  assert.equal(connect.status, 200)
  assert.ok(Array.isArray((await connect.json()).addresses))
})

// ---------------------------------------------------------------------------
// QR encoder

function pngOf(modules, scale = 4, border = 4) {
  const n = modules.length
  const dim = (n + border * 2) * scale
  const raw = Buffer.alloc((dim + 1) * dim, 255)
  for (let y = 0; y < dim; y++) {
    raw[y * (dim + 1)] = 0
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / scale) - border
      const my = Math.floor(y / scale) - border
      if (mx >= 0 && my >= 0 && mx < n && my < n && modules[my][mx]) raw[y * (dim + 1) + 1 + x] = 0
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(dim, 0); ihdr.writeUInt32BE(dim, 4); ihdr[8] = 8
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

test('QR encoder picks the right version and draws the fixed patterns', () => {
  const small = qrMatrix('A')
  assert.equal(small.length, 21, 'version 1')
  const link = qrMatrix('http://192.168.1.20:5175/player/#/pair?code=ABCD2345&s=Gharmonize%20Player&alt=http%3A%2F%2F100.101.102.103%3A5175')
  assert.ok(link.length >= 37 && link.length <= 57)
  // Finder pattern corners and timing pattern.
  for (const [x, y] of [[0, 0], [link.length - 1, 0], [0, link.length - 1]]) assert.equal(link[y][x], true)
  for (let i = 8; i < link.length - 8; i++) assert.equal(link[6][i], i % 2 === 0)
  assert.throws(() => qrMatrix('x'.repeat(3000)), /too long/)
})

const HAS_ZBAR = spawnSync('zbarimg', ['--version'], { stdio: 'ignore' }).status === 0
test('QR codes decode back to the same text', { skip: !HAS_ZBAR && 'zbarimg not installed' }, () => {
  const dir = tmpDir('qr')
  try {
    const samples = ['http://192.168.1.20:5175/player/#/pair?code=ABCD2345', 'Gharmonize Player ğüşıöç İ 🎧', 'y'.repeat(400)]
    for (const text of samples) {
      const file = path.join(dir, 'qr.png')
      fs.writeFileSync(file, pngOf(qrMatrix(text)))
      const out = spawnSync('zbarimg', ['--raw', '-q', file], { encoding: 'utf8' })
      assert.equal(out.stdout.replace(/\n$/, ''), text)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
