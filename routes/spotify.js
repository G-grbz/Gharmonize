import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { sendOk, sendError, uniqueId } from "../modules/utils.js";
import { idsToMusicUrls, mapSpotifyToYtm, downloadMatchedSpotifyTracks, createDownloadQueue } from "../modules/sp.js";
import { isSpotifyUrl, resolveSpotifyUrl, makeSpotify, parseSpotifyUrl, findSpotifyMetaByQuery } from "../modules/spotify.js";
import { spotifyMapTasks, spotifyDownloadTasks, jobs, killJobProcesses, createJob, registerJobProcess } from "../modules/store.js";
import { processJob } from "../modules/processor.js";
import { convertMedia, downloadThumbnail, retagMediaFile } from "../modules/media.js";
import archiver from "archiver";
import { resolveMarket } from "../modules/market.js";
import { isVideoFormat, processYouTubeVideoJob } from "../modules/video.js";

const router = express.Router();

const BASE_DIR   = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");
const TEMP_DIR   = path.resolve(BASE_DIR, "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

console.log("[spotify] BASE_DIR   =", BASE_DIR);
console.log("[spotify] OUTPUT_DIR =", OUTPUT_DIR);
console.log("[spotify] TEMP_DIR   =", TEMP_DIR);

function makeMapId() { return uniqueId("map"); }

function makeBgToken() {
  try { return crypto.randomBytes(8).toString("hex"); }
  catch { return String(Date.now()); }
}

function parseConcurrency(v, fallback = 4) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(16, Math.max(1, Math.round(n)));
}

function _liteTrackToItem(t) {
  if (!t) return null;
  const artist = (t.artists || []).map(a => a?.name).filter(Boolean).join(", ");
  const title = t.name || "";
  const album = t.album?.name || "";
  const releaseDate = t.album?.release_date || "";
  const year = releaseDate ? String(releaseDate).slice(0, 4) : "";
  const coverUrl = (t.album?.images || []).slice().sort((a,b)=> (b.width||0)-(a.width||0))[0]?.url || "";
  const spUrl = t.external_urls?.spotify || "";
  const isrc = t.external_ids?.isrc || "";
  return {
    title,
    artist,
    album,
    year,
    date: releaseDate,
    track_number: t.track_number || null,
    disc_number: t.disc_number || null,
    track_total: t.album?.total_tracks || null,
    disc_total: null,
    isrc,
    coverUrl,
    spUrl,
    album_artist: (t.album?.artists?.[0]?.name || artist || ""),
    label: "",
    copyright: "",
    genre: ""
  };
}

async function resolveSpotifyUrlLite(url, { market } = {}) {
  const { type, id } = parseSpotifyUrl(url);
  if (!id || type === "unknown") throw new Error("Unsupported Spotify URL");
  const api = await makeSpotify();
  const mkt = resolveMarket(market);

  if (type === "track") {
    const r = await api.getTrack(id, { ...(mkt ? { market: mkt } : {}) });
    const item = _liteTrackToItem(r?.body);
    if (!item) throw new Error("Track could not be fetched");
    return { kind: "track", title: `${item.artist} - ${item.title}`, items: [item] };
  }

  if (type === "playlist") {
    let plTitle = "Spotify Playlist";
    try {
      const pl = (await api.getPlaylist(id, { fields: "name" }))?.body;
      plTitle = pl?.name || plTitle;
    } catch {}

    const items = [];
    let page = await api.getPlaylistTracks(id, {
      limit: 100,
      ...(mkt ? { market: mkt } : {})
    });
    while (page) {
      for (const it of (page.body?.items || [])) {
        const t = it?.track;
        const item = _liteTrackToItem(t);
        if (item?.title && item?.artist) items.push(item);
      }
      const next = page.body?.next;
      if (!next) break;
      const u = new URL(next);
      const offset = Number(u.searchParams.get("offset") || 0);
      page = await api.getPlaylistTracks(id, {
        limit: 100,
        offset,
        ...(mkt ? { market: mkt } : {})
      });
    }
    return { kind: "playlist", title: plTitle, items };
  }

  if (type === "album") {
    const alb = (await api.getAlbum(id, { ...(mkt ? { market: mkt } : {}) }))?.body || null;
    const albumTitle = alb?.name || "Spotify Album";
    const albumArtist = alb?.artists?.[0]?.name || "";
    const coverUrl = (alb?.images || []).slice().sort((a,b)=> (b.width||0)-(a.width||0))[0]?.url || "";
    const releaseDate = alb?.release_date || "";
    const year = releaseDate ? String(releaseDate).slice(0,4) : "";
    const totalTracks = alb?.total_tracks || null;

    const items = [];
    let page = await api.getAlbumTracks(id, { limit: 50, ...(mkt ? { market: mkt } : {}) });
    while (page) {
      for (const t of (page.body?.items || [])) {
        const item = _liteTrackToItem({
          ...t,
          album: {
            name: albumTitle,
            artists: [{ name: albumArtist }],
            images: coverUrl ? [{ url: coverUrl, width: 9999, height: 9999 }] : [],
            release_date: releaseDate,
            total_tracks: totalTracks
          }
        });
        if (item?.title && item?.artist) items.push(item);
      }
      const next = page.body?.next;
      if (!next) break;
      const u = new URL(next);
      const offset = Number(u.searchParams.get("offset") || 0);
      page = await api.getAlbumTracks(id, { limit: 50, offset, ...(mkt ? { market: mkt } : {}) });
    }
    const title = albumArtist ? `${albumArtist} - ${albumTitle}` : albumTitle;
    return { kind: "playlist", title, items };
  }

  throw new Error("This type of Spotify URL is not supported yet");
}

router.post("/api/spotify/process/start", async (req, res) => {
  try {
    const {
      url,
      format = "mp3",
      bitrate = "192k",
      sampleRate = "48000",
      market: marketIn,
      includeLyrics,
      volumeGain,
      compressionLevel,
      bitDepth,
      videoSettings = {},
      spotifyConcurrency,
      autoCreateZip
    } = req.body || {};

   const autoCreateZipFlag =
     autoCreateZip === undefined
       ? true
       : (autoCreateZip === true || autoCreateZip === "true");

    console.log('[Spotify] UI sent spotifyConcurrency =', spotifyConcurrency);

    const volumeGainNum = volumeGain != null ? Number(volumeGain) : null;
    if (!url || !isSpotifyUrl(url)) return sendError(res, 'UNSUPPORTED_URL_FORMAT', "Spotify URL is required", 400);

    const effectiveSpotifyConcurrency = parseConcurrency(
      spotifyConcurrency,
      parseConcurrency(process.env.SPOTIFY_CONCURRENCY || 4, 4)
    );

    console.log('[Spotify] effectiveSpotifyConcurrency =', {
      effectiveSpotifyConcurrency
    });

    const bgToken = makeBgToken();
    const job = createJob({
    status: "queued",
    progress: 0,
    format,
    bitrate,
    sampleRate: parseInt(sampleRate) || 48000,
    volumeGain: volumeGainNum,
    compressionLevel: compressionLevel != null ? Number(compressionLevel) : null,
    bitDepth: bitDepth || null,
    videoSettings: (format === "mp4" || format === "mkv") ? videoSettings : null,
    metadata: {
      source: "spotify",
      spotifyUrl: url,
      spotifyKind: null,
      spotifyTitle: null,
      isPlaylist: true,
      isAlbum: false,
      isAutomix: false,
      includeLyrics: (includeLyrics === true || includeLyrics === "true"),
      volumeGain: volumeGainNum,
      compressionLevel: compressionLevel != null ? Number(compressionLevel) : null,
      bitDepth: bitDepth || null,
      autoCreateZip: autoCreateZipFlag,
      spotifyConcurrency: effectiveSpotifyConcurrency,
      bgToken
    },
        resultPath: null,
        error: null,
        playlist: { total: 0, done: 0 },
        phase: "mapping",
        currentPhase: "mapping",
        lastLogKey: "log.starting",
        lastLogVars: {},
        lastLog: "⏳ Starting Spotify job..."
      });
      const jobId = job.id;

      sendOk(res, {
        jobId,
        id: jobId,
        title: "-",
        total: 0,
        message: "Spotify processing started"
      });

      setImmediate(async () => {
        const j = jobs.get(jobId);
        if (!j) return;
        if (j.metadata?.bgToken !== bgToken) return;

        try {
          let sp;
          try {
            sp = await resolveSpotifyUrlLite(url, { market: resolveMarket(marketIn) });
          } catch (e) {
            const msg = String(e?.message || "");
            if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
              j.status = "error";
              j.error = "SPOTIFY_MIX_UNSUPPORTED";
              j.phase = "error"; j.currentPhase = "error";
              j.lastLogKey = "SPOTIFY_MIX_UNSUPPORTED";
              j.lastLogVars = {};
              j.lastLog = "❌ Spotify Mix unsupported (404). Copy tracks to a normal playlist and retry.";
              return;
            }
            throw e;
          }

          j.status = "running";
          j.metadata.spotifyKind  = sp.kind;
          j.metadata.spotifyTitle = sp.title;
          j.metadata.isPlaylist   = sp.kind === "playlist";
          j.metadata.isAlbum      = sp.kind === "album";
          j.playlist.total = sp.items?.length || 0;
          j.lastLogKey = "status.mappingStarted";
          j.lastLogVars = { title: sp.title, total: j.playlist.total };
          j.lastLog = `🔍 Mapping started: ${sp.title} (${j.playlist.total} track)`;

          await processSpotifyIntegrated(jobId, sp, format, bitrate, { market: marketIn });
        } catch (err) {
          const jj = jobs.get(jobId);
          if (!jj) return;
          jj.status = "error";
          jj.error = err?.message || String(err);
          jj.phase = "error"; jj.currentPhase = "error";
          jj.lastLogKey = "log.error";
          jj.lastLogVars = { err: jj.error };
          jj.lastLog = `❌ Error: ${jj.error}`;
          console.error("[spotify/process/start bg] error:", err);
        }
      });

    } catch (e) {
      return sendError(res, 'PROCESS_FAILED', e.message || "Spotify processing error", 400);
    }
});

function createLimiter(max) {
  let active = 0;
  const queue = [];

  const run = (fn) => new Promise((resolve, reject) => {
    const task = () => {
      active++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          active--;
          if (queue.length > 0) {
            const next = queue.shift();
            next();
          }
        });
    };

    if (active < max) {
      task();
    } else {
      queue.push(task);
    }
  });

  return run;
}

async function processSpotifyIntegrated(jobId, sp, format, bitrate, { market } = {}) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    const effectiveVolumeGain =
      job.metadata?.volumeGain != null
        ? job.metadata.volumeGain
        : (job.volumeGain != null ? job.volumeGain : null);

    job.phase = "mapping";
    job.currentPhase = "mapping";
    job.progress = 5;
    job.downloadProgress = 0;
    job.convertProgress = 0;
    job.metadata.selectedIds   = job.metadata.selectedIds   || [];
    job.metadata.frozenEntries = job.metadata.frozenEntries || [];
    job.metadata.frozenTitle   = job.metadata.frozenTitle   || job.metadata.spotifyTitle;

    const isVideoFormatFlag = isVideoFormat(format);

    let matchedCount = 0;
    const totalItems = sp.items.length;

    job.playlist.total = totalItems;
    job.playlist.done = 0;
    job.playlist.downloaded = 0;
    job.playlist.converted = 0;
    job.playlist.downloadTotal = 0;
    job.playlist.convertTotal = 0;

    const shouldCancel = () => {
    const j = jobs.get(jobId);
    return !!(j && (j.canceled || j.status === "canceled"));
  };

  const isCanceledError = (err) =>
    String(err?.message || "").toUpperCase() === "CANCELED";

    const parallel = Math.max(
      1,
      Math.min(
        16,
        Number(job.metadata?.spotifyConcurrency || process.env.SPOTIFY_CONCURRENCY || 4)
      )
    );

    console.log(`[Spotify ${jobId}] download/convert parallel =`, parallel);

    const results = new Array(totalItems);
    const allFiles = [];
    const convertPromises = [];
    const runLimitedConvert = createLimiter(parallel);
    const richMetaByIndex = new Map();
    const outputAbsByIndex = new Map();
    const runMetaLimited = createLimiter(Math.max(1, Math.min(8, Math.floor(parallel * 2))));
    const mktResolved = resolveMarket(market);

    (async () => {
      try {
        for (let i = 0; i < totalItems; i++) {
          if (shouldCancel()) break;
          const itemLite = sp.items[i];
          const logicalIndex = i;
          runMetaLimited(async () => {
            if (shouldCancel()) return;
            let rich = null;
            try {
              rich = await findSpotifyMetaByQuery(itemLite.artist, itemLite.title, mktResolved);
            } catch {}
            if (!rich) return;

            richMetaByIndex.set(logicalIndex, rich);

            const baseMeta = {
              title: itemLite.title,
              track: itemLite.title,
              artist: itemLite.artist,
              uploader: itemLite.artist,
              album: itemLite.album || "",
              album_artist: itemLite.album_artist || itemLite.artist,
              track_number: itemLite.track_number ?? null,
              disc_number: itemLite.disc_number ?? null,
              track_total: itemLite.track_total ?? null,
              disc_total: itemLite.disc_total ?? null,
              isrc: itemLite.isrc || "",
              release_year: itemLite.year || "",
              release_date: itemLite.date || "",
              webpage_url: itemLite.spUrl || "",
              genre: itemLite.genre || "",
              label: itemLite.label || "",
              publisher: itemLite.label || "",
              copyright: itemLite.copyright || ""
            };

            const merged = { ...baseMeta };
            for (const [k, v] of Object.entries(rich || {})) {
              if (v == null) continue;
              if (typeof v === "string" && !v.trim()) continue;
              merged[k] = v;
            }

            const abs = outputAbsByIndex.get(logicalIndex);
            if (abs && fs.existsSync(abs)) {
              retagMediaFile(
                abs,
                format,
               {
                  ...merged,
                  playlist_title: job.metadata.spotifyTitle,
                  webpage_url: merged.webpage_url || rich.webpage_url || itemLite.spUrl || ""
                },
                null,
                { jobId, tempDir: TEMP_DIR }
              ).catch(() => {});
            }
          }).catch(()=>{});
        }
      } catch {}
    })();

    const convertDownloadedItem = async (dlResult, idxZeroBased) => {
      if (shouldCancel()) {
        console.log(`[Spotify ${jobId}] convertDownloadedItem → canceled before start, skipping`);
        return;
      }

      const filePath = dlResult.filePath;
      const entry = dlResult.item;
      const logicalIndex = (dlResult.index != null ? dlResult.index - 1 : idxZeroBased);

      let spInfo = null;
      if (Array.isArray(sp.items) && sp.items.length) {
        spInfo = sp.items.find(x =>
          x.title?.toLowerCase() === entry.title?.toLowerCase() &&
          (x.artist || "").toLowerCase().includes((entry.uploader || "").toLowerCase())
        ) || null;
      }

      const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";
      const richNow = richMetaByIndex.get(logicalIndex) || null;
      const fileMeta = (preferSpotify && (richNow || spInfo)) ? {
        title: (richNow?.title || spInfo?.title || entry.title),
        track: (richNow?.title || spInfo?.title || entry.title),
        artist: (richNow?.artist || spInfo?.artist || entry.uploader),
        uploader: (richNow?.artist || spInfo?.artist || entry.uploader),
        album: (richNow?.album || spInfo?.album || ""),
        playlist_title: job.metadata.spotifyTitle,
        webpage_url: (richNow?.webpage_url || richNow?.spUrl || spInfo?.spUrl || entry.webpage_url),
        release_year: (richNow?.release_year || spInfo?.year || ""),
        release_date: (richNow?.release_date || spInfo?.date || ""),
        track_number: (richNow?.track_number ?? spInfo?.track_number),
        disc_number:  (richNow?.disc_number ?? spInfo?.disc_number),
        track_total:  (richNow?.track_total ?? spInfo?.track_total),
        disc_total:   (richNow?.disc_total ?? spInfo?.disc_total),
        isrc:         (richNow?.isrc || spInfo?.isrc || ""),
        album_artist: (richNow?.album_artist || spInfo?.album_artist || ""),
        genre:        (richNow?.genre || spInfo?.genre || ""),
        label:        (richNow?.label || spInfo?.label || ""),
        publisher:    (richNow?.publisher || richNow?.label || spInfo?.label || ""),
        copyright:    (richNow?.copyright || spInfo?.copyright || "")
      } : {
        title: entry.title,
        track: entry.title,
        uploader: entry.uploader,
        artist: entry.uploader,
        album: job.metadata.spotifyTitle,
        playlist_title: job.metadata.spotifyTitle,
        webpage_url: entry.webpage_url
      };

      let itemCover = null;
      const baseNoExt = filePath.replace(/\.[^.]+$/, "");
      const coverExts = [".jpg", ".jpeg", ".png", ".webp"];
      for (const ext of coverExts) {
        const cand = `${baseNoExt}${ext}`;
        if (fs.existsSync(cand)) { itemCover = cand; break; }
      }
      if (!itemCover && preferSpotify && spInfo?.coverUrl) {
        try {
          const dl = await downloadThumbnail(spInfo.coverUrl, `${baseNoExt}.spotify_cover`);
          if (dl) itemCover = dl;
        } catch {}
      }

      try {
        if (shouldCancel()) { throw new Error("CANCELED"); }
        if (job.phase !== "converting") {
          job.phase = "converting";
          job.currentPhase = "converting";
          job.progress = Math.max(job.progress, 70);
          job.downloadProgress = Math.max(job.downloadProgress || 0, 100);
          job.convertProgress = job.convertProgress || 0;
          job.playlist.total = job.playlist.total || totalItems;
          job.playlist.done = job.playlist.done || 0;
          job.lastLogKey = 'log.converting.batch';
          job.lastLogVars = { total: job.playlist.total };
          job.lastLog = `⚙️ Converting ${job.playlist.total} track(s)...`;
        }

        job.lastLogKey = 'log.converting.single';
        job.lastLogVars = { title: entry.title };
        job.lastLog = `⚙️ Converting: ${entry.title}`;

        const result = await convertMedia(
          filePath, format, bitrate, `${jobId}_${logicalIndex}`,
          (progress) => {
            const totalForProgress = job.playlist.total || totalItems || 1;
            const fileProgress = (logicalIndex / totalForProgress) * 25;
            const cur = (progress / 100) * (25 / totalForProgress);
            job.convertProgress = Math.min(
              100,
              Math.floor(70 + fileProgress + cur)
            );
            job.progress = Math.floor((job.downloadProgress + job.convertProgress) / 2);
          },
          fileMeta,
          itemCover,
          (format === "mp4"),
          OUTPUT_DIR,
          TEMP_DIR,
          {
            onProcess: (child) => { try { registerJobProcess(jobId, child); } catch {} },
            includeLyrics: !!job.metadata.includeLyrics,
            sampleRate: job.sampleRate || 48000,
            volumeGain: job.metadata?.volumeGain ?? job.volumeGain ?? null,
            compressionLevel: job.metadata?.compressionLevel ?? job.compressionLevel ?? undefined,
            bitDepth: job.metadata?.bitDepth ?? job.bitDepth ?? undefined,
            onLyricsStats: (delta) => {
              if (!delta) return;
              const m = job.metadata || (job.metadata = {});
              const cur = m.lyricsStats || { found: 0, notFound: 0 };
              cur.found += Number(delta.found || 0);
              cur.notFound += Number(delta.notFound || 0);
              m.lyricsStats = cur;
            }
          }
        );

        if (job.metadata.includeLyrics) {
          if (result && result.lyricsPath) {
            job.lastLog = `🎼 Lyrics added: ${path.basename(result.lyricsPath)}`;
          } else {
            job.lastLog = `🎼 Lyrics not found: ${entry.title}`;
          }
        }

        results[logicalIndex] = result;

        try {
          if (result?.outputPath) {
            const abs = path.join(
              OUTPUT_DIR,
              decodeURIComponent(result.outputPath.replace("/download/", ""))
            );
            outputAbsByIndex.set(logicalIndex, abs);
          }
        } catch {}

        try {
          const abs = outputAbsByIndex.get(logicalIndex);
          const rich = richMetaByIndex.get(logicalIndex);
          if (abs && rich && fs.existsSync(abs)) {
            retagMediaFile(
              abs,
              format,
              { ...rich, playlist_title: job.metadata.spotifyTitle },
              null,
              { jobId, tempDir: TEMP_DIR }
            ).catch(()=>{});
          }
        } catch {}

        job.lastLogKey = 'log.converting.ok';
        job.lastLogVars = { title: entry.title };
        job.lastLog = `✅ Converted: ${entry.title}`;
      } catch (convertError) {
        if (isCanceledError(convertError)) {
          console.log(`[Spotify ${jobId}] Conversion canceled for: ${entry.title}`);
          return;
        }

        console.error(`Conversion error (${entry.title}):`, convertError);
        job.lastLogKey = 'log.converting.err';
        job.lastLogVars = { title: entry.title, err: convertError.message };
        job.lastLog = `❌ Conversion error: ${entry.title} - ${convertError.message}`;
        results[logicalIndex] = { outputPath: null, error: convertError.message };
      } finally {
        job.playlist.converted = (job.playlist.converted || 0) + 1;
        job.playlist.done = job.playlist.converted;
      }
    };

    const dlQueue = !isVideoFormatFlag
      ? createDownloadQueue(jobId, {
          concurrency: parallel,
          onProgress: (done, _queueTotal) => {
          job.playlist.downloaded = done;
          job.downloadProgress = Math.floor((done / Math.max(1, totalItems)) * 100);
          job.lastLogKey = 'log.downloading.progress';
          job.lastLogVars = { done, total: totalItems };
          job.lastLog = `📥 Downloading: ${done}/${totalItems}`;

          const dlPct = totalItems > 0 ? (done / totalItems) : 0;
          if (job.phase === "downloading") {
            job.progress = Math.max(job.progress, Math.floor(30 + dlPct * 40));
          }
        },
          onLog: (payload) => {
            const { logKey, logVars, fallback } =
              (typeof payload === 'string')
                ? { logKey: null, logVars: null, fallback: payload }
                : payload;
            job.lastLogKey  = logKey || null;
            job.lastLogVars = logVars || null;
            job.lastLog     = fallback || '';
            console.log(`[Spotify ${jobId}] ${fallback || job.lastLogKey || ''}`);
          },
          shouldCancel,
          onItemDone: (dlResult, idx) => {
            if (!dlResult || !dlResult.filePath) return;
            if (shouldCancel()) {
              console.log(`[Spotify ${jobId}] onItemDone → job canceled, skipping convert enqueue`);
              return;
            }

            allFiles.push(dlResult.filePath);

            const p = runLimitedConvert(() => convertDownloadedItem(dlResult, idx))
              .catch(err => {
                if (!isCanceledError(err)) {
                  console.error(`[Spotify ${jobId}] convert pipeline error:`, err);
                }
              });

            convertPromises.push(p);
          }
        })
      : null;
    await mapSpotifyToYtm(
      sp,
      (idx, item) => {
        if (shouldCancel()) return;

        job.progress = 5 + Math.floor(((idx + 1) / totalItems) * 25);
        job.lastLogKey = 'log.searchingTrack';
        job.lastLogVars = { artist: item.uploader, title: item.title };
        job.lastLog = `🔍 Searching: ${item.uploader} - ${item.title}`;

        if (item.id) {
          matchedCount++;
          job.metadata.selectedIds.push(item.id);
          job.metadata.frozenEntries.push({
            index: item.index,
            id: item.id,
            title: item.title,
            uploader: item.uploader,
            webpage_url: item.webpage_url
          });

          if (dlQueue) {
            dlQueue.enqueue(
              {
                index: item.index,
                id: item.id,
                title: item.title,
                uploader: item.uploader,
                webpage_url: item.webpage_url
              },
              idx
            );
          }
        }
      },
      {
        concurrency: parallel,
        shouldCancel,
        onLog: (payload) => {
          const { logKey, logVars, fallback } =
            (typeof payload === 'string')
              ? { logKey: null, logVars: null, fallback: payload }
              : payload;
          job.lastLogKey  = logKey || null;
          job.lastLogVars = logVars || null;
          job.lastLog     = fallback || '';
          console.log(`[Spotify ${jobId}] ${fallback || job.lastLogKey || ''}`);
        }
      }
    );

    if (shouldCancel()) { throw new Error("CANCELED"); }

    if (matchedCount === 0) {
      throw new Error("No matching tracks found");
    }

    job.playlist.downloadTotal = matchedCount;
    job.playlist.convertTotal  = matchedCount;

    if (isVideoFormatFlag && job.metadata?.source === "spotify") {
      console.log(`🎬 Redirecting Spotify to video processing: ${matchedCount} track(s)`);

      const trackCount = matchedCount;
      const playlistTitle = job.metadata.spotifyTitle || "Spotify Playlist";

      job.lastLogKey = 'log.spotify.videoProcessing';
      job.lastLogVars = {
        title: playlistTitle,
        count: trackCount
      };
      job.lastLog = `🎬 Starting Spotify video processing: ${playlistTitle} (${trackCount} track(s))`;

      await processYouTubeVideoJob(job, { OUTPUT_DIR, TEMP_DIR });

      try {
        if (Array.isArray(job.resultPath) && job.resultPath.length > 1 && !job.clientBatch) {
          const titleHint = job.metadata?.spotifyTitle || "Spotify Playlist";
          job.zipPath = await makeZipFromOutputs(
            jobId,
            job.resultPath,
            titleHint || "playlist",
            job.metadata?.includeLyrics
          );
        }
      } catch {}

      cleanupSpotifyTempFiles(jobId, null, null);
      return;
    }

    dlQueue.end();
    job.phase = "downloading";
    job.currentPhase = "downloading";
    job.lastLogKey = 'log.downloading.waitAll';
    job.lastLogVars = {};
    job.lastLog = `⏳ Matching completed. Starting download + convert pipeline...`;

    await dlQueue.waitForIdle();
    if (shouldCancel()) { throw new Error("CANCELED"); }

    await Promise.all(convertPromises);
    if (shouldCancel()) { throw new Error("CANCELED"); }

    if (job.metadata.includeLyrics && job.metadata.lyricsStats) {
      const stats = job.metadata.lyricsStats;
      job.lastLog = `📊 Lyrics summary: ${stats.found} found, ${stats.notFound} not found`;
    }

    const successfulResults = results.filter(r => r && r.outputPath && !r.error);
    if (!successfulResults.length) {
      throw new Error("No tracks could be converted");
    }

    job.resultPath = successfulResults;

    if (job.metadata?.autoCreateZip) {
      try {
        const zipTitle = job.metadata.spotifyTitle || "Spotify Playlist";
        job.lastLogKey = 'log.zip.creating';
        job.lastLogVars = {};
        job.lastLog = `📦 Creating ZIP file...`;
        job.zipPath = await makeZipFromOutputs(jobId, successfulResults, zipTitle, !!job.metadata.includeLyrics);
        job.lastLogKey = 'log.zip.ready';
        job.lastLogVars = { title: zipTitle };
        job.lastLog = `✅ ZIP file is ready: ${zipTitle}`;
      } catch (e) {
        console.warn("ZIP creation error:", e);
        job.lastLogKey = 'log.zip.error';
        job.lastLogVars = { err: e.message };
        job.lastLog = `❌ ZIP creation error: ${e.message}`;
      }
    } else {
    }

    job.status = "completed";
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.phase = "completed";
    job.currentPhase = "completed";
    job.lastLogKey = 'log.done';
    job.lastLogVars = { ok: successfulResults.length };
    job.lastLog = `🎉 All operations completed! ${successfulResults.length} track(s) converted successfully.`;

    cleanupSpotifyTempFiles(jobId, allFiles);

  } catch (error) {
    if (String(error?.message || "").toUpperCase() === "CANCELED") {
      job.status = "canceled";
      job.error = null;
      job.phase = "canceled"; job.currentPhase = "canceled";
      job.downloadProgress = 0;
      job.convertProgress = 0;
      job.lastLogKey = 'status.canceled';
      job.lastLogVars = {};
      job.lastLog = "⛔ Canceled";
      try { killJobProcesses(jobId); } catch {}
      try { cleanupSpotifyTempFiles(jobId); } catch {}
    } else {
      job.status = "error";
      job.error = error.message;
      job.phase = "error"; job.currentPhase = "error";
      job.downloadProgress = 0;
      job.convertProgress = 0;
      job.lastLogKey = 'log.error';
      job.lastLogVars = { err: error.message };
      job.lastLog = `❌ Error: ${error.message}`;
      console.error("Spotify integrated processing error:", error);
    }
  }
}

async function processSingleTrack(jobId, sp, format, bitrate) {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    job.phase = "mapping"; job.currentPhase = "mapping";
    job.progress = 10;
    job.lastLogKey = 'log.searchingSingleTrack';
    job.lastLogVars = { artist: sp.items[0]?.artist, title: sp.items[0]?.title };
    job.lastLog = `🔍 Searching: ${sp.items[0]?.artist} - ${sp.items[0]?.title}`;

    let matchedItem = null;
    const shouldCancel = () => {
      const j = jobs.get(jobId);
      return !!(j && (j.canceled || j.status === "canceled"));
    };

    await mapSpotifyToYtm(sp, (idx, item) => {
      if (shouldCancel()) return;
      if (item.id) {
        matchedItem = item;
        job.metadata.selectedIds = [item.id];
        job.metadata.frozenEntries = [{
          index: 1,
          id: item.id,
          title: item.title,
          uploader: item.uploader,
          webpage_url: item.webpage_url
        }];
      }
    }, {
      concurrency: 1,
      shouldCancel,
      onLog: (payload) => {
        const { logKey, logVars, fallback } = (typeof payload === 'string')
          ? { logKey: null, logVars: null, fallback: payload }
          : payload;
        job.lastLogKey = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog = fallback || '';
      }
    });

    if (shouldCancel()) { throw new Error("CANCELED"); }
    if (!matchedItem) {
      throw new Error("Track could not be matched");
    }

    job.phase = "downloading"; job.currentPhase = "downloading";
    job.progress = 30;
    job.lastLogKey = 'log.downloading.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `📥 Downloading: ${matchedItem.title}`;

    const dlQueue = createDownloadQueue(jobId, {
      concurrency: 1,
      shouldCancel,
      onProgress: (done, total) => {
        job.playlist.done = done;
        job.progress = 30 + (done * 40);
      },
      onLog: (payload) => {
        const { logKey, logVars, fallback } = (typeof payload === 'string')
          ? { logKey: null, logVars: null, fallback: payload }
          : payload;
        job.lastLogKey = logKey || null;
        job.lastLogVars = logVars || null;
        job.lastLog = fallback || '';
      }
    });

    dlQueue.enqueue({
      index: 1,
      id: matchedItem.id,
      title: matchedItem.title,
      uploader: matchedItem.uploader,
      webpage_url: matchedItem.webpage_url
    }, 0);
    dlQueue.end();
    await dlQueue.waitForIdle();
    if (shouldCancel()) { throw new Error("CANCELED"); }

    const downloadResults = dlQueue.getResults();
    const successfulDownload = downloadResults.find(r => r.filePath);

    if (!successfulDownload) {
      const firstErr = downloadResults.find(r => r?.error)?.error || "unknown download error";
      job.lastLogKey  = 'log.downloading.err';
      job.lastLogVars = { err: firstErr };
      job.lastLog     = `❌ Download error: ${firstErr}`;
      throw new Error(`Track could not be downloaded: ${firstErr}`);
    }

    job.phase = "converting"; job.currentPhase = "converting";
    job.progress = 80;
    job.lastLogKey = 'log.converting.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `⚙️ Converting: ${matchedItem.title}`;

    const filePath = successfulDownload.filePath;
    const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";
    const spInfo = sp.items[0];

    const fileMeta = preferSpotify ? {
      title: spInfo.title,
      track: spInfo.title,
      artist: spInfo.artist,
      uploader: spInfo.artist,
      album: spInfo.album || "",
      webpage_url: spInfo.spUrl || matchedItem.webpage_url,
      release_year: spInfo.year || "",
      release_date: spInfo.date || "",
      track_number: spInfo.track_number,
      disc_number: spInfo.disc_number,
      track_total: spInfo.track_total,
      disc_total: spInfo.disc_total,
      isrc: spInfo.isrc,
      album_artist: spInfo.album_artist || "",
      genre:        spInfo.genre || "",
      label:        spInfo.label || "",
      publisher:    spInfo.label || "",
      copyright:    spInfo.copyright || ""
    } : {
      title: matchedItem.title,
      track: matchedItem.title,
      uploader: matchedItem.uploader,
      artist: matchedItem.uploader,
      webpage_url: matchedItem.webpage_url
    };

    let itemCover = null;
    const baseNoExt = filePath.replace(/\.[^.]+$/, "");
    const coverExts = [".jpg", ".jpeg", ".png", ".webp"];
    for (const ext of coverExts) {
      const cand = `${baseNoExt}${ext}`;
      if (fs.existsSync(cand)) { itemCover = cand; break; }
    }
    if (!itemCover && preferSpotify && spInfo?.coverUrl) {
      try {
        const dl = await downloadThumbnail(spInfo.coverUrl, `${baseNoExt}.spotify_cover`);
        if (dl) itemCover = dl;
      } catch {}
    }

    const result = await convertMedia(
      filePath, format, bitrate, jobId,
      (progress) => {
        job.progress = 80 + Math.floor(progress * 0.2);
      },
      fileMeta, itemCover, (format === "mp4"),
      OUTPUT_DIR,
      TEMP_DIR,
      {
        onProcess: (child) => { try { registerJobProcess(jobId, child); } catch {} },
        includeLyrics: !!job.metadata.includeLyrics,
        sampleRate: job.sampleRate || 48000,
        volumeGain: job.metadata?.volumeGain ?? job.volumeGain ?? null,
        compressionLevel: job.metadata?.compressionLevel ?? job.compressionLevel ?? undefined,
        bitDepth: job.metadata?.bitDepth ?? job.bitDepth ?? undefined,
        onLyricsStats: (delta) => {
          if (!delta) return;
          const m = job.metadata || (job.metadata = {});
          const cur = m.lyricsStats || { found: 0, notFound: 0 };
          cur.found += Number(delta.found || 0);
          cur.notFound += Number(delta.notFound || 0);
          m.lyricsStats = cur;
        }
      }
    );

    job.resultPath = result;
    job.status = "completed";
    job.progress = 100;
    job.phase = "completed"; job.currentPhase = "completed";
    job.playlist.done = 1;
    job.lastLogKey = 'log.done.single';
    job.lastLogVars = { title: matchedItem.title };
    job.lastLog = `🎉 Processing completed: ${matchedItem.title}`;

    cleanupSpotifyTempFiles(jobId, [filePath]);

  } catch (error) {
    if (String(error?.message || "").toUpperCase() === "CANCELED") {
      job.status = "canceled";
      job.error = null;
      job.phase = "canceled"; job.currentPhase = "canceled";
      job.lastLogKey = 'status.canceled';
      job.lastLogVars = {};
      job.lastLog = "⛔ Canceled";
      try { killJobProcesses(jobId); } catch {}
      try { cleanupSpotifyTempFiles(jobId); } catch {}
    } else {
      job.status = "error";
      job.error = error.message;
      job.phase = "error"; job.currentPhase = "error";
      job.lastLogKey = 'log.error';
      job.lastLogVars = { err: error.message };
      job.lastLog = `❌ Error: ${error.message}`;
      console.error("Single track processing error:", error);
    }
  }
}

async function makeZipFromOutputs(jobId, outputs, titleHint = "playlist", includeLyrics = false) {
  const outDir = OUTPUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const safeBase = `${(titleHint || 'playlist')}_${jobId}`
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .slice(0, 200);

  const zipName = `${safeBase}.zip`;
  const zipAbs  = path.join(outDir, zipName);

  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(zipAbs);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve(`/download/${encodeURIComponent(zipName)}`));
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    for (const r of outputs) {
      if (!r?.outputPath) continue;
      const rel = decodeURIComponent(r.outputPath.replace(/^\/download\//, ""));
      const abs = path.join(outDir, rel);
      if (fs.existsSync(abs)) {
        archive.file(abs, { name: path.basename(abs).normalize("NFC") });
        if (includeLyrics) {
          const lrcPath = abs.replace(/\.[^/.]+$/, "") + ".lrc";
          if (fs.existsSync(lrcPath)) {
            archive.file(lrcPath, { name: path.basename(lrcPath).normalize("NFC") });
          }
        }
      }
    }
    archive.finalize();
  });
}

function cleanupSpotifyTempFiles(jobId, files) {
  try {
    if (Array.isArray(files)) {
      files.forEach(f => {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
      });
    }

    const jobDir = path.join(TEMP_DIR, jobId);
    if (fs.existsSync(jobDir)) {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
    }
  } catch (e) {
    console.warn("Cleanup error:", e);
  }
}

router.post("/api/spotify/preview/start", async (req, res) => {
  try {
    const { url, market: marketIn } = req.body || {};
    if (!url || !isSpotifyUrl(url)) return sendError(res, 'UNSUPPORTED_URL_FORMAT', "Spotify URL is required", 400);

    let sp;
    try {
      sp = await resolveSpotifyUrl(url, { market: resolveMarket(marketIn) });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
        return sendError(
          res,
          'SPOTIFY_MIX_UNSUPPORTED',
          "This link is a personalized Spotify Mix. The Spotify Web API cannot provide this content (404). Please copy the tracks from the Mix into a new playlist in the Spotify app and send that playlist URL instead.",
          400
        );
      }
      throw e;
    }
    const id = makeMapId();
    const task = {
      id,
      url,
      status: "running",
      title: sp.title || (sp.kind === "track" ? "Spotify Track" : "Spotify Playlist"),
      total: (sp.items || []).length,
      done: 0,
      items: [],
      logs: [],
      createdAt: new Date(),
      validItems: [],
      jobId: null
    };
    spotifyMapTasks.set(id, task);

    mapSpotifyToYtm(sp, (idx, item) => {
      task.items[idx] = item;
      task.done++;
      if (item.id) task.validItems.push(item);
    }, {
      concurrency: Number(process.env.SPOTIFY_MAP_CONCURRENCY || 3),
      onLog: (log) => { task.logs.push({ time: new Date(), message: log }); console.log(`[Spotify ${id}] ${log}`); }
    }).then(() => {
      task.status = "completed";
      if (task.validItems.length > 0) {
        const urls = idsToMusicUrls(task.validItems.map(i => i.id));
        fs.mkdirSync(TEMP_DIR, { recursive: true });
        const listFile = path.join(TEMP_DIR, `${task.id}.urls.txt`);
        fs.writeFileSync(listFile, urls.join("\n"), "utf8");
        task.urlListFile = listFile;
        console.log(`✅ Spotify URL list created: ${listFile}`);
      }
    }).catch((e) => { task.status = "error"; task.error = e.message; });

    return sendOk(res, { mapId: id, title: task.title, total: task.total });
  } catch (e) {
    return sendError(res, 'PREVIEW_FAILED', e.message || "Spotify start error", 400);
  }
});

router.get("/api/spotify/preview/stream/:id", (req, res) => {
  const { id } = req.params || {};
  const task = spotifyMapTasks.get(id);
  if (!task) return sendError(res, 'JOB_NOT_FOUND', "Map task not found", 404);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "init", title: task.title, total: task.total, done: task.done, items: task.items || [] });
  let lastSent = task.items.length;
  const interval = setInterval(() => {
    while (lastSent < task.items.length) { const item = task.items[lastSent]; if (item) send({ type: "item", item }); lastSent++; }
    send({ type: "progress", done: task.done, total: task.total, status: task.status });
    if (task.status === "completed" || task.status === "error") { send({ type: "done", status: task.status, error: task.error || null }); clearInterval(interval); res.end(); }
  }, 800);
  req.on("close", () => clearInterval(interval));
});

router.get("/api/spotify/preview/stream-logs/:id", (req, res) => {
  const { id } = req.params || {};
  const task = spotifyMapTasks.get(id);
  if (!task) return sendError(res, 'JOB_NOT_FOUND', "Map task not found", 404);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: "init", title: task.title, total: task.total, done: task.done, items: task.items || [] });
  let lastSent = task.items.length;
  const interval = setInterval(() => {
    while (lastSent < task.items.length) {
      const item = task.items[lastSent];
      if (item) send({
        type: "item",
        item,
        logKey: "log.matchFound",
        logVars: { artist: item.uploader, title: item.title },
        log: `✅ Match found: ${item.uploader} - ${item.title}`
      });
      lastSent++;
    }
    send({ type: "progress", done: task.done, total: task.total, status: task.status });
    if (task.status === "completed" || task.status === "error") {
      send({
        type: "done",
        status: task.status,
        error: task.error || null,
        logKey: task.status === "completed" ? "status.allMatchesCompleted" : "log.error",
        logVars: task.status === "completed" ? {} : { err: task.error },
        log: task.status === "completed" ? "🎉 All matches completed!" : `❌ Error: ${task.error}`
      });
      clearInterval(interval); res.end();
    }
  }, 500);
  req.on("close", () => clearInterval(interval));
});

export default router;
