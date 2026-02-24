import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { sendOk, sendError, ERR, isDirectMediaUrl } from "../modules/utils.js";
import { jobs, spotifyMapTasks, killJobProcesses, createJob } from "../modules/store.js";
import { processJob } from "../modules/processor.js";
import { enqueueJob } from "../modules/queue.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { idsToMusicUrls, searchYtmBestId } from "../modules/sp.js";
import { resolveMarket } from "../modules/market.js";
import { requireAuth } from "../modules/settings.js";
import { probeMediaFile, parseStreams, getDefaultStreamSelection } from "../modules/probe.js";
import { attachLyricsToMedia, lyricsFetcher } from "../modules/lyrics.js";
import { getFfmpegCaps } from "../modules/ffmpegCaps.js";
import { FFMPEG_BIN as BINARY_FFMPEG_BIN } from "../modules/binaries.js";
import "dotenv/config";
import {
  isYouTubeUrl,
  isDailymotionUrl,
  isYouTubePlaylist,
  isDailymotionPlaylist,
  isYouTubeAutomix,
  normalizeYouTubeUrl,
  resolvePlaylistSelectedIds,
  resolveAutomixSelectedIds,
  getPlaylistMetaLite,
  extractPlaylistPage,
  extractAutomixPage
} from "../modules/yt.js";
import { isSupportedPlatformUrl, detectPlatform } from "../modules/platform.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");
const UPLOAD_DIR = path.resolve(BASE_DIR, "uploads");
const LOCAL_INPUT_DIR = path.resolve(BASE_DIR, process.env.LOCAL_INPUT_DIR || "local-inputs");

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(LOCAL_INPUT_DIR, { recursive: true });

console.log('[jobs] BASE_DIR:', BASE_DIR);
console.log('[jobs] UPLOAD_DIR:', UPLOAD_DIR);
console.log('[jobs] LOCAL_INPUT_DIR:', LOCAL_INPUT_DIR);

const DEFAULT_UPLOAD_MAX_BYTES = 1000 * 1024 * 1024;
// Uploads max bytes for Express API request handling.
const UPLOAD_MAX_BYTES = (() => {
  const raw = process.env.UPLOAD_MAX_BYTES;
  if (!raw) return DEFAULT_UPLOAD_MAX_BYTES;

  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;

  const m = String(raw).match(/^(\d+)\s*mb?$/i);
  if (m) {
    const mb = Number(m[1]);
    if (Number.isFinite(mb) && mb > 0) {
      return mb * 1024 * 1024;
    }
  }

  console.warn(`[jobs] Invalid UPLOAD_MAX_BYTES value ("${raw}"), falling back to default.`);
  return DEFAULT_UPLOAD_MAX_BYTES;
})();

console.log(
  `[jobs] Maximum upload size: ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))} MB`
);

const inFlightAutomix = new Map();

// Parses cookie header for Express API request handling.
function parseCookieHeader(raw) {
  const out = {};
  const src = String(raw || "");
  if (!src) return out;
  const parts = src.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

// Handles to utf8 filename in Express API request handling.
function toUtf8Filename(name) {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const origUtf8 = toUtf8Filename(file.originalname);
    cb(null, `${crypto.randomBytes(8).toString("hex")}_${origUtf8}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_MAX_BYTES }
});

// Handles job state has any existing output in Express API request handling.
function jobHasAnyExistingOutput(job) {
  // Resolves download metadata path for Express API request handling.
  const resolveDownloadPath = (downloadPath) => {
    if (!downloadPath) return null;
    const rel = decodeURIComponent(
      String(downloadPath).replace(/^\/download\//, "")
    );
    if (!rel) return null;

    return path.join(OUTPUT_DIR, rel);
  };

  // Handles check file in Express API request handling.
  const checkFile = (downloadPath) => {
    const abs = resolveDownloadPath(downloadPath);
    if (!abs) return false;
    try {
      return fs.existsSync(abs);
    } catch {
      return false;
    }
  };

  if (job.zipPath && checkFile(job.zipPath)) {
    return true;
  }

  const rp = job.resultPath;

  if (Array.isArray(rp)) {
    return rp.some((r) => {
      if (!r) return false;
      const p = typeof r === "string" ? r : r.outputPath;
      return checkFile(p);
    });
  }

  if (rp && typeof rp === "object") {
    return checkFile(rp.outputPath);
  }

  if (typeof rp === "string") {
    return checkFile(rp);
  }

  return false;
}

// Cleans up completed job state without outputs for Express API request handling.
function cleanupCompletedJobsWithoutOutputs() {
  let removed = 0;

  for (const [id, job] of jobs.entries()) {
    if (job.status === "completed") {
      const hasOutput = jobHasAnyExistingOutput(job);
      if (!hasOutput) {
        jobs.delete(id);
        removed++;
      }
    }
  }

  if (removed > 0) {
    console.log(`[jobs] ${removed} completed jobs without outputs were cleaned up.`);
  }
}

const router = express.Router();

// Selects lang for Express API request handling.
function pickLang(req) {
  const SUPPORTED = new Set(["en","tr","de","fr"]);
  const hx = String(req.get("x-lang") || "").toLowerCase().trim();
  if (SUPPORTED.has(hx)) return hx;
  const q = String(req.query?.lang || "").toLowerCase().trim();
  if (SUPPORTED.has(q)) return q;

  try {
    const raw = String(req.headers?.cookie || "");
    if (raw) {
      const parsed = parseCookieHeader(raw);
      const c = String(parsed.lang || "").toLowerCase().trim();
      if (SUPPORTED.has(c)) return c;
    }
  } catch {}

  const al = String(req.get("accept-language") || "").toLowerCase();
  if (al.includes("tr")) return "tr";
  if (al.includes("de")) return "de";
  if (al.includes("fr")) return "fr";
  if (al.includes("en")) return "en";
  return "en";
}

// Handles t in Express API request handling.
function t(lang, key, vars = {}) {
  const dict = {
    tr: {
      idle: "Boşta",
      queued: "Kuyrukta",
      processing: "İşleniyor",
      downloading: "İndiriliyor",
      converting: "Dönüştürülüyor",
      completed: "Tamamlandı",
      error: "Hata",
      canceled: "İptal",
      progress: "{n}%",
    },
    en: {
      idle: "Idle",
      queued: "Queued",
      processing: "Processing",
      downloading: "Downloading",
      converting: "Converting",
      completed: "Completed",
      error: "Error",
      canceled: "Canceled",
      progress: "{n}%",
    },
    de: {
      idle: "Leerlauf",
      queued: "Warteschlange",
      processing: "In Arbeit",
      downloading: "Wird heruntergeladen",
      converting: "Wird konvertiert",
      completed: "Fertig",
      error: "Fehler",
      canceled: "Abgebrochen",
      progress: "{n}%",
    },
    fr: {
      idle: "Inactif",
      queued: "En file",
      processing: "Traitement",
      downloading: "Téléchargement",
      converting: "Conversion",
      completed: "Terminé",
      error: "Erreur",
      canceled: "Annulé",
      progress: "{n}%",
    },
  };

  const d = dict[lang] || dict.en;
  let s = d[key] ?? dict.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return s;
}

// Normalizes phase key for Express API request handling.
function normalizePhaseKey(s) {
  const v = String(s || "").toLowerCase().trim();
  if (!v) return "";
  if (v.includes("download")) return "downloading";
  if (v.includes("convert") || v.includes("transcod")) return "converting";
  if (v === "queued") return "queued";
  if (v === "processing") return "processing";
  if (v === "completed") return "completed";
  if (v === "error") return "error";
  if (v === "canceled") return "canceled";
  return v;
}

// Handles require widget key in Express API request handling.
function requireWidgetKey(req, res, next) {
  const expected = String(process.env.HOMEPAGE_WIDGET_KEY || "").trim();
  if (!expected) {
    return res.status(500).json({
      error: { code: "WIDGET_KEY_NOT_SET", message: "HOMEPAGE_WIDGET_KEY is not set" }
    });
  }
  const got =
    String(req.get("x-widget-key") || req.get("x-widget_key") || "").trim();
  if (!got || got !== expected) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Unauthorized" }
    });
  }
  return next();
}

router.get("/api/homepage", requireWidgetKey, (req, res) => {
  try {
    const lang = pickLang(req);
    cleanupCompletedJobsWithoutOutputs();
    const all = Array.from(jobs.values());

    const isActive = (j) =>
      j && (j.status === "queued" || j.status === "processing");

    const active = all.filter(isActive);

    const current =
      active
        .slice()
        .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))[0] ||
      null;

    // Handles to num in Express API request handling.
    const toNum = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    const clamp0_100 = (n) => Math.max(0, Math.min(100, Math.floor(n)));

    // Computes progress for Express API request handling.
    const computeProgress = (j) => {
      const d = toNum(j?.downloadProgress);
      const c = toNum(j?.convertProgress);
      const p = toNum(j?.progress);

      let out = 0;
      if (d > 0 || c > 0) {
        out = (d > 0 && c > 0) ? (d + c) / 2 : Math.max(d, c);
      } else {
        out = p;
      }
      return clamp0_100(out);
    };

    const currentProgress = current ? computeProgress(current) : 0;
    const currentProgressText = current
      ? t(lang, "progress", { n: currentProgress })
      : t(lang, "idle");

    const rawPhase = current?.currentPhase || current?.status || "";
    const phaseKey = normalizePhaseKey(rawPhase);
    const currentPhaseText =
      phaseKey && (phaseKey in ( {queued:1,processing:1,downloading:1,converting:1,completed:1,error:1,canceled:1} ))
        ? t(lang, phaseKey)
        : (rawPhase ? String(rawPhase) : null);

  res.json({
    totalCount: all.length,

      activeCount: active.length,
      queueCount: all.filter(j => j.status === "queued").length,
      processingCount: all.filter(j => j.status === "processing").length,
      completedCount: all.filter(j => j.status === "completed").length,
      errorCount: all.filter(j => j.status === "error").length,

      currentId: current?.id || null,
      currentPhase: rawPhase || null,
      currentPhaseText,
      currentProgress,
      currentProgressText,

      ts: Date.now()
    });
  } catch (e) {
    console.error("[homepage] error:", e);
    res.status(500).json({
      error: { code: "HOMEPAGE_FAIL", message: e.message || "failed" }
    });
  }
});

router.get("/api/local-files", requireAuth, (req, res) => {
  try {
    const allowedExts = [
      ".mp3", ".flac", ".wav", ".ogg", ".m4a",
      ".mp4", ".mkv", ".avi", ".mov", ".dts", ".ac3",
      ".eac3", ".aac", ".webm"
    ];

    const items = [];

    // Handles walk in Express API request handling.
    function walk(dir, baseDir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath, baseDir);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!allowedExts.includes(ext)) continue;

          let size = 0;
          try { size = fs.statSync(fullPath).size; } catch {}
          const relPath = path.relative(baseDir, fullPath);

          items.push({
            name: relPath,
            size
          });
        }
      }
    }

    walk(LOCAL_INPUT_DIR, LOCAL_INPUT_DIR);

    res.json({ items });
  } catch (e) {
    console.error("[local-files] error:", e);
    res.status(500).json({
      error: { code: "LOCAL_LIST_FAILED", message: e.message || "list failed" }
    });
  }
});

router.get("/api/ffmpeg/caps", async (req, res) => {
  try {
    const ffmpegBin = BINARY_FFMPEG_BIN;
    const caps = await getFfmpegCaps(ffmpegBin);

    res.json({
      ok: true,
      ffmpegBin,
      caps,
      ts: Date.now()
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e?.message || e)
    });
  }
});

router.post("/api/probe/file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "File is required" });
    }

    const finalPath = req.file.path;
    const probeData = await probeMediaFile(finalPath);
    const streams = parseStreams(probeData);
    const defaultSelection = getDefaultStreamSelection(streams);

    res.json({
      success: true,
      finalPath,
      streams,
      defaultSelection
    });
  } catch (error) {
    console.error("Probe error:", error);

    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (e) {}
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

 router.post("/api/probe/local", requireAuth, async (req, res) => {
   try {
     const { localPath } = req.body;

     if (!localPath) {
       return res.status(400).json({ error: "localPath is required" });
     }

     let relPath = String(localPath).trim();
     relPath = relPath.replace(/^[/\\]+/, "");
     const abs = path.resolve(LOCAL_INPUT_DIR, relPath);

     if (!abs.startsWith(LOCAL_INPUT_DIR)) {
       return res.status(400).json({ error: "Invalid localPath" });
     }

     if (!fs.existsSync(abs)) {
       return res.status(404).json({ error: "File not found" });
     }

     const probeData = await probeMediaFile(abs);
     const streams = parseStreams(probeData);
     const defaultSelection = getDefaultStreamSelection(streams);

     res.json({
       success: true,
       streams,
       defaultSelection
     });
   } catch (error) {
     console.error("Local probe error:", error);
     res.status(500).json({
       success: false,
       error: error.message
     });
   }
 });

router.post("/api/probe/cleanup", async (req, res) => {
  try {
    const { finalPath } = req.body || {};

    if (!finalPath) {
      return res.status(400).json({ error: "finalPath is required" });
    }

    const abs = path.resolve(finalPath);
    if (!abs.startsWith(UPLOAD_DIR)) {
      console.warn("[probe/cleanup] Attempt to delete outside UPLOAD_DIR:", abs);
      return res.status(400).json({ error: "Invalid path" });
    }

    if (fs.existsSync(abs)) {
      try {
        fs.unlinkSync(abs);
        console.log(`[probe/cleanup] Deleted probed file: ${abs}`);
      } catch (e) {
        console.error("[probe/cleanup] unlink failed:", e);
        return res.status(500).json({ error: e.message || "unlink failed" });
      }
    } else {
      console.log("[probe/cleanup] File already missing:", abs);
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("Probe cleanup error:", error);
    return res.status(500).json({ error: error.message || "internal" });
  }
});

router.post('/api/upload/chunk/cancel', async (req, res) => {
  try {
    const { uploadId } = req.body;

    if (!uploadId) {
      return res.status(400).json({ error: 'uploadId is required' });
    }

    console.log(`🧹 Cancelling upload: ${uploadId}`);

    let cleanedCount = 0;
    const uploadData = chunkStorage.get(uploadId);

    if (uploadData) {
      uploadData.canceled = true;

      if (uploadData.writeStream && !uploadData.writeStream.destroyed) {
        try {
          uploadData.writeStream.destroy();
          console.log('🛑 Write stream destroyed');
        } catch (e) {
          console.warn('Write stream destroy failed:', e);
        }
      }

      if (uploadData.finalPath && fs.existsSync(uploadData.finalPath)) {
        try {
          fs.unlinkSync(uploadData.finalPath);
          cleanedCount++;
          console.log(`✅ Final file deleted: ${uploadData.finalPath}`);
        } catch (err) {
          console.warn(`❌ Final file could not be deleted: ${uploadData.finalPath}`, err);
        }
      }
    } else {
      console.log(`[cancel] No uploadData in memory for ${uploadId}, doing fallback disk cleanup...`);
    }

    try {
      const uploadsDir = UPLOAD_DIR;
      const files = fs.readdirSync(uploadsDir);

      const uploadFiles = files.filter(file => file.includes(uploadId));
      for (const file of uploadFiles) {
        const filePath = path.join(uploadsDir, file);
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            cleanedCount++;
            console.log(`✅ Upload file deleted (fallback): ${filePath}`);
          }
        } catch (error) {
          console.warn(`❌ Upload file could not be deleted: ${filePath}`, error);
        }
      }
    } catch (dirError) {
      console.warn('Uploads directory could not be read:', dirError);
    }

    if (uploadData) {
      chunkStorage.delete(uploadId);
    }

    console.log(`✅ Upload canceled: ${uploadId}, ${cleanedCount} files cleaned up`);

    return res.json({
      success: true,
      message: 'Upload successfully canceled',
      cleanedCount
    });

  } catch (error) {
    console.error('Upload cancel error:', error);
    return res.status(500).json({ error: error.message });
  }
});

router.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return sendError(res, ERR.JOB_NOT_FOUND, "Job not found", 404);
  return sendOk(res, job);
});

router.get("/api/stream/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.flushHeaders?.();
  res.write(`: ping\n\n`);

  // Sends update in Express API request handling.
  const sendUpdate = () => {
    try { res.write(`data: ${JSON.stringify(job)}\n\n`); } catch {}
  };

  sendUpdate();

  const interval = setInterval(() => {
    sendUpdate();
    if (job.status === "completed" || job.status === "error" || job.status === "canceled") {
      clearInterval(interval);
      res.end();
    }
  }, 1000);

  req.on("close", () => clearInterval(interval));
});

router.post("/api/jobs/:id/cancel", (req, res) => {
  const id = req.params.id;
  const job = jobs.get(id);
  if (!job) return sendError(res, ERR.JOB_NOT_FOUND, "Job not found", 404);

  if (job.status === "completed" || job.status === "error" || job.status === "canceled") {
    return sendOk(res, { id, status: job.status });
  }

  job.canceled = true;
  job.status = "canceled";
  job.currentPhase = "canceled";
  job.error = null;
  job.canceledBy = "user";
  try { killJobProcesses(id); } catch {}

  try {
   const TEMP_DIR = path.resolve(process.cwd(), "temp");
   const jobDir = path.join(TEMP_DIR, id);
   if (fs.existsSync(jobDir)) fs.rmSync(jobDir, { recursive: true, force: true });
 } catch {}

  return sendOk(res, { id, status: "canceled" });
});

router.post("/api/debug/lyrics", async (req, res) => {
  try {
    const { artist, title } = req.body;

    if (!artist || !title) {
      return res.status(400).json({ error: "Artist and title are required" });
    }

    console.log(`🔍 Test lyrics search: "${artist}" - "${title}"`);

    const lyricsPath = await lyricsFetcher.downloadLyrics(
      artist,
      title,
      null,
      path.join(process.cwd(), "test_output")
    );

    if (lyricsPath) {
      const content = fs.readFileSync(lyricsPath, 'utf8');
      return res.json({
        success: true,
        path: lyricsPath,
        content: content.substring(0, 500) + "..."
      });
    } else {
      return res.json({ success: false, message: "Lyrics not found" });
    }
  } catch (error) {
    console.error("Test lyrics error:", error);
    return res.status(500).json({ error: error.message });
  }
});

const chunkStorage = new Map();

router.post('/api/upload/chunk', upload.single('chunk'), async (req, res) => {
  let chunk;

  try {
    const { chunkIndex, totalChunks, uploadId, originalName, purpose } = req.body;
    chunk = req.file;

    if (!chunk || !uploadId) {
      return res.status(400).json({ error: 'Missing parameters' });
    }

    try {
      const oldPath = chunk.path;
      const dir = path.dirname(oldPath);
      const base = path.basename(oldPath);
      if (!base.includes(uploadId)) {
        const newName = `${uploadId}_${base}`;
        const newPath = path.join(dir, newName);
        fs.renameSync(oldPath, newPath);
        chunk.path = newPath;
        console.log(`📝 Chunk temp renamed: ${oldPath} -> ${newPath}`);
      }
    } catch (e) {
      console.warn('Chunk temp rename failed:', e);
    }

    if (!chunkStorage.has(uploadId)) {
      chunkStorage.set(uploadId, {
        chunks: new Array(parseInt(totalChunks, 10)),
        originalName,
        totalChunks: parseInt(totalChunks, 10),
        createdAt: Date.now(),
        writeStream: null,
        finalPath: null,
        completedChunks: 0,
        canceled: false
      });
    }

    const uploadData = chunkStorage.get(uploadId);
    const chunkIndexNum = parseInt(chunkIndex, 10);

    if (uploadData.canceled) {
      try {
        fs.unlink(chunk.path, () => {});
      } catch {}
      return res.status(410).json({ error: 'Upload canceled' });
    }

    if (chunkIndexNum === 0 && !uploadData.writeStream) {
      const finalPath = path.join(UPLOAD_DIR, `${uploadId}_${originalName}`);
      const ws = fs.createWriteStream(finalPath);

      ws.on('error', (err) => {
        console.warn(`Write stream error for ${uploadId}:`, err);
      });

      uploadData.writeStream = ws;
      uploadData.finalPath = finalPath;
    }

    if (!uploadData.writeStream) {
      return res.status(500).json({ error: 'Write stream could not be created' });
    }

    await new Promise((resolve, reject) => {
      const rs = fs.createReadStream(chunk.path);

      rs.on('error', (err) => {
        console.error('Chunk read error:', err);
        reject(err);
      });

      rs.pipe(uploadData.writeStream, { end: false });

      rs.on('end', () => {
        resolve();
      });
    });

    try {
      fs.unlink(chunk.path, () => {});
    } catch (err) {
      console.warn('Temporary chunk could not be deleted:', chunk.path, err);
    }

    uploadData.chunks[chunkIndexNum] = { size: chunk.size, path: chunk.path };
    uploadData.completedChunks = (uploadData.completedChunks || 0) + 1;

    const completedChunks = uploadData.completedChunks;

    if (completedChunks === uploadData.totalChunks && uploadData.writeStream) {
      uploadData.writeStream.end();
      if (purpose === 'probe') {
        uploadData.writeStream.on('finish', async () => {
          console.log(`✅ All chunks merged (probe): ${uploadData.finalPath}`);
          try {
            const probeData = await probeMediaFile(uploadData.finalPath);
            const streams = parseStreams(probeData);
            const defaultSelection = getDefaultStreamSelection(streams);

            return res.json({
              success: true,
              finalPath: uploadData.finalPath,
              streams,
              defaultSelection,
              mode: 'probe'
            });
          } catch (err) {
            console.error('Probe after chunk error:', err);
            return res.status(500).json({
              success: false,
              error: err.message
            });
          } finally {
            chunkStorage.delete(uploadId);
          }
        });

        return;
      }

      uploadData.writeStream.on('finish', () => {
        console.log(`✅ All chunks merged: ${uploadData.finalPath}`);
      });

      return res.json({
        success: true,
        finalPath: uploadData.finalPath,
        message: 'File uploaded successfully'
      });
    }

    const progress = (completedChunks / uploadData.totalChunks) * 100;

    return res.json({
      success: true,
      progress,
      message: `Chunk ${chunkIndexNum + 1}/${totalChunks} uploaded`
    });
    } catch (error) {
    console.error('Chunk upload error:', error);

    const { uploadId } = req.body || {};
    const uploadData = chunkStorage.get(uploadId);

    if (uploadData && uploadData.writeStream) {
      try {
        uploadData.writeStream.destroy();
      } catch (e) {
        console.warn('Write stream destroy failed in catch:', e);
      }
    }

    try {
      if (chunk && chunk.path && fs.existsSync(chunk.path)) {
        fs.unlinkSync(chunk.path);
        console.log(`🧹 Deleted failed chunk file: ${chunk.path}`);
      }
    } catch (e) {
      console.warn('Failed to delete failed chunk file:', chunk?.path, e);
    }

    return res.status(500).json({ error: error.message });
  }
});

router.post("/api/jobs", upload.single("file"), async (req, res) => {
  try {
    const body = req.body || {};
    console.log("📦 RAW req.body.youtubeConcurrency:", body.youtubeConcurrency, "typeof:", typeof body.youtubeConcurrency);
    const metadata = {};
    const autoCreateZip =
   body.autoCreateZip === undefined
     ? true
     : (body.autoCreateZip === true || body.autoCreateZip === 'true');
    metadata.autoCreateZip = autoCreateZip;

    const finalUploadPath = body.finalUploadPath;
    const localPath = body.localPath;
    let inputPath = null;

    if (finalUploadPath && fs.existsSync(finalUploadPath)) {
      inputPath = finalUploadPath;
      metadata.source = metadata.source || "file";
      metadata.originalName = metadata.originalName || path.basename(finalUploadPath).replace(/^[^_]+_/, '');
    } else if (req.file) {
      inputPath = req.file.path;
    }

    if (!inputPath && localPath) {
    let relPath = String(localPath).trim();
    relPath = relPath.replace(/^[/\\]+/, "");
    const abs = path.resolve(LOCAL_INPUT_DIR, relPath);
    if (!abs.startsWith(LOCAL_INPUT_DIR)) {
      return sendError(res, "INVALID_LOCAL_PATH", "Invalid localPath", 400);
    }

    if (!fs.existsSync(abs)) {
      return sendError(res, "LOCAL_FILE_NOT_FOUND", "Local file not found", 404);
    }
    inputPath = abs;
    metadata.source = "local";
    metadata.originalName = path.basename(abs);
    metadata.localPath = abs;
  }

    const {
      url,
      format = "mp3",
      bitrate = "192k",
      sampleRate = "48000",
      bitDepth,
      sampleRateHz,
      compressionLevel,
      isPlaylist = false,
      selectedIndices,
      clientBatch,
      spotifyMapId,
      includeLyrics = false,
      embedLyrics = false,
      volumeGain,
      spotifyConcurrency,
      stereoConvert = "auto",
      atempoAdjust = "none",
      videoSettings: rawVideoSettings,
      selectedStreams,
      youtubeConcurrency,
      frozenEntries: rawFrozenEntries
    } = body;
    const includeLyricsFlag =
      includeLyrics === true || includeLyrics === "true" || includeLyrics === "1";
    const embedLyricsFlag =
      embedLyrics === true || embedLyrics === "true" || embedLyrics === "1";

    let frozenEntriesParsed = null;
    if (rawFrozenEntries) {
      if (typeof rawFrozenEntries === "string") {
        try {
          const parsed = JSON.parse(rawFrozenEntries);
          if (Array.isArray(parsed)) {
            frozenEntriesParsed = parsed;
          } else {
            console.warn("frozenEntries (string) JSON parsed but not an array");
          }
        } catch (e) {
          console.warn("Failed to parse frozenEntries JSON:", e.message);
        }
      } else if (Array.isArray(rawFrozenEntries)) {
        frozenEntriesParsed = rawFrozenEntries;
      } else {
        console.warn("Unsupported frozenEntries type:", typeof rawFrozenEntries);
      }
    }

    const parsedYoutubeConc = Number(youtubeConcurrency);
    const youtubeConcurrencyNormalized =
      Number.isFinite(parsedYoutubeConc) && parsedYoutubeConc > 0
        ? Math.min(16, Math.max(1, Math.round(parsedYoutubeConc)))
        : 4;

    console.log("🎛️ UI youtubeConcurrency:", youtubeConcurrency);
    console.log("🎛️ Normalized concurrency:", youtubeConcurrencyNormalized);

    let selectedStreamsParsed = null;
    if (selectedStreams) {
      if (typeof selectedStreams === "string") {
        try {
          selectedStreamsParsed = JSON.parse(selectedStreams);
        } catch (e) {
          console.warn("Failed to parse selectedStreams JSON:", e.message);
        }
      } else if (typeof selectedStreams === "object") {
        selectedStreamsParsed = selectedStreams;
      }
    }

    // Parses sr for Express API request handling.
    const parseSR = (v) => {
      if (v == null) return NaN;
      const s = String(v).trim().toLowerCase();
      const m = s.match(/^(\d+(?:\.\d+)?)\s*k(?:hz)?$/i);
      if (m) return Math.round(parseFloat(m[1]) * 1000);
      const n = Number(s.replace(/[^0-9.]/g, ""));
      return Number.isFinite(n) ? Math.round(n) : NaN;
    };
    const pickedSR =
      Number.isFinite(parseSR(sampleRate))    ? parseSR(sampleRate) :
      Number.isFinite(parseSR(sampleRateHz))  ? parseSR(sampleRateHz) :
      48000;

    // Normalizes flac level for Express API request handling.
    const normalizeFlacLevel = (fmt, val) => {
      if (fmt !== "flac") return null;
      const n = Number(val);
      if (!Number.isFinite(n)) return null;
      const clamped = Math.min(12, Math.max(0, Math.round(n)));
      return clamped;
    };

    const normalizedCompressionLevel = normalizeFlacLevel(format, compressionLevel);

    // Parses video settings for Express API request handling.
    const parseVideoSettings = (raw) => {
      if (!raw) return null;
      if (typeof raw === "string") {
        try {
          return JSON.parse(raw);
        } catch {
          console.warn("Failed to parse videoSettings JSON:", raw);
          return null;
        }
      }
      if (typeof raw === "object") return raw;
      return null;
    };

    const parsedVideoSettings = parseVideoSettings(rawVideoSettings);
    const effectiveVideoSettings =
      (format === "mp4" || format === "mkv") && parsedVideoSettings
        ? parsedVideoSettings
        : null;

    const supported = ["mp3","flac","wav","ogg","mp4","mkv","eac3","ac3","aac","dts"];
    if (!supported.includes(format)) {
      return sendError(res, ERR.INVALID_FORMAT, "Unsupported format", 400);
    }

    const validBitDepths = ["16", "24", "32f"];
    const normalizedBitDepth = validBitDepths.includes(String(bitDepth))
      ? String(bitDepth)
      : null;

    if (req.file) {
    inputPath = req.file.path;
    const origUtf8 = (typeof toUtf8Filename === "function")
      ? toUtf8Filename(req.file.originalname)
      : req.file.originalname;
    metadata.originalName = origUtf8;
    metadata.source = "file";
  }

    if (!inputPath && url) {
      if (isSpotifyUrl(url)) {
        metadata.source = "spotify";
        metadata.isPlaylist = true;
        metadata.isAutomix = false;

        if (spotifyMapId) {
          const task = spotifyMapTasks.get(spotifyMapId);
          if (task && task.status === "completed" && task.validItems?.length) {
            metadata.spotifyKind = "playlist";
            metadata.spotifyTitle = task.title;
            metadata.spotifyMapId = spotifyMapId;

            const validItems = task.validItems;
            metadata.selectedIndices = selectedIndices || "all";
            metadata.selectedIds = validItems.map(i => i.id);
            metadata.frozenEntries = validItems;
            metadata.frozenTitle = task.title || "Spotify";
          } else {
            return sendError(res, ERR.PREVIEW_FAILED, "Please complete Spotify mapping first", 400);
        }
        } else {
          let sp;
          try {
            sp = await resolveSpotifyUrl(url, { market: resolveMarket(req.body?.market) });
          } catch (e) {
            const msg = String(e?.message || "");
            if (msg.startsWith("SPOTIFY_MIX_UNSUPPORTED")) {
              return sendError(res, 'SPOTIFY_MIX_UNSUPPORTED', "This link is a personalized Spotify Mix. The Spotify Web API does not provide this content (404). Please copy the tracks from the Mix into a new playlist in the Spotify app and use that playlist URL instead.", 400);
            }
            throw e;
          }
          metadata.spotifyKind = sp.kind;
          metadata.spotifyTitle = sp.title;
          const all = sp.items || [];

          let sel = null;
          const rawSel = req.body?.selectedIndices;
          if (rawSel === "all") sel = "all";
          else if (Array.isArray(rawSel)) sel = rawSel.map(Number).filter(n => Number.isFinite(n) && n > 0);
          else if (typeof rawSel === "string" && rawSel.trim()) {
            sel = rawSel.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n>0);
            if (!sel.length) sel = null;
          }

          const itemsToUse = (sel && sel !== "all")
            ? sel.map(i => all[i-1]).filter(Boolean)
            : all;

          const ids = [];
          const frozen = [];
          for (let i = 0; i < itemsToUse.length; i++) {
            const it = itemsToUse[i];
            const vid = await searchYtmBestId(it.artist, it.title);
            if (!vid) continue;
            ids.push(vid);
            frozen.push({
              index: (sel && sel !== "all") ? sel[i] : (i+1),
              id: vid,
              title: it.title,
              uploader: it.artist,
              webpage_url: `https://music.youtube.com/watch?v=${vid}`,
              thumbnails: []
            });
          }

          if (!ids.length) return sendError(res, ERR.PREVIEW_FAILED, "No Spotify matches found", 400);

          metadata.selectedIndices = sel || "all";
          metadata.selectedIds = ids;
          metadata.frozenEntries = frozen;
          metadata.frozenTitle = sp.title || "Spotify";
        }
      }

    else if (isYouTubeUrl(url) || isDailymotionUrl(url)) {
      const isYouTubeSource = isYouTubeUrl(url);
      const normalized = isYouTubeSource ? normalizeYouTubeUrl(url) : String(url).trim();
      metadata.source = "youtube";
      metadata.url = normalized;
      metadata.originalUrl = url;

      const playlistUrl = isYouTubeSource
        ? isYouTubePlaylist(normalized)
        : isDailymotionPlaylist(normalized);
      const automixUrl  = isYouTubeSource ? isYouTubeAutomix(normalized) : false;
      metadata.isPlaylist = playlistUrl || automixUrl || (isPlaylist === true || isPlaylist === "true");
      metadata.isAutomix  = automixUrl;

      let sel = null;
      if (selectedIndices === "all") sel = "all";
      else if (Array.isArray(selectedIndices)) {
        sel = selectedIndices.map(Number).filter(n => Number.isFinite(n) && n>0);
      } else if (typeof selectedIndices === "string" && selectedIndices.trim()) {
        sel = selectedIndices.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n>0);
      } else {
        sel = metadata.isPlaylist ? "all" : null;
      }
      metadata.selectedIndices = sel;
      if (
        Array.isArray(req.body.selectedIds) &&
        req.body.selectedIds.length > 0 &&
        (isYouTubeSource || (Array.isArray(frozenEntriesParsed) && frozenEntriesParsed.length > 0))
      ) {
        if (!isYouTubeSource && Array.isArray(frozenEntriesParsed) && frozenEntriesParsed.length > 0) {
          const idToUrl = new Map(
            frozenEntriesParsed
              .filter((e) => e?.id && e?.webpage_url)
              .map((e) => [String(e.id), String(e.webpage_url)])
          );
          metadata.selectedIds = req.body.selectedIds
            .map((raw) => {
              const v = String(raw || "").trim();
              if (!v) return null;
              if (/^https?:\/\//i.test(v)) return v;
              return idToUrl.get(v) || v;
            })
            .filter(Boolean);
        } else {
          metadata.selectedIds = req.body.selectedIds;
        }
      }

      console.log("=== MEDIA DEBUG ===");
      console.log("platform:", isYouTubeSource ? "youtube" : "dailymotion");
      console.log("URL:", normalized);
      console.log("isPlaylist:", metadata.isPlaylist);
      console.log("isAutomix:", metadata.isAutomix);
      console.log("selectedIndices:", sel);
      console.log("req.body.selectedIds:", req.body.selectedIds);
      console.log("metadata.selectedIds (after merge):", metadata.selectedIds);
      console.log("================================");

      if (Array.isArray(frozenEntriesParsed) && frozenEntriesParsed.length > 0) {
    metadata.frozenEntries = frozenEntriesParsed;
    console.log("📌 YT frozenEntries attached from client. len =", frozenEntriesParsed.length);
  }

      if (metadata.isAutomix &&
          !metadata.selectedIds &&
          Array.isArray(sel) &&
          sel.length > 0 &&
          sel !== "all") {
        try {
          console.log("Resolving Automix IDs (fallback)...");
          const automixData = await resolveAutomixSelectedIds(normalized, sel);
          if (automixData.ids && automixData.ids.length > 0) {
            metadata.selectedIds = automixData.ids;
            metadata.frozenEntries = automixData.entries;
            metadata.frozenTitle = automixData.title;
            console.log("selectedIds fetched from API:", metadata.selectedIds);
          }
        } catch (error) {
          console.warn("Could not retrieve Automix IDs:", error.message);
        }
      }
    }
    else if (isSupportedPlatformUrl(url)) {
      metadata.source = "platform";
      metadata.platform = detectPlatform(url);
      metadata.url = url;
      metadata.originalUrl = url;
      metadata.isPlaylist = false;
      metadata.isAutomix = false;
    }

    else if (isDirectMediaUrl(url)) {
        metadata.source = "direct_url";
        inputPath = url;
      } else {
        return sendError(res, ERR.UNSUPPORTED_URL_FORMAT, "Unsupported URL format", 400);
      }
    }

    if (!inputPath && !url) {
      return sendError(res, ERR.URL_OR_FILE_REQUIRED, "A valid URL or file is required", 400);
    }

    const job = createJob({
      status: "queued",
      progress: 0,
      format,
      bitrate,
      sampleRate: pickedSR,
      compressionLevel: normalizedCompressionLevel,
      bitDepth: normalizedBitDepth,
      videoSettings: effectiveVideoSettings,
      metadata: {
        ...metadata,
        includeLyrics: includeLyricsFlag,
        embedLyrics: embedLyricsFlag,
        spotifyConcurrency: (Number.isFinite(Number(spotifyConcurrency)) && Number(spotifyConcurrency) > 0)
        ? Math.min(16, Math.max(1, Math.round(Number(spotifyConcurrency))))
        : undefined,
        stereoConvert: stereoConvert,
        atempoAdjust: atempoAdjust,
        compressionLevel: normalizedCompressionLevel,
        selectedStreams: selectedStreamsParsed,
        youtubeConcurrency: youtubeConcurrencyNormalized,
        volumeGain:
          volumeGain != null
            ? Number(volumeGain)
            : (selectedStreamsParsed && selectedStreamsParsed.volumeGain != null
                ? Number(selectedStreamsParsed.volumeGain)
                : null)
      },
      resultPath: null,
      error: null,
      clientBatch: clientBatch || null,
    });
    const jobId = job.id;

    let batchTotal = null;
    if (clientBatch && metadata.isPlaylist && metadata.selectedIndices && metadata.selectedIndices !== "all") {
      batchTotal = metadata.selectedIndices.length;
    }

    enqueueJob(jobId, () => processJob(jobId, inputPath, format, bitrate));

    return sendOk(res, {
      id: jobId,
      status: job.status,
      format,
      bitrate,
      sampleRate: job.sampleRate,
      source: metadata.source,
      isPlaylist: metadata.isPlaylist,
      isAutomix: metadata.isAutomix,
      selectedIndices: metadata.selectedIndices ?? null,
      selectedIds: metadata.selectedIds ?? null,
      clientBatch: job.clientBatch,
      batchTotal,
    });
  } catch (error) {
    console.error("Job creation error:", error);
    return sendError(res, ERR.INTERNAL, error.message || "internal", 500);
  }
});

router.get("/api/jobs", requireAuth, (req, res) => {
  try {
    cleanupCompletedJobsWithoutOutputs();

    const status = (req.query.status || "active").toLowerCase();
    const all = Array.from(jobs.values());
    const pick = (j) => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      downloadProgress: j.downloadProgress ?? 0,
      convertProgress: j.convertProgress ?? 0,
      currentPhase: j.currentPhase || "queued",
      format: j.format,
      bitrate: j.bitrate,
      videoSettings: j.videoSettings || null,
      createdAt: j.createdAt,
      resultPath: j.resultPath || null,
      zipPath: j.zipPath || null,
      playlist: j.playlist || null,
      skippedCount: j.skippedCount || 0,
      errorsCount: j.errorsCount || 0,
      lastLog: j.lastLog || null,
      canceledBy: j.canceledBy || null,
      metadata: {
        source: j.metadata?.source,
        isPlaylist: !!j.metadata?.isPlaylist,
        isAutomix: !!j.metadata?.isAutomix,
        frozenTitle: j.metadata?.frozenTitle || null,
        extracted: j.metadata?.extracted || null,
        skipStats: j.metadata?.skipStats || { skippedCount: 0, errorsCount: 0 },
        spotifyTitle: j.metadata?.spotifyTitle || null,
        originalName: j.metadata?.originalName || null,
        includeLyrics: !!j.metadata?.includeLyrics,
        lyricsStats: j.metadata?.lyricsStats || null,
        frozenEntries: Array.isArray(j.metadata?.frozenEntries)
          ? j.metadata.frozenEntries.map(e => ({
              index: e.index,
              title: e.title,
              hasLyrics: !!e.hasLyrics
            })).slice(0, 500)
          : null,
        counters: j.counters || { dlTotal: 0, dlDone: 0, cvTotal: 0, cvDone: 0 }
      },
    });

    let items = all.map(pick);
    if (status === "active")      items = items.filter(j => j.status!=="completed" && j.status!=="error");
    else if (status === "error")  items = items.filter(j => j.status==="error");
    else if (status === "completed") items = items.filter(j => j.status==="completed");
    items.sort((a,b)=> new Date(b.createdAt)-new Date(a.createdAt));
    res.json({ items });
  } catch (e) {
    res.status(500).json({ error:{ code:"LIST_FAIL", message:e.message || "list failed" }});
  }
});

router.get("/api/stream", requireAuth, (req, res) => {
  cleanupCompletedJobsWithoutOutputs();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Handles payload in Express API request handling.
  const payload = () => {
    const items = Array.from(jobs.values()).map(j => ({
      id: j.id,
      status: j.status,
      progress: j.progress,
      downloadProgress: j.downloadProgress ?? 0,
      convertProgress: j.convertProgress ?? 0,
      currentPhase: j.currentPhase || "queued",
      format: j.format,
      bitrate: j.bitrate,
      videoSettings: j.videoSettings || null,
      resultPath: j.resultPath || null,
      zipPath: j.zipPath || null,
      createdAt: j.createdAt,
      skippedCount: j.skippedCount || 0,
      errorsCount: j.errorsCount || 0,
      playlist: j.playlist || null,
      lastLog: j.lastLog || null,
      canceledBy: j.canceledBy || null,
      metadata: {
      source: j.metadata?.source,
      isPlaylist: !!j.metadata?.isPlaylist,
      isAutomix: !!j.metadata?.isAutomix,
      frozenTitle: j.metadata?.frozenTitle || null,
      extracted: j.metadata?.extracted || null,
      skipStats: j.metadata?.skipStats || { skippedCount: 0, errorsCount: 0 },
      spotifyTitle: j.metadata?.spotifyTitle || null,
      originalName: j.metadata?.originalName || null,
      includeLyrics: !!j.metadata?.includeLyrics,
      lyricsStats: j.metadata?.lyricsStats || null,
      frozenEntries: Array.isArray(j.metadata?.frozenEntries)
        ? j.metadata.frozenEntries.map(e => ({
            index: e.index,
            title: e.title,
            hasLyrics: !!e.hasLyrics
          })).slice(0, 500)
        : null,
      counters: j.counters || { dlTotal: 0, dlDone: 0, cvTotal: 0, cvDone: 0 }
      },
    }));
    return `data: ${JSON.stringify({ items })}\n\n`;
  };
  res.write(`: ping\n\n`);
  const iv = setInterval(()=>{ try{ res.write(payload()); }catch{} }, 1000);
  req.on("close", ()=> clearInterval(iv));
});

// Cleans up old chunks for Express API request handling.
function cleanupOldChunks() {
  const now = Date.now();
  const MAX_AGE = 2 * 60 * 60 * 1000;

  for (const [uploadId, uploadData] of chunkStorage.entries()) {
    if (now - uploadData.createdAt > MAX_AGE) {
      console.log(`🧹 Cleaning up old upload: ${uploadId}`);
      for (const chunkInfo of uploadData.chunks) {
        if (chunkInfo && chunkInfo.path && fs.existsSync(chunkInfo.path)) {
          try {
            fs.unlinkSync(chunkInfo.path);
          } catch (error) {
            console.warn(`Old chunk could not be deleted: ${chunkInfo.path}`, error);
          }
        }
      }
      chunkStorage.delete(uploadId);
    }
  }
}

setInterval(cleanupOldChunks, 30 * 60 * 1000);
setTimeout(cleanupOldChunks, 5000);

export default router;
