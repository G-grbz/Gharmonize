import fs from "fs";
import os from "os";
import path from "path";
import { resolveDownloadPathToAbs } from "./outputPaths.js";
import { uniqueId } from "./utils.js";

export const jobs = new Map();
export const spotifyMapTasks = new Map();
export const spotifyDownloadTasks = new Map();

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const DEFAULT_CACHE_DIR = path.resolve(BASE_DIR, "cache");
const JOBS_STATE_VERSION = 1;
const GC_INTERVAL_MS = 60 * 60 * 1000;
const PERSIST_INTERVAL_MS = 5 * 1000;
const JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const procByJob = new Map();
let lastPersistedSnapshot = "";

// Ensures cache directory is writable for job state persistence.
function ensureWritableDir(dirPath) {
  const target = String(dirPath || "").trim();
  if (!target) return false;
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Builds candidate cache paths for job state persistence.
function buildJobsStateCandidates() {
  const envDir = String(process.env.JOBS_STATE_DIR || process.env.CACHE_DIR || "").trim();
  const dirs = [
    envDir || null,
    DEFAULT_CACHE_DIR,
    path.join(os.tmpdir(), "gharmonize-cache")
  ].filter(Boolean);

  return Array.from(new Set(dirs)).map((dirPath) => ({
    dir: dirPath,
    file: path.join(dirPath, "jobs-state.json")
  }));
}

// Resolves readable and writable job state persistence paths.
function resolveJobsStatePaths() {
  const candidates = buildJobsStateCandidates();
  const writable = candidates.find((candidate) => ensureWritableDir(candidate.dir)) || null;

  if (writable && writable.dir !== DEFAULT_CACHE_DIR) {
    console.warn(
      `[store] Cache dir "${DEFAULT_CACHE_DIR}" is not writable, using "${writable.dir}" for jobs state persistence.`
    );
  }

  if (!writable) {
    console.warn("[store] No writable cache dir found, completed jobs persistence is disabled.");
  }

  return {
    readFiles: candidates.map((candidate) => candidate.file),
    writeFile: writable ? writable.file : null,
    writeDir: writable ? writable.dir : null
  };
}

const JOBS_STATE_PATHS = resolveJobsStatePaths();
const JOBS_STATE_FILE = JOBS_STATE_PATHS.writeFile;

function safeJsonClone(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function normalizeCounters(value) {
  const counters = value && typeof value === "object" ? value : {};
  return {
    dlTotal: Number(counters.dlTotal || 0) || 0,
    dlDone: Number(counters.dlDone || 0) || 0,
    cvTotal: Number(counters.cvTotal || 0) || 0,
    cvDone: Number(counters.cvDone || 0) || 0,
  };
}

function pickPersistedMetadata(metadata = {}) {
  const out = {
    source: metadata?.source || null,
    mediaPlatform: metadata?.mediaPlatform || null,
    isPlaylist: !!metadata?.isPlaylist,
    isAutomix: !!metadata?.isAutomix,
    frozenTitle: metadata?.frozenTitle || null,
    spotifyTitle: metadata?.spotifyTitle || null,
    outputSubdir: metadata?.outputSubdir || null,
    originalName: metadata?.originalName || null,
    includeLyrics: !!metadata?.includeLyrics,
    embedLyrics: !!metadata?.embedLyrics,
    volumeGain: metadata?.volumeGain ?? null,
    lang: metadata?.lang || null,
    url: metadata?.url || null,
    originalUrl: metadata?.originalUrl || null,
    skipStats: safeJsonClone(metadata?.skipStats, { skippedCount: 0, errorsCount: 0 }),
    lyricsStats: safeJsonClone(metadata?.lyricsStats, null),
    selectedStreams: safeJsonClone(metadata?.selectedStreams, null),
    selectedIndices: Array.isArray(metadata?.selectedIndices)
      ? metadata.selectedIndices.map((value) => Number(value)).filter(Number.isFinite)
      : null,
    ringtone: metadata?.ringtone
      ? {
          enabled: !!metadata.ringtone.enabled,
          target: metadata.ringtone.target || null,
          mode: metadata.ringtone.mode || null,
          durationSec: Number(metadata.ringtone.durationSec || 0) || null,
          startSec: metadata.ringtone.startSec != null
            ? Number(metadata.ringtone.startSec)
            : null,
          fadeInSec: metadata.ringtone.fadeInSec != null
            ? Number(metadata.ringtone.fadeInSec)
            : null,
          fadeOutSec: metadata.ringtone.fadeOutSec != null
            ? Number(metadata.ringtone.fadeOutSec)
            : null,
        }
      : null,
    frozenEntries: Array.isArray(metadata?.frozenEntries)
      ? metadata.frozenEntries
          .map((entry) => ({
            index: Number(entry?.index) || 0,
            title: entry?.title || null,
            hasLyrics: !!entry?.hasLyrics,
          }))
          .slice(0, 500)
      : null,
  };

  const extracted = metadata?.extracted;
  if (extracted && typeof extracted === "object") {
    out.extracted = {
      title: extracted.title || null,
      track: extracted.track || null,
      webpage_url: extracted.webpage_url || null,
      playlist_title: extracted.playlist_title || null,
      uploader: extracted.uploader || null,
      channel: extracted.channel || null,
    };
  } else {
    out.extracted = null;
  }

  return out;
}

// Serializes completed job for persisted job state storage.
function serializeCompletedJob(job) {
  if (!job || job.status !== "completed") return null;
  if (!job.completedAt) {
    job.completedAt = new Date().toISOString();
  }

  return {
    id: job.id,
    status: "completed",
    progress: Number(job.progress ?? 100) || 100,
    downloadProgress: Number(job.downloadProgress ?? 100) || 100,
    convertProgress: Number(job.convertProgress ?? 100) || 100,
    currentPhase: "completed",
    format: job.format || null,
    bitrate: job.bitrate || null,
    videoSettings: safeJsonClone(job.videoSettings, null),
    createdAt: job.createdAt || new Date().toISOString(),
    completedAt: job.completedAt,
    resultPath: safeJsonClone(job.resultPath, null),
    zipPath: job.zipPath || null,
    playlist: safeJsonClone(job.playlist, null),
    skippedCount: Number(job.skippedCount || 0) || 0,
    errorsCount: Number(job.errorsCount || 0) || 0,
    lastLog: job.lastLog || null,
    canceledBy: job.canceledBy || null,
    metadata: pickPersistedMetadata(job.metadata || {}),
    counters: normalizeCounters(job.counters),
  };
}

// Collects completed jobs that still have accessible outputs.
function collectPersistedJobs() {
  const items = [];
  for (const job of jobs.values()) {
    if (job?.status !== "completed") continue;
    if (!jobHasAnyExistingOutput(job)) continue;
    const serialized = serializeCompletedJob(job);
    if (serialized) items.push(serialized);
  }

  items.sort((a, b) => {
    const ta = new Date(a.completedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.completedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });

  return items;
}

// Builds persisted jobs payload for disk storage.
function buildPersistedJobsPayload() {
  const items = collectPersistedJobs();
  return {
    version: JOBS_STATE_VERSION,
    savedAt: new Date().toISOString(),
    jobs: items,
  };
}

// Writes completed jobs state to disk storage.
function writePersistedJobs(force = false) {
  if (!JOBS_STATE_FILE) return;

  cleanupCompletedJobsWithoutOutputs();
  const payload = buildPersistedJobsPayload();
  const snapshot = JSON.stringify({
    version: payload.version,
    jobs: payload.jobs,
  });

  if (!force && snapshot === lastPersistedSnapshot) {
    return;
  }

  try {
    fs.mkdirSync(JOBS_STATE_PATHS.writeDir, { recursive: true });

    if (!payload.jobs.length) {
      if (fs.existsSync(JOBS_STATE_FILE)) {
        fs.unlinkSync(JOBS_STATE_FILE);
      }
      lastPersistedSnapshot = snapshot;
      return;
    }

    const tmpFile = `${JOBS_STATE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(tmpFile, JOBS_STATE_FILE);
    lastPersistedSnapshot = snapshot;
  } catch (error) {
    console.warn("[store] Failed to persist completed jobs:", error);
  }
}

// Loads completed jobs state from disk storage.
function loadPersistedJobs() {
  try {
    const sourceFile = JOBS_STATE_PATHS.readFiles.find((filePath) => {
      try {
        return filePath && fs.existsSync(filePath);
      } catch {
        return false;
      }
    });

    if (!sourceFile) {
      lastPersistedSnapshot = JSON.stringify({
        version: JOBS_STATE_VERSION,
        jobs: collectPersistedJobs(),
      });
      return;
    }

    const raw = fs.readFileSync(sourceFile, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed?.jobs) ? parsed.jobs : [];

    for (const item of items) {
      if (!item || item.status !== "completed" || !item.id) continue;
      if (!jobHasAnyExistingOutput(item)) continue;

      jobs.set(item.id, {
        id: item.id,
        status: "completed",
        canceled: false,
        progress: Number(item.progress ?? 100) || 100,
        downloadProgress: Number(item.downloadProgress ?? 100) || 100,
        convertProgress: Number(item.convertProgress ?? 100) || 100,
        currentPhase: "completed",
        createdAt: item.createdAt || new Date().toISOString(),
        completedAt: item.completedAt || item.createdAt || new Date().toISOString(),
        metadata: pickPersistedMetadata(item.metadata || {}),
        resultPath: safeJsonClone(item.resultPath, null),
        zipPath: item.zipPath || null,
        playlist: safeJsonClone(item.playlist, null),
        counters: normalizeCounters(item.counters),
        format: item.format || null,
        bitrate: item.bitrate || null,
        videoSettings: safeJsonClone(item.videoSettings, null),
        skippedCount: Number(item.skippedCount || 0) || 0,
        errorsCount: Number(item.errorsCount || 0) || 0,
        lastLog: item.lastLog || null,
        canceledBy: item.canceledBy || null,
        error: null,
      });
    }
  } catch (error) {
    console.warn("[store] Failed to load persisted completed jobs:", error);
  }

  cleanupCompletedJobsWithoutOutputs();
  lastPersistedSnapshot = JSON.stringify({
    version: JOBS_STATE_VERSION,
    jobs: collectPersistedJobs(),
  });
}

// Resolves absolute output path from stored download path.
function resolveOutputPath(downloadPath) {
  if (!downloadPath) return null;
  return resolveDownloadPathToAbs(downloadPath);
}

// Checks whether stored output path still exists on disk.
function outputExists(downloadPath) {
  const abs = resolveOutputPath(downloadPath);
  if (!abs) return false;
  try {
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

export function jobHasAnyExistingOutput(job) {
  if (!job) return false;

  if (job.zipPath && outputExists(job.zipPath)) {
    return true;
  }

  const resultPath = job.resultPath;
  if (Array.isArray(resultPath)) {
    return resultPath.some((entry) => {
      if (!entry) return false;
      const downloadPath =
        typeof entry === "string" ? entry : (entry.outputPath || entry.path);
      return outputExists(downloadPath);
    });
  }

  if (resultPath && typeof resultPath === "object") {
    return outputExists(resultPath.outputPath || resultPath.path);
  }

  if (typeof resultPath === "string") {
    return outputExists(resultPath);
  }

  return false;
}

export function cleanupCompletedJobsWithoutOutputs() {
  let removed = 0;

  for (const [id, job] of jobs.entries()) {
    if (job?.status !== "completed") continue;
    if (jobHasAnyExistingOutput(job)) continue;

    jobs.delete(id);
    procByJob.delete(id);
    removed++;
  }

  if (removed > 0) {
    console.log(`[store] ${removed} completed jobs without outputs were cleaned up.`);
  }

  return removed;
}

loadPersistedJobs();

const persistInterval = setInterval(() => {
  writePersistedJobs();
}, PERSIST_INTERVAL_MS);
persistInterval.unref?.();

process.once("beforeExit", () => {
  writePersistedJobs(true);
});

process.once("exit", () => {
  writePersistedJobs(true);
});

// Creates job state for core application logic.
export function createJob(initial = {}) {
  const id = uniqueId("job");
  const job = {
    id,
    status: "queued",
    canceled: false,
    progress: 0,
    downloadProgress: 0,
    convertProgress: 0,
    currentPhase: "queued",
    createdAt: new Date(),
    metadata: {},
    resultPath: null,
    error: null,
    ...initial,
    id,
    createdAt: initial.createdAt || new Date(),
  };
  jobs.set(id, job);
  return job;
}

// Returns job state used for core application logic.
export function getJob(id) { return jobs.get(id); }

// Marks a job as completed once and preserves the original completion time.
export function markJobCompleted(job, completedAt = new Date().toISOString()) {
  if (!job) return job;
  job.status = "completed";
  if (!job.completedAt) {
    job.completedAt = completedAt;
  }
  return job;
}

// Handles register job state process in core application logic.
export function registerJobProcess(jobId, child) {
  if (!jobId || !child) return;
  let set = procByJob.get(jobId);
  if (!set) { set = new Set(); procByJob.set(jobId, set); }
  set.add(child);
  // Cleans up cleanup for core application logic.
  const cleanup = () => { try { set.delete(child); } catch {} };
  child.on?.('exit', cleanup);
  child.on?.('close', cleanup);
}

// Handles kill job state processes in core application logic.
export function killJobProcesses(jobId) {
  const set = procByJob.get(jobId);
  if (!set || set.size === 0) return 0;
  let killed = 0;
  for (const ch of Array.from(set)) {
    try { ch.kill?.('SIGTERM'); setTimeout(()=>{ try { ch.kill?.('SIGKILL'); } catch {} }, 500); killed++; } catch {}
  }
  return killed;
}

export function getJobProcessCount(jobId) {
  const set = procByJob.get(jobId);
  return set ? set.size : 0;
}

setInterval(() => {
  const now = Date.now();

  for (const [id, job] of jobs.entries()) {
    if (!job?.createdAt) continue;
    if (job.status === "completed") {
      if (!jobHasAnyExistingOutput(job)) {
        jobs.delete(id);
        procByJob.delete(id);
      }
      continue;
    }

    const finished = job.status === "error";
    if (finished && (now - new Date(job.createdAt).getTime()) > JOB_MAX_AGE_MS) {
      jobs.delete(id);
      procByJob.delete(id);
    }
  }

  for (const [id, task] of spotifyMapTasks.entries()) {
    if (!task?.createdAt) continue;
    const finished = task.status === "completed" || task.status === "error";
    if (finished && (now - new Date(task.createdAt).getTime()) > JOB_MAX_AGE_MS) {
      spotifyMapTasks.delete(id);
    }
  }
}, GC_INTERVAL_MS);

export { procByJob };
