import fs from "fs";
import path from "path";
import { execFileSafe } from "./safeProcess.js";
import { terminateProcess } from "./processTermination.js";
import { getBinaryRuntimeEnv } from "./binaries.js";
import { resolveYtDlp, withYT403Workarounds, hasCookieArgs, stripCookieArgs, searchYouTubeMusicSongs } from "./yt.js";
import { registerJobProcess } from "./store.js";
import crypto from "crypto";
import { getUserAgent, getYouTubeHeaders, addGeoArgs, getExtraArgs, FLAGS } from "./config.js";
import { addCookieArgs, getJsRuntimeArgs } from "./utils.js";
import {
  buildCatalogMusicSearchQueries,
  isCatalogMusicProvider,
  scoreCatalogMusicCandidateText,
  hasMusicArtistEvidence,
  isPlausibleMusicDuration,
  isMappedMusicDurationCompatible,
  MAPPED_MUSIC_YT_STRICT_MATCH_SCORE,
  mappedMusicMatchMode,
  MAPPED_MUSIC_YT_SEARCH_RESULTS,
  MAPPED_MUSIC_YT_SEARCH_RETRIES,
  MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS,
  MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS,
  MAPPED_MUSIC_YT_SEARCH_STAGGER_MS
} from "./mappedMusicMatcher.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const TEMP_DIR = path.resolve(BASE_DIR, "temp");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const YT_SEARCH_RESULTS = Math.max(1, Math.min(10, Number(process.env.YT_SEARCH_RESULTS || 3)));
const YT_SEARCH_TIMEOUT_MS = Math.max(3000, Number(process.env.YT_SEARCH_TIMEOUT_MS || 20000));
const YT_SEARCH_STAGGER_MS = Math.max(0, Number(process.env.YT_SEARCH_STAGGER_MS || 140));
const YT_DOWNLOAD_RETRY_ATTEMPTS = Math.max(
  1,
  Number(process.env.YT_DOWNLOAD_RETRY_ATTEMPTS || 2)
);
const YT_DOWNLOAD_RETRY_BACKOFF_MS = Math.max(
  0,
  Number(process.env.YT_DOWNLOAD_RETRY_BACKOFF_MS || 1200)
);
const YT_DOWNLOAD_STALL_TIMEOUT_MS = Math.max(
  30000,
  Number(process.env.YT_DOWNLOAD_STALL_TIMEOUT_MS || 60000)
);
const YT_DOWNLOAD_HARD_TIMEOUT_MS = Math.max(
  YT_DOWNLOAD_STALL_TIMEOUT_MS * 2,
  Number(process.env.YT_DOWNLOAD_HARD_TIMEOUT_MS || 600000)
);
const YT_DOWNLOAD_WATCHDOG_POLL_MS = Math.max(
  1000,
  Math.min(10000, Number(process.env.YT_DOWNLOAD_WATCHDOG_POLL_MS || 5000))
);
const SOUNDCLOUD_YT_MIN_MATCH_SCORE = Math.max(1, Number(process.env.SOUNDCLOUD_YT_MIN_MATCH_SCORE || 6));
const SOUNDCLOUD_YT_SEARCH_RESULTS = Math.max(5, Math.min(20, Number(process.env.SOUNDCLOUD_YT_SEARCH_RESULTS || 10)));
const _searchCache = new Map();
const _SEARCH_CACHE_MAX = 800;
let _catalogSearchCooldownUntil = 0;


function isYouTubeMusicUrl(value = "") {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "music.youtube.com";
  } catch {
    return false;
  }
}

function toStandardYouTubeUrl(value = "") {
  const parsed = new URL(String(value || "").trim());
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "music.youtube.com") {
    throw new Error("Not a YouTube Music URL");
  }
  parsed.hostname = "www.youtube.com";
  return parsed.toString();
}

// Derives the parent job id from indexed file ids for core application logic.
function deriveJobIdFromFileId(fileId = "") {
  const raw = String(fileId || "").trim();
  if (!raw) return "";
  const cut = raw.lastIndexOf("_");
  return cut > 0 ? raw.slice(0, cut) : raw;
}

function getDownloadActivitySignature(downloadDir, fileId) {
  try {
    const entries = fs.readdirSync(downloadDir, { withFileTypes: true });
    let totalSize = 0;
    let latestMtime = 0;
    let count = 0;

    for (const entry of entries) {
      if (!entry?.isFile?.() || !entry.name.startsWith(`${fileId}.`)) continue;
      const fullPath = path.join(downloadDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        totalSize += Number(stat.size) || 0;
        latestMtime = Math.max(latestMtime, Number(stat.mtimeMs) || 0);
        count++;
      } catch {}
    }

    return `${count}:${totalSize}:${Math.floor(latestMtime)}`;
  } catch {
    return "0:0:0";
  }
}

function startYtDlpDownloadProcess(
  YTDLP_BIN,
  args,
  downloadDir,
  fileId,
  callback
) {
  let watchdogReason = "";
  let lastActivityAt = Date.now();
  let lastSignature = getDownloadActivitySignature(downloadDir, fileId);
  let watchdogInterval = null;
  let hardTimer = null;
  let child = null;

  const touch = () => {
    lastActivityAt = Date.now();
  };

  const clearWatchdog = () => {
    if (watchdogInterval) clearInterval(watchdogInterval);
    if (hardTimer) clearTimeout(hardTimer);
    watchdogInterval = null;
    hardTimer = null;
  };

  child = execFileSafe(
    YTDLP_BIN,
    args,
    {
      maxBuffer: 1024 * 1024 * 1024,
      windowsHide: true,
      env: getBinaryRuntimeEnv(),
      // A dedicated process group lets cancellation/watchdog kills include
      // yt-dlp helper processes such as ffmpeg on POSIX systems.
      detached: process.platform !== "win32"
    },
    (err, stdout, stderr) => {
      clearWatchdog();
      callback(err, stdout, stderr, watchdogReason);
    }
  );

  child.stdout?.on?.("data", touch);
  child.stderr?.on?.("data", touch);

  watchdogInterval = setInterval(() => {
    const signature = getDownloadActivitySignature(downloadDir, fileId);
    if (signature !== lastSignature) {
      lastSignature = signature;
      touch();
      return;
    }

    if ((Date.now() - lastActivityAt) < YT_DOWNLOAD_STALL_TIMEOUT_MS) return;

    watchdogReason = `yt-dlp stalled for ${Math.round(YT_DOWNLOAD_STALL_TIMEOUT_MS / 1000)}s`;
    clearWatchdog();
    terminateProcess(child);
  }, YT_DOWNLOAD_WATCHDOG_POLL_MS);
  watchdogInterval.unref?.();

  hardTimer = setTimeout(() => {
    watchdogReason = `yt-dlp exceeded ${Math.round(YT_DOWNLOAD_HARD_TIMEOUT_MS / 1000)}s hard timeout`;
    clearWatchdog();
    terminateProcess(child);
  }, YT_DOWNLOAD_HARD_TIMEOUT_MS);
  hardTimer.unref?.();

  child.once?.("error", clearWatchdog);
  child.once?.("close", clearWatchdog);

  try {
    registerJobProcess(deriveJobIdFromFileId(fileId), child);
  } catch {}

  return child;
}
// Handles cached data get in core application logic.
function _cacheGet(k) {
  const entry = _searchCache.get(k);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    _searchCache.delete(k);
    return undefined;
  }
  return entry.value;
}
// Handles cached data set in core application logic.
function _cacheSet(k, v) {
  // A negative search is transient: allow another attempt in the same app
  // session instead of freezing a missing match until Electron is restarted.
  _searchCache.set(k, { value: v, expiresAt: Date.now() + (v ? 30 * 60 * 1000 : 30 * 1000) });
  if (_searchCache.size > _SEARCH_CACHE_MAX) {
    const first = _searchCache.keys().next().value;
    _searchCache.delete(first);
  }
}

const SEARCH_CHAR_FOLD_MAP = Object.freeze({
  I: "i",
  İ: "i",
  ı: "i",
  Ş: "s",
  ş: "s",
  Ğ: "g",
  ğ: "g",
  Ü: "u",
  ü: "u",
  Ö: "o",
  ö: "o",
  Ç: "c",
  ç: "c",
  ß: "ss",
  Æ: "ae",
  æ: "ae",
  Œ: "oe",
  œ: "oe",
});

// Handles normalize matching text in core application logic.
function _normMatch(s = "") {
  return String(s)
    .replace(/[IİıŞşĞğÜüÖöÇçßÆæŒœ]/g, (ch) => SEARCH_CHAR_FOLD_MAP[ch] || ch)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Handles make map id in core application logic.
export function makeMapId() {
  return crypto.randomBytes(8).toString("hex");
}

// Returns YouTube metadata dlp search args lite used for core application logic.
function getYtDlpSearchArgsLite() {
  const ua = getUserAgent();
  const headers = getYouTubeHeaders();
  const base = [
    "--no-progress",
    "--no-warnings",
    "--skip-download",
    "--flat-playlist",
    "--dump-single-json",
    "--retries", "1",
    "--retry-sleep", "0",
    "--user-agent", ua,
    "--add-header", `Referer: ${headers["Referer"]}`,
    "--add-header", `Accept-Language: ${headers["Accept-Language"]}`,
    "--socket-timeout", "10",
  ];

  if (FLAGS.FORCE_IPV4) base.push("--force-ipv4");

  const geoArgs = addGeoArgs([]);
  if (geoArgs.length) base.push(...geoArgs);

  const extra = getExtraArgs();
  if (extra.length) base.push(...extra);

  return base;
}

// Runs YouTube metadata json lite for core application logic.
async function runYtJsonLite(urls, label = "ytm-search-lite", timeoutMs = YT_SEARCH_TIMEOUT_MS) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found");

  const args = withYT403Workarounds(
    [...getYtDlpSearchArgsLite(), ...(Array.isArray(urls) ? urls : [String(urls)])],
    { stripCookies: true }
  );

  return new Promise((resolve, reject) => {
    execFileSafe(
      YTDLP_BIN,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs, env: getBinaryRuntimeEnv() },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr || "").split("\n").slice(-10).join("\n");
          return reject(new Error(`[${label}] yt-dlp error: ${err.code}\n${tail}`));
        }
        try {
          const s = String(stdout || "").trim();
          return resolve(s ? JSON.parse(s) : null);
        } catch (e) {
          const tail = String(stderr || "").split("\n").slice(-10).join("\n");
          return reject(new Error(`[${label}] JSON parse error: ${e.message}\n${tail}`));
        }
      }
    );
  });
}

function uniqueSearchQueries(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const query = String(value || "").replace(/\s+/g, " ").trim();
    if (!query) continue;
    const key = _normMatch(query);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

export function buildMappedMusicSearchQueries(artist, title, { provider = "", sourceItem = null } = {}) {
  const sourceProvider = String(provider || "").trim().toLowerCase();
  const primaryArtist = String(sourceItem?.match_artist || sourceItem?.matchArtist || artist || "").trim();
  const primaryTitle = String(sourceItem?.match_title || sourceItem?.matchTitle || title || "").trim();
  const rawArtist = String(
    sourceItem?.soundcloud_raw_artist ||
    sourceItem?.artist ||
    sourceItem?.uploader ||
    artist ||
    ""
  ).trim();
  const rawTitle = String(
    sourceItem?.soundcloud_raw_title ||
    sourceItem?.title ||
    sourceItem?.track ||
    title ||
    ""
  ).trim();

  if (isCatalogMusicProvider(sourceProvider)) {
    // Catalog providers expose clean artist/title metadata. Keep the normal
    // artist+title query cheap, and use title-only only when the first search
    // cannot produce a safe candidate.
    return buildCatalogMusicSearchQueries(artist, title);
  }

  if (sourceProvider !== "soundcloud") {
    return uniqueSearchQueries([`${artist || ""} ${title || ""}`]);
  }

  // SoundCloud upload titles often already contain "Artist - Track" while the
  // uploader is merely the account name. Prefer the normalized identity first,
  // then progressively broader fallbacks only when that search is weak/empty.
  return uniqueSearchQueries([
    `${primaryArtist} ${primaryTitle}`,
    primaryTitle,
    `${rawArtist} ${primaryTitle}`,
    rawTitle,
    `${rawArtist} ${rawTitle}`
  ]);
}

function sourceDurationMs(sourceItem = null) {
  const direct = Number(sourceItem?.duration_ms ?? sourceItem?.durationMs ?? 0);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const seconds = Number(sourceItem?.duration || 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

function entryDurationSeconds(entry = null) {
  const seconds = Number(entry?.duration ?? 0);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  const ms = Number(entry?.duration_ms ?? entry?.durationMs ?? 0);
  if (Number.isFinite(ms) && ms > 0) return ms / 1000;
  const time = String(entry?.duration_string || '');
  return /^\d{1,3}(?::[0-5]\d){1,2}$/.test(time)
    ? time.split(':').reduce((total, part) => total * 60 + Number(part), 0)
    : 0;
}

function scoreSearchEntries(entries, artist, title, { provider = '' } = {}) {
  const aNorm = _normMatch(artist || '');
  const tNorm = _normMatch(title || '');
  const ranked = [];

  for (const e of entries) {
    const vid = e?.id;
    if (!vid) continue;

    const status = String(e?.live_status || '').toLowerCase();
    if (e?.is_live === true || status === 'is_live' || status === 'is_upcoming') continue;

    const et = _normMatch(e?.title || '');
    const ch = _normMatch(e?.uploader || e?.channel || '');
    let score = 0;

    if (isCatalogMusicProvider(provider)) {
      score = scoreCatalogMusicCandidateText(
        artist,
        title,
        e?.title || '',
        e?.uploader || e?.channel || ''
      );
    } else {
      if (tNorm) {
        if (et === tNorm) score += 6;
        else if (et.includes(tNorm) || tNorm.includes(et)) score += 4;
      }

      if (aNorm) {
        if (ch === aNorm) score += 4;
        else if (et.includes(aNorm) || ch.includes(aNorm)) score += 2;
      }

      if (aNorm && tNorm && et.includes(tNorm) && (et.includes(aNorm) || ch.includes(aNorm))) {
        score += 2;
      }

      if (/\btopic\b/.test(ch)) score += 1;
    }

    ranked.push({ entry: e, score, searchRank: ranked.length });
  }

  ranked.sort((a, b) => (b.score - a.score) || (a.searchRank - b.searchRank));
  return ranked;
}

function formatDurationSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function youtubeMatchFromEntry(entry = null, song = false) {
  const id = String(entry?.id || '').trim();
  if (!id) return null;
  const duration = entryDurationSeconds(entry) || null;
  const thumbnail = entry?.thumbnail ||
    (Array.isArray(entry?.thumbnails) ? entry.thumbnails.at(-1)?.url : null) ||
    null;
  return {
    id,
    title: String(entry?.title || '').trim(),
    uploader: String(entry?.uploader || entry?.channel || '').trim(),
    duration,
    duration_string: entry?.duration_string || formatDurationSeconds(duration),
    webpage_url: song
      ? `https://music.youtube.com/watch?v=${id}`
      : `https://www.youtube.com/watch?v=${id}`,
    thumbnail
  };
}

// How close (in seconds) to the closest candidate another candidate still
// counts as "equally close"; within this band the better title/artist match
// wins, so a one-second difference never beats the right recording.
const MUSIC_DURATION_WINDOW_SEC = 3;

function musicCandidate(entry, score, artist, sourceMs, rank) {
  const duration = entryDurationSeconds(entry);
  if (!isPlausibleMusicDuration(sourceMs, duration)) return null;
  return {
    entry,
    score,
    rank,
    artist: hasMusicArtistEvidence(artist, entry?.title || '', entry?.uploader || entry?.channel || ''),
    distance: sourceMs > 0 && duration > 0 ? Math.abs(sourceMs / 1000 - duration) : Infinity
  };
}

// Duration decides among candidates whose text already matches the source:
// the closest one wins, but candidates within a few seconds of it are
// compared by score first (then distance, then search order).
function pickMusicMatch(candidates = []) {
  if (!candidates.length) return null;
  const closest = Math.min(...candidates.map((c) => c.distance));
  const pool = Number.isFinite(closest)
    ? candidates.filter((c) => c.distance <= closest + MUSIC_DURATION_WINDOW_SEC)
    : candidates;
  let best = null;
  for (const c of pool) {
    if (!best || c.score > best.score ||
      (c.score === best.score && (c.distance < best.distance || (c.distance === best.distance && c.rank < best.rank)))) {
      best = c;
    }
  }
  return best;
}

// Good enough to stop asking more queries: the source artist is credited and
// the length is within a second (or the source has no length).
function isConfidentMusicMatch(candidates, sourceMs) {
  return candidates.some((c) => c.artist && (!sourceMs || c.distance <= 1));
}

async function findMusicSongs(queries, artist, title, { provider, sourceMs, album, resultLimit, onStage }) {
  const candidates = [];
  let failed = false;
  const minimum = provider === 'soundcloud' ? SOUNDCLOUD_YT_MIN_MATCH_SCORE : MAPPED_MUSIC_YT_STRICT_MATCH_SCORE;
  const albumQuery = album && _normMatch(album) !== _normMatch(title) ? queries[0] + " " + album : "";
  for (const query of uniqueSearchQueries([queries[0], albumQuery, ...queries.slice(1)])) {
    let entries;
    try {
      entries = await searchYouTubeMusicSongs(query, { limit: Math.max(12, resultLimit), onWait: onStage });
    } catch {
      // Not the same as "no songs": the caller must not remember a video
      // fallback chosen only because YouTube Music could not be asked.
      failed = true;
      continue;
    }
    for (const { entry, score } of scoreSearchEntries(entries, artist, title, { provider })) {
      if (score < minimum) continue;
      const candidate = musicCandidate(entry, score, artist, sourceMs, candidates.length);
      if (candidate) candidates.push(candidate);
    }
    if (isConfidentMusicMatch(candidates, sourceMs)) break;
  }
  return { candidates, failed };
}

async function waitForCatalogSearchCooldown(provider, onStage) {
  if (!isCatalogMusicProvider(provider)) return;
  const remaining = _catalogSearchCooldownUntil - Date.now();
  if (remaining > 0) {
    onStage?.('waiting');
    await sleep(remaining);
    onStage?.('matching');
  }
}

function isYouTubeSearchRateLimitError(error) {
  const message = String(error?.message || error || '');
  return /(?:\b429\b|too many requests|rate.?limit|sign in to confirm you.?re not a bot)/i.test(message);
}

async function runMappedMusicSearchQuery(query, resultLimit, provider, onStage) {
  const catalogProvider = isCatalogMusicProvider(provider);
  const attempts = catalogProvider ? (1 + MAPPED_MUSIC_YT_SEARCH_RETRIES) : 1;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    await waitForCatalogSearchCooldown(provider, onStage);
    try {
      return await runYtJsonLite([`ytsearch${resultLimit}:${query}`], 'ytm-search-lite', YT_SEARCH_TIMEOUT_MS);
    } catch (error) {
      lastError = error;
      if (catalogProvider && isYouTubeSearchRateLimitError(error)) {
        _catalogSearchCooldownUntil = Math.max(
          _catalogSearchCooldownUntil,
          Date.now() + MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS
        );
        throw error;
      }
      if (attempt + 1 >= attempts) break;
      const jitter = Math.floor(Math.random() * 150);
      onStage?.('retrying');
      await sleep(MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS + jitter);
      onStage?.('matching');
    }
  }
  throw lastError || new Error('YouTube search failed');
}

// Returns the best YouTube candidate plus its real metadata.
export async function searchYtmBestMatch(artist, title, options = {}) {
  const provider = String(options?.provider || '').trim().toLowerCase();
  const sourceItem = options?.sourceItem || null;
  const queries = buildMappedMusicSearchQueries(artist, title, { provider, sourceItem });
  if (!queries.length) return null;

  const sourceMs = sourceDurationMs(sourceItem);
  const catalogProvider = isCatalogMusicProvider(provider);
  const mode = mappedMusicMatchMode(options.format);
  const album = sourceItem?.album || '';
  const cacheKey = JSON.stringify([provider, mode, sourceMs, album, ...queries.map(_normMatch)]);
  const cached = _cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const scoreArtist = sourceItem?.match_artist || sourceItem?.matchArtist || artist || '';
  const scoreTitle = sourceItem?.match_title || sourceItem?.matchTitle || title || '';
  const resultLimit = provider === 'soundcloud'
    ? Math.max(YT_SEARCH_RESULTS, SOUNDCLOUD_YT_SEARCH_RESULTS)
    : (isCatalogMusicProvider(provider) ? MAPPED_MUSIC_YT_SEARCH_RESULTS : YT_SEARCH_RESULTS);
  // With a known artist, candidates crediting that artist come first; the
  // rest (often covers by someone else) are only a last resort.
  const credited = _normMatch(scoreArtist)
    ? (list) => list.filter((c) => c.artist)
    : (list) => list;
  const finish = (pick, song, remember = true) => {
    const match = pick ? youtubeMatchFromEntry(pick.entry, song) : null;
    if (remember) _cacheSet(cacheKey, match);
    return match;
  };

  // Every format except MP4 prefers YouTube Music "Songs" (the audio
  // release); videos are the fallback when no credited song exists.
  let songs = [];
  let songSearchFailed = false;
  if (mode === 'song') {
    ({ candidates: songs, failed: songSearchFailed } = await findMusicSongs(queries, scoreArtist, scoreTitle, {
      provider, sourceMs, album, resultLimit, onStage: options.onStage
    }));
    const song = pickMusicMatch(credited(songs));
    if (song) return finish(song, true);
  }

  const videos = [];
  let firstFallback = null;
  let lastSearchError = null;
  let successfulSearchResponses = 0;
  const soundCloud = provider === 'soundcloud';
  const minimum = soundCloud ? SOUNDCLOUD_YT_MIN_MATCH_SCORE : (catalogProvider ? MAPPED_MUSIC_YT_STRICT_MATCH_SCORE : 1);

  for (const query of queries) {
    let data;
    try {
      data = await runMappedMusicSearchQuery(query, resultLimit, provider, options.onStage);
    } catch (error) {
      if (songs.length) break;
      if (!catalogProvider && !soundCloud) throw error;
      if (catalogProvider && isYouTubeSearchRateLimitError(error)) throw error;
      lastSearchError = error;
      continue;
    }

    successfulSearchResponses++;
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const ranked = scoreSearchEntries(entries, scoreArtist, scoreTitle, { provider });
    for (const { entry, score } of ranked) {
      const candidate = musicCandidate(entry, score, scoreArtist, sourceMs, videos.length);
      if (!candidate) continue;
      if (!firstFallback) firstFallback = candidate;
      if (score >= minimum) videos.push(candidate);
    }
    if (isConfidentMusicMatch(videos, sourceMs)) break;
  }

  // A video picked because YouTube Music could not be asked is not
  // remembered, so the next attempt looks for the song again.
  const remember = !songSearchFailed;
  const video = pickMusicMatch(credited(videos));
  if (video) return finish(video, false, remember);
  // Last resort without the artist's credit: only when the length agrees
  // with the source too, otherwise it is most likely a different recording.
  const fits = (c) => c && (c.artist || isMappedMusicDurationCompatible(sourceMs, entryDurationSeconds(c.entry)));
  const looseSong = pickMusicMatch(songs.filter(fits));
  if (looseSong) return finish(looseSong, true, remember);
  const fallbackEntry = !catalogProvider && !soundCloud && fits(firstFallback) ? firstFallback : null;
  const looseVideo = pickMusicMatch(videos.filter(fits)) || fallbackEntry;
  if (!looseVideo && lastSearchError && catalogProvider && !successfulSearchResponses) throw lastSearchError;
  return finish(looseVideo, false, remember);
}

// Backward-compatible id-only API.
export async function searchYtmBestId(artist, title, options = {}) {
  const match = await searchYtmBestMatch(artist, title, options);
  return match?.id || null;
}

// Handles ids to music URLs in core application logic.
export function idsToMusicUrls(ids, useMusic = false) {
  return ids.map((id) =>
    useMusic
      ? `https://music.youtube.com/watch?v=${id}`
      : `https://www.youtube.com/watch?v=${id}`
  );
}

// Returns YouTube metadata dlp common args used for core application logic.
function getYtDlpCommonArgs() {
  const ua = getUserAgent();
  const headers = getYouTubeHeaders();
  const base = [
    "--no-progress",
    "--no-warnings",
    "--retries", "10",
    "--fragment-retries", "10",
    "--retry-sleep", "3",
    "--user-agent", ua,
    "--add-header", `Referer: ${headers["Referer"]}`,
    "--add-header", `Accept-Language: ${headers["Accept-Language"]}`,
  ];

  if (FLAGS.FORCE_IPV4) {
    base.push("--force-ipv4");
  }

  const geoArgs = addGeoArgs([]);
  if (geoArgs.length) base.push(...geoArgs);

  const extra = getExtraArgs();
  if (extra.length) base.push(...extra);

  addCookieArgs(base);
  base.push(...getJsRuntimeArgs());

  return base;
}

// Handles map Spotify metadata to ytm in core application logic.
export async function mapSpotifyToYtm(
  sp,
  onUpdate,
  { concurrency = 3, onLog = null, shouldCancel = null, onStage = null, format } = {}
) {
  if (!Array.isArray(sp?.items) || sp.items.length === 0) {
    return [];
  }

  let i = 0,
    running = 0;
  const results = new Array(sp.items.length);
  const mappingProvider = String(sp?.provider || '').trim().toLowerCase();
  const effectiveConcurrency = isCatalogMusicProvider(mappingProvider)
    ? Math.max(1, Math.min(Number(concurrency) || 1, 3))
    : Math.max(1, Number(concurrency) || 1);
  const effectiveStaggerMs = isCatalogMusicProvider(mappingProvider)
    ? Math.max(YT_SEARCH_STAGGER_MS, MAPPED_MUSIC_YT_SEARCH_STAGGER_MS)
    : YT_SEARCH_STAGGER_MS;
  return new Promise((resolve) => {
    // Handles kick in core application logic.
    const kick = () => {
      if (shouldCancel && shouldCancel()) {
        return resolve(results);
      }
      while (running < effectiveConcurrency && i < sp.items.length) {
        const idx = i++;
        running++;
        (async () => {
          const it = sp.items[idx];
          if (shouldCancel && shouldCancel()) {
            results[idx] = null;
            return;
          }

          if (effectiveStaggerMs > 0) {
            const slot = idx % effectiveConcurrency;
            const jitter = Math.floor(Math.random() * 25);
            await sleep((slot * effectiveStaggerMs) + jitter);
          }

          if (onLog)
            onLog({
              logKey: "log.searchingTrack",
              logVars: { artist: it.artist, title: it.title },
              fallback: `🔍 Searching: ${it.artist} - ${it.title}`,
            });
          const stage = phase => { try { onStage?.(idx, phase, it); } catch {} };
          stage('matching');
          let ytMatch = null;
          let searchFailed = false;
          try {
            const searchArtist = it.match_artist || it.matchArtist || it.artist;
            const searchTitle = it.match_title || it.matchTitle || it.title;
            ytMatch = await searchYtmBestMatch(searchArtist, searchTitle, {
              provider: sp?.provider || it?.source_provider || "",
              sourceItem: it, onStage: stage, format
            });
            if (onLog && ytMatch?.id)
              onLog({
                logKey: "log.foundTrack",
                logVars: { artist: it.artist, title: it.title },
                fallback: `✅ Found: ${it.artist} - ${it.title}`,
              });
            else if (onLog)
              onLog({
                logKey: "log.notFoundTrack",
                logVars: { artist: it.artist, title: it.title },
                fallback: `❌ Not found: ${it.artist} - ${it.title}`,
              });
          } catch (e) {
            searchFailed = true;
            stage('error');
            if (onLog)
              onLog({
                logKey: "log.searchError",
                logVars: {
                  artist: it.artist,
                  title: it.title,
                  err: e.message,
                },
                fallback: `❌ Search error: ${it.artist} - ${it.title} (${e.message})`,
              });
          }
          const vid = ytMatch?.id || null;
          if (!searchFailed) stage(vid ? 'queued' : 'not_found');
          const item = {
            index: idx + 1,
            id: vid,
            title: it.title,
            uploader: it.artist,
            duration: ytMatch?.duration || null,
            duration_string: ytMatch?.duration_string || null,
            webpage_url: ytMatch?.webpage_url || "",
            thumbnail: ytMatch?.thumbnail || null,
          };
          results[idx] = item;
          onUpdate(idx, item);
        })()
          .finally(() => {
            running--;
            if (shouldCancel && shouldCancel()) return resolve(results);
            if (i >= sp.items.length && running === 0) resolve(results);
            else kick();
          });
      }
    };
    kick();
  });
}

// Downloads matched Spotify metadata tracks for core application logic.
export async function downloadMatchedSpotifyTracks(
  matchedItems,
  jobId,
  onProgress,
  onLog = null
) {
  const downloadDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(downloadDir, { recursive: true });

  const results = [];
  let completed = 0;
  const total = matchedItems.length;
  const concurrency = 4;
  let currentIndex = 0;
  let running = 0;

  if (onLog)
    onLog({
      logKey: "log.downloading.batchStart",
      logVars: { total, concurrency },
      fallback: `🚀 Starting parallel download of ${total} tracks (max ${concurrency} concurrent)...`,
    });

  return new Promise((resolve, _reject) => {
    // Processes next in core application logic.
    const processNext = async () => {
      while (running < concurrency && currentIndex < total) {
        const index = currentIndex++;
        const item = matchedItems[index];
        running++;

        if (onLog)
          onLog({
            logKey: "log.downloading.start",
            logVars: {
              cur: index + 1,
              total,
              artist: item.uploader,
              title: item.title,
            },
            fallback: `📥 Downloading (${index + 1}/${total}): ${item.uploader} - ${item.title}`,
          });

        try {
          const filePath = await downloadSingleYouTubeVideo(
            item.webpage_url,
            `${jobId}_${index}`,
            downloadDir
          );

          results.push({
            index: item.index,
            title: item.title,
            uploader: item.uploader,
            filePath,
            item,
          });

          completed++;
          if (onProgress) onProgress(completed, total);
          if (onLog)
            onLog({
              logKey: "log.downloading.ok",
              logVars: {
                cur: index + 1,
                total,
                artist: item.uploader,
                title: item.title,
              },
              fallback: `✅ Downloaded (${index + 1}/${total}): ${item.uploader} - ${item.title}`,
            });
        } catch (error) {
          if (onLog)
            onLog({
              logKey: "log.downloading.err",
              logVars: {
                cur: index + 1,
                total,
                artist: item.uploader,
                title: item.title,
                err: error.message,
              },
              fallback: `❌ Download error (${index + 1}/${total}): ${item.uploader} - ${item.title} - ${error.message}`,
            });
          results.push({
            index: item.index,
            title: item.title,
            uploader: item.uploader,
            filePath: null,
            item,
            error: error.message,
          });
          completed++;
          if (onProgress) onProgress(completed, total);
        } finally {
          running--;
          processNext();
        }
      }

      if (completed === total && running === 0) {
        const successful = results.filter((r) => r.filePath).length;
        if (onLog)
          onLog({
            logKey: "log.downloading.summary",
            logVars: { ok: successful, total },
            fallback: `📊 Download completed: ${successful}/${total} tracks successfully downloaded`,
          });
        resolve(results.sort((a, b) => a.index - b.index));
      }
    };

    processNext();
  });
}

// Downloads single you tube video for one attempt in core application logic.
async function downloadSingleYouTubeVideoOnce(url, fileId, downloadDir) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found");

  const template = path.join(downloadDir, `${fileId}.%(ext)s`);

  try {
    const pre = fs
      .readdirSync(downloadDir)
      .filter(
        (f) =>
          f.startsWith(`${fileId}.`) &&
          /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f)
      );
    if (pre.length > 0) return path.join(downloadDir, pre[0]);
  } catch {}

  const base = [
    "-f",
    "bestaudio[abr>=128]/bestaudio/best",
    "--no-playlist",
    "--continue",
    "--no-overwrites",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
    "--socket-timeout",
    "15",
    "--concurrent-fragments",
    "1",
    "--write-thumbnail",
    "-o",
    template,
  ];

  let args = [...getYtDlpCommonArgs(), "--no-abort-on-error", ...base, url];
  const stripCookies = FLAGS.STRIP_COOKIES;
  let finalArgs = withYT403Workarounds(args, { stripCookies });

  return new Promise((resolve, reject) => {
    // Finds downloaded for core application logic.
    const findDownloaded = () => {
      try {
        const files = fs
          .readdirSync(downloadDir)
          .filter(
            (f) =>
              f.startsWith(`${fileId}.`) &&
              /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f)
          );
        return files.length > 0 ? path.join(downloadDir, files[0]) : null;
      } catch {
        return null;
      }
    };

    const finishAttempt = (
      err,
      _stdout,
      stderr,
      watchdogReason,
      { allowMusicFallback = true, allowCookieFallback = true } = {}
    ) => {
      if (!err) {
        const p = findDownloaded();
        return p ? resolve(p) : reject(new Error("File downloaded but not found"));
      }

      // With yt-dlp's normal .part behavior, a final media extension indicates
      // that the media file itself finished even if a later optional step failed.
      const have = findDownloaded();
      if (have) return resolve(have);

      if (watchdogReason) {
        return reject(new Error(watchdogReason));
      }

      const stderrStr = String(stderr || "");
      const is403 = /403|Forbidden/i.test(stderrStr);
      const isMusic = isYouTubeMusicUrl(url);

      // Cookies are optional: a run that used them and failed is repeated once
      // without them (expired or unreadable browser cookies must not break downloads).
      if (allowCookieFallback && hasCookieArgs(finalArgs)) {
        console.warn("[yt-download] failed with cookies, retrying without cookies");
        const retryArgs = stripCookieArgs(finalArgs);
        startYtDlpDownloadProcess(
          YTDLP_BIN,
          retryArgs,
          downloadDir,
          fileId,
          (err2, so2, se2, fallbackWatchdogReason) => {
            finalArgs = retryArgs;
            finishAttempt(err2, so2, se2, fallbackWatchdogReason, { allowMusicFallback, allowCookieFallback: false });
          }
        );
        return;
      }

      if (allowMusicFallback && is403 && isMusic) {
        const fallbackUrl = toStandardYouTubeUrl(url);
        const retryArgs = finalArgs
          .map((x) => x)
          .filter((x) => x !== url)
          .concat(fallbackUrl);
        const idxExtr = retryArgs.findIndex(
          (v, i) => v === "--extractor-args"
        );
        if (idxExtr >= 0 && retryArgs[idxExtr + 1]) {
          retryArgs[idxExtr + 1] = "youtube:player_client=android,web";
        }

        startYtDlpDownloadProcess(
          YTDLP_BIN,
          retryArgs,
          downloadDir,
          fileId,
          (err2, so2, se2, fallbackWatchdogReason) => {
            finishAttempt(
              err2,
              so2,
              se2,
              fallbackWatchdogReason,
              { allowMusicFallback: false, allowCookieFallback: false }
            );
          }
        );
        return;
      }

      const tail = stderrStr.split("\n").slice(-10).join("\n");
      return reject(new Error(`yt-dlp error: ${err.code}\n${tail}`));
    };

    startYtDlpDownloadProcess(
      YTDLP_BIN,
      finalArgs,
      downloadDir,
      fileId,
      (err, stdout, stderr, watchdogReason) => {
        finishAttempt(err, stdout, stderr, watchdogReason);
      }
    );
  });
}

// Downloads single you tube video with outer retry in core application logic.
export async function downloadSingleYouTubeVideo(url, fileId, downloadDir, onStage = null) {
  let lastError = null;

  for (let attempt = 1; attempt <= YT_DOWNLOAD_RETRY_ATTEMPTS; attempt++) {
    try {
      onStage?.('downloading');
      return await downloadSingleYouTubeVideoOnce(url, fileId, downloadDir);
    } catch (error) {
      lastError = error;
      if (attempt >= YT_DOWNLOAD_RETRY_ATTEMPTS) break;

      console.warn(
        `[downloadSingleYouTubeVideo] retry ${attempt}/${YT_DOWNLOAD_RETRY_ATTEMPTS - 1} for ${fileId}: ${
          error?.message || error
        }`
      );

      if (YT_DOWNLOAD_RETRY_BACKOFF_MS > 0) {
        onStage?.('retrying');
        await sleep(YT_DOWNLOAD_RETRY_BACKOFF_MS * attempt);
      }
    }
  }

  throw lastError || new Error("yt-dlp download failed");
}

// Creates download metadata queue for core application logic.
export function createDownloadQueue(
  jobId,
  { concurrency = 4, onProgress, onLog, shouldCancel, onItemDone, onStage = null } = {}
) {
  const downloadDir = path.join(TEMP_DIR, jobId);
  fs.mkdirSync(downloadDir, { recursive: true });

  let running = 0;
  const q = [];
  const results = [];
  let total = 0,
    done = 0;
  let idleResolve;
  let ended = false;

  // Handles pump in core application logic.
  const pump = async () => {
    while (running < concurrency && q.length) {
      if (shouldCancel && shouldCancel()) {
        q.length = 0;
        if (running === 0 && idleResolve) idleResolve();
        return;
      }
      const task = q.shift();
      running++;
      const { item, idx } = task;
      const stage = phase => { try { onStage?.(idx, phase, item); } catch {} };
      if (onLog)
        onLog({
          logKey: "log.downloading.start",
          logVars: {
            cur: done + 1,
            total,
            artist: item.uploader,
            title: item.title,
          },
          fallback: `📥 Downloading (${done + 1}/${total}): ${item.uploader} - ${item.title}`,
        });
      try {
        const filePath = await downloadSingleYouTubeVideo(
          item.webpage_url,
          `${jobId}_${idx}`,
          downloadDir, stage
        );

        const dlResult = {
          index: item.index,
          idxZeroBased: idx,
          title: item.title,
          uploader: item.uploader,
          filePath,
          item,
        };

        results.push(dlResult);
        stage('queued');

        if (onLog)
          onLog({
            logKey: "log.downloading.ok",
            logVars: { artist: item.uploader, title: item.title },
            fallback: `✅ Downloaded: ${item.uploader} - ${item.title}`,
          });

        if (onItemDone && filePath) {
          try {
            onItemDone(dlResult, idx);
          } catch (e) {
            console.warn("[downloadQueue] onItemDone error:", e);
          }
        }
      } catch (e) {
        stage(shouldCancel?.() ? 'canceled' : 'error');
        const dlResult = {
          index: item.index,
          idxZeroBased: idx,
          title: item.title,
          uploader: item.uploader,
          filePath: null,
          item,
          error: e.message,
        };

        results.push(dlResult);

        if (onLog)
          onLog({
            logKey: "log.downloading.err",
            logVars: {
              artist: item.uploader,
              title: item.title,
              err: e.message,
            },
            fallback: `❌ Download error: ${item.uploader} - ${item.title} - ${e.message}`,
          });
        } finally {
          done++;
          if (onProgress) onProgress(done, total);
          running--;
          if (shouldCancel && shouldCancel()) {
            q.length = 0;
            if (running === 0 && idleResolve) idleResolve();
            return;
          }
          if (q.length) pump();
          else if (ended && running === 0 && idleResolve) idleResolve();
        }
      }
    };

  return {
    // Handles enqueue in core application logic.
    enqueue(item, idxZeroBased) {
      total++;
      try { onStage?.(idxZeroBased, 'queued', item); } catch {}
      q.push({ item, idx: idxZeroBased });
      pump();
    },
    // Handles wait for idle in core application logic.
    async waitForIdle() {
      if (running === 0 && q.length === 0) return;
      return new Promise((res) => {
        idleResolve = res;
      });
    },
    // Handles end in core application logic.
    end() {
      ended = true;
      if (q.length === 0 && running === 0 && idleResolve) idleResolve();
    },
    // Returns results used for core application logic.
    getResults() {
      return results.sort((a, b) => a.index - b.index);
    },
  };
}
