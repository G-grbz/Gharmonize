// Cloudflare Tunnel for Gharmonize Player (remote access mode "tunnel").
//
// No port forwarding, works behind CGNAT, phones need no extra app. The
// official cloudflared binary is used from CLOUDFLARED_BIN / PATH or
// downloaded from Cloudflare's GitHub releases into the player data folder.
// cloudflared only reaches a dedicated 127.0.0.1 listener that serves the
// player (never the rest of Gharmonize).

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download'
const QUICK_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export function cloudflaredAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') return { linux_x64: 'cloudflared-linux-amd64', linux_arm64: 'cloudflared-linux-arm64', linux_arm: 'cloudflared-linux-arm', linux_ia32: 'cloudflared-linux-386' }[`linux_${arch}`] || null
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe'
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz'
  return null
}

export function parseQuickTunnelUrl(text) {
  const m = String(text || '').match(QUICK_URL_RE)
  return m ? m[0].toLowerCase() : null
}

function runVersion(file) {
  return new Promise((resolve) => {
    execFile(file, ['--version'], { timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return resolve(null)
      const out = `${stdout}${stderr}`.trim()
      resolve(out.match(/version\s+([\w.-]+)/i)?.[1] || out.split('\n')[0] || 'unknown')
    })
  })
}

async function download(url, dest, fetchImpl) {
  const res = await fetchImpl(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`cloudflared download failed (HTTP ${res.status})`)
  const tmp = `${dest}.download`
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length < 1_000_000) throw new Error('cloudflared download looks incomplete')
  await fs.promises.writeFile(tmp, buf, { mode: 0o755 })
  await fs.promises.rename(tmp, dest)
}

/** Returns { file, version, source } — system/env binary first, then a downloaded one. */
export async function ensureCloudflared({ binDir, env = process.env, platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, versionImpl = runVersion, logger = console } = {}) {
  const explicit = String(env.CLOUDFLARED_BIN || '').trim()
  if (explicit) {
    const version = await versionImpl(explicit)
    if (!version) throw new Error(`CLOUDFLARED_BIN does not run: ${explicit}`)
    return { file: explicit, version, source: 'env' }
  }
  const onPath = await versionImpl(platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  if (onPath) return { file: platform === 'win32' ? 'cloudflared.exe' : 'cloudflared', version: onPath, source: 'system' }

  const asset = cloudflaredAsset(platform, arch)
  if (!asset) throw new Error(`cloudflared is not available for ${platform}/${arch}`)
  await fs.promises.mkdir(binDir, { recursive: true })
  const file = path.join(binDir, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  let version = fs.existsSync(file) ? await versionImpl(file) : null
  if (!version) {
    logger.log?.('🌐 [player] downloading cloudflared…')
    if (asset.endsWith('.tgz')) {
      const archive = path.join(binDir, asset)
      await download(`${RELEASE_BASE}/${asset}`, archive, fetchImpl)
      await new Promise((resolve, reject) => {
        execFile('tar', ['-xzf', archive, '-C', binDir], (error) => (error ? reject(error) : resolve()))
      })
      await fs.promises.rm(archive, { force: true })
      await fs.promises.chmod(file, 0o755)
    } else {
      await download(`${RELEASE_BASE}/${asset}`, file, fetchImpl)
    }
    version = await versionImpl(file)
    if (!version) throw new Error('Downloaded cloudflared does not run on this system')
  }
  return { file, version, source: 'downloaded' }
}

// POSIX: run cloudflared under a tiny shell watchdog that reads our stdin;
// when Gharmonize exits in any way (even SIGKILL or a crash) the pipe closes
// and the watchdog stops cloudflared, so no orphan tunnel is left behind.
// (Background jobs get /dev/null as stdin, so our pipe is kept on fd 3.)
const WATCHDOG = 'exec 3<&0; cf="$1"; shift; "$cf" "$@" </dev/null & c=$!; ' +
  '{ while read -r _ <&3; do :; done; kill "$c" 2>/dev/null; } & w=$!; ' +
  'wait "$c"; s=$?; kill "$w" 2>/dev/null; exit $s'

export function spawnArgs(file, args, platform = process.platform) {
  if (platform === 'win32') return { command: file, args, watchdog: false }
  return { command: '/bin/sh', args: ['-c', WATCHDOG, 'cloudflared-watchdog', file, ...args], watchdog: true }
}

const liveChildren = new Set()
let exitHookInstalled = false
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Last resort (and the only way on Windows): stop tunnels on normal exit.
  process.once('exit', () => { for (const c of liveChildren) { try { c.kill('SIGTERM') } catch {} } })
}

/**
 * Keeps cloudflared running according to getConfig():
 * { enabled, mode: 'quick'|'token', token, publicUrl, port }.
 */
export function createTunnel({ getConfig, binDir, logger = console, spawnImpl = spawn, ensureBinary = ensureCloudflared, env = process.env, platform = process.platform } = {}) {
  let child = null
  let key = null
  let restartTimer = null
  let backoffMs = 5000
  let stopping = false
  let generation = 0
  let state = { status: 'stopped', url: null, error: null, mode: null, binary: null, since: null, restarts: 0 }
  const lastLines = []

  const set = (patch) => { state = { ...state, ...patch } }

  function configKey(cfg) {
    return cfg.enabled ? JSON.stringify([cfg.mode, cfg.mode === 'token' ? cfg.token : '', cfg.port]) : null
  }

  function kill() {
    clearTimeout(restartTimer)
    restartTimer = null
    const current = child
    child = null
    if (current && current.exitCode === null) {
      stopping = true
      // Closing stdin makes the watchdog stop cloudflared itself.
      try { current.stdin?.end() } catch {}
      current.kill('SIGTERM')
      setTimeout(() => { if (current.exitCode === null) current.kill('SIGKILL') }, 4000).unref?.()
    }
  }

  async function start(cfg, myGen) {
    if (cfg.mode === 'token' && !cfg.token) {
      set({ status: 'error', error: { code: 'TUNNEL_TOKEN_MISSING', message: 'Paste the Cloudflare tunnel token in settings.' }, url: null, mode: cfg.mode })
      return
    }
    set({ status: 'preparing', error: null, url: cfg.mode === 'token' ? (cfg.publicUrl || null) : null, mode: cfg.mode })
    let binary
    try {
      binary = await ensureBinary({ binDir, env, logger })
    } catch (error) {
      if (myGen !== generation) return
      set({ status: 'error', error: { code: 'CLOUDFLARED_UNAVAILABLE', message: String(error?.message || error) } })
      scheduleRestart(myGen)
      return
    }
    if (myGen !== generation) return
    set({ binary: { version: binary.version, source: binary.source }, status: 'starting' })
    const args = cfg.mode === 'token'
      ? ['tunnel', '--no-autoupdate', 'run']
      : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${cfg.port}`]
    // The token goes through the environment, not the visible command line.
    const childEnv = { ...env, ...(cfg.mode === 'token' ? { TUNNEL_TOKEN: cfg.token } : {}) }
    lastLines.length = 0
    stopping = false
    const launch = spawnArgs(binary.file, args, platform)
    const proc = spawnImpl(launch.command, launch.args, { env: childEnv, stdio: [launch.watchdog ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true })
    child = proc
    liveChildren.add(proc)
    installExitHook()
    proc.stdin?.on?.('error', () => {})
    const onData = (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (!line.trim()) continue
        lastLines.push(line.replace(/eyJ[\w-]{10,}/g, '***'))
        if (lastLines.length > 20) lastLines.shift()
        if (cfg.mode === 'quick') {
          const url = parseQuickTunnelUrl(line)
          if (url && state.url !== url) {
            set({ url, status: 'running', since: Date.now(), error: null })
            backoffMs = 5000
            logger.log?.(`🌐 [player] Cloudflare tunnel ready: ${url}`)
          }
        } else if (/Registered tunnel connection|Connection [\w-]+ registered/i.test(line) && state.status !== 'running') {
          set({ status: 'running', since: Date.now(), error: null })
          backoffMs = 5000
          logger.log?.('🌐 [player] Cloudflare tunnel connected')
        }
      }
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('error', (error) => {
      if (child !== proc) return
      set({ status: 'error', error: { code: 'CLOUDFLARED_FAILED', message: String(error?.message || error) } })
    })
    proc.on('exit', (code) => {
      liveChildren.delete(proc)
      if (child === proc) child = null
      if (stopping || myGen !== generation) return
      const tail = lastLines.filter((l) => /ERR|error|failed/i.test(l)).slice(-3).join(' | ') || `exit code ${code}`
      set({ status: 'error', url: cfg.mode === 'token' ? state.url : null, error: { code: 'TUNNEL_EXITED', message: tail.slice(0, 500) } })
      logger.warn?.(`⚠️ [player] cloudflared exited: ${tail}`)
      scheduleRestart(myGen)
    })
  }

  function scheduleRestart(myGen) {
    clearTimeout(restartTimer)
    restartTimer = setTimeout(() => {
      if (myGen !== generation) return
      set({ restarts: state.restarts + 1 })
      start(getConfig(), myGen)
    }, backoffMs)
    restartTimer.unref?.()
    backoffMs = Math.min(backoffMs * 2, 5 * 60_000)
  }

  async function apply({ force = false } = {}) {
    const cfg = getConfig()
    const next = configKey(cfg)
    if (!force && next === key && (child || restartTimer || !next)) return state
    key = next
    generation += 1
    kill()
    if (!next) {
      set({ status: 'stopped', url: null, error: null, mode: null, since: null })
      return state
    }
    backoffMs = 5000
    await start(cfg, generation)
    return state
  }

  async function stop() {
    generation += 1
    key = null
    kill()
    set({ status: 'stopped', url: null, since: null })
  }

  return { apply, stop, restart: () => apply({ force: true }), status: () => ({ ...state, log: lastLines.slice(-5) }) }
}
