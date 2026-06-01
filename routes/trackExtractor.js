import express from "express";
import fs from "fs";
import path from "path";
import { sendError, sendOk, ERR } from "../modules/utils.js";
import { createJob } from "../modules/store.js";
import { enqueueJob } from "../modules/queue.js";
import {
  buildTrackExtractorOutputSubdir,
  extractTracksForJob,
  inspectTrackSource,
  selectTracksByIndex
} from "../modules/trackExtractor.js";

const router = express.Router();
const BASE_DIR = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");

function getDesktopToken(req) {
  return String(req.get("x-gharmonize-desktop-token") || "").trim();
}

function requireDesktopBridge(req, res, next) {
  const expected = String(process.env.GHARMONIZE_DESKTOP_TOKEN || "").trim();
  if (!expected) {
    return sendError(
      res,
      "DESKTOP_BRIDGE_DISABLED",
      "Track extractor desktop bridge is not available",
      403
    );
  }

  if (getDesktopToken(req) !== expected) {
    return sendError(res, "DESKTOP_BRIDGE_FORBIDDEN", "Forbidden", 403);
  }

  next();
}

function ensureSafeOutputSubdir(relSubdir) {
  const rel = String(relSubdir || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(OUTPUT_DIR, rel);
  if (abs !== OUTPUT_DIR && !abs.startsWith(OUTPUT_DIR + path.sep)) {
    throw new Error("Invalid output directory");
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

router.post("/api/track-extractor/probe", requireDesktopBridge, async (req, res) => {
  try {
    const sourcePath = req.body?.sourcePath;
    if (!sourcePath) {
      return sendError(res, ERR.FILE_NOT_FOUND, "sourcePath is required", 400);
    }

    const inspected = await inspectTrackSource(sourcePath);
    return sendOk(res, inspected);
  } catch (error) {
    console.error("[track-extractor/probe] failed:", error);
    return sendError(
      res,
      "TRACK_EXTRACTOR_PROBE_FAILED",
      error?.message || "Track probe failed",
      500
    );
  }
});

router.post("/api/track-extractor/extract", requireDesktopBridge, async (req, res) => {
  try {
    const sourcePath = req.body?.sourcePath;
    const requestedTracks = req.body?.tracks;

    if (!sourcePath) {
      return sendError(res, ERR.FILE_NOT_FOUND, "sourcePath is required", 400);
    }
    if (!Array.isArray(requestedTracks) || requestedTracks.length === 0) {
      return sendError(res, "NO_TRACKS_SELECTED", "No tracks selected", 400);
    }

    const inspected = await inspectTrackSource(sourcePath);
    const selectedTracks = selectTracksByIndex(inspected.tracks, requestedTracks);

    if (!selectedTracks.length) {
      return sendError(res, "NO_TRACKS_SELECTED", "No matching tracks selected", 400);
    }

    const job = createJob({
      status: "queued",
      progress: 0,
      format: "extract",
      bitrate: null,
      metadata: {
        source: "track_extractor",
        originalName: inspected.fileName,
        sourcePath: inspected.sourcePath,
        selectedTracks
      },
      resultPath: null,
      error: null
    });

    const outputSubdir = buildTrackExtractorOutputSubdir(inspected.sourcePath, job.id);
    job.metadata.outputSubdir = outputSubdir;
    const outputDir = ensureSafeOutputSubdir(outputSubdir);

    enqueueJob(job.id, () => extractTracksForJob(job, {
      sourcePath: inspected.sourcePath,
      tracks: selectedTracks,
      outputDir,
      outputRootDir: OUTPUT_DIR
    }));

    return sendOk(res, {
      id: job.id,
      status: job.status,
      outputSubdir,
      tracks: selectedTracks,
      source: "track_extractor"
    });
  } catch (error) {
    console.error("[track-extractor/extract] failed:", error);
    return sendError(
      res,
      "TRACK_EXTRACTOR_START_FAILED",
      error?.message || "Track extraction could not be started",
      500
    );
  }
});

export default router;
