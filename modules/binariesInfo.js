import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  FFMPEG_BIN,
  FFPROBE_BIN,
  MKVMERGE_BIN,
  MKVPROPEDIT_BIN,
  YTDLP_BIN,
  DENO_BIN,
  getDynamicBinaryMetadata
} from './binaries.js';

const execFileAsync = promisify(execFile);

let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Clears cached binaries metadata.
export function clearBinariesInfoCache() {
  cache = null;
  cacheTime = 0;
}

// Normalizes a parsed version token for core application logic.
function normalizeVersionToken(token) {
  const value = String(token || '').trim().replace(/^[a-z]+@/i, '');
  if (!value) return null;
  if (/^v\d+\.\d+(\.\d+)?$/i.test(value)) {
    return value.slice(1);
  }
  return value;
}

// Checks whether a line is only an AppImage temporary path.
function isAppImageTempLine(line) {
  const value = String(line || '').trim();
  if (!value) return false;
  return (
    /^\/tmp\/\.mount_/i.test(value) ||
    /^\/tmp\/appimage/i.test(value) ||
    /^\/tmp\/appimage_extracted/i.test(value)
  );
}

// Checks whether a line looks like a long hash or digest.
function isLongHashLine(line) {
  return /^[a-f0-9]{16,}$/i.test(String(line || '').trim());
}

// Resolves version from cached dynamic binary metadata.
function getVersionFromDynamicMetadata(toolName, binPath) {
  const entry = getDynamicBinaryMetadata(toolName);
  if (!entry || typeof entry !== 'object') return null;
  const currentPath = String(binPath || '').trim();
  const metaPath = String(entry.path || '').trim();
  const backingPath = String(entry.backingPath || '').trim();
  const tag = normalizeVersionToken(entry.tag);

  if (!tag) return null;
  if (!currentPath) return tag;
  if (currentPath === metaPath || currentPath === backingPath) return tag;
  return null;
}

// Checks whether a parsed version looks valid for a specific tool.
function isLikelyVersionForTool(toolName, version) {
  const tool = String(toolName || '').trim().toLowerCase();
  const value = String(version || '').trim();
  if (!value) return false;

  if (tool === 'mkvmerge') {
    return /^\d+\.\d+(?:\.\d+)?$/.test(value);
  }
  if (tool === 'yt-dlp' || tool === 'ytdlp') {
    return /^\d{4}\.\d{2}\.\d{2}$/.test(value);
  }
  if (tool === 'deno') {
    return /^\d+\.\d+(?:\.\d+)?$/.test(value);
  }
  if (tool === 'ffmpeg' || tool === 'ffprobe') {
    return /^N-\d+(?:-g[0-9a-f]+)?-\d{8}$/i.test(value) || /^[a-z]?\d+\.\d+(?:\.\d+)?$/i.test(value);
  }

  return true;
}

// Parses version metadata from process output for core application logic.
function parseVersionFromOutput(output, toolName = '') {
  if (!output) return null;
  const tool = String(toolName || '').trim().toLowerCase();

  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !isAppImageTempLine(line))
    .filter((line) => !isLongHashLine(line));

  if (tool === 'mkvmerge') {
    for (const line of lines) {
      const match = line.match(/\bmkvmerge\s+v(\d+\.\d+(?:\.\d+)?)\b/i);
      if (match?.[1]) return match[1];
    }
  }

  if (tool === 'mkvpropedit') {
    for (const line of lines) {
      const match = line.match(/\bmkvpropedit\s+v(\d+\.\d+(?:\.\d+)?)\b/i);
      if (match?.[1]) return match[1];
    }
  }

  if (tool === 'yt-dlp' || tool === 'ytdlp') {
    for (const line of lines) {
      const match = line.match(/\b(\d{4}\.\d{2}\.\d{2})\b/);
      if (match?.[1]) return match[1];
    }
  }

  for (const line of lines) {
    let m = line.match(/version[:\s]+([^\s]+)/i);
    if (m && m[1]) return normalizeVersionToken(m[1]);

    m = line.match(/\b(v?\d+\.\d+(?:\.\d+)?(?:\.\d+)?)\b/);
    if (m && m[1]) return normalizeVersionToken(m[1]);

    m = line.match(/\b(N-\d+(?:-g[0-9a-f]+)?-\d{8})\b/i);
    if (m && m[1]) return normalizeVersionToken(m[1]);

    if (/^(ffmpeg|ffprobe|mkvmerge|yt-dlp|deno)\b/i.test(line)) {
      return line;
    }
  }

  return lines[0] || null;
}

// Returns single version metadata used for core application logic.
async function getSingleVersion(binPath, args = ['-version'], toolName = '') {
  try {
    const { stdout, stderr } = await execFileAsync(binPath, args, { timeout: 5000 });
    const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');
    const parsedVersion = parseVersionFromOutput(combinedOutput, toolName);
    const metadataVersion = getVersionFromDynamicMetadata(toolName, binPath);
    const version = isLikelyVersionForTool(toolName, parsedVersion)
      ? parsedVersion
      : (metadataVersion || parsedVersion);
    return {
      path: binPath,
      version: version || 'unknown',
      raw: combinedOutput.toString()
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
export async function getBinariesInfo(options = {}) {
  const force = !!options.force;
  const now = Date.now();
  if (!force && cache && (now - cacheTime) < CACHE_TTL_MS) {
    return cache;
  }

  const [ffmpeg, ffprobe, mkvmerge, mkvpropedit, ytdlp, deno] = await Promise.all([
    getSingleVersion(FFMPEG_BIN, ['-version'], 'ffmpeg'),
    getSingleVersion(FFPROBE_BIN, ['-version'], 'ffprobe'),
    getSingleVersion(MKVMERGE_BIN, ['--version'], 'mkvmerge'),
    getSingleVersion(MKVPROPEDIT_BIN, ['--version'], 'mkvpropedit'),
    getSingleVersion(YTDLP_BIN, ['--version'], 'yt-dlp'),
    getSingleVersion(DENO_BIN, ['--version'], 'deno')
  ]);

  cache = { ffmpeg, ffprobe, mkvmerge, mkvpropedit, ytdlp, deno };
  cacheTime = now;
  return cache;
}
