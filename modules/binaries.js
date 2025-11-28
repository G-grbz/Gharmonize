import path from "node:path";
import fs from "node:fs";

const isElectron = !!process.versions.electron;

const isPackagedElectron =
  isElectron &&
  typeof process.resourcesPath === "string" &&
  process.resourcesPath.length > 0;

const DESKTOP_BIN_DIR = isPackagedElectron
  ? path.join(process.resourcesPath, "bin")
  : path.join(process.cwd(), "build", "bin");

function pickExeName(baseName) {
  if (process.platform === "win32") {
    return `${baseName}.exe`;
  }
  return baseName;
}

function resolveBin(envVarName, baseName) {
  if (process.env[envVarName]) {
    return process.env[envVarName];
  }

  const exeName = pickExeName(baseName);

  if (isPackagedElectron) {
    const candidate = path.join(DESKTOP_BIN_DIR, exeName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const devCandidate = path.join(DESKTOP_BIN_DIR, exeName);
  if (!isPackagedElectron && fs.existsSync(devCandidate)) {
    return devCandidate;
  }

  return exeName;
}

export const FFMPEG_BIN   = resolveBin("FFMPEG_BIN",   "ffmpeg");
export const FFPROBE_BIN  = resolveBin("FFPROBE_BIN",  "ffprobe");
export const MKVMERGE_BIN = resolveBin("MKVMERGE_BIN", "mkvmerge");
export const YTDLP_BIN    = resolveBin("YTDLP_BIN",    "yt-dlp");
