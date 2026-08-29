import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const CONTROL_CHARS = /[\u0000\r\n\u2028\u2029]/;
const DEFAULT_ALLOWED_EXECUTABLES = new Set([
  "yt-dlp", "yt-dlp.exe",
  "ffmpeg", "ffmpeg.exe",
  "ffprobe", "ffprobe.exe",
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
  "--plugin-dirs",
  "--cookies-from-browser",
  "--ffmpeg-location"
];

function assertPlainProcessString(value, label, maxLength, { allowEmpty = true } = {}) {
  const text = String(value ?? "");
  if ((!allowEmpty && !text) || text.length > maxLength || CONTROL_CHARS.test(text)) {
    throw new Error(`Unsafe ${label}`);
  }
  return text;
}

export function assertTrustedExecutable(command) {
  const text = assertPlainProcessString(command, "executable path", 4096, { allowEmpty: false });
  const base = path.basename(text).toLowerCase();
  const managedName =
    /^yt-dlp(?:-|\.exe$)/.test(base) ||
    /^ffmpeg(?:-|\.exe$)/.test(base) ||
    /^ffprobe(?:-|\.exe$)/.test(base) ||
    /^deno(?:-v|\.exe$)/.test(base);
  if (
    !DEFAULT_ALLOWED_EXECUTABLES.has(base) &&
    !managedName &&
    process.env.GHARMONIZE_ALLOW_CUSTOM_BINARIES !== "1"
  ) {
    throw new Error(`Executable is not in the Gharmonize allowlist: ${base}`);
  }
  return text;
}

// Treats a blank settings override as "use the managed/default executable"
// while keeping process execution itself strict and non-empty.
export function normalizeTrustedExecutableSetting(value) {
  const text = String(value ?? "").trim();
  return text ? assertTrustedExecutable(text) : "";
}

export function assertSafeProcessArgs(command, args = []) {
  if (!Array.isArray(args)) throw new Error("Process arguments must be an array");
  const executable = path.basename(String(command || "")).toLowerCase();
  const safe = args.map((arg) => assertPlainProcessString(arg, "process argument", 64 * 1024));

  if (executable === "yt-dlp" || executable === "yt-dlp.exe") {
    for (const arg of safe) {
      const lower = arg.toLowerCase();
      if (YTDLP_DANGEROUS_FLAGS.some((flag) => lower === flag || lower.startsWith(`${flag}=`))) {
        if (process.env.GHARMONIZE_ALLOW_UNSAFE_YTDLP_ARGS !== "1") {
          throw new Error(`Unsafe yt-dlp option is blocked: ${arg}`);
        }
      }
    }
  }

  return safe;
}


function buildFixedToolExecOptions(resolvedCommand, expectedBase, options = {}) {
  const trustedPath = assertTrustedExecutable(resolvedCommand || expectedBase);
  const actualBase = path.basename(trustedPath).toLowerCase();
  const requiredBase = String(expectedBase).toLowerCase();
  if (actualBase !== requiredBase) {
    throw new Error(`Unexpected executable name for ${requiredBase}: ${actualBase}`);
  }

  const supplied = options && typeof options === "object" ? options : {};
  const env = {
    ...process.env,
    ...(supplied.env || {})
  };

  // When Gharmonize resolved an explicit managed/packaged/custom path, expose
  // only its directory through PATH while keeping the actual child-process
  // command name fixed. This prevents remote/configured path text from ever
  // becoming the command argument passed to execFile().
  const dir = path.dirname(trustedPath);
  if (path.isAbsolute(trustedPath) || dir !== ".") {
    const resolvedDir = path.resolve(dir);
    env.PATH = [resolvedDir, env.PATH || ""].filter(Boolean).join(path.delimiter);
  }

  return {
    ...supplied,
    env,
    shell: false
  };
}

// Executes mkvpropedit using a fixed command token. The resolved path is used
// only to select a trusted PATH directory; it never reaches execFile's command
// argument, which keeps the process sink independent from remote release data.
export function execMkvpropeditSafe(resolvedCommand, args = [], options = {}, callback) {
  const command = process.platform === "win32" ? "mkvpropedit.exe" : "mkvpropedit";
  const safeArgs = assertSafeProcessArgs(command, args);

  if (typeof options === "function") {
    const execOptions = buildFixedToolExecOptions(resolvedCommand, command, {});
    return execFile(command, safeArgs, execOptions, options);
  }

  const execOptions = buildFixedToolExecOptions(resolvedCommand, command, options);
  return execFile(command, safeArgs, execOptions, callback);
}

export function spawnSafe(command, args = [], options = {}) {
  const executable = assertTrustedExecutable(command);
  const safeArgs = assertSafeProcessArgs(executable, args);
  // Trusted executable allowlist, argument validation, and shell:false are enforced above.
  return spawn(executable, safeArgs, {
    ...options,
    shell: false
  });
}

export function execFileSafe(command, args = [], options = {}, callback) {
  const executable = assertTrustedExecutable(command);
  const safeArgs = assertSafeProcessArgs(executable, args);
  if (typeof options === "function") {
    // Trusted executable allowlist, argument validation, and shell:false are enforced above.
    return execFile(executable, safeArgs, { shell: false }, options);
  }
  // Trusted executable allowlist, argument validation, and shell:false are enforced above.
  return execFile(executable, safeArgs, { ...options, shell: false }, callback);
}

// Preserves Node execFile's native promisified { stdout, stderr } result shape.
// Without this custom hook, promisify(execFileSafe) resolves only stdout because
// execFileSafe is a wrapper, causing callers that destructure stdout/stderr to
// see undefined values and report valid tool versions as "unknown".
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
