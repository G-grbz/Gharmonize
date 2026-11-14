import fs from 'node:fs';
import path from 'node:path';
import { assertPathWithinAny, fetchSafeRemote, sanitizeLogValue } from './security.js';
import { spawnSafe } from './safeProcess.js';

const MAX_COVER_BYTES = 25 * 1024 * 1024;

// YouTube advertises maxresdefault even for older uploads that only have HQ.
// Keep provider artwork intact; resolution fallbacks apply only to YouTube CDN.
export function thumbnailCandidates(value) {
  const original = String(value || '').trim();
  if (!original) return [];
  const urls = [original];
  try {
    const u = new URL(original);
    const match = u.pathname.match(/^\/(?:vi|vi_webp)\/([A-Za-z0-9_-]{11})\//);
    if (u.protocol === 'https:' && /^(?:i|i\d)\.ytimg\.com$/.test(u.hostname) && match) {
      for (const size of ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault', 'default']) {
        urls.push(`https://i.ytimg.com/vi/${match[1]}/${size}.jpg`);
      }
    }
  } catch {}
  return [...new Set(urls)];
}

export function youtubeThumbnailFromUrl(value) {
  try {
    const u = new URL(value);
    let id = null;
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com')) id = u.searchParams.get('v');
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` : null;
  } catch { return null; }
}

function imageExtension(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return '.png';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return '.webp';
  return null;
}

// Decode only supported still images and encode fresh pixels as PNG. This
// rejects truncated/signature-only files and discards appended payloads and
// metadata instead of persisting the remote response verbatim.
export async function normalizeCoverImage(bytes) {
  const ext = imageExtension(bytes);
  if (!ext || bytes.length > MAX_COVER_BYTES) throw new Error('Invalid cover image');
  const decoder = ext === '.jpg' ? 'mjpeg' : ext === '.png' ? 'png' : 'webp';
  const { FFMPEG_BIN } = await import('./binaries.js');
  return new Promise((resolve, reject) => {
    const proc = spawnSafe(FFMPEG_BIN || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-xerror',
      '-protocol_whitelist', 'pipe', '-f', 'image2pipe', '-c:v', decoder,
      '-threads', '1', '-max_pixels', '16777216', '-i', 'pipe:0',
      '-map', '0:v:0', '-frames:v', '1', '-map_metadata', '-1',
      '-vf', 'scale=w=min(2048\\,iw):h=min(2048\\,ih):force_original_aspect_ratio=decrease',
      '-threads', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks = [];
    let size = 0;
    let failure;
    const fail = (error) => { failure ||= error; proc.kill('SIGKILL'); };
    const timer = setTimeout(() => fail(new Error('Cover image decoding timed out')), 10_000);
    proc.once('error', (error) => { failure ||= error; });
    proc.stdin.on('error', () => {});
    proc.stderr.resume();
    proc.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_COVER_BYTES) fail(new Error('Decoded cover image is too large'));
      else if (!failure) chunks.push(chunk);
    });
    proc.once('close', (code) => {
      clearTimeout(timer);
      if (failure || code !== 0 || !size) return reject(failure || new Error('Cover image decoding failed'));
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.end(bytes);
  });
}

async function readCoverResponse(res) {
  if (Number(res.headers.get('content-length')) > MAX_COVER_BYTES) {
    await res.body?.cancel?.();
    throw new Error('Cover image is too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_COVER_BYTES) throw new Error('Cover image is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createThumbnailDownloader({ fetchRemote = fetchSafeRemote, logger = console } = {}) {
  return async function downloadThumbnail(url, destBasePathNoExt) {
    if (!url) return null;
    const baseDir = path.resolve(process.env.DATA_DIR || process.cwd());
    const roots = ['outputs', 'temp', 'uploads'].map((name) => path.join(baseDir, name));
    const safeBase = assertPathWithinAny(path.resolve(String(destBasePathNoExt || '')), roots);
    for (const candidate of thumbnailCandidates(url)) {
      try {
        const res = await fetchRemote(candidate, { signal: AbortSignal.timeout(5000) }, { maxRedirects: 3 });
        if (!res.ok) { await res.body?.cancel?.(); continue; }
        const bytes = await readCoverResponse(res);
        const image = await normalizeCoverImage(bytes);
        const dest = assertPathWithinAny(`${safeBase}.png`, roots);
        fs.writeFileSync(dest, image, { mode: 0o600 });
        return dest;
      } catch {}
    }
    logger.warn?.('⚠️ No usable cover image:', sanitizeLogValue(url));
    return null;
  };
}

export const downloadThumbnail = createThumbnailDownloader();

export function createCoverResolver({ download = downloadThumbnail, exists = fs.existsSync } = {}) {
  return async function resolvePreferredCoverPath(meta, { baseNoExt = '', fallbackSidecarPath = null, fallbackCoverPath = null } = {}) {
    const preferred = [...new Set([meta?.__applePreferredCoverUrl, meta?.coverUrl, meta?.imageUrl, meta?.thumbnailUrl].filter(Boolean))];
    if (baseNoExt) {
      for (let i = 0; i < preferred.length; i++) {
        const file = await download(preferred[i], `${baseNoExt}.cover_${i}`);
        if (file && exists(file)) return file;
      }
    }
    if (fallbackSidecarPath && exists(fallbackSidecarPath)) return fallbackSidecarPath;
    // Use the track's image before a playlist-wide cover.
    if (baseNoExt) {
      const url = meta?.thumbnail || youtubeThumbnailFromUrl(meta?.webpage_url);
      if (url && !preferred.includes(url)) {
        const file = await download(url, `${baseNoExt}.thumbnail`);
        if (file && exists(file)) return file;
      }
    }
    return fallbackCoverPath && exists(fallbackCoverPath) ? fallbackCoverPath : null;
  };
}

export const resolvePreferredCoverPath = createCoverResolver();

export function taggedUrl(parsed, name) {
  for (const tags of Object.values(parsed?.native || {})) {
    for (const tag of tags) {
      if (tag.id === 'WXXX' && tag.value?.description?.toUpperCase() === name) return tag.value.url || '';
      if (tag.id.toUpperCase() === `TXXX:${name}`) return String(tag.value || '');
    }
  }
  return '';
}
