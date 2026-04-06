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
const __dirname = path.dirname(__filename);
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
const HTTP_HEADERS = {
  "User-Agent": "Gharmonize-Binaries"
};
const GH_HEADERS = {
  ...HTTP_HEADERS,
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

const FFMPEG_ARCHIVE_ASSETS = {
  linux: {
    x64: /ffmpeg-.*-linux64-gpl\.tar\.xz$/i,
    arm64: /ffmpeg-.*-linuxarm64-gpl\.tar\.xz$/i
  },
  win32: {
    x64: /ffmpeg-.*-win64-gpl\.zip$/i,
    arm64: /ffmpeg-.*-winarm64-gpl\.zip$/i
  }
};

const WINDOWS_7Z_EXTRACTORS = [
  ["tar", ["-xf"]],
  ["7z", ["x", "-y"]],
  ["7zr", ["x", "-y"]],
  ["7za", ["x", "-y"]],
  ["bsdtar", ["-xf"]]
];

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
const DYNAMIC_BINARY_TOOL_LABELS = {
  ffmpeg: "ffmpeg / ffprobe",
  mkvmerge: "mkvmerge",
  ytdlp: "yt-dlp",
  deno: "deno"
};

// Creates default per-tool runtime binary status.
function createDynamicBinaryToolState(toolKey) {
  return {
    label: DYNAMIC_BINARY_TOOL_LABELS[toolKey] || toolKey,
    status: "idle",
    message: "",
    updatedAt: null
  };
}

// Creates default runtime binary status snapshot.
function createDynamicBinariesStatus() {
  const tools = {};
  for (const toolKey of Object.keys(DYNAMIC_BINARY_TOOL_LABELS)) {
    tools[toolKey] = createDynamicBinaryToolState(toolKey);
  }

  return {
    webEnabled: WEB_BINARIES_ENABLED,
    active: false,
    phase: WEB_BINARIES_ENABLED ? "idle" : "disabled",
    currentTool: null,
    currentToolLabel: "",
    message: "",
    startedAt: null,
    completedAt: WEB_BINARIES_ENABLED ? null : Date.now(),
    updatedAt: Date.now(),
    tools
  };
}

let dynamicBinariesStatus = createDynamicBinariesStatus();

// Returns a detached runtime binary status snapshot.
export function getDynamicBinariesStatus() {
  return {
    ...dynamicBinariesStatus,
    tools: Object.fromEntries(
      Object.entries(dynamicBinariesStatus.tools || {}).map(([toolKey, value]) => [
        toolKey,
        { ...value }
      ])
    )
  };
}

// Resets runtime binary status for a new initialization cycle.
function resetDynamicBinariesStatus(force = false) {
  dynamicBinariesStatus = createDynamicBinariesStatus();
  dynamicBinariesStatus.startedAt = Date.now();
  dynamicBinariesStatus.updatedAt = Date.now();

  if (!WEB_BINARIES_ENABLED) {
    dynamicBinariesStatus.message = "Web-managed binaries are disabled";
    return;
  }

  dynamicBinariesStatus.active = true;
  dynamicBinariesStatus.phase = "checking";
  dynamicBinariesStatus.message = force
    ? "Refreshing runtime binaries"
    : "Checking runtime binaries";
}

// Updates overall runtime binary status fields.
function updateDynamicBinariesStatus(patch = {}) {
  dynamicBinariesStatus = {
    ...dynamicBinariesStatus,
    ...patch,
    updatedAt: Date.now()
  };
}

// Marks a runtime binary task as active.
function startDynamicBinaryTask(toolKey, phase, message = "") {
  const label = DYNAMIC_BINARY_TOOL_LABELS[toolKey] || toolKey;
  const now = Date.now();
  dynamicBinariesStatus = {
    ...dynamicBinariesStatus,
    active: true,
    phase,
    currentTool: toolKey,
    currentToolLabel: label,
    message: message || dynamicBinariesStatus.message,
    completedAt: null,
    updatedAt: now,
    tools: {
      ...dynamicBinariesStatus.tools,
      [toolKey]: {
        ...(dynamicBinariesStatus.tools?.[toolKey] || createDynamicBinaryToolState(toolKey)),
        label,
        status: phase,
        message: message || "",
        updatedAt: now
      }
    }
  };
}

// Marks a runtime binary task as finished.
function finishDynamicBinaryTask(toolKey, status, message = "") {
  const label = DYNAMIC_BINARY_TOOL_LABELS[toolKey] || toolKey;
  const now = Date.now();
  const isCurrentTool = dynamicBinariesStatus.currentTool === toolKey;
  dynamicBinariesStatus = {
    ...dynamicBinariesStatus,
    phase: dynamicBinariesStatus.active ? "checking" : dynamicBinariesStatus.phase,
    currentTool: isCurrentTool ? null : dynamicBinariesStatus.currentTool,
    currentToolLabel: isCurrentTool ? "" : dynamicBinariesStatus.currentToolLabel,
    updatedAt: now,
    tools: {
      ...dynamicBinariesStatus.tools,
      [toolKey]: {
        ...(dynamicBinariesStatus.tools?.[toolKey] || createDynamicBinaryToolState(toolKey)),
        label,
        status,
        message: message || "",
        updatedAt: now
      }
    }
  };
}

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

// Reads the current dynamic binary metadata snapshot.
export function getDynamicBinaryMetadata(key = null) {
  const meta = readJsonFile(WEB_META_FILE, {});
  if (!key) return meta;
  return meta?.[key] || null;
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
async function downloadToFile(url, filePath, headers = HTTP_HEADERS) {
  const res = await fetchWithTimeout(url, {
    headers,
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

// Returns latest release payload from GitHub for web binary cache.
async function fetchLatestRelease(ownerRepo) {
  const url = `https://api.github.com/repos/${ownerRepo}/releases/latest`;
  const res = await fetchWithTimeout(url, { headers: GH_HEADERS });
  if (!res.ok) {
    throw new Error(`GitHub API failed (${res.status} ${res.statusText})`);
  }

  const payload = await res.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("GitHub API returned an invalid release payload");
  }
  return payload;
}

// Returns latest release tag from GitHub for web binary cache.
async function fetchLatestTag(ownerRepo) {
  const payload = await fetchLatestRelease(ownerRepo);
  const tag = String(payload?.tag_name || "").trim();
  if (!tag) {
    throw new Error("GitHub API returned empty tag_name");
  }
  return tag;
}

// Returns the current MKVToolNix version from the official latest release feed.
async function fetchLatestMkvToolNixVersion() {
  const url = "https://mkvtoolnix.download/latest-release.json";
  const res = await fetchWithTimeout(url, {
    headers: {
      ...HTTP_HEADERS,
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`MKVToolNix release feed failed (${res.status} ${res.statusText})`);
  }

  const payload = await res.json();
  const version = String(
    payload?.["mkvtoolnix-releases"]?.["latest-source"]?.version || ""
  ).trim();

  if (!version) {
    throw new Error("MKVToolNix release feed returned an empty version");
  }

  return version;
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

// Extracts tar file for web binary cache.
async function extractTar(archivePath, outputDir) {
  await execFileAsync("tar", ["-xf", archivePath, "-C", outputDir], { windowsHide: true });
}

// Extracts 7z file for web binary cache.
async function extract7z(archivePath, outputDir) {
  let lastError = null;

  for (const [tool, baseArgs] of WINDOWS_7Z_EXTRACTORS) {
    const args = baseArgs[0] === "-xf"
      ? [...baseArgs, archivePath, "-C", outputDir]
      : [...baseArgs, archivePath, `-o${outputDir}`];
    try {
      await execFileAsync(tool, args, { windowsHide: true });
      return;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(lastError?.message || "No 7z extractor is available");
}

// Extracts an archive based on its file name for web binary cache.
async function extractArchive(archivePath, outputDir) {
  const fileName = path.basename(String(archivePath || "")).toLowerCase();
  if (fileName.endsWith(".zip")) {
    await extractZip(archivePath, outputDir);
    return;
  }
  if (fileName.endsWith(".tar.xz") || fileName.endsWith(".tar")) {
    await extractTar(archivePath, outputDir);
    return;
  }
  if (fileName.endsWith(".7z")) {
    await extract7z(archivePath, outputDir);
    return;
  }

  throw new Error(`Unsupported archive type: ${archivePath}`);
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

// Checks whether a version command produced a recognizable tool version line.
function hasRecognizableVersionOutput(toolName, stdout = "", stderr = "") {
  const lines = `${stdout || ""}\n${stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\/tmp\/appimage_extracted/i.test(line))
    .filter((line) => !/^\/tmp\/\.mount_/i.test(line));

  const patterns = {
    ffmpeg: /^ffmpeg version\s+/i,
    ffprobe: /^ffprobe version\s+/i,
    mkvmerge: /^mkvmerge v/i,
    mkvpropedit: /^mkvpropedit v/i,
    "yt-dlp": /^\d{4}\.\d{2}\.\d{2}/,
    deno: /^deno\s+/i
  };

  const matcher = patterns[toolName];
  if (!matcher) {
    return lines.length > 0;
  }

  return lines.some((line) => matcher.test(line));
}

// Verifies executable and requires a recognizable version line in the output.
async function verifyVersionedBinary(
  binaryPath,
  toolName,
  args = ["--version"]
) {
  const { stdout, stderr } = await execFileAsync(binaryPath, args, {
    timeout: 8000,
    windowsHide: true
  });

  if (!hasRecognizableVersionOutput(toolName, stdout, stderr)) {
    throw new Error(`${toolName} version output is invalid`);
  }
}

// Sanitizes tag for file naming in web binary cache.
function sanitizeTag(tag) {
  return String(tag || "").replace(/[^A-Za-z0-9._-]/g, "_");
}

// Removes stale versioned binaries and temp artifacts from cache.
async function pruneVersionedFiles(prefix, keepPaths = []) {
  const keepNames = new Set(
    (Array.isArray(keepPaths) ? keepPaths : [keepPaths])
      .filter(Boolean)
      .map((keepPath) => path.basename(keepPath))
  );
  const entries = await fs.promises.readdir(WEB_CACHE_DIR, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (keepNames.has(entry.name)) continue;
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

// Resolves matching release asset from a GitHub release payload.
function resolveReleaseAsset(release, matcher) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (!matcher) return null;

  if (matcher instanceof RegExp) {
    return assets.find((asset) => matcher.test(String(asset?.name || ""))) || null;
  }

  return assets.find((asset) => String(asset?.name || "") === String(matcher)) || null;
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

// Returns archive suffix from asset name.
function archiveSuffixFromName(fileName) {
  const raw = String(fileName || "");
  if (raw.toLowerCase().endsWith(".tar.xz")) return ".tar.xz";
  return path.extname(raw) || "";
}

// Escapes value for a bash single-quoted string.
function shellQuote(value) {
  return `'${String(value || "").replace(/'/g, `'\\''`)}'`;
}

// Copies executable into the web cache.
async function copyExecutable(sourcePath, destPath) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await fs.promises.rm(destPath, { force: true }).catch(() => {});
  await fs.promises.copyFile(sourcePath, destPath);
  if (process.platform !== "win32") {
    await fs.promises.chmod(destPath, 0o755).catch(() => {});
  }
}

// Writes executable text file into the web cache.
async function writeExecutableFile(filePath, content) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content, "utf8");
  if (process.platform !== "win32") {
    await fs.promises.chmod(filePath, 0o755).catch(() => {});
  }
}

// Creates a Linux MKVToolNix wrapper script for AppImage execution.
async function writeMkvToolNixLinuxWrapper(wrapperPath, appImagePath, binaryName) {
  const content = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `APPIMAGE_PATH=${shellQuote(appImagePath)}`,
    `BINARY_NAME=${shellQuote(binaryName)}`,
    "EXTRACT_ROOT=\"${APPIMAGE_PATH}.root\"",
    "APPDIR=\"${EXTRACT_ROOT}/squashfs-root\"",
    "BIN_PATH=\"${EXTRACT_ROOT}/squashfs-root/usr/bin/${BINARY_NAME}\"",
    "",
    "if [ ! -x \"$BIN_PATH\" ]; then",
    "  LOCK_DIR=\"${EXTRACT_ROOT}.lock\"",
    "  while ! mkdir \"$LOCK_DIR\" 2>/dev/null; do",
    "    if [ -x \"$BIN_PATH\" ]; then",
    "      break",
    "    fi",
    "    sleep 1",
    "  done",
    "",
    "  if [ ! -x \"$BIN_PATH\" ]; then",
    "    TMP_DIR=\"${EXTRACT_ROOT}.tmp.$$\"",
    "    cleanup() {",
    "      rm -rf \"$TMP_DIR\"",
    "      rmdir \"$LOCK_DIR\" 2>/dev/null || true",
    "    }",
    "    trap cleanup EXIT",
    "    rm -rf \"$TMP_DIR\"",
    "    mkdir -p \"$TMP_DIR\"",
    "    (",
    "      cd \"$TMP_DIR\"",
    "      \"$APPIMAGE_PATH\" --appimage-extract >/dev/null 2>&1",
    "    )",
    "    rm -rf \"$EXTRACT_ROOT\"",
    "    mv \"$TMP_DIR\" \"$EXTRACT_ROOT\"",
    "    trap - EXIT",
    "    cleanup",
    "  else",
    "    rmdir \"$LOCK_DIR\" 2>/dev/null || true",
    "  fi",
    "fi",
    "",
    "export LD_LIBRARY_PATH=\"${APPDIR}/usr/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}\"",
    "exec \"$BIN_PATH\" \"$@\""
  ].join("\n");

  await writeExecutableFile(wrapperPath, `${content}\n`);
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
    startDynamicBinaryTask("ytdlp", "downloading", "Downloading yt-dlp");
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
  const tmpZipPath = `${zipPath}.download`;
  const extractDir = path.join(WEB_CACHE_DIR, `deno-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const url = `https://github.com/denoland/deno/releases/download/${tag}/${asset}`;

  await fs.promises.rm(tmpZipPath, { force: true }).catch(() => {});
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

  try {
    startDynamicBinaryTask("deno", "downloading", "Downloading deno");
    await downloadToFile(url, tmpZipPath);
    await fs.promises.rename(tmpZipPath, zipPath);
    await fs.promises.mkdir(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    const exeName = pickExeName("deno");
    const extractedPath = await findFileRecursive(extractDir, exeName);
    await copyExecutable(extractedPath, finalPath);
    await verifyBinary(finalPath, ["--version"]);
    setMetaEntry(meta, "deno", { tag, path: finalPath });
    await pruneVersionedFiles("deno-", finalPath);
    return finalPath;
  } catch (err) {
    await fs.promises.rm(finalPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.promises.rm(tmpZipPath, { force: true }).catch(() => {});
    await fs.promises.rm(zipPath, { force: true }).catch(() => {});
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Ensures latest ffmpeg and ffprobe binaries from the shared FFmpeg archive.
async function ensureLatestFfmpegTools(meta, options = {}) {
  const force = !!options.force;
  const assetMatcher = pickReleaseAsset(FFMPEG_ARCHIVE_ASSETS);
  if (!assetMatcher) return null;

  const currentFfmpeg = meta?.ffmpeg;
  const currentFfprobe = meta?.ffprobe;
  if (
    !force &&
    currentFfmpeg?.path &&
    currentFfprobe?.path &&
    isExecutable(currentFfmpeg.path) &&
    isExecutable(currentFfprobe.path) &&
    isFresh(currentFfmpeg) &&
    isFresh(currentFfprobe)
  ) {
    await pruneVersionedFiles("ffmpeg-", currentFfmpeg.path);
    await pruneVersionedFiles("ffprobe-", currentFfprobe.path);
    return {
      ffmpegPath: currentFfmpeg.path,
      ffprobePath: currentFfprobe.path
    };
  }

  const release = await fetchLatestRelease("BtbN/FFmpeg-Builds");
  const asset = resolveReleaseAsset(release, assetMatcher);
  if (!asset?.browser_download_url) {
    throw new Error("FFmpeg latest release asset was not found");
  }

  const versionTag = sanitizeTag(
    release?.published_at ||
    asset?.updated_at ||
    asset?.name ||
    release?.tag_name ||
    `ffmpeg-${Date.now()}`
  );
  const ffmpegFinalPath = path.join(
    WEB_CACHE_DIR,
    process.platform === "win32" ? `ffmpeg-${versionTag}.exe` : `ffmpeg-${versionTag}`
  );
  const ffprobeFinalPath = path.join(
    WEB_CACHE_DIR,
    process.platform === "win32" ? `ffprobe-${versionTag}.exe` : `ffprobe-${versionTag}`
  );

  if (isExecutable(ffmpegFinalPath) && isExecutable(ffprobeFinalPath)) {
    try {
      await verifyBinary(ffmpegFinalPath, ["-version"]);
      await verifyBinary(ffprobeFinalPath, ["-version"]);
      setMetaEntry(meta, "ffmpeg", { tag: versionTag, path: ffmpegFinalPath });
      setMetaEntry(meta, "ffprobe", { tag: versionTag, path: ffprobeFinalPath });
      await pruneVersionedFiles("ffmpeg-", ffmpegFinalPath);
      await pruneVersionedFiles("ffprobe-", ffprobeFinalPath);
      return {
        ffmpegPath: ffmpegFinalPath,
        ffprobePath: ffprobeFinalPath
      };
    } catch {
      await fs.promises.rm(ffmpegFinalPath, { force: true }).catch(() => {});
      await fs.promises.rm(ffprobeFinalPath, { force: true }).catch(() => {});
    }
  }

  const archivePath = path.join(
    WEB_CACHE_DIR,
    `ffmpeg-${versionTag}${archiveSuffixFromName(asset.name)}`
  );
  const tmpArchivePath = `${archivePath}.download`;
  const extractDir = path.join(WEB_CACHE_DIR, `ffmpeg-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);

  await fs.promises.rm(tmpArchivePath, { force: true }).catch(() => {});
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

  try {
    startDynamicBinaryTask("ffmpeg", "downloading", "Downloading ffmpeg / ffprobe");
    await downloadToFile(asset.browser_download_url, tmpArchivePath);
    await fs.promises.rename(tmpArchivePath, archivePath);
    await fs.promises.mkdir(extractDir, { recursive: true });
    await extractArchive(archivePath, extractDir);

    const extractedFfmpeg = await findFileRecursive(extractDir, pickExeName("ffmpeg"));
    const extractedFfprobe = await findFileRecursive(extractDir, pickExeName("ffprobe"));
    await copyExecutable(extractedFfmpeg, ffmpegFinalPath);
    await copyExecutable(extractedFfprobe, ffprobeFinalPath);
    await verifyBinary(ffmpegFinalPath, ["-version"]);
    await verifyBinary(ffprobeFinalPath, ["-version"]);
    setMetaEntry(meta, "ffmpeg", { tag: versionTag, path: ffmpegFinalPath });
    setMetaEntry(meta, "ffprobe", { tag: versionTag, path: ffprobeFinalPath });
    await pruneVersionedFiles("ffmpeg-", ffmpegFinalPath);
    await pruneVersionedFiles("ffprobe-", ffprobeFinalPath);
    return {
      ffmpegPath: ffmpegFinalPath,
      ffprobePath: ffprobeFinalPath
    };
  } catch (err) {
    await fs.promises.rm(ffmpegFinalPath, { force: true }).catch(() => {});
    await fs.promises.rm(ffprobeFinalPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    await fs.promises.rm(tmpArchivePath, { force: true }).catch(() => {});
    await fs.promises.rm(archivePath, { force: true }).catch(() => {});
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Ensures latest mkvmerge binary from the official MKVToolNix downloads.
async function ensureLatestMkvmerge(meta, options = {}) {
  const force = !!options.force;
  const current = meta?.mkvmerge;
  const usesManagedLinuxWrapper =
    process.platform === "linux" &&
    path.basename(String(current?.path || "")) === "mkvmerge";
  const hasBacking = usesManagedLinuxWrapper
    ? !!current?.backingPath && fs.existsSync(current.backingPath)
    : (!current?.backingPath || fs.existsSync(current.backingPath));
  const hasHelper = usesManagedLinuxWrapper
    ? !!current?.helperPath && fs.existsSync(current.helperPath)
    : (!current?.helperPath || fs.existsSync(current.helperPath));
  if (
    !force &&
    current?.path &&
    hasBacking &&
    hasHelper &&
    isExecutable(current.path) &&
    isFresh(current)
  ) {
    try {
      if (usesManagedLinuxWrapper) {
        await verifyVersionedBinary(current.path, "mkvmerge", ["--version"]);
        await verifyVersionedBinary(
          current.helperPath,
          "mkvpropedit",
          ["--version"]
        );
      } else {
        await verifyVersionedBinary(current.path, "mkvmerge", ["--version"]);
      }

      if (current.helperPath && !process.env.MKVPROPEDIT_BIN) {
        MKVPROPEDIT_BIN = current.helperPath;
      }
      await pruneVersionedFiles(
        "mkvmerge-",
        current.backingPath ? [current.backingPath] : current.path
      );
      return current.path;
    } catch {
    }
  }

  const version = await fetchLatestMkvToolNixVersion();
  const safeVersion = sanitizeTag(version);

  if (process.platform === "linux") {
    if (!["x64", "arm64"].includes(process.arch)) return null;

    const archLabel = process.arch === "arm64" ? "arm64" : "x86_64";
    const appImagePath = path.join(
      WEB_CACHE_DIR,
      `mkvmerge-${safeVersion}-${archLabel}.AppImage`
    );
    const wrapperPath = path.join(WEB_CACHE_DIR, "mkvmerge");
    const propeditWrapperPath = path.join(WEB_CACHE_DIR, "mkvpropedit");
    const url = `https://mkvtoolnix.download/appimage/MKVToolNix_GUI-${version}-${archLabel}.AppImage`;

    if (fs.existsSync(appImagePath)) {
      try {
        await writeMkvToolNixLinuxWrapper(wrapperPath, appImagePath, "mkvmerge");
        await writeMkvToolNixLinuxWrapper(
          propeditWrapperPath,
          appImagePath,
          "mkvpropedit"
        );
        await verifyVersionedBinary(wrapperPath, "mkvmerge", ["--version"]);
        await verifyVersionedBinary(
          propeditWrapperPath,
          "mkvpropedit",
          ["--version"]
        );
        setMetaEntry(meta, "mkvmerge", {
          tag: version,
          path: wrapperPath,
          backingPath: appImagePath,
          helperPath: propeditWrapperPath
        });
        if (!process.env.MKVPROPEDIT_BIN) {
          MKVPROPEDIT_BIN = propeditWrapperPath;
        }
        await pruneVersionedFiles("mkvmerge-", appImagePath);
        return wrapperPath;
      } catch {
        await fs.promises.rm(wrapperPath, { force: true }).catch(() => {});
        await fs.promises.rm(propeditWrapperPath, { force: true }).catch(() => {});
      }
    }

    const tmpAppImagePath = `${appImagePath}.download`;
    await fs.promises.rm(tmpAppImagePath, { force: true }).catch(() => {});

    try {
      startDynamicBinaryTask("mkvmerge", "downloading", "Downloading mkvmerge");
      await downloadToFile(url, tmpAppImagePath);
      await fs.promises.rename(tmpAppImagePath, appImagePath);
      await fs.promises.chmod(appImagePath, 0o755).catch(() => {});
      await writeMkvToolNixLinuxWrapper(wrapperPath, appImagePath, "mkvmerge");
      await writeMkvToolNixLinuxWrapper(
        propeditWrapperPath,
        appImagePath,
        "mkvpropedit"
      );
      await verifyVersionedBinary(wrapperPath, "mkvmerge", ["--version"]);
      await verifyVersionedBinary(
        propeditWrapperPath,
        "mkvpropedit",
        ["--version"]
      );
      setMetaEntry(meta, "mkvmerge", {
        tag: version,
        path: wrapperPath,
        backingPath: appImagePath,
        helperPath: propeditWrapperPath
      });
      if (!process.env.MKVPROPEDIT_BIN) {
        MKVPROPEDIT_BIN = propeditWrapperPath;
      }
      await pruneVersionedFiles("mkvmerge-", appImagePath);
      return wrapperPath;
    } catch (err) {
      await fs.promises.rm(wrapperPath, { force: true }).catch(() => {});
      await fs.promises.rm(propeditWrapperPath, { force: true }).catch(() => {});
      await fs.promises.rm(appImagePath, { force: true }).catch(() => {});
      throw err;
    } finally {
      await fs.promises.rm(tmpAppImagePath, { force: true }).catch(() => {});
    }
  }

  if (process.platform === "win32") {
    const bitLabel = process.arch === "ia32" ? "32-bit" : "64-bit";
    const archivePath = path.join(WEB_CACHE_DIR, `mkvmerge-${safeVersion}.7z`);
    const tmpArchivePath = `${archivePath}.download`;
    const extractDir = path.join(WEB_CACHE_DIR, `mkvmerge-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const finalPath = path.join(WEB_CACHE_DIR, `mkvmerge-${safeVersion}.exe`);
    const url = `https://mkvtoolnix.download/windows/releases/${version}/mkvtoolnix-${bitLabel}-${version}.7z`;

    if (isExecutable(finalPath)) {
      try {
        await verifyBinary(finalPath, ["--version"]);
        setMetaEntry(meta, "mkvmerge", { tag: version, path: finalPath });
        await pruneVersionedFiles("mkvmerge-", finalPath);
        return finalPath;
      } catch {
        await fs.promises.rm(finalPath, { force: true }).catch(() => {});
      }
    }

    await fs.promises.rm(tmpArchivePath, { force: true }).catch(() => {});
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

    try {
      startDynamicBinaryTask("mkvmerge", "downloading", "Downloading mkvmerge");
      await downloadToFile(url, tmpArchivePath);
      await fs.promises.rename(tmpArchivePath, archivePath);
      await fs.promises.mkdir(extractDir, { recursive: true });
      await extractArchive(archivePath, extractDir);
      const extractedPath = await findFileRecursive(extractDir, "mkvmerge.exe");
      await copyExecutable(extractedPath, finalPath);
      await verifyBinary(finalPath, ["--version"]);
      setMetaEntry(meta, "mkvmerge", { tag: version, path: finalPath });
      await pruneVersionedFiles("mkvmerge-", finalPath);
      return finalPath;
    } catch (err) {
      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
      throw err;
    } finally {
      await fs.promises.rm(tmpArchivePath, { force: true }).catch(() => {});
      await fs.promises.rm(archivePath, { force: true }).catch(() => {});
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  return null;
}

export let FFMPEG_BIN = resolveBin("FFMPEG_BIN", "ffmpeg");
export let FFPROBE_BIN = resolveBin("FFPROBE_BIN", "ffprobe");
export let MKVMERGE_BIN = resolveBin("MKVMERGE_BIN", "mkvmerge");
export let MKVPROPEDIT_BIN = resolveBin("MKVPROPEDIT_BIN", "mkvpropedit");
export let YTDLP_BIN = resolveBin("YTDLP_BIN", "yt-dlp");
export let DENO_BIN = resolveBin("DENO_BIN", "deno");

let initPromise = null;

// Initializes web-first binary resolution for runtime tools.
export async function initializeDynamicBinaries(options = {}) {
  const force = !!options.force;

  if (initPromise && !force) return initPromise;

  if (initPromise && force) {
    await initPromise.catch(() => {});
  }

  resetDynamicBinariesStatus(force);

  initPromise = (async () => {
    const result = {
      webEnabled: WEB_BINARIES_ENABLED,
      forced: force,
      cacheDir: WEB_CACHE_DIR,
      ffmpegPath: FFMPEG_BIN,
      ffprobePath: FFPROBE_BIN,
      mkvmergePath: MKVMERGE_BIN,
      mkvpropeditPath: MKVPROPEDIT_BIN,
      ytdlpPath: YTDLP_BIN,
      denoPath: DENO_BIN,
      updated: false
    };

    try {
      // Re-resolve after dotenv and runtime env overrides.
      FFMPEG_BIN = resolveBin("FFMPEG_BIN", "ffmpeg");
      FFPROBE_BIN = resolveBin("FFPROBE_BIN", "ffprobe");
      MKVMERGE_BIN = resolveBin("MKVMERGE_BIN", "mkvmerge");
      MKVPROPEDIT_BIN = resolveBin("MKVPROPEDIT_BIN", "mkvpropedit");
      YTDLP_BIN = resolveBin("YTDLP_BIN", "yt-dlp");
      DENO_BIN = resolveBin("DENO_BIN", "deno");
      result.ffmpegPath = FFMPEG_BIN;
      result.ffprobePath = FFPROBE_BIN;
      result.mkvmergePath = MKVMERGE_BIN;
      result.mkvpropeditPath = MKVPROPEDIT_BIN;
      result.ytdlpPath = YTDLP_BIN;
      result.denoPath = DENO_BIN;

      if (!WEB_BINARIES_ENABLED) {
        updateDynamicBinariesStatus({
          active: false,
          phase: "disabled",
          currentTool: null,
          currentToolLabel: "",
          completedAt: Date.now(),
          message: "Web-managed binaries are disabled"
        });
        return result;
      }

      await fs.promises.mkdir(WEB_CACHE_DIR, { recursive: true }).catch(() => {});
      const meta = readJsonFile(WEB_META_FILE, {});
      let shouldSaveMeta = false;

      const shouldOverride = (envVarName) =>
        force || WEB_FORCE_DOCKER_OVERRIDE || !process.env[envVarName];

      if (shouldOverride("FFMPEG_BIN") || shouldOverride("FFPROBE_BIN")) {
        try {
          startDynamicBinaryTask(
            "ffmpeg",
            "checking",
            force ? "Refreshing ffmpeg / ffprobe" : "Checking ffmpeg / ffprobe"
          );
          const latestFfmpegTools = await ensureLatestFfmpegTools(meta, { force });
          if (latestFfmpegTools) {
            if (shouldOverride("FFMPEG_BIN")) {
              FFMPEG_BIN = latestFfmpegTools.ffmpegPath;
              result.ffmpegPath = FFMPEG_BIN;
            }
            if (shouldOverride("FFPROBE_BIN")) {
              FFPROBE_BIN = latestFfmpegTools.ffprobePath;
              result.ffprobePath = FFPROBE_BIN;
            }
            shouldSaveMeta = true;
            finishDynamicBinaryTask("ffmpeg", "ready", "ffmpeg / ffprobe ready");
          } else {
            finishDynamicBinaryTask("ffmpeg", "skipped", "Using existing ffmpeg / ffprobe");
          }
        } catch (err) {
          finishDynamicBinaryTask("ffmpeg", "error", err.message || "ffmpeg / ffprobe refresh failed");
          console.warn("[binaries] ffmpeg/ffprobe web latest unavailable, fallback active:", err.message);
        }
      } else {
        finishDynamicBinaryTask("ffmpeg", "skipped", "Using configured ffmpeg / ffprobe path");
      }

      if (shouldOverride("MKVMERGE_BIN")) {
        try {
          startDynamicBinaryTask(
            "mkvmerge",
            "checking",
            force ? "Refreshing mkvmerge" : "Checking mkvmerge"
          );
          const latestMkvmerge = await ensureLatestMkvmerge(meta, { force });
          if (latestMkvmerge) {
            MKVMERGE_BIN = latestMkvmerge;
            if (!process.env.MKVPROPEDIT_BIN && meta?.mkvmerge?.helperPath) {
              MKVPROPEDIT_BIN = meta.mkvmerge.helperPath;
            }
            result.mkvmergePath = MKVMERGE_BIN;
            result.mkvpropeditPath = MKVPROPEDIT_BIN;
            shouldSaveMeta = true;
            finishDynamicBinaryTask("mkvmerge", "ready", "mkvmerge ready");
          } else {
            finishDynamicBinaryTask("mkvmerge", "skipped", "Using existing mkvmerge");
          }
        } catch (err) {
          finishDynamicBinaryTask("mkvmerge", "error", err.message || "mkvmerge refresh failed");
          console.warn("[binaries] mkvmerge web latest unavailable, fallback active:", err.message);
        }
      } else {
        finishDynamicBinaryTask("mkvmerge", "skipped", "Using configured mkvmerge path");
      }

      if (shouldOverride("YTDLP_BIN")) {
        try {
          startDynamicBinaryTask(
            "ytdlp",
            "checking",
            force ? "Refreshing yt-dlp" : "Checking yt-dlp"
          );
          const latestYtDlp = await ensureLatestYtDlp(meta, { force });
          if (latestYtDlp) {
            YTDLP_BIN = latestYtDlp;
            result.ytdlpPath = YTDLP_BIN;
            shouldSaveMeta = true;
            finishDynamicBinaryTask("ytdlp", "ready", "yt-dlp ready");
          } else {
            finishDynamicBinaryTask("ytdlp", "skipped", "Using existing yt-dlp");
          }
        } catch (err) {
          finishDynamicBinaryTask("ytdlp", "error", err.message || "yt-dlp refresh failed");
          console.warn("[binaries] yt-dlp web latest unavailable, fallback active:", err.message);
        }
      } else {
        finishDynamicBinaryTask("ytdlp", "skipped", "Using configured yt-dlp path");
      }

      if (shouldOverride("DENO_BIN")) {
        try {
          startDynamicBinaryTask(
            "deno",
            "checking",
            force ? "Refreshing deno" : "Checking deno"
          );
          const latestDeno = await ensureLatestDeno(meta, { force });
          if (latestDeno) {
            DENO_BIN = latestDeno;
            result.denoPath = DENO_BIN;
            shouldSaveMeta = true;
            finishDynamicBinaryTask("deno", "ready", "deno ready");
          } else {
            finishDynamicBinaryTask("deno", "skipped", "Using existing deno");
          }
        } catch (err) {
          finishDynamicBinaryTask("deno", "error", err.message || "deno refresh failed");
          console.warn("[binaries] deno web latest unavailable, fallback active:", err.message);
        }
      } else {
        finishDynamicBinaryTask("deno", "skipped", "Using configured deno path");
      }

      if (shouldSaveMeta) {
        await writeJsonFile(WEB_META_FILE, meta).catch(() => {});
      }
      result.updated = shouldSaveMeta;
      const hasErrors = Object.values(dynamicBinariesStatus.tools || {}).some(
        (toolState) => toolState?.status === "error"
      );
      updateDynamicBinariesStatus({
        active: false,
        phase: hasErrors ? "ready_with_errors" : "ready",
        currentTool: null,
        currentToolLabel: "",
        completedAt: Date.now(),
        message: hasErrors
          ? "Runtime binaries refreshed with warnings"
          : "Runtime binaries ready"
      });
      return result;
    } catch (err) {
      updateDynamicBinariesStatus({
        active: false,
        phase: "error",
        currentTool: null,
        currentToolLabel: "",
        completedAt: Date.now(),
        message: err.message || "Runtime binary init failed"
      });
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
  console.log("[binaries] FFPROBE_BIN:", FFPROBE_BIN);
  console.log("[binaries] MKVMERGE_BIN:", MKVMERGE_BIN);
  console.log("[binaries] MKVPROPEDIT_BIN:", MKVPROPEDIT_BIN);
  console.log("[binaries] YTDLP_BIN:", YTDLP_BIN);
  console.log("[binaries] DENO_BIN:", DENO_BIN);
}
