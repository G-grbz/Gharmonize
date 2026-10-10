import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

let initialized;

// Resolve once, before any route captures DATA_DIR. Desktop userData is a
// fallback/profile directory, not an override of the user's storage choice.
export function resolveRuntimeDataDir(env, { cwd = process.cwd(), desktopDataDir = '', pathApi = path } = {}) {
  const base = desktopDataDir || cwd;
  return pathApi.resolve(base, String(env.DATA_DIR || '').trim() || base);
}

// Packaged desktop caches share Chromium's capitalization. Keep Node/Docker
// defaults unchanged so existing volumes and deployment paths remain valid.
// No legacy-cache migration or fallback: desktop starts with a fresh cache.
export function resolveRuntimeCacheDir(env = process.env, pathApi = path) {
  const name = String(env.GHARMONIZE_DESKTOP_DATA_DIR || '').trim() ? 'Cache' : 'cache';
  return pathApi.resolve(env.DATA_DIR || process.cwd(), name);
}

export function initializeRuntimeEnvironment({ env = process.env, cwd = process.cwd(), desktopDataDir = '' } = {}) {
  if (env === process.env && initialized) return initialized;
  const inherited = { ...env };
  const desktop = desktopDataDir || String(inherited.GHARMONIZE_DESKTOP_DATA_DIR || '').trim();
  const userEnv = path.resolve(cwd, inherited.ENV_USER_PATH || inherited.ENV_PATH || path.join(cwd, '.env'));
  const defaultEnv = inherited.ENV_DEFAULT_PATH ? path.resolve(cwd, inherited.ENV_DEFAULT_PATH) : '';
  const readEnv = (file) => file && fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
  const values = { ...readEnv(defaultEnv), ...readEnv(userEnv) };
  // Deployment environment wins over files (in particular Docker mount paths).
  // Empty path overrides should still allow a configured .env value/fallback.
  const pathKeys = new Set(['DATA_DIR', 'OUTPUTS_DISPLAY_DIR', 'LOCAL_INPUT_DIR', 'GHARMONIZE_MASTER_KEY_FILE']);
  for (const [key, value] of Object.entries(inherited)) {
    if (!pathKeys.has(key) || String(value || '').trim()) values[key] = value;
  }
  Object.assign(env, values);
  env.ENV_USER_PATH = userEnv; // Settings must save to the file actually loaded.
  env.ENV_DEFAULT_PATH = defaultEnv;
  env.DATA_DIR = resolveRuntimeDataDir(env, { cwd, desktopDataDir: desktop });
  if (desktop && !String(env.GHARMONIZE_MASTER_KEY_FILE || '').trim()) {
    // Keep existing encrypted settings readable when only storage is moved.
    env.GHARMONIZE_MASTER_KEY_FILE = path.join(desktop, '.gharmonize-key');
  }
  if (String(env.LOCAL_INPUT_DIR || '').trim()) {
    env.LOCAL_INPUT_DIR = path.resolve(env.DATA_DIR, env.LOCAL_INPUT_DIR.trim());
  }
  fs.mkdirSync(env.DATA_DIR, { recursive: true });
  const result = { dataDir: env.DATA_DIR, userEnv, defaultEnv };
  if (env === process.env) initialized = result;
  return result;
}

// A display alias may name a Windows host path while the server runs on Linux.
// It must never become a storage root or be passed to a local folder opener.
export function resolveOutputsLocation(env = process.env, pathApi = path) {
  const outputDir = pathApi.resolve(env.DATA_DIR || process.cwd(), 'outputs');
  const raw = String(env.OUTPUTS_DISPLAY_DIR || '').trim();
  const foreignWindowsPath = pathApi === path.posix && path.win32.isAbsolute(raw) && !path.posix.isAbsolute(raw);
  const displayDir = !raw ? outputDir : foreignWindowsPath ? path.win32.normalize(raw) : pathApi.resolve(env.DATA_DIR || process.cwd(), raw);
  return { outputDir, displayDir, linuxPath: displayDir.replace(/\\/g, '/'), windowsPath: displayDir.replace(/\//g, '\\') };
}
