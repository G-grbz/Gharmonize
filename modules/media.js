import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import fetch from "node-fetch";
import { sanitizeFilename, findOnPATH, isExecutable } from "./utils.js";
import { attachLyricsToMedia } from "./lyrics.js";
import { jobs } from "./store.js";
import "dotenv/config";
import { FFMPEG_BIN as BINARY_FFMPEG_BIN } from "./binaries.js";
import { getFfmpegCaps } from "./ffmpegCaps.js";

function getOptimalEncoderParams(codec, hardware, quality = 'medium') {
    const params = {
        'h264': {
            'software': { preset: 'medium', tune: 'film', crf: '23' },
            'nvenc': { preset: 'p7', tune: 'hq', cq: '23' },
            'qsv': { preset: 'medium', quality: '23' },
            'vaapi': { quality: '23' }
        },
        'h265': {
            'software': { preset: 'medium', crf: '28' },
            'nvenc': { preset: 'p7', cq: '28' },
            'qsv': { preset: 'medium', quality: '28' },
            'vaapi': { quality: '28' }
        },
        'av1': {
            'software': { cpuUsed: '4', rowMt: '1', crf: '30' },
            'nvenc': { preset: 'p7', cq: '30' },
            'qsv': { preset: 'medium', quality: '30' },
            'vaapi': { quality: '30' }
        },
        'vp9': {
            'software': { cpuUsed: '2', rowMt: '1', crf: '31' },
            'vaapi': { quality: '31' }
        }
    };
    return params[codec]?.[hardware] || params['h264'][hardware] || params['h264']['software'];
}

function normalizeNvencPresetAndTune(rawPreset) {
  const v = String(rawPreset || "").trim().toLowerCase();

  if (/^p[1-7]$/.test(v)) return { preset: v, tune: null };

  if (["hq", "ll", "ull", "lossless"].includes(v)) {
    return { preset: "p4", tune: v };
  }

  const legacyMap = {
    slow: "p7",
    medium: "p5",
    fast: "p3",
    hp: "p3",
    hq: "p5",
    bd: "p5",
    ll: "p4",
    llhq: "p5",
    llhp: "p3",
    lossless: "p4",
    losslesshp: "p3"
  };

  if (legacyMap[v]) return { preset: legacyMap[v], tune: null };
  return { preset: "p4", tune: null };
}

const PRESET_ORDER = [
  "ultrafast",
  "superfast",
  "veryfast",
  "faster",
  "fast",
  "medium",
  "slow",
  "slower",
  "veryslow"
];

function normalizeSwPreset(p) {
  const v = String(p || "").trim().toLowerCase();
  return PRESET_ORDER.includes(v) ? v : "veryfast";
}

function presetRank(p) {
  const v = normalizeSwPreset(p);
  const idx = PRESET_ORDER.indexOf(v);
  return idx >= 0 ? idx : 2;
}

function presetToAomCpuUsed(p) {
  const r = presetRank(p);
  return Math.max(0, Math.min(8, 8 - r));
}

function presetToSvtPreset(p) {
  const map = {
    ultrafast: 12,
    superfast: 11,
    veryfast:  10,
    faster:    9,
    fast:      8,
    medium:    7,
    slow:      6,
    slower:    5,
    veryslow:  4
  };
  return map[normalizeSwPreset(p)] ?? 10;
}

function presetToVp9CpuUsed(p) {
  return presetToAomCpuUsed(p);
}

function presetToVp9Deadline(p) {
  const r = presetRank(p);
  if (r <= 2) return "realtime";
  if (r <= 5) return "good";
  return "best";
}

function resolveFfmpegBin() {
  const isWin = process.platform === "win32";
  const exe = isWin ? "ffmpeg.exe" : "ffmpeg";
  const fromEnvFile = process.env.FFMPEG_BIN || process.env.FFMPEG_PATH;
  if (fromEnvFile && isExecutable(fromEnvFile)) {
    return fromEnvFile;
  }

  if (process.env.FFMPEG_DIR) {
    const candidate = path.join(process.env.FFMPEG_DIR, exe);
    if (isExecutable(candidate)) return candidate;
  }

  if (BINARY_FFMPEG_BIN && isExecutable(BINARY_FFMPEG_BIN)) {
    return BINARY_FFMPEG_BIN;
  }

  const fromPATH = findOnPATH(exe);
  if (fromPATH && isExecutable(fromPATH)) {
    return fromPATH;
  }

  const guesses = isWin
    ? [
        "C:\\tools\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\ffmpeg\\bin\\ffmpeg.exe",
        "C:\\tools\\yt-dlp\\ffmpeg.exe",
        "C:\\Windows\\ffmpeg.exe"
      ]
    : ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg"];

  if (process.resourcesPath) {
    const packed = path.join(process.resourcesPath, "bin", exe);
    guesses.unshift(packed);
  }

  for (const g of guesses) {
    if (isExecutable(g)) return g;
  }

  return exe;
}

function emitLog(onLog, payload) {
  if (payload?.fallback) console.log(payload.fallback);
  if (onLog) onLog(payload);
}

export function resolveTemplate(meta, template) {
  const pick = (a, b) =>
    (meta[a] || "").toString().trim() || (meta[b] || "").toString().trim();
  return template
    .replace(/%\(([^)]+)\)s/g, (_, keyExpr) => {
      if (keyExpr.includes("|")) {
        const [a, b] = keyExpr.split("|").map((s) => s.trim());
        return pick(a, b) || "";
      }
      const v = (meta[keyExpr] || "").toString().trim();
      return v || "";
    })
    .replace(/\s+-\s+/g, " - ")
    .replace(/^\s*-\s+/, "")
    .replace(/\s+-\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function maybeCleanTitle(t) {
  if (!t) return t;
  if (process.env.TITLE_CLEAN_PIPE === "1") {
    const parts = t.split("|").map((s) => s.trim());
    if (parts.length > 1) return parts.at(-1);
  }
  return t;
}

function cleanTitleForTags(t) {
  if (!t) return t;
  let s = String(t).trim();

  s = s.replace(/\s*_\s*/g, " ");
  s = s.replace(/\s*(?:_+\s*)+$/, "");
  s = s.replace(/\s*(?:[-–—•]\s*)+$/, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

export async function downloadThumbnail(thumbnailUrl, destBasePathNoExt) {
  if (!thumbnailUrl) return null;
  try {
    const res = await fetch(thumbnailUrl);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    let ext = ".jpg";
    if (ct.includes("image/webp")) ext = ".webp";
    else if (ct.includes("image/png")) ext = ".png";
    else if (ct.includes("jpeg")) ext = ".jpg";
    const destPath = `${destBasePathNoExt}${ext}`;
    fs.writeFileSync(destPath, Buffer.from(buf));
    return destPath;
  } catch {
    return null;
  }
}

export async function ensureJpegCover(
  coverPath,
  jobId,
  tempDir,
  ffmpegFromCaller = null
) {
  try {
    if (!coverPath || !fs.existsSync(coverPath)) return null;

    const ext = path.extname(coverPath).toLowerCase();
    if ([".jpg", ".jpeg"].includes(ext)) return coverPath;

    const ffmpegBin = ffmpegFromCaller || resolveFfmpegBin();

    let outDir = path.dirname(coverPath);
    if (!outDir || outDir === "." || !path.isAbsolute(outDir)) {
      outDir = tempDir || process.cwd();
    }

    const baseName = path.basename(coverPath, ext);
    const outJpg = path.join(outDir, `${baseName}.norm.jpg`);

    await new Promise((resolve, reject) => {
      const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", coverPath, outJpg];
      const p = spawn(ffmpegBin, args);
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) =>
        code === 0 && fs.existsSync(outJpg)
          ? resolve()
          : reject(new Error(`Cover conversion failed (code ${code}): ${err}`))
      );
      p.on("error", (e) =>
        reject(new Error(`Failed to start ffmpeg: ${e.message}`))
      );
    });

    return outJpg;
  } catch (e) {
    console.warn("⚠️ Cover conversion warning:", e.message);
    return null;
  }
}

const getCommentText = () => {
  if (process.env.MEDIA_COMMENT) return process.env.MEDIA_COMMENT;
  if (process.env.COMMENT_TEXT) return process.env.COMMENT_TEXT;
  return "Gharmonize";
};

const VIDEO_HWACCEL = (process.env.VIDEO_HWACCEL || "off").toLowerCase();
const NVENC_PRESET  = process.env.NVENC_PRESET  || "fast";
const NVENC_Q       = process.env.NVENC_Q       || "23";
const QSV_PRESET    = process.env.QSV_PRESET    || "veryfast";
const QSV_Q         = process.env.QSV_Q         || "23";
const VAAPI_DEVICE  = process.env.VAAPI_DEVICE  || "/dev/dri/renderD128";
const VAAPI_QUALITY = process.env.VAAPI_QUALITY || "23";

function commentKeyFor(fmt) {
  const f = String(fmt || "").toLowerCase();
  if (f === "flac" || f === "ogg") return "DESCRIPTION";
  if (f === "mp4" || f === "m4a") return "comment";
  if (f === "mp3") return "comment";
  if (f === "eac3" || f === "ac3") return "comment";
  if (f === "aac") return "comment";
  return "comment";
}

function buildCommonMetaPairs(resolvedMeta, format) {
  const baseNumbers = {
    track_number: resolvedMeta.track_number ?? null,
    track_total:  resolvedMeta.track_total  ?? null,
    disc_number:  resolvedMeta.disc_number  ?? null,
    disc_total:   resolvedMeta.disc_total   ?? null
  };

  const tn   = Number(baseNumbers.track_number) || null;
  const ttot = Number(baseNumbers.track_total)  || null;
  const dn   = Number(baseNumbers.disc_number)  || null;
  const dtot = Number(baseNumbers.disc_total)   || null;
  const trackTag = tn ? (ttot ? `${tn}/${ttot}` : String(tn)) : "";
  const discTag  = dn ? (dtot ? `${dn}/${dtot}` : String(dn)) : "";
  const dateTag =
    resolvedMeta.release_date &&
    /^\d{4}(-\d{2}(-\d{2})?)?$/.test(resolvedMeta.release_date)
      ? resolvedMeta.release_date
      : resolvedMeta.release_year || resolvedMeta.upload_date || "";

  const metaPairs = {
    title:  resolvedMeta.track || resolvedMeta.title || "",
    artist: resolvedMeta.artist || "",
    album:  resolvedMeta.album || resolvedMeta.playlist_title || "",
    date:   dateTag || "",
    track:  trackTag || "",
    disc:   discTag || "",
    genre:  resolvedMeta.genre || ""
  };

  if (resolvedMeta.album_artist) {
    metaPairs.album_artist = resolvedMeta.album_artist;
    metaPairs.ALBUMARTIST  = resolvedMeta.album_artist;
  }

  const labelLike = resolvedMeta.label || resolvedMeta.publisher;
  if (labelLike) {
    metaPairs.publisher = labelLike;
    metaPairs.PUBLISHER = labelLike;
  }

  if (resolvedMeta.copyright) {
    metaPairs.copyright = resolvedMeta.copyright;
    metaPairs.COPYRIGHT = resolvedMeta.copyright;
  }

  if (resolvedMeta.webpage_url) {
    metaPairs.URL = resolvedMeta.webpage_url;
  }

  return metaPairs;
}

function shouldSkipRetag(format) {
  const f = String(format || "").toLowerCase();
  return (f === "wav" || f === "aac" || f === "ac3" || f === "eac3");
}

export async function retagMediaFile(
  absOutputPath,
  format,
  metadata = {},
  coverPath = null,
  opts = {}
) {
  try {
    if (!absOutputPath || !fs.existsSync(absOutputPath)) return null;
    const f = String(format || path.extname(absOutputPath).slice(1) || "").toLowerCase();

    if (shouldSkipRetag(f)) {
      console.log(`ℹ️ retag skipped for format=${f} (container metadata limits) → ${path.basename(absOutputPath)}`);
      return null;
    }

    const ffmpegBin = opts?.ffmpegBin || resolveFfmpegBin();
    const tempDir = opts?.tempDir || path.dirname(absOutputPath);
    const jobId = opts?.jobId || "retag";
    const resolvedMeta = {
      ...metadata,
      title: cleanTitleForTags(maybeCleanTitle(metadata?.title)),
      track: cleanTitleForTags(metadata?.track),
    };

    let canEmbedCover = false;
    let coverToUse = null;
    const coverOkFormats = new Set(["mp3", "flac", "m4a", "mp4", "ogg"]);
    const preserveExistingCover = !coverPath && coverOkFormats.has(f);
    if (coverPath && coverOkFormats.has(f)) {
      try {
        coverToUse = await ensureJpegCover(coverPath, jobId, tempDir, ffmpegBin);
      } catch {}
      if (coverToUse && fs.existsSync(coverToUse)) canEmbedCover = true;
    }

    const COMMENT_KEY = commentKeyFor(f);
    const metaPairs = buildCommonMetaPairs(resolvedMeta, f);
    const ext = path.extname(absOutputPath) || `.${f}`;
    const base = absOutputPath.slice(0, -ext.length);
    const tmpOut = `${base}.retag.${crypto.randomBytes(4).toString("hex")}${ext}`;

    await new Promise((resolve, reject) => {
      const args = ["-hide_banner", "-nostdin", "-y", "-i", absOutputPath];
      if (canEmbedCover) args.push("-i", coverToUse);
      args.push("-map_metadata", "0");

    for (const [k, v] of Object.entries(metaPairs)) {
      if (v != null && String(v).length) args.push("-metadata", `${k}=${v}`);
    }

      const commentText = getCommentText();
      if (commentText) args.push("-metadata", `${COMMENT_KEY}=${commentText}`);
      if (resolvedMeta.isrc) args.push("-metadata", `ISRC=${resolvedMeta.isrc}`);
      if (resolvedMeta.webpage_url) args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);
      args.push("-map", "0:a");
      if (preserveExistingCover) {
        args.push("-map", "0:v?");
        args.push("-c:v", "copy");
        args.push("-disposition:v:0", "attached_pic");
      }

      if (canEmbedCover) {
        args.push(
          "-map", "1:v?",
          "-disposition:v", "attached_pic",
          "-metadata:s:v", "title=Album cover"
        );
        if (f === "mp3") args.push("-c:v", "mjpeg");
        else if (f === "flac") args.push("-c:v", "mjpeg");
        else if (f === "m4a" || f === "mp4") args.push("-c:v", "mjpeg");
        else if (f === "ogg") args.push("-c:v", "mjpeg");
      }
      args.push("-c:a", "copy");
      if (f === "mp3") {
        args.push("-id3v2_version", "3");
        if (process.env.WRITE_ID3V1 === "1") args.push("-write_id3v1", "1");
      }

      args.push(tmpOut);

      console.log("🏷️ FFmpeg retag args:", args.join(" "));
      const p = spawn(ffmpegBin, args);
      let err = "";
      p.stderr.on("data", (d) => (err += d.toString()));
      p.on("close", (code) => {
        if (code === 0 && fs.existsSync(tmpOut)) return resolve();
        const tail = String(err || "").split("\n").slice(-12).join("\n");
        return reject(new Error(`retag ffmpeg error (code ${code}): ${tail}`));
      });
      p.on("error", (e) => reject(new Error(`retag spawn error: ${e.message}`)));
    });

    try { fs.renameSync(tmpOut, absOutputPath); }
    catch {
      fs.copyFileSync(tmpOut, absOutputPath);
      try { fs.unlinkSync(tmpOut); } catch {}
    }

    console.log(`✅ retag ok: ${path.basename(absOutputPath)}`);
    return absOutputPath;
  } catch (e) {
    console.warn("⚠️ retag warning:", e?.message || e);
    return null;
  }
}

export async function convertMedia(
  inputPath,
  format,
  bitrate,
  jobId,
  progressCallback,
  metadata = {},
  coverPath = null,
  isVideo = false,
  outputDir,
  tempDir,
  opts = {}
) {
  const ffmpegFromOpts = opts?.ffmpegBin || null;
  const isCanceled =
  typeof opts.isCanceled === "function" ? () => !!opts.isCanceled() : () => false;

  const stereoConvert = opts?.stereoConvert || "auto";
  const atempoAdjust = opts?.atempoAdjust || "none";
  const bitDepth = opts?.bitDepth || null;
  const videoSettings = opts.videoSettings || {};
  const selectedStreams = opts.selectedStreams || null;

  let volumeGainRaw = null;
  if (opts?.volumeGain != null) {
    volumeGainRaw = opts.volumeGain;
  } else if (videoSettings?.volumeGain != null) {
    volumeGainRaw = videoSettings.volumeGain;
  } else if (metadata?.volumeGain != null) {
    volumeGainRaw = metadata.volumeGain;
  }

  const clampInt = (v, min, max) => {
   const n = Math.round(Number(v));
   if (!Number.isFinite(n)) return null;
   return Math.min(max, Math.max(min, n));
 };

  const clampNonNegInt = (v, fallback = 0) => {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
  };

  const normalizeHexColor = (c) => {
    const s = String(c || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(s)) return s;
    if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
    return '#000000';
  };

  const ensureVfAppend = (args, frag) => {
    if (!frag) return;
    const i = args.lastIndexOf("-vf");
    if (i !== -1 && typeof args[i + 1] === "string") {
      args[i + 1] = `${args[i + 1]},${frag}`;
    } else {
      args.push("-vf", frag);
    }
  };

  const buildOrientationFilter = (mode) => {
    const m = String(mode || 'auto').toLowerCase();
    if (m === '90cw') return "transpose=1";
    if (m === '90ccw') return "transpose=2";
    if (m === '180') return "transpose=2,transpose=2";
    if (m === 'hflip') return "hflip";
    if (m === 'vflip') return "vflip";
    return null;
  };

  const buildCropEdgesFilter = (settings) => {
    if (!settings?.cropEnabled) return null;
    const L = clampNonNegInt(settings.cropLeft, 0);
    const R = clampNonNegInt(settings.cropRight, 0);
    const T = clampNonNegInt(settings.cropTop, 0);
    const B = clampNonNegInt(settings.cropBottom, 0);
    if ((L + R + T + B) <= 0) return null;
    return `crop=in_w-${L + R}:in_h-${T + B}:${L}:${T}`;
  };

  const buildBorderFilter = (settings, targetWidth, targetHeight) => {
    if (!settings?.borderEnabled) return null;
    const bs = clampNonNegInt(settings.borderSize, 0);
    if (!bs) return null;
    const col = normalizeHexColor(settings.borderColor);

    const tw = Number.isFinite(Number(targetWidth)) ? Number(targetWidth) : null;
    const th = Number.isFinite(Number(targetHeight)) ? Number(targetHeight) : null;

    if (tw && th) {
      return `pad=w=${tw}+${bs * 2}:h=${th}+${bs * 2}:x=${bs}:y=${bs}:color=${col}`;
    }

    return `pad=iw+${bs * 2}:ih+${bs * 2}:${bs}:${bs}:color=${col}`;
  };

  const proresProfile =
    clampInt(videoSettings?.proresProfile, 0, 5) ??
    clampInt(videoSettings?.swSettings?.proresProfile, 0, 5) ??
    2;

  const swCrf = clampInt(videoSettings?.swSettings?.quality, 16, 30);

  const toEven = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x) || x <= 0) return null;
  const xi = Math.round(x);
  return (xi % 2 === 0) ? xi : (xi - 1);
};

function computeTargetHeight({ heightMode, targetHeight, srcH, fallbackH, allowUpscale }) {
  const mode = String(heightMode || 'auto').toLowerCase();

  if (mode === 'source') {
    return { targetH: 0, reason: 'source->no-height' };
  }

  if (mode === 'custom') {
    const h0 = toEven(targetHeight);
    if (!h0) return { targetH: fallbackH, reason: 'custom-invalid->fallback' };

    if (!allowUpscale && srcH > 0 && h0 > srcH) {
      return { targetH: srcH, reason: 'custom-upscale-blocked->src' };
    }

    return { targetH: h0, reason: 'custom' };
  }

  return { targetH: 0, reason: 'auto->no-height' };
}

function computeWidthForScaling({ scaleMode, targetWidth, srcW }) {
  const mode = String(scaleMode || "auto").toLowerCase();
  if (mode !== "custom" && mode !== "auto") return { widthW: null, reason: `mode=${mode}` };

  const w0 = toEven(targetWidth);
  if (!w0) return { widthW: null, reason: "no/invalid-width" };

  const MIN_W = 320;
  const MAX_W = (srcW && srcW > 0) ? srcW : 8192;
  if (w0 < MIN_W) return { widthW: null, reason: `too-small(<${MIN_W})` };
  if (w0 > MAX_W) return { widthW: null, reason: `too-large(>${MAX_W})` };

  return { widthW: w0, reason: "ok" };
}

  const volumeGain =
    volumeGainRaw != null ? Number(volumeGainRaw) : null;
  const selectedAudioStreams = Array.isArray(selectedStreams?.audio)
    ? selectedStreams.audio
    : [];
  const selectedSubtitleStreams = Array.isArray(selectedStreams?.subtitles)
    ? selectedStreams.subtitles
    : [];
    try {
    console.log("🎚 convertMedia selectedStreams:", {
      inputPath,
      format,
      isVideo,
      selectedAudioStreams,
      selectedSubtitleStreams,
      hasVideo: selectedStreams?.hasVideo
    });
  } catch {}

  const hasVideoFlag =
    typeof selectedStreams?.hasVideo === "boolean"
      ? selectedStreams.hasVideo
      : isVideo;

  const audioLanguageMap = selectedStreams?.audioLanguages || null;
  const subtitleLanguageMap = selectedStreams?.subtitleLanguages || null;

  let videoHwaccel = videoSettings.hwaccel || VIDEO_HWACCEL;

  const disableQsvInDocker = process.env.DISABLE_QSV_IN_DOCKER === "1";
  const disableVaapiInDocker = process.env.DISABLE_VAAPI_IN_DOCKER === "1";

  if (disableQsvInDocker && videoHwaccel === "qsv") {
    console.log("⚠️ Docker: QSV is disabled in Docker, falling back to NVENC");
    videoHwaccel = "nvenc";
  }

  if (disableVaapiInDocker && videoHwaccel === "vaapi") {
    console.log("⚠️ Docker: VAAPI is disabled in Docker, falling back to NVENC");
    videoHwaccel = "nvenc";
  }

  const audioCodec = videoSettings.audioTranscodeEnabled ?
                         videoSettings.audioCodec : 'aac';
  const audioBitrate = videoSettings.audioTranscodeEnabled ?
                          videoSettings.audioBitrate : '192k';
   const audioChannels = videoSettings.audioTranscodeEnabled ?
                           videoSettings.audioChannels : 'original';
  const audioSampleRate = videoSettings.audioTranscodeEnabled ?
                             videoSettings.audioSampleRate : '48000';

  console.log(`🎬 Video Setting:`, { isVideo, format, videoSettings, videoHwaccel });
  console.log(`🎵 Audio Setting: Codec=${audioCodec}, Bitrate=${audioBitrate}, Transcode=${videoSettings.audioTranscodeEnabled}`);

  const parseFps = (v) => {
     if (v == null) return null;
     const s = String(v).trim().toLowerCase();
     if (!s || s === "source" || s === "auto") return null;

     const n = Number(s);
     if (!Number.isFinite(n) || n <= 0) return null;
     return Math.max(15, Math.min(120, n));
 };

 const targetFps = parseFps(videoSettings.fps);

 console.log(`🎬 Video Settings:`, {
   isVideo,
   format,
   videoSettings,
   videoHwaccel,
   transcodeEnabled: videoSettings.transcodeEnabled,
   targetFps
 });

  const parseSR = (v) => {
    const n = Number(String(v || "").replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? Math.round(n) : NaN;
  };

  const isEac3Ac3 = format === "eac3" || format === "ac3" || format === "aac";
  const srOpt1 = parseSR(opts?.sampleRate);
  const srOpt2 = parseSR(opts?.sampleRateHz);
  const srEnv = parseSR(process.env.TARGET_SAMPLE_RATE);

  let SAMPLE_RATE;
  if (isEac3Ac3) {
    SAMPLE_RATE = Number.isFinite(srOpt1)
      ? srOpt1
      : Number.isFinite(srOpt2)
      ? srOpt2
      : Number.isFinite(srEnv)
      ? srEnv
      : 48000;
  } else {
    SAMPLE_RATE = Number.isFinite(srOpt1)
      ? srOpt1
      : Number.isFinite(srOpt2)
      ? srOpt2
      : Number.isFinite(srEnv)
      ? srEnv
      : 48000;
  }

  if (!Number.isFinite(SAMPLE_RATE) || SAMPLE_RATE <= 0) {
    SAMPLE_RATE = 48000;
  }

  const SAFE_SR = Math.min(192000, Math.max(8000, SAMPLE_RATE));

  const pickNearest = (target, allowed) =>
    allowed.reduce(
      (best, cur) =>
        Math.abs(cur - target) < Math.abs(best - target) ? cur : best,
      allowed[0]
    );

  const COMMENT_KEY = commentKeyFor(format);

  function normalizeSR(fmt, sr) {
    const f = String(fmt || "").toLowerCase();
    if (f === "mp3") {
      const allowed = [
        8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000
      ];
      const picked = pickNearest(sr, allowed);
      return { sr: picked, note: "mp3-legal" };
    }
    if (f === "mp4") {
      const picked = Math.min(48000, Math.max(8000, sr));
      return { sr: picked, note: "aac-clamped" };
    }
    return { sr: sr, note: "as-is" };
  }

  let baseSR = SAFE_SR;
  if (
    isVideo &&
    format === "mp4" &&
    !Number.isFinite(srOpt1) &&
    !Number.isFinite(srOpt2) &&
    !Number.isFinite(srEnv)
  ) {
    baseSR = 48000;
  }

  const { sr: SR_NORM, note: SR_NOTE } = normalizeSR(format, baseSR);

  const buildUniqueOut = (baseName, fmt) => {
    let fileName = `${baseName}.${fmt}`;
    let outPath = path.join(outputDir, fileName);
    let n = 1;
    while (fs.existsSync(outPath)) {
      fileName = `${baseName} (${n++}).${fmt}`;
      outPath = path.join(outputDir, fileName);
    }
    return { fileName, outPath };
  };

  let FINAL_SAMPLE_RATE = SR_NORM;
  if (videoSettings.audioTranscodeEnabled && audioSampleRate !== 'original') {
    const selectedSR = parseInt(audioSampleRate);
    if (Number.isFinite(selectedSR) && selectedSR > 0) {
      FINAL_SAMPLE_RATE = Math.min(192000, Math.max(8000, selectedSR));
      console.log(`🎵 Selected sample rate: ${audioSampleRate} -> ${FINAL_SAMPLE_RATE} Hz`);
    }
  } else if (audioSampleRate === 'original') {
    FINAL_SAMPLE_RATE = null;
    console.log(`🎵 Original sample rate will be preserved`);
  }

  const srSrc = Number.isFinite(srOpt1)
    ? "opt.sampleRate"
    : Number.isFinite(srOpt2)
    ? "opt.sampleRateHz"
    : Number.isFinite(srEnv)
    ? "env"
    : "default";

  console.log(
    `🎵 Conversion → in: ${path.basename(
      inputPath
    )} | fmt=${format} | lyrics=${
      opts.includeLyrics !== false ? "yes" : "no"
    } | video=${isVideo ? "yes" : "no"} | sr=${SAMPLE_RATE}Hz (src=${srSrc}→${SR_NORM} ${SR_NOTE}) | stereo=${stereoConvert} | atempo=${atempoAdjust}`
  );

  const template = isVideo
    ? process.env.FILENAME_TEMPLATE_VIDEO || "%(title)s"
    : process.env.FILENAME_TEMPLATE || "%(artist|album_artist)s - %(track|title)s";

  const resolvedMeta = {
    ...metadata,
    title: cleanTitleForTags(maybeCleanTitle(metadata?.title)),
    track: cleanTitleForTags(metadata?.track),
  };
  const SRC_H = 0;
  const EFFECTIVE_H = 0;
  const VIDEO_PRESET = process.env.VIDEO_PRESET || "veryfast";

    let basename = resolveTemplate(resolvedMeta, template) || `output_${jobId}`;
    basename = sanitizeFilename(basename);

    basename = basename.replace(/\s*(?:_+\s*)+$/, '').replace(/\s{2,}/g, ' ').trim();

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch {}

  let outputFileName = null;
  let outputPath = null;

  let canEmbedCover = false;
  let coverToUse = null;

  if (!isVideo && coverPath && ["mp3", "flac"].includes(format)) {
    try {
      coverToUse = await ensureJpegCover(coverPath, jobId, tempDir, ffmpegFromOpts);
    } catch (e) {
      console.warn("⚠️ Cover conversion warning:", e.message);
    }
    if (coverToUse && fs.existsSync(coverToUse)) canEmbedCover = true;
  }

  const ffmpegBin = ffmpegFromOpts || resolveFfmpegBin();
  console.log(`🧭 Using FFmpeg: ${ffmpegBin}`);

  const result = await new Promise(async (resolve, reject) => {
  const args = ["-hide_banner", "-nostdin", "-y"];

  const orientationMode = String(videoSettings?.orientation || 'auto').toLowerCase();
    if (isVideo && orientationMode !== 'auto') {
      args.push("-noautorotate");
    }
    args.push("-i", inputPath);

    if (isCanceled()) return reject(new Error("CANCELED"));

    if (!isVideo && !canEmbedCover) {
      if (selectedAudioStreams.length > 0) {
        args.push("-map", `0:${selectedAudioStreams[0]}`);
      }
      args.push("-vn");
    }
    if (canEmbedCover) args.push("-i", coverToUse);

    const tn = Number(resolvedMeta.track_number) || null;
    const ttot = Number(resolvedMeta.track_total) || null;
    const dn = Number(resolvedMeta.disc_number) || null;
    const dtot = Number(resolvedMeta.disc_total) || null;
    const trackTag = tn ? (ttot ? `${tn}/${ttot}` : String(tn)) : "";
    const discTag = dn ? (dtot ? `${dn}/${dtot}` : String(dn)) : "";
    const dateTag =
      resolvedMeta.release_date &&
      /^\d{4}(-\d{2}(-\d{2})?)?$/.test(resolvedMeta.release_date)
        ? resolvedMeta.release_date
        : resolvedMeta.release_year || resolvedMeta.upload_date || "";

    const metaPairs = {
      title: resolvedMeta.track || resolvedMeta.title || "",
      artist: resolvedMeta.artist || "",
      album: resolvedMeta.album || resolvedMeta.playlist_title || "",
      date: dateTag || "",
      track: trackTag || "",
      disc: discTag || "",
      genre: resolvedMeta.genre || ""
    };

    if (resolvedMeta.album_artist) metaPairs.album_artist = resolvedMeta.album_artist;

    const labelLike = resolvedMeta.label || resolvedMeta.publisher;
    if (labelLike) metaPairs.publisher = labelLike;

    if (resolvedMeta.copyright) metaPairs.copyright = resolvedMeta.copyright;

    args.push("-map_metadata", "-1");

    for (const [k, v] of Object.entries(metaPairs)) {
      if (v) args.push("-metadata", `${k}=${v}`);
    }

    const commentText = getCommentText();
    if (commentText && format !== "mp3") {
      args.push("-metadata", `${COMMENT_KEY}=${commentText}`);
    }

    if (resolvedMeta.isrc) args.push("-metadata", `ISRC=${resolvedMeta.isrc}`);

    if (!isVideo && (format === "flac" || format === "ogg")) {
      if (resolvedMeta.album_artist)
        args.push("-metadata", `ALBUMARTIST=${resolvedMeta.album_artist}`);
      if (labelLike) {
        args.push("-metadata", `LABEL=${labelLike}`);
        args.push("-metadata", `PUBLISHER=${labelLike}`);
      }
      if (resolvedMeta.webpage_url)
        args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);
      if (resolvedMeta.genre) args.push("-metadata", `GENRE=${resolvedMeta.genre}`);
      if (resolvedMeta.copyright)
        args.push("-metadata", `COPYRIGHT=${resolvedMeta.copyright}`);
    }

    if (!isVideo && format === "mp3") {
      if (resolvedMeta.album_artist)
        args.push("-metadata", `ALBUMARTIST=${resolvedMeta.album_artist}`);
      if (resolvedMeta.genre) args.push("-metadata", `genre=${resolvedMeta.genre}`);
      if (resolvedMeta.copyright)
        args.push("-metadata", `copyright=${resolvedMeta.copyright}`);
      if (resolvedMeta.webpage_url)
        args.push("-metadata", `URL=${resolvedMeta.webpage_url}`);

      const cmt = getCommentText();
      if (cmt) args.push("-metadata", `comment=${cmt}`);
    }

    if (canEmbedCover) {
      if (selectedAudioStreams.length > 0) {
        args.push("-map", `0:${selectedAudioStreams[0]}`);
      } else {
        args.push("-map", "0:a");
      }

      args.push(
        "-map",
        "1:v?",
        "-disposition:v",
        "attached_pic",
        "-metadata:s:v",
        "title=Album cover"
      );
      if (format === "mp3") args.push("-c:v", "mjpeg", "-id3v2_version", "3");
      else if (format === "flac") args.push("-c:v", "mjpeg");
    }

    if (isVideo) {
      if (hasVideoFlag) {
    args.push("-map", "0:v:0");
  } else {
    args.push("-vn");
  }

  if (selectedAudioStreams.length > 0) {
    selectedAudioStreams.forEach((aIdx) => {
      if (Number.isInteger(aIdx) && aIdx >= 0) {
        args.push("-map", `0:${aIdx}`);
      }
    });
  } else {
    args.push("-map", "0:a:0");
  }

  if (selectedSubtitleStreams.length > 0) {
      selectedSubtitleStreams.forEach((sIdx, i) => {
        if (Number.isInteger(sIdx) && sIdx >= 0) {
          args.push("-map", `0:${sIdx}`);
        }
        if (i === 0) {
          args.push("-disposition:s:0", "default");
        }
      });

      if (format === "mp4") {
        console.log("🎬 Subtitles will be written as mov_text in MP4 output");
        args.push("-c:s", "mov_text");
      } else {
        args.push("-c:s", "copy");
      }
    }

  if (selectedStreams) {
    if (Array.isArray(selectedAudioStreams) && audioLanguageMap) {
      let outAudioIndex = 0;
      if (selectedAudioStreams.length > 0) {
        for (const srcIdx of selectedAudioStreams) {
          const lang = audioLanguageMap[srcIdx];
          if (lang && lang !== "und") {
            const normLang = String(lang).trim().toLowerCase().slice(0, 3);
            if (normLang) {
              args.push(`-metadata:s:a:${outAudioIndex}`, `language=${normLang}`);
              }
            }
            outAudioIndex++;
          }
        } else {
      }
    }

    const includeSubtitleMeta =
      Array.isArray(selectedSubtitleStreams) &&
      subtitleLanguageMap;

    if (includeSubtitleMeta) {
      let outSubIndex = 0;
      if (selectedSubtitleStreams.length > 0) {
        for (const srcIdx of selectedSubtitleStreams) {
          const lang = subtitleLanguageMap[srcIdx];
          if (lang && lang !== "und") {
            const normLang = String(lang).trim().toLowerCase().slice(0, 3);
            if (normLang) {
              args.push(`-metadata:s:s:${outSubIndex}`, `language=${normLang}`);
            }
          }
          outSubIndex++;
        }
      }
    }
  }

  if (format === "mp4" || format === "mkv" || format === "mov" || format === "webm") {
    console.log(`🎬 Video transcode: ${videoSettings.transcodeEnabled ? 'ON' : 'OFF'}`);
    const br = (bitrate || "").toString().trim();
    const isVidMb = /^[0-9]+(\.[0-9]+)?m$/i.test(br);
    const isVidKb = /^[0-9]+k$/i.test(br);

    let srcInfo = null;
    try {
      const { probeVideoStreamInfo } = await import("./ffmpegCaps.js");
      srcInfo = await probeVideoStreamInfo(ffmpegBin, inputPath);
    } catch (e) {
      console.warn("⚠️ probeVideoStreamInfo failed:", e?.message || e);
      srcInfo = null;
    }

    const SRC_W = Number(srcInfo?.width) || Number(resolvedMeta.__srcWidth) || 0;
    const SRC_H = Number(srcInfo?.height) || Number(resolvedMeta.__srcHeight) || 0;

    resolvedMeta.__srcWidth = SRC_W;
    resolvedMeta.__srcHeight = SRC_H;

    let autoHeight = 0;
    if (!autoHeight && br) {
        const m = br.match(/(\d{3,4})p/i);
        if (m) autoHeight = parseInt(m[1], 10) || 0;
    }
    if (!autoHeight) autoHeight = 1080;

    const allowUpscale = videoSettings.allowUpscale === true;
    const { targetH: targetHeight, reason: heightReason } = computeTargetHeight({
        heightMode: videoSettings.heightMode,
        targetHeight: videoSettings.targetHeight,
        srcH: SRC_H,
        fallbackH: autoHeight,
        allowUpscale
    });

    const keepOriginal = String(videoSettings.heightMode || "auto").toLowerCase() === "source";
    const { widthW, reason: widthReason } = keepOriginal
      ? { widthW: null, reason: "keep-original" }
      : computeWidthForScaling({
          scaleMode: videoSettings.scaleMode,
          targetWidth: videoSettings.targetWidth,
          srcW: SRC_W
        });

    console.log("📐 scale decision:", {
      scaleMode: videoSettings.scaleMode,
      targetWidth: videoSettings.targetWidth,
      widthW,
      widthReason,
      targetHeight,
      heightReason,
      srcW: SRC_W,
      srcH: SRC_H
    });

    const codecPref = String(videoSettings.videoCodec || "auto").toLowerCase();

    let hwMode = String(videoHwaccel || "off").toLowerCase();

    const resizeMode = String(videoSettings?.resizeMode || "scale").toLowerCase();
    const cropEdgesFilter = buildCropEdgesFilter(videoSettings);
    const orientFilter = buildOrientationFilter(videoSettings?.orientation);

    const evenizeFilter = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

    const colorRange = String(videoSettings.colorRange || "auto").toLowerCase();
    const colorPrim  = String(videoSettings.colorPrimaries || "auto").toLowerCase();

    let colorMetaPushed = false;

    function mapColorRange(v) {
      if (v === "tv" || v === "limited") return "tv";
      if (v === "pc" || v === "full") return "pc";
      return null;
    }

    function normalizePrim(p) {
      return String(p || "").trim().toLowerCase();
    }

    function decideSdrColorMeta(prim) {
      if (prim === "bt2020") {
        return { primaries: "bt2020", trc: "bt2020-10", colorspace: "bt2020nc" };
      }
      if (prim === "bt709") {
        return { primaries: "bt709", trc: "bt709", colorspace: "bt709" };
      }
      return { primaries: prim, trc: null, colorspace: null };
    }

    const pushColorMetadata = () => {
      if (colorMetaPushed) return;
      colorMetaPushed = true;

      const cr = mapColorRange(colorRange);
      if (cr) args.push("-color_range", cr);

      const prim = normalizePrim(colorPrim);
      if (!prim || prim === "auto") return;

      const m = decideSdrColorMeta(prim);
      if (m.primaries)  args.push("-color_primaries", m.primaries);
      if (m.trc)        args.push("-color_trc", m.trc);
      if (m.colorspace) args.push("-colorspace", m.colorspace);
    };

    function buildSetParams() {
      const prim = normalizePrim(colorPrim);
      if (!prim || prim === "auto") return null;

      const m = decideSdrColorMeta(prim);
      const parts = [];
      const cr = mapColorRange(colorRange);
      if (cr) parts.push(`range=${cr}`);

      if (m.primaries)  parts.push(`color_primaries=${m.primaries}`);
      if (m.trc)        parts.push(`color_trc=${m.trc}`);
      if (m.colorspace) parts.push(`colorspace=${m.colorspace}`);

      return parts.length ? `setparams=${parts.join(":")}` : null;
    }

    function buildResizeFilter({ widthW, targetHeight, resizeMode, borderColor }) {
      const w = Number.isFinite(Number(widthW)) ? Number(widthW) : null;
      const h = Number.isFinite(Number(targetHeight)) ? Number(targetHeight) : 0;
      const col = normalizeHexColor(borderColor);

      if ((resizeMode === "crop" || resizeMode === "pad") && w && h > 0) {
        if (resizeMode === "crop") {
          return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
        }
        return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${col}`;
      }

      const needScale = (widthW != null) || (targetHeight > 0);
      if (!needScale) return null;
      const wExpr = (widthW != null) ? widthW : -2;
      const hExpr = (targetHeight > 0) ? targetHeight : -2;
      return `scale=${wExpr}:${hExpr}`;
    }

    function buildBaseVf() {
      const chain = [];

      const sp = buildSetParams();
      if (sp) chain.push(sp);

      if (orientFilter) chain.push(orientFilter);
      if (cropEdgesFilter) chain.push(cropEdgesFilter);

      const colForPad = normalizeHexColor(videoSettings?.borderColor);
      const resizeFrag = buildResizeFilter({
        widthW,
        targetHeight,
        resizeMode,
        borderColor: colForPad
      });
      if (resizeFrag) chain.push(resizeFrag);

      const borderFilterNew = buildBorderFilter(
        videoSettings,
        widthW || null,
        (targetHeight > 0) ? targetHeight : null
      );
      if (borderFilterNew) chain.push(borderFilterNew);

      if (targetFps) chain.push(`fps=${targetFps}`);
      chain.push(evenizeFilter);

      return chain.length ? chain.join(",") : null;
    }

    const baseVf = buildBaseVf();

      const codecConfig = {
        'auto': {
            name: 'H.264',
            bitDepth: 8,
            encoder: 'h264',
            format: 'mp4'
        },
        'h264': {
            name: 'H.264 8-bit',
            bitDepth: 8,
            encoder: 'h264',
            format: 'mp4'
        },
        'h264_10bit': {
            name: 'H.264 10-bit',
            bitDepth: 10,
            encoder: 'h264_10bit',
            format: 'mp4'
        },
        'h265': {
            name: 'H.265/HEVC 8-bit',
            bitDepth: 8,
            encoder: 'hevc',
            format: 'mp4'
        },
        'h265_10bit': {
            name: 'H.265/HEVC 10-bit',
            bitDepth: 10,
            encoder: 'hevc_10bit',
            format: 'mp4'
        },
        'av1': {
            name: 'AV1 8-bit',
            bitDepth: 8,
            encoder: 'av1',
            format: 'mp4'
        },
        'av1_10bit': {
            name: 'AV1 10-bit',
            bitDepth: 10,
            encoder: 'av1_10bit',
            format: 'mp4'
        },
        'vp9': {
            name: 'VP9 8-bit',
            bitDepth: 8,
            encoder: 'vp9',
            format: 'webm'
        },
        'vp9_10bit': {
            name: 'VP9 10-bit',
            bitDepth: 10,
            encoder: 'vp9_10bit',
            format: 'webm'
        },
        'x264': {
            name: 'x264 (CPU)',
            bitDepth: 8,
            encoder: 'libx264',
            format: 'mp4'
        },
        'prores': {
            name: 'Apple ProRes 422',
            bitDepth: 10,
            encoder: 'prores',
            format: 'mov'
        },
        'copy': {
            name: 'Orijinal Codec',
            bitDepth: null,
            encoder: 'copy',
            format: null
        }
    };

    let selectedCodec = codecConfig[codecPref] || codecConfig["auto"];
    console.log(`🎬 Selected codec: ${selectedCodec.name} (${selectedCodec.encoder})`);
    const userExplicitContainer = !!format && format !== "auto";
    if (!userExplicitContainer && selectedCodec.format && selectedCodec.format !== format) {
      const oldFmt = format;
      format = selectedCodec.format;
      console.log(`📦 Container changed: ${oldFmt} -> ${format}`);
    }

    if (!outputPath || !outputFileName) {
      const built = buildUniqueOut(basename, format);
      outputFileName = built.fileName;
      outputPath = built.outPath;
    } else {
      if (!outputPath.endsWith(`.${format}`)) {
        const built = buildUniqueOut(basename, format);
        outputFileName = built.fileName;
        outputPath = built.outPath;
      }
    }

    let caps = null;
    try {
      caps = await getFfmpegCaps(ffmpegBin);
    } catch (e) {
      console.warn("⚠️ getFfmpegCaps failed:", e?.message || e);
      caps = null;
    }

    const capOk = (k) => !!(caps && caps[k] && caps[k].ok);
    const wantsAv1 = selectedCodec.encoder === "av1" || selectedCodec.encoder === "av1_10bit";
    const wants10  = selectedCodec.encoder.endsWith("_10bit");

    if (hwMode === "nvenc" && wantsAv1) {
      const needKey = wants10 ? "av1_nvenc_10bit" : "av1_nvenc";
      if (!capOk(needKey)) {
        if (capOk("libsvtav1")) {
          console.log(`⚠️ ${needKey} unsupported → fallback: software libsvtav1 (keep AV1).`);
          hwMode = "off";
        } else {
          console.log(`⚠️ ${needKey} unsupported and no libsvtav1 → fallback: HEVC NVENC.`);
          selectedCodec = wants10 ? codecConfig["h265_10bit"] : codecConfig["h265"];
        }
      }
    }

    if (hwMode === "nvenc" && selectedCodec.encoder === "h264_10bit" && !capOk("h264_nvenc_10bit")) {
      console.log("⚠️ h264_nvenc 10-bit unsupported → fallback: h264 8-bit.");
      selectedCodec = codecConfig["h264"];
    }

    if (hwMode === "nvenc" && selectedCodec.encoder === "hevc_10bit" && !capOk("hevc_nvenc_10bit")) {
      console.log("⚠️ hevc_nvenc 10-bit unsupported → fallback: hevc 8-bit.");
      selectedCodec = codecConfig["h265"];
    }

    const useNvenc = hwMode === "nvenc";
    const useQsv   = hwMode === "qsv";
    const useVaapi = hwMode === "vaapi";

    const qsvPixFmtFor = (enc, bitDepth) => {
      if (bitDepth === 10 || String(enc || "").includes("10bit") || String(enc || "").endsWith("_10bit")) return "p010le";
      return "nv12";
    };

    const normalizeQsvProfile = (enc, rawProfile) => {
      const p = String(rawProfile || "").trim().toLowerCase();
      if (enc === "hevc" || enc === "hevc_10bit") {
        if (enc === "hevc_10bit") return "main10";
        return (p === "main10") ? "main10" : "main";
      }
      if (["baseline", "main", "high"].includes(p)) return p;
      return "high";
    };

    let explicitBv = null;
    if (isVidMb || isVidKb) {
        explicitBv = isVidMb ? br.replace(/m$/i, "M") : br;
    }

    let pixFmtAlreadySet = false;
    const pushPixFmt = (fmt) => {
      if (!fmt) return;
      if (pixFmtAlreadySet) return;
      args.push("-pix_fmt", fmt);
      pixFmtAlreadySet = true;
    };

    let vf = (!useVaapi && baseVf) ? baseVf : null;

    if (vf && useQsv && selectedCodec.encoder !== "copy") {
      const qsvPixFmt = (selectedCodec.bitDepth === 10) ? "p010le" : "nv12";
      vf = `${vf},format=${qsvPixFmt}`;
    }

    if (vf) args.push("-vf", vf);
    if (useNvenc) {
    const nvencPreset = videoSettings.nvencSettings?.preset || NVENC_PRESET;
    const nvencQuality = videoSettings.nvencSettings?.quality || NVENC_Q;
    const nvencTune = videoSettings.nvencSettings?.tune || null;
    const nvencProfile = videoSettings.nvencSettings?.profile || 'high';
    const nvencLevel = videoSettings.nvencSettings?.level || null;
    const validNvencTunes = ['hq', 'll', 'ull', 'lossless'];

    let finalNvencTune = null;
    if (nvencTune) {
      if (validNvencTunes.includes(nvencTune)) {
        finalNvencTune = nvencTune;
      } else {
        const tuneMap = {
          'film': 'hq',
          'animation': 'hq',
          'grain': 'hq',
          'fastdecode': 'll',
          'zerolatency': 'll',
          'psnr': 'hq',
          'ssim': 'hq'
        };
        finalNvencTune = tuneMap[nvencTune] || 'hq';
        console.log(`🔄 NVENC tune conversion: ${nvencTune} -> ${finalNvencTune}`);
      }
    }

  switch (selectedCodec.encoder) {
    case "h264":
          args.push("-c:v", "h264_nvenc");
          pushPixFmt("yuv420p");
          args.push("-profile:v", nvencProfile);
          if (nvencLevel && nvencLevel !== 'auto') args.push("-level:v", nvencLevel);
          break;

    case 'x264':
    case 'libx264':
      args.push("-c:v", "h264_nvenc");
      pushPixFmt("yuv420p");
      args.push("-profile:v", nvencProfile);
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "h264_10bit":
      args.push("-c:v", "h264_nvenc"); pushPixFmt("p010le");
      if (nvencProfile && nvencProfile !== 'high') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "hevc":
      args.push("-c:v", "hevc_nvenc");
      if (nvencProfile && nvencProfile !== 'main') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "hevc_10bit":
      args.push("-c:v", "hevc_nvenc"); pushPixFmt("p010le");
      if (nvencProfile && nvencProfile !== 'main10') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "av1":
      args.push("-c:v", "av1_nvenc");
      if (nvencProfile && nvencProfile !== 'main') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    case "av1_10bit":
      args.push("-c:v", "av1_nvenc"); pushPixFmt("p010le");
      if (nvencProfile && nvencProfile !== 'main') {
        args.push("-profile:v", nvencProfile);
      }
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;

    default:
      args.push("-c:v", "h264_nvenc");
      pushPixFmt("yuv420p");
      args.push("-profile:v", nvencProfile);
      if (nvencLevel && nvencLevel !== 'auto') {
        args.push("-level:v", nvencLevel);
      }
      break;
  }

    const rawNvencPreset = videoSettings.nvencSettings?.preset || NVENC_PRESET;
    const rawNvencQuality = videoSettings.nvencSettings?.quality || NVENC_Q;
    const { preset: nvPreset, tune: legacyTune } = normalizeNvencPresetAndTune(rawNvencPreset);
    const effectiveTune = finalNvencTune || legacyTune;

    args.push("-preset", nvPreset);
    if (effectiveTune) {
      if (validNvencTunes.includes(effectiveTune)) {
        args.push("-tune", effectiveTune);
      } else {
        console.log(`⚠️ Skipping invalid NVENC tune: ${effectiveTune}`);
      }
    }

    args.push("-rc:v", "vbr");
    if (selectedCodec.encoder === "h264") {
      const prim = normalizePrim(colorPrim);
      if (prim === "bt2020") {
        const full = (mapColorRange(colorRange) === "pc") ? 1 : 0;
        args.push(
          "-bsf:v",
          `h264_metadata=colour_primaries=9:transfer_characteristics=14:matrix_coefficients=9:video_full_range_flag=${full}`
        );
      }
    }

    if (explicitBv) {
      args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
    } else {
      args.push("-cq:v", nvencQuality);
    }
  }
      else if (useQsv) {
      const qsvPreset = videoSettings.qsvSettings?.preset || QSV_PRESET;
      const qsvQuality = videoSettings.qsvSettings?.quality || QSV_Q;
      const qsvTune = videoSettings.qsvSettings?.tune || null;
      const qsvProfileRaw = videoSettings.qsvSettings?.profile || 'high';
      const qsvLevel = videoSettings.qsvSettings?.level || null;
      const qsvEnc = selectedCodec.encoder;
      const qsvProfile = normalizeQsvProfile(qsvEnc, qsvProfileRaw);
      const qsvPixFmt = qsvPixFmtFor(qsvEnc, selectedCodec.bitDepth || 8);
      const qsvPresetNorm = normalizeSwPreset(qsvPreset);
      let canUseQsvPresetFlag = false;

      switch(selectedCodec.encoder) {
        case 'h264':
          args.push("-c:v", "h264_qsv");
          args.push("-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case 'h264_10bit':
          args.push("-c:v", "h264_qsv", "-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case 'hevc':
          args.push("-c:v", "hevc_qsv");
          args.push("-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case 'hevc_10bit':
          args.push("-c:v", "hevc_qsv", "-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
          break;
        case "av1":
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(qsvPresetNorm);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP));
          } else {
            const cpuUsed = presetToAomCpuUsed(qsvPresetNorm);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1");
          }
          break;
        case "av1_10bit":
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(qsvPresetNorm);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP), "-pix_fmt", "yuv420p10le");
          } else {
            const cpuUsed = presetToAomCpuUsed(qsvPresetNorm);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1", "-pix_fmt", "yuv420p10le");
          }
          break;
        default:
          args.push("-c:v", "h264_qsv");
          args.push("-pix_fmt", qsvPixFmt);
          args.push("-profile:v", qsvProfile);
          canUseQsvPresetFlag = true;
          if (qsvLevel && qsvLevel !== 'auto') {
            args.push("-level:v", qsvLevel);
          }
      }

      if (canUseQsvPresetFlag) {
        args.push("-preset", qsvPresetNorm);
      }

      if (qsvTune) {
        console.log(`⚠️ QSV: ignoring tune=${qsvTune} (not supported reliably)`);
      }

      if (explicitBv) {
        args.push("-b:v", explicitBv);
      } else {
        args.push("-global_quality", qsvQuality, "-rc_mode", "vbr");
      }
    }
    else if (useVaapi) {
      const vaapiDevice = videoSettings.vaapiSettings?.device || VAAPI_DEVICE;
      const vaapiQuality = videoSettings.vaapiSettings?.quality || VAAPI_QUALITY;
      const vaapiTune = videoSettings.vaapiSettings?.tune || null;
      const vaapiProfile = videoSettings.vaapiSettings?.profile || 'high';
      const vaapiLevel = videoSettings.vaapiSettings?.level || null;
      const pre = [];
      const sp = buildSetParams();
      if (sp) pre.push(sp);
      if (orientFilter) pre.push(orientFilter);
      if (cropEdgesFilter) pre.push(cropEdgesFilter);

      const col = normalizeHexColor(videoSettings?.borderColor);
      const wantBorder = !!videoSettings?.borderEnabled;
      const keepOriginal = String(videoSettings.heightMode || "auto").toLowerCase() === "source";
      const needScale = !keepOriginal && ((widthW != null) || (targetHeight > 0));
      const needCpuResize =
        (resizeMode === "crop" || resizeMode === "pad") ||
        (resizeMode === "scale" && wantBorder);

      if (needCpuResize) {
        const cpuResize = buildResizeFilter({
          widthW,
          targetHeight,
          resizeMode: (resizeMode === "scale") ? "scale" : resizeMode,
          borderColor: col
        });
        if (cpuResize) pre.push(cpuResize);

        const borderFrag = buildBorderFilter(
          videoSettings,
          widthW || null,
          (targetHeight > 0) ? targetHeight : null
        );
        if (borderFrag) pre.push(borderFrag);

        pre.push(evenizeFilter);
        pre.push("format=nv12", "hwupload");

        let vaapiFilter = pre.join(",");
        if (targetFps) vaapiFilter += `,fps=${targetFps}`;
        args.push("-vaapi_device", vaapiDevice, "-vf", vaapiFilter);
      } else {
        pre.push(evenizeFilter);
        pre.push("format=nv12", "hwupload");
        let vaapiFilter = pre.join(",");

        if (needScale) {
          const wExpr = (widthW != null) ? widthW : -2;
          const hExpr = (targetHeight > 0) ? targetHeight : -2;
          vaapiFilter += `,scale_vaapi=w=${wExpr}:h=${hExpr}`;
        }
        if (targetFps) vaapiFilter += `,fps=${targetFps}`;
        args.push("-vaapi_device", vaapiDevice, "-vf", vaapiFilter);
      }

      switch(selectedCodec.encoder) {
        case 'h264':
          args.push("-c:v", "h264_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'h264_10bit':
          args.push("-c:v", "h264_vaapi", "-pix_fmt", "p010le");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'hevc':
          args.push("-c:v", "hevc_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'hevc_10bit':
          args.push("-c:v", "hevc_vaapi", "-pix_fmt", "p010le");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'av1':
          args.push("-c:v", "av1_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        case 'av1_10bit':
          args.push("-c:v", "av1_vaapi", "-pix_fmt", "p010le");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
          break;
        default:
          args.push("-c:v", "h264_vaapi");
          args.push("-profile:v", vaapiProfile);
          if (vaapiLevel && vaapiLevel !== 'auto') {
            args.push("-level:v", vaapiLevel);
          }
      }

      if (vaapiTune) args.push("-tune", vaapiTune);

      if (explicitBv) {
        args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
      } else {
        args.push("-global_quality", vaapiQuality);
      }
    }
    else {
      const swQuality = videoSettings.swSettings?.quality || '23';
      const swPreset  = normalizeSwPreset(videoSettings.swSettings?.preset || VIDEO_PRESET || "veryfast");
      const swTune = String(videoSettings.swSettings?.tune ?? '').trim();
      const swProfile = videoSettings.swSettings?.profile || 'high';
      const swLevel = videoSettings.swSettings?.level || null;

      let swProfileEff = swProfile;
      if (selectedCodec.encoder === "h264_10bit") swProfileEff = "high10";
      if (selectedCodec.encoder === "hevc") swProfileEff = "main";
      if (selectedCodec.encoder === "hevc_10bit") swProfileEff = "main10";

      const VP9_LEVELS = new Set([
        "1","1.1","2","2.1","3","3.1","4","4.1",
        "5","5.1","5.2","6","6.1","6.2"
      ]);

      switch (selectedCodec.encoder) {
        case 'h264':
        case 'x264':
          args.push("-c:v", "libx264", "-preset", swPreset);
          if (swProfileEff) args.push("-profile:v", swProfileEff);
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'h264_10bit':
          args.push("-c:v", "libx264", "-preset", swPreset);
          pushPixFmt("yuv420p10le");
          args.push("-profile:v", "high10");
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'hevc':
          args.push("-c:v", "libx265", "-preset", swPreset);
          pushPixFmt("yuv420p");
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          args.push("-profile:v", "main");
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'hevc_10bit':
          args.push("-c:v", "libx265", "-preset", swPreset);
          pushPixFmt("yuv420p10le");
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          args.push("-profile:v", "main10");
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
          break;
        case 'av1':
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(swPreset);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP));
          } else {
            const cpuUsed = presetToAomCpuUsed(swPreset);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1");
          }
          break;
        case 'av1_10bit':
          if (capOk("libsvtav1")) {
            const svtP = presetToSvtPreset(swPreset);
            args.push("-c:v", "libsvtav1", "-preset", String(svtP), "-pix_fmt", "yuv420p10le");
          } else {
            const cpuUsed = presetToAomCpuUsed(swPreset);
            args.push("-c:v", "libaom-av1", "-cpu-used", String(cpuUsed), "-row-mt", "1", "-pix_fmt", "yuv420p10le");
          }
          break;
        case 'vp9': {
          const cpuUsed = presetToVp9CpuUsed(swPreset);
          const deadline = presetToVp9Deadline(swPreset);
          args.push("-c:v", "libvpx-vp9", "-cpu-used", String(cpuUsed), "-deadline", deadline, "-row-mt", "1", "-b:v", "0");
          const crf = swCrf != null ? String(swCrf) : String(swQuality || "30");
          args.push("-crf", crf);
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          if (swProfile && swProfile !== '0') args.push("-profile:v", swProfile);
          if (swLevel && swLevel !== 'auto') {
            const lvlStr = String(swLevel);
            if (VP9_LEVELS.has(lvlStr)) {
              args.push("-level:v", lvlStr);
            } else {
              console.log(`⚠️ VP9 level "${lvlStr}" geçersiz → -level:v atlanıyor`);
            }
          }
         break;
        }
        case 'vp9_10bit': {
          const cpuUsed = presetToVp9CpuUsed(swPreset);
          const deadline = presetToVp9Deadline(swPreset);
          args.push(
            "-c:v",
            "libvpx-vp9",
            "-cpu-used",
            String(cpuUsed),
            "-deadline",
            deadline,
            "-row-mt",
            "1",
            "-b:v",
            "0",
            "-pix_fmt",
            "yuv420p10le"
          );
          const crf = swCrf != null ? String(swCrf) : String(swQuality || "30");
          args.push("-crf", crf);
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          if (swProfile && swProfile !== '2') args.push("-profile:v", swProfile);
          if (swLevel && swLevel !== 'auto') {
            const lvlStr = String(swLevel);
            if (VP9_LEVELS.has(lvlStr)) {
              args.push("-level:v", lvlStr);
            } else {
              console.log(`⚠️ VP9 10-bit level "${lvlStr}" geçersiz → -level:v atlanıyor`);
            }
          }
          break;
        }
       case 'prores': {
          const p = proresProfile;
          args.push("-c:v", "prores_ks", "-profile:v", String(p));
          if (p >= 4) pushPixFmt("yuv444p10le");
          else pushPixFmt("yuv422p10le");

          break;
        }
        case 'copy':
          args.push("-c:v", "copy");
          break;
        default:
          args.push("-c:v", "libx264", "-preset", VIDEO_PRESET);
          if (swTune && swTune !== 'auto') args.push("-tune", swTune);
          args.push("-profile:v", swProfile);
          if (swLevel && swLevel !== 'auto') args.push("-level:v", swLevel);
      }

      if (explicitBv && selectedCodec.encoder !== 'copy') {
        args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
      } else if (!explicitBv && selectedCodec.encoder !== 'copy') {
        if (swCrf != null) {
          if (!['vp9', 'vp9_10bit', 'prores'].includes(selectedCodec.encoder)) {
            args.push("-crf", String(swCrf));
          }
        } else {
          const crf = br === "auto" || br === "0" ? "23" : "21";
          if (!['vp9', 'vp9_10bit', 'prores'].includes(selectedCodec.encoder)) {
            args.push("-crf", crf);
          }
        }
      }
    }

    const SRC_H2 = Number(resolvedMeta.__srcHeight) || 0;
    const tgtH = targetHeight > 0 ? targetHeight : 0;

    if (!useVaapi && selectedCodec.encoder !== 'copy') {

    if (!useNvenc && !useQsv && selectedCodec.encoder !== 'prores') {
      if (!pixFmtAlreadySet) {
        if (!selectedCodec.bitDepth || selectedCodec.bitDepth === 8) pushPixFmt("yuv420p");
        else if (selectedCodec.bitDepth === 10) pushPixFmt("yuv420p10le");
      }
    }

      if (format === "mp4") {
        args.push("-movflags", "+faststart+write_colr");
      }

      if (selectedCodec.encoder.includes('264') || selectedCodec.encoder.includes('265')) {
        args.push("-g", "60", "-keyint_min", "60", "-sc_threshold", "0");
      }
    } else if (useVaapi) {
        args.push(
          "-movflags", "+faststart",
          "-g", "60",
          "-keyint_min", "60",
          "-sc_threshold", "0"
        );
    }

    if (audioCodec === 'copy') {
        args.push("-c:a", "copy");
    } else {
        args.push("-c:a", audioCodec);
        if (audioCodec === 'flac') {
            args.push("-compression_level", "5");
        } else if (audioBitrate !== 'original' && audioBitrate !== 'lossless') {
            args.push("-b:a", audioBitrate);
        }

        if (audioCodec !== 'copy' && audioCodec !== 'flac') {
            if (audioChannels === 'stereo') {
                args.push("-ac", "2");
            } else if (audioChannels === 'mono') {
                args.push("-ac", "1");
            }
        } else if (audioCodec === 'flac' && audioChannels !== 'original') {
            args.push("-ac", audioChannels === 'stereo' ? "2" : "1");
        }

        if (FINAL_SAMPLE_RATE !== null) {
            args.push("-ar", String(FINAL_SAMPLE_RATE));
        }
    }
}
    } else {
      switch (format) {
        case "mp3":
          args.push("-id3v2_version", "3");
          if (process.env.WRITE_ID3V1 === "1") args.push("-write_id3v1", "1");
          if (bitrate === "auto" || bitrate === "0" || bitrate === "lossless") {
            args.push(
              "-acodec",
              "libmp3lame",
              "-q:a",
              "0",
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          } else {
            args.push(
              "-acodec",
              "libmp3lame",
              "-b:a",
              bitrate,
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          }
          break;
        case "flac": {
          let cl = Number(opts?.compressionLevel);
          if (!Number.isFinite(cl)) cl = 5;
          cl = Math.max(0, Math.min(12, cl));

          args.push(
            "-acodec",
            "flac",
            "-compression_level",
            String(cl),
            "-ar",
            FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
          );

          if (bitDepth === "16") {
            args.push("-sample_fmt", "s16");
          } else if (bitDepth === "24") {
            args.push("-sample_fmt", "s32");
          } else if (bitDepth === "32f") {
            args.push("-sample_fmt", "flt");
          }
          break;
        }
        case "wav": {
          let codec = "pcm_s16le";
          if (bitDepth === "24") {
            codec = "pcm_s24le";
          } else if (bitDepth === "32f") {
            codec = "pcm_f32le";
          }
          args.push("-acodec", codec, "-ar", FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM));
          break;
        }
        case "ogg":
          if (bitrate === "auto" || bitrate === "0") {
            args.push(
              "-acodec",
              "libvorbis",
              "-q:a",
              "6",
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          } else {
            args.push(
              "-acodec",
              "libvorbis",
              "-b:a",
              bitrate,
              "-ar",
              FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
            );
          }
          break;
        case "eac3":
        case "aac":
        case "ac3":
          args.push(
            "-acodec",
            format,
            "-b:a",
            bitrate,
            "-ar",
            FINAL_SAMPLE_RATE !== null ? String(FINAL_SAMPLE_RATE) : String(SR_NORM)
          );
          if (stereoConvert === "force") args.push("-ac", "2");
          break;
      }
    }

    const afilters = [];

    if (!isVideo && atempoAdjust !== "none") {
      const ratioTable = {
        "24000_23976": 24000 / 23976,
        "25_24": 24 / 25,
        "25_23976": 23976 / 25000,
        "30_23976": 23976 / 30000,
        "30_24": 24 / 30,
        "24000_25000": 25000 / 24000,
        "23976_24000": 24000 / 23976,
        "23976_25000": 25000 / 23976,
        "30000_23976": 23976 / 30000,
        "30000_25000": 25000 / 30000
      };

      const target = ratioTable[atempoAdjust];
      if (Number.isFinite(target) && target > 0) {
        const splitAtempo = (f) => {
          const parts = [];
          let x = f;
          while (x < 0.5) {
            parts.push(0.5);
            x = x / 0.5;
          }
          while (x > 2.0) {
            parts.push(2.0);
            x = x / 2.0;
          }
          parts.push(x);
          return parts.map((v) => +v.toFixed(6));
        };

        const chain = splitAtempo(target);
        if (chain.length) {
          const expr = chain.map((v) => `atempo=${v}`).join(",");
          afilters.push(expr);
        }
      }
    }

    if (Number.isFinite(volumeGain) && volumeGain > 0 && volumeGain !== 1) {
      const safeGain = Math.min(Math.max(volumeGain, 0.5), 5.0);
      afilters.push(`volume=${safeGain.toFixed(2)}`);
    }

    if (afilters.length > 0) {
      const filterStr = afilters.join(",");
      args.push("-af", filterStr);
    }

    if (!outputPath || !outputFileName) {
      const built = buildUniqueOut(basename, format);
      outputFileName = built.fileName;
      outputPath = built.outPath;
    }

    args.push(outputPath);

    console.log("🔧 FFmpeg arguments:", args.join(" "));

    let triedFallback = false;
    let ffmpeg = spawn(ffmpegBin, args);
    try {
      if (typeof opts.onProcess === "function") {
        opts.onProcess(ffmpeg);
      }
    } catch {}
    let duration = null;
    let stderrData = "";
    let canceledByFlag = false;

    const tryCancel = () => {
      if (!canceledByFlag && isCanceled()) {
        canceledByFlag = true;
        try {
          ffmpeg.kill("SIGTERM");
        } catch {}
      }
    };

    ffmpeg.stderr.on("data", (d) => {
      const line = d.toString();
      stderrData += line;

      if (!duration) {
        const m = line.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const [, h, mn, s] = m;
          duration = +h * 3600 + +mn * 60 + +s;
        }
      }

      tryCancel();

      const t = line.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (t && duration) {
        const [, h, mn, s] = t;
        const cur = +h * 3600 + +mn * 60 + +s;
        const p = Math.min(99, Math.floor((cur / duration) * 100));
        progressCallback(p);
        tryCancel();
      }
    });

    ffmpeg.on("close", (code) => {
      const actualOut = outputPath;
      if (canceledByFlag || isCanceled()) {
        try {
          if (actualOut && fs.existsSync(actualOut)) fs.unlinkSync(actualOut);
        } catch {}
        return reject(new Error("CANCELED"));
      }

      if (code === 0 && fs.existsSync(outputPath)) {
        progressCallback(100);
        console.log(`✅ Conversion completed: ${outputPath}`);
        resolve({
          outputPath: `/download/${encodeURIComponent(outputFileName)}`,
          fileSize: fs.statSync(outputPath).size
        });
      } else {
        try {
          if (outputPath && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        } catch {}
        const tail = stderrData.split("\n").slice(-10).join("\n");
        console.error(`❌ FFmpeg error (code ${code}):\n${tail}`);
        reject(new Error(`FFmpeg error (code ${code}): ${tail}`));
      }
    });

    ffmpeg.on("error", (e) => {
      console.error(`❌ FFmpeg spawn error: ${e.message}`);
      if (!triedFallback && /ENOENT/i.test(e.message)) {
        triedFallback = true;
        try {
          ffmpeg = spawn(
            process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
            args
          );
          if (typeof opts.onProcess === "function") {
            try {
              opts.onProcess(ffmpeg);
            } catch {}
          }
          ffmpeg.stderr.on("data", (d) => {});
          ffmpeg.on("close", (code) => {});
          ffmpeg.on("error", (e2) => {
            reject(new Error(`FFmpeg spawn error (fallback): ${e2.message}`));
          });
          return;
        } catch (e2) {
          return reject(
            new Error(`FFmpeg spawn error (fallback init): ${e2.message}`)
          );
        }
      }
      reject(new Error(`FFmpeg spawn error: ${e.message}`));
    });
  });

  try {
    if (isCanceled()) {
      return result;
    }
    const includeLyricsFlag = opts.includeLyrics !== false;

    console.log(
      `🔍 Lyrics check → Will it be added?: ${
        includeLyricsFlag ? "yes" : "no"
      } | video: ${isVideo ? "yes" : "no"} | format: ${format} | meta: ${[
        metadata.artist,
        metadata.title || metadata.track
      ]
        .filter(Boolean)
        .join(" - ")}`
    );

    if (includeLyricsFlag && !isVideo && result && result.outputPath) {
      console.log("🎵 Adding lyrics...");
      const actualOutputPath = path.join(
        outputDir,
        decodeURIComponent(result.outputPath.replace("/download/", ""))
      );

      if (isCanceled()) {
        return result;
      }

      const lyricsLogCallback = (message) => {
        const line =
          typeof message === "object" && message?.fallback
            ? message.fallback
            : typeof message === "string"
            ? message
            : JSON.stringify(message);
        console.log(`[Lyrics ${jobId}] ${line}`);

        const job = jobs.get(jobId.split("_")[0]);
        if (job) {
          if (typeof message === "object" && message.logKey) {
            job.lastLogKey = message.logKey;
            job.lastLogVars = message.logVars || {};
            job.lastLog = message.fallback || "";
          } else {
            job.lastLog = line;
            job.lastLogKey = null;
            job.lastLogVars = null;
          }
        }
      };

      try {
        const lyricsPath = await attachLyricsToMedia(actualOutputPath, metadata, {
          includeLyrics: includeLyricsFlag,
          jobId: jobId.split("_")[0],
          onLog: lyricsLogCallback,
          onLyricsStats: opts.onLyricsStats
        });

        if (lyricsPath) {
          console.log(`✅ lyrics added successfully: ${lyricsPath}`);
          result.lyricsPath = `/download/${encodeURIComponent(
            path.basename(lyricsPath)
          )}`;

          const job = jobs.get(jobId.split("_")[0]);
          if (job) {
            job.lastLog = `🎼 Lyrics file added: ${path.basename(
              lyricsPath
            )}`;
            if (!job.metadata.lyricsStats) {
              job.metadata.lyricsStats = { found: 0, notFound: 0 };
            }
            job.metadata.lyricsStats.found++;
          }
        } else {
          console.log("ℹ️ Lyrics could not be found or added");
          const job = jobs.get(jobId.split("_")[0]);
          if (job) {
            job.lastLog = `🎼 Lyrics not found: ${
              metadata.title || "Unknown"
            }`;
            if (!job.metadata.lyricsStats) {
              job.metadata.lyricsStats = { found: 0, notFound: 0 };
            }
            job.metadata.lyricsStats.notFound++;
          }
        }
      } catch (lyricsError) {
        console.warn("❌ Error adding lyrics (main process in progress):", lyricsError);
        const job = jobs.get(jobId.split("_")[0]);
        if (job) {
         job.lastLog = `❌ Lyrics error: ${lyricsError.message}`;
        }
      }
    } else {
      console.log(
        `⚙️ no lyrics added → Will it be added?: ${
          includeLyricsFlag ? "yes" : "no"
        } | reason: ${isVideo ? "Video format" : "Disabled"}`
      );
    }

    return result;
  } catch (error) {
    console.error("❌ Lyrics processing error:", error);
    return result;
  }
}
