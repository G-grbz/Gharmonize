import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpDir } from './fixtures/playerAudio.mjs'

import { openPlayerDatabase } from '../modules/player/db.js'
import { createCatalog } from '../modules/player/catalog.js'
import { createMixes, seededRandom, seededShuffle, spreadArtists, isRealGenre } from '../modules/player/mixes.js'
import { createStats, streaks, rangeBounds, listenerTraits } from '../modules/player/stats.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date(2026, 10, 13, 15, 0, 0).getTime()

// Two libraries; "bob" may only see the first. 4 artists × 10 songs per genre.
async function seed(t) {
  const dir = tmpDir('ghp-mixes-')
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const db = await openPlayerDatabase(dir)
  const run = (sql, ...p) => db.prepare(sql).run(...p)
  run(`INSERT INTO libraries (id, name, path, enabled, created_at) VALUES (1, 'A', '/a', 1, 0), (2, 'B', '/b', 1, 0)`)
  run(`INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at) VALUES (1, 'admin', 'Admin', 'x', 'admin', 0, 0), (2, 'bob', 'Bob', 'x', 'user', 0, 0)`)
  run(`INSERT INTO user_libraries (user_id, library_id) VALUES (2, 1)`)
  const artists = [['Rocky', 'Rock', 1, 1985], ['Stone', 'Rock', 1, 1988], ['Beats', 'Electronic', 1, 1995], ['Hidden', 'Jazz', 2, 1975]]
  let id = 0
  artists.forEach(([name, genre, lib, year], a) => {
    run(`INSERT INTO artists (id, name, name_key, created_at) VALUES (?, ?, ?, 0)`, a + 1, name, name.toLowerCase())
    run(`INSERT INTO albums (id, title, title_key, artist_id, created_at) VALUES (?, ?, ?, ?, 0)`, a + 1, `${name} LP`, `${name} lp`, a + 1)
    for (let i = 0; i < 10; i++) {
      id += 1
      run(`INSERT INTO tracks (id, library_id, rel_path, size, mtime_ms, title, artist_id, artist_name, album_id, album_title, year, genre, duration, added_at, updated_at)
        VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?, 200, 0, 0)`, id, lib, `${name}/${i}.mp3`, `${name} ${i}`, a + 1, name, a + 1, `${name} LP`, year + (i % 3), genre)
    }
  })
  const play = (uid, trackId, at, ms = 180000) => {
    run(`INSERT INTO play_history (user_id, track_id, played_at, played_ms, completed) VALUES (?, ?, ?, ?, 1)`, uid, trackId, at, ms)
    run(`INSERT INTO play_stats (user_id, track_id, play_count, last_played_at) VALUES (?, ?, 1, ?)
      ON CONFLICT (user_id, track_id) DO UPDATE SET play_count = play_count + 1, last_played_at = excluded.last_played_at`, uid, trackId, at)
  }
  return { db, run, play }
}

test('seeded helpers are stable and spread artists apart', () => {
  const a = seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom('x'))
  assert.deepEqual(a, seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom('x')))
  assert.notDeepEqual(a, seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], seededRandom('y')))
  const spread = spreadArtists([{ artist_id: 1 }, { artist_id: 1 }, { artist_id: 2 }, { artist_id: 2 }])
  assert.deepEqual(spread.map((r) => r.artist_id), [1, 2, 1, 2])
  assert.equal(isRealGenre('Music'), false)
  assert.equal(isRealGenre(' rock '), true)
})

test('mixes follow taste, respect library access and stay fixed for the day', async (t) => {
  const { db, play } = await seed(t)
  // Bob listens to Rocky (rock) a lot; Hidden (library 2) is not his.
  for (let i = 0; i < 6; i++) play(2, 1 + (i % 4), NOW - i * DAY)
  play(2, 21, NOW - DAY)
  let now = NOW
  const mixes = createMixes(db, { now: () => now })
  const list = mixes.list(2)
  const daily = list.filter((m) => m.kind === 'daily')
  assert.ok(daily.length >= 1)
  const rock = daily.find((m) => m.genre === 'Rock')
  assert.ok(rock, 'a rock mix exists')
  assert.ok(rock.artists.includes('Rocky'))
  assert.ok(rock.covers.length >= 1 && rock.trackCount >= 8)

  const full = mixes.get(2, rock.id)
  const visible = new Set(db.prepare('SELECT id FROM tracks WHERE library_id = 1').all().map((r) => r.id))
  assert.ok(full.trackIds.every((id) => visible.has(id)), 'only visible songs')
  assert.ok(full.trackIds.some((id) => id >= 11 && id <= 20), 'same-genre artist joins the mix')
  for (const m of list) assert.ok(mixes.get(2, m.id).trackIds.every((id) => visible.has(id)), `${m.id} visible only`)

  const discover = mixes.get(2, 'discover')
  if (discover) {
    const played = new Set([1, 2, 3, 4, 21])
    assert.ok(discover.trackIds.every((id) => !played.has(id)), 'discover = not yet played')
  }

  // Same day → same songs, even from a fresh instance; next day → refreshed.
  assert.deepEqual(createMixes(db, { now: () => NOW + 3600_000 }).get(2, rock.id).trackIds, full.trackIds)
  now = NOW + DAY
  assert.notDeepEqual(mixes.get(2, rock.id)?.trackIds, full.trackIds)
  assert.equal(mixes.get(2, 'nope'), null)
})

test('a brand-new listener still gets mixes from the library', async (t) => {
  const { db } = await seed(t)
  const list = createMixes(db, { now: () => NOW }).list(1)
  assert.ok(list.some((m) => m.kind === 'daily'))
  assert.ok(list.some((m) => m.kind === 'decade'))
})

test('listening stats, streaks and wrapped', async (t) => {
  const { db, play, run } = await seed(t)
  // Bob: 3 consecutive days ending today, plus one day last month.
  play(2, 1, NOW - 2 * DAY); play(2, 1, NOW - DAY); play(2, 2, NOW); play(2, 21, NOW)
  play(2, 11, NOW - 40 * DAY)
  // Too short to count.
  run(`INSERT INTO play_history (user_id, track_id, played_at, played_ms, completed) VALUES (2, 3, ?, 5000, 0)`, NOW)
  // Admin listened to a song bob cannot see.
  play(1, 31, NOW)
  const stats = createStats(db, { catalog: createCatalog(db), now: () => NOW })

  const month = stats.listening(2, { range: 'month' })
  assert.equal(month.plays, 4)
  assert.equal(month.minutes, 12)
  assert.equal(month.topTracks[0].title, 'Rocky 0')
  assert.equal(month.topTracks[0].plays, 2)
  assert.equal(month.topArtists[0].name, 'Rocky')
  assert.deepEqual(month.topGenres.map((g) => g.name), ['Rock', 'Electronic'])
  assert.deepEqual(month.streak, { longest: 3, current: 3 })
  assert.equal(month.activeDays, 3)
  assert.equal(month.newArtists.count, 2, 'Stone was first heard 40 days ago')
  assert.equal(month.hours.reduce((a, b) => a + b, 0), 12)
  assert.equal(month.weekdays.length, 7)

  const all = stats.listening(2, { range: 'all' })
  assert.equal(all.plays, 5)
  assert.equal(stats.listening(2, { range: 'week' }).plays, 4)

  const wrapped = stats.wrapped(2, 2026)
  assert.equal(wrapped.year, 2026)
  assert.equal(wrapped.plays, 5)
  assert.equal(wrapped.firstTrack.title, 'Stone 0')
  assert.deepEqual(stats.years(2), [2026])
  assert.equal(stats.wrapped(2, 2020).plays, 0)

  // Losing access hides the song from stats.
  run('DELETE FROM user_libraries WHERE user_id = 2')
  assert.equal(stats.listening(2, { range: 'all' }).plays, 0)
})

test('stat helpers', () => {
  assert.deepEqual(streaks(['2026-11-10', '2026-11-11', '2026-11-13'], '2026-11-13'), { longest: 2, current: 1 })
  assert.deepEqual(streaks(['2026-11-01', '2026-11-02'], '2026-11-13'), { longest: 2, current: 0 })
  assert.deepEqual(streaks([], '2026-11-13'), { longest: 0, current: 0 })
  assert.equal(rangeBounds('bogus', NOW).range, 'month')
  assert.equal(rangeBounds('all', NOW).from, 0)
  const night = Array(24).fill(0); night[23] = 50
  assert.deepEqual(listenerTraits({ hours: night, plays: 100, uniqueArtists: 60 }), ['nightOwl', 'explorer'])
  assert.deepEqual(listenerTraits({ hours: Array(24).fill(0), plays: 0, uniqueArtists: 0 }), [])
})

test('copies of one song show once in recent, top, mixes and stats', async (t) => {
  const { db, run, play } = await seed(t)
  // Track 41 is a second file of "Rocky 0" (e.g. from another playlist folder).
  run(`INSERT INTO tracks (id, library_id, rel_path, size, mtime_ms, title, artist_id, artist_name, album_id, album_title, year, genre, duration, added_at, updated_at)
    VALUES (41, 1, 'Playlist/Rocky 0.mp3', 1, 0, 'Rocky 0', 1, 'Rocky', 1, 'Rocky LP', 1985, 'Rock', 200, 0, 0)`)
  play(2, 1, NOW - 3000); play(2, 41, NOW - 2000); play(2, 2, NOW - 1000); play(2, 41, NOW - 500)
  const catalog = createCatalog(db, { now: () => NOW })
  const recent = catalog.recentlyPlayed(2, { limit: 10 })
  assert.deepEqual(recent.map((r) => r.title), ['Rocky 0', 'Rocky 1'])
  assert.deepEqual(catalog.mostPlayed(2, { limit: 10 }).map((r) => r.title), ['Rocky 0', 'Rocky 1'])
  const stats = createStats(db, { catalog, now: () => NOW }).listening(2, { range: 'week' })
  assert.equal(stats.topTracks[0].title, 'Rocky 0')
  assert.equal(stats.topTracks[0].plays, 3, 'plays of both files add up')
  assert.equal(stats.uniqueTracks, 2)
  for (const m of createMixes(db, { now: () => NOW }).list(2)) {
    const ids = createMixes(db, { now: () => NOW }).get(2, m.id).trackIds
    assert.ok(!(ids.includes(1) && ids.includes(41)), `${m.id} has the song twice`)
  }
})
