import path from "path";
import fs from "fs";
import { spawn, execFile } from "child_process";
import { registerJobProcess } from "./store.js";
import { getCache, setCache, mergeCacheEntries, PREVIEW_MAX_ENTRIES } from "./cache.js";
import { findOnPATH, isExecutable, toNFC, addCookieArgs, getJsRuntimeArgs, parseIdFromPath } from "./utils.js";
import { getYouTubeHeaders, getUserAgent, addGeoArgs, getExtraArgs, getLocaleConfig, FLAGS } from "./config.js";
import { YTDLP_BIN as BINARY_YTDLP_BIN, DENO_BIN } from "./binaries.js";

// Checks whether music enabled is valid for the yt-dlp YouTube download pipeline.
export function isMusicEnabled() {
  const v = process.env.YT_USE_MUSIC;
  if (v === "0") return false;
  if (v === "1") return true;
  return false;
}

const DEFAULT_TIMEOUT = 30000;
const DEFAULT_USER_AGENT = getUserAgent();
const DEFAULT_HEADERS = getYouTubeHeaders();
const SKIP_RE = /(private|members\s*only|copyright|blocked|region|geo|not\s+available|unavailable|age[-\s]?restricted|signin|sign\s*in|skipp?ed|removed)/i;
const ERROR_WORD = /\berror\b/i;
const DEFAULT_FRAGMENT_CONCURRENCY = 4;
const AUTOMIX_ALL_TIMEOUT =
  Number(process.env.AUTOMIX_ALL_TIMEOUT_MS || 25000);

const AUTOMIX_PAGE_TIMEOUT =
  Number(process.env.AUTOMIX_PAGE_TIMEOUT_MS || 45000);

const PLAYLIST_ALL_TIMEOUT =
  Number(process.env.PLAYLIST_ALL_TIMEOUT_MS || 30000);

const PLAYLIST_PAGE_TIMEOUT =
  Number(process.env.PLAYLIST_PAGE_TIMEOUT_MS || 20000);

const PLAYLIST_META_TIMEOUT =
  Number(process.env.PLAYLIST_META_TIMEOUT_MS || 25000);

const PLAYLIST_META_FALLBACK_TIMEOUT =
  Number(process.env.PLAYLIST_META_FALLBACK_TIMEOUT_MS || 15000);


// Checks whether benign sabr warning is valid for the yt-dlp YouTube download pipeline.
function isBenignSabrWarning(line) {
  if (!line) return false;
  const s = String(line);
  return (
    /SABR streaming for this client/i.test(s) &&
    /Some web(?:_safari)? client https formats have been skipped as they are missing a url/i.test(s)
  );
}

// Normalizes concurrency for the yt-dlp YouTube download pipeline.
function normalizeConcurrency(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return 4;
  return Math.max(1, Math.min(16, Math.round(num)));
}

// Runs with concurrency for the yt-dlp YouTube download pipeline.
async function runWithConcurrency(limit, tasks) {
  const max = Math.max(1, Number(limit) || 1);
  if (!tasks.length) return;

  let index = 0;
  let active = 0;
  let fatalError = null;

  return new Promise((resolve, reject) => {
    // Handles next in the yt-dlp YouTube download pipeline.
    const next = () => {
      if (fatalError) return;
      if (index >= tasks.length && active === 0) {
        return resolve();
      }

      while (active < max && index < tasks.length) {
        const i = index++;
        active++;

        Promise.resolve()
          .then(() => tasks[i]())
          .catch(err => {
            fatalError = err;
            reject(err);
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

// Handles headers to args in the yt-dlp YouTube download pipeline.
function headersToArgs(headersObj) {
  const out = [];
  for (const key of ["Referer", "Origin", "Accept-Language"]) {
    const val = headersObj?.[key];
    if (val) out.push("--add-header", `${key}: ${val}`);
  }
  return out;
}

// Handles emit event in the yt-dlp YouTube download pipeline.
function emitEvent(progressCallback, opts, payload) {
  if (opts && typeof opts.onEvent === "function") {
    try { opts.onEvent(payload); } catch {}
  }
  if (typeof progressCallback === "function") {
    try { progressCallback({ __event: true, ...payload }); } catch {}
  }
}

// Normalizes you tube URL for the yt-dlp YouTube download pipeline.
export function normalizeYouTubeUrl(input) {
  try {
    let url = new URL(input);
    url.hostname = url.hostname.replace(/^m\./, "www.");
    if (url.hostname === "youtu.be") {
      const id = url.pathname.replace(/^\/+/, "");
      const list = url.searchParams.get("list");
      url = new URL("https://www.youtube.com/watch");
      if (id) url.searchParams.set("v", id);
      if (list) url.searchParams.set("list", list);
    }

    if (isMusicEnabled() && url.hostname === "www.youtube.com" &&
        url.pathname === "/watch" && url.searchParams.get("v")) {
      url.hostname = getLocaleConfig().hostnameForWatch(true);
    }

    const DROP_PARAMS = ["feature", "pp", "si", "start_radio", "persist_app", "t"];
    DROP_PARAMS.forEach(param => url.searchParams.delete(param));

    url.hash = "";
    if (typeof url.searchParams.sort === "function") {
      url.searchParams.sort();
    }

    return url.toString();
  } catch {
    return String(input).replace(/([&?])index=\d+/i, "$1").replace(/[?&]$/, "");
  }
}

// Checks whether you tube URL is valid for the yt-dlp YouTube download pipeline.
export const isYouTubeUrl = (url) => {
  const s = String(url || "");
  return (
    s.includes("youtube.com/") ||
    s.includes("youtu.be/") ||
    s.includes("youtube.com/watch") ||
    s.includes("youtube.com/playlist")
  );
};

// Checks whether dailymotion URL is valid for the yt-dlp YouTube download pipeline.
export const isDailymotionUrl = (url) => {
  const s = String(url || "").trim();
  if (!s) return false;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return (
      host.includes("dailymotion.com") ||
      host === "dai.ly" ||
      host.endsWith(".dai.ly")
    );
  } catch {
    return /(?:^|\/\/)(?:www\.)?(?:dailymotion\.com|dai\.ly)\//i.test(s);
  }
};

// Builds video format selector for the yt-dlp YouTube download pipeline.
function buildVideoFormatSelector(sourceUrl, maxHeight = 1080) {
  const h = Number.isFinite(Number(maxHeight)) ? Number(maxHeight) : 1080;
  const s = String(sourceUrl || "");
  const isYouTubeLike = isYouTubeUrl(s) || isDailymotionUrl(s);

  if (isYouTubeLike) {
    return (
      `bestvideo[height<=${h}]+bestaudio[abr>=128][vcodec=none]/` +
      `bestvideo[height<=${h}]+bestaudio[vcodec=none]/` +
      `best[vcodec!=none][height<=${h}]/` +
      `best[vcodec!=none]/best`
    );
  }

  return (
    `best[height<=${h}]/` +
    `bestvideo[height<=${h}]+bestaudio/` +
    `bestvideo+bestaudio/` +
    `best`
  );
}

// Checks whether you tube playlist data is valid for the yt-dlp YouTube download pipeline.
export const isYouTubePlaylist = (url) => {
  const s = String(url || "");
  return (
    s.includes("list=") ||
    s.includes("/playlist") ||
    s.includes("&list=") ||
    !!s.match(/youtube\.com.*[&?]list=/)
  );
};

// Checks whether dailymotion playlist data is valid for the yt-dlp YouTube download pipeline.
export const isDailymotionPlaylist = (url) => {
  if (!isDailymotionUrl(url)) return false;
  const s = String(url || "");
  try {
    const u = new URL(s);
    return /\/playlist\//i.test(u.pathname) || u.searchParams.has("playlist");
  } catch {
    return /\/playlist\//i.test(s) || /[?&]playlist=/.test(s);
  }
};

export const isYouTubeAutomix = (url) =>
  String(url || "").includes("&index=") ||
  (String(url || "").includes("/watch?v=") &&
    String(url || "").includes("&list=RD")) ||
  String(url || "").toLowerCase().includes("automix") ||
  String(url || "").includes("list=RD");

// Resolves YouTube metadata dlp for the yt-dlp YouTube download pipeline.
export function resolveYtDlp() {
  const fromEnv = process.env.YTDLP_BIN;
  if (fromEnv && isExecutable(fromEnv)) {
    return fromEnv;
  }

  if (BINARY_YTDLP_BIN && isExecutable(BINARY_YTDLP_BIN)) {
    return BINARY_YTDLP_BIN;
  }

  if (process.platform !== "win32") {
    const commonPaths = [
      "/usr/local/bin/yt-dlp",
      "/usr/bin/yt-dlp",
      path.join(process.env.HOME || "", ".local/bin/yt-dlp")
    ];

    for (const p of commonPaths) {
      if (p && isExecutable(p)) return p;
    }
  }

  const fromPATH = findOnPATH(process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  if (fromPATH && isExecutable(fromPATH)) {
    return fromPATH;
  }

  return null;
}

// Handles ids to music URLs in the yt-dlp YouTube download pipeline.
export function idsToMusicUrls(ids) {
  return ids.map(id => isMusicEnabled() ?
    `https://music.youtube.com/watch?v=${id}` :
    `https://www.youtube.com/watch?v=${id}`
  );
}

// Handles ids to watch URLs in the yt-dlp YouTube download pipeline.
export function idsToWatchUrls(ids) {
  return ids.map(id =>
    normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`)
  );
}

// Checks whether likely you tube video id is valid for the yt-dlp YouTube download pipeline.
function isLikelyYouTubeVideoId(id) {
  return /^[A-Za-z0-9_-]{11}$/.test(String(id || ""));
}

// Handles ids to download metadata URLs in the yt-dlp YouTube download pipeline.
function idsToDownloadUrls(ids, frozenEntries = [], sourceUrl = "") {
  const byIdWebpage = new Map(
    (Array.isArray(frozenEntries) ? frozenEntries : [])
      .filter((e) => e?.id && e?.webpage_url)
      .map((e) => [String(e.id), String(e.webpage_url)])
  );
  const fromDailymotion = isDailymotionUrl(sourceUrl);

  return (Array.isArray(ids) ? ids : []).map((raw) => {
    const id = String(raw || "").trim();
    if (!id) return id;
    if (/^https?:\/\//i.test(id)) return id;

    if (isLikelyYouTubeVideoId(id)) {
      return normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
    }

    const mappedUrl = byIdWebpage.get(id);
    if (mappedUrl && /^https?:\/\//i.test(mappedUrl)) {
      return mappedUrl;
    }

    if (fromDailymotion && /^x[0-9a-z]+$/i.test(id)) {
      return `https://www.dailymotion.com/video/${id}`;
    }

    return normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
  });
}

// Determines whether use flat playlist data should run for the yt-dlp YouTube download pipeline.
function shouldUseFlatPlaylist(url) {
  return !isDailymotionUrl(url);
}

// Determines whether attach cookies should run for the yt-dlp YouTube download pipeline.
function shouldAttachCookies(sourceUrl = "", forceCookies = false) {
  if (forceCookies) return true;
  return isYouTubeUrl(String(sourceUrl || ""));
}

// Builds base args for the yt-dlp YouTube download pipeline.
function buildBaseArgs(additionalArgs = [], { sourceUrl = "" } = {}) {
  const isYouTubeSource = isYouTubeUrl(String(sourceUrl || ""));
  const args = [
    "--ignore-config", "--no-warnings",
    "--socket-timeout", "15",
    "--user-agent", DEFAULT_USER_AGENT,
    "--retries", "3", "--retry-sleep", "1",
    "--sleep-requests", "0.1",
    "-J"
  ];

  if (isYouTubeSource) {
    args.push("--extractor-args", "youtube:player_client=android,web");
  }

  if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");

  if (isYouTubeSource) {
    Object.entries(DEFAULT_HEADERS).forEach(([key, value]) => {
      args.push("--add-header", `${key}: ${value}`);
    });
  }

  const extra = getExtraArgs();
  if (extra.length) args.push(...extra);

  if (shouldAttachCookies(sourceUrl)) {
    addCookieArgs(args, { ui: true });
  }
  args.push(...getJsRuntimeArgs());

  return [...args, ...additionalArgs];
}

// Determines whether strip cookies should run for the yt-dlp YouTube download pipeline.
function shouldStripCookies(explicit = false) {
  const env = process.env.YT_STRIP_COOKIES;

  if (env === "1") {
    return true;
  }

  if (env === "0") {
    return false;
  }

  if (FLAGS.STRIP_COOKIES) {
    return true;
  }
  return !!explicit;
}

// Handles with yt403 workarounds in the yt-dlp YouTube download pipeline.
export function withYT403Workarounds(baseArgs, { stripCookies = false } = {}) {
  let args = [...baseArgs];

  if (FLAGS.APPLY_403_WORKAROUNDS) {
    const tweaks = [
      ["--http-chunk-size", "16M"],
      ["--concurrent-fragments", "2"]
    ];
    tweaks.forEach(([flag, value]) => {
      if (!args.includes(flag)) args.push(flag, value);
    });
    args = addGeoArgs(args);
  }

  const finalStrip = shouldStripCookies(stripCookies);

  if (finalStrip) {
    const cookieFlags = ["--cookies", "--cookies-from-browser"];
    cookieFlags.forEach(flag => {
      const index = args.indexOf(flag);
      if (index !== -1) args.splice(index, 2);
    });
  }

  return args;
}

// Runs YouTube metadata json for the yt-dlp YouTube download pipeline.
export async function runYtJson(args, label = "ytjson", timeout = DEFAULT_TIMEOUT) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) {
    throw new Error("yt-dlp not found. Please install it or set YTDLP_BIN to its path.");
  }

  return new Promise((resolve, reject) => {
    const sourceUrl =
      [...(Array.isArray(args) ? args : [])]
        .reverse()
        .find((x) => typeof x === "string" && /^https?:\/\//i.test(x)) || "";
    const finalArgs = buildBaseArgs(args, { sourceUrl });
    let stdoutData = "", stderrData = "";

    const process = spawn(YTDLP_BIN, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });

    const timeoutId = setTimeout(() => {
      try { process.kill("SIGKILL"); } catch {}
      reject(new Error(`[${label}] timeout (${timeout}ms)`));
    }, timeout);

    process.stdout.on("data", chunk => stdoutData += chunk.toString());
    process.stderr.on("data", chunk => stderrData += chunk.toString());

    process.on("close", (code) => {
      clearTimeout(timeoutId);

      if (code === 0) {
        try {
          const result = JSON.parse(stdoutData);
          resolve(result);
        } catch (error) {
          reject(new Error(`[${label}] JSON parse error: ${error.message}\n${stderrData}`));
        }
      } else {
        reject(new Error(`[${label}] exit code ${code}\n${stderrData.slice(-500)}`));
      }
    });

    process.on("error", (error) => {
      clearTimeout(timeoutId);
      reject(new Error(`[${label}] failed to start: ${error.message}`));
    });
  });
}

// Processes entry in the yt-dlp YouTube download pipeline.
function processEntry(entry, index) {
  const id = entry?.id || "";
  const isDmId = /^x[0-9a-z]+$/i.test(String(id || ""));
  const directUrl = entry?.webpage_url || entry?.url || "";
  let resolvedUrl = directUrl;
  if (!resolvedUrl && id) {
    if (isLikelyYouTubeVideoId(id)) {
      resolvedUrl = normalizeYouTubeUrl(`https://www.youtube.com/watch?v=${id}`);
    } else if (isDmId) {
      resolvedUrl = `https://www.dailymotion.com/video/${id}`;
    }
  }

  const titleRaw =
    entry?.title ||
    entry?.alt_title ||
    entry?.track ||
    entry?.name ||
    "";

  return {
    index: Number(entry?.playlist_index ?? (index + 1)),
    id,
    title: toNFC(titleRaw || id || ""),
    duration: Number.isFinite(entry?.duration) ? entry.duration : null,
    duration_string: entry?.duration_string || null,
    uploader: toNFC(
      entry?.uploader ||
      entry?.channel ||
      entry?.artist ||
      entry?.creator ||
      entry?.owner?.screenname ||
      entry?.owner?.username ||
      ""
    ),
    webpage_url: resolvedUrl,
    thumbnail: (Array.isArray(entry?.thumbnails) && entry.thumbnails.length ?
      entry.thumbnails.at(-1).url :
      entry?.thumbnail ||
      entry?.thumbnail_720_url ||
      entry?.thumbnail_360_url ||
      entry?.thumbnail_url ||
      null)
  };
}

// Processes entries in the yt-dlp YouTube download pipeline.
function processEntries(entries, maxEntries = PREVIEW_MAX_ENTRIES) {
  return entries
    .filter(Boolean)
    .slice(0, maxEntries)
    .map(processEntry)
    .sort((a, b) => a.index - b.index);
}

// Extracts playlist data all flat for the yt-dlp YouTube download pipeline.
export async function extractPlaylistAllFlat(url) {
  const useFlat = shouldUseFlatPlaylist(url);
  const args = useFlat
    ? ["--yes-playlist", "--flat-playlist", "--ignore-errors", url]
    : ["--yes-playlist", "--ignore-errors", "--skip-download", url];
  const data = await runYtJson(
    args,
    "playlist-all-flat",
    PLAYLIST_ALL_TIMEOUT
  );

  const title = data?.title || data?.playlist_title || "";
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  const count = Number(data?.n_entries) || rawEntries.length || 0;
  const items = processEntries(rawEntries);

  return { title, count, items };
}

// Returns playlist data meta lite used for the yt-dlp YouTube download pipeline.
export async function getPlaylistMetaLite(url) {
  const isAutomix = isYouTubeAutomix(url);

  if (isAutomix) {
    try {
      const data = await runYtJson(
        ["--yes-playlist", "--flat-playlist", "--ignore-errors", url],
        "automix-meta",
        40000
      );

      const title = data?.title || data?.playlist_title || "YouTube Automix";
      const count = Number(data?.n_entries) ||
                    (Array.isArray(data?.entries) ? data.entries.length : 50) ||
                    50;

      setCache(url, { title, count: Math.max(1, count), entries: [] });
      return { title, count: Math.max(1, count), isAutomix: true };
    } catch {
      setCache(url, { title: "YouTube Automix", count: 50, entries: [] });
      return { title: "YouTube Automix", count: 50, isAutomix: true };
    }
  }

  const useFlat = shouldUseFlatPlaylist(url);
  const metaArgs = useFlat
    ? ["--yes-playlist", "--flat-playlist", "--ignore-errors", url]
    : ["--yes-playlist", "--ignore-errors", "--skip-download", "--playlist-items", "1", url];

  try {
    const data = await runYtJson(
      metaArgs,
      "playlist-meta",
      PLAYLIST_META_TIMEOUT
    );

    const title = data?.title || data?.playlist_title || "";
    const count = Number(data?.n_entries) || Number(data?.playlist_count) ||
                 (Array.isArray(data?.entries) ? data.entries.length : 0);

    return { title, count: Math.max(1, count), isAutomix: false };
  } catch {
    try {
      const data = await runYtJson(
        ["--yes-playlist", "--skip-download", "--playlist-items", "1", url],
        "playlist-meta-fallback",
        PLAYLIST_META_FALLBACK_TIMEOUT
      );

      const title = data?.title || data?.playlist_title || "";
      const count = Number(data?.n_entries) || Number(data?.playlist_count) || 1;

      return { title, count: Math.max(1, count), isAutomix: false };
    } catch {
      return { title: "", count: 1, isAutomix: false };
    }
  }
}

// Extracts playlist data page for the yt-dlp YouTube download pipeline.
export async function extractPlaylistPage(url, start, end) {
  try {
    const useFlat = shouldUseFlatPlaylist(url);
    const args = useFlat
      ? [
          "--yes-playlist", "--flat-playlist",
          "--playlist-items", `${start}-${end}`,
          url
        ]
      : [
          "--yes-playlist", "--ignore-errors", "--skip-download",
          "--playlist-items", `${start}-${end}`,
          url
        ];
    const data = await runYtJson(
      args,
      `playlist-page-${start}-${end}`,
      PLAYLIST_PAGE_TIMEOUT
    );

    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const items = entries.map(processEntry);
    const title = data?.title || data?.playlist_title || "";

    return { title, items };
  } catch {
    return { title: "", items: [] };
  }
}

// Extracts automix all flat for the yt-dlp YouTube download pipeline.
export async function extractAutomixAllFlat(url) {
  const data = await runYtJson([
    "--yes-playlist", "--flat-playlist", "--ignore-errors", url
  ], "automix-all-flat", AUTOMIX_ALL_TIMEOUT);

  const title = data?.title || data?.playlist_title || "YouTube Automix";
  const rawEntries = Array.isArray(data?.entries) ? data.entries : [];
  const count = Number(data?.n_entries) || rawEntries.length || 50;

  const items = rawEntries
    .slice(0, PREVIEW_MAX_ENTRIES)
    .map((entry, index) => ({
      ...processEntry(entry, index),
      uploader: entry?.uploader || entry?.channel || "YouTube Mix",
      webpage_url: entry?.webpage_url || entry?.url || url
    }))
    .sort((a, b) => a.index - b.index);

  return { title, count: Math.max(1, count), items };
}

// Extracts automix page for the yt-dlp YouTube download pipeline.
export async function extractAutomixPage(url, start, end) {
  try {
    const data = await runYtJson(
      [
        "--yes-playlist", "--flat-playlist", "--ignore-errors",
        "--playlist-items", `${start}-${end}`, url
      ],
      `automix-page-${start}-${end}`,
      AUTOMIX_PAGE_TIMEOUT
    );

    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const items = entries.map((entry, index) => ({
      ...processEntry(entry, index),
      uploader: entry?.uploader || entry?.channel || "YouTube Mix",
      webpage_url: entry?.webpage_url || entry?.url || url
    }));

    const title = data?.title || data?.playlist_title || "YouTube Automix";
    const count = Number(data?.n_entries) || entries.length || 50;
    const cache = getCache(url) || { title, count: 0, entries: [] };
    if (!cache.title) cache.title = title;
    mergeCacheEntries(url, items);

    return { title, items, count };
  } catch {
    return null;
  }
}

// Handles ensure automix upto in the yt-dlp YouTube download pipeline.
export async function ensureAutomixUpto(url, upto, batchSize = 50) {
  const cache = getCache(url);
  if (!cache) return;

  const have = cache.entries.length;
  if (have >= upto) return;

  let start = have + 1;
  while (start <= upto && cache.entries.length < PREVIEW_MAX_ENTRIES) {
    const end = Math.min(start + batchSize - 1, upto);
    const page = await extractAutomixPage(url, start, end);

    if (page && Array.isArray(page.items) && page.items.length) {
      mergeCacheEntries(url, page.items);
      start = end + 1;
    } else {
      break;
    }
  }
}

// Loads YouTube metadata metadata for the yt-dlp YouTube download pipeline.
export async function fetchYtMetadata(url, isPlaylist = false) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found.");

  // Builds args for the yt-dlp YouTube download pipeline.
  const buildArgs = (flat = false, { stripCookies = false } = {}) => {
    let args = buildBaseArgs([], { sourceUrl: url });
    if (!args.includes("--no-check-formats")) {
      args.push("--no-check-formats");
    }

    if (!isPlaylist) args.push("--no-playlist");
    if (flat && isPlaylist) args.push("--flat-playlist");
    args = withYT403Workarounds(args, { stripCookies });

    args.push(url);
    return args;
  };

  const attemptDownload = (args, label) =>
    new Promise((resolve, reject) => {
      let stdoutData = "", stderrData = "";

      console.warn("[yt-meta-debug]", label, "args:", args.join(" "));

      const child = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      const timeoutId = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        reject(new Error(`[${label}] timeout`));
      }, 30000);

      child.stdout.on("data", chunk => stdoutData += chunk.toString());
      child.stderr.on("data", chunk => stderrData += chunk.toString());

      child.on("close", (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          try {
            resolve(JSON.parse(stdoutData));
          } catch (error) {
            reject(new Error(`[${label}] JSON parse error: ${error.message}\n${stderrData}`));
          }
        } else {
          const tail = stderrData.split("\n").slice(-20).join("\n");
          reject(new Error(`[${label}] exit code ${code}\n${tail}`));
        }
      });

      child.on("error", (error) => {
        clearTimeout(timeoutId);
        reject(new Error(`[${label}] failed to start: ${error.message}`));
      });
    });

  const attempts = [
    { label: "meta+cookies+flat", args: buildArgs(true,  { stripCookies: false }) },
    { label: "meta+cookies",      args: buildArgs(false, { stripCookies: false }) },
    { label: "meta+nocookies",    args: buildArgs(false, { stripCookies: true  }) }
  ];

  let lastError;
for (const attempt of attempts) {
  try {
    const data = await attemptDownload(attempt.args, attempt.label);
    return data;
  } catch (error) {
    lastError = error;
    const msg = String(error.message || "");
    if (/Sign in to confirm your age/i.test(msg) ||
        /may be inappropriate for some users/i.test(msg) ||
        /age[-\s]?restricted/i.test(msg)) {
      console.warn("[yt-meta] age-restricted, metadata alınamadı, null dönüyorum");
      return null;
    }
  }
}

throw new Error(`All metadata attempts failed. Last error: ${lastError?.message}`);
}

// Resolves playlist data selected ids for the yt-dlp YouTube download pipeline.
export async function resolvePlaylistSelectedIds(url, indices = []) {
  const data = await extractPlaylistAllFlat(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  const title = data?.title || "";

  const byIndex = new Map(items.map((item, index) => [index + 1, item]));
  const picked = indices.map(idx => byIndex.get(Number(idx))).filter(Boolean);
  const ids = picked.map(entry => entry.id).filter(Boolean);

  return { ids, entries: picked, title };
}

// Resolves automix selected ids for the yt-dlp YouTube download pipeline.
export async function resolveAutomixSelectedIds(url, indices = []) {
  const data = await extractAutomixAllFlat(url);
  const items = Array.isArray(data?.items) ? data.items : [];
  const title = data?.title || "YouTube Automix";

  const byIndex = new Map(items.map((item, index) => [index + 1, item]));
  const picked = indices.map(idx => byIndex.get(Number(idx))).filter(Boolean);
  const ids = picked.map(entry => entry.id).filter(Boolean);

  return { ids, entries: picked, title };
}

// Downloads you tube video for the yt-dlp YouTube download pipeline.
export async function downloadYouTubeVideo(
  url,
  jobId,
  isPlaylist = false,
  playlistItems = null,
  isAutomix = false,
  selectedIds = null,
  TEMP_DIR = path.resolve(process.cwd(), "temp"),
  progressCallback = null,
  opts = {},
  ctrl = {}
) {
  try {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  } catch {}

  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found.");
  if (isYouTubeUrl(String(url || ""))) {
    url = normalizeYouTubeUrl(url);
  }

  const hasSelectedIds =
    (isAutomix || isPlaylist) &&
    Array.isArray(selectedIds) &&
    selectedIds.length > 0;

  if (hasSelectedIds) {
    const conc = normalizeConcurrency(opts.youtubeConcurrency);
    if (conc > 1) {
      return downloadSelectedIdsParallel(
        YTDLP_BIN,
        selectedIds,
        jobId,
        TEMP_DIR,
        progressCallback,
        { ...opts, youtubeConcurrency: conc },
        ctrl
      );
    }

    return downloadSelectedIds(
      YTDLP_BIN,
      selectedIds,
      jobId,
      TEMP_DIR,
      progressCallback,
      opts,
      ctrl
    );
  }

  return downloadStandard(
    YTDLP_BIN,
    url,
    jobId,
    isPlaylist,
    isAutomix,
    playlistItems,
    TEMP_DIR,
    progressCallback,
    opts,
    ctrl
  );
}

// Downloads selected ids for the yt-dlp YouTube download pipeline.
async function downloadSelectedIds(
  ytDlpBin,
  selectedIds,
  jobId,
  tempDir,
  progressCallback,
  opts = {},
  ctrl = {}
) {
  const idToIndex = new Map((opts?.frozenEntries || []).filter(e => e?.id && Number.isFinite(e.index)).map(e => [e.id, e.index]));
  const seenSkip = new Set();
  const listFile = path.join(tempDir, `${jobId}.urls.txt`);
  const urls = idsToDownloadUrls(selectedIds, opts?.frozenEntries, opts?.sourceUrl || "");
  const sourceUrl = opts?.sourceUrl || urls?.[0] || "";
  const sourceHeaders = isYouTubeUrl(String(sourceUrl || "")) ? DEFAULT_HEADERS : null;
  const fragmentConc = normalizeConcurrency(
    process.env.YTDLP_FRAGMENT_CONCURRENCY || DEFAULT_FRAGMENT_CONCURRENCY
  );

  fs.writeFileSync(listFile, urls.join("\n"), "utf8");

  const playlistDir = path.join(tempDir, jobId);
  fs.mkdirSync(playlistDir, { recursive: true });

  const preExisting = getDownloadedFiles(playlistDir, true);
  if (preExisting.length >= selectedIds.length) {
    if (progressCallback) progressCallback(100);
    return preExisting;
  }

  const totalCount = selectedIds.length;
  let skippedCount = 0;
  let errorsCount = 0;

  // Updates skip stats for the yt-dlp YouTube download pipeline.
  const updateSkipStats = () => {
    if (opts.onSkipUpdate) {
      opts.onSkipUpdate({ skippedCount, errorsCount });
    }
  };

  // Handles bump skip in the yt-dlp YouTube download pipeline.
  const bumpSkip = (line) => {
    if (isBenignSabrWarning(line)) return;
    if (/^\s*SKIP_(SUMMARY|HINT):/i.test(line)) return;
    const key = line.replace(/\s+/g, " ").trim();
    if (seenSkip.has(key)) return;
    seenSkip.add(key);

    if (SKIP_RE.test(line)) {
      skippedCount++;
      emitEvent(progressCallback, opts, {
        type: "skip-hint",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skippedItem",
        raw: line,
        jobId
      });
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    } else if (ERROR_WORD.test(line)) {
      errorsCount++;
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    }
  };

let args;

if (opts.video) {
    const h = (opts.maxHeight && Number.isFinite(opts.maxHeight)) ? opts.maxHeight : 1080;
    args = [
      "--force-ipv4",
      "--no-playlist",
      "--ignore-errors", "--no-abort-on-error",
      "--no-part",
      "--progress", "--newline",
      "-N", String(fragmentConc),
      "-f", buildVideoFormatSelector(opts?.sourceUrl || urls?.[0] || "", h),
      "-o", path.join(playlistDir, "%(id)s.%(ext)s"),
      "-a", listFile
    ];
  } else {
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--user-agent", DEFAULT_USER_AGENT,
      ...headersToArgs(sourceHeaders),
      "--no-playlist",
      "-N", String(fragmentConc),
      "--ignore-errors", "--no-abort-on-error",
      "--write-thumbnail", "--convert-thumbnails", "jpg",
      "--continue", "--no-overwrites",
      "--progress", "--newline",
      "-o", path.join(playlistDir, "%(id)s.%(ext)s"),
      "-a", listFile,
      "-f", "bestaudio[abr>=128]/bestaudio/best"
    ];

    if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
    const geoNetArgs = addGeoArgs([]);
    if (geoNetArgs.length) args.push(...geoNetArgs);

    const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
    if (extraEnv) {
      args.push(...extraEnv.split(/\s+/).filter(Boolean));
    }
  }
  const cookieSourceUrl = opts?.sourceUrl || urls?.[0] || "";
  if (shouldAttachCookies(cookieSourceUrl, !!opts?.forceCookies)) {
    addCookieArgs(args, { ui: !!opts?.forceCookies });
  }
  args.push(...getJsRuntimeArgs());

  return new Promise((resolve, reject) => {
    let stderrBuf = "";
    let downloadedCount = 0;

    const child = spawn(ytDlpBin, args);
    try { registerJobProcess(jobId, child); } catch {}

    // Handles abort if canceled in the yt-dlp YouTube download pipeline.
    const abortIfCanceled = () => {
      if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
        try { child.kill("SIGTERM"); } catch {}
        return true;
      }
      return false;
    };

    // Handles handle line in the yt-dlp YouTube download pipeline.
    const handleLine = (line) => {
    if (!line) return;
    if (ERROR_WORD.test(line) || SKIP_RE.test(line)) bumpSkip(line);
    if (line.includes("[download] Destination:")) {
    const m = line.match(/Destination:\s*(.+)$/i);
    const dest = m ? m[1].trim() : "";

    const isThumb = /\.(jpe?g|png|webp)$/i.test(dest);

    if (!isThumb) {
      downloadedCount++;
      const logicalDone = opts.video
        ? Math.min(totalCount, Math.ceil(downloadedCount / 2))
        : Math.min(totalCount, downloadedCount);

      const progress = (logicalDone / totalCount) * 100;
      if (typeof opts.onFileDone === "function") {
        let absPath = dest;
        if (!path.isAbsolute(absPath)) {
          absPath = path.join(playlistDir, dest);
        }

        const fileId = parseIdFromPath(absPath);
        const playlistIndex = (fileId && idToIndex.has(fileId)) ? idToIndex.get(fileId) : parsePlaylistIndexFromPath(absPath);
        try {
          opts.onFileDone({
            filePath: absPath,
            playlistIndex,
            id: fileId || null
          });
        } catch {}
      }

      if (progressCallback) progressCallback(progress);
      emitEvent(progressCallback, opts, {
        type: "file-done",
        downloaded: logicalDone,
        total: totalCount,
        jobId
      });
    }
    return;
  }
    const pctMatch = line.match(/(\d+(?:\.\d+)?)%/);
    if (pctMatch && progressCallback) {
    const filePct = parseFloat(pctMatch[1]);
    const overall = (downloadedCount / totalCount) * 100 + (filePct / totalCount);
        progressCallback(Math.min(100, overall));
      }
    };

    child.stdout.on("data", (data) => {
      if (abortIfCanceled()) return;
      const s = data.toString();
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.stderr.on("data", (data) => {
      if (abortIfCanceled()) return;
      const s = data.toString();
      stderrBuf += s;
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.on("close", (code, signal) => {
      try { process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`); } catch {}
      updateSkipStats();
      emitEvent(progressCallback, opts, {
        type: "summary",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skipSummary",
        lastLogVars: { skipped: skippedCount, errors: errorsCount }
      });

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        return reject(new Error("CANCELED"));
      }
      if (code === null && /terminated|killed|aborted|SIGTERM|SIGKILL/i.test(stderrBuf)) {
        return reject(new Error("CANCELED"));
      }

      const files = getDownloadedFiles(playlistDir, true);
      if (files.length > 0) {
        const finalSkipped = Math.max(0, totalCount - files.length);
        if (finalSkipped !== skippedCount) {
          skippedCount = finalSkipped;
          updateSkipStats();
        }
        if (progressCallback) progressCallback(100);
        return resolve(files);
      }

      const errorTail = String(stderrBuf).split("\n").slice(-20).join("\n");
      return reject(new Error(`yt-dlp error (selected-ids): ${code}\n${errorTail}`));
    });

    child.on("error", (error) => {
      reject(new Error(`yt-dlp failed to start: ${error.message}`));
    });
  });
}

// Downloads selected ids parallel for the yt-dlp YouTube download pipeline.
async function downloadSelectedIdsParallel(
  ytDlpBin,
  selectedIds,
  jobId,
  tempDir,
  progressCallback,
  opts = {},
  ctrl = {}
) {
  const idToIndex = new Map((opts?.frozenEntries || []).filter(e => e?.id && Number.isFinite(e.index)).map(e => [e.id, e.index]));
  const urls = idsToDownloadUrls(selectedIds, opts?.frozenEntries, opts?.sourceUrl || "");
  const playlistDir = path.join(tempDir, jobId);
  fs.mkdirSync(playlistDir, { recursive: true });

  const preExisting = getDownloadedFiles(playlistDir, true);
  if (preExisting.length >= selectedIds.length) {
    if (progressCallback) progressCallback(100);
    return preExisting;
  }

  const fragmentConc = normalizeConcurrency(
    process.env.YTDLP_FRAGMENT_CONCURRENCY || DEFAULT_FRAGMENT_CONCURRENCY
  );

  const totalCount = selectedIds.length;
  let completedCount = preExisting.length;
  let skippedCount = 0;
  let errorsCount = 0;
  const seenSkip = new Set();

  // Updates skip stats for the yt-dlp YouTube download pipeline.
  const updateSkipStats = () => {
    if (typeof opts.onSkipUpdate === "function") {
      opts.onSkipUpdate({ skippedCount, errorsCount });
    }
  };

  // Handles bump skip in the yt-dlp YouTube download pipeline.
  const bumpSkip = (line) => {
    if (isBenignSabrWarning(line)) return;
    if (/^\s*SKIP_(SUMMARY|HINT):/i.test(line)) return;
    const key = line.replace(/\s+/g, " ").trim();
    if (seenSkip.has(key)) return;
    seenSkip.add(key);

    if (SKIP_RE.test(line)) {
      skippedCount++;
      emitEvent(progressCallback, opts, {
        type: "skip-hint",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skippedItem",
        raw: line,
        jobId
      });
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    } else if (ERROR_WORD.test(line)) {
      errorsCount++;
      updateSkipStats();
      try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
    }
  };

  // Handles overall progress in the yt-dlp YouTube download pipeline.
  const overallProgress = () => {
    if (!progressCallback) return;
    const pct = Math.min(100, (completedCount / totalCount) * 100);
    progressCallback(pct);
  };

  const makeTask = (url, index) => async () => {
    if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
      throw new Error("CANCELED");
    }

    const outputTemplate = path.join(playlistDir, `%(id)s.%(ext)s`);

    let args;

    if (opts.video) {
      const h = (opts.maxHeight && Number.isFinite(opts.maxHeight))
        ? opts.maxHeight
        : 1080;

      args = [
        "--force-ipv4",
        "--no-playlist",
        "--ignore-errors", "--no-abort-on-error",
        "--no-part",
        "--progress", "--newline",
        "-N", String(fragmentConc),
        "-f", buildVideoFormatSelector(url, h),
        "-o", outputTemplate,
        url
      ];
    } else {
      args = [
        "--ignore-config", "--no-warnings",
        "--socket-timeout", "15",
        "--user-agent", DEFAULT_USER_AGENT,
        ...headersToArgs(isYouTubeUrl(String(url || "")) ? DEFAULT_HEADERS : null),
        "--no-playlist",
        "--ignore-errors", "--no-abort-on-error",
        "--write-thumbnail", "--convert-thumbnails", "jpg",
        "--continue", "--no-overwrites",
        "--autonumber-size", "3",
        "--progress", "--newline",
        "-N", String(fragmentConc),
        "-f", "bestaudio[abr>=128]/bestaudio/best",
        "-o", outputTemplate,
        url
      ];

      if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
      const geoNetArgs = addGeoArgs([]);
      if (geoNetArgs.length) args.push(...geoNetArgs);

      const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
      if (extraEnv) {
        args.push(...extraEnv.split(/\s+/).filter(Boolean));
      }
    }

    if (shouldAttachCookies(url, !!opts?.forceCookies)) {
      addCookieArgs(args, { ui: !!opts?.forceCookies });
    }
    args.push(...getJsRuntimeArgs());

    return new Promise((resolve, reject) => {
      let stderrBuf = "";
      let mediaDestAbs = null;
      let emittedDone = false;

      const child = spawn(ytDlpBin, args);
      try { registerJobProcess(jobId, child); } catch {}

      // Handles abort if canceled in the yt-dlp YouTube download pipeline.
      const abortIfCanceled = () => {
        if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
          try { child.kill("SIGTERM"); } catch {}
          return true;
        }
        return false;
      };

      // Handles fallback abs path by id in the yt-dlp YouTube download pipeline.
      const fallbackAbsPathById = () => {
        const fallbackId = selectedIds[index];
        if (!fallbackId) return null;
        try {
          const all = fs
            .readdirSync(playlistDir)
            .map((f) => path.join(playlistDir, f))
            .filter((p) => parseIdFromPath(p) === fallbackId);
          return all[0] || null;
        } catch {
          return null;
        }
      };

      // Handles emit file done once in the yt-dlp YouTube download pipeline.
      const emitFileDoneOnce = () => {
        if (emittedDone) return;
        const donePath =
          (mediaDestAbs && fs.existsSync(mediaDestAbs) && mediaDestAbs) ||
          fallbackAbsPathById();
        if (!donePath) return;
        emittedDone = true;

        completedCount++;
        overallProgress();

        emitEvent(progressCallback, opts, {
          type: "file-done",
          downloaded: completedCount,
          total: totalCount,
          jobId
        });

        if (typeof opts.onFileDone === "function") {
          const fileId = parseIdFromPath(donePath);
          const playlistIndex = (fileId && idToIndex.has(fileId))
            ? idToIndex.get(fileId)
            : parsePlaylistIndexFromPath(donePath);
          try {
            opts.onFileDone({
              filePath: donePath,
              playlistIndex,
              id: fileId || null
            });
          } catch {}
        }
      };

      // Handles handle line in the yt-dlp YouTube download pipeline.
      const handleLine = (line) => {
        if (!line) return;

        if (ERROR_WORD.test(line) || SKIP_RE.test(line)) {
          bumpSkip(line);
        }

        if (line.includes("[download] Destination:")) {
          const m = line.match(/Destination:\s*(.+)$/i);
          const dest = m ? m[1].trim() : "";
          if (dest && !/\.(jpe?g|png|webp)$/i.test(dest)) {
            mediaDestAbs = path.isAbsolute(dest) ? dest : path.join(playlistDir, dest);
          }
        }
      };

      child.stdout.on("data", (d) => {
        if (abortIfCanceled()) return;
        d.toString().split(/\r?\n/).forEach(handleLine);
      });

      child.stderr.on("data", (d) => {
        if (abortIfCanceled()) return;
        const s = d.toString();
        stderrBuf += s;
        s.split(/\r?\n/).forEach(handleLine);
      });

      child.on("close", (code, signal) => {
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          return reject(new Error("CANCELED"));
        }

        if (code === 0) {
          emitFileDoneOnce();
          return resolve();
        }

        const tail = String(stderrBuf).split("\n").slice(-20).join("\n");

        if (SKIP_RE.test(tail) || ERROR_WORD.test(tail)) {
          emitFileDoneOnce();
          return resolve();
        }

        return reject(new Error(`yt-dlp error (parallel id ${index + 1}): ${code}\n${tail}`));
      });

      child.on("error", (err) => {
        reject(new Error(`yt-dlp failed to start: ${err.message}`));
      });
    });
  };

  const conc = normalizeConcurrency(opts.youtubeConcurrency);
  const tasks = urls.map((url, idx) => makeTask(url, idx));

  await runWithConcurrency(conc, tasks);

  try {
    process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`);
  } catch {}
  updateSkipStats();
  emitEvent(progressCallback, opts, {
    type: "summary",
    skippedCount,
    errorsCount,
    lastLogKey: "log.skipSummary",
    lastLogVars: { skipped: skippedCount, errors: errorsCount }
  });

  const files = getDownloadedFiles(playlistDir, true);
  if (files.length > 0) {
    if (progressCallback) progressCallback(100);
    return files;
  }

  throw new Error("Download appears successful but output files were not found");
}

// Downloads standard for the yt-dlp YouTube download pipeline.
async function downloadStandard(
  ytDlpBin,
  url,
  jobId,
  isPlaylist,
  isAutomix,
  playlistItems,
  tempDir,
  progressCallback = null,
  opts = {},
  ctrl = {}
) {
  const H = (opts.maxHeight && Number.isFinite(opts.maxHeight)) ? opts.maxHeight : 1080;
  const fragmentConc = normalizeConcurrency(
    process.env.YTDLP_FRAGMENT_CONCURRENCY || DEFAULT_FRAGMENT_CONCURRENCY
  );

  const outputTemplate = path.join(
    tempDir,
    isPlaylist || isAutomix
      ? `${jobId}/%(playlist_index)s.%(ext)s`
      : `${jobId}.%(ext)s`
  );

  if (isPlaylist || isAutomix) {
    const playlistDir = path.join(tempDir, jobId);
    if (fs.existsSync(playlistDir)) {
      const files = getDownloadedFiles(playlistDir, true);
      if (files.length > 0) return files;
    }
  } else {
    const existingSingle = getDownloadedFiles(tempDir, false, jobId);
    if (existingSingle.length > 0) {
      return existingSingle[0];
    }
  }

  let args;

  if (opts.video) {
    const h = H || 1080;
    args = [
      "--force-ipv4",
      "--progress", "--newline",
      "-f",
      buildVideoFormatSelector(url, h)
    ];

    if (isPlaylist || isAutomix) {
      args.push(
        "--yes-playlist",
        "--ignore-errors",
        "--no-abort-on-error",
        "--no-part",
        "-N", String(fragmentConc),
        "-o", outputTemplate
      );

      if (Array.isArray(playlistItems) && playlistItems.length > 0) {
        args.push("--playlist-items", playlistItems.join(","));
      } else {
        args.push("--playlist-end", "100");
      }
    } else {
      args.push(
        "--no-playlist",
        "--no-part",
        "-o", outputTemplate
      );
    }

    const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
    if (extraEnv) {
      args.push(...extraEnv.split(/\s+/).filter(Boolean));
    }
    if (shouldAttachCookies(opts?.sourceUrl || url, !!opts?.forceCookies)) {
      addCookieArgs(args, { ui: !!opts?.forceCookies });
    }
    args.push(...getJsRuntimeArgs());

    args.push(url);
      } else {
    args = [
      "--ignore-config", "--no-warnings",
      "--socket-timeout", "15",
      "--user-agent", DEFAULT_USER_AGENT,
      ...headersToArgs(
        opts?.requestHeaders || (isYouTubeUrl(String(url || "")) ? DEFAULT_HEADERS : null)
      ),
      "--progress", "--newline",
      "-f", "bestaudio[abr>=128]/bestaudio/best"
    ];

        if (FLAGS.FORCE_IPV4) args.push("--force-ipv4");
        const geoNetArgs = addGeoArgs([]);
        if (geoNetArgs.length) args.push(...geoNetArgs);

        if (isPlaylist || isAutomix) {
      args.push(
        "--yes-playlist",
        "--ignore-errors",
        "--no-abort-on-error",
        "--write-thumbnail",
        "--convert-thumbnails", "jpg",
        "-N", String(fragmentConc),
      );

      if (Array.isArray(playlistItems) && playlistItems.length > 0) {
        args.push("--playlist-items", playlistItems.join(","));
      } else {
        args.push("--playlist-end", "100");
      }
    } else {
      args.push("--no-playlist");

      const audioLimit = process.env.YTDLP_AUDIO_LIMIT_RATE;
      if (audioLimit) {
        args.push("--limit-rate", audioLimit);
      }
    }

    args.push(
      "--no-part", "--continue", "--no-overwrites",
      "--retries", "10",
      "--fragment-retries", "10",
      "--retry-sleep", "1",
      "-o", outputTemplate
    );

    const extraEnv = process.env.YTDLP_EXTRA || process.env.YTDLP_ARGS_EXTRA;
    if (extraEnv) {
      args.push(...extraEnv.split(/\s+/).filter(Boolean));
    }
    if (shouldAttachCookies(opts?.sourceUrl || url, !!opts?.forceCookies)) {
      addCookieArgs(args, { ui: !!opts?.forceCookies });
    }
    args.push(...getJsRuntimeArgs());
    args.push(url);
  }

  const finalArgs = args;
  return new Promise((resolve, reject) => {
    const child = spawn(ytDlpBin, finalArgs, { stdio: ["ignore", "pipe", "pipe"] });
    try { registerJobProcess(jobId, child); } catch {}

    // Handles abort if canceled in the yt-dlp YouTube download pipeline.
    const abortIfCanceled = () => {
      if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
        try { child.kill("SIGTERM"); } catch {}
        return true;
      }
      return false;
    };

    if (abortIfCanceled()) {
      return reject(new Error("CANCELED"));
    }
    const cancelTick = setInterval(() => { abortIfCanceled(); }, 250);

    let stderrBuf = "";
    let skippedCount = 0;
    let errorsCount = 0;
    let seenTotal = null;
    let downloadedFiles = 0;
    let curFilePct = 0;

    // Updates skip stats for the yt-dlp YouTube download pipeline.
    const updateSkipStats = () => {
      if (opts.onSkipUpdate) {
        opts.onSkipUpdate({ skippedCount, errorsCount });
      }
    };

    // Handles bump skip std in the yt-dlp YouTube download pipeline.
    const bumpSkipStd = (line) => {
      if (isBenignSabrWarning(line)) return;
      if (/^\s*SKIP_(SUMMARY|HINT):/i.test(line)) return;
      const key = line.replace(/\s+/g, " ").trim();
      if (seenSkip.has(key)) return;
      seenSkip.add(key);

      if (SKIP_RE.test(line)) {
        skippedCount++;
        emitEvent(progressCallback, opts, {
          type: "skip-hint",
          skippedCount,
          errorsCount,
          lastLogKey: "log.skippedItem",
          raw: line,
          jobId
        });
        updateSkipStats();
        try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
      } else if (ERROR_WORD.test(line)) {
        errorsCount++;
        updateSkipStats();
        try { process.stderr.write(`\nSKIP_HINT: ${line.trim()}\n`); } catch {}
      }
    };

    const seenSkip = new Set();
    const pctRe = /(\d+(?:\.\d+)?)%/;
    const itemRe = /Downloading item\s+(\d+)\s+of\s+(\d+)/i;
    const destinationRe = /\[download\]\s+Destination:/i;

    // Handles bump progress in the yt-dlp YouTube download pipeline.
    const bumpProgress = () => {
      if (!progressCallback) return;

      if (isPlaylist || isAutomix) {
        const total = seenTotal || downloadedFiles || 1;
        const fileProgress = (downloadedFiles / total) * 100;
        const currentFileProgress = (curFilePct / 100) * (100 / total);
        const overall = Math.max(0, Math.min(100, fileProgress + currentFileProgress));
        progressCallback(overall);
      } else {
        progressCallback(Math.max(0, Math.min(100, curFilePct)));
      }
    };

    // Handles handle line in the yt-dlp YouTube download pipeline.
    const handleLine = (line) => {
    if (!line) return;

    if (ERROR_WORD.test(line) || SKIP_RE.test(line)) {
      bumpSkipStd(line);
    }

    if (destinationRe.test(line)) {
      const m = line.match(/Destination:\s*(.+)$/i);
      const dest = (m?.[1] || "").trim();

      if (isPlaylist || isAutomix) {
        downloadedFiles++;

        const total = seenTotal || downloadedFiles;
        if (progressCallback) {
          const progress = (downloadedFiles / total) * 100;
          progressCallback(progress);
        }

        emitEvent(progressCallback, opts, {
          type: "file-done",
          downloaded: downloadedFiles,
          total: seenTotal || downloadedFiles,
          jobId
        });

        if (typeof opts.onFileDone === "function" && dest) {
          let absPath = dest;
          if (!path.isAbsolute(absPath)) {
            const playlistDir = path.join(tempDir, jobId);
            absPath = path.join(playlistDir, dest);
          }

          const playlistIndex = parsePlaylistIndexFromPath(absPath);
          try {
            opts.onFileDone({
              filePath: absPath,
              playlistIndex
            });
          } catch {}
        }
      }
      return;
    }

    const pctMatch = line.match(pctRe);
    if (pctMatch) {
      curFilePct = parseFloat(pctMatch[1]) || 0;
      bumpProgress();
    }

    const mItem = line.match(itemRe);
    if (mItem) {
      const idx = parseInt(mItem[1], 10);
      const tot = parseInt(mItem[2], 10);
      if (Number.isFinite(tot) && tot > 0) seenTotal = tot;
    }
  };
    child.stdout.on("data", (d) => {
      if (abortIfCanceled()) return;
      const s = d.toString();
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.stderr.on("data", (d) => {
      if (abortIfCanceled()) return;
      const s = d.toString();
      stderrBuf += s;
      s.split(/\r?\n/).forEach(handleLine);
    });

    child.on("close", (code, signal) => {
      clearInterval(cancelTick);
      try { process.stderr.write(`\nSKIP_SUMMARY: skipped=${skippedCount} errors=${errorsCount}\n`); } catch {}
      updateSkipStats();
      emitEvent(progressCallback, opts, {
        type: "summary",
        skippedCount,
        errorsCount,
        lastLogKey: "log.skipSummary",
        lastLogVars: { skipped: skippedCount, errors: errorsCount }
      });

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        return reject(new Error("CANCELED"));
      }
      if (code === null && /terminated|killed|aborted|SIGTERM|SIGKILL/i.test(stderrBuf)) {
        return reject(new Error("CANCELED"));
      }

      if (isPlaylist || isAutomix) {
        const playlistDir = path.join(tempDir, jobId);
        const files = getDownloadedFiles(playlistDir, true);
        if (files.length > 0) {
          const declaredTotal =
            (Array.isArray(playlistItems) && playlistItems.length)
              ? playlistItems.length
              : (seenTotal || files.length);
          const finalSkipped = Math.max(0, declaredTotal - files.length);
          if (finalSkipped !== skippedCount) {
            skippedCount = finalSkipped;
            updateSkipStats();
          }
          if (progressCallback) progressCallback(100);
          return resolve(files);
        }

        if (code !== 0) {
          const tail = stderrBuf.split("\n").slice(-20).join("\n");
          return reject(new Error(`yt-dlp error: ${code}\n${tail}`));
        }
        return reject(new Error("Download appears successful but output file was not found"));
      } else {
        const files = getDownloadedFiles(tempDir, false, jobId);
        if (files.length > 0) {
          if (progressCallback) progressCallback(100);
          return resolve(files[0]);
        }
        if (code !== 0) {
          const tail = stderrBuf.split("\n").slice(-20).join("\n");
          return reject(new Error(`yt-dlp error: ${code}\n${tail}`));
        }
        return reject(new Error("Download appears successful but output file was not found"));
      }
    });

    child.on("error", (err) => {
      clearInterval(cancelTick);
      reject(new Error(`yt-dlp failed to start: ${err.message}`));
    });
  });
}

// Returns downloaded files used for the yt-dlp YouTube download pipeline.
function getDownloadedFiles(directory, isPlaylist = false, jobId = null) {
  if (!fs.existsSync(directory)) return [];

  const audioVideoExtensions = /\.(mp4|webm|m4a|mp3|opus|mkv|mka|flac|wav|aac|ogg)$/i;

  let files = fs.readdirSync(directory)
    .filter(file => audioVideoExtensions.test(file))
    .map(file => path.join(directory, file));

  if (isPlaylist) {
    files = files.sort((a, b) => {
      const aNum = parsePlaylistIndexFromPath(a) || 0;
      const bNum = parsePlaylistIndexFromPath(b) || 0;
      return aNum - bNum;
    });
    } else if (jobId) {
      const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escapeRe(jobId)}(?:\\.|\\s-\\s)`);
      files = files.filter(file => re.test(path.basename(file)));
    }
    return files;
}

// Parses playlist data index from path for the yt-dlp YouTube download pipeline.
export function parsePlaylistIndexFromPath(filePath) {
  const basename = path.basename(filePath);
  const noExt = basename.replace(/\.[A-Za-z0-9]+$/i, "");
  if (!noExt) return null;

  // Accept true index-based names:
  // "12.ext" or legacy "12 - title.ext"
  if (/^\d+$/.test(noExt)) return Number(noExt);
  const legacy = noExt.match(/^(\d+)\s*-\s+.+$/);
  return legacy ? Number(legacy[1]) : null;
}

// Builds entries map for the yt-dlp YouTube download pipeline.
export function buildEntriesMap(ytMetadata) {
  const map = new Map();
  const entries = Array.isArray(ytMetadata?.entries) ? ytMetadata.entries : [];

  entries.forEach(entry => {
    const index = Number(entry?.playlist_index ?? entry?.playlist?.index);
    if (Number.isFinite(index)) {
      map.set(index, entry);
    }
  });
  return map;
}

// Handles media probe data youtube music meta in the yt-dlp YouTube download pipeline.
export async function probeYoutubeMusicMeta(input) {
  const url = typeof input === "string" && !/^https?:\/\//i.test(input)
    ? `https://www.youtube.com/watch?v=${input}`
    : input;
  const data = await runYtJson([
    "--no-playlist",
    url
  ], "yt-music-probe", 20000);

  const d = Array.isArray(data?.entries) ? data.entries[0] : data;
  if (!d) return null;

  const artist = toNFC(d.artist || d.artist_uploader || d.uploader || d.channel || "");
  const track  = toNFC(d.track  || d.title || "");
  const album  = toNFC(d.album  || "");
  const year   = (d.release_year && String(d.release_year)) || "";
  const date   = d.release_date || d.upload_date || "";
  const cover  = (Array.isArray(d.thumbnails) && d.thumbnails.length
    ? d.thumbnails.at(-1).url : d.thumbnail || null);

  const out = {
    title: track || d.title || "",
    track: track || d.title || "",
    artist: artist || "",
    uploader: artist || d.uploader || "",
    album: album || "",
    album_artist: artist || "",
    release_year: year || (date ? String(date).slice(0,4) : ""),
    release_date: date || "",
    isrc: d.isrc || "",
    coverUrl: cover || "",
    webpage_url: d.webpage_url || d.original_url || url
  };

  if (!out.title && !out.artist) return null;
  return out;
}
