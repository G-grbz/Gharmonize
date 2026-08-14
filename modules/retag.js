import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseFile } from "music-metadata";
import { retagMediaFile, downloadThumbnail } from "./media.js";
import { findAppleTrackMetaByQuery } from "./apple.js";
import { findDeezerTrackMetaByQuery } from "./deezer.js";
import { searchSpotifyBestTrackStrict, trackToId3Meta } from "./spotify.js";
import { resolveMarket } from "./market.js";
import { markJobCompleted, registerJobProcess } from "./store.js";
import { sanitizeFilename } from "./utils.js";

const RETAGGABLE_EXTENSIONS = new Set([".mp3", ".flac", ".m4a"]);
const SIDECAR_COVER_NAMES = ["cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.jpeg", "front.jpg"];

function hasValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function mergePresent(base = {}, extra = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (hasValue(value)) out[key] = value;
  }
  return out;
}

function mergeMissing(base = {}, extra = {}) {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    if (!hasValue(out[key]) && hasValue(value)) out[key] = value;
  }
  return out;
}

function firstText(value) {
  if (Array.isArray(value)) {
    const first = value.find((entry) => hasValue(entry));
    if (first && typeof first === "object") return String(first.text || first.url || "").trim();
    return String(first || "").trim();
  }
  if (value && typeof value === "object") return String(value.text || value.url || "").trim();
  return String(value || "").trim();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function filenameHints(filePath, common = {}) {
  let lookupStem = path.parse(filePath).name.trim();
  let previousStem = "";
  while (lookupStem !== previousStem) {
    previousStem = lookupStem;
    lookupStem = lookupStem.replace(/\([^()]*\)/g, " ");
  }
  lookupStem = lookupStem.replace(/\s+/g, " ").trim();

  const segments = lookupStem
    .split(/\s+[\-–—]\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasDiscTrackPrefix = segments.length >= 4 &&
    /^\d{1,3}$/.test(segments[0]) &&
    /^\d{1,3}$/.test(segments[1]);
  const hasTrackPrefix = !hasDiscTrackPrefix && segments.length >= 3 &&
    /^\d{1,3}$/.test(segments[0]);

  const filenameArtist = String(
    hasDiscTrackPrefix
      ? segments[2]
      : (hasTrackPrefix ? segments[1] : (segments.length >= 2 ? segments[0] : ""))
  ).trim();
  const filenameTitle = String(
    hasDiscTrackPrefix ? segments[3] : (hasTrackPrefix ? segments[2] : (segments[1] || segments[0] || ""))
  ).trim();
  const parsedTrackNumber = hasDiscTrackPrefix
    ? numberOrNull(segments[1])
    : (hasTrackPrefix ? numberOrNull(segments[0]) : null);
  const parsedDiscNumber = hasDiscTrackPrefix ? numberOrNull(segments[0]) : null;
  const title = String(common.title || filenameTitle || "").trim();
  const artist = String(
    common.artist ||
    (Array.isArray(common.artists) ? common.artists.filter(Boolean).join(", ") : "") ||
    filenameArtist ||
    ""
  ).trim();
  return {
    artist,
    title,
    lookupArtist: filenameArtist || artist,
    lookupTitle: filenameTitle || title,
    trackNumber: parsedTrackNumber,
    discNumber: parsedDiscNumber
  };
}

function metadataFromParsed(filePath, parsed = {}, libraryRoot = null) {
  const common = parsed.common || {};
  const hints = filenameHints(filePath, common);
  const parentDirectory = path.dirname(filePath);
  const parentAlbum = libraryRoot && path.resolve(parentDirectory) !== path.resolve(libraryRoot)
    ? path.basename(parentDirectory).trim()
    : "";
  const releaseDate = firstText(common.originaldate || common.date || "");
  const releaseYear = numberOrNull(common.year) || numberOrNull(releaseDate.slice(0, 4));
  const isrc = firstText(common.isrc);
  const sourceUrl = firstText(common.website);

  return {
    title: hints.title,
    track: hints.title,
    artist: hints.artist,
    uploader: hints.artist,
    retag_lookup_artist: hints.lookupArtist,
    retag_lookup_title: hints.lookupTitle,
    album: firstText(common.album) || parentAlbum,
    album_artist: firstText(common.albumartist) || hints.artist,
    release_year: releaseYear ? String(releaseYear) : "",
    release_date: releaseDate,
    track_number: numberOrNull(common.track?.no) || hints.trackNumber,
    track_total: numberOrNull(common.track?.of),
    disc_number: numberOrNull(common.disk?.no) || hints.discNumber,
    disc_total: numberOrNull(common.disk?.of),
    genre: firstText(common.genre),
    copyright: firstText(common.copyright),
    label: firstText(common.label),
    publisher: firstText(common.label),
    isrc,
    webpage_url: sourceUrl,
    comment: firstText(common.comment),
    lyrics: firstText(common.lyrics),
    duration_ms: Number.isFinite(parsed.format?.duration)
      ? Math.round(Number(parsed.format.duration) * 1000)
      : null
  };
}

async function resolveOnlineMetadata(existing = {}) {
  if (process.env.RETAG_ONLINE_METADATA === "0") return null;
  const artist = String(
    existing.retag_lookup_artist || existing.artist || existing.album_artist || ""
  ).trim();
  const title = String(existing.retag_lookup_title || existing.track || existing.title || "").trim();
  if (!title) return null;

  const options = {
    album: existing.album || "",
    market: resolveMarket(),
    targetDurationMs: Number(existing.duration_ms || 0) || null,
    targetDurationSec: Number(existing.duration_ms || 0) > 0
      ? Number(existing.duration_ms) / 1000
      : null
  };

  let resolved = null;
  let source = null;
  if (process.env.PREFER_SPOTIFY_TAGS === "1") {
    try {
      const spotifyTrack = await searchSpotifyBestTrackStrict(
        artist,
        title,
        options.market,
        {
          targetDurationSec: options.targetDurationSec,
          titleRaw: title,
          minScore: 7
        }
      );
      resolved = trackToId3Meta(spotifyTrack);
      if (resolved) source = "spotify";
    } catch {}
  }

  let appleMeta = null;
  try {
    appleMeta = await findAppleTrackMetaByQuery(artist, title, options);
  } catch {}
  if (!resolved) {
    resolved = appleMeta;
    if (resolved) source = "apple";
  }
  else resolved = mergeMissing(resolved, appleMeta);

  if (!resolved) {
    try {
      resolved = await findDeezerTrackMetaByQuery(artist, title, options);
      if (resolved) source = "deezer";
    } catch {}
  }

  return resolved ? { metadata: resolved, source } : null;
}

function findSidecarCover(filePath) {
  const parsed = path.parse(filePath);
  const sameStem = [".jpg", ".jpeg", ".png", ".webp"]
    .map((ext) => path.join(parsed.dir, `${parsed.name}${ext}`));
  const albumCovers = SIDECAR_COVER_NAMES.map((name) => path.join(parsed.dir, name));
  return [...sameStem, ...albumCovers].find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || null;
}

async function resolveCover(filePath, metadata, jobTempDir, index) {
  const sidecar = findSidecarCover(filePath);
  if (sidecar) return { path: sidecar, temporary: false };

  const coverUrl = String(metadata?.coverUrl || metadata?.imageUrl || metadata?.thumbnailUrl || "").trim();
  if (!coverUrl) return { path: null, temporary: false };

  try {
    fs.mkdirSync(jobTempDir, { recursive: true });
    const base = path.join(jobTempDir, `cover_${index}_${crypto.randomBytes(4).toString("hex")}`);
    const downloaded = await downloadThumbnail(coverUrl, base);
    return { path: downloaded || null, temporary: !!downloaded };
  } catch {
    return { path: null, temporary: false };
  }
}

function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function truncateUtf8(value, maxBytes) {
  const chars = Array.from(String(value || ""));
  while (chars.length && Buffer.byteLength(chars.join(""), "utf8") > maxBytes) chars.pop();
  return chars.join("");
}

function safeRetagBasename(value, fallback = "track") {
  let safe = sanitizeFilename(String(value || ""), "_")
    .replace(/[\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!safe) safe = sanitizeFilename(fallback, "_") || "track";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) safe = `_${safe}`;
  return truncateUtf8(safe, 220) || "track";
}

export function buildRetagFilename(filePath, metadata = {}) {
  const parsed = path.parse(filePath);
  const artist = firstText(metadata.artist || metadata.album_artist || metadata.uploader);
  const title = firstText(metadata.track || metadata.title);
  const parts = [];

  if (artist) parts.push(artist);
  if (title) parts.push(title);

  const basename = safeRetagBasename(parts.join(" - "), parsed.name);
  return `${basename}${parsed.ext}`;
}

function uniqueRenameTarget(filePath, desiredPath) {
  if (!fs.existsSync(desiredPath)) return { targetPath: desiredPath, collision: false };

  const sourceResolved = path.resolve(filePath);
  const desiredResolved = path.resolve(desiredPath);
  const isWindowsCaseOnly = process.platform === "win32" &&
    sourceResolved.toLowerCase() === desiredResolved.toLowerCase();
  if (sourceResolved === desiredResolved || isWindowsCaseOnly) {
    return { targetPath: desiredPath, collision: false };
  }

  const parsed = path.parse(desiredPath);
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const suffixText = ` (${suffix})`;
    const basename = truncateUtf8(parsed.name, Math.max(32, 220 - Buffer.byteLength(suffixText)));
    const candidate = path.join(parsed.dir, `${basename}${suffixText}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return { targetPath: candidate, collision: true };
  }
  throw new Error(`A unique filename could not be created for ${path.basename(desiredPath)}`);
}

export function renameRetaggedFile(filePath, metadata = {}) {
  const desiredName = buildRetagFilename(filePath, metadata);
  const desiredPath = path.join(path.dirname(filePath), desiredName);
  if (path.resolve(filePath) === path.resolve(desiredPath)) {
    return { path: filePath, renamed: false, collision: false };
  }

  const { targetPath, collision } = uniqueRenameTarget(filePath, desiredPath);
  const caseOnlyOnWindows = process.platform === "win32" &&
    path.resolve(filePath).toLowerCase() === path.resolve(targetPath).toLowerCase();

  if (caseOnlyOnWindows) {
    const tempPath = path.join(
      path.dirname(filePath),
      `.gharmonize-rename-${crypto.randomBytes(6).toString("hex")}${path.extname(filePath)}`
    );
    fs.renameSync(filePath, tempPath);
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      try { fs.renameSync(tempPath, filePath); } catch {}
      throw error;
    }
  } else {
    fs.renameSync(filePath, targetPath);
  }

  return { path: targetPath, renamed: true, collision };
}

export function scanRetaggableFiles(directoryPath) {
  const files = [];
  const pending = [directoryPath];

  while (pending.length) {
    const current = pending.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(abs);
      } else if (entry.isFile() && RETAGGABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(abs);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

export async function processRetagDirectoryJob(job, { directoryPath, tempRoot }) {
  const jobTempDir = path.join(tempRoot, job.id);

  try {
    job.status = "processing";
    job.currentPhase = "converting";
    job.downloadProgress = 100;
    job.convertProgress = 0;
    job.progress = 0;

    const files = scanRetaggableFiles(directoryPath);
    if (!files.length) {
      throw new Error("No supported music files were found in the selected directory");
    }

    job.playlist = { total: files.length, done: 0, converted: 0 };
    job.counters = { dlTotal: files.length, dlDone: files.length, cvTotal: files.length, cvDone: 0 };
    job.metadata.retagStats = {
      total: files.length,
      tagged: 0,
      failed: 0,
      onlineMatched: 0,
      existingOnly: 0,
      coversUpdated: 0,
      renamed: 0,
      unchangedNames: 0,
      nameCollisions: 0,
      providers: {}
    };
    job.lastLog = `🏷️ ${files.length} file(s) found. Retagging started.`;

    for (let index = 0; index < files.length; index += 1) {
      if (job.canceled || job.status === "canceled") break;

      const filePath = files[index];
      const fileName = path.basename(filePath);
      job.lastLog = `🏷️ Retagging: ${fileName}`;
      let cover = { path: null, temporary: false };

      try {
        const parsed = await parseFile(filePath, { duration: true, skipCovers: true });
        const existingMeta = metadataFromParsed(filePath, parsed, directoryPath);
        const onlineResult = await resolveOnlineMetadata(existingMeta);
        const metadata = onlineResult
          ? mergePresent(existingMeta, onlineResult.metadata)
          : existingMeta;
        cover = await resolveCover(filePath, metadata, jobTempDir, index);

        const result = await retagMediaFile(
          filePath,
          path.extname(filePath).slice(1),
          metadata,
          cover.path,
          {
            jobId: job.id,
            tempDir: jobTempDir,
            onProcess: (child) => registerJobProcess(job.id, child)
          }
        );

        if (!result) throw new Error("The media tags could not be rewritten");
        const renameResult = renameRetaggedFile(result, metadata);
        job.metadata.retagStats.tagged += 1;
        if (onlineResult) {
          job.metadata.retagStats.onlineMatched += 1;
          const provider = onlineResult.source || "online";
          job.metadata.retagStats.providers[provider] =
            Number(job.metadata.retagStats.providers[provider] || 0) + 1;
        } else {
          job.metadata.retagStats.existingOnly += 1;
        }
        if (cover.path) job.metadata.retagStats.coversUpdated += 1;
        if (renameResult.renamed) job.metadata.retagStats.renamed += 1;
        else job.metadata.retagStats.unchangedNames += 1;
        if (renameResult.collision) job.metadata.retagStats.nameCollisions += 1;
        const sourceLabel = onlineResult?.source || "existing tags";
        const renamedLabel = renameResult.renamed
          ? `${fileName} → ${path.basename(renameResult.path)}`
          : fileName;
        job.lastLog = `✅ Retagged (${sourceLabel}): ${renamedLabel}`;
      } catch (error) {
        if (job.canceled || job.status === "canceled") break;
        job.metadata.retagStats.failed += 1;
        job.errorsCount = job.metadata.retagStats.failed;
        job.lastLog = `⚠️ Retag failed: ${fileName} — ${error?.message || error}`;
      } finally {
        if (cover.temporary) safeUnlink(cover.path);
      }

      const done = index + 1;
      const progress = Math.floor((done / files.length) * 100);
      job.playlist.done = done;
      job.playlist.converted = done;
      job.counters.cvDone = done;
      job.convertProgress = progress;
      job.progress = progress;
    }

    if (job.canceled || job.status === "canceled") {
      job.currentPhase = "canceled";
      return job;
    }

    job.progress = 100;
    job.downloadProgress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    const stats = job.metadata.retagStats;
    job.lastLog = `✅ Retagging completed: ${stats.tagged}/${files.length} • online ${stats.onlineMatched} • covers ${stats.coversUpdated} • renamed ${stats.renamed}`;
    markJobCompleted(job);
    return job;
  } catch (error) {
    if (job.canceled || job.status === "canceled") return job;
    job.status = "error";
    job.currentPhase = "error";
    job.error = error?.message || String(error);
    job.lastLog = `❌ Retagging failed: ${job.error}`;
    return job;
  } finally {
    try { fs.rmSync(jobTempDir, { recursive: true, force: true }); } catch {}
  }
}

export { RETAGGABLE_EXTENSIONS };
