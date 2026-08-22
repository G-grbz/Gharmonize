import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSafe } from "./safeProcess.js";
import { assertPathWithinAny } from "./security.js";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFileSafe);
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

const FFMPEG_RELEASE_TARGETS = {
  linux: {
    x64: { token: "linux64", extension: ".tar.xz" },
    arm64: { token: "linuxarm64", extension: ".tar.xz" }
  },
  win32: {
    x64: { token: "win64", extension: ".zip" },
    arm64: { token: "winarm64", extension: ".zip" }
  }
};

// Stable/release builds are the default. Read the channel dynamically so a
// value saved from Settings is honored by a manual binary refresh immediately.
function getFfmpegChannel() {
  return String(process.env.GHARMONIZE_FFMPEG_CHANNEL || "stable")
    .trim()
    .toLowerCase() === "master" ? "master" : "stable";
}

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

  const managedCachePath = resolveManagedCacheBin(baseName);
  if (managedCachePath) {
    return managedCachePath;
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
    homeDir ? path.join(homeDir, ".cache", "gharmonize", "web-bin") : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(candidate, 0o700); } catch {}
      fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }

  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-web-bin-"));
  try { fs.chmodSync(fallback, 0o700); } catch {}
  return fallback;
}

const WEB_CACHE_DIR = resolveWebCacheDir();
const WEB_RUNTIME_TMP_DIR = path.join(WEB_CACHE_DIR, "tmp");
const WEB_META_FILE = path.join(WEB_CACHE_DIR, "metadata.json");

function resolveBinaryRuntimeTmpDir() {
  const configured = String(process.env.GHARMONIZE_BINARY_TMP_DIR || "").trim();
  const candidates = [
    configured ? path.resolve(configured) : null,
    WEB_RUNTIME_TMP_DIR,
    path.join(process.cwd(), "temp", "binary-tmp")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
      try { fs.chmodSync(candidate, 0o700); } catch {}
      fs.accessSync(candidate, fs.constants.W_OK | fs.constants.X_OK);
      return candidate;
    } catch {
    }
  }

  const fallback = fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-bin-tmp-"));
  try { fs.chmodSync(fallback, 0o700); } catch {}
  return fallback;
}

export function getBinaryRuntimeEnv(extraEnv = {}) {
  const tmpDir = resolveBinaryRuntimeTmpDir();
  return {
    ...process.env,
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    PYINSTALLER_TEMP: tmpDir,
    ...extraEnv
  };
}

// Resolves a managed runtime binary from the persistent web cache.
function resolveManagedCacheBin(baseName) {
  if (!WEB_BINARIES_ENABLED) return null;

  const toolKey = baseName === "yt-dlp" ? "ytdlp" : baseName;
  const meta = readJsonFile(WEB_META_FILE, {});
  const metaEntry =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? meta[toolKey]
      : null;
  const candidates = [
    path.join(WEB_CACHE_DIR, pickExeName(baseName)),
    metaEntry?.path ? path.resolve(String(metaEntry.path)) : null,
    toolKey === "mkvpropedit" && meta?.mkvmerge?.helperPath
      ? path.resolve(String(meta.mkvmerge.helperPath))
      : null
  ].filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

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
  const target = assertPathWithinAny(filePath, [WEB_CACHE_DIR]);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  // Target is confined to WEB_CACHE_DIR; remote metadata cannot choose the filesystem destination.
  await fs.promises.writeFile(target, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
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

const TRUSTED_BINARY_HOSTS = new Set([
  "github.com", "api.github.com", "objects.githubusercontent.com",
  "github-releases.githubusercontent.com", "release-assets.githubusercontent.com",
  "mkvtoolnix.download"
]);
const MAX_BINARY_DOWNLOAD_BYTES = Math.max(10 * 1024 * 1024, Number(process.env.GHARMONIZE_BINARY_MAX_BYTES || 2 * 1024 * 1024 * 1024));

function normalizeSha256Digest(raw) {
  const value = String(raw || "").trim().toLowerCase().replace(/^sha256:/, "");
  return /^[0-9a-f]{64}$/.test(value) ? value : "";
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

function assertTrustedBinaryUrl(rawUrl) {
  const parsed = new URL(String(rawUrl || ""));
  if (parsed.protocol !== "https:") throw new Error("Runtime binaries must be downloaded over HTTPS");
  if (!TRUSTED_BINARY_HOSTS.has(parsed.hostname) && process.env.GHARMONIZE_ALLOW_UNVERIFIED_BINARY_URLS !== "1") {
    throw new Error(`Untrusted runtime binary host: ${parsed.hostname}`);
  }
}

// Downloads a runtime binary/archive with origin, size and optional SHA-256 verification.
async function downloadToFile(url, filePath, headers = HTTP_HEADERS, expectedDigest = "") {
  assertTrustedBinaryUrl(url);
  const res = await fetchWithTimeout(url, { headers, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status} ${res.statusText})`);
  assertTrustedBinaryUrl(res.url || url);

  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BINARY_DOWNLOAD_BYTES) throw new Error(`Runtime binary exceeds download size limit (${declared} bytes)`);

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  let downloaded = 0;
  const source = Readable.fromWeb(res.body);
  source.on("data", (chunk) => {
    downloaded += chunk.length;
    if (downloaded > MAX_BINARY_DOWNLOAD_BYTES) source.destroy(new Error("Runtime binary exceeds download size limit"));
  });
  await pipeline(source, fs.createWriteStream(filePath, { mode: 0o600 }));

  const expected = normalizeSha256Digest(expectedDigest);
  if (expected) {
    const actual = await sha256File(filePath);
    if (actual !== expected) {
      await fs.promises.rm(filePath, { force: true }).catch(() => {});
      throw new Error(`SHA-256 mismatch for runtime binary (expected ${expected}, got ${actual})`);
    }
  }
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

// Finds first existing file from a list of candidate names.
async function findFirstFileRecursive(dir, fileNames = []) {
  let lastError = null;
  for (const fileName of fileNames) {
    try {
      return await findFileRecursive(dir, fileName);
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    lastError?.message ||
    `None of the requested files were found: ${fileNames.join(", ")}`
  );
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
    windowsHide: true,
    env: getBinaryRuntimeEnv()
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
    windowsHide: true,
    env: getBinaryRuntimeEnv()
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


// Compares dotted numeric versions such as 8.1 and 7.1.
function compareNumericVersionsDesc(a, b) {
  const aa = String(a || "").split(".").map((n) => Number(n) || 0);
  const bb = String(b || "").split(".").map((n) => Number(n) || 0);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (bb[i] || 0) - (aa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Selects the newest BtbN release-branch asset for the current platform.
// Unlike the old broad matcher, this deliberately excludes "master-latest".
function resolveStableFfmpegAsset(release) {
  const target = FFMPEG_RELEASE_TARGETS?.[process.platform]?.[process.arch];
  if (!target) return null;

  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const escapedToken = target.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedExt = target.extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const releaseRe = new RegExp(
    `^ffmpeg-n(\\d+(?:\\.\\d+)+)-latest-${escapedToken}-gpl(?:-[0-9.]+)?${escapedExt}$`,
    "i"
  );

  const candidates = assets
    .map((asset) => {
      const name = String(asset?.name || "");
      if (/shared/i.test(name)) return null;
      const match = name.match(releaseRe);
      if (!match) return null;
      return { asset, version: match[1] };
    })
    .filter(Boolean)
    .sort((a, b) => compareNumericVersionsDesc(a.version, b.version));

  return candidates[0]?.asset || null;
}

// Selects BtbN master only when the user explicitly opts in.
function resolveMasterFfmpegAsset(release) {
  const target = FFMPEG_RELEASE_TARGETS?.[process.platform]?.[process.arch];
  if (!target) return null;
  const expected = `ffmpeg-master-latest-${target.token}-gpl${target.extension}`.toLowerCase();
  return (Array.isArray(release?.assets) ? release.assets : [])
    .find((asset) => String(asset?.name || "").toLowerCase() === expected) || null;
}

function resolvePreferredFfmpegAsset(release, channel = getFfmpegChannel()) {
  if (channel === "master") {
    return resolveMasterFfmpegAsset(release);
  }
  return resolveStableFfmpegAsset(release);
}

// Runs a binary while preserving stderr even for non-zero exits.
async function execFileCapture(binaryPath, args = [], timeout = 8000) {
  try {
    const { stdout, stderr } = await execFileAsync(binaryPath, args, {
      timeout,
      windowsHide: true,
      env: getBinaryRuntimeEnv(),
      maxBuffer: 4 * 1024 * 1024
    });
    return { code: 0, stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (error) {
    return {
      code: Number.isInteger(error?.code) ? error.code : 1,
      stdout: String(error?.stdout || ""),
      stderr: String(error?.stderr || error?.message || "")
    };
  }
}

function summarizeNvencProbeDetail(detail) {
  const lines = String(detail || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const preferredPatterns = [
    /Driver does not support the required nvenc API version/i,
    /minimum required Nvidia driver/i,
    /required nvenc API/i,
    /Cannot load libnvidia-encode/i,
    /Cannot load libcuda/i,
    /CUDA_ERROR/i,
    /No capable devices/i,
    /Error while opening encoder/i
  ];

  for (const pattern of preferredPatterns) {
    const line = lines.find((item) => pattern.test(item));
    if (line) return line;
  }
  return lines[lines.length - 1];
}

function isNvencApiCompatibilityFailure(detail) {
  return /Driver does not support the required nvenc API version|minimum required Nvidia driver|required nvenc API/i
    .test(String(detail || ""));
}

// Lightweight hardware validation used only for FFmpeg activation/rollback.
// h264_nvenc is a good canary because every NVENC-capable NVIDIA generation
// supported by Gharmonize exposes H.264 encode even when HEVC/AV1 differs.
async function probeH264Nvenc(ffmpegPath) {
  const encoders = await execFileCapture(ffmpegPath, ["-hide_banner", "-encoders"], 8000);
  if (encoders.code !== 0) {
    return {
      listed: false,
      ok: false,
      code: encoders.code,
      detail: summarizeNvencProbeDetail(encoders.stderr)
    };
  }

  const encoderText = `${encoders.stdout}\n${encoders.stderr}`;
  if (!/\bh264_nvenc\b/i.test(encoderText)) {
    return { listed: false, ok: false, code: 0, detail: "h264_nvenc is not listed" };
  }

  const probe = await execFileCapture(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "verbose",
    "-f", "lavfi",
    "-i", "color=c=black:s=128x128:r=30:d=0.1",
    "-an",
    "-c:v", "h264_nvenc",
    "-t", "0.1",
    "-f", "null",
    "-"
  ], 10000);

  return {
    listed: true,
    ok: probe.code === 0,
    code: probe.code,
    detail: summarizeNvencProbeDetail(probe.stderr),
    rawDetail: String(probe.stderr || "").split(/\r?\n/).slice(-24).join("\n").trim()
  };
}

async function inspectFfmpegPair(ffmpegPath, ffprobePath) {
  const result = {
    basic: false,
    nvenc: { listed: false, ok: false, code: null, detail: "" }
  };

  if (!isExecutable(ffmpegPath) || !isExecutable(ffprobePath)) {
    return result;
  }

  try {
    await verifyVersionedBinary(ffmpegPath, "ffmpeg", ["-version"]);
    await verifyVersionedBinary(ffprobePath, "ffprobe", ["-version"]);
    result.basic = true;
  } catch (error) {
    result.basicError = String(error?.message || error);
    return result;
  }

  result.nvenc = await probeH264Nvenc(ffmpegPath);
  return result;
}

function activeFfmpegPairFromMeta(meta) {
  if (!meta?.ffmpeg?.path || !meta?.ffprobe?.path) return null;
  return {
    ffmpegPath: meta.ffmpeg.path,
    ffprobePath: meta.ffprobe.path,
    tag: meta.ffmpeg.tag || meta.ffprobe.tag || "",
    source: meta.ffmpeg.source || "legacy",
    assetName: meta.ffmpeg.assetName || "",
    validation: meta.ffmpeg.validation || null
  };
}

function lastKnownGoodPairFromMeta(meta) {
  const lkg = meta?.ffmpegLastKnownGood;
  if (!lkg?.ffmpegPath || !lkg?.ffprobePath) return null;
  return { ...lkg };
}

function pairPathsDiffer(a, b) {
  if (!a || !b) return true;
  return path.resolve(String(a.ffmpegPath)) !== path.resolve(String(b.ffmpegPath)) ||
    path.resolve(String(a.ffprobePath)) !== path.resolve(String(b.ffprobePath));
}

function validationAllowsActivation(candidateValidation, baselineValidation = null) {
  if (!candidateValidation?.basic) {
    return { ok: false, reason: candidateValidation?.basicError || "basic FFmpeg validation failed" };
  }

  if (baselineValidation?.nvenc?.ok && !candidateValidation?.nvenc?.ok) {
    return {
      ok: false,
      reason: `NVENC regression: ${candidateValidation?.nvenc?.detail || "h264_nvenc runtime probe failed"}`
    };
  }

  // On a first install/migration there may be no LKG yet. An explicit NVENC
  // API/driver mismatch means we know this candidate is incompatible with the
  // NVIDIA runtime that is actually present, so do not activate it.
  if (
    candidateValidation?.nvenc?.listed &&
    !candidateValidation?.nvenc?.ok &&
    isNvencApiCompatibilityFailure(
      `${candidateValidation?.nvenc?.detail || ""}\n${candidateValidation?.nvenc?.rawDetail || ""}`
    )
  ) {
    return {
      ok: false,
      reason: candidateValidation?.nvenc?.detail || "NVENC API/driver compatibility failure"
    };
  }

  return { ok: true, reason: "" };
}

async function inspectPairMaybe(pair) {
  if (!pair?.ffmpegPath || !pair?.ffprobePath) return null;
  const validation = await inspectFfmpegPair(pair.ffmpegPath, pair.ffprobePath);
  return { ...pair, validation };
}

async function findCompatibleLocalFfmpegPair(excludePaths = []) {
  const excluded = new Set(excludePaths.filter(Boolean).map((p) => path.resolve(String(p))));
  const candidates = [];

  const addPair = (ffmpegPath, ffprobePath, source) => {
    if (!ffmpegPath || !ffprobePath) return;
    const resolved = path.resolve(String(ffmpegPath));
    if (excluded.has(resolved)) return;
    if (candidates.some((item) => path.resolve(String(item.ffmpegPath)) === resolved)) return;
    candidates.push({ ffmpegPath, ffprobePath, tag: source, source });
  };

  if (PACKAGED_BIN_DIR) {
    addPair(
      path.join(PACKAGED_BIN_DIR, pickExeName("ffmpeg")),
      path.join(PACKAGED_BIN_DIR, pickExeName("ffprobe")),
      "packaged"
    );
  }

  addPair(
    path.join(DEV_BIN_DIR, pickExeName("ffmpeg")),
    path.join(DEV_BIN_DIR, pickExeName("ffprobe")),
    "development"
  );

  addPair(
    findOnPath(pickExeName("ffmpeg")),
    findOnPath(pickExeName("ffprobe")),
    "system"
  );

  for (const pair of candidates) {
    if (!isExecutable(pair.ffmpegPath) || !isExecutable(pair.ffprobePath)) continue;
    const inspected = await inspectPairMaybe(pair);
    if (inspected?.validation?.basic && inspected?.validation?.nvenc?.ok) {
      return inspected;
    }
  }

  return null;
}

function setActiveFfmpegMetadata(meta, pair, validation, extra = {}) {
  setMetaEntry(meta, "ffmpeg", {
    tag: pair.tag,
    path: pair.ffmpegPath,
    source: pair.source || "btbn-stable",
    assetName: pair.assetName || "",
    validation,
    ...extra
  });
  setMetaEntry(meta, "ffprobe", {
    tag: pair.tag,
    path: pair.ffprobePath,
    source: pair.source || "btbn-stable",
    assetName: pair.assetName || "",
    ...extra
  });
}

function setLastKnownGoodMetadata(meta, pair, validation) {
  if (!pair?.ffmpegPath || !pair?.ffprobePath || !validation?.basic) return;
  meta.ffmpegLastKnownGood = {
    tag: pair.tag || "",
    ffmpegPath: pair.ffmpegPath,
    ffprobePath: pair.ffprobePath,
    source: pair.source || "unknown",
    assetName: pair.assetName || "",
    validation,
    savedAt: Date.now()
  };
}

async function pruneFfmpegCache(meta) {
  const active = activeFfmpegPairFromMeta(meta);
  const lkg = lastKnownGoodPairFromMeta(meta);
  await pruneVersionedFiles("ffmpeg-", [active?.ffmpegPath, lkg?.ffmpegPath]);
  await pruneVersionedFiles("ffprobe-", [active?.ffprobePath, lkg?.ffprobePath]);
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
  const target = assertPathWithinAny(filePath, [WEB_CACHE_DIR]);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  // Target is confined to WEB_CACHE_DIR and the wrapper content is generated by Gharmonize.
  await fs.promises.writeFile(target, content, { encoding: "utf8", mode: 0o700 });
  if (process.platform !== "win32") {
    await fs.promises.chmod(target, 0o700).catch(() => {});
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

  const release = await fetchLatestRelease("yt-dlp/yt-dlp");
  const tag = String(release?.tag_name || "").trim();
  if (!tag) throw new Error("yt-dlp release tag is missing");
  const releaseAsset = resolveReleaseAsset(release, asset);
  if (!releaseAsset?.browser_download_url) throw new Error(`yt-dlp release asset not found: ${asset}`);
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
  const url = releaseAsset.browser_download_url;

  await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
  try {
    startDynamicBinaryTask("ytdlp", "downloading", "Downloading yt-dlp");
    await downloadToFile(url, tmpPath, HTTP_HEADERS, releaseAsset.digest);
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

  const release = await fetchLatestRelease("denoland/deno");
  const tag = String(release?.tag_name || "").trim();
  if (!tag) throw new Error("Deno release tag is missing");
  const releaseAsset = resolveReleaseAsset(release, asset);
  if (!releaseAsset?.browser_download_url) throw new Error(`Deno release asset not found: ${asset}`);
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
  const url = releaseAsset.browser_download_url;

  await fs.promises.rm(tmpZipPath, { force: true }).catch(() => {});
  await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

  try {
    startDynamicBinaryTask("deno", "downloading", "Downloading deno");
    await downloadToFile(url, tmpZipPath, HTTP_HEADERS, releaseAsset.digest);
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

// Ensures a tested BtbN FFmpeg release build and preserves a last-known-good pair.
async function ensureLatestFfmpegTools(meta, options = {}) {
  const force = !!options.force;
  const ffmpegChannel = getFfmpegChannel();
  const currentPair = activeFfmpegPairFromMeta(meta);
  const lkgPair = lastKnownGoodPairFromMeta(meta);

  const currentInspected = currentPair && isExecutable(currentPair.ffmpegPath) && isExecutable(currentPair.ffprobePath)
    ? await inspectPairMaybe(currentPair)
    : null;
  const lkgInspected = lkgPair && isExecutable(lkgPair.ffmpegPath) && isExecutable(lkgPair.ffprobePath)
    ? await inspectPairMaybe(lkgPair)
    : null;

  const baselineValidation =
    currentInspected?.validation?.nvenc?.ok ? currentInspected.validation :
    lkgInspected?.validation?.nvenc?.ok ? lkgInspected.validation :
    currentInspected?.validation?.basic ? currentInspected.validation :
    lkgInspected?.validation?.basic ? lkgInspected.validation :
    null;

  const currentSource = String(currentPair?.source || "");
  const currentStoredNvencWasGood = !!currentPair?.validation?.nvenc?.ok;
  const currentHasRuntimeRegression =
    currentStoredNvencWasGood && !currentInspected?.validation?.nvenc?.ok;
  const currentHasApiMismatch = isNvencApiCompatibilityFailure(
    `${currentInspected?.validation?.nvenc?.detail || ""}\n${currentInspected?.validation?.nvenc?.rawDetail || ""}`
  );

  // A stable build that already passed validation remains active until TTL.
  // We still run the tiny NVENC canary so a driver downgrade/runtime regression
  // can trigger rollback instead of silently switching the user's encoder.
  if (
    !force &&
    currentInspected?.validation?.basic &&
    currentSource === "btbn-stable" &&
    isFresh(meta?.ffmpeg) &&
    isFresh(meta?.ffprobe) &&
    !currentHasRuntimeRegression &&
    !currentHasApiMismatch
  ) {
    // Refresh the cached runtime result without extending checkedAt; otherwise
    // opening the app frequently would postpone the next update forever.
    if (meta?.ffmpeg) {
      meta.ffmpeg.validation = currentInspected.validation;
    }
    await pruneFfmpegCache(meta);
    return {
      ffmpegPath: currentPair.ffmpegPath,
      ffprobePath: currentPair.ffprobePath,
      source: currentSource,
      validation: currentInspected.validation
    };
  }

  // If the latest candidate was rejected recently, keep the known-good fallback
  // without downloading the same large archive on every application start.
  if (
    !force &&
    currentInspected?.validation?.basic &&
    meta?.ffmpegRejected?.checkedAt &&
    (Date.now() - Number(meta.ffmpegRejected.checkedAt)) < WEB_TTL_MS
  ) {
    await pruneFfmpegCache(meta);
    return {
      ffmpegPath: currentPair.ffmpegPath,
      ffprobePath: currentPair.ffprobePath,
      source: currentSource || "fallback",
      validation: currentInspected.validation,
      rejectedCandidate: meta.ffmpegRejected
    };
  }

  const release = await fetchLatestRelease("BtbN/FFmpeg-Builds");
  const asset = resolvePreferredFfmpegAsset(release, ffmpegChannel);
  if (!asset?.browser_download_url) {
    throw new Error(
      ffmpegChannel === "master"
        ? "FFmpeg master release asset was not found"
        : "FFmpeg stable/release-branch asset was not found"
    );
  }

  const assetName = String(asset.name || "");
  const branchName = assetName.match(/^ffmpeg-(n[0-9.]+|master)-latest-/i)?.[1] || ffmpegChannel;
  const releaseStamp = release?.published_at || asset?.updated_at || release?.tag_name || Date.now();
  const versionTag = sanitizeTag(`${branchName}-${releaseStamp}`);
  const ffmpegFinalPath = path.join(
    WEB_CACHE_DIR,
    process.platform === "win32" ? `ffmpeg-${versionTag}.exe` : `ffmpeg-${versionTag}`
  );
  const ffprobeFinalPath = path.join(
    WEB_CACHE_DIR,
    process.platform === "win32" ? `ffprobe-${versionTag}.exe` : `ffprobe-${versionTag}`
  );

  const candidatePair = {
    ffmpegPath: ffmpegFinalPath,
    ffprobePath: ffprobeFinalPath,
    tag: versionTag,
    source: ffmpegChannel === "master" ? "btbn-master" : "btbn-stable",
    assetName
  };

  // Avoid re-downloading an already staged candidate, but never trust it until
  // both the basic executable checks and the runtime hardware probe pass.
  let candidateValidation = null;
  if (isExecutable(ffmpegFinalPath) && isExecutable(ffprobeFinalPath)) {
    candidateValidation = await inspectFfmpegPair(ffmpegFinalPath, ffprobeFinalPath);
    if (!candidateValidation.basic) {
      await fs.promises.rm(ffmpegFinalPath, { force: true }).catch(() => {});
      await fs.promises.rm(ffprobeFinalPath, { force: true }).catch(() => {});
      candidateValidation = null;
    }
  }

  const archivePath = path.join(
    WEB_CACHE_DIR,
    `ffmpeg-candidate-${versionTag}${archiveSuffixFromName(asset.name)}`
  );
  const tmpArchivePath = `${archivePath}.download`;
  const extractDir = path.join(
    WEB_CACHE_DIR,
    `ffmpeg-candidate-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );

  try {
    if (!candidateValidation) {
      await fs.promises.rm(tmpArchivePath, { force: true }).catch(() => {});
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

      startDynamicBinaryTask(
        "ffmpeg",
        "downloading",
        ffmpegChannel === "master"
          ? "Downloading ffmpeg master candidate"
          : "Downloading ffmpeg stable candidate"
      );
      await downloadToFile(asset.browser_download_url, tmpArchivePath, HTTP_HEADERS, asset.digest);
      await fs.promises.rename(tmpArchivePath, archivePath);
      await fs.promises.mkdir(extractDir, { recursive: true });
      await extractArchive(archivePath, extractDir);

      const extractedFfmpeg = await findFileRecursive(extractDir, pickExeName("ffmpeg"));
      const extractedFfprobe = await findFileRecursive(extractDir, pickExeName("ffprobe"));
      await copyExecutable(extractedFfmpeg, ffmpegFinalPath);
      await copyExecutable(extractedFfprobe, ffprobeFinalPath);
      candidateValidation = await inspectFfmpegPair(ffmpegFinalPath, ffprobeFinalPath);
    }

    const decision = validationAllowsActivation(candidateValidation, baselineValidation);
    if (!decision.ok) {
      console.warn(`[binaries] FFmpeg candidate rejected: ${decision.reason}`);
      meta.ffmpegRejected = {
        tag: versionTag,
        assetName,
        channel: ffmpegChannel,
        reason: decision.reason,
        validation: candidateValidation,
        checkedAt: Date.now()
      };

      // Remove only a newly staged candidate. If this exact pair is already
      // active (for example after a driver downgrade), deleting it would leave
      // the degraded fallback metadata pointing at missing files.
      const candidateIsCurrent = currentPair && !pairPathsDiffer(candidatePair, currentPair);
      const candidateIsLkg = lkgPair && !pairPathsDiffer(candidatePair, lkgPair);
      if (!candidateIsCurrent && !candidateIsLkg) {
        await fs.promises.rm(ffmpegFinalPath, { force: true }).catch(() => {});
        await fs.promises.rm(ffprobeFinalPath, { force: true }).catch(() => {});
      }

      // Prefer the current working pair, then the saved LKG, then a packaged/
      // system FFmpeg whose NVENC canary is actually healthy on this machine.
      let fallback = null;
      if (currentInspected?.validation?.basic && currentInspected?.validation?.nvenc?.ok) {
        fallback = currentInspected;
      } else if (lkgInspected?.validation?.basic && lkgInspected?.validation?.nvenc?.ok) {
        fallback = lkgInspected;
      } else {
        fallback = await findCompatibleLocalFfmpegPair([
          currentPair?.ffmpegPath,
          lkgPair?.ffmpegPath,
          ffmpegFinalPath
        ]);
      }

      if (fallback) {
        setActiveFfmpegMetadata(meta, fallback, fallback.validation, {
          channel: "fallback"
        });
        setLastKnownGoodMetadata(meta, fallback, fallback.validation);
        await pruneFfmpegCache(meta);
        return {
          ffmpegPath: fallback.ffmpegPath,
          ffprobePath: fallback.ffprobePath,
          source: fallback.source || "fallback",
          validation: fallback.validation,
          rejectedCandidate: meta.ffmpegRejected
        };
      }

      // No NVENC-compatible rollback target exists. Keep an already runnable
      // FFmpeg pair rather than breaking the entire application; media.js will
      // still fall back to software/VAAPI and the updater will retry after TTL.
      if (currentInspected?.validation?.basic) {
        setActiveFfmpegMetadata(meta, currentInspected, currentInspected.validation, {
          channel: "degraded-fallback"
        });
        await pruneFfmpegCache(meta);
        return {
          ffmpegPath: currentInspected.ffmpegPath,
          ffprobePath: currentInspected.ffprobePath,
          source: currentInspected.source || "degraded-fallback",
          validation: currentInspected.validation,
          rejectedCandidate: meta.ffmpegRejected
        };
      }

      throw new Error(`FFmpeg candidate rejected and no compatible rollback target exists: ${decision.reason}`);
    }

    // Preserve the previous good active pair before promoting the candidate.
    if (
      currentInspected?.validation?.basic &&
      pairPathsDiffer(currentInspected, candidatePair) &&
      !isNvencApiCompatibilityFailure(
        `${currentInspected.validation?.nvenc?.detail || ""}\n${currentInspected.validation?.nvenc?.rawDetail || ""}`
      )
    ) {
      setLastKnownGoodMetadata(meta, currentInspected, currentInspected.validation);
    } else if (lkgInspected?.validation?.basic) {
      setLastKnownGoodMetadata(meta, lkgInspected, lkgInspected.validation);
    }

    setActiveFfmpegMetadata(meta, candidatePair, candidateValidation, {
      channel: ffmpegChannel === "master" ? "master" : "stable"
    });

    // On the first successful managed install the active pair itself is the
    // first known-good checkpoint. A later successful update will move the old
    // active pair into this slot before promotion.
    if (!lastKnownGoodPairFromMeta(meta)) {
      setLastKnownGoodMetadata(meta, candidatePair, candidateValidation);
    }

    delete meta.ffmpegRejected;
    await pruneFfmpegCache(meta);

    return {
      ffmpegPath: ffmpegFinalPath,
      ffprobePath: ffprobeFinalPath,
      source: candidatePair.source,
      validation: candidateValidation
    };
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
      await downloadToFile(url, tmpAppImagePath, HTTP_HEADERS, process.env.GHARMONIZE_MKVMERGE_SHA256);
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
	if (!["x64", "ia32"].includes(process.arch)) return null;

    const bitLabel =
      process.arch === "ia32"
        ? "32-bit"
        : "64-bit";

    const archivePath = path.join(WEB_CACHE_DIR, `mkvtoolnix-${safeVersion}.zip`);
    const tmpArchivePath = `${archivePath}.download`;
    const extractDir = path.join(WEB_CACHE_DIR, `mkvmerge-extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const finalPath = path.join(WEB_CACHE_DIR, `mkvmerge-${safeVersion}.exe`);
    const helperPath = path.join(WEB_CACHE_DIR, `mkvpropedit-${safeVersion}.exe`);
    const url = `https://mkvtoolnix.download/windows/releases/${version}/mkvtoolnix-${bitLabel}-${version}.zip`;

    if (isExecutable(finalPath) && isExecutable(helperPath)) {
      try {
        await verifyVersionedBinary(finalPath, "mkvmerge", ["--version"]);
        await verifyVersionedBinary(helperPath, "mkvpropedit", ["--version"]);
        setMetaEntry(meta, "mkvmerge", {
          tag: version,
          path: finalPath,
          helperPath
        });
        if (!process.env.MKVPROPEDIT_BIN) {
          MKVPROPEDIT_BIN = helperPath;
        }
        await pruneVersionedFiles("mkvmerge-", finalPath);
        await pruneVersionedFiles("mkvpropedit-", helperPath);
        return finalPath;
      } catch {
        await fs.promises.rm(finalPath, { force: true }).catch(() => {});
		await fs.promises.rm(helperPath, { force: true }).catch(() => {});
      }
    }

    await fs.promises.rm(tmpArchivePath, { force: true }).catch(() => {});
    await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});

    try {
      startDynamicBinaryTask("mkvmerge", "downloading", "Downloading mkvmerge");
	  console.log("[binaries] mkvmerge url:", url);
      await downloadToFile(url, tmpArchivePath, HTTP_HEADERS, process.env.GHARMONIZE_MKVMERGE_SHA256);
      await fs.promises.rename(tmpArchivePath, archivePath);
      await fs.promises.mkdir(extractDir, { recursive: true });
      await extractArchive(archivePath, extractDir);
	  console.log("[binaries] mkvmerge extracted to:", extractDir);
      const extractedMkvmerge = await findFirstFileRecursive(extractDir, ["mkvmerge.exe"]);
      const extractedMkvpropedit = await findFirstFileRecursive(extractDir, ["mkvpropedit.exe"]);

      await copyExecutable(extractedMkvmerge, finalPath);
      await copyExecutable(extractedMkvpropedit, helperPath);

      await verifyVersionedBinary(finalPath, "mkvmerge", ["--version"]);
      await verifyVersionedBinary(helperPath, "mkvpropedit", ["--version"]);

      setMetaEntry(meta, "mkvmerge", {
        tag: version,
        path: finalPath,
        helperPath
      });
      if (!process.env.MKVPROPEDIT_BIN) {
        MKVPROPEDIT_BIN = helperPath;
      }
      await pruneVersionedFiles("mkvmerge-", finalPath);
      await pruneVersionedFiles("mkvpropedit-", helperPath);
      return finalPath;
    } catch (err) {
      await fs.promises.rm(finalPath, { force: true }).catch(() => {});
	  await fs.promises.rm(helperPath, { force: true }).catch(() => {});
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

      const shouldOverride = (
        envVarName,
        currentPath = "",
        { preferNativeInDocker = false } = {}
      ) => {
        const explicitEnvPath = String(process.env[envVarName] || "").trim();
        if (explicitEnvPath) {
          return false;
        }
        if (force) return true;
        if (
          preferNativeInDocker &&
          IS_DOCKER &&
          !WEB_FORCE_DOCKER_OVERRIDE &&
          isExecutable(currentPath)
        ) {
          return false;
        }
        return true;
      };

      if (
        shouldOverride("FFMPEG_BIN", FFMPEG_BIN) ||
        shouldOverride("FFPROBE_BIN", FFPROBE_BIN)
      ) {
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
            if (latestFfmpegTools.rejectedCandidate) {
              const rollbackSource = String(latestFfmpegTools.source || "fallback");
              console.warn(
                `[binaries] FFmpeg candidate rejected; keeping ${rollbackSource}: ` +
                `${latestFfmpegTools.rejectedCandidate.reason || "runtime validation failed"}`
              );
              finishDynamicBinaryTask(
                "ffmpeg",
                "ready",
                `FFmpeg candidate rejected; using ${rollbackSource}`
              );
            } else {
              finishDynamicBinaryTask(
                "ffmpeg",
                "ready",
                latestFfmpegTools.source === "btbn-master"
                  ? "ffmpeg / ffprobe master ready"
                  : "ffmpeg / ffprobe stable ready"
              );
            }
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

      if (
        shouldOverride("MKVMERGE_BIN", MKVMERGE_BIN, { preferNativeInDocker: true })
      ) {
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

      if (shouldOverride("YTDLP_BIN", YTDLP_BIN)) {
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

      if (shouldOverride("DENO_BIN", DENO_BIN)) {
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
