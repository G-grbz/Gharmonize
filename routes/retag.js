import express from "express";
import { rateLimit } from "../modules/rateLimit.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { createJob } from "../modules/store.js";
import { enqueueJob } from "../modules/queue.js";
import { processRetagDirectoryJob } from "../modules/retag.js";
import { requireAuth } from "../modules/settings.js";
import { sendError, sendOk } from "../modules/utils.js";

const router = express.Router();
const BASE_DIR = process.env.DATA_DIR || process.cwd();
const TEMP_DIR = path.resolve(BASE_DIR, "temp");
const LOCAL_INPUT_DIR = process.env.LOCAL_INPUT_DIR
  ? path.resolve(process.env.LOCAL_INPUT_DIR)
  : path.resolve(BASE_DIR, "local-inputs");

function hasDesktopAccess(req) {
  const expected = String(process.env.GHARMONIZE_DESKTOP_TOKEN || "").trim();
  const provided = String(req.get("x-gharmonize-desktop-token") || "").trim();
  if (!expected) return false;
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  return providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);
}

function requireRetagAccess(req, res, next) {
  if (hasDesktopAccess(req)) {
    req.retagDesktopAccess = true;
    return next();
  }
  return requireAuth(req, res, next);
}

function realDirectory(directoryPath) {
  const raw = String(directoryPath || "").trim();
  if (!raw) {
    const error = new Error("A music directory must be selected");
    error.code = "RETAG_DIRECTORY_REQUIRED";
    throw error;
  }
  const resolved = path.resolve(raw);
  const real = fs.realpathSync(resolved);
  if (!fs.statSync(real).isDirectory()) throw new Error("The selected path is not a directory");
  return real;
}

function configuredWebRoots() {
  const configured = String(process.env.RETAG_ROOTS || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = configured.length
    ? configured
    : ["/music", LOCAL_INPUT_DIR];
  const roots = [];

  for (const candidate of candidates) {
    try {
      const real = realDirectory(candidate);
      if (!roots.includes(real)) roots.push(real);
    } catch {}
  }
  return roots;
}

function isWithin(directoryPath, rootPath) {
  const rel = path.relative(rootPath, directoryPath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveRequestedDirectory(req, rawPath) {
  const selected = realDirectory(rawPath);
  if (req.retagDesktopAccess) return selected;

  const allowed = configuredWebRoots();
  if (!allowed.some((root) => isWithin(selected, root))) {
    const error = new Error("The selected directory is outside the configured retag roots");
    error.code = "RETAG_DIRECTORY_FORBIDDEN";
    throw error;
  }
  return selected;
}

function directoryLabel(directoryPath) {
  return path.basename(directoryPath) || directoryPath;
}

// Custom Gharmonize rateLimit middleware is applied on this route.
// codeql[js/missing-rate-limiting]
router.get("/api/retag/directories", requireRetagAccess, rateLimit(60, 60_000), (req, res) => {
  try {
    if (req.retagDesktopAccess) {
      return sendOk(res, { desktop: true, roots: [], current: null, entries: [] });
    }

    const roots = configuredWebRoots();
    if (!roots.length) {
      return sendError(
        res,
        "RETAG_ROOTS_UNAVAILABLE",
        "No readable retag root is configured. Mount a music directory at /music or set RETAG_ROOTS.",
        503
      );
    }

    const rawPath = String(req.query.path || "").trim();
    if (!rawPath) {
      return sendOk(res, {
        desktop: false,
        roots: roots.map((root) => ({ path: root, name: directoryLabel(root) })),
        current: null,
        parentPath: null,
        entries: []
      });
    }

    const current = resolveRequestedDirectory(req, rawPath);
    const currentRoot = roots.find((root) => isWithin(current, root));
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(current);

    return sendOk(res, {
      desktop: false,
      roots: roots.map((root) => ({ path: root, name: directoryLabel(root) })),
      current,
      parentPath: current !== currentRoot && isWithin(parent, currentRoot) ? parent : null,
      entries
    });
  } catch (error) {
    const code = error?.code || "RETAG_DIRECTORY_READ_FAILED";
    const status = code === "RETAG_DIRECTORY_FORBIDDEN" ? 403 : 400;
    return sendError(res, code, error?.message || "Directory could not be read", status);
  }
});

// Custom Gharmonize rateLimit middleware is applied on this route.
// codeql[js/missing-rate-limiting]
router.post("/api/retag/jobs", requireRetagAccess, rateLimit(20, 60_000), (req, res) => {
  try {
    const directoryPath = resolveRequestedDirectory(req, req.body?.directoryPath);
    fs.accessSync(directoryPath, fs.constants.R_OK | fs.constants.W_OK);

    const job = createJob({
      status: "queued",
      progress: 0,
      format: "retag",
      bitrate: null,
      metadata: {
        source: "retag",
        isPlaylist: true,
        frozenTitle: directoryLabel(directoryPath),
        directoryName: directoryLabel(directoryPath)
      },
      resultPath: null,
      error: null
    });

    enqueueJob(job.id, () => processRetagDirectoryJob(job, { directoryPath, tempRoot: TEMP_DIR }));

    return sendOk(res, {
      id: job.id,
      status: job.status,
      format: job.format,
      source: "retag",
      directoryName: job.metadata.directoryName
    });
  } catch (error) {
    const code = error?.code || "RETAG_START_FAILED";
    const status = code === "RETAG_DIRECTORY_FORBIDDEN"
      ? 403
      : (error?.code === "EACCES" ? 403 : 400);
    return sendError(res, code, error?.message || "Retagging could not be started", status);
  }
});

export default router;
