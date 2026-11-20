// New releases of the artists a user follows, and the user's notifications.
//
// Once a day the Deezer discography of every followed artist is compared
// with what was seen before. The first look only records the discography
// (no flood of "new" old albums); later, a release that was not there and is
// recent becomes a notification, and is downloaded into the library when the
// user switched that on.

import { getSetting, setSetting } from './db.js'

const DAY = 24 * 60 * 60 * 1000
const RECENT_DAYS = 60
const MAX_ARTISTS_PER_RUN = 60

export function createReleaseWatch({ db, discovery, bridge, annotator = null, getUser, logger = console, now = () => Date.now(), checkEveryMs = DAY }) {
  const stmt = {
    followedArtists: db.prepare(`SELECT ar.id, ar.name FROM favorites f JOIN artists ar ON ar.id = f.item_id
      WHERE f.user_id = ? AND f.item_type = 'artist' ORDER BY f.created_at`),
    usersWithArtists: db.prepare("SELECT DISTINCT user_id FROM favorites WHERE item_type = 'artist'"),
    watch: db.prepare('SELECT * FROM artist_watch WHERE user_id = ? AND artist_id = ?'),
    upsertWatch: db.prepare(`INSERT INTO artist_watch (user_id, artist_id, deezer_id, known, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, artist_id) DO UPDATE SET deezer_id = excluded.deezer_id, known = excluded.known, checked_at = excluded.checked_at`),
    touchWatch: db.prepare(`INSERT INTO artist_watch (user_id, artist_id, checked_at) VALUES (?, ?, ?)
      ON CONFLICT(user_id, artist_id) DO UPDATE SET checked_at = excluded.checked_at`),
    notify: db.prepare(`INSERT INTO notifications (user_id, kind, title, body, artwork_url, link, data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    list: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    unread: db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL'),
    readAll: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL'),
    readOne: db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND id = ? AND read_at IS NULL'),
    purge: db.prepare('DELETE FROM notifications WHERE created_at < ?')
  }
  let running = null

  // ---- per-user settings ------------------------------------------------------------

  function settings(userId) {
    const value = getSetting(db, `releases:${Number(userId)}`, {}) || {}
    return { autoDownload: Boolean(value.autoDownload) }
  }

  function updateSettings(userId, patch = {}) {
    const next = { ...settings(userId) }
    if (patch.autoDownload !== undefined) next.autoDownload = Boolean(patch.autoDownload)
    setSetting(db, `releases:${Number(userId)}`, next)
    return next
  }

  // ---- notifications ----------------------------------------------------------------

  function serialize(row) {
    let data = null
    try { data = row.data ? JSON.parse(row.data) : null } catch {}
    return { id: row.id, kind: row.kind, title: row.title, body: row.body, artworkUrl: row.artwork_url, link: row.link, data, createdAt: row.created_at, read: Boolean(row.read_at) }
  }

  function notifications(userId, { limit = 50 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 50, 1), 200)
    return { items: stmt.list.all(Number(userId), n).map(serialize), unread: stmt.unread.get(Number(userId)).n }
  }

  function markRead(userId, ids = null) {
    const ts = now()
    if (Array.isArray(ids) && ids.length) for (const id of ids.slice(0, 500)) stmt.readOne.run(ts, Number(userId), Number(id))
    else stmt.readAll.run(ts, Number(userId))
    return { unread: stmt.unread.get(Number(userId)).n }
  }

  // ---- checks -------------------------------------------------------------------------

  async function checkArtist(user, artist, { force = false } = {}) {
    const watch = stmt.watch.get(user.id, artist.id)
    if (!force && watch?.checked_at && now() - watch.checked_at < checkEveryMs) return []
    let found
    try { found = await discovery.artistReleases(artist.name, watch?.deezer_id || null) } catch (error) {
      logger.debug?.(`[player] release check for ${artist.name} failed: ${error?.message || error}`)
      return []
    }
    if (!found) { stmt.touchWatch.run(user.id, artist.id, now()); return [] }
    const ids = found.albums.map((a) => String(a.id))
    // First look: remember the discography, announce nothing.
    if (!watch || watch.known === '[]' || !watch.deezer_id) {
      stmt.upsertWatch.run(user.id, artist.id, found.id, JSON.stringify(ids), now())
      return []
    }
    const known = new Set(JSON.parse(watch.known || '[]'))
    const cutoff = new Date(now() - RECENT_DAYS * DAY).toISOString().slice(0, 10)
    let fresh = found.albums.filter((a) => !known.has(String(a.id)) && (!a.releaseDate || a.releaseDate >= cutoff))
    if (annotator) fresh = annotator.items(fresh, user.id).filter((a) => !a.library?.complete)
    stmt.upsertWatch.run(user.id, artist.id, found.id, JSON.stringify([...new Set([...known, ...ids])].slice(-2000)), now())
    const auto = settings(user.id).autoDownload && bridge.canDownload(user)
    for (const album of fresh) {
      const kindKey = album.recordType === 'single' ? 'single' : 'album'
      stmt.notify.run(user.id, 'release', String(album.title || '').slice(0, 300), String(album.artist || artist.name).slice(0, 300),
        /^https:\/\//.test(String(album.artworkUrl || '')) ? album.artworkUrl : null,
        `/online/album?provider=deezer&id=${encodeURIComponent(album.id)}`,
        JSON.stringify({ ...album, recordKind: kindKey, autoDownload: auto }), now())
      if (auto) {
        try { await bridge.request(user, { ...album, kind: 'album' }) } catch (error) {
          logger.debug?.(`[player] auto-download of ${album.title} failed: ${error?.code || error?.message}`)
        }
      }
    }
    if (fresh.length) logger.log?.(`🆕 [player] ${artist.name}: ${fresh.length} new release(s) for user ${user.id}`)
    return fresh
  }

  async function checkUser(userId, { force = false } = {}) {
    const user = getUser(userId)
    if (!user || user.disabled) return { checked: 0, found: 0 }
    const artists = stmt.followedArtists.all(user.id).slice(0, MAX_ARTISTS_PER_RUN)
    let found = 0
    for (const artist of artists) found += (await checkArtist(user, artist, { force })).length
    return { checked: artists.length, found }
  }

  // Hourly housekeeping: artists not checked today, one run at a time.
  function checkDue() {
    if (running) return running
    running = (async () => {
      for (const { user_id: userId } of stmt.usersWithArtists.all()) {
        try { await checkUser(userId) } catch (error) { logger.debug?.(`[player] release check failed: ${error?.message || error}`) }
      }
      stmt.purge.run(now() - 90 * DAY)
    })().finally(() => { running = null })
    return running
  }

  return { settings, updateSettings, notifications, markRead, checkUser, checkArtist, checkDue }
}
