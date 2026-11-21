// Gharmonize Player: tells the administrators when a new Gharmonize release
// is out (the same GitHub "latest release" the classic interface checks).
// GitHub is asked at most once a day; each version is announced once, as a
// notification in the player's bell (web) and on the phone (APK).

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { getSetting, setSetting } from './db.js'

const REPO = 'G-grbz/Gharmonize'
const DAY_MS = 24 * 60 * 60 * 1000
const STATE_KEY = 'app_update'

export function readAppVersion() {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json')
    return JSON.parse(fs.readFileSync(file, 'utf8')).version || '0.0.0'
  } catch { return '0.0.0' }
}

export function isNewerVersion(latest, current) {
  const parse = (v) => String(v || '').replace(/^v/i, '').split('.').map((n) => Number.parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

// Only administrators get the notice: listeners cannot update the server.
export function createAppUpdateWatch({ db, currentVersion = readAppVersion(), fetchImpl = fetch, now = () => Date.now(), logger = console, everyMs = DAY_MS } = {}) {
  const stmt = {
    admins: db.prepare("SELECT id FROM users WHERE role = 'admin' AND disabled = 0"),
    notify: db.prepare(`INSERT INTO notifications (user_id, kind, title, body, artwork_url, link, data, created_at)
      VALUES (?, 'app-update', ?, NULL, NULL, ?, ?, ?)`),
    // After updating, an older "new version" notice is no longer news.
    settle: db.prepare("UPDATE notifications SET read_at = ? WHERE kind = 'app-update' AND read_at IS NULL")
  }
  let running = null

  function state() {
    return getSetting(db, STATE_KEY, {}) || {}
  }

  async function fetchLatest() {
    const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Gharmonize-Player' },
      signal: AbortSignal.timeout(10_000)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    const version = String(data?.tag_name || '').replace(/^v/i, '').trim()
    if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('no version in the latest release')
    const url = /^https:\/\/github\.com\/G-grbz\/Gharmonize\/releases\//.test(String(data?.html_url || ''))
      ? data.html_url
      : `https://github.com/${REPO}/releases/tag/v${version}`
    return { version, url }
  }

  async function run({ force }) {
    const before = state()
    if (before.announced && !isNewerVersion(before.announced, currentVersion)) stmt.settle.run(now())
    if (!force && before.checkedAt && now() - before.checkedAt < everyMs) return status()
    let latest
    try {
      latest = await fetchLatest()
    } catch (error) {
      setSetting(db, STATE_KEY, { ...before, checkedAt: now() })
      logger.debug?.(`[player] update check failed: ${error?.message || error}`)
      return status()
    }
    const next = { ...before, checkedAt: now(), latest: latest.version, url: latest.url }
    if (isNewerVersion(latest.version, currentVersion) && before.announced !== latest.version) {
      const data = JSON.stringify({ version: latest.version, current: currentVersion, url: latest.url })
      for (const admin of stmt.admins.all()) stmt.notify.run(admin.id, `Gharmonize v${latest.version}`, latest.url, data, now())
      next.announced = latest.version
      logger.log?.(`🆕 [player] Gharmonize v${latest.version} is available (running v${currentVersion})`)
    }
    setSetting(db, STATE_KEY, next)
    return status()
  }

  function check({ force = false } = {}) {
    if (!running) running = run({ force }).finally(() => { running = null })
    return running
  }

  function status() {
    const s = state()
    return {
      current: currentVersion,
      latest: s.latest || null,
      url: s.url || null,
      available: Boolean(s.latest && isNewerVersion(s.latest, currentVersion)),
      checkedAt: s.checkedAt || null
    }
  }

  return { check, status }
}
