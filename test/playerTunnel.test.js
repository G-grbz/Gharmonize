import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { tmpDir, silentLogger } from './fixtures/playerAudio.mjs'

import { normalizeRemoteAccessMode, normalizeTunnelMode, normalizeTunnelToken, normalizeTunnelUrl, getTunnelConfig } from '../modules/player/gate.js'
import { classifyRequest, isNetworkAllowed } from '../modules/player/network.js'
import { cloudflaredAsset, parseQuickTunnelUrl, createTunnel, ensureCloudflared, spawnArgs } from '../modules/player/cloudflared.js'
import { spawn } from 'node:child_process'
import { buildConnectInfo } from '../modules/player/connect.js'
import { startPlayerService } from '../modules/player/service.js'

const fakeReq = (headers = {}, ip = '127.0.0.1', extra = {}) => ({ ip, socket: { remoteAddress: ip }, protocol: 'https', get: (n) => headers[String(n).toLowerCase()], ...extra })

test('tunnel settings normalize safely', () => {
  assert.equal(normalizeRemoteAccessMode('TUNNEL'), 'tunnel')
  assert.equal(normalizeTunnelMode('token'), 'token')
  assert.equal(normalizeTunnelMode('whatever'), 'quick')
  assert.equal(normalizeTunnelToken('short'), '')
  assert.equal(normalizeTunnelToken('eyJhIjoiYWJjZGVmZ2hpamtsbW5vcCJ9'), 'eyJhIjoiYWJjZGVmZ2hpamtsbW5vcCJ9')
  assert.equal(normalizeTunnelToken('bad token with spaces and stuff'), '')
  assert.equal(normalizeTunnelUrl('muzik.example.com/player'), 'https://muzik.example.com')
  assert.equal(normalizeTunnelUrl('http://muzik.example.com'), '', 'only https')
  assert.deepEqual(getTunnelConfig({}), { enabled: false, mode: 'quick', token: '', publicUrl: '', port: 5185 })
  assert.equal(getTunnelConfig({ GHARMONIZE_PLAYER_ENABLED: '1', GHARMONIZE_PLAYER_REMOTE_ACCESS: 'tunnel' }).enabled, true)
  assert.equal(getTunnelConfig({ GHARMONIZE_PLAYER_ENABLED: '0', GHARMONIZE_PLAYER_REMOTE_ACCESS: 'tunnel' }).enabled, false, 'player off → no tunnel')
  assert.equal(getTunnelConfig({ GHARMONIZE_PLAYER_ENABLED: '1', GHARMONIZE_PLAYER_REMOTE_ACCESS: 'tailscale' }).enabled, false)
})

test('requests from the tunnel origin are a separate network kind', () => {
  const viaTunnel = fakeReq({ 'cf-connecting-ip': '203.0.113.9' }, '203.0.113.9', { playerVia: 'tunnel' })
  assert.equal(classifyRequest(viaTunnel), 'tunnel')
  assert.equal(isNetworkAllowed('tunnel', 'tunnel'), true)
  assert.equal(isNetworkAllowed('tunnel', 'any'), true)
  assert.equal(isNetworkAllowed('tunnel', 'off'), false)
  assert.equal(isNetworkAllowed('tunnel', 'tailscale'), false)
  // "tunnel" mode does not open the player to other internet / tailnet traffic.
  assert.equal(isNetworkAllowed('public', 'tunnel'), false)
  assert.equal(isNetworkAllowed('tailscale', 'tunnel'), false)
  // A Cloudflare header alone (without coming through the tunnel listener) proves nothing.
  assert.equal(classifyRequest(fakeReq({ 'cf-connecting-ip': '1.2.3.4' }, '192.168.1.5')), 'lan')
})

test('cloudflared assets and quick tunnel URL parsing', () => {
  assert.equal(cloudflaredAsset('linux', 'x64'), 'cloudflared-linux-amd64')
  assert.equal(cloudflaredAsset('linux', 'arm64'), 'cloudflared-linux-arm64')
  assert.equal(cloudflaredAsset('win32', 'x64'), 'cloudflared-windows-amd64.exe')
  assert.equal(cloudflaredAsset('darwin', 'arm64'), 'cloudflared-darwin-arm64.tgz')
  assert.equal(cloudflaredAsset('sunos', 'x64'), null)
  const line = '2026-11-13T12:00:00Z INF |  https://brave-owl-music-lab.trycloudflare.com                                  |'
  assert.equal(parseQuickTunnelUrl(line), 'https://brave-owl-music-lab.trycloudflare.com')
  assert.equal(parseQuickTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), null)
})

test('cloudflared from CLOUDFLARED_BIN or PATH is used before downloading', async () => {
  const dir = tmpDir('cfbin')
  try {
    let fetched = 0
    const fetchImpl = async () => { fetched++; throw new Error('no network in tests') }
    const env = await ensureCloudflared({ binDir: dir, env: { CLOUDFLARED_BIN: '/opt/cf' }, versionImpl: async (f) => (f === '/opt/cf' ? '2026.1.0' : null), fetchImpl })
    assert.deepEqual(env, { file: '/opt/cf', version: '2026.1.0', source: 'env' })
    const sys = await ensureCloudflared({ binDir: dir, env: {}, platform: 'linux', versionImpl: async (f) => (f === 'cloudflared' ? '2025.9.1' : null), fetchImpl })
    assert.equal(sys.source, 'system')
    await assert.rejects(ensureCloudflared({ binDir: dir, env: {}, platform: 'linux', arch: 'x64', versionImpl: async () => null, fetchImpl }), /no network/)
    assert.equal(fetched, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function fakeSpawn(log) {
  return (file, args, opts) => {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.exitCode = null
    proc.stdin = new PassThrough()
    proc.kill = (sig) => { proc.exitCode = 0; log.push(`kill ${sig}`); setImmediate(() => proc.emit('exit', 0)) }
    const real = file === process.execPath ? args.slice(1) : [file, ...args]
    log.push({ file, args: real.slice(1), binary: real[0], token: opts.env.TUNNEL_TOKEN || null, proc })
    return proc
  }
}

test('tunnel manager starts, reports the address, restarts and stops', async () => {
  let cfg = { enabled: true, mode: 'quick', token: '', publicUrl: '', port: 5185 }
  const log = []
  const tunnel = createTunnel({
    getConfig: () => cfg,
    binDir: '/nonexistent',
    logger: silentLogger,
    spawnImpl: fakeSpawn(log),
    ensureBinary: async () => ({ file: '/bin/cloudflared', version: '2026.1.0', source: 'downloaded' }),
  })
  await tunnel.apply()
  assert.equal(tunnel.status().status, 'starting')
  const first = log[0]
  assert.deepEqual(first.args, ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:5185'])
  first.proc.stderr.write('INF Your quick Tunnel has been created! Visit it at:\nINF |  https://owl-test.trycloudflare.com  |\n')
  await new Promise((r) => setImmediate(r))
  assert.equal(tunnel.status().status, 'running')
  assert.equal(tunnel.status().url, 'https://owl-test.trycloudflare.com')
  assert.equal(tunnel.status().binary.version, '2026.1.0')

  // Same settings → nothing restarts.
  await tunnel.apply()
  assert.equal(log.filter((x) => typeof x === 'object').length, 1)

  // Unexpected exit → error, then a scheduled restart.
  first.proc.stderr.write('ERR failed to connect to the edge\n')
  first.proc.exitCode = 1
  first.proc.emit('exit', 1)
  assert.equal(tunnel.status().status, 'error')
  assert.equal(tunnel.status().url, null)
  assert.match(tunnel.status().error.message, /failed to connect/)

  // Token mode: token travels in the environment, never in argv.
  cfg = { enabled: true, mode: 'token', token: 'eyJhIjoiYWJjZGVmZ2hpamtsbW5vcCJ9', publicUrl: 'https://muzik.example.com', port: 5185 }
  await tunnel.apply()
  const tokenRun = log.filter((x) => typeof x === 'object').at(-1)
  assert.deepEqual(tokenRun.args, ['tunnel', '--no-autoupdate', 'run'])
  assert.equal(tokenRun.token, 'eyJhIjoiYWJjZGVmZ2hpamtsbW5vcCJ9')
  assert.equal(tunnel.status().url, 'https://muzik.example.com')
  tokenRun.proc.stderr.write('INF Registered tunnel connection connIndex=0 location=ist01\n')
  await new Promise((r) => setImmediate(r))
  assert.equal(tunnel.status().status, 'running')

  cfg = { ...cfg, enabled: false }
  await tunnel.apply()
  assert.equal(tunnel.status().status, 'stopped')
  assert.ok(log.includes('kill SIGTERM'))

  // Token mode without a token explains what is missing instead of looping.
  cfg = { enabled: true, mode: 'token', token: '', publicUrl: '', port: 5185 }
  await tunnel.apply()
  assert.equal(tunnel.status().error.code, 'TUNNEL_TOKEN_MISSING')
  await tunnel.stop()
})

test('connection info offers the tunnel address for pairing', () => {
  const info = buildConnectInfo({
    req: fakeReq({ host: 'owl.trycloudflare.com' }, '203.0.113.9', { playerVia: 'tunnel' }),
    main: { host: '127.0.0.1', port: 5174 },
    listener: { enabled: false, listening: false, port: 5175 },
    tunnel: { status: 'running', mode: 'quick', url: 'https://owl.trycloudflare.com' },
    remoteAccess: 'tunnel',
    interfaces: {},
  })
  assert.deepEqual(info.addresses.map((a) => [a.url, a.kind, a.blocked]), [['https://owl.trycloudflare.com', 'tunnel', false]])
  assert.ok(info.warnings.includes('TUNNEL_QUICK'))
  const off = buildConnectInfo({ main: { host: '127.0.0.1', port: 5174 }, listener: null, tunnel: { status: 'running', mode: 'quick', url: 'https://x.trycloudflare.com' }, remoteAccess: 'off', interfaces: {} })
  assert.equal(off.addresses[0].blocked, true)
})

test('the tunnel origin listener marks its requests and only serves the player', async (t) => {
  const root = tmpDir('tunnel')
  const downloads = path.join(root, 'outputs')
  fs.mkdirSync(downloads, { recursive: true })
  const env = { GHARMONIZE_PLAYER_ENABLED: '1', GHARMONIZE_PLAYER_REMOTE_ACCESS: 'tunnel' }
  const fakeTunnel = { apply: async () => ({}), stop: async () => {}, restart: async () => ({}), status: () => ({ status: 'running', mode: 'quick', url: 'https://owl.trycloudflare.com' }) }
  const service = await startPlayerService({
    env, logger: silentLogger, dataDir: path.join(root, 'data'), cacheDir: path.join(root, 'cache'), defaultLibraryDir: downloads, initialScanDelayMs: -1,
    listenerOptions: { getConfig: () => ({ enabled: false, port: 0, host: '127.0.0.1' }) },
    tunnelOptions: { tunnel: fakeTunnel, listener: { getConfig: () => ({ enabled: true, port: 0, host: '127.0.0.1' }) } },
    tailscaleProbe: { get: async () => ({ cli: false, docker: false, detected: false, running: false, ips: [], serveUrls: [], funnelUrls: [] }) },
    routerOptions: { adminBridge: () => ({ getSession: () => false, verifyPassword: () => false }), getMode: () => env.GHARMONIZE_PLAYER_REMOTE_ACCESS },
  })
  t.after(async () => { await service.stop(); fs.rmSync(root, { recursive: true, force: true }) })
  const origin = service.context.tunnelOrigin.status()
  assert.equal(origin.listening, true)
  const base = `http://127.0.0.1:${origin.port}`
  const status = await (await fetch(`${base}/api/player/status`, { headers: { 'x-forwarded-for': '203.0.113.9' } })).json()
  assert.equal(status.network, 'tunnel')
  assert.equal((await fetch(`${base}/api/settings`)).status, 404)
  assert.equal((await fetch(`${base}/player/`)).status, 200)
  // Turning external access off closes the door for tunnel traffic.
  env.GHARMONIZE_PLAYER_REMOTE_ACCESS = 'off'
  const blocked = await fetch(`${base}/api/player/status`)
  assert.equal(blocked.status, 403)
  assert.equal((await blocked.json()).error.code, 'PLAYER_REMOTE_ACCESS_DISABLED')
})

test('the watchdog stops cloudflared when Gharmonize goes away', { skip: process.platform === 'win32' && 'POSIX only', timeout: 10000 }, async (t) => {
  assert.equal(spawnArgs('/x/cloudflared', ['tunnel'], 'win32').command, '/x/cloudflared')
  const root = tmpDir('watchdog')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const script = path.join(root, 'stand-in.cjs')
  fs.writeFileSync(script, "console.log(JSON.stringify({ pid: process.pid, arg: process.argv[2] })); setInterval(() => {}, 1000)")
  const literal = 'spaces; $(touch injected) `echo nope` "quotes"'
  const { command, args } = spawnArgs(process.execPath, [script, literal], 'linux')
  assert.equal(command, process.execPath)
  const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  t.after(() => proc.kill('SIGTERM'))
  const exited = new Promise((resolve, reject) => { proc.once('exit', resolve); proc.once('error', reject) })
  const ready = await new Promise((resolve, reject) => {
    let output = ''
    proc.stdout.on('data', (chunk) => { output += chunk; if (output.includes('\n')) resolve(JSON.parse(output.split('\n')[0])) })
    proc.once('exit', () => reject(new Error('watchdog exited before child started')))
    proc.once('error', reject)
  })
  assert.equal(ready.arg, literal, 'shell metacharacters stay literal')
  // Parent "dies": the pipe closes, the watchdog must stop the child.
  proc.stdin.end()
  await exited
  assert.throws(() => process.kill(ready.pid, 0), { code: 'ESRCH' }, 'child was reaped before the watchdog exited')
})
