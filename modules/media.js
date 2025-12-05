import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";
import { sanitizeFilename, findOnPATH, isExecutable } from "./utils.js";
import { attachLyricsToMedia } from "./lyrics.js";
import { jobs } from "./store.js";
import "dotenv/config";
import { FFMPEG_BIN as BINARY_FFMPEG_BIN } from "./binaries.js";

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

  function commentKeyFor(fmt) {
    const f = String(fmt || "").toLowerCase();
    if (f === "flac" || f === "ogg") return "DESCRIPTION";
    if (f === "mp4" || f === "m4a") return "comment";
    if (f === "mp3") return "comment";
    if (f === "eac3" || f === "ac3") return "comment";
    if (f === "aac" || f === "ac3") return "comment";
    return "comment";
  }
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
    : process.env.FILENAME_TEMPLATE || "%(artist)s - %(track|title)s";

  const resolvedMeta = { ...metadata, title: maybeCleanTitle(metadata?.title) };
  const VIDEO_MAX_H = Number(resolvedMeta.__maxHeight) || 1080;
  const SRC_H = Number(resolvedMeta.__srcHeight) || 0;
  const EFFECTIVE_H = SRC_H || VIDEO_MAX_H;
  const VIDEO_PRESET = process.env.VIDEO_PRESET || "veryfast";

  let basename = resolveTemplate(resolvedMeta, template) || `output_${jobId}`;
  basename = sanitizeFilename(basename);

  try {
    fs.mkdirSync(outputDir, { recursive: true });
  } catch {}

  let outputFileName = `${basename}.${format}`;
  let outputPath = path.join(outputDir, outputFileName);
  let idx = 1;
  while (fs.existsSync(outputPath)) {
    outputFileName = `${basename} (${idx++}).${format}`;
    outputPath = path.join(outputDir, outputFileName);
  }

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

  const result = await new Promise((resolve, reject) => {
  const args = ["-hide_banner", "-nostdin", "-y", "-i", inputPath];

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

  if (format === "mp4" || format === "mkv") {
    console.log(`🎬 Video transcode: ${videoSettings.transcodeEnabled ? 'ON' : 'OFF'}`);
    const br = (bitrate || "").toString().trim();
    const isVidMb = /^[0-9]+(\.[0-9]+)?m$/i.test(br);
    const isVidKb = /^[0-9]+k$/i.test(br);
    let targetHeight = 0;
    if (VIDEO_MAX_H && VIDEO_MAX_H > 0) targetHeight = VIDEO_MAX_H;
    if (!targetHeight && br) {
      const m = br.match(/(\d{3,4})p/i);
      if (m) targetHeight = parseInt(m[1], 10) || 0;
    }
    if (SRC_H && SRC_H > 0 && targetHeight > 0 && SRC_H < targetHeight) {
      targetHeight = SRC_H;
    }

    const useHevc = (targetHeight || EFFECTIVE_H) >= 2160;
    const useNvenc = videoHwaccel === "nvenc";
    const useQsv   = videoHwaccel === "qsv";
    const useVaapi = videoHwaccel === "vaapi";

    let explicitBv = null;
    if (isVidMb || isVidKb) {
      explicitBv = isVidMb ? br.replace(/m$/i, "M") : br;
    }

        if (useNvenc) {
          const nvencPreset = videoSettings.nvencSettings?.preset || NVENC_PRESET;
          const nvencQuality = videoSettings.nvencSettings?.quality || NVENC_Q;
          if (useHevc) {
            args.push(
              "-c:v", "hevc_nvenc",
              "-preset", nvencPreset,
              "-rc:v", "vbr"
            );
          } else {
            args.push(
              "-c:v", "h264_nvenc",
              "-preset", nvencPreset,
              "-rc:v", "vbr"
            );
          }

          if (explicitBv) {
            args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
          } else {
            args.push("-cq:v", nvencQuality);
          }
        } else if (useQsv) {
          const qsvPreset = videoSettings.qsvSettings?.preset || QSV_PRESET;
          const qsvQuality = videoSettings.qsvSettings?.quality || QSV_Q;
          if (useHevc) {
            args.push("-c:v", "hevc_qsv", "-preset", qsvPreset);
          } else {
            args.push("-c:v", "h264_qsv", "-preset", qsvPreset);
          }

          if (explicitBv) {
            args.push("-b:v", explicitBv);
          } else {
            args.push(
              "-global_quality", qsvQuality,
              "-rc_mode", "vbr"
            );
          }
        } else if (useVaapi) {
          const vaapiDevice  = videoSettings.vaapiSettings?.device  || VAAPI_DEVICE;
          const vaapiQuality = videoSettings.vaapiSettings?.quality || VAAPI_QUALITY;
          let vaapiFilter = "format=nv12,hwupload";

          if (targetHeight > 0) {
            vaapiFilter += `,scale_vaapi=w=-2:h=${targetHeight}`;
          }

          if (targetFps) {
            vaapiFilter += `,fps=${targetFps}`;
          }

          args.push(
            "-vaapi_device", vaapiDevice,
            "-vf", vaapiFilter,
            "-c:v", useHevc ? "hevc_vaapi" : "h264_vaapi"
          );

          if (explicitBv) {
            args.push(
              "-b:v",     explicitBv,
              "-maxrate", explicitBv,
              "-bufsize", `${explicitBv}*2`
            );
          } else {
            args.push("-global_quality", vaapiQuality);
            }
          } else {
          if (useHevc) {
            args.push("-c:v", "libx265", "-preset", VIDEO_PRESET);
          } else {
            args.push("-c:v", "libx264", "-preset", VIDEO_PRESET, "-tune", "film");
          }

          if (explicitBv) {
            args.push("-b:v", explicitBv, "-maxrate", explicitBv, "-bufsize", `${explicitBv}*2`);
          } else {
            const crf = br === "auto" || br === "0" ? "23" : "21";
            args.push("-crf", crf);
          }
        }

        if (!useVaapi && targetHeight > 0) {
          args.push("-vf", `scale=-2:${targetHeight}`);
        }

        if (!useVaapi && targetFps) {
          args.push("-r", String(targetFps));
        }

        if (!useVaapi) {
          args.push(
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-g",
            "60",
            "-keyint_min",
            "60",
            "-sc_threshold",
            "0"
          );
        } else {
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

    if (stereoConvert === "force") {
          args.push("-ac", "2");
        } else if (audioChannels === 'stereo') {
          args.push("-ac", "2");
        } else if (audioChannels === 'mono') {
          args.push("-ac", "1");
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
