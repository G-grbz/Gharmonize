import fs from 'node:fs';
import path from 'node:path';
import { assertPathWithinAny, fetchSafeRemote, sanitizeLogValue } from './security.js';

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
        const maxBytes = 25 * 1024 * 1024;
        if (Number(res.headers.get('content-length')) > maxBytes) { await res.body?.cancel?.(); continue; }
        const bytes = Buffer.from(await res.arrayBuffer());
        if (bytes.length > maxBytes) continue;
        const ext = imageExtension(bytes);
        if (!ext) continue; // A 200 HTML error page is not artwork.
        const dest = assertPathWithinAny(`${safeBase}${ext}`, roots);
        fs.writeFileSync(dest, bytes, { mode: 0o600 });
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
