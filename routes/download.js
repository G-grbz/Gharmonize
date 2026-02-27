import express from "express";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import { resolveDownloadPathToAbs } from "../modules/outputPaths.js";

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
  const src = String(rawSubdir || "").trim().replace(/^[/\\]+|[/\\]+$/g, "");
  if (!src) return root;

  const parts = src.split(/[\\/]+/).filter(Boolean);
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
    const child = spawn(command, args, {
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

router.get("/api/outputs/location", (_req, res) => {
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

router.get("/api/outputs/exists", (req, res) => {
  const rawPath = req.query.path || req.query.url || "";
  const abs = resolveOutputPath(rawPath);
  const exists = !!(abs && fs.existsSync(abs));
  res.json({ exists });
});

router.post("/api/outputs/open", async (req, res) => {
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

router.get("/download/*", (req, res) => {
  const requested = String(req.params?.[0] || "").trim();
  const abs = resolveOutputPath(`/download/${requested}`);
  if (!abs) {
    return res.status(400).send("Bad path");
  }

  if (!fs.existsSync(abs)) {
    console.warn("[download] Not found:", abs);
    return res.status(404).send("Not found");
  }

  const filename = path.basename(abs);
  const isZip = filename.toLowerCase().endsWith(".zip");
  res.setHeader("Content-Type", isZip ? "application/zip" : "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  return res.download(abs, filename);
});

export default router;
