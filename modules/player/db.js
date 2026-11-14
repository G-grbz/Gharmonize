import path from 'node:path'
import { ensurePrivateDir } from './paths.js'

let DatabaseSyncCtor = null

// node:sqlite prints an ExperimentalWarning on Node 22. It is only loaded once
// the player is enabled, and only that specific warning is silenced.
async function loadSqlite() {
  if (DatabaseSyncCtor) return DatabaseSyncCtor
  const originalEmit = process.emitWarning
  process.emitWarning = function patchedEmitWarning(warning, ...rest) {
    const message = typeof warning === 'string' ? warning : warning?.message
    if (/SQLite is an experimental feature/i.test(String(message || ''))) return
    return originalEmit.call(this, warning, ...rest)
  }
  try {
    const mod = await import('node:sqlite')
    DatabaseSyncCtor = mod.DatabaseSync
  } finally {
    process.emitWarning = originalEmit
  }
  return DatabaseSyncCtor
}

const MIGRATIONS = [
  // v1: library index, multi-user accounts, devices, personal data.
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE libraries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_scan_at INTEGER,
    last_scan_status TEXT,
    last_scan_error TEXT,
    track_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE artists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE albums (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    title_key TEXT NOT NULL,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    year INTEGER,
    genre TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (title_key, artist_id)
  );

  CREATE TABLE tracks (
    id INTEGER PRIMARY KEY,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    rel_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    title TEXT NOT NULL,
    artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
    artist_name TEXT,
    album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
    album_title TEXT,
    album_artist TEXT,
    track_no INTEGER,
    disc_no INTEGER,
    year INTEGER,
    genre TEXT,
    duration REAL,
    bitrate INTEGER,
    sample_rate INTEGER,
    bit_depth INTEGER,
    channels INTEGER,
    codec TEXT,
    container TEXT,
    lossless INTEGER NOT NULL DEFAULT 0,
    has_embedded_art INTEGER NOT NULL DEFAULT 0,
    has_lyrics INTEGER NOT NULL DEFAULT 0,
    isrc TEXT,
    rg_track_gain REAL,
    rg_album_gain REAL,
    bpm REAL,
    added_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (library_id, rel_path)
  );
  CREATE INDEX tracks_album_idx ON tracks(album_id, disc_no, track_no);
  CREATE INDEX tracks_artist_idx ON tracks(artist_id);
  CREATE INDEX tracks_added_idx ON tracks(added_at DESC);
  CREATE INDEX tracks_genre_idx ON tracks(genre);
  CREATE INDEX tracks_isrc_idx ON tracks(isrc);

  CREATE VIRTUAL TABLE tracks_fts USING fts5(
    title, artist, album, album_artist, genre,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('session', 'device')),
    name TEXT,
    platform TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    last_ip TEXT,
    expires_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX tokens_user_idx ON tokens(user_id);

  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE favorites (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('track', 'album', 'artist')),
    item_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_type, item_id)
  );

  CREATE TABLE playlists (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_public INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX playlists_user_idx ON playlists(user_id);

  CREATE TABLE playlist_tracks (
    id INTEGER PRIMARY KEY,
    playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    added_at INTEGER NOT NULL
  );
  CREATE INDEX playlist_tracks_idx ON playlist_tracks(playlist_id, position);

  CREATE TABLE play_history (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    played_at INTEGER NOT NULL,
    played_ms INTEGER NOT NULL DEFAULT 0,
    completed INTEGER NOT NULL DEFAULT 0,
    context TEXT,
    device_id TEXT
  );
  CREATE INDEX play_history_user_idx ON play_history(user_id, played_at DESC);

  CREATE TABLE play_stats (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    play_count INTEGER NOT NULL DEFAULT 0,
    skip_count INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER,
    PRIMARY KEY (user_id, track_id)
  );
  CREATE INDEX play_stats_count_idx ON play_stats(user_id, play_count DESC);
  `,
  // v2: download bridge. Survives restarts; one row per user request.
  `
  CREATE TABLE downloads (
    id TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK (kind IN ('track', 'album', 'playlist')),
    provider TEXT NOT NULL,
    source_url TEXT NOT NULL,
    requested_url TEXT,
    title TEXT,
    artist TEXT,
    album TEXT,
    artwork_url TEXT,
    isrc TEXT,
    duration REAL,
    expected_tracks INTEGER,
    status TEXT NOT NULL CHECK (status IN ('queued', 'resolving', 'downloading', 'indexing', 'completed', 'exists', 'failed', 'canceled')),
    progress REAL NOT NULL DEFAULT 0,
    phase TEXT,
    job_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER,
    error_code TEXT,
    error TEXT,
    result_track_ids TEXT NOT NULL DEFAULT '[]',
    playlist_id INTEGER REFERENCES playlists(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER
  );
  CREATE INDEX downloads_status_idx ON downloads(status);
  CREATE INDEX downloads_user_idx ON downloads(user_id, created_at DESC);
  CREATE INDEX downloads_source_idx ON downloads(source_url);
  CREATE INDEX downloads_requested_idx ON downloads(requested_url);
  `,
  // v3: persistent cache for online discovery (charts, artist data ...).
  `
  CREATE TABLE online_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX online_cache_fetched_idx ON online_cache(fetched_at);
  `,
  // v4: per-user permissions — library access grants and download right.
  `
  ALTER TABLE users ADD COLUMN can_download INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN all_libraries INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE user_libraries (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, library_id)
  );
  CREATE INDEX user_libraries_library_idx ON user_libraries(library_id);
  `,
  // v5: use the embedded source link to match downloaded YouTube tracks.
  `
  ALTER TABLE tracks ADD COLUMN source_key TEXT;
  CREATE INDEX tracks_source_key_idx ON tracks(source_key);
  UPDATE tracks SET mtime_ms = 0;
  `,
  // v6: artist lookups go through albums.artist_id (album artists, matching).
  `
  CREATE INDEX albums_artist_idx ON albums(artist_id);
  `,
  // v7: a download whose source was unavailable remembers the original link
  // after switching to a substitute upload (only one switch per download).
  `
  ALTER TABLE downloads ADD COLUMN alternate_of TEXT;
  `
]

export async function openPlayerDatabase(dataDir, { fileName = 'player.db' } = {}) {
  const DatabaseSync = await loadSqlite()
  const file = fileName === ':memory:' ? ':memory:' : path.join(ensurePrivateDir(dataDir), fileName)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  migrate(db)
  return db
}

function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version || 0)
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version])
      db.exec(`PRAGMA user_version = ${version + 1}`)
    })
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try { db.exec('ROLLBACK') } catch {}
    throw error
  }
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return fallback
  try { return JSON.parse(row.value) } catch { return fallback }
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value))
}
