import fs from 'node:fs'
import path from 'node:path'
import { resolveRuntimeCacheDir } from '../runtimeEnvironment.js'

// Player state (users, playlists, library index) must survive container
// re-creation. The official Docker image runs with a read-only root file
// system and only DATA_DIR/cache (and outputs etc.) are mounted volumes, so
// inside Docker the database lives below the cache volume. Elsewhere it lives
// in DATA_DIR/player-data. PLAYER_DATA_DIR always wins.
export function resolvePlayerDataDir(env = process.env, { inDocker = fs.existsSync('/.dockerenv') } = {}) {
  const explicit = String(env.PLAYER_DATA_DIR || '').trim()
  if (explicit) return path.resolve(explicit)
  if (inDocker) return path.join(resolveRuntimeCacheDir(env), 'player')
  return path.resolve(env.DATA_DIR || process.cwd(), 'player-data')
}

// Regenerable data (resized artwork, transcodes) always goes to the cache dir.
export function resolvePlayerCacheDir(env = process.env) {
  const explicit = String(env.PLAYER_CACHE_DIR || '').trim()
  if (explicit) return path.resolve(explicit)
  return path.join(resolveRuntimeCacheDir(env), 'player-cache')
}

// Gharmonize's own download library (DATA_DIR/outputs) is the default library.
export function resolveDefaultLibraryDir(env = process.env) {
  return path.resolve(env.DATA_DIR || process.cwd(), 'outputs')
}

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch {}
  return dir
}
