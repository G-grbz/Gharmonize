import express from "express";
import path from "path";
import fs from "fs";
import { spawnSafe } from "../modules/safeProcess.js";
import { resolveDownloadPathToAbs } from "../modules/outputPaths.js";
import { sanitizeLogValue } from "../modules/security.js";
import { rateLimit } from "../modules/rateLimit.js";

const router = express.Router();
const BASE_DIR = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");
const OUTPUTS_DISPLAY_DIR_RAW = String(process.env.OUTPUTS_DISPLAY_DIR || "").trim();
const OUTPUTS_DISPLAY_DIR = OUTPUTS_DISPLAY_DIR_RAW
  ? (path.isAbsolute(OUTPUTS_DISPLAY_DIR_RAW)
      ? path.resolve(OUTPUTS_DISPLAY_DIR_RAW)
      : path.resolve(BASE_DIR, OUTPUTS_DISPLAY_DIR_RAW))
  : OUTPUT_DIR;

// Resolves safest existing output root for open-folder operations.
function resolveOpenRootDir() {
  const candidates = [OUTPUTS_DISPLAY_DIR, OUTPUT_DIR];
  for (const c of candidates) {
    try {
      const abs = path.resolve(String(c || ""));
      if (!abs) continue;
      if (!fs.existsSync(abs)) continue;
      if (!fs.statSync(abs).isDirectory()) continue;
      return abs;
    } catch {
    }
  }
  return OUTPUT_DIR;
}

// Resolves output subdirectory safely against root.
function resolveOutputSubdirAbs(rawSubdir = "", outputRootDir = OUTPUT_DIR) {
  const root = path.resolve(outputRootDir || OUTPUT_DIR);
  const src = String(rawSubdir || "").trim();
  if (!src) return root;

  const parts = [];
  let current = "";
  for (const ch of src) {
    if (ch === "/" || ch === "\\") {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) parts.push(current);
  if (!parts.length) return root;
  if (parts.some((p) => p === "." || p === "..")) return null;

  const rel = parts.join(path.sep);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Spawns detached command and resolves when process starts.
function spawnDetached(command, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawnSafe(command, args, {
      detached: true,
      stdio: "ignore"
    });

    child.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });

    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      try { child.unref(); } catch {}
      resolve();
    });
  });
}

// Opens a directory using platform default file manager.
async function openDirectoryInFileManager(absDir) {
  const target = path.resolve(String(absDir || ""));
  const attempts = process.platform === "win32"
    ? [["explorer.exe", [target.replace(/\//g, "\\")]]]
    : process.platform === "darwin"
      ? [["open", [target]]]
      : [
          ["xdg-open", [target]],
          ["gio", ["open", target]]
        ];

  let lastError = null;
  for (const [cmd, args] of attempts) {
    try {
      await spawnDetached(cmd, args);
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error("No file manager opener available");
}

// Resolves output absolute path from download path-like input.
function resolveOutputPath(rawPath) {
  return resolveDownloadPathToAbs(rawPath, OUTPUT_DIR);
}

function encodeRfc5987Value(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function asciiFilenameFallback(filename) {
  const clean = String(filename || "download")
    .replace(/[\r\n]+/g, " ")
    .trim();
  const ascii = clean
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/[\\"]/g, "_")
    .trim();
  return ascii || "download";
}

function contentDispositionForFilename(filename) {
  const clean = String(filename || "download")
    .replace(/[\r\n]+/g, " ")
    .trim() || "download";
  const fallback = asciiFilenameFallback(clean).replace(/(["\\])/g, "\\$1");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(clean)}`;
}

function applyDownloadHeaders(res, abs, stat) {
  const filename = path.basename(abs);
  const isZip = filename.toLowerCase().endsWith(".zip");
  res.setHeader("Content-Type", isZip ? "application/zip" : "application/octet-stream");
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader("Content-Disposition", contentDispositionForFilename(filename));
}

function clearDownloadHeaders(res) {
  res.removeHeader("Content-Type");
  res.removeHeader("Content-Length");
  res.removeHeader("Content-Disposition");
}

function getRequestedDownloadPath(req) {
  return Array.isArray(req.params.filePath)
    ? req.params.filePath.join("/")
    : String(req.params.filePath || "").trim();
}

function handleDownload(req, res) {
  const requested = getRequestedDownloadPath(req);
  const abs = resolveOutputPath(`/download/${requested}`);
  if (!abs) {
    return res.status(400).send("Bad path");
  }

  fs.stat(abs, (statErr, stat) => {
    if (statErr) {
      if (statErr.code === "ENOENT" || statErr.code === "ENOTDIR") {
        // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
        console.warn("[download] Not found:", sanitizeLogValue(abs)); // codeql[js/log-injection]
        return res.status(404).send("Not found");
      }

      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.warn("[download] Stat failed:", sanitizeLogValue(abs), sanitizeLogValue(statErr?.message || statErr)); // codeql[js/log-injection]
      return res.status(500).send("Unable to read file");
    }

    if (!stat.isFile()) {
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.warn("[download] Not a file:", sanitizeLogValue(abs)); // codeql[js/log-injection]
      return res.status(404).send("Not found");
    }

    applyDownloadHeaders(res, abs, stat);

    if (req.method === "HEAD") {
      return res.status(200).end();
    }

    const stream = fs.createReadStream(abs);

    stream.once("error", (sendErr) => {
      // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
      console.warn("[download] Send failed:", sanitizeLogValue(abs), sanitizeLogValue(sendErr?.message || sendErr)); // codeql[js/log-injection]

      if (!res.headersSent) {
        clearDownloadHeaders(res);
        const missing = sendErr?.code === "ENOENT" || sendErr?.code === "ENOTDIR";
        return res.status(missing ? 404 : 500).send(missing ? "Not found" : "Unable to send file");
      }

      try {
        res.destroy(sendErr);
      } catch {}
    });

    stream.pipe(res);
  });
}

// Custom Gharmonize rateLimit middleware is applied on this route.
router.get("/api/outputs/location", rateLimit(120, 60_000), (_req, res) => { // codeql[js/missing-rate-limiting]
  const isWindows = process.platform === "win32";
  const linuxPath = isWindows ? OUTPUTS_DISPLAY_DIR.replace(/\\/g, "/") : OUTPUTS_DISPLAY_DIR;
  const windowsPath = isWindows ? OUTPUTS_DISPLAY_DIR : OUTPUTS_DISPLAY_DIR.replace(/\//g, "\\");

  res.json({
    outputDir: OUTPUT_DIR,
    displayDir: OUTPUTS_DISPLAY_DIR,
    linuxPath,
    windowsPath
  });
});

// Custom Gharmonize rateLimit middleware is applied on this route.
router.get("/api/outputs/exists", rateLimit(120, 60_000), (req, res) => { // codeql[js/missing-rate-limiting]
  const rawPath = req.query.path || req.query.url || "";
  const abs = resolveOutputPath(rawPath);
  const exists = !!(abs && fs.existsSync(abs));
  res.json({ exists });
});

// Custom Gharmonize rateLimit middleware is applied on this route.
router.post("/api/outputs/open", rateLimit(30, 60_000), async (req, res) => { // codeql[js/missing-rate-limiting]
  try {
    const openRoot = resolveOpenRootDir();
    const subdir = req.body?.subdir || req.body?.outputSubdir || "";
    const targetDir = resolveOutputSubdirAbs(subdir, openRoot);

    if (!targetDir) {
      return res.status(400).json({ ok: false, error: "Invalid output folder path" });
    }
    if (!fs.existsSync(targetDir)) {
      return res.status(404).json({ ok: false, error: "Output folder not found" });
    }
    if (!fs.statSync(targetDir).isDirectory()) {
      return res.status(400).json({ ok: false, error: "Output path is not a folder" });
    }

    await openDirectoryInFileManager(targetDir);
    return res.json({ ok: true, path: targetDir });
  } catch (err) {
    console.warn("[outputs/open] Failed:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Failed to open output folder"
    });
  }
});

// Custom Gharmonize rateLimit middleware is applied on this route.
router.head("/download/*filePath", rateLimit(120, 60_000), handleDownload); // codeql[js/missing-rate-limiting]
// Custom Gharmonize rateLimit middleware is applied on this route.
router.get("/download/*filePath", rateLimit(120, 60_000), handleDownload); // codeql[js/missing-rate-limiting]

export default router;
