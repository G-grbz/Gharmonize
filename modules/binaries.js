import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const isElectron = !!process.versions.electron;
const resourcesPath =
  isElectron && typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : null;

const isPackagedElectron =
  !!resourcesPath && !resourcesPath.includes("node_modules");

const PACKAGED_BIN_DIR = resourcesPath
  ? path.join(resourcesPath, "bin")
  : null;
const DEV_BIN_DIR = path.resolve(__dirname, "..", "build", "bin");

// Selects exe name for core application logic.
function pickExeName(baseName) {
  if (process.platform === "win32") {
    return `${baseName}.exe`;
  }
  return baseName;
}

// Resolves bin for core application logic.
function resolveBin(envVarName, baseName) {
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }

  const exeName = pickExeName(baseName);
  if (PACKAGED_BIN_DIR) {
    const candidate = path.join(PACKAGED_BIN_DIR, exeName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  if (fs.existsSync(path.join(DEV_BIN_DIR, exeName))) {
    return path.join(DEV_BIN_DIR, exeName);
  }

  return exeName;
}

export const FFMPEG_BIN   = resolveBin("FFMPEG_BIN",   "ffmpeg");
export const FFPROBE_BIN  = resolveBin("FFPROBE_BIN",  "ffprobe");
export const MKVMERGE_BIN = resolveBin("MKVMERGE_BIN", "mkvmerge");
export const YTDLP_BIN    = resolveBin("YTDLP_BIN",    "yt-dlp");
export const DENO_BIN     = resolveBin("DENO_BIN",     "deno");

// Handles debug binaries in core application logic.
export function debugBinaries() {
  console.log("[binaries] isElectron:", isElectron);
  console.log("[binaries] isPackagedElectron:", isPackagedElectron);
  console.log("[binaries] PACKAGED_BIN_DIR:", PACKAGED_BIN_DIR);
  console.log("[binaries] DEV_BIN_DIR:", DEV_BIN_DIR);
  console.log("[binaries] FFMPEG_BIN:", FFMPEG_BIN);
  console.log("[binaries] YTDLP_BIN:", YTDLP_BIN);
  console.log("[binaries] FFPROBE_BIN:", FFPROBE_BIN);
  console.log("[binaries] MKVMERGE_BIN:", MKVMERGE_BIN);
  console.log("[binaries] DENO_BIN:", DENO_BIN);
}
