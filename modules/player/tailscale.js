// Tailscale detection (read-only). Gharmonize never changes the Tailscale
// configuration; it only reports what is there so the player can show the
// right addresses and setup steps. Runs on demand and caches for 30 s.

import os from 'node:os'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { classifyClientIp, normalizeIp } from './network.js'

const CACHE_MS = 30_000
const CLI_TIMEOUT_MS = 3000

function cliCandidates(platform = process.platform) {
  if (platform === 'win32') return ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe']
  if (platform === 'darwin') return ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale']
  return ['tailscale', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/usr/sbin/tailscale']
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) resolve({ ok: false, code: error.code, stdout: String(stdout || '') })
      else resolve({ ok: true, stdout: String(stdout || '') })
    })
  })
}

// Addresses on local interfaces that belong to a tailnet.
export function interfaceTailscaleIps(interfaces = os.networkInterfaces()) {
  const out = []
  for (const list of Object.values(interfaces || {})) {
    for (const addr of list || []) {
      if (addr.internal) continue
      const ip = normalizeIp(addr.address)
      if (classifyClientIp(ip) === 'tailscale' && !out.includes(ip)) out.push(ip)
    }
  }
  return out
}

// Parses `tailscale status --json`.
export function parseStatus(json) {
  let data
  try { data = typeof json === 'string' ? JSON.parse(json) : json } catch { return null }
  if (!data || typeof data !== 'object') return null
  const self = data.Self || {}
  const dnsName = String(self.DNSName || '').replace(/\.$/, '') || null
  return {
    backendState: String(data.BackendState || '') || null,
    running: data.BackendState === 'Running',
    hostName: String(self.HostName || '') || null,
    dnsName,
    tailnet: String(data.CurrentTailnet?.Name || '') || null,
    magicDns: Boolean(data.CurrentTailnet?.MagicDNSEnabled ?? data.MagicDNSSuffix),
    ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(normalizeIp).filter(Boolean) : [],
    online: self.Online !== false
  }
}

// Parses `tailscale serve status --json` and returns HTTPS URLs that proxy to
// one of the given local ports.
export function parseServeStatus(json, ports = []) {
  let data
  try { data = typeof json === 'string' ? JSON.parse(json) : json } catch { return { serve: [], funnel: [] } }
  const serve = []
  const funnel = []
  const web = data?.Web || {}
  const funnelHosts = data?.AllowFunnel || {}
  for (const [hostPort, cfg] of Object.entries(web)) {
    for (const handler of Object.values(cfg?.Handlers || {})) {
      const proxy = String(handler?.Proxy || '')
      const target = proxy.match(/:(\d+)(?:\/|$)/)
      if (!target || !ports.map(Number).includes(Number(target[1]))) continue
      const [host, port] = hostPort.split(':')
      const url = `https://${host}${port && port !== '443' ? `:${port}` : ''}`
      if (!serve.includes(url)) serve.push(url)
      if (funnelHosts[hostPort] && !funnel.includes(url)) funnel.push(url)
    }
  }
  return { serve, funnel }
}

export function createTailscaleProbe({ runImpl = run, interfacesImpl = () => os.networkInterfaces(), platform = process.platform, now = () => Date.now(), isDocker = defaultIsDocker } = {}) {
  let cache = null
  let pending = null

  async function findCli() {
    for (const candidate of cliCandidates(platform)) {
      const res = await runImpl(candidate, ['version'])
      if (res.ok) return candidate
    }
    return null
  }

  async function detect(ports = []) {
    const ifaceIps = interfaceTailscaleIps(interfacesImpl())
    const cli = await findCli()
    let status = null
    let serve = { serve: [], funnel: [] }
    if (cli) {
      const res = await runImpl(cli, ['status', '--json'])
      if (res.stdout) status = parseStatus(res.stdout)
      if (status?.running) {
        const sres = await runImpl(cli, ['serve', 'status', '--json'])
        if (sres.ok && sres.stdout.trim()) serve = parseServeStatus(sres.stdout, ports)
      }
    }
    const ips = [...new Set([...(status?.ips || []), ...ifaceIps])]
    return {
      cli: Boolean(cli),
      docker: isDocker(),
      detected: Boolean(cli || ips.length),
      running: status ? status.running : ips.length > 0,
      backendState: status?.backendState || (ips.length ? 'Running' : null),
      hostName: status?.hostName || null,
      dnsName: status?.dnsName || null,
      tailnet: status?.tailnet || null,
      ips,
      serveUrls: serve.serve,
      funnelUrls: serve.funnel,
      checkedAt: now()
    }
  }

  async function get(ports = [], { fresh = false } = {}) {
    const key = ports.join(',')
    if (!fresh && cache && cache.key === key && now() - cache.at < CACHE_MS) return cache.value
    if (pending) return pending
    pending = detect(ports)
      .catch(() => ({ cli: false, docker: isDocker(), detected: false, running: false, ips: [], serveUrls: [], funnelUrls: [], checkedAt: now() }))
      .then((value) => { cache = { key, at: now(), value }; return value })
      .finally(() => { pending = null })
    return pending
  }

  return { get }
}

function defaultIsDocker() {
  if (String(process.env.GHARMONIZE_WEB_BINARIES_IN_DOCKER || '') === '1') return true
  try { return fs.existsSync('/.dockerenv') } catch { return false }
}
