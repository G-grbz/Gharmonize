import path from "path";
import fs from "fs";
import archiver from "archiver";
import { resolveId3StrictForYouTube } from "./tags.js";
import { resolveMarket } from "./market.js";
import { jobs, registerJobProcess, killJobProcesses } from "./store.js";
import { sanitizeFilename, toNFC, normalizeTitle } from "./utils.js";
import { processYouTubeVideoJob, qualityToHeight } from "./video.js";
import {
  isYouTubeAutomix,
  fetchYtMetadata,
  downloadYouTubeVideo,
  buildEntriesMap,
  parsePlaylistIndexFromPath
} from "./yt.js";
import { downloadThumbnail, convertMedia, maybeCleanTitle } from "./media.js";
import { buildId3FromYouTube } from "./tags.js";
import { probeYoutubeMusicMeta } from "./yt.js";
import { findSpotifyMetaByQuery } from "./spotify.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");
const TEMP_DIR = path.resolve(BASE_DIR, "temp");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

function clampInt(v, min, max) {
  v = Math.round(v || 0);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function cleanTitleLike(s) {
  if (!s) return s;
  let out = String(s);
  out = maybeCleanTitle(out);
  out = cleanNameDynamic(out);
  return out;
}

function applyGlobalMetaCleaning(meta) {
  if (!meta) return meta;
  const m = { ...meta };

  if (m.title) m.title = cleanTitleLike(m.title);
  if (m.track) m.track = cleanTitleLike(m.track);
  if (m.playlist_title) m.playlist_title = cleanTitleLike(m.playlist_title);
  if (m.artist) m.artist = cleanNameDynamic(m.artist);
  if (m.album_artist) m.album_artist = cleanNameDynamic(m.album_artist);
  if (m.uploader) m.uploader = cleanNameDynamic(m.uploader);
  return m;
}

function bump(obj, key, inc = 1) {
  obj[key] = (obj[key] || 0) + inc;
}

function cleanNameDynamic(name) {
  if (!name) return "";
  let s = String(name).trim().replace(/\s+/g, " ");

  const suffixes = (process.env.CLEAN_SUFFIXES || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  const phrases = (process.env.CLEAN_PHRASES || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  const parens = (process.env.CLEAN_PARENS || "")
    .split(",")
    .map(v => v.trim())
    .filter(Boolean);

  if (suffixes.length) {
    const sufRegex = new RegExp(`\\s*-\\s*(${suffixes.join("|")})\\s*$`, "i");
    s = s.replace(sufRegex, "");
  }

  if (suffixes.length) {
    const sufEndRegex = new RegExp(`\\s+(${suffixes.join("|")})\\s*$`, "i");
    s = s.replace(sufEndRegex, "");
  }

  if (phrases.length) {
    const phrRegex = new RegExp(
      `\\s*-?\\s*(${phrases.map(x => x.replace(/\s+/g, "\\s+")).join("|")})\\s*$`,
      "i"
    );
    s = s.replace(phrRegex, "");
  }

  if (parens.length) {
    const parRegex = new RegExp(
      `\\s*\\((${parens.join("|")})\\)\\s*$`,
      "i"
    );
    s = s.replace(parRegex, "");
  }
  return s.trim();
}

function mergeMeta(base, extra) {
  if (!extra) return base;
  for (const [k, v] of Object.entries(extra)) {
    if (v == null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (base[k] == null || base[k] === "") base[k] = v;
  }
  return base;
}

function isVideoFormat(fmt) {
  const f = String(fmt || "").toLowerCase();
  return f === "mp4" || f === "mkv";
}

function createLimiter(max) {
  let active = 0;
  const queue = [];

  const run = (fn) =>
    new Promise((resolve, reject) => {
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

export async function processJob(jobId, inputPath, format, bitrate) {
  try {
    killJobProcesses(jobId);
  } catch {}

  const job = jobs.get(jobId);
if (!job) return;

console.log("🧊 job.metadata.frozenEntries snapshot:",
  Array.isArray(job.metadata?.frozenEntries)
    ? { len: job.metadata.frozenEntries.length,
        sample: job.metadata.frozenEntries.slice(0, 3) }
    : job.metadata?.frozenEntries
);

  const selectedStreams = job.metadata?.selectedStreams || {};

  const effectiveVolumeGain =
    job.metadata?.volumeGain != null
      ? job.metadata.volumeGain
      : job.videoSettings?.volumeGain != null
      ? job.videoSettings.volumeGain
      : null;

  job.canceled = false;

  let skippedCount = 0;
  let errorsCount = 0;
  let lyricsFound = 0;
  let lyricsMiss = 0;

  const updateLyricsStatsLive = (doneCount = 0, totalCount = null) => {
    if (!job?.metadata?.includeLyrics) return;

    const usedDone = Math.max(0, Number(doneCount || 0));
    let foundSafe = Number(lyricsFound || 0);
    if (Number.isFinite(totalCount) && totalCount != null) {
      foundSafe = Math.min(foundSafe, Number(totalCount));
    }

    const notFoundLive = Math.max(0, usedDone - foundSafe);
    const prev = job.metadata.lyricsStats || { found: 0, notFound: 0 };
    const target = { found: foundSafe, notFound: notFoundLive };

    if (Number.isFinite(totalCount) && totalCount != null) {
      target.notFound = Math.max(
        notFoundLive,
        Math.max(0, Number(totalCount) - foundSafe)
      );
    }

    if (prev.found !== target.found || prev.notFound !== target.notFound) {
      job.metadata.lyricsStats = target;
    }
  };

  const handleSkipUpdate = (stats) => {
    skippedCount = stats.skippedCount || 0;
    errorsCount = stats.errorsCount || 0;
    job.skippedCount = skippedCount;
    job.errorsCount = errorsCount;
    job.metadata = job.metadata || {};
    job.metadata.skipStats = { skippedCount, errorsCount };
  };

  const handleLyricsLog = (_payload) => {};
  const handleLyricsStats = (delta) => {
    if (!delta) return;
    lyricsFound += Number(delta.found || 0);
    lyricsMiss += Number(delta.notFound || 0);
    job.metadata = job.metadata || {};
    const doneNow = (job.playlist && Number(job.playlist.done)) || 0;
    updateLyricsStatsLive(doneNow);
  };

  const sampleRate = job.sampleRate || 48000;

  try {
    job.status = "running";
    job.progress = 0;
    job.downloadProgress = 0;
    job.convertProgress = 0;
    job.currentPhase = "preparing";
    job.metadata = job.metadata || {};
    job.counters = job.counters || {
      dlTotal: 0,
      dlDone: 0,
      cvTotal: 0,
      cvDone: 0
    };
    const isVideoFormatFlag = isVideoFormat(format);

    if (isVideoFormatFlag && job.metadata?.source === "youtube") {
      await processYouTubeVideoJob(job, { OUTPUT_DIR, TEMP_DIR });

      try {
        if (
          Array.isArray(job.resultPath) &&
          job.resultPath.length > 1 &&
          !job.clientBatch &&
          format !== "mp4"
        ) {
          const titleHint =
            job.metadata?.frozenTitle ||
            job.metadata?.extracted?.title ||
            job.metadata?.extracted?.playlist_title ||
            (job.metadata?.isAutomix ? "YouTube Automix" : "Playlist");
          job.zipPath = await makeZipFromOutputs(
            jobId,
            job.resultPath,
            titleHint || "playlist",
            job.metadata?.includeLyrics
          );
        }
      } catch {}

      cleanupTempFiles(jobId, inputPath, null);
      return;
    }

    let actualInputPath = inputPath;
    let coverPath = null;

    if (job.metadata.source === "spotify") {
      job.currentPhase = "downloading";
      job.downloadProgress = 5;
      job.metadata.extracted = job.metadata.extracted || {
        title: toNFC(job.metadata.spotifyTitle || "Spotify Playlist"),
        uploader: "Spotify",
        playlist_title: toNFC(job.metadata.spotifyTitle || "Spotify Playlist")
      };

      const selectedIds = Array.isArray(job.metadata.selectedIds)
        ? job.metadata.selectedIds
        : [];
      if (!selectedIds.length) {
        throw new Error("Spotify URL list is empty");
      }

      job.counters = job.counters || {};
      job.counters.dlTotal = Number(selectedIds.length);
      job.counters.cvTotal = Number(selectedIds.length);
      job.counters.dlDone = job.counters.dlDone || 0;
      job.counters.cvDone = job.counters.cvDone || 0;

      const files = await downloadYouTubeVideo(
        job.metadata.spotifyTitle || "Spotify",
        jobId,
        true,
        null,
        false,
        selectedIds,
        TEMP_DIR,
        (progress) => {
          if (
            progress &&
            typeof progress === "object" &&
            progress.__event &&
            progress.type === "file-done"
          ) {
            const t = Number(
              progress.total ||
                job.counters?.dlTotal ||
                selectedIds.length ||
                0
            );
            job.counters.dlTotal = t;
            job.counters.dlDone = Math.min(
              t,
              Number(progress.downloaded || 0)
            );
            job.downloadProgress = Math.floor(
              (job.counters.dlDone / Math.max(1, t)) * 100
            );
          } else {
            job.downloadProgress = 20 + Number(progress || 0) * 0.8;
            const t = Number(
              job.counters?.dlTotal || selectedIds.length || 0
            );
            if (t > 0) {
              const approx = clampInt(
                ((Number(progress || 0) / 100) * t) | 0,
                0,
                t
              );
              if ((job.counters.dlDone || 0) < approx)
                job.counters.dlDone = approx;
            }
          }
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );
        },
        {
          video: isVideoFormat(format),
          onSkipUpdate: handleSkipUpdate,
          maxHeight: isVideoFormat(format)
            ? qualityToHeight(bitrate)
            : undefined
        },
        { isCanceled: () => !!job.canceled }
      );

      job.counters.dlDone = job.counters.dlTotal;
      job.downloadProgress = 100;
      job.currentPhase = "converting";
      job.convertProgress = 0;

      if (!Array.isArray(files) || !files.length) {
        throw new Error("Spotify download completed but no files were found");
      }

      const frozen = Array.isArray(job.metadata.frozenEntries)
        ? job.metadata.frozenEntries
        : [];
      const byId = new Map();
      for (const e of frozen) if (e?.id) byId.set(e.id, e);
      const sorted = files
        .map((fp, i) => ({ fp, auto: i + 1 }))
        .sort((a, b) => a.auto - b.auto);

      const spotifyConcurrency = job.metadata?.spotifyConcurrency || 4;
      const spotifyLimiter = createLimiter(spotifyConcurrency);

      const results = new Array(sorted.length);
      job.playlist = { total: sorted.length, done: 0 };
      job.counters.cvTotal = sorted.length;

      const convertPromisesSpotify = [];

      for (let i = 0; i < sorted.length; i++) {
        const convertPromise = spotifyLimiter(async () => {
          const { fp: filePath, auto } = sorted[i];
          const pinnedId = selectedIds[auto - 1];
          const entry = (pinnedId ? byId.get(pinnedId) : null) || {};
          const fallbackTitle = path
            .basename(filePath, path.extname(filePath))
            .replace(/^\d+\s*-\s*/, "");
          const title = toNFC(entry.title || fallbackTitle);
          const fileMeta = {
            title,
            track: title,
            uploader: entry.uploader || "",
            artist: entry.artist || entry.uploader || "",
            album: entry.album || "",
            album_artist:
              entry.album_artist || entry.artist || entry.uploader || "",
            playlist_title: job.metadata.spotifyTitle || "Spotify Playlist",
            webpage_url: entry.webpage_url || "",
            release_year: entry.year || "",
            release_date: entry.date || "",
            track_number: entry.track_number,
            disc_number: entry.disc_number,
            track_total: entry.track_total,
            disc_total: entry.disc_total,
            isrc: entry.isrc,
            genre: entry.genre || "",
            label: entry.label || null,
            publisher: entry.label || null,
            copyright: entry.copyright || ""
          };

          fileMeta = applyGlobalMetaCleaning(fileMeta);

          let itemCover = null;
          const baseNoExt = filePath.replace(/\.[^.]+$/, "");
          const sidecarJpg = `${baseNoExt}.jpg`;
          if (fs.existsSync(sidecarJpg)) itemCover = sidecarJpg;

          const existingOut = findExistingOutput(
            `${jobId}_${i}`,
            format,
            OUTPUT_DIR
          );
          let r;
          if (existingOut) {
            r = {
              outputPath: `/download/${encodeURIComponent(
                path.basename(existingOut)
              )}`
            };
            const fileProgress = (i / sorted.length) * 100;
            job.convertProgress = Math.floor(
              fileProgress + 100 / sorted.length
            );
            job.progress = Math.floor(
              (job.downloadProgress + job.convertProgress) / 2
            );
          } else {
            r = await convertMedia(
              filePath,
              format,
              bitrate,
              `${jobId}_${i}`,
              (progress) => {
                const baseProgress = (i / sorted.length) * 100;
                const currentFileProgress =
                  (progress / 100) * (100 / sorted.length);
                job.convertProgress = Math.floor(
                  baseProgress + currentFileProgress
                );

                if (job.playlist) {
                  job.playlist.current = i;
                }
                job.progress = Math.floor(
                  (job.downloadProgress + job.convertProgress) / 2
                );
              },
              fileMeta,
              itemCover,
              isVideoFormat(format),
              OUTPUT_DIR,
              TEMP_DIR,
              {
                onProcess: (child) => {
                  try {
                    registerJobProcess(jobId, child);
                  } catch {}
                },
                includeLyrics: job.metadata.includeLyrics,
                sampleRate: sampleRate,
                bitDepth: job.bitDepth || null,
                compressionLevel: job.metadata?.compressionLevel ?? null,
                isCanceled: () => !!jobs.get(jobId)?.canceled,
                onLog: handleLyricsLog,
                volumeGain: effectiveVolumeGain,
                onLyricsStats: handleLyricsStats,
                stereoConvert: job.metadata?.stereoConvert || "auto",
                atempoAdjust: job.metadata?.atempoAdjust || "none",
                selectedStreams: job.metadata.selectedStreams,
                videoSettings: job.videoSettings || {}
              }
            );
          }

          const hasLrc = !!r?.lyricsPath;
          if (Array.isArray(job.metadata.frozenEntries)) {
            const fe = job.metadata.frozenEntries.find(
              (x) => x.index === i + 1
            );
            if (fe) fe.hasLyrics = hasLrc;
          }

          results[i] = r;
         bump(job.counters, "cvDone", 1);
            if (job.playlist) job.playlist.done = job.counters.cvDone;
            updateLyricsStatsLive(job.playlist.done);

          return r;
        });

        convertPromisesSpotify.push(convertPromise);
      }

      await Promise.all(convertPromisesSpotify);

      const finalResults = results.filter((r) => r);

      if (finalResults.length === 1) {
        job.resultPath = finalResults[0]?.outputPath || null;
      } else {
        job.resultPath = finalResults;
        if (!job.clientBatch) {
          try {
            const zipTitle =
              job.metadata.spotifyTitle || "Spotify Playlist";
            job.zipPath = await makeZipFromOutputs(
              jobId,
              finalResults,
              zipTitle,
              job.metadata.includeLyrics
            );
          } catch (e) {}
        }
      }

      if (job.metadata?.includeLyrics) {
        updateLyricsStatsLive(
          job.playlist?.done || finalResults.length,
          job.playlist?.total || finalResults.length
        );
      }

      job.status = "completed";
      job.progress = 100;
      job.downloadProgress = 100;
      job.convertProgress = 100;
      job.currentPhase = "completed";
      cleanupTempFiles(jobId, inputPath, files);
      return;
    }

    if (job.metadata.source === "youtube") {
      job.currentPhase = "downloading";
      job.downloadProgress = 5;

      let isAutomix = !!job.metadata.isAutomix;
      if (!isAutomix) {
        isAutomix = isYouTubeAutomix(job.metadata.url);
        job.metadata.isAutomix = isAutomix;
      }

      let ytMeta = null;
      if (isAutomix) {
        ytMeta = {
          title: "YouTube Automix",
          uploader: "YouTube",
          playlist_title: "Automix"
        };
      } else {
        ytMeta = await fetchYtMetadata(
          job.metadata.url,
          job.metadata.isPlaylist
        );
      }

      let flat = {
      title: toNFC(ytMeta?.title || ""),
      uploader: toNFC(ytMeta?.uploader || ytMeta?.channel || ""),
      artist: toNFC(
        ytMeta?.artist ||
          ytMeta?.creator ||
          ytMeta?.uploader ||
          ytMeta?.channel ||
          ""
      ),
      track: ytMeta?.track || "",
      album: toNFC(ytMeta?.album || ""),
            release_year:
              (ytMeta?.release_year && String(ytMeta.release_year)) ||
              (ytMeta?.release_date &&
                String(ytMeta.release_date).slice(0, 4)) ||
              "",
            upload_date: ytMeta?.upload_date || "",
            webpage_url: ytMeta?.webpage_url || job.metadata.url,
            thumbnail:
              (ytMeta?.thumbnails && ytMeta.thumbnails.length
                ? ytMeta.thumbnails[ytMeta.thumbnails.length - 1].url
                : ytMeta?.thumbnail) || "",
            playlist_title: toNFC(ytMeta?.playlist_title || "")
          };
      flat = applyGlobalMetaCleaning(flat);
      job.metadata.extracted = flat;

      try {
        const id3Guess = buildId3FromYouTube({
          title: flat.title,
          uploader: flat.uploader,
          thumbnail: flat.thumbnail,
          webpage_url: flat.webpage_url
        });
        if (id3Guess) {
          flat.artist = id3Guess.artist || flat.artist || "";
          flat.title = id3Guess.title || flat.title || "";
          flat.track = id3Guess.track || flat.title || "";
        }
      } catch {}

      if (flat.thumbnail && !isAutomix) {
        const thumbBase = path.join(TEMP_DIR, `${jobId}.cover`);
        coverPath = await downloadThumbnail(flat.thumbnail, thumbBase);
      }

      if (job.metadata.isPlaylist || isAutomix) {
        job.downloadProgress = 10;

        const selectedIndicesVar =
          job.metadata.selectedIndices === "all" ||
          !job.metadata.selectedIndices
            ? null
            : job.metadata.selectedIndices;
        const selectedIdsVar = Array.isArray(job.metadata.selectedIds)
          ? job.metadata.selectedIds
          : null;

        const totalGuess =
          (selectedIdsVar && selectedIdsVar.length) ||
          (selectedIndicesVar && selectedIndicesVar.length) ||
          (Number.isFinite(ytMeta?.n_entries)
            ? ytMeta.n_entries
            : Number.isFinite(ytMeta?.playlist_count)
            ? ytMeta.playlist_count
            : Array.isArray(ytMeta?.entries)
            ? ytMeta.entries.length
            : null);

        if (Number.isFinite(totalGuess) && totalGuess > 0) {
          job.playlist = { total: totalGuess, done: 0 };
        }

        job.counters = job.counters || {};
        job.counters.dlTotal = Number(totalGuess || 0);
        job.counters.cvTotal = Number(totalGuess || 0);
        job.counters.dlDone = job.counters.dlDone || 0;
        job.counters.cvDone = job.counters.cvDone || 0;

        const indices = selectedIndicesVar;
        const selectedIds = selectedIdsVar;
        const metaEntries = Array.isArray(ytMeta?.entries)
          ? ytMeta.entries
          : [];
        const byIndex = buildEntriesMap(ytMeta);
        const byIdRaw = new Map();
        for (const e of metaEntries) {
          if (e?.id) byIdRaw.set(e.id, e);
        }
        const trackLyricsMap = new Map();
        const frozenByIndex = new Map();
        const frozenById = new Map();

        if (Array.isArray(job.metadata?.frozenEntries)) {
          for (const e of job.metadata.frozenEntries) {
            if (!e) continue;

            const idx = Number(e.index);
            if (Number.isFinite(idx)) {
              frozenByIndex.set(idx, { ...e, index: idx });
            }

            if (e.id) {
              frozenById.set(e.id, { ...e, index: Number.isFinite(idx) ? idx : e.index });
            }
          }
        }

        const youtubeConcurrency = job.metadata?.youtubeConcurrency || 4;
        console.log("⚡ Processing with youtubeConcurrency:", youtubeConcurrency);
        const youtubeLimiter = createLimiter(youtubeConcurrency);
        const results = [];
        const convertPromisesYouTube = [];
        let autoCounter = 0;

        async function convertPlaylistItem(
          autoIndex,
          filePath,
          explicitPlaylistIndex = null
        ) {
          const baseName = path.basename(filePath);

        const fromParser = parsePlaylistIndexFromPath(baseName);
        const regexMatch = baseName.match(/^(\d+)\s*-\s*/);
        const indexFromName = Number.isFinite(fromParser)
          ? fromParser
          : (regexMatch ? Number(regexMatch[1]) : NaN);

        const playlistIndex =
          Number.isFinite(indexFromName)
            ? indexFromName
            : (Number.isFinite(explicitPlaylistIndex) && explicitPlaylistIndex != null
                ? explicitPlaylistIndex
                : autoIndex + 1);

          let frozen = null;
          if (Number.isFinite(playlistIndex)) {
            frozen = frozenByIndex.get(playlistIndex) || null;
          }

          if (!frozen && Array.isArray(selectedIds) && selectedIds.length) {
            const pinnedId = selectedIds[playlistIndex - 1] || null;
            if (pinnedId && frozenById.has(pinnedId)) {
              frozen = frozenById.get(pinnedId);
            }
          }

          let entry = {};

          if (frozen?.id && byIdRaw.has(frozen.id)) {
            entry = byIdRaw.get(frozen.id) || {};
          } else if (Number.isFinite(playlistIndex) && byIndex.has(playlistIndex)) {
            entry = byIndex.get(playlistIndex) || {};
          }

          if (frozen) {
            entry = {
              ...entry,
              id: frozen.id || entry.id,
              title: frozen.title || entry.title,
              uploader: frozen.uploader || entry.uploader,
              artist: frozen.artist || entry.artist,
              webpage_url: frozen.webpage_url || entry.webpage_url
            };
          }

          const fallbackTitle = path
            .basename(filePath, path.extname(filePath))
            .replace(/^\d+\s*-\s*/, "");
          let title = toNFC(entry?.title || fallbackTitle);

          let fileMeta = {
            ...flat,
            title,
            track: title,
            uploader: toNFC(entry?.uploader || flat.uploader),
            artist: toNFC(
              entry?.artist ||
                entry?.uploader ||
                flat.artist ||
                flat.uploader
            ),
            album:
              flat.album ||
              (ytMeta?.title ||
                ytMeta?.playlist_title ||
                job.metadata.frozenTitle ||
                ""),
            webpage_url: entry?.webpage_url || entry?.url || flat.webpage_url,
            genre: "",
            label: "",
            publisher: "",
            copyright: "",
            album_artist: ""
          };
          fileMeta = applyGlobalMetaCleaning(fileMeta);
          fileMeta.album_artist = toNFC(
            (entry && entry.album_artist) || fileMeta.artist || ""
          );
          if (/^(youtube|youtube\s+mix)$/i.test((fileMeta.artist || "").trim())) {
            fileMeta.artist = "";
          }

          fileMeta.uploader = cleanNameDynamic(fileMeta.uploader);
          fileMeta.artist = cleanNameDynamic(fileMeta.artist);
          fileMeta.album_artist = cleanNameDynamic(fileMeta.album_artist);

          try {
            const ytMusic = await probeYoutubeMusicMeta(
              entry?.webpage_url || entry?.id
            );
            fileMeta = mergeMeta(fileMeta, ytMusic);
          } catch {}

          if (process.env.ENRICH_SPOTIFY_FOR_YT === "1") {
            try {
              const spMeta = await findSpotifyMetaByQuery(
                fileMeta.artist,
                fileMeta.track,
                job?.metadata?.market
              );
              if (spMeta) {
                fileMeta = {
                  ...fileMeta,
                  genre: spMeta.genre || fileMeta.genre,
                  label: spMeta.label || fileMeta.label,
                  publisher: spMeta.publisher || spMeta.label || fileMeta.publisher,
                  copyright: spMeta.copyright || fileMeta.copyright,
                  album_artist: spMeta.album_artist || fileMeta.album_artist,
                  album: spMeta.album || fileMeta.album,
                  release_year: spMeta.release_year || fileMeta.release_year,
                  release_date: spMeta.release_date || fileMeta.release_date,
                  isrc: spMeta.isrc || fileMeta.isrc
                };
              }
            } catch (error) {
              console.warn(
                `Spotify metadata enrichment error: ${error.message}`
              );
            }
          }

          let itemCover = null;
          const baseNoExt = filePath.replace(/\.[^.]+$/, "");
          const sidecarJpg = `${baseNoExt}.jpg`;
          if (fs.existsSync(sidecarJpg)) itemCover = sidecarJpg;
          else if (coverPath && fs.existsSync(coverPath)) itemCover = coverPath;
          else if (fileMeta?.coverUrl) {
            try {
              const dl = await downloadThumbnail(
                fileMeta.coverUrl,
                `${baseNoExt}.cover`
              );
              if (dl) itemCover = dl;
            } catch {}
          }

          try {
            const strictMeta = await resolveId3StrictForYouTube(
              {
                title: fileMeta.title,
                uploader: fileMeta.artist || fileMeta.uploader,
                thumbnail: itemCover ? null : flat.thumbnail,
                webpage_url: fileMeta.webpage_url
              },
              { market: resolveMarket(), isPlaylist: true }
            );

            if (strictMeta) {
              fileMeta = {
                ...fileMeta,
                ...strictMeta,
                genre: fileMeta.genre || strictMeta.genre,
                label: fileMeta.label || strictMeta.label,
                publisher: fileMeta.publisher || strictMeta.publisher,
                copyright: fileMeta.copyright || strictMeta.copyright,
                album_artist: fileMeta.album_artist || strictMeta.album_artist,
                webpage_url: strictMeta.spotifyUrl || fileMeta.webpage_url
              };
              fileMeta.album_artist = toNFC(
                fileMeta.album_artist || fileMeta.artist || ""
              );
              if (strictMeta.label) {
                if (!fileMeta.label) fileMeta.label = strictMeta.label;
                if (!fileMeta.publisher) fileMeta.publisher = strictMeta.label;
              }
            } else {
              const guess = buildId3FromYouTube({
                title: fileMeta.title,
                uploader: fileMeta.artist || fileMeta.uploader,
                thumbnail: itemCover ? null : flat.thumbnail,
                webpage_url: fileMeta.webpage_url
              });

              if (guess) {
                fileMeta = {
                  ...fileMeta,
                  title: guess.title || fileMeta.title,
                  track: guess.track || fileMeta.track || guess.title || fileMeta.title,
                  artist: guess.artist || fileMeta.artist,
                  uploader: guess.uploader || fileMeta.uploader,
                  genre: fileMeta.genre,
                  label: fileMeta.label,
                  publisher: fileMeta.publisher,
                  copyright: fileMeta.copyright,
                  album_artist:
                    fileMeta.album_artist ||
                    guess.artist ||
                    fileMeta.artist
                };
                fileMeta.album_artist = toNFC(
                  fileMeta.album_artist || fileMeta.artist || ""
                );
              }
            }
          } catch (error) {
            console.warn(`ID3 strict resolution error: ${error.message}`);
          }
          fileMeta = applyGlobalMetaCleaning(fileMeta);

          const totalTracks = job.playlist?.total || totalGuess || 1;
          const existingOut = findExistingOutput(
            `${jobId}_${autoIndex}`,
            format,
            OUTPUT_DIR
          );
          let r;
          if (existingOut) {
            r = {
              outputPath: `/download/${encodeURIComponent(
                path.basename(existingOut)
              )}`
            };
            const fileProgress = (autoIndex / totalTracks) * 100;
            job.convertProgress = Math.floor(
              fileProgress + 100 / totalTracks
            );
            job.progress = Math.floor(
              (job.downloadProgress + job.convertProgress) / 2
            );
            if (job.canceled) throw new Error("CANCELED");
          } else {
            try {
              r = await convertMedia(
                filePath,
                format,
                bitrate,
                `${jobId}_${autoIndex}`,
                (progress) => {
                  const baseProgress = (autoIndex / totalTracks) * 100;
                  const currentFileProgress =
                    (progress / 100) * (100 / totalTracks);
                  job.convertProgress = Math.floor(
                    baseProgress + currentFileProgress
                  );
                  if (job.playlist) {
                    job.playlist.current = autoIndex;
                  }
                  job.progress = Math.floor(
                    (job.downloadProgress + job.convertProgress) / 2
                  );
                },
                fileMeta,
                itemCover,
                isVideoFormat(format),
                OUTPUT_DIR,
                TEMP_DIR,
                {
                  onProcess: (child) => {
                    try {
                      registerJobProcess(jobId, child);
                    } catch {}
                  },
                  includeLyrics: job.metadata.includeLyrics,
                  sampleRate: sampleRate,
                  bitDepth: job.bitDepth || null,
                  compressionLevel: job.metadata?.compressionLevel ?? null,
                  isCanceled: () => !!jobs.get(jobId)?.canceled,
                  onLog: handleLyricsLog,
                  volumeGain: effectiveVolumeGain,
                  onLyricsStats: handleLyricsStats,
                  stereoConvert: job.metadata?.stereoConvert || "auto",
                  atempoAdjust: job.metadata?.atempoAdjust || "none"
                }
              );
            } catch (err) {
              if (String(err?.message || "").toUpperCase() === "CANCELED") {
                const jobRef = jobs.get(jobId);
                if (jobRef) {
                  jobRef.status = "canceled";
                  jobRef.currentPhase = "canceled";
                  jobRef.error = null;
                  jobRef.canceled = true;
                }
                return null;
              }
              throw err;
            }
          }

          const hasLrc = !!r?.lyricsPath;
          if (hasLrc && Number.isFinite(playlistIndex)) {
            trackLyricsMap.set(playlistIndex, true);
          }

          results[autoIndex] = r;
          bump(job.counters, "cvDone", 1);
          if (job.playlist) {
            job.playlist.done = (job.playlist.done || 0) + 1;
          }
          updateLyricsStatsLive(job.playlist?.done || 0, totalTracks);

          return r;
        }

        const filesPromise = downloadYouTubeVideo(
        job.metadata.url,
        jobId,
        true,
        indices,
        isAutomix,
        selectedIds,
        TEMP_DIR,
          (progress) => {
            const tGuess = Number(
              job.counters?.dlTotal || job.playlist?.total || 0
            );
            if (
              progress &&
              typeof progress === "object" &&
              progress.__event &&
              progress.type === "file-done"
            ) {
              const t = Number(progress.total || tGuess || 0);
              job.counters.dlTotal = t || tGuess;
              job.counters.dlDone = Math.min(
                job.counters.dlTotal || t,
                Number(progress.downloaded || 0)
              );
              job.downloadProgress = Math.max(
              10,
              Math.min(
              100,
              10 +
                (job.counters.dlDone /
                  Math.max(1, job.counters.dlTotal || t || 1)) *
                  90
                )
              );
              if (job.playlist && job.currentPhase === "downloading") {
                job.playlist.current = Math.max(
                  0,
                  (job.counters.dlDone - 1) | 0
                );
              }
            } else {
              const pct = Number(progress || 0);
              job.downloadProgress = Math.max(
                10,
                Math.min(100, 10 + pct * 0.9)
              );
              const t = tGuess;
              if (t > 0) {
                const approx = clampInt((pct / 100) * t, 0, t);
                if ((job.counters.dlDone || 0) < approx)
                  job.counters.dlDone = approx;
                if (job.playlist && job.currentPhase === "downloading") {
                  job.playlist.current = Math.max(
                    0,
                    Math.min(t - 1, approx - 1)
                  );
                }
              }
            }
            job.progress = Math.floor(
              (job.downloadProgress + job.convertProgress) / 2
            );
          },
          {
            video: isVideoFormat(format),
            onSkipUpdate: handleSkipUpdate,
            maxHeight: isVideoFormat(format)
              ? qualityToHeight(bitrate)
              : undefined,
            youtubeConcurrency,
            onFileDone: ({ filePath, playlistIndex }) => {
              const myIndex = autoCounter++;
              const p = youtubeLimiter(() =>
                convertPlaylistItem(myIndex, filePath, playlistIndex)
              );
              convertPromisesYouTube.push(p);
            }
          },
          { isCanceled: () => !!job.canceled }
        );

        const files = await filesPromise;

        job.counters.dlDone = job.counters.dlTotal;
        job.downloadProgress = 100;
        job.currentPhase = "converting";
        job.convertProgress = job.convertProgress || 0;

        if (!Array.isArray(files) || !files.length) {
          throw new Error("Playlist/Automix media files not found");
        }

        const entryById = new Map();
        if (Array.isArray(job.metadata.frozenEntries)) {
          for (const e of job.metadata.frozenEntries) {
            if (e?.id) entryById.set(e.id, e);
          }
        }
        if (
          !Array.isArray(job.metadata.frozenEntries) ||
          job.metadata.frozenEntries.length === 0
        ) {
          const fe = [];
          const byIdMeta = new Map();
          for (const e of metaEntries) {
            if (e?.id) byIdMeta.set(e.id, e);
          }
          for (let i = 0; i < files.length; i++) {
            const filePath = files[i];
            const idxFromName = parsePlaylistIndexFromPath(filePath);
            let src = null;
            if (Number.isFinite(idxFromName) && byIndex.has(idxFromName)) {
              src = byIndex.get(idxFromName);
            } else if (
              Array.isArray(selectedIds) &&
              selectedIds[i] &&
              byIdMeta.has(selectedIds[i])
            ) {
              src = byIdMeta.get(selectedIds[i]);
            }
            const title = (
              src?.title ||
              src?.alt_title ||
              path
                .basename(filePath, path.extname(filePath))
                .replace(/^\d+\s*-\s*/, "") ||
              ""
            ).toString();
            const uploader = (
              src?.uploader ||
              src?.channel ||
              ytMeta?.uploader ||
              ytMeta?.channel ||
              ""
            ).toString();
            const id = (
              src?.id ||
              (Array.isArray(selectedIds) ? selectedIds[i] : null) ||
              ""
            ).toString();
            const webpage_url = (
              src?.webpage_url ||
              src?.url ||
              job.metadata.url ||
              ""
            ).toString();
            const index = Number.isFinite(idxFromName)
              ? idxFromName
              : i + 1;
            const hasLyrics = !!trackLyricsMap.get(index);
            const entry = {
              index,
              id,
              title,
              uploader,
              webpage_url,
              hasLyrics
            };
            fe.push(entry);
            if (id) entryById.set(id, entry);
          }
          job.metadata.frozenEntries = fe;
          job.metadata.frozenTitle =
            job.metadata.frozenTitle ||
            ytMeta?.title ||
            ytMeta?.playlist_title ||
            (isAutomix ? "YouTube Automix" : "");
        } else {
          for (const fe of job.metadata.frozenEntries) {
            if (!fe || typeof fe.index !== "number") continue;
            if (trackLyricsMap.has(fe.index)) {
              fe.hasLyrics = !!trackLyricsMap.get(fe.index);
            }
          }
        }

        await Promise.all(convertPromisesYouTube);
        const finalResults = results.filter(Boolean);

        if (finalResults.length === 1) {
          job.resultPath = finalResults[0]?.outputPath || null;
        } else {
          job.resultPath = finalResults;
          if (!job.clientBatch) {
            try {
              const zipTitle =
                ytMeta?.title ||
                ytMeta?.playlist_title ||
                (isAutomix ? "YouTube Automix" : "Playlist");
              job.zipPath = await makeZipFromOutputs(
                jobId,
                finalResults,
                zipTitle,
                job.metadata.includeLyrics
              );
            } catch (e) {}
          }
        }

        if (job.metadata?.includeLyrics) {
          const doneCount = job.playlist?.done || finalResults.length;
          const totalCount = job.playlist?.total || totalGuess || finalResults.length;
          updateLyricsStatsLive(doneCount, totalCount);
        }

        job.status = "completed";
        job.progress = 100;
        job.downloadProgress = 100;
        job.convertProgress = 100;
        job.currentPhase = "completed";
        cleanupTempFiles(jobId, inputPath, files);
        return;
      }

      const filePath = await downloadYouTubeVideo(
        job.metadata.url,
        jobId,
        false,
        null,
        false,
        null,
        TEMP_DIR,
        (progress) => {
          job.downloadProgress = progress;
          job.counters = job.counters || {};
          job.counters.dlTotal = 1;
          const approx = progress >= 100 ? 1 : 0;
          if ((job.counters.dlDone || 0) < approx)
            job.counters.dlDone = approx;
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );
        },
        {
          video: isVideoFormat(format),
          onSkipUpdate: handleSkipUpdate,
          maxHeight: isVideoFormat(format)
            ? qualityToHeight(bitrate)
            : undefined
        },
        { isCanceled: () => !!job.canceled }
      );

      job.counters.dlTotal = 1;
      job.counters.dlDone = 1;
      job.downloadProgress = 100;
      job.currentPhase = "converting";
      actualInputPath = filePath;
    }

    const isVideo = format === "mp4";
    const isEac3Ac3 =
      format === "eac3" || format === "ac3" || format === "aac";
    if (!coverPath && typeof actualInputPath === "string") {
      const baseNoExt = actualInputPath.replace(/\.[^.]+$/, "");
      const sidecar = `${baseNoExt}.jpg`;
      if (fs.existsSync(sidecar)) coverPath = sidecar;
    }

    let singleMeta = { ...(job.metadata.extracted || {}) };

    try {
      const ytMusicSingle = await probeYoutubeMusicMeta(
        singleMeta.webpage_url || job.metadata.url
      );
      singleMeta = mergeMeta(singleMeta, ytMusicSingle);
    } catch {}

    if (process.env.ENRICH_SPOTIFY_FOR_YT === "1") {
      try {
        const spSingle = await findSpotifyMetaByQuery(
          singleMeta.artist,
          singleMeta.track,
          job?.metadata?.market
        );
        singleMeta = mergeMeta(singleMeta, spSingle);
        if (!singleMeta.publisher && spSingle?.label)
          singleMeta.publisher = spSingle.label;
      } catch {}
    }
    singleMeta.album_artist =
    singleMeta.album_artist || singleMeta.artist || "";
    singleMeta = applyGlobalMetaCleaning(singleMeta);

    try {
      const artistForMeta =
        singleMeta?.artist ||
        singleMeta?.album_artist ||
        job.metadata?.artist ||
        job.metadata?.extracted?.artist ||
        "";

      if (singleMeta.title && artistForMeta) {
        const coreTitle = normalizeTitle(singleMeta.title, artistForMeta);
        singleMeta.title =
          artistForMeta && coreTitle
            ? `${artistForMeta} - ${coreTitle}`
            : singleMeta.title;
      }
    } catch {}

    if (!coverPath && singleMeta?.coverUrl && typeof actualInputPath === "string") {
      try {
        const baseNoExt = actualInputPath.replace(/\.[^.]+$/, "");
        const dl = await downloadThumbnail(
          singleMeta.coverUrl,
          `${baseNoExt}.cover`
        );
        if (dl) coverPath = dl;
      } catch {}
    }

    job.counters = job.counters || {};

    const selectedAudioStreams = Array.isArray(selectedStreams.audio)
      ? selectedStreams.audio.filter(
          (idx) => Number.isInteger(idx) && idx >= 0
        )
      : [];

    const isAudioFormat = !isVideoFormatFlag;
    const multiAudioOutputs = isAudioFormat && selectedAudioStreams.length > 1;

    if (multiAudioOutputs) {
      const results = [];
      const total = selectedAudioStreams.length;

      job.counters.cvTotal = total;
      job.counters.cvDone = job.counters.cvDone || 0;

      for (let i = 0; i < total; i++) {
        const aIdx = selectedAudioStreams[i];
        const perStreamSelected = {
          ...(selectedStreams || {}),
          audio: [aIdx]
        };

        const perJobId = `${jobId}_a${i}`;
        const existingOut = findExistingOutput(
          perJobId,
          format,
          OUTPUT_DIR
        );
        const progressForStream = (p) => {
          const base = (i / total) * 100;
          const cur = base + (Number(p || 0) / total);
          job.convertProgress = Math.floor(cur);
          job.progress = Math.floor(
            (job.downloadProgress + job.convertProgress) / 2
          );
        };

        let r;
        if (existingOut) {
          r = {
            outputPath: `/download/${encodeURIComponent(
              path.basename(existingOut)
            )}`
          };
          progressForStream(100);
        } else {
          r = await convertMedia(
            actualInputPath,
            format,
            bitrate,
            perJobId,
            progressForStream,
            {
              ...singleMeta,
              __maxHeight: undefined
            },
            coverPath,
            false,
            OUTPUT_DIR,
            TEMP_DIR,
            {
              onProcess: (child) => {
                try {
                  registerJobProcess(jobId, child);
                } catch {}
              },
              includeLyrics: !!job.metadata.includeLyrics,
              sampleRate: sampleRate,
              compressionLevel: job.metadata?.compressionLevel ?? null,
              bitDepth: job.bitDepth || null,
              isCanceled: () => !!jobs.get(jobId)?.canceled,
              onLog: handleLyricsLog,
              onLyricsStats: handleLyricsStats,
              volumeGain: effectiveVolumeGain,
              stereoConvert: job.metadata?.stereoConvert || "auto",
              selectedStreams: perStreamSelected,
              atempoAdjust: job.metadata?.atempoAdjust || "none",
              videoSettings: job.videoSettings || {}
            }
          );
        }

        results.push(r);
        bump(job.counters, "cvDone", 1);

        if (job.metadata?.includeLyrics) {
          updateLyricsStatsLive(job.counters.cvDone, total);
        }

        if (job.canceled) {
          throw new Error("CANCELED");
        }
      }

      job.resultPath = results.length === 1 ? results[0] : results;

      job.status = "completed";
      job.progress = 100;
      job.downloadProgress = 100;
      job.convertProgress = 100;
      job.currentPhase = "completed";
      cleanupTempFiles(jobId, inputPath, actualInputPath);
      return;
    }

    job.counters.cvTotal = 1;

    const existingSingle = findExistingOutput(jobId, format, OUTPUT_DIR);
    const r = existingSingle
      ? {
          outputPath: `/download/${encodeURIComponent(
            path.basename(existingSingle)
          )}`
        }
      : await convertMedia(
          actualInputPath,
          format,
          bitrate,
          jobId,
          (p) => {
            job.convertProgress = Math.floor(p);
            job.progress = Math.floor(
              (job.downloadProgress + job.convertProgress) / 2
            );
          },
          {
            ...singleMeta,
            __maxHeight: isVideoFormatFlag
              ? qualityToHeight(bitrate)
              : undefined
          },
          coverPath,
          isVideoFormat(format),
          OUTPUT_DIR,
          TEMP_DIR,
          {
            onProcess: (child) => {
              try {
                registerJobProcess(jobId, child);
              } catch {}
            },
            includeLyrics: !!job.metadata.includeLyrics,
            sampleRate: sampleRate,
            compressionLevel: job.metadata?.compressionLevel ?? null,
            bitDepth: job.bitDepth || null,
            isCanceled: () => !!jobs.get(jobId)?.canceled,
            onLog: handleLyricsLog,
            onLyricsStats: handleLyricsStats,
            volumeGain: effectiveVolumeGain,
            stereoConvert: job.metadata?.stereoConvert || "auto",
            selectedStreams: selectedStreams,
            atempoAdjust: job.metadata?.atempoAdjust || "none",
            videoSettings: job.videoSettings || {}
          }
        );

        job.resultPath = r;
    try {
      if (r?.outputPath) {
        const extMap = {
          mp3: ".mp3",
          flac: ".flac",
          wav: ".wav",
          ogg: ".ogg",
          mp4: ".mp4"
        };
        const desiredExt =
          extMap[format] || "." + String(format || "mp3");

        const titleCandidate =
          singleMeta?.title ||
          job.metadata?.title ||
          job.metadata?.extracted?.title ||
          "";

        const artistForName =
          singleMeta?.artist ||
          singleMeta?.album_artist ||
          job.metadata?.artist ||
          job.metadata?.extracted?.artist ||
          "";

        const titleForFilename = normalizeTitle(
          titleCandidate,
          artistForName
        );

        let baseTitle;

        if (artistForName && titleForFilename) {
          baseTitle = `${artistForName} - ${titleForFilename}`;
        } else if (titleCandidate) {
          baseTitle = titleCandidate;
        } else {
          baseTitle =
            job.metadata?.originalName ||
            singleMeta?.track ||
            job.metadata?.extracted?.title ||
            `job_${jobId}`;
        }

        baseTitle = baseTitle.replace(/\.[^.]*$/, "");
        const safeBase = sanitizeFilename(toNFC(baseTitle)) || "output";

        let targetName = `${safeBase}${desiredExt}`;
        const currentRel = decodeURIComponent(
          String(r.outputPath).replace(/^\/download\//, "")
        );
        const currentAbs = path.join(OUTPUT_DIR, currentRel);
        let targetAbs = path.join(OUTPUT_DIR, targetName);
        if (fs.existsSync(targetAbs)) {
          let i = 1;
          const stem = safeBase;
          const ext = desiredExt;
          while (fs.existsSync(targetAbs) && i < 1000) {
            targetName = `${stem} (${i})${ext}`;
            targetAbs = path.join(OUTPUT_DIR, targetName);
            i++;
          }
        }

        if (fs.existsSync(currentAbs)) {
          fs.renameSync(currentAbs, targetAbs);
          job.resultPath = {
            outputPath: `/download/${encodeURIComponent(targetName)}`
          };
          const oldLrc = currentAbs.replace(/\.[^/.]+$/, "") + ".lrc";
          if (fs.existsSync(oldLrc)) {
            const newLrc = targetAbs.replace(/\.[^/.]+$/, "") + ".lrc";
            try {
              fs.renameSync(oldLrc, newLrc);
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn("Output rename warning:", e.message);
    }

    job.counters.cvDone = 1;
    if (job.metadata?.includeLyrics) {
      updateLyricsStatsLive(1, 1);
    }

    job.status = "completed";
    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    cleanupTempFiles(jobId, inputPath, actualInputPath);
  } catch (error) {
    const jobRef = jobs.get(jobId);
    if (jobRef) {
      if (error && String(error.message).toUpperCase() === "CANCELED") {
        jobRef.status = "canceled";
        jobRef.error = null;
        jobRef.currentPhase = "canceled";
      } else {
        jobRef.status = "error";
        jobRef.error = error.message;
        jobRef.currentPhase = "error";
      }
    }
    if (!error || String(error.message).toUpperCase() !== "CANCELED") {
      console.error("Job error:", error);
    }
    try {
      killJobProcesses(jobId);
    } catch {}
    cleanupTempFiles(jobId, inputPath);
  }
}

function findExistingOutput(idPrefix, format, outDir) {
  try {
    const exts =
      {
        mp3: ["mp3"],
        flac: ["flac"],
        wav: ["wav"],
        ogg: ["ogg", "oga"],
        mp4: ["mp4", "m4a"]
      }[format] || [format];
    const files = fs.readdirSync(outDir);
    const hit = files.find(
      (f) =>
        f.startsWith(`${idPrefix}.`) &&
        exts.some((e) => f.toLowerCase().endsWith(`.${e}`))
    );
    return hit ? path.join(outDir, hit) : null;
  } catch {
    return null;
  }
}

async function makeZipFromOutputs(
  jobId,
  outputs,
  titleHint = "playlist",
  includeLyrics = false
) {
  const safeBase = sanitizeFilename(
    `${titleHint || "playlist"}_${jobId}`
  ).normalize("NFC");
  const zipName = `${safeBase}.zip`;
  const zipAbs = path.join(OUTPUT_DIR, zipName);

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipAbs);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () =>
      resolve(`/download/${encodeURIComponent(zipName)}`)
    );
    archive.on("error", (err) => reject(err));

    archive.pipe(output);

    for (const r of outputs) {
      if (!r?.outputPath) continue;
      const rel = decodeURIComponent(
        r.outputPath.replace(/^\/download\//, "")
      );
      const abs = path.join(OUTPUT_DIR, rel);
      if (fs.existsSync(abs)) {
        const nfcName = path.basename(abs).normalize("NFC");
        archive.file(abs, { name: nfcName });
        if (includeLyrics) {
          const lrcPath = abs.replace(/\.[^/.]+$/, "") + ".lrc";
          if (fs.existsSync(lrcPath)) {
            const lrcName = path.basename(lrcPath).normalize("NFC");
            archive.file(lrcPath, { name: lrcName });
          }
        }
      }
    }
    archive.finalize();
  });
}

function cleanupTempFiles(jobId, originalInputPath, downloadedPath = null) {
  try {
    if (
      typeof originalInputPath === "string" &&
      fs.existsSync(originalInputPath) &&
      originalInputPath.includes(
        path.resolve(process.cwd(), "uploads")
      )
    ) {
      try {
        fs.unlinkSync(originalInputPath);
      } catch {}
    }

    if (Array.isArray(downloadedPath)) {
      downloadedPath.forEach((f) => {
        try {
          if (
            typeof f === "string" &&
            fs.existsSync(f) &&
            f.startsWith(TEMP_DIR + path.sep)
          ) {
            fs.unlinkSync(f);
          }
        } catch {}
      });
      const playlistDir = path.join(TEMP_DIR, jobId);
      if (fs.existsSync(playlistDir)) {
        try {
          fs.rmSync(playlistDir, { recursive: true, force: true });
        } catch {}
      }
    } else if (
      typeof downloadedPath === "string" &&
      fs.existsSync(downloadedPath) &&
      downloadedPath.startsWith(TEMP_DIR + path.sep)
    ) {
      try {
        fs.unlinkSync(downloadedPath);
      } catch {}
    }

    try {
      const files = fs.readdirSync(TEMP_DIR);
      files.forEach((f) => {
        if (f.startsWith(jobId)) {
          try {
            fs.unlinkSync(path.join(TEMP_DIR, f));
          } catch {}
        }
      });
    } catch {}
  } catch (e) {
    console.warn("Cleanup warning:", e.message);
  }
}
