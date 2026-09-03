import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const CONTROL_CHARS = /[\u0000\r\n\u2028\u2029]/;
const CONTROL_CHARS_WITH_MULTILINE = /[\u0000\u2028\u2029]/;
const DEFAULT_ALLOWED_EXECUTABLES = new Set([
  "yt-dlp", "yt-dlp.exe",
  "ffmpeg", "ffmpeg.exe",
  "ffprobe", "ffprobe.exe",
  "ffmpeg-candidate", "ffmpeg-candidate.exe",
  "ffprobe-candidate", "ffprobe-candidate.exe",
  "ffmpeg-lkg", "ffmpeg-lkg.exe",
  "ffprobe-lkg", "ffprobe-lkg.exe",
  "mkvmerge", "mkvmerge.exe",
  "mkvpropedit", "mkvpropedit.exe",
  "deno", "deno.exe",
  "vainfo", "vainfo.exe",
  "tar", "tar.exe",
  "bsdtar", "bsdtar.exe",
  "7z", "7z.exe", "7zr", "7zr.exe", "7za", "7za.exe",
  "xdg-open", "gio", "open", "explorer.exe", "taskkill.exe", "taskkill",
  "reg.exe", "reg", "update-desktop-database",
  "powershell", "powershell.exe", "pwsh", "pwsh.exe", "unzip", "unzip.exe"
]);

const YTDLP_DANGEROUS_FLAGS = [
  "--exec",
  "--exec-before-download",
  "--external-downloader",
  "--external-downloader-args",
  "--config-location",
  "--config-locations",
  "--plugin-dirs"
];

const YTDLP_ALLOWED_COOKIE_BROWSERS = new Set([
  "chrome",
  "chromium",
  "firefox",
  "edge"
]);

function assertSafeYtDlpFfmpegLocation(value) {
  const location = assertPlainProcessString(value, "yt-dlp ffmpeg location", 4096, { allowEmpty: false }).trim();
  if (!path.isAbsolute(location) || location.endsWith(path.sep)) {
    throw new Error(`Unsafe yt-dlp ffmpeg location is blocked: ${location}`);
  }

  const base = path.basename(location).toLowerCase();
  if (base !== "ffmpeg" && base !== "ffmpeg.exe") {
    throw new Error(`Unsafe yt-dlp ffmpeg location is blocked: ${location}`);
  }

  return location;
}

function assertPlainProcessString(value, label, maxLength, { allowEmpty = true, allowLineBreaks = false } = {}) {
  const text = String(value ?? "");
  const unsafeChars = allowLineBreaks ? CONTROL_CHARS_WITH_MULTILINE : CONTROL_CHARS;
  if ((!allowEmpty && !text) || text.length > maxLength || unsafeChars.test(text)) {
    throw new Error(`Unsafe ${label}`);
  }
  return text;
}

function canonicalExecutableToken(command) {
  const text = assertPlainProcessString(command, "executable path", 4096, { allowEmpty: false });
  const base = path.basename(text).toLowerCase();
  if (!DEFAULT_ALLOWED_EXECUTABLES.has(base)) {
    throw new Error(`Executable is not in the Gharmonize allowlist: ${base}`);
  }

  // Return only compile-time literal command tokens. The caller-supplied path
  // is never forwarded as child_process' executable argument.
  switch (base) {
    case "yt-dlp": return "yt-dlp";
    case "yt-dlp.exe": return "yt-dlp.exe";
    case "ffmpeg": return "ffmpeg";
    case "ffmpeg.exe": return "ffmpeg.exe";
    case "ffprobe": return "ffprobe";
    case "ffprobe.exe": return "ffprobe.exe";
    case "ffmpeg-candidate": return "ffmpeg-candidate";
    case "ffmpeg-candidate.exe": return "ffmpeg-candidate.exe";
    case "ffprobe-candidate": return "ffprobe-candidate";
    case "ffprobe-candidate.exe": return "ffprobe-candidate.exe";
    case "ffmpeg-lkg": return "ffmpeg-lkg";
    case "ffmpeg-lkg.exe": return "ffmpeg-lkg.exe";
    case "ffprobe-lkg": return "ffprobe-lkg";
    case "ffprobe-lkg.exe": return "ffprobe-lkg.exe";
    case "mkvmerge": return "mkvmerge";
    case "mkvmerge.exe": return "mkvmerge.exe";
    case "mkvpropedit": return "mkvpropedit";
    case "mkvpropedit.exe": return "mkvpropedit.exe";
    case "deno": return "deno";
    case "deno.exe": return "deno.exe";
    case "vainfo": return "vainfo";
    case "vainfo.exe": return "vainfo.exe";
    case "tar": return "tar";
    case "tar.exe": return "tar.exe";
    case "bsdtar": return "bsdtar";
    case "bsdtar.exe": return "bsdtar.exe";
    case "7z": return "7z";
    case "7z.exe": return "7z.exe";
    case "7zr": return "7zr";
    case "7zr.exe": return "7zr.exe";
    case "7za": return "7za";
    case "7za.exe": return "7za.exe";
    case "xdg-open": return "xdg-open";
    case "gio": return "gio";
    case "open": return "open";
    case "explorer.exe": return "explorer.exe";
    case "taskkill.exe": return "taskkill.exe";
    case "taskkill": return "taskkill";
    case "reg.exe": return "reg.exe";
    case "reg": return "reg";
    case "update-desktop-database": return "update-desktop-database";
    case "powershell": return "powershell";
    case "powershell.exe": return "powershell.exe";
    case "pwsh": return "pwsh";
    case "pwsh.exe": return "pwsh.exe";
    case "unzip": return "unzip";
    case "unzip.exe": return "unzip.exe";
    default: throw new Error(`Executable is not in the Gharmonize allowlist: ${base}`);
  }
}

export function assertTrustedExecutable(command) {
  const text = assertPlainProcessString(command, "executable path", 4096, { allowEmpty: false });
  canonicalExecutableToken(text);
  return text;
}

// Treats a blank settings override as "use the managed/default executable"
// while keeping process execution itself strict and non-empty.
export function normalizeTrustedExecutableSetting(value, expectedBase = "") {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const trusted = assertTrustedExecutable(text);
  if (expectedBase) {
    const actual = canonicalExecutableToken(trusted).replace(/\.exe$/i, "");
    const expected = String(expectedBase).toLowerCase().replace(/\.exe$/i, "");
    if (actual !== expected) {
      throw new Error(`Expected ${expected} executable, received ${path.basename(trusted)}`);
    }
  }
  return trusted;
}

export function assertSafeProcessArgs(command, args = []) {
  if (!Array.isArray(args)) throw new Error("Process arguments must be an array");
  const executable = canonicalExecutableToken(command).toLowerCase();
  const isFfmpeg = executable === "ffmpeg" || executable === "ffmpeg.exe"
    || executable === "ffmpeg-candidate" || executable === "ffmpeg-candidate.exe"
    || executable === "ffmpeg-lkg" || executable === "ffmpeg-lkg.exe";
  const safe = args.map((arg, index) => {
    const previous = String(args[index - 1] ?? "").toLowerCase();
    const isFfmpegMetadataValue = isFfmpeg && /^-metadata(?::[^=\s]+)*$/.test(previous);
    return assertPlainProcessString(arg, "process argument", 64 * 1024, {
      allowLineBreaks: isFfmpegMetadataValue,
    });
  });

  if (executable === "yt-dlp" || executable === "yt-dlp.exe") {
    for (let index = 0; index < safe.length; index += 1) {
      const arg = safe[index];
      const lower = arg.toLowerCase();

      if (lower === "--cookies-from-browser" || lower.startsWith("--cookies-from-browser=")) {
        const browser = lower === "--cookies-from-browser"
          ? String(safe[index + 1] || "").trim().toLowerCase()
          : lower.slice("--cookies-from-browser=".length).trim();

        if (!YTDLP_ALLOWED_COOKIE_BROWSERS.has(browser)) {
          throw new Error(`Unsafe yt-dlp browser cookie source is blocked: ${browser || "<empty>"}`);
        }

        if (lower === "--cookies-from-browser") index += 1;
        continue;
      }

      if (lower === "--ffmpeg-location" || lower.startsWith("--ffmpeg-location=")) {
        const location = lower === "--ffmpeg-location"
          ? String(safe[index + 1] || "").trim()
          : arg.slice("--ffmpeg-location=".length).trim();

        assertSafeYtDlpFfmpegLocation(location);
        if (lower === "--ffmpeg-location") index += 1;
        continue;
      }

      if (YTDLP_DANGEROUS_FLAGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`))) {
        if (process.env.GHARMONIZE_ALLOW_UNSAFE_YTDLP_ARGS !== "1") {
          throw new Error(`Unsafe yt-dlp option is blocked: ${arg}`);
        }
      }
    }
  }

  return safe;
}

function buildExecOptions(resolvedCommand, options = {}) {
  const trustedPath = assertTrustedExecutable(resolvedCommand);
  const supplied = options && typeof options === "object" ? options : {};
  const env = { ...process.env, ...(supplied.env || {}) };
  const dir = path.dirname(trustedPath);

  if (path.isAbsolute(trustedPath) || dir !== ".") {
    const resolvedDir = path.resolve(dir);
    env.PATH = [resolvedDir, env.PATH || ""].filter(Boolean).join(path.delimiter);
  }

  return { ...supplied, env, shell: false };
}

function execFileLiteral(token, args, options, callback) {
  switch (token) {
    case "yt-dlp": return execFile("yt-dlp", args, options, callback);
    case "yt-dlp.exe": return execFile("yt-dlp.exe", args, options, callback);
    case "ffmpeg": return execFile("ffmpeg", args, options, callback);
    case "ffmpeg.exe": return execFile("ffmpeg.exe", args, options, callback);
    case "ffprobe": return execFile("ffprobe", args, options, callback);
    case "ffprobe.exe": return execFile("ffprobe.exe", args, options, callback);
    case "ffmpeg-candidate": return execFile("ffmpeg-candidate", args, options, callback);
    case "ffmpeg-candidate.exe": return execFile("ffmpeg-candidate.exe", args, options, callback);
    case "ffprobe-candidate": return execFile("ffprobe-candidate", args, options, callback);
    case "ffprobe-candidate.exe": return execFile("ffprobe-candidate.exe", args, options, callback);
    case "ffmpeg-lkg": return execFile("ffmpeg-lkg", args, options, callback);
    case "ffmpeg-lkg.exe": return execFile("ffmpeg-lkg.exe", args, options, callback);
    case "ffprobe-lkg": return execFile("ffprobe-lkg", args, options, callback);
    case "ffprobe-lkg.exe": return execFile("ffprobe-lkg.exe", args, options, callback);
    case "mkvmerge": return execFile("mkvmerge", args, options, callback);
    case "mkvmerge.exe": return execFile("mkvmerge.exe", args, options, callback);
    case "mkvpropedit": return execFile("mkvpropedit", args, options, callback);
    case "mkvpropedit.exe": return execFile("mkvpropedit.exe", args, options, callback);
    case "deno": return execFile("deno", args, options, callback);
    case "deno.exe": return execFile("deno.exe", args, options, callback);
    case "vainfo": return execFile("vainfo", args, options, callback);
    case "vainfo.exe": return execFile("vainfo.exe", args, options, callback);
    case "tar": return execFile("tar", args, options, callback);
    case "tar.exe": return execFile("tar.exe", args, options, callback);
    case "bsdtar": return execFile("bsdtar", args, options, callback);
    case "bsdtar.exe": return execFile("bsdtar.exe", args, options, callback);
    case "7z": return execFile("7z", args, options, callback);
    case "7z.exe": return execFile("7z.exe", args, options, callback);
    case "7zr": return execFile("7zr", args, options, callback);
    case "7zr.exe": return execFile("7zr.exe", args, options, callback);
    case "7za": return execFile("7za", args, options, callback);
    case "7za.exe": return execFile("7za.exe", args, options, callback);
    case "xdg-open": return execFile("xdg-open", args, options, callback);
    case "gio": return execFile("gio", args, options, callback);
    case "open": return execFile("open", args, options, callback);
    case "explorer.exe": return execFile("explorer.exe", args, options, callback);
    case "taskkill.exe": return execFile("taskkill.exe", args, options, callback);
    case "taskkill": return execFile("taskkill", args, options, callback);
    case "reg.exe": return execFile("reg.exe", args, options, callback);
    case "reg": return execFile("reg", args, options, callback);
    case "update-desktop-database": return execFile("update-desktop-database", args, options, callback);
    case "powershell": return execFile("powershell", args, options, callback);
    case "powershell.exe": return execFile("powershell.exe", args, options, callback);
    case "pwsh": return execFile("pwsh", args, options, callback);
    case "pwsh.exe": return execFile("pwsh.exe", args, options, callback);
    case "unzip": return execFile("unzip", args, options, callback);
    case "unzip.exe": return execFile("unzip.exe", args, options, callback);
    default: throw new Error(`Executable token is not dispatchable: ${token}`);
  }
}

function spawnLiteral(token, args, options) {
  switch (token) {
    case "yt-dlp": return spawn("yt-dlp", args, options);
    case "yt-dlp.exe": return spawn("yt-dlp.exe", args, options);
    case "ffmpeg": return spawn("ffmpeg", args, options);
    case "ffmpeg.exe": return spawn("ffmpeg.exe", args, options);
    case "ffprobe": return spawn("ffprobe", args, options);
    case "ffprobe.exe": return spawn("ffprobe.exe", args, options);
    case "ffmpeg-candidate": return spawn("ffmpeg-candidate", args, options);
    case "ffmpeg-candidate.exe": return spawn("ffmpeg-candidate.exe", args, options);
    case "ffprobe-candidate": return spawn("ffprobe-candidate", args, options);
    case "ffprobe-candidate.exe": return spawn("ffprobe-candidate.exe", args, options);
    case "ffmpeg-lkg": return spawn("ffmpeg-lkg", args, options);
    case "ffmpeg-lkg.exe": return spawn("ffmpeg-lkg.exe", args, options);
    case "ffprobe-lkg": return spawn("ffprobe-lkg", args, options);
    case "ffprobe-lkg.exe": return spawn("ffprobe-lkg.exe", args, options);
    case "mkvmerge": return spawn("mkvmerge", args, options);
    case "mkvmerge.exe": return spawn("mkvmerge.exe", args, options);
    case "mkvpropedit": return spawn("mkvpropedit", args, options);
    case "mkvpropedit.exe": return spawn("mkvpropedit.exe", args, options);
    case "deno": return spawn("deno", args, options);
    case "deno.exe": return spawn("deno.exe", args, options);
    case "vainfo": return spawn("vainfo", args, options);
    case "vainfo.exe": return spawn("vainfo.exe", args, options);
    case "tar": return spawn("tar", args, options);
    case "tar.exe": return spawn("tar.exe", args, options);
    case "bsdtar": return spawn("bsdtar", args, options);
    case "bsdtar.exe": return spawn("bsdtar.exe", args, options);
    case "7z": return spawn("7z", args, options);
    case "7z.exe": return spawn("7z.exe", args, options);
    case "7zr": return spawn("7zr", args, options);
    case "7zr.exe": return spawn("7zr.exe", args, options);
    case "7za": return spawn("7za", args, options);
    case "7za.exe": return spawn("7za.exe", args, options);
    case "xdg-open": return spawn("xdg-open", args, options);
    case "gio": return spawn("gio", args, options);
    case "open": return spawn("open", args, options);
    case "explorer.exe": return spawn("explorer.exe", args, options);
    case "taskkill.exe": return spawn("taskkill.exe", args, options);
    case "taskkill": return spawn("taskkill", args, options);
    case "reg.exe": return spawn("reg.exe", args, options);
    case "reg": return spawn("reg", args, options);
    case "update-desktop-database": return spawn("update-desktop-database", args, options);
    case "powershell": return spawn("powershell", args, options);
    case "powershell.exe": return spawn("powershell.exe", args, options);
    case "pwsh": return spawn("pwsh", args, options);
    case "pwsh.exe": return spawn("pwsh.exe", args, options);
    case "unzip": return spawn("unzip", args, options);
    case "unzip.exe": return spawn("unzip.exe", args, options);
    default: throw new Error(`Executable token is not dispatchable: ${token}`);
  }
}

export function execMkvpropeditSafe(resolvedCommand, args = [], options = {}, callback) {
  const command = resolvedCommand || (process.platform === "win32" ? "mkvpropedit.exe" : "mkvpropedit");
  return execFileSafe(command, args, options, callback);
}

export function spawnSafe(command, args = [], options = {}) {
  const token = canonicalExecutableToken(command);
  const safeArgs = assertSafeProcessArgs(token, args);
  return spawnLiteral(token, safeArgs, buildExecOptions(command, options));
}

export function execFileSafe(command, args = [], options = {}, callback) {
  const token = canonicalExecutableToken(command);
  const safeArgs = assertSafeProcessArgs(token, args);
  if (typeof options === "function") {
    return execFileLiteral(token, safeArgs, buildExecOptions(command, {}), options);
  }
  return execFileLiteral(token, safeArgs, buildExecOptions(command, options), callback);
}

// Preserves Node execFile's native promisified { stdout, stderr } result shape.
execFileSafe[promisify.custom] = function execFileSafeAsync(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFileSafe(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
};
