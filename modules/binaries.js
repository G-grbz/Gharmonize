import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
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
const IS_DOCKER = fs.existsSync("/.dockerenv");
const WEB_BINARIES_IN_DOCKER = process.env.GHARMONIZE_WEB_BINARIES_IN_DOCKER === "1";
const WEB_BINARIES_ENABLED = IS_DOCKER
  ? WEB_BINARIES_IN_DOCKER || process.env.GHARMONIZE_WEB_BINARIES === "1"
  : process.env.GHARMONIZE_WEB_BINARIES !== "0";
const WEB_FORCE_DOCKER_OVERRIDE = IS_DOCKER && WEB_BINARIES_IN_DOCKER;
const WEB_TIMEOUT_MS = Math.max(1000, Number(process.env.GHARMONIZE_WEB_TIMEOUT_MS || 5000));
const WEB_TTL_MS = Math.max(60_000, Number(process.env.GHARMONIZE_WEB_TTL_MS || (6 * 60 * 60 * 1000)));
const GH_HEADERS = {
  "User-Agent": "Gharmonize-Binaries",
  "Accept": "application/vnd.github+json"
};

const YTDLP_ASSETS = {
  linux: {
    x64: "yt-dlp_linux",
    arm64: "yt-dlp_linux_aarch64"
  },
  win32: {
    x64: "yt-dlp.exe",
    arm64: "yt-dlp.exe"
  },
  darwin: {
    x64: "yt-dlp_macos",
    arm64: "yt-dlp_macos"
  }
};

const DENO_ASSETS = {
  linux: {
    x64: "deno-x86_64-unknown-linux-gnu.zip",
    arm64: "deno-aarch64-unknown-linux-gnu.zip"
  },
  win32: {
    x64: "deno-x86_64-pc-windows-msvc.zip",
    arm64: "deno-aarch64-pc-windows-msvc.zip"
  },
  darwin: {
    x64: "deno-x86_64-apple-darwin.zip",
    arm64: "deno-aarch64-apple-darwin.zip"
  }
};

// Selects exe name for core application logic.
function pickExeName(baseName) {
  if (process.platform === "win32") {
    return `${baseName}.exe`;
  }
  return baseName;
}

// Finds executable in PATH for binary resolution.
function findOnPath(exeName) {
  const allPaths = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const p of allPaths) {
    const candidate = path.join(p, exeName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }
  return null;
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

  const fromPath = findOnPath(exeName);
  if (fromPath) {
    return fromPath;
  }

  return exeName;
}

// Returns web cache directory used for web-first binaries.
function resolveWebCacheDir() {
  const fromEnv = String(process.env.GHARMONIZE_WEB_CACHE_DIR || "").trim();
  const dataDir = String(process.env.DATA_DIR || "").trim();
  const homeDir = String(process.env.HOME || "").trim();
  const localAppData = String(process.env.LOCALAPPDATA || "").trim();

  const candidates = [
    fromEnv ? path.resolve(fromEnv) : null,
    dataDir ? path.join(path.resolve(dataDir), "cache", "binaries") : null,
    dataDir ? path.join(path.resolve(dataDir), "web-bin") : null,
    process.platform === "win32" && localAppData
      ? path.join(localAppData, "Gharmonize", "web-bin")
      : null,
    homeDir ? path.join(homeDir, ".cache", "gharmonize", "web-bin") : null,
    path.join(os.tmpdir(), "gharmonize-web-bin")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }

  return path.join(os.tmpdir(), "gharmonize-web-bin");
}

const WEB_CACHE_DIR = resolveWebCacheDir();
const WEB_META_FILE = path.join(WEB_CACHE_DIR, "metadata.json");

// Reads json metadata file for web binary cache.
function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
  }
  return fallbackValue;
}

// Persists json metadata file for web binary cache.
async function writeJsonFile(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

// Creates fetch timeout wrapper for web binary cache.
async function fetchWithTimeout(url, init = {}, timeoutMs = WEB_TIMEOUT_MS) {
  if (typeof fetch !== "function") {
    throw new Error("fetch API is not available in this Node.js runtime");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

// Downloads url to path for web binary cache.
async function downloadToFile(url, filePath) {
  const res = await fetchWithTimeout(url, {
    headers: GH_HEADERS,
    redirect: "follow"
  });

  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText})`);
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await pipeline(
    Readable.fromWeb(res.body),
    fs.createWriteStream(filePath)
  );
}

// Returns latest release tag from GitHub for web binary cache.
async function fetchLatestTag(ownerRepo) {
  const url = `https://api.github.com/repos/${ownerRepo}/releases/latest`;
  const res = await fetchWithTimeout(url, { headers: GH_HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub API failed (${res.status} ${res.statusText})`);
  }

  const payload = await res.json();
  const tag = String(payload?.tag_name || "").trim();
  if (!tag) {
    throw new Error("GitHub API returned empty tag_name");
  }
  return tag;
}

// Extracts zip file for web binary cache.
async function extractZip(zipPath, outputDir) {
  if (process.platform === "win32") {
    const safeZip = String(zipPath).replace(/'/g, "''");
    const safeOut = String(outputDir).replace(/'/g, "''");
    const psArgs = [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${safeZip}' -DestinationPath '${safeOut}' -Force`
    ];
    await execFileAsync("powershell", psArgs, { windowsHide: true });
    return;
  }

  await execFileAsync("unzip", ["-o", zipPath, "-d", outputDir], { windowsHide: true });
}

// Finds file recursively for web binary cache.
async function findFileRecursive(dir, fileName) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, fileName).catch(() => null);
      if (found) return found;
      continue;
    }
    if (entry.name === fileName) {
      return full;
    }
  }
  throw new Error(`${fileName} not found in archive`);
}

// Checks whether binary is executable for web binary cache.
function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Verifies executable by running version command.
async function verifyBinary(binaryPath, args = ["--version"]) {
  await execFileAsync(binaryPath, args, {
    timeout: 8000,
    windowsHide: true
  });
}

// Sanitizes tag for file naming in web binary cache.
function sanitizeTag(tag) {
  return String(tag || "").replace(/[^A-Za-z0-9._-]/g, "_");
}

// Removes stale versioned binaries and temp artifacts from cache.
async function pruneVersionedFiles(prefix, keepPath) {
  const keepName = keepPath ? path.basename(keepPath) : null;
  const entries = await fs.promises.readdir(WEB_CACHE_DIR, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (keepName && entry.name === keepName) continue;
    const full = path.join(WEB_CACHE_DIR, entry.name);
    await fs.promises.rm(full, { recursive: true, force: true }).catch(() => {});
  }
}

// Picks release asset by platform+arch.
function pickReleaseAsset(map) {
  const byPlatform = map?.[process.platform];
  if (!byPlatform) return null;
  return byPlatform[process.arch] || null;
}

// Updates metadata entry for web binary cache.
function setMetaEntry(meta, key, value) {
  meta[key] = {
    ...value,
    checkedAt: Date.now()
  };
}

// Checks whether metadata entry is still fresh.
function isFresh(metaEntry) {
  if (!metaEntry?.checkedAt) return false;
  return (Date.now() - Number(metaEntry.checkedAt)) < WEB_TTL_MS;
}

// Ensures latest yt-dlp binary from web cache.
async function ensureLatestYtDlp(meta, options = {}) {
  const force = !!options.force;
  const asset = pickReleaseAsset(YTDLP_ASSETS);
  if (!asset) return null;

  const current = meta?.ytdlp;
  if (!force && current?.path && isExecutable(current.path) && isFresh(current)) {
    await pruneVersionedFiles("yt-dlp-", current.path);
    return current.path;
  }

  const tag = await fetchLatestTag("yt-dlp/yt-dlp");
  const safeTag = sanitizeTag(tag);
  const outName = process.platform === "win32"
    ? `yt-dlp-${safeTag}.exe`
    : `yt-dlp-${safeTag}`;
  const finalPath = path.join(WEB_CACHE_DIR, outName);

  if (isExecutable(finalPath)) {
    try {
      await verifyBinary(finalPath, ["--version"]);
      setMetaEntry(meta, "ytdlp", { tag, path: finalPath });
      await pruneVersionedFiles("yt-dlp-", finalPath);
      return finalPath;
    } catch {
      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    }
  }

  const tmpPath = `${finalPath}.download`;
  const url = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}/${asset}`;

  await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  try {
    await downloadToFile(url, tmpPath);
    await fs.promises.rename(tmpPath, finalPath);
    if (process.platform !== "win32") {
      await fs.promises.chmod(finalPath, 0o755).catch(() => {});
    }
    await verifyBinary(finalPath, ["--version"]);
    setMetaEntry(meta, "ytdlp", { tag, path: finalPath });
    await pruneVersionedFiles("yt-dlp-", finalPath);
    return finalPath;
  } catch (err) {
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  }
}

// Ensures latest deno binary from web cache.
async function ensureLatestDeno(meta, options = {}) {
  const force = !!options.force;
  const asset = pickReleaseAsset(DENO_ASSETS);
  if (!asset) return null;

  const current = meta?.deno;
  if (!force && current?.path && isExecutable(current.path) && isFresh(current)) {
    await pruneVersionedFiles("deno-", current.path);
    return current.path;
  }

  const tag = await fetchLatestTag("denoland/deno");
  const safeTag = sanitizeTag(tag);
  const outName = process.platform === "win32"
    ? `deno-${safeTag}.exe`
    : `deno-${safeTag}`;
  const finalPath = path.join(WEB_CACHE_DIR, outName);

  if (isExecutable(finalPath)) {
    try {
      await verifyBinary(finalPath, ["--version"]);
      setMetaEntry(meta, "deno", { tag, path: finalPath });
      await pruneVersionedFiles("deno-", finalPath);
      return finalPath;
    } catch {
      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    }
  }

  const zipPath = path.join(WEB_CACHE_DIR, `deno-${safeTag}.zip`);
  const extractDir = path.join(WEB_CACHE_DIR, `deno-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const url = `https://github.com/denoland/deno/releases/download/${tag}/${asset}`;

  await fs.promises.rm(zipPath, { force: true }).catch(() => {});
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

  try {
    await downloadToFile(url, zipPath);
    await fs.promises.mkdir(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    const exeName = pickExeName("deno");
    const extractedPath = await findFileRecursive(extractDir, exeName);
    await fs.promises.copyFile(extractedPath, finalPath);
    if (process.platform !== "win32") {
      await fs.promises.chmod(finalPath, 0o755).catch(() => {});
    }
    await verifyBinary(finalPath, ["--version"]);
    setMetaEntry(meta, "deno", { tag, path: finalPath });
    await pruneVersionedFiles("deno-", finalPath);
    return finalPath;
  } catch (err) {
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

export const FFMPEG_BIN   = resolveBin("FFMPEG_BIN",   "ffmpeg");
export const FFPROBE_BIN  = resolveBin("FFPROBE_BIN",  "ffprobe");
export const MKVMERGE_BIN = resolveBin("MKVMERGE_BIN", "mkvmerge");
export let YTDLP_BIN      = resolveBin("YTDLP_BIN",    "yt-dlp");
export let DENO_BIN       = resolveBin("DENO_BIN",     "deno");

let initPromise = null;

// Initializes web-first binary resolution for yt-dlp and deno.
export async function initializeDynamicBinaries(options = {}) {
  const force = !!options.force;

  if (initPromise && !force) return initPromise;

  if (initPromise && force) {
    await initPromise.catch(() => {});
  }

  initPromise = (async () => {
    const result = {
      webEnabled: WEB_BINARIES_ENABLED,
      forced: force,
      cacheDir: WEB_CACHE_DIR,
      ytdlpPath: YTDLP_BIN,
      denoPath: DENO_BIN,
      updated: false
    };

    try {
      // Re-resolve after dotenv and runtime env overrides.
      YTDLP_BIN = resolveBin("YTDLP_BIN", "yt-dlp");
      DENO_BIN = resolveBin("DENO_BIN", "deno");
      result.ytdlpPath = YTDLP_BIN;
      result.denoPath = DENO_BIN;

      if (!WEB_BINARIES_ENABLED) {
        return result;
      }

      await fs.promises.mkdir(WEB_CACHE_DIR, { recursive: true }).catch(() => {});
      const meta = readJsonFile(WEB_META_FILE, {});
      let shouldSaveMeta = false;

      if (force || WEB_FORCE_DOCKER_OVERRIDE || !process.env.YTDLP_BIN) {
        try {
          const latestYtDlp = await ensureLatestYtDlp(meta, { force });
          if (latestYtDlp) {
            YTDLP_BIN = latestYtDlp;
            shouldSaveMeta = true;
            result.ytdlpPath = YTDLP_BIN;
          }
        } catch (err) {
          console.warn("[binaries] yt-dlp web latest unavailable, fallback active:", err.message);
        }
      }

      if (force || WEB_FORCE_DOCKER_OVERRIDE || !process.env.DENO_BIN) {
        try {
          const latestDeno = await ensureLatestDeno(meta, { force });
          if (latestDeno) {
            DENO_BIN = latestDeno;
            shouldSaveMeta = true;
            result.denoPath = DENO_BIN;
          }
        } catch (err) {
          console.warn("[binaries] deno web latest unavailable, fallback active:", err.message);
        }
      }

      if (shouldSaveMeta) {
        await writeJsonFile(WEB_META_FILE, meta).catch(() => {});
      }
      result.updated = shouldSaveMeta;
      return result;
    } catch (err) {
      console.warn("[binaries] dynamic binary init failed, fallback active:", err.message);
      return result;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

// Handles debug binaries in core application logic.
export function debugBinaries() {
  console.log("[binaries] isElectron:", isElectron);
  console.log("[binaries] isPackagedElectron:", isPackagedElectron);
  console.log("[binaries] IS_DOCKER:", IS_DOCKER);
  console.log("[binaries] PACKAGED_BIN_DIR:", PACKAGED_BIN_DIR);
  console.log("[binaries] DEV_BIN_DIR:", DEV_BIN_DIR);
  console.log("[binaries] WEB_CACHE_DIR:", WEB_CACHE_DIR);
  console.log("[binaries] WEB_BINARIES_ENABLED:", WEB_BINARIES_ENABLED);
  console.log("[binaries] WEB_FORCE_DOCKER_OVERRIDE:", WEB_FORCE_DOCKER_OVERRIDE);
  console.log("[binaries] FFMPEG_BIN:", FFMPEG_BIN);
  console.log("[binaries] YTDLP_BIN:", YTDLP_BIN);
  console.log("[binaries] FFPROBE_BIN:", FFPROBE_BIN);
  console.log("[binaries] MKVMERGE_BIN:", MKVMERGE_BIN);
  console.log("[binaries] DENO_BIN:", DENO_BIN);
}
