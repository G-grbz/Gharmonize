import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { FFMPEG_BIN } from "./binaries.js";
import { probeMediaFile } from "./probe.js";
import { queueOwnershipFix } from "./fsOwnership.js";
import { markJobCompleted, registerJobProcess } from "./store.js";
import { sanitizeFilename } from "./utils.js";
import { toDownloadPath } from "./outputPaths.js";

export const TRACK_EXTRACTOR_VIDEO_EXTS = new Set([
  ".mkv",
  ".mk3d",
  ".webm",
  ".mp4",
  ".m4v",
  ".mov",
  ".avi",
  ".ts",
  ".m2ts",
  ".mts",
  ".mpg",
  ".mpeg",
  ".wmv"
]);

const LANGUAGE_ALIASES = new Map(Object.entries({
  en: "eng",
  eng: "eng",
  english: "eng",
  tr: "tur",
  tur: "tur",
  turkish: "tur",
  de: "deu",
  deu: "deu",
  ger: "deu",
  german: "deu",
  fr: "fra",
  fre: "fra",
  fra: "fra",
  french: "fra",
  es: "spa",
  spa: "spa",
  spanish: "spa",
  it: "ita",
  ita: "ita",
  italian: "ita",
  ja: "jpn",
  jp: "jpn",
  jpn: "jpn",
  japanese: "jpn",
  ko: "kor",
  kor: "kor",
  korean: "kor",
  ru: "rus",
  rus: "rus",
  russian: "rus",
  ar: "ara",
  ara: "ara",
  arabic: "ara",
  und: "und"
}));

const AUDIO_EXT_BY_CODEC = new Map(Object.entries({
  ac3: "ac3",
  eac3: "eac3",
  dts: "dts",
  dca: "dts",
  truehd: "thd",
  mlp: "mlp",
  aac: "aac",
  mp3: "mp3",
  mp2: "mp2",
  flac: "flac",
  alac: "m4a",
  opus: "opus",
  vorbis: "ogg",
  wavpack: "wv",
  pcm_s16le: "wav",
  pcm_s24le: "wav",
  pcm_s32le: "wav",
  pcm_f32le: "wav"
}));

const SUBTITLE_EXT_BY_CODEC = new Map(Object.entries({
  subrip: "srt",
  ass: "ass",
  ssa: "ssa",
  webvtt: "vtt",
  mov_text: "srt",
  hdmv_pgs_subtitle: "sup",
  dvd_subtitle: "sub",
  dvb_subtitle: "dvbsub",
  xsub: "sub"
}));

const VIDEO_EXT_BY_CODEC = new Map(Object.entries({
  h264: "h264",
  hevc: "h265",
  av1: "ivf",
  vp9: "ivf",
  vp8: "ivf",
  mpeg4: "m4v",
  mpeg2video: "m2v",
  mpeg1video: "m1v",
  prores: "mov",
  ffv1: "mkv"
}));

const IMAGE_EXT_BY_CODEC = new Map(Object.entries({
  mjpeg: "jpg",
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  bmp: "bmp",
  tiff: "tiff",
  gif: "gif"
}));

const IMAGE_EXT_BY_MIME = new Map(Object.entries({
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/gif": "gif"
}));

const IMAGE_FILE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".gif"
]);

const CHAPTERS_TRACK_INDEX = -1;

function sanitizeSegment(value, fallback = "track") {
  const cleaned = sanitizeFilename(String(value || ""), "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 120);
  return cleaned || fallback;
}

function normalizeLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "und";
  const simple = raw.replace(/[^a-z0-9_-]+/g, "");
  const primary = simple.split(/[-_]/)[0] || simple;
  const mapped = LANGUAGE_ALIASES.get(primary) || LANGUAGE_ALIASES.get(simple);
  if (mapped) return mapped;
  if (/^[a-z]{3}$/.test(primary)) return primary;
  if (/^[a-z]{2}$/.test(primary)) return primary;
  const compact = primary.replace(/[^a-z0-9]+/g, "");
  return compact ? compact.slice(0, 8) : "und";
}

function parseFrameRateValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.includes("/")) {
    const [numRaw, denRaw] = raw.split("/", 2);
    const num = Number(numRaw);
    const den = Number(denRaw);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      const fps = num / den;
      return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : null;
    }
    return null;
  }
  const fps = Number(raw);
  return Number.isFinite(fps) && fps > 0 ? Number(fps.toFixed(3)) : null;
}

function pickStreamFps(stream) {
  return parseFrameRateValue(stream?.avg_frame_rate) ?? parseFrameRateValue(stream?.r_frame_rate);
}

function hasDisposition(stream, key) {
  return Number(stream?.disposition?.[key]) === 1;
}

function getTagValue(tags, names) {
  if (!tags || typeof tags !== "object") return "";
  const wanted = new Set(names.map((name) => String(name).toLowerCase()));
  for (const [key, value] of Object.entries(tags)) {
    if (wanted.has(String(key).toLowerCase()) && value != null) {
      return String(value);
    }
  }
  return "";
}

function collectSubtitleMarkerText(stream) {
  const tags = stream?.tags && typeof stream.tags === "object"
    ? Object.values(stream.tags).filter(Boolean).join(" ")
    : "";
  return String(tags || "").toLowerCase();
}

function hasMarker(text, marker) {
  return new RegExp(`(^|[^a-z0-9])${marker}([^a-z0-9]|$)`, "i").test(text);
}

function pickSubtitleNamePrefix(stream) {
  const text = collectSubtitleMarkerText(stream);

  if (hasDisposition(stream, "forced") || hasMarker(text, "forced")) {
    return "forced";
  }

  if (
    hasDisposition(stream, "hearing_impaired") ||
    hasDisposition(stream, "captions") ||
    hasMarker(text, "sdh") ||
    hasMarker(text, "cc") ||
    hasMarker(text, "hi") ||
    /hearing[^a-z0-9]+impaired/i.test(text) ||
    /hard[^a-z0-9]+of[^a-z0-9]+hearing/i.test(text) ||
    hasMarker(text, "deaf") ||
    /closed[^a-z0-9]+captions?/i.test(text)
  ) {
    return "sdh";
  }

  return "";
}

export function isSupportedTrackSourcePath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  return TRACK_EXTRACTOR_VIDEO_EXTS.has(ext);
}

function pickTrackExtension(type, codec) {
  const key = String(codec || "").toLowerCase();
  if (type === "audio") return AUDIO_EXT_BY_CODEC.get(key) || "mka";
  if (type === "subtitle") return SUBTITLE_EXT_BY_CODEC.get(key) || "mks";
  if (type === "video") return VIDEO_EXT_BY_CODEC.get(key) || "mkv";
  if (type === "image") return IMAGE_EXT_BY_CODEC.get(key) || "bin";
  if (type === "chapters") return "txt";
  return "bin";
}

function pickImageExtension(stream) {
  const filename = getTagValue(stream?.tags, ["filename", "file_name", "name"]);
  const filenameExt = path.extname(filename).toLowerCase();
  if (IMAGE_FILE_EXTS.has(filenameExt)) {
    return filenameExt.replace(/^\./, "").replace(/^jpeg$/i, "jpg").replace(/^tif$/i, "tiff");
  }

  const mime = getTagValue(stream?.tags, ["mimetype", "mime_type", "content_type"]).toLowerCase();
  const mimeExt = IMAGE_EXT_BY_MIME.get(mime);
  if (mimeExt) return mimeExt;

  return IMAGE_EXT_BY_CODEC.get(String(stream?.codec_name || "").toLowerCase()) || "bin";
}

function isImageAttachmentStream(stream) {
  const type = String(stream?.codec_type || "").toLowerCase();
  const codec = String(stream?.codec_name || "").toLowerCase();
  const mime = getTagValue(stream?.tags, ["mimetype", "mime_type", "content_type"]).toLowerCase();
  const filename = getTagValue(stream?.tags, ["filename", "file_name", "name"]);
  const filenameExt = path.extname(filename).toLowerCase();

  if (type === "video" && hasDisposition(stream, "attached_pic")) return true;
  if (type !== "attachment") return false;
  return (
    mime.startsWith("image/") ||
    IMAGE_EXT_BY_CODEC.has(codec) ||
    IMAGE_FILE_EXTS.has(filenameExt)
  );
}

function pickImageOutputStem(stream) {
  const filename = getTagValue(stream?.tags, ["filename", "file_name", "name"]);
  const filenameStem = path.basename(filename || "", path.extname(filename || ""));
  if (filenameStem) return sanitizeSegment(filenameStem, "image");

  const title = getTagValue(stream?.tags, ["title"]);
  if (title) return sanitizeSegment(title, "image");

  if (hasDisposition(stream, "attached_pic")) return "cover";
  return `image_${Number.isFinite(Number(stream?.index)) ? Number(stream.index) : "track"}`;
}

function toTrackInfo(stream, { attachmentOrdinal = null } = {}) {
  const type = String(stream?.codec_type || "").toLowerCase();
  const isImage = isImageAttachmentStream(stream);
  if (!isImage && !["audio", "subtitle", "video"].includes(type)) return null;

  const codec = String(stream?.codec_name || "unknown").toLowerCase();
  const language = normalizeLanguage(stream?.tags?.language);
  const trackType = isImage ? "image" : type;
  const extension = isImage ? pickImageExtension(stream) : pickTrackExtension(trackType, codec);
  const subtitleNamePrefix = trackType === "subtitle" ? pickSubtitleNamePrefix(stream) : "";

  return {
    index: Number(stream?.index),
    type: trackType,
    codec,
    codecLong: stream?.codec_long_name || codec,
    language,
    title: stream?.tags?.title || "",
    default: stream?.disposition?.default === 1,
    forced: stream?.disposition?.forced === 1,
    attachedPic: hasDisposition(stream, "attached_pic"),
    mimeType: getTagValue(stream?.tags, ["mimetype", "mime_type", "content_type"]),
    originalFilename: getTagValue(stream?.tags, ["filename", "file_name", "name"]),
    attachmentOrdinal,
    imageExtractMode: type === "attachment" ? "attachment" : (isImage ? "stream" : ""),
    channels: stream?.channels || null,
    sampleRate: stream?.sample_rate || null,
    bitRate: stream?.bit_rate || null,
    width: stream?.width || null,
    height: stream?.height || null,
    fps: pickStreamFps(stream),
    outputStem: isImage ? pickImageOutputStem(stream) : "",
    subtitleNamePrefix,
    extension
  };
}

function toChaptersTrack(chapters) {
  const usableChapters = Array.isArray(chapters)
    ? chapters.filter((chapter) => Number.isFinite(Number(chapter?.start)) && Number.isFinite(Number(chapter?.end)))
    : [];
  if (!usableChapters.length) return null;

  return {
    index: CHAPTERS_TRACK_INDEX,
    type: "chapters",
    codec: "ffmetadata",
    codecLong: "Chapters",
    language: "und",
    title: "Chapters",
    chapterCount: usableChapters.length,
    chapters: usableChapters,
    outputStem: "chapters",
    extension: "txt"
  };
}

function buildTrackOutputStem(track) {
  if (track.outputStem) {
    return sanitizeSegment(track.outputStem, "track");
  }
  const base = sanitizeSegment(track.language || "und", "und");
  const prefix = track.type === "subtitle"
    ? sanitizeSegment(track.subtitleNamePrefix || "", "")
    : "";
  return prefix ? `${base}.${prefix}` : base;
}

function addNameCollisionSuffix(fileName, count) {
  const ext = path.extname(fileName);
  const stem = ext ? fileName.slice(0, -ext.length) : fileName;
  return `${stem}_${count}${ext}`;
}

export function attachSuggestedNames(tracks) {
  const seen = new Map();
  return tracks.map((track) => {
    const base = buildTrackOutputStem(track);
    const ext = sanitizeSegment(track.extension || "bin", "bin").toLowerCase();
    const preferredName = `${base}.${ext}`;
    const key = preferredName.toLowerCase();
    const nextCount = (seen.get(key) || 0) + 1;
    const outputName = nextCount === 1
      ? preferredName
      : addNameCollisionSuffix(preferredName, nextCount);
    seen.set(key, nextCount);
    return { ...track, outputName };
  });
}

export async function inspectTrackSource(sourcePath) {
  const abs = path.resolve(String(sourcePath || ""));
  if (!abs) throw new Error("Source path is required");
  if (!isSupportedTrackSourcePath(abs)) {
    throw new Error("Unsupported video file type");
  }
  if (!fs.existsSync(abs)) {
    throw new Error("Source file not found");
  }
  if (!fs.statSync(abs).isFile()) {
    throw new Error("Source path is not a file");
  }

  const probeData = await probeMediaFile(abs);
  const streams = Array.isArray(probeData?.streams) ? probeData.streams : [];
  let attachmentOrdinal = 0;
  const streamTracks = streams
    .map((stream) => {
      const currentAttachmentOrdinal = String(stream?.codec_type || "").toLowerCase() === "attachment"
        ? attachmentOrdinal
        : null;
      if (currentAttachmentOrdinal != null) attachmentOrdinal += 1;
      return toTrackInfo(stream, { attachmentOrdinal: currentAttachmentOrdinal });
    })
    .filter((track) => track && Number.isFinite(track.index))
    .sort((a, b) => a.index - b.index);
  const chaptersTrack = toChaptersTrack(probeData?.chapters);
  const tracks = attachSuggestedNames(chaptersTrack ? [...streamTracks, chaptersTrack] : streamTracks);

  return {
    sourcePath: abs,
    fileName: path.basename(abs),
    baseName: path.basename(abs, path.extname(abs)),
    tracks,
    format: probeData?.format || {}
  };
}

export function selectTracksByIndex(allTracks, requestedIndexes) {
  const indexes = Array.isArray(requestedIndexes)
    ? requestedIndexes.map((value) => Number(value)).filter(Number.isFinite)
    : [];
  const wanted = new Set(indexes);
  return allTracks.filter((track) => wanted.has(Number(track.index)));
}

export function buildTrackExtractorOutputSubdir(sourcePath, jobId) {
  const baseName = path.basename(String(sourcePath || "video"), path.extname(String(sourcePath || "")));
  const safeBase = sanitizeSegment(baseName, "video");
  const shortId = sanitizeSegment(String(jobId || Date.now()).replace(/^job_/, "").slice(0, 8), "job");
  return path.posix.join("track-extractor", `${safeBase}_${shortId}`);
}

function buildFfmpegExtractArgs(sourcePath, track, outputPath) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    sourcePath,
    "-map",
    `0:${track.index}`,
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1"
  ];

  if (track.type === "subtitle" && track.codec === "mov_text") {
    args.push("-c:s", "srt");
  } else if (track.type === "video") {
    args.push("-c:v", "copy");
    if (track.codec === "h264") args.push("-bsf:v", "h264_mp4toannexb");
    if (track.codec === "hevc") args.push("-bsf:v", "hevc_mp4toannexb");
  } else if (track.type === "image") {
    args.push("-c:v", "copy", "-frames:v", "1");
  } else if (track.type === "audio") {
    args.push("-c:a", "copy");
  } else if (track.type === "subtitle") {
    args.push("-c:s", "copy");
  } else {
    args.push("-c", "copy");
  }

  args.push(outputPath);
  return args;
}

function runFfmpegExtract(job, sourcePath, track, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpegBin = FFMPEG_BIN || "ffmpeg";
    const args = buildFfmpegExtractArgs(sourcePath, track, outputPath);
    const child = spawn(ffmpegBin, args, { windowsHide: true });
    registerJobProcess(job.id, child);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (job.canceled || job.status === "canceled") {
        reject(new Error("Extraction canceled"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-4).join(" / ")}` : "";
      reject(new Error(`ffmpeg exited with code ${code}${signal ? ` (${signal})` : ""}${detail}`));
    });
  });
}

function runFfmpegDumpAttachment(job, sourcePath, track, outputPath) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(Number(track.attachmentOrdinal))) {
      reject(new Error("Attachment ordinal is missing"));
      return;
    }

    const ffmpegBin = FFMPEG_BIN || "ffmpeg";
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      `-dump_attachment:t:${Number(track.attachmentOrdinal)}`,
      outputPath,
      "-i",
      sourcePath,
      "-f",
      "null",
      "-"
    ];
    const child = spawn(ffmpegBin, args, { windowsHide: true });
    registerJobProcess(job.id, child);

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (job.canceled || job.status === "canceled") {
        reject(new Error("Extraction canceled"));
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }
      const detail = stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-4).join(" / ")}` : "";
      reject(new Error(`ffmpeg exited with code ${code}${signal ? ` (${signal})` : ""}${detail}`));
    });
  });
}

function parseChapterTimeBase(value) {
  const raw = String(value || "").trim();
  if (!/^\d+\/\d+$/.test(raw)) return 0;
  const [numRaw, denRaw] = raw.split("/", 2);
  const num = Number(numRaw);
  const den = Number(denRaw);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return 0;
  return num / den;
}

function pickChapterStartSeconds(chapter) {
  const startTime = Number(chapter?.start_time);
  if (Number.isFinite(startTime) && startTime >= 0) return startTime;

  const start = Number(chapter?.start);
  const timeBase = parseChapterTimeBase(chapter?.time_base);
  if (Number.isFinite(start) && start >= 0 && timeBase > 0) {
    return start * timeBase;
  }

  return 0;
}

function formatChapterTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const m = totalMinutes % 60;
  const h = Math.floor(totalMinutes / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function sanitizeChapterTitle(value, fallback) {
  const title = String(value || "")
    .replace(/\r?\n/g, " ")
    .trim();
  return title || fallback;
}

function formatChaptersAsOgmText(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  const lines = [];

  list.forEach((chapter, index) => {
    const tags = chapter?.tags && typeof chapter.tags === "object" ? chapter.tags : {};
    const number = String(index + 1).padStart(2, "0");
    const title = sanitizeChapterTitle(tags.title, `Chapter ${index + 1}`);

    lines.push(`CHAPTER${number}=${formatChapterTimestamp(pickChapterStartSeconds(chapter))}`);
    lines.push(`CHAPTER${number}NAME=${title}`);
  });

  return `${lines.join("\n")}\n`;
}

async function writeChaptersFile(track, outputPath) {
  const chapters = Array.isArray(track?.chapters) ? track.chapters : [];
  if (!chapters.length) {
    throw new Error("No chapters found");
  }
  await fs.promises.writeFile(outputPath, formatChaptersAsOgmText(chapters), "utf8");
}

async function extractSingleTrack(job, sourcePath, track, outputPath) {
  if (track.type === "chapters") {
    await writeChaptersFile(track, outputPath);
    return;
  }

  if (track.type === "image" && track.imageExtractMode === "attachment") {
    await runFfmpegDumpAttachment(job, sourcePath, track, outputPath);
    return;
  }

  await runFfmpegExtract(job, sourcePath, track, outputPath);
}

export async function extractTracksForJob(job, {
  sourcePath,
  tracks,
  outputDir,
  outputRootDir
}) {
  const selectedTracks = Array.isArray(tracks) ? tracks : [];
  if (!selectedTracks.length) throw new Error("No tracks selected");

  fs.mkdirSync(outputDir, { recursive: true });
  await queueOwnershipFix(outputDir, { recursive: true });

  job.status = "processing";
  job.currentPhase = "extracting";
  job.progress = 0;
  job.downloadProgress = 100;
  job.convertProgress = 0;
  job.counters = {
    ...(job.counters || {}),
    dlTotal: 0,
    dlDone: 0,
    cvTotal: selectedTracks.length,
    cvDone: 0
  };

  const results = [];

  try {
    for (let i = 0; i < selectedTracks.length; i += 1) {
      if (job.canceled || job.status === "canceled") throw new Error("Extraction canceled");

      const track = selectedTracks[i];
      const outputName = sanitizeSegment(track.outputName, `track_${track.index}.${track.extension}`);
      const outputPath = path.join(outputDir, outputName);
      job.lastLog = `Extracting ${outputName}`;
      job.metadata.currentTrack = {
        index: track.index,
        type: track.type,
        codec: track.codec,
        language: track.language,
        outputName
      };

      await extractSingleTrack(job, sourcePath, track, outputPath);
      if (!fs.existsSync(outputPath)) {
        throw new Error(`Extraction completed but output was not created: ${outputName}`);
      }
      await queueOwnershipFix(outputPath);

      const downloadPath = toDownloadPath(outputPath, outputRootDir);
      results.push({
        outputPath: downloadPath || outputPath,
        path: downloadPath || outputPath,
        filename: outputName,
        type: track.type,
        codec: track.codec,
        language: track.language,
        streamIndex: track.type === "chapters" ? null : track.index,
        chapterCount: track.chapterCount || null,
        mimeType: track.mimeType || null
      });

      job.counters.cvDone = i + 1;
      job.convertProgress = Math.floor(((i + 1) / selectedTracks.length) * 100);
      job.progress = job.convertProgress;
    }

    job.resultPath = results;
    job.progress = 100;
    job.convertProgress = 100;
    job.currentPhase = "completed";
    job.lastLog = "Track extraction completed";
    markJobCompleted(job);
    return results;
  } catch (error) {
    if (job.canceled || job.status === "canceled" || /canceled/i.test(error?.message || "")) {
      job.canceled = true;
      job.status = "canceled";
      job.currentPhase = "canceled";
      job.error = null;
      job.lastLog = "Track extraction canceled";
      return results;
    }

    job.status = "error";
    job.currentPhase = "error";
    job.error = error?.message || "Track extraction failed";
    job.lastLog = job.error;
    throw error;
  }
}
