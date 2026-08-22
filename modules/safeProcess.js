import { execFile, spawn } from "node:child_process";
import path from "node:path";

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
