import net from 'node:net'
import { ipInCidr } from '../security.js'
import { getRemoteAccessMode } from './gate.js'

const LOOPBACK = ['127.0.0.0/8', '::1/128']
const LAN = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10']
// Tailscale assigns addresses from the CGNAT range and its own ULA prefix.
const TAILSCALE = ['100.64.0.0/10', 'fd7a:115c:a1e0::/48']

export function normalizeIp(raw) {
  let ip = String(raw || '').trim()
  if (ip.startsWith('::ffff:') && net.isIP(ip.slice(7)) === 4) ip = ip.slice(7)
  const zone = ip.indexOf('%')
  if (zone !== -1) ip = ip.slice(0, zone)
  return ip
}

// Returns 'loopback' | 'lan' | 'tailscale' | 'public' | 'unknown'.
export function classifyClientIp(raw) {
  const ip = normalizeIp(raw)
  if (!net.isIP(ip)) return 'unknown'
  if (LOOPBACK.some((cidr) => ipInCidr(ip, cidr))) return 'loopback'
  // Tailscale's ULA prefix is inside fc00::/7, so test it before LAN.
  if (TAILSCALE.some((cidr) => ipInCidr(ip, cidr))) return 'tailscale'
  if (LAN.some((cidr) => ipInCidr(ip, cidr))) return 'lan'
  return 'public'
}

// Local network access always works. Anything outside requires the explicit
// "allow external connections" consent in settings.
export function isNetworkAllowed(kind, mode) {
  if (kind === 'loopback' || kind === 'lan') return true
  if (mode === 'tunnel') return kind === 'tunnel'
  if (mode === 'tailscale') return kind === 'tailscale'
  if (mode === 'any') return kind === 'tailscale' || kind === 'public' || kind === 'tunnel'
  return false
}

// Classifies a request. Local reverse proxies are trusted for the client
// address (req.ip). Tailscale Funnel publishes a local port to the whole
// internet through tailscaled on loopback and marks those requests; they are
// public traffic and must never pass as "home network" or "Tailscale".
export function classifyRequest(req) {
  // Set by the internal listener that only the Cloudflare Tunnel connects to.
  if (req.playerVia === 'tunnel') return 'tunnel'
  if (String(req.get?.('tailscale-funnel-request') || '').trim()) return 'public'
  return classifyClientIp(req.ip || req.socket?.remoteAddress)
}

export function networkGate({ getMode = () => getRemoteAccessMode() } = {}) {
  return (req, res, next) => {
    const kind = classifyRequest(req)
    req.playerNetwork = kind
    if (isNetworkAllowed(kind, getMode())) return next()
    res.set('Cache-Control', 'no-store')
    return res.status(403).json({
      error: {
        code: 'PLAYER_REMOTE_ACCESS_DISABLED',
        message: 'External connections to Gharmonize Player are not allowed. Enable remote access in settings.'
      }
    })
  }
}
