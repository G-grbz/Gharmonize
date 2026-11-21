import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { BridgeError } from './coreAdapter.js'
import { visibleSql, uidLiteral } from './access.js'
import { placeUpgradeOutput, planUpgradeOutput, relocateDownloads } from './relocate.js'
import { transaction } from './db.js'
import { linkedTrack } from './annotate.js'

export { BridgeError }

export const ACTIVE_STATUSES = ['queued', 'resolving', 'downloading', 'indexing']
const FINAL_STATUSES = ['completed', 'exists', 'failed', 'canceled']
const MAX_ATTEMPTS = 3
// yt-dlp messages for uploads that cannot be played from here at all (region
// block, removed, private): retrying the same link is pointless.
const UNAVAILABLE_RE = /video unavailable|this video is not available|not available in your country|blocked it in your country|private video|video has been removed|account associated with this video has been terminated/i
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000

const ONLY_MAX = 1000

// The songs an album or playlist download is limited to: { title, artist, isrc, duration }.
export function onlyTracks(value) {
  if (!Array.isArray(value)) return []
  const text = (v, max) => String(v ?? '').trim().slice(0, max)
  return value.slice(0, ONLY_MAX).map((song) => ({
    id: text(song?.id, 100) || null,
    url: /^https:\/\//i.test(String(song?.url || '')) ? text(song.url, 2000) : null,
    title: text(song?.title, 300),
    artist: text(song?.artist, 300) || null,
    isrc: text(song?.isrc, 32).toUpperCase() || null,
    duration: Number(song?.duration) > 0 ? Number(song.duration) : null
  })).filter((song) => song.title)
}

function parseOnly(value) {
  try { return onlyTracks(JSON.parse(value || '[]')) } catch { return [] }
}

function parseIds(value) {
  try {
    const ids = JSON.parse(value || '[]')
    return Array.isArray(ids) ? ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []
  } catch { return [] }
}

export function serializeDownload(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    provider: row.provider,
    sourceUrl: row.source_url,
    requestedUrl: row.requested_url || null,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artworkUrl: row.artwork_url,
    duration: row.duration,
    status: row.status,
    active: ACTIVE_STATUSES.includes(row.status),
    progress: Math.max(0, Math.min(100, Number(row.progress) || 0)),
    phase: row.phase,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error_code ? { code: row.error_code, message: row.error } : null,
    trackIds: parseIds(row.result_track_ids),
    playlistId: row.playlist_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  }
}

function backoffMs(attempts) {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000)
}

export function createDownloadBridge({
  db,
  core,
  scanner,
  matcher,
  catalog,
  getConfig,
  // { dir, sourceRoot } while player downloads go to their own folder.
  getDownloadTarget = () => null,
  getUpgradeTarget,
  // The core's mapping cache of an album / playlist link (see linkedTrack).
  mappedLinks = async () => [],
  now = () => Date.now(),
  logger = console,
  pollMs = 2000
}) {
  const events = new EventEmitter()
  events.setMaxListeners(100)
  const resolving = new Set()
  let timer = null
  let ticking = false
  let stopped = false

  const stmt = {
    get: db.prepare('SELECT * FROM downloads WHERE id = ?'),
    insert: db.prepare(`INSERT INTO downloads (id, user_id, kind, provider, source_url, requested_url, title, artist, album, artwork_url, isrc, duration,
      expected_tracks, status, progress, phase, result_track_ids, playlist_id, created_at, updated_at, completed_at, upgrade_target, only_tracks)
      VALUES ($id, $user, $kind, $provider, $url, $requested, $title, $artist, $album, $art, $isrc, $duration, $expected, $status, $progress, $phase, $ids, $playlist, $ts, $ts, $completed, $upgrade, $only)`),
    activeBySource: db.prepare(`SELECT * FROM downloads WHERE (source_url = $u OR requested_url = $u) AND status IN ('queued','resolving','downloading','indexing') ORDER BY created_at LIMIT 1`),
    activeByTarget: db.prepare(`SELECT * FROM downloads WHERE (source_url = $u OR requested_url = $u) AND upgrade_target IS $upgrade AND status IN ('queued','resolving','downloading','indexing') ORDER BY created_at LIMIT 1`),
    doneBySource: db.prepare(`SELECT result_track_ids, completed_at, updated_at FROM downloads WHERE (source_url = $u OR requested_url = $u) AND status = 'completed' ORDER BY COALESCE(completed_at, updated_at) DESC LIMIT 5`),
    completedUpgrades: db.prepare(`SELECT * FROM downloads WHERE upgrade_target = ? AND status = 'completed' ORDER BY completed_at DESC`),
    liveResults: db.prepare(`SELECT t.id FROM json_each($ids) AS result
      JOIN tracks t ON t.id = result.value
      WHERE ${visibleSql('t')} AND t.added_at <= $completed
      ORDER BY result.key`),
    activeCountForUser: db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE user_id = ? AND status IN ('queued','resolving','downloading','indexing')`),
    inCore: db.prepare(`SELECT COUNT(*) AS n FROM downloads WHERE status IN ('resolving','downloading','indexing')`),
    dueQueued: db.prepare(`SELECT * FROM downloads WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?`),
    downloading: db.prepare(`SELECT * FROM downloads WHERE status = 'downloading'`),
    purge: db.prepare(`DELETE FROM downloads WHERE status IN ('completed','exists','failed','canceled') AND updated_at < ?`)
  }

  function update(id, fields) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    const sets = keys.map((k) => `${k} = $${k}`).join(', ')
    const params = { $id: id, $updated_at: now() }
    for (const k of keys) params[`$${k}`] = fields[k]
    db.prepare(`UPDATE downloads SET ${sets}, updated_at = $updated_at WHERE id = $id`).run(params)
    const row = stmt.get.get(id)
    events.emit('update', serializeDownload(row))
    return row
  }

  function liveResultIds(row, userId) {
    const ids = parseIds(row.result_track_ids)
    if (!ids.length) return ids
    // An older database could reuse a deleted row's ID for a later import.
    return stmt.liveResults.all({ $ids: JSON.stringify(ids), $uid: userId, $completed: row.completed_at ?? row.updated_at })
      .map((result) => result.id)
  }

  function downloadForUser(row, userId) {
    return { ...serializeDownload(row), trackIds: liveResultIds(row, userId) }
  }

  // Tracks an earlier download of this exact link produced that still exist
  // and that this user may see (the files may have been deleted since).
  function previousResult(url, userId) {
    if (!url) return []
    for (const row of stmt.doneBySource.all({ $u: String(url) })) {
      const ids = liveResultIds(row, userId)
      if (ids.length) return ids
    }
    return []
  }

  function libraryBySources(urls = [], userId) {
    const out = new Map()
    for (const url of urls) {
      if (!url || out.has(url)) continue
      const ids = previousResult(url, userId)
      if (ids.length) out.set(url, ids)
    }
    return out
  }

  // Master switch in the player config + per-user right (admins always).
  function canDownload(user) {
    if (!user || user.disabled) return false
    if (!getConfig().downloadsEnabled) return false
    return user.role === 'admin' || Boolean(user.canDownload)
  }

  function attachPlaylist(userId, playlistId, trackIds) {
    if (!playlistId || !trackIds.length || !catalog) return
    try { catalog.addPlaylistTracks(playlistId, userId, trackIds) } catch (error) {
      logger.warn?.(`⚠️ [player] could not add downloaded tracks to playlist ${playlistId}: ${error?.message || error}`)
    }
  }

  function albumTrackIds(albumId, userId) {
    return db.prepare(`SELECT t.id FROM tracks t WHERE t.album_id = ? AND ${visibleSql('t', uidLiteral(userId))}
      ORDER BY COALESCE(t.disc_no,1), COALESCE(t.track_no,9999)`).all(Number(albumId)).map((r) => r.id)
  }

  // Creates a download request. Returns the (possibly pre-existing) record.
  async function request(user, input = {}, { playlistId = null, force = false, signal, onRequested, upgrade = null } = {}) {
    signal?.throwIfAborted()
    if (!user?.id) throw new BridgeError('PLAYER_AUTH_REQUIRED', 'Sign in first.', { status: 401 })
    if (!canDownload(user)) throw new BridgeError('DOWNLOADS_NOT_ALLOWED', 'Downloading into the library is not allowed for this account.', { status: 403 })
    const kind = ['track', 'album', 'playlist'].includes(input.kind) ? input.kind : 'track'
    const rawUrl = String(input.url || '').trim()
    if (!rawUrl) throw new BridgeError('SOURCE_URL_REQUIRED', 'A source link is required.')
    const defaultLib = db.prepare('SELECT enabled FROM libraries WHERE is_default = 1').get()
    if (upgrade) getUpgradeTarget(upgrade, { checkWritable: true })
    else if (defaultLib && !defaultLib.enabled && !getDownloadTarget()) {
      throw new BridgeError('DEFAULT_LIBRARY_DISABLED', 'The Gharmonize download library is disabled and no player download folder is set, so downloads would not appear in the player.', { status: 409 })
    }
    const info = await core.inspect(rawUrl)
    signal?.throwIfAborted()
    const ts = now()
    // Albums and playlists: only these songs (the ones the library lacks).
    let only = kind === 'track' ? [] : onlyTracks(input.only)
    const base = {
      $user: user.id,
      $kind: kind,
      $provider: info.provider,
      $url: info.url,
      $requested: rawUrl.slice(0, 2000),
      $title: String(input.title || '').slice(0, 300) || null,
      $artist: String(input.artist || '').slice(0, 300) || null,
      $album: String(input.album || '').slice(0, 300) || null,
      $art: /^https:\/\//i.test(String(input.artworkUrl || '')) ? String(input.artworkUrl).slice(0, 1000) : null,
      $isrc: String(input.isrc || '').trim().toUpperCase().slice(0, 32) || null,
      $duration: Number(input.duration) > 0 ? Number(input.duration) : null,
      $expected: Number(input.trackCount) > 0 ? Math.floor(Number(input.trackCount)) : null,
      $playlist: Number(playlistId) > 0 ? Number(playlistId) : null,
      $upgrade: upgrade ? JSON.stringify(upgrade) : null,
      $only: null,
      $ts: ts
    }
    if (base.$playlist && catalog) {
      // Validate ownership up front so a bad playlist id fails fast.
      const pl = catalog.getPlaylist(base.$playlist, user.id)
      if (!pl.editable) throw new BridgeError('FORBIDDEN', 'Only the owner can add to this playlist.', { status: 403 })
    }

    // 1) Already in the library → no download.
    if (only.length && matcher) {
      // The client's list can be stale: songs that arrived meanwhile are skipped,
      // and so are songs an earlier download of this link already brought.
      const owned = []
      let links = []
      try { links = await mappedLinks(info.url) } catch {}
      signal?.throwIfAborted()
      only = only.filter((song) => {
        const id = matcher.findTrack(song, user.id) || linkedTrack(matcher, links, song, user.id)
        if (id) owned.push(id)
        return !id
      })
      if (!only.length) {
        const id = crypto.randomUUID()
        stmt.insert.run({ ...base, $id: id, $status: 'exists', $progress: 100, $phase: null, $ids: JSON.stringify(owned), $completed: ts })
        attachPlaylist(user.id, base.$playlist, owned)
        const row = serializeDownload(stmt.get.get(id))
        events.emit('update', row)
        return row
      }
    }
    if (only.length) {
      base.$only = JSON.stringify(only)
      base.$expected = only.length
    }
    if (!force && !only.length && matcher) {
      let existingIds = []
      if (kind === 'track') {
        const id = matcher.findTrack({ title: input.title, artist: input.artist, isrc: base.$isrc, duration: base.$duration }, user.id)
        if (id) existingIds = [id]
      } else if (kind === 'album') {
        const album = matcher.findAlbum({ title: input.title, artist: input.artist }, user.id)
        if (album && (!base.$expected || album.trackCount >= base.$expected)) existingIds = albumTrackIds(album.id, user.id)
      }
      // The same link was downloaded before and its songs are still there.
      if (!existingIds.length) existingIds = previousResult(info.url, user.id).concat(info.url !== rawUrl ? previousResult(rawUrl, user.id) : [])
      existingIds = [...new Set(existingIds)]
      if (existingIds.length && (kind === 'track' || !base.$expected || existingIds.length >= base.$expected)) {
        const id = crypto.randomUUID()
        stmt.insert.run({ ...base, $id: id, $status: 'exists', $progress: 100, $phase: null, $ids: JSON.stringify(existingIds), $completed: ts })
        attachPlaylist(user.id, base.$playlist, existingIds)
        const row = serializeDownload(stmt.get.get(id))
        events.emit('update', row)
        return row
      }
    }

    // 2) The same link is already on its way → join it (a download of only
    // some songs cannot stand in for the whole album or playlist).
    const running = stmt.activeByTarget.get({ $u: info.url, $upgrade: base.$upgrade })
    if (running && (only.length || !running.only_tracks)) {
      if (base.$playlist && !running.playlist_id && running.user_id === user.id) update(running.id, { playlist_id: base.$playlist })
      if (onRequested) transaction(db, () => onRequested(running.id, false), { durable: true })
      return serializeDownload(stmt.get.get(running.id))
    }

    // 3) Per-user fairness.
    const cfg = getConfig()
    if (stmt.activeCountForUser.get(user.id).n >= cfg.maxQueuedPerUser) {
      throw new BridgeError('TOO_MANY_DOWNLOADS', `You already have ${cfg.maxQueuedPerUser} downloads waiting.`, { status: 429 })
    }

    const id = crypto.randomUUID()
    const enqueue = () => {
      stmt.insert.run({ ...base, $id: id, $status: 'queued', $progress: 0, $phase: 'queued', $ids: '[]', $completed: null })
      onRequested?.(id, true)
    }
    // The batch must be able to find this exact download after a restart.
    if (onRequested) transaction(db, enqueue, { durable: true })
    else enqueue()
    const row = serializeDownload(stmt.get.get(id))
    events.emit('update', row)
    schedule(0)
    return row
  }

  function fail(row, error) {
    const code = error?.code || 'DOWNLOAD_FAILED'
    const message = String(error?.message || error || 'Download failed').slice(0, 500)
    const attempts = (row.attempts || 0) + 1
    if (!error?.permanent && attempts < MAX_ATTEMPTS && !stopped) {
      update(row.id, { status: 'queued', phase: 'retry-wait', attempts, job_id: null, progress: 0, next_attempt_at: now() + backoffMs(attempts), error_code: code, error: message })
      logger.warn?.(`⚠️ [player] download ${row.id} failed (${code}), retry ${attempts}/${MAX_ATTEMPTS - 1}`)
      return
    }
    update(row.id, { status: 'failed', phase: null, attempts, job_id: null, error_code: code, error: message, completed_at: now() })
    logger.warn?.(`⚠️ [player] download ${row.id} failed permanently: ${code} ${message}`)
  }

  // The upload is unavailable here: switch once to a public copy of the same
  // song (same artist, title and length). Returns true when it switched.
  async function tryAlternative(row, message) {
    if (!core.findAlternative || row.kind !== 'track' || row.provider !== 'youtube' || row.alternate_of || !row.title || !row.artist) return false
    if (!UNAVAILABLE_RE.test(String(message || ''))) return false
    let url = null
    try { url = await core.findAlternative({ title: row.title, artist: row.artist, duration: row.duration, excludeUrl: row.source_url }) } catch (error) {
      logger.debug?.(`[player] alternative search failed: ${error?.message || error}`)
    }
    const current = stmt.get.get(row.id)
    if (!url || stopped || current?.status !== 'resolving') return false
    update(row.id, { source_url: url, alternate_of: row.source_url, status: 'queued', phase: 'queued', job_id: null, progress: 0, next_attempt_at: null, error_code: null, error: null })
    logger.log?.(`🔁 [player] download ${row.id}: source unavailable, using ${url}`)
    schedule(0)
    return true
  }

  // Failure handling shared by resolving and running jobs.
  async function failOrSwitch(row, error) {
    const message = String(error?.message || error || '')
    if (await tryAlternative(row, message)) return
    const current = stmt.get.get(row.id)
    if (current?.status !== 'resolving') return
    // Unavailable uploads never come back on a retry.
    fail(current, UNAVAILABLE_RE.test(message) ? new BridgeError(error?.code || 'SOURCE_UNAVAILABLE', message, { permanent: true }) : error)
  }

  async function begin(row) {
    resolving.add(row.id)
    update(row.id, { status: 'resolving', phase: 'resolving', next_attempt_at: null })
    try {
      const cfg = getConfig()
      const only = parseOnly(row.only_tracks)
      const { jobId } = await core.createAndEnqueue({
        url: row.source_url,
        kind: row.kind,
        only: only.length ? only : null,
        preset: {
          format: cfg.downloadFormat,
          bitrate: cfg.downloadBitrate,
          lyrics: cfg.downloadLyrics
        },
        tag: row.id,
        isCanceled: () => stmt.get.get(row.id)?.status !== 'resolving'
      })
      const current = stmt.get.get(row.id)
      if (current?.status !== 'resolving') {
        await core.cancel(jobId).catch(() => {})
        return
      }
      update(row.id, { status: 'downloading', phase: 'queued', job_id: jobId, progress: 0 })
    } catch (error) {
      const current = stmt.get.get(row.id)
      if (current?.status === 'resolving') await failOrSwitch(current, error)
    } finally {
      resolving.delete(row.id)
    }
  }

  async function finalize(row, job) {
    let upgradeTarget
    if (row.upgrade_target) {
      try { upgradeTarget = getUpgradeTarget(JSON.parse(row.upgrade_target)) } catch (error) {
        if (error.code === 'UPGRADE_FOLDER_UNAVAILABLE') {
          if (row.phase !== 'waiting-folder') update(row.id, { phase: 'waiting-folder', progress: 100 })
        } else fail(row, new BridgeError(error.code || 'MOVE_FAILED', error.message, { permanent: true }))
        return
      }
    }
    update(row.id, { status: 'indexing', phase: 'indexing', progress: 100 })
    if (!row.upgrade_output && !job?.outputs.length) {
      fail(stmt.get.get(row.id), new BridgeError('NO_OUTPUT', job.error || 'The download finished without producing audio files.'))
      return
    }
    let outputs = job?.outputs || []
    const target = upgradeTarget ? null : getDownloadTarget()
    if (upgradeTarget) {
      try {
        let plan = row.upgrade_output && JSON.parse(row.upgrade_output)
        if (!plan) {
          if (outputs.length !== 1) throw new Error('The quality upgrade must produce one audio file.')
          plan = await planUpgradeOutput(outputs[0], upgradeTarget)
          transaction(db, () => db.prepare('UPDATE downloads SET upgrade_output = ? WHERE id = ?').run(JSON.stringify(plan), row.id), { durable: true })
        }
        outputs = [await placeUpgradeOutput(plan, upgradeTarget, row.id, logger)]
      } catch (error) {
        fail(stmt.get.get(row.id), new BridgeError('MOVE_FAILED', error.message, { permanent: true }))
        return
      }
    } else if (target) {
      try {
        const moved = await relocateDownloads(outputs, { sourceRoot: target.sourceRoot, targetDir: target.dir, logger })
        outputs = outputs.map((file) => moved.get(file)).filter(Boolean)
      } catch (error) {
        fail(stmt.get.get(row.id), new BridgeError('MOVE_FAILED', `The files could not be moved to the player download folder: ${error?.message || error}`, { permanent: true }))
        return
      }
    }
    let indexed
    try { indexed = await scanner.indexFiles(outputs) } catch (error) {
      fail(stmt.get.get(row.id), new BridgeError('INDEX_FAILED', error?.message || 'Indexing failed.', { permanent: Boolean(row.upgrade_target) }))
      return
    }
    const trackIds = outputs.map((file) => indexed.get(file)).filter(Boolean)
    if (!trackIds.length) {
      fail(stmt.get.get(row.id), new BridgeError('NOT_IN_LIBRARY', 'The files were downloaded but are not inside an enabled library (is the Gharmonize download library disabled?).', { permanent: true }))
      return
    }
    update(row.id, { status: 'completed', phase: null, result_track_ids: JSON.stringify([...new Set(trackIds)]), error_code: null, error: null, completed_at: now(), upgrade_output: null })
    attachPlaylist(row.user_id, row.playlist_id, trackIds)
    logger.log?.(`🎧 [player] download ${row.id} added ${trackIds.length} track(s) to the library`)
  }

  async function checkDownloading() {
    for (const row of stmt.downloading.all()) {
      if (stopped) return
      if (row.upgrade_output) { await finalize(row, null); continue }
      let job
      try { job = row.job_id ? await core.getJob(row.job_id) : null } catch (error) {
        logger.debug?.(`[player] job lookup failed: ${error?.message || error}`)
        continue
      }
      if (stmt.get.get(row.id)?.status !== 'downloading') continue
      if (!job) {
        // The core job vanished (e.g. server restart): run it again.
        fail(row, new BridgeError('INTERRUPTED', 'The download was interrupted.'))
        continue
      }
      if (job.status === 'completed') { await finalize(row, job); continue }
      if (job.status === 'error') {
        await core.cleanupJob?.(row.job_id).catch(() => {})
        if (stmt.get.get(row.id)?.status !== 'downloading') continue
        // The alternative search can take a while: run it outside the tick.
        update(row.id, { status: 'resolving', phase: 'resolving', job_id: null })
        resolving.add(row.id)
        failOrSwitch(row, new BridgeError('CORE_JOB_FAILED', job.error || 'The download failed.')).finally(() => resolving.delete(row.id))
        continue
      }
      if (job.status === 'canceled') {
        update(row.id, { status: 'canceled', phase: null, completed_at: now() })
        await core.cleanupJob?.(row.job_id).catch(() => {})
        continue
      }
      const progress = Math.round(job.progress * 10) / 10
      if (progress !== row.progress || job.phase !== row.phase) update(row.id, { progress, phase: job.phase })
    }
  }

  function startDue() {
    const cfg = getConfig()
    const free = cfg.maxParallelDownloads - stmt.inCore.get().n
    if (free <= 0) return
    for (const row of stmt.dueQueued.all(now(), free)) {
      if (resolving.has(row.id)) continue
      begin(row)
    }
  }

  async function tick() {
    if (ticking || stopped) return
    ticking = true
    try {
      await checkDownloading()
      startDue()
    } catch (error) {
      logger.error?.('❌ [player] download bridge tick failed:', error?.message || error)
    } finally {
      ticking = false
    }
  }

  function schedule(delay = pollMs) {
    if (stopped) return
    setTimeout(() => tick(), delay).unref?.()
  }

  function start() {
    // After a restart nothing is "resolving" in memory any more.
    db.prepare(`UPDATE downloads SET status = 'downloading', updated_at = ? WHERE status = 'indexing' AND upgrade_target IS NOT NULL`).run(now())
    db.prepare(`UPDATE downloads SET status = 'queued', phase = 'queued', updated_at = ? WHERE status IN ('resolving', 'indexing')`).run(now())
    timer = setInterval(() => tick(), pollMs)
    timer.unref?.()
    schedule(0)
  }

  async function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    // Wait briefly for in-flight resolution so the DB is not closed under it.
    for (let i = 0; i < 50 && (resolving.size || ticking); i += 1) await new Promise((r) => setTimeout(r, 100))
  }

  function get(id, user) {
    const row = stmt.get.get(String(id))
    if (!row || (row.user_id !== user?.id && user?.role !== 'admin')) throw new BridgeError('NOT_FOUND', 'Download not found.', { status: 404 })
    return downloadForUser(row, user.id)
  }

  function completedUpgrades(user, target) {
    return stmt.completedUpgrades.all(JSON.stringify(target)).map((row) => downloadForUser(row, user.id))
  }

  function list(user, { all = false, limit = 100, activeOnly = false } = {}) {
    const where = []
    const params = { $limit: Math.min(Math.max(Number(limit) || 100, 1), 500) }
    if (!(all && user?.role === 'admin')) { where.push('user_id = $uid'); params.$uid = user.id }
    if (activeOnly) where.push(`status IN ('queued','resolving','downloading','indexing')`)
    return db.prepare(`SELECT * FROM downloads ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (status IN ('queued','resolving','downloading','indexing')) DESC, created_at DESC LIMIT $limit`).all(params)
      .map((row) => downloadForUser(row, user.id))
  }

  async function cancel(id, user) {
    const row = stmt.get.get(String(id))
    if (!row || (row.user_id !== user?.id && user?.role !== 'admin')) throw new BridgeError('NOT_FOUND', 'Download not found.', { status: 404 })
    // Once the audio is written, let indexing finish.
    if (FINAL_STATUSES.includes(row.status) || row.status === 'indexing') return downloadForUser(row, user.id)
    const canceled = update(row.id, { status: 'canceled', phase: null, completed_at: now() })
    if (row.job_id) {
      await core.cancel(row.job_id).catch(() => {})
      // Give the core a moment to stop its processes before removing the folder.
      setTimeout(() => core.cleanupJob?.(row.job_id).catch(() => {}), 3000).unref?.()
    }
    return serializeDownload(canceled)
  }

  function retry(id, user) {
    const row = stmt.get.get(String(id))
    if (!row || (row.user_id !== user?.id && user?.role !== 'admin')) throw new BridgeError('NOT_FOUND', 'Download not found.', { status: 404 })
    if (!['failed', 'canceled'].includes(row.status)) return downloadForUser(row, user.id)
    const running = stmt.activeByTarget.get({ $u: row.source_url, $upgrade: row.upgrade_target })
    if (running) return serializeDownload(running)
    const resume = Boolean(row.upgrade_output)
    const updated = update(row.id, { status: resume ? 'downloading' : 'queued', phase: resume ? 'indexing' : 'queued', attempts: 0, next_attempt_at: null, job_id: null, error_code: null, error: null, progress: resume ? 100 : 0, completed_at: null })
    schedule(0)
    return serializeDownload(updated)
  }

  // Active download state per source link, used to badge online results.
  function activeBySources(urls = []) {
    const out = new Map()
    for (const url of urls) {
      if (!url) continue
      const row = stmt.activeBySource.get({ $u: String(url) })
      if (row) out.set(url, { id: row.id, status: row.status, progress: row.progress })
    }
    return out
  }

  function purgeOld() {
    stmt.purge.run(now() - RETENTION_MS)
  }

  return { request, get, completedUpgrades, list, cancel, retry, activeBySources, libraryBySources, start, stop, tick, purgeOld, events, canDownload }
}
