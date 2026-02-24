import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  MKVMERGE_BIN,
  YTDLP_BIN,
  DENO_BIN
} from './binaries.js';

const execFileAsync = promisify(execFile);

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Parses version metadata from stdout for core application logic.
function parseVersionFromStdout(stdout) {
  if (!stdout) return null;
  const firstLine = String(stdout).split('\n')[0] || '';
  let m = firstLine.match(/version\s+([^\s]+)/i);
  if (m && m[1]) return m[1];

  m = firstLine.match(/\b(v?\d+\.\d+(\.\d+)?)/);
  if (m && m[1]) return m[1];

  return firstLine.trim() || null;
}

// Returns single version metadata used for core application logic.
async function getSingleVersion(binPath, args = ['-version']) {
  try {
    const { stdout } = await execFileAsync(binPath, args, { timeout: 5000 });
    const version = parseVersionFromStdout(stdout);
    return {
      path: binPath,
      version: version || 'unknown',
      raw: stdout.toString()
    };
  } catch (err) {
    return {
      path: binPath,
      version: 'unavailable',
      error: err.message || String(err)
    };
  }
}

// Returns binaries info used for core application logic.
export async function getBinariesInfo() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL_MS) {
    return cache;
  }

  const [ffmpeg, ffprobe, mkvmerge, ytdlp, deno] = await Promise.all([
    getSingleVersion(FFMPEG_BIN),
    getSingleVersion(FFPROBE_BIN),
    getSingleVersion(MKVMERGE_BIN, ['--version']),
    getSingleVersion(YTDLP_BIN, ['--version']),
    getSingleVersion(DENO_BIN, ['--version'])
  ]);

  cache = { ffmpeg, ffprobe, mkvmerge, ytdlp, deno };
  cacheTime = now;
  return cache;
}
