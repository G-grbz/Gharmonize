// Works out the addresses a phone can use to reach the player: the home
// network, Tailscale (IP, MagicDNS name, `tailscale serve` HTTPS) and custom
// addresses (reverse proxy / tunnel) the administrator entered. Used for the
// pairing QR code and the remote-access status page.

import os from 'node:os'
import net from 'node:net'
import { classifyClientIp, normalizeIp } from './network.js'

// Virtual interfaces whose addresses are not reachable from other devices.
const VIRTUAL_IFACE = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|cali|weave|kube|lxc|lxd|podman|tailscale|utun|zt|tun|tap|wg)/i

export function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || classifyClientIp(h) === 'loopback'
}

export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = []
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (VIRTUAL_IFACE.test(name)) continue
    for (const addr of list || []) {
      if (addr.internal || (addr.family !== 'IPv4' && addr.family !== 4)) continue
      const ip = normalizeIp(addr.address)
      if (classifyClientIp(ip) === 'lan' && !ip.startsWith('169.254.') && !out.includes(ip)) out.push(ip)
    }
  }
  return out
}

function hostForUrl(host) {
  return net.isIP(host) === 6 ? `[${host}]` : host
}

export function normalizePublicUrl(value) {
  let parsed
  try { parsed = new URL(String(value || '').trim()) } catch { return null }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/player$/, '')
  return `${parsed.protocol}//${parsed.host}${pathname}`.slice(0, 300)
}

function originOf(req) {
  const host = String(req.get?.('host') || '').trim()
  if (!host || !/^[a-z0-9.\-:[\]]+$/i.test(host)) return null
  return { url: `${req.protocol || 'http'}://${host}`, hostname: host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') }
}

// main: { host, port }  listener: status()  tailscale: probe result
export function buildConnectInfo({ req = null, main, listener, tailscale = null, tunnel = null, remoteAccess = 'off', publicUrls = [], interfaces, docker = false, serverName = 'Gharmonize Player' }) {
  const mainLan = !isLoopbackHost(main.host)
  // Port that other devices can reach directly on this machine.
  const directPort = listener?.listening ? listener.port : mainLan ? main.port : null
  // Tailscale addresses need the "tailscale" (or "any") mode.
  const remoteBlocked = !['tailscale', 'any'].includes(remoteAccess)
  const addresses = []
  const add = (entry) => {
    if (!entry.url || addresses.some((a) => a.url === entry.url)) return
    addresses.push(entry)
  }

  const current = req ? originOf(req) : null
  // Through the tunnel the page's own address is the tunnel address (added below).
  if (current && !isLoopbackHost(current.hostname) && req?.playerVia !== 'tunnel') {
    const kind = classifyClientIp(current.hostname)
    add({ url: current.url, kind: 'current', network: kind === 'unknown' ? 'name' : kind, blocked: (kind === 'tailscale' || kind === 'public') && remoteBlocked })
  }
  // Container addresses are not reachable from the home network; in Docker
  // the address the browser used (above) is the reliable one.
  if (directPort && !docker) {
    for (const ip of lanAddresses(interfaces)) add({ url: `http://${hostForUrl(ip)}:${directPort}`, kind: 'lan', network: 'lan', blocked: false })
  }
  // Cloudflare Tunnel: reachable from anywhere, no app needed on the phone.
  if (tunnel?.url) add({ url: tunnel.url, kind: 'tunnel', network: 'internet', blocked: !['tunnel', 'any'].includes(remoteAccess), ephemeral: tunnel.mode === 'quick' })
  if (tailscale?.running) {
    for (const url of tailscale.serveUrls || []) add({ url, kind: 'tailscale-https', network: 'tailscale', blocked: remoteBlocked, funnel: (tailscale.funnelUrls || []).includes(url) })
    if (directPort) {
      if (tailscale.dnsName) add({ url: `http://${tailscale.dnsName}:${directPort}`, kind: 'tailscale-dns', network: 'tailscale', blocked: remoteBlocked })
      for (const ip of tailscale.ips || []) {
        if (net.isIP(ip) === 4) add({ url: `http://${ip}:${directPort}`, kind: 'tailscale', network: 'tailscale', blocked: remoteBlocked })
      }
    }
  }
  for (const raw of publicUrls) {
    const url = normalizePublicUrl(raw)
    if (!url) continue
    let host = ''
    try { host = new URL(url).hostname.replace(/^\[|\]$/g, '') } catch {}
    const kind = classifyClientIp(host)
    const network = kind === 'unknown' ? (/\.ts\.net$/i.test(host) ? 'tailscale' : 'internet') : kind
    add({ url, kind: 'custom', network, blocked: (network === 'tailscale' && remoteBlocked) || ((network === 'internet' || network === 'public') && remoteAccess !== 'any') })
  }

  const warnings = []
  if (!directPort && !docker) warnings.push('LOCAL_ONLY')
  if (listener?.enabled && !listener.listening) warnings.push('LISTENER_FAILED')
  if (tailscale?.running && !directPort && !(tailscale.serveUrls || []).length) warnings.push('TAILSCALE_UNREACHABLE')
  if ((tailscale?.funnelUrls || []).length && remoteAccess !== 'any') warnings.push('FUNNEL_BLOCKED')
  if (tailscale?.running && remoteAccess === 'off') warnings.push('REMOTE_OFF')
  if (tunnel && tunnel.status === 'error') warnings.push('TUNNEL_FAILED')
  if (tunnel && tunnel.mode === 'quick' && tunnel.url) warnings.push('TUNNEL_QUICK')

  return {
    serverName,
    remoteAccess,
    docker,
    main: { host: main.host, port: main.port, lan: mainLan },
    listener: listener || null,
    directPort,
    tailscale,
    tunnel,
    addresses,
    warnings,
    requestNetwork: req?.playerNetwork || null
  }
}
