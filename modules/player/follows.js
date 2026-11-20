// Followed online playlists: a YouTube Music / Deezer / Spotify / Apple Music
// list (or a YouTube Mix) is tied to one of the user's player playlists and
// checked once a day. Songs already in the library are added right away, new
// ones are downloaded into the library and added when they arrive (the
// download bridge attaches them to the playlist). Songs that were handled
// once are remembered, so a song the user removes from the playlist does not
// come back.

import { songKey } from './songKey.js'

const DAY = 24 * 60 * 60 * 1000
const PROVIDERS = new Set(['deezer', 'youtube', 'spotify', 'apple'])

export class FollowError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function sourceKeyOf({ provider, id, url } = {}) {
  const p = String(provider || '').toLowerCase()
  const ref = ['youtube', 'apple'].includes(p) ? String(url || '').trim() : String(id || '').trim()
  return p && ref ? `${p}:${ref}` : ''
}

function trackKey(t) {
  return songKey(t.title, t.artist) || String(t.url || '')
}

export function createFollows({ db, discovery, bridge, catalog, getUser, logger = console, now = () => Date.now(), syncEveryMs = DAY, maxNewPerSync = 30 }) {
  const stmt = {
    byUser: db.prepare('SELECT * FROM followed_playlists WHERE user_id = ? ORDER BY created_at DESC'),
    byId: db.prepare('SELECT * FROM followed_playlists WHERE id = ?'),
    byKey: db.prepare('SELECT * FROM followed_playlists WHERE user_id = ? AND source_key = ?'),
    byPlaylist: db.prepare('SELECT * FROM followed_playlists WHERE user_id = ? AND playlist_id = ?'),
    due: db.prepare('SELECT id FROM followed_playlists WHERE COALESCE(last_sync_at, 0) < ? ORDER BY COALESCE(last_sync_at, 0) LIMIT 20'),
    insert: db.prepare(`INSERT INTO followed_playlists (user_id, provider, source_key, source_id, source_url, title, artwork_url, playlist_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    remove: db.prepare('DELETE FROM followed_playlists WHERE id = ?'),
    synced: db.prepare(`UPDATE followed_playlists SET known = ?, last_sync_at = ?, last_added = ?, last_error = ?, title = COALESCE(?, title),
      artwork_url = COALESCE(?, artwork_url) WHERE id = ?`),
    failed: db.prepare('UPDATE followed_playlists SET last_sync_at = ?, last_error = ? WHERE id = ?')
  }
  const running = new Map()

  function serialize(row) {
    if (!row) return null
    return {
      id: row.id,
      provider: row.provider,
      sourceId: row.source_id,
      sourceUrl: row.source_url,
      title: row.title,
      artworkUrl: row.artwork_url,
      playlistId: row.playlist_id,
      lastSyncAt: row.last_sync_at,
      lastAdded: row.last_added || 0,
      lastError: row.last_error || null,
      syncing: running.has(row.id),
      createdAt: row.created_at
    }
  }

  function list(userId) {
    return stmt.byUser.all(Number(userId)).map(serialize)
  }

  function find(userId, ref) {
    const key = sourceKeyOf(ref)
    return key ? serialize(stmt.byKey.get(Number(userId), key)) : null
  }

  function forPlaylist(userId, playlistId) {
    return serialize(stmt.byPlaylist.get(Number(userId), Number(playlistId)))
  }

  async function follow(user, { provider, id, url, title, artworkUrl, mix } = {}) {
    const p = String(provider || '').toLowerCase()
    if (!PROVIDERS.has(p)) throw new FollowError('UNKNOWN_PROVIDER', 'This list cannot be followed.')
    // An artist radio is new songs every time: it would never stop growing.
    if (mix === 'artist' || mix === 'deezer') throw new FollowError('FOLLOW_UNSUPPORTED', 'Artist radios cannot be followed.')
    const key = sourceKeyOf({ provider: p, id, url })
    if (!key) throw new FollowError('SOURCE_REQUIRED', 'A playlist id or link is required.')
    const existing = stmt.byKey.get(user.id, key)
    if (existing) return serialize(existing)
    const name = String(title || '').trim().slice(0, 120) || 'Playlist'
    const playlist = catalog.createPlaylist(user.id, { name, description: '' })
    const art = /^https:\/\//i.test(String(artworkUrl || '')) ? String(artworkUrl).slice(0, 1000) : null
    const res = stmt.insert.run(user.id, p, key, id ? String(id).slice(0, 200) : null, url ? String(url).slice(0, 2000) : null, name, art, playlist.id, now())
    const row = stmt.byId.get(Number(res.lastInsertRowid))
    // The first sync runs in the background (the online list can take a while).
    sync(row.id).catch(() => {})
    return serialize(stmt.byId.get(row.id))
  }

  function unfollow(userId, followId) {
    const row = stmt.byId.get(Number(followId))
    if (!row || row.user_id !== Number(userId)) throw new FollowError('NOT_FOUND', 'Not followed.', 404)
    stmt.remove.run(row.id)
    return { ok: true }
  }

  function sync(followId) {
    const id = Number(followId)
    if (running.has(id)) return running.get(id)
    const job = runSync(id).finally(() => running.delete(id))
    running.set(id, job)
    return job
  }

  async function runSync(id) {
    const row = stmt.byId.get(id)
    if (!row) return null
    const user = getUser(row.user_id)
    // The tied playlist was deleted, or the account is gone: stop following.
    if (!user || user.disabled || !row.playlist_id) {
      stmt.remove.run(row.id)
      return null
    }
    let playlist
    try { playlist = catalog.getPlaylist(row.playlist_id, user.id) } catch {
      stmt.remove.run(row.id)
      return null
    }
    let data
    try {
      data = await discovery.onlinePlaylist(user, { provider: row.provider, id: row.source_id, url: row.source_url })
    } catch (error) {
      stmt.failed.run(now(), String(error?.code || error?.message || 'SYNC_FAILED').slice(0, 300), row.id)
      logger.debug?.(`[player] follow ${row.id} sync failed: ${error?.message || error}`)
      return serialize(stmt.byId.get(row.id))
    }
    const known = new Set(JSON.parse(row.known || '[]'))
    const inPlaylist = new Set((playlist.tracks || []).map((t) => t.id))
    const fresh = (data.tracks || []).filter((t) => !known.has(trackKey(t)))

    const ownedIds = []
    for (const t of fresh) {
      const trackId = t.library?.trackId
      if (!trackId) continue
      known.add(trackKey(t))
      if (!inPlaylist.has(trackId)) { ownedIds.push(trackId); inPlaylist.add(trackId) }
    }
    if (ownedIds.length) {
      try { catalog.addPlaylistTracks(row.playlist_id, user.id, ownedIds) } catch (error) {
        logger.warn?.(`⚠️ [player] follow ${row.id}: could not add songs: ${error?.message || error}`)
      }
    }

    let requested = 0
    let lastError = null
    if (bridge.canDownload(user)) {
      for (const t of fresh) {
        if (t.library || !t.url || requested >= maxNewPerSync) continue
        try {
          await bridge.request(user, { ...t, kind: 'track' }, { playlistId: row.playlist_id })
          known.add(trackKey(t))
          requested += 1
        } catch (error) {
          lastError = String(error?.code || error?.message || 'DOWNLOAD_FAILED').slice(0, 300)
          // A full queue: the rest waits for the next sync.
          if (error?.code === 'TOO_MANY_DOWNLOADS' || error?.code === 'DOWNLOADS_NOT_ALLOWED') break
        }
      }
    }
    const title = data.playlist?.title ? String(data.playlist.title).slice(0, 120) : null
    const art = /^https:\/\//i.test(String(data.playlist?.artworkUrl || '')) ? data.playlist.artworkUrl : null
    stmt.synced.run(JSON.stringify([...known].slice(-5000)), now(), ownedIds.length + requested, lastError, title, art, row.id)
    if (ownedIds.length || requested) logger.log?.(`🔁 [player] followed playlist "${row.title}": ${ownedIds.length} added, ${requested} downloading`)
    return serialize(stmt.byId.get(row.id))
  }

  // Called from the hourly housekeeping: lists that were not checked today.
  async function syncDue() {
    for (const { id } of stmt.due.all(now() - syncEveryMs)) {
      try { await sync(id) } catch (error) { logger.debug?.(`[player] follow sync failed: ${error?.message || error}`) }
    }
  }

  return { list, find, forPlaylist, follow, unfollow, sync, syncDue }
}
