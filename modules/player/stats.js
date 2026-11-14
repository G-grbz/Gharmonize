// Listening statistics and the yearly "Wrapped" summary, computed from the
// user's own play history. Only songs the user can still see are named.

import { visibleSql, uidLiteral } from './access.js'
import { localDayKey, isRealGenre } from './mixes.js'
import { songKey } from './songKey.js'

const DAY = 24 * 60 * 60 * 1000
// A play "counts" after 30 s or when the song finished (same rule as stats).
const COUNTED = '(h.played_ms >= 30000 OR h.completed = 1)'
export const STAT_RANGES = ['week', 'month', 'year', 'all']

export function rangeBounds(range, nowMs, year = null) {
  if (year != null) {
    const y = Math.floor(Number(year))
    return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() - 1, range: 'year-of', year: y }
  }
  const r = STAT_RANGES.includes(range) ? range : 'month'
  const span = { week: 7 * DAY, month: 30 * DAY, year: 365 * DAY }[r]
  return { from: span ? nowMs - span : 0, to: nowMs, range: r }
}

/** Longest run of consecutive days, and the run ending today (or yesterday). */
export function streaks(dayKeys, todayKey) {
  const days = [...new Set(dayKeys)].sort()
  let longest = 0
  let run = 0
  let prev = null
  for (const key of days) {
    const d = new Date(`${key}T12:00:00`)
    run = prev && Math.round((d - prev) / DAY) === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    prev = d
  }
  let current = 0
  if (days.length) {
    const last = new Date(`${days.at(-1)}T12:00:00`)
    const gap = Math.round((new Date(`${todayKey}T12:00:00`) - last) / DAY)
    if (gap <= 1) {
      current = 1
      for (let i = days.length - 2; i >= 0; i--) {
        if (Math.round((new Date(`${days[i + 1]}T12:00:00`) - new Date(`${days[i]}T12:00:00`)) / DAY) === 1) current++
        else break
      }
    }
  }
  return { longest, current }
}

export function listenerTraits({ hours, plays, uniqueArtists }) {
  const traits = []
  const peak = hours.indexOf(Math.max(...hours))
  if (Math.max(...hours) > 0) {
    if (peak >= 22 || peak < 5) traits.push('nightOwl')
    else if (peak < 10) traits.push('earlyBird')
    else if (peak < 18) traits.push('dayListener')
    else traits.push('eveningListener')
  }
  if (plays >= 20) {
    const variety = uniqueArtists / plays
    traits.push(variety > 0.45 ? 'explorer' : variety < 0.15 ? 'loyal' : 'balanced')
  }
  return traits
}

export function createStats(db, { catalog, now = () => Date.now() } = {}) {
  function listening(uid, { range = 'month', year = null } = {}) {
    const b = rangeBounds(range, now(), year)
    const u = uidLiteral(uid)
    const vis = visibleSql('t', u)
    const base = `FROM play_history h JOIN tracks t ON t.id = h.track_id
      WHERE h.user_id = ${u} AND h.played_at BETWEEN ? AND ? AND ${COUNTED} AND ${vis}`
    const p = [b.from, b.to]
    const all = (sql) => db.prepare(sql).all(...p)
    const one = (sql) => db.prepare(sql).get(...p)

    const totals = one(`SELECT COUNT(*) AS plays, COALESCE(SUM(h.played_ms), 0) AS ms, COUNT(DISTINCT h.track_id) AS tracks,
      COUNT(DISTINCT t.artist_id) AS artists ${base}`)

    // Copies of one song (several files) count together.
    const songRows = all(`SELECT h.track_id AS id, t.title, t.artist_name, COUNT(*) AS plays, SUM(h.played_ms) AS ms ${base}
      GROUP BY h.track_id ORDER BY plays DESC, ms DESC LIMIT 60`)
    const bySong = new Map()
    for (const r of songRows) {
      const key = songKey(r.title, r.artist_name) || `id:${r.id}`
      const hit = bySong.get(key)
      if (hit) { hit.plays += r.plays; hit.ms += r.ms } else bySong.set(key, { id: r.id, plays: r.plays, ms: r.ms })
    }
    const topTrackRows = [...bySong.values()].sort((a, b) => b.plays - a.plays || b.ms - a.ms).slice(0, 10)
    const trackById = new Map(catalog.getTracksByIds(topTrackRows.map((r) => r.id), uid).map((t) => [t.id, t]))
    const topTracks = topTrackRows.map((r) => trackById.get(r.id) && { ...trackById.get(r.id), plays: r.plays, minutes: Math.round(r.ms / 60000) }).filter(Boolean)

    const topArtists = all(`SELECT ar.id, ar.name, COUNT(*) AS plays, SUM(h.played_ms) AS ms ${base.replace('JOIN tracks t ON t.id = h.track_id', 'JOIN tracks t ON t.id = h.track_id JOIN artists ar ON ar.id = t.artist_id')}
      GROUP BY ar.id ORDER BY plays DESC, ms DESC LIMIT 10`)
      .map((r) => ({ id: r.id, name: r.name, plays: r.plays, minutes: Math.round(r.ms / 60000), artwork: `artist/${r.id}` }))

    const topAlbums = all(`SELECT a.id, a.title, ar.name AS artist, COUNT(*) AS plays ${base.replace('JOIN tracks t ON t.id = h.track_id', 'JOIN tracks t ON t.id = h.track_id JOIN albums a ON a.id = t.album_id LEFT JOIN artists ar ON ar.id = a.artist_id')}
      GROUP BY a.id ORDER BY plays DESC LIMIT 6`)
      .map((r) => ({ id: r.id, title: r.title, artist: r.artist || '', plays: r.plays, artwork: `album/${r.id}` }))

    const topGenres = all(`SELECT t.genre AS name, COUNT(*) AS plays ${base} AND t.genre IS NOT NULL AND TRIM(t.genre) != ''
      GROUP BY t.genre COLLATE NOCASE ORDER BY plays DESC LIMIT 10`).filter((g) => isRealGenre(g.name)).slice(0, 6)

    const hours = Array(24).fill(0)
    for (const r of all(`SELECT CAST(strftime('%H', h.played_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS hr, SUM(h.played_ms) AS ms ${base} GROUP BY hr`)) {
      hours[r.hr] = Math.round(r.ms / 60000)
    }
    // 0 = Monday … 6 = Sunday
    const weekdays = Array(7).fill(0)
    for (const r of all(`SELECT CAST(strftime('%w', h.played_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS wd, SUM(h.played_ms) AS ms ${base} GROUP BY wd`)) {
      weekdays[(r.wd + 6) % 7] = Math.round(r.ms / 60000)
    }
    const dayRows = all(`SELECT strftime('%Y-%m-%d', h.played_at / 1000, 'unixepoch', 'localtime') AS day, SUM(h.played_ms) AS ms ${base} GROUP BY day`)
    const busiest = dayRows.reduce((best, r) => (!best || r.ms > best.ms ? r : best), null)

    const newArtistRows = db.prepare(`SELECT ar.id, ar.name, MIN(h.played_at) AS first FROM play_history h
      JOIN tracks t ON t.id = h.track_id JOIN artists ar ON ar.id = t.artist_id
      WHERE h.user_id = ${u} AND ${COUNTED} AND ${vis}
      GROUP BY ar.id HAVING first BETWEEN ? AND ? ORDER BY first DESC`).all(...p)

    const uniqueSongCount = new Set(all(`SELECT DISTINCT t.title, t.artist_name ${base}`).map((r) => songKey(r.title, r.artist_name) || r.title)).size
    const minutes = Math.round(totals.ms / 60000)
    return {
      range: b.range,
      year: b.year ?? null,
      from: b.from,
      to: b.to,
      minutes,
      plays: totals.plays,
      uniqueTracks: uniqueSongCount,
      uniqueArtists: totals.artists,
      topTracks,
      topArtists,
      topAlbums,
      topGenres,
      hours,
      weekdays,
      busiestDay: busiest ? { date: busiest.day, minutes: Math.round(busiest.ms / 60000) } : null,
      streak: streaks(dayRows.map((r) => r.day), localDayKey(now())),
      activeDays: dayRows.length,
      newArtists: { count: newArtistRows.length, names: newArtistRows.slice(0, 5).map((r) => r.name) },
      traits: listenerTraits({ hours, plays: totals.plays, uniqueArtists: totals.artists }),
    }
  }

  function wrapped(uid, year) {
    const y = Math.floor(Number(year)) || new Date(now()).getFullYear()
    const stats = listening(uid, { year: y })
    const u = uidLiteral(uid)
    const first = db.prepare(`SELECT h.track_id AS id FROM play_history h JOIN tracks t ON t.id = h.track_id
      WHERE h.user_id = ${u} AND h.played_at BETWEEN ? AND ? AND ${COUNTED} AND ${visibleSql('t', u)}
      ORDER BY h.played_at ASC LIMIT 1`).get(stats.from, stats.to)
    return { ...stats, firstTrack: first ? catalog.getTracksByIds([first.id], uid)[0] || null : null }
  }

  function years(uid) {
    return db.prepare(`SELECT DISTINCT CAST(strftime('%Y', played_at / 1000, 'unixepoch', 'localtime') AS INTEGER) AS y
      FROM play_history WHERE user_id = ? ORDER BY y DESC`).all(Number(uid)).map((r) => r.y)
  }

  return { listening, wrapped, years }
}
