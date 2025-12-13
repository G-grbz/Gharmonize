import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { resolveYtDlp, withYT403Workarounds, YT_USE_MUSIC } from "./yt.js";
import { registerJobProcess } from "./store.js";
import crypto from "crypto";
import { getUserAgent, getYouTubeHeaders, addGeoArgs, getExtraArgs, FLAGS } from "./config.js";
import { addCookieArgs, getJsRuntimeArgs } from "./utils.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const TEMP_DIR = path.resolve(BASE_DIR, "temp");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const YT_SEARCH_RESULTS = Math.max(1, Math.min(10, Number(process.env.YT_SEARCH_RESULTS || 3)));
const YT_SEARCH_TIMEOUT_MS = Math.max(3000, Number(process.env.YT_SEARCH_TIMEOUT_MS || 20000));
const YT_SEARCH_STAGGER_MS = Math.max(0, Number(process.env.YT_SEARCH_STAGGER_MS || 140));
const _searchCache = new Map();
const _SEARCH_CACHE_MAX = 800;
function _cacheGet(k) { return _searchCache.has(k) ? _searchCache.get(k) : undefined; }
function _cacheSet(k, v) {
  _searchCache.set(k, v);
  if (_searchCache.size > _SEARCH_CACHE_MAX) {
    const first = _searchCache.keys().next().value;
    _searchCache.delete(first);
  }
}

export function makeMapId() {
  return crypto.randomBytes(8).toString("hex");
}

function getYtDlpSearchArgsLite() {
  const ua = getUserAgent();
  const headers = getYouTubeHeaders();
  const base = [
    "--no-progress",
    "--no-warnings",
    "--skip-download",
    "--flat-playlist",
    "--dump-single-json",
    "--retries", "2",
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

async function runYtJsonLite(urls, label = "ytm-search-lite", timeoutMs = YT_SEARCH_TIMEOUT_MS) {
  const YTDLP_BIN = resolveYtDlp();
  if (!YTDLP_BIN) throw new Error("yt-dlp not found");

  const args = withYT403Workarounds(
    [...getYtDlpSearchArgsLite(), ...(Array.isArray(urls) ? urls : [String(urls)])],
    { stripCookies: true }
  );

  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_BIN,
      args,
      { maxBuffer: 32 * 1024 * 1024, timeout: timeoutMs },
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

export async function searchYtmBestId(artist, title) {
  const q = `${artist} ${title}`.trim();
  const qNorm = q.toLowerCase().replace(/\s+/g, " ").trim();
  const cached = _cacheGet(qNorm);
  if (cached !== undefined) return cached;

  const data = await runYtJsonLite([`ytsearch${YT_SEARCH_RESULTS}:${q}`], "ytm-search-lite", YT_SEARCH_TIMEOUT_MS);
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (!entries.length) { _cacheSet(qNorm, null); return null; }
  const aLow = (artist || "").toLowerCase();
  for (const e of entries) {
    const vid = e?.id;
    const et = (e?.title || "").toLowerCase();
    const ch = (e?.uploader || e?.channel || "").toLowerCase();
    if (vid && (et.includes(aLow) || ch.includes(aLow))) { _cacheSet(qNorm, vid); return vid; }
  }
  const fallback = entries[0]?.id || null;
  _cacheSet(qNorm, fallback);
  return fallback;
}

export function idsToMusicUrls(ids, useMusic = YT_USE_MUSIC) {
  return ids.map((id) =>
    useMusic
      ? `https://music.youtube.com/watch?v=${id}`
      : `https://www.youtube.com/watch?v=${id}`
  );
}

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

export async function mapSpotifyToYtm(
  sp,
  onUpdate,
  { concurrency = 3, onLog = null, shouldCancel = null } = {}
) {
  let i = 0,
    running = 0;
  const results = new Array(sp.items.length);
  const useMusic = YT_USE_MUSIC;
  return new Promise((resolve) => {
    const kick = () => {
      if (shouldCancel && shouldCancel()) {
        return resolve(results);
      }
      while (running < concurrency && i < sp.items.length) {
        const idx = i++;
        running++;
        (async () => {
          const it = sp.items[idx];
          if (shouldCancel && shouldCancel()) {
            results[idx] = null;
            return;
          }

          if (YT_SEARCH_STAGGER_MS > 0) {
            const slot = idx % Math.max(1, concurrency);
            const jitter = Math.floor(Math.random() * 25);
            await sleep((slot * YT_SEARCH_STAGGER_MS) + jitter);
          }

          if (onLog)
            onLog({
              logKey: "log.searchingTrack",
              logVars: { artist: it.artist, title: it.title },
              fallback: `🔍 Searching: ${it.artist} - ${it.title}`,
            });
          let vid = null;
          try {
            vid = await searchYtmBestId(it.artist, it.title);
            if (onLog && vid)
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
          const item = {
            index: idx + 1,
            id: vid || null,
            title: it.title,
            uploader: it.artist,
            duration: null,
            duration_string: null,
            webpage_url: vid
              ? useMusic
                ? `https://music.youtube.com/watch?v=${vid}`
                : `https://www.youtube.com/watch?v=${vid}`
              : "",
            thumbnail: null,
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

export async function downloadSingleYouTubeVideo(url, fileId, downloadDir) {
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
    "--no-part",
    "--continue",
    "--no-overwrites",
    "--retries",
    "3",
    "--fragment-retries",
    "3",
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
    const child = execFile(
      YTDLP_BIN,
      finalArgs,
      { maxBuffer: 1024 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) {
          const p = findDownloaded();
          return p ? resolve(p) : reject(new Error("File downloaded but not found"));
        }

        const have = findDownloaded();
        if (have) return resolve(have);

        const stderrStr = String(stderr || "");
        const is403 = /403|Forbidden/i.test(stderrStr);
        const isMusic = /music\.youtube\.com/i.test(url);
        if (is403 && isMusic) {
          const fallbackUrl = url.replace(/music\.youtube\.com/i, "www.youtube.com");
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
          const child2 = execFile(
            YTDLP_BIN,
            retryArgs,
            { maxBuffer: 1024 * 1024 * 1024 },
            (err2, _so2, se2) => {
              if (!err2) {
                try {
                  const files = fs
                    .readdirSync(downloadDir)
                    .filter(
                      (f) =>
                        f.startsWith(`${fileId}.`) &&
                        /(\.(mp4|webm|m4a|mp3|opus|flac|wav|aac|ogg))$/i.test(f)
                    );
                  if (files.length > 0)
                    return resolve(path.join(downloadDir, files[0]));
                } catch {}
                return reject(new Error("File downloaded but not found"));
              }
              const tail2 = String(se2 || "")
                .split("\n")
                .slice(-10)
                .join("\n");
              return reject(
                new Error(
                  `yt-dlp error (fallback attempt): ${err2.code}\n${tail2}`
                )
              );
            }
          );
          try {
            registerJobProcess(String(fileId).split("_")[0], child2);
          } catch {}
        }

        const tail = stderrStr.split("\n").slice(-10).join("\n");
        return reject(new Error(`yt-dlp error: ${err.code}\n${tail}`));
      }
    );
    try {
      registerJobProcess(String(fileId).split("_")[0], child);
    } catch {}
  });
}

export function createDownloadQueue(
  jobId,
  { concurrency = 4, onProgress, onLog, shouldCancel, onItemDone } = {}
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
          downloadDir
        );

        const dlResult = {
          index: item.index,
          title: item.title,
          uploader: item.uploader,
          filePath,
          item,
        };

        results.push(dlResult);

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
        const dlResult = {
          index: item.index,
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
    enqueue(item, idxZeroBased) {
      total++;
      q.push({ item, idx: idxZeroBased });
      pump();
    },
    async waitForIdle() {
      if (running === 0 && q.length === 0) return;
      return new Promise((res) => {
        idleResolve = res;
      });
    },
    end() {
      ended = true;
      if (q.length === 0 && running === 0 && idleResolve) idleResolve();
    },
    getResults() {
      return results.sort((a, b) => a.index - b.index);
    },
  };
}
