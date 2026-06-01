import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DENO_BIN } from "./binaries.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const TEMP_COOKIE_DIR = path.resolve(BASE_DIR, "temp", "yt-dlp-cookies");

export const ERR = {
  INVALID_FORMAT: 'INVALID_FORMAT',
  URL_OR_FILE_REQUIRED: 'URL_OR_FILE_REQUIRED',
  UNSUPPORTED_URL_FORMAT: 'UNSUPPORTED_URL_FORMAT',
  PREVIEW_NEED_YT_URL: 'PREVIEW_NEED_YT_URL',
  PLAYLIST_REQUIRED: 'PLAYLIST_REQUIRED',
  PREVIEW_FAILED: 'PREVIEW_FAILED',
  PAGE_FETCH_FAILED: 'PAGE_FETCH_FAILED',
  JOB_NOT_FOUND: 'JOB_NOT_FOUND',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  YTDLP_NOT_FOUND: 'YTDLP_NOT_FOUND',
  INTERNAL: 'INTERNAL'
};

// Parses id from path for core application logic.
export function parseIdFromPath(filePath) {
  const base = path.basename(String(filePath || ""));
  const noExt = base.replace(/\.[A-Za-z0-9]+$/i, "");
  if (!noExt) return null;

  // Selected-id downloads are saved as "<videoId>.<ext>" and IDs can start with "2-...".
  // Only treat a numeric prefix as playlist index when it is the explicit "N - " form.
  if (/^[A-Za-z0-9_-]{6,}$/.test(noExt)) return noExt;

  const withLegacyPrefix = noExt.match(/^\d+\s*-\s+([A-Za-z0-9_-]{6,})$/);
  return withLegacyPrefix ? withLegacyPrefix[1] : null;
}

// Handles escape reg exp in core application logic.
export function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TITLE_FOLD_MAP = Object.freeze({
  I: "i",
  İ: "i",
  ı: "i",
  Ş: "s",
  ş: "s",
  Ğ: "g",
  ğ: "g",
  Ü: "u",
  ü: "u",
  Ö: "o",
  ö: "o",
  Ç: "c",
  ç: "c",
  ß: "ss",
  Æ: "ae",
  æ: "ae",
  Œ: "oe",
  œ: "oe",
});

// Handles normalize loose compare text in core application logic.
function normalizeLooseCompareText(s = "") {
  return String(s)
    .replace(/[IİıŞşĞğÜüÖöÇçßÆæŒœ]/g, (ch) => TITLE_FOLD_MAP[ch] || ch)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Normalizes title for core application logic.
export function normalizeTitle(rawTitle, artist) {
  if (!rawTitle) return rawTitle;
  const a = String(artist || "").trim();
  let title = String(rawTitle).trim();
  if (!a) return title;

  const escaped = escapeRegExp(a);
  const re = new RegExp(`^(?:${escaped}\\s*[-_–]+\\s*)+`, "i");
  const exactTrimmed = title.replace(re, "").trim();
  if (exactTrimmed !== title) return exactTrimmed;

  const parts = title.match(/^\s*(.+?)\s*[-_–—]+\s*(.+)\s*$/);
  if (!parts) return title;
  const left = parts[1].trim();
  const right = parts[2].trim();
  if (!left || !right) return title;

  if (normalizeLooseCompareText(left) === normalizeLooseCompareText(a)) {
    return right;
  }

  return title;
}

// Sends ok in core application logic.
export function sendOk(res, payload = {}, status = 200) {
  return res.status(status).json({ ok: true, ...payload });
}

// Sends error in core application logic.
export function sendError(res, code, message, status = 400, extra = {}) {
  return res.status(status).json({ ok: false, error: { code, message, ...extra } });
}

// Checks whether executable is valid for core application logic.
export function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// Finds on path for core application logic.
export function findOnPATH(name) {
  const paths = (process.env.PATH || "").split(path.delimiter);
  for (const p of paths) {
    const candidate = path.join(p, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export const toNFC = (s) => (typeof s === "string" ? s.normalize("NFC") : s);

// Handles sanitize filename in core application logic.
export function sanitizeFilename(name, replacement = "_") {
  const n = toNFC(name);
  const cleaned = n
    .replace(/\s*\u2022+\s*/g, " - ")
    .replace(/\s+&\s+/g, ", ")
    .replace(/[\/\\?%*:|"<>]/g, replacement)
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 200);
}

export const isDirectMediaUrl = (url) => /(\.(mp4|avi|mov|mkv|webm|mp3|wav|flac|aac|ogg|m4a))$/i.test(url);

// Handles make t in core application logic.
export function makeT(req) {
  // Handles fallback in core application logic.
  const fallback = (key, vars={}) => {
    let s = String(key);
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return s;
  };
  if (req && typeof req.t === 'function') return req.t;
  return fallback;
}

// Handles unique id in core application logic.
export function uniqueId(prefix) {
  try {
    const id = randomUUID();
    return prefix ? `${prefix}_${id}` : id;
  } catch {
    const fallback = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return prefix ? `${prefix}_${fallback}` : fallback;
  }
}

// Handles add cookie args in core application logic.
export function addCookieArgs(args, { ui = false } = {}) {
  const hasCookieFile = (cookieFile) => {
    const filePath = String(cookieFile || "").trim();
    if (!filePath) return false;
    try {
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  };

  const pruneTempCookieCopies = () => {
    try {
      const entries = fs
        .readdirSync(TEMP_COOKIE_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^cookies-.*\.txt$/i.test(entry.name))
        .map((entry) => {
          const abs = path.join(TEMP_COOKIE_DIR, entry.name);
          let mtimeMs = 0;
          try {
            mtimeMs = fs.statSync(abs).mtimeMs || 0;
          } catch {}
          return { abs, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      const maxKeep = 20;
      const maxAgeMs = 12 * 60 * 60 * 1000;
      const now = Date.now();

      entries.forEach((entry, index) => {
        if (index < maxKeep && now - entry.mtimeMs < maxAgeMs) return;
        try { fs.unlinkSync(entry.abs); } catch {}
      });
    } catch {}
  };

  const prepareCookieFile = (cookieFile) => {
    const filePath = String(cookieFile || "").trim();
    if (!hasCookieFile(filePath)) return "";

    try {
      fs.mkdirSync(TEMP_COOKIE_DIR, { recursive: true });
      pruneTempCookieCopies();
      const snapshotPath = path.join(
        TEMP_COOKIE_DIR,
        `cookies-${Date.now()}-${randomUUID()}.txt`
      );
      fs.copyFileSync(filePath, snapshotPath);
      return snapshotPath;
    } catch (err) {
      console.warn("[cookies] Temp cookie snapshot failed, using source file:", err?.message || err);
      return filePath;
    }
  };

  const pushPreferredCookieSource = () => {
    const cookieBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
    const cookieFile = process.env.YTDLP_COOKIES;

    // Use a throwaway snapshot so yt-dlp can normalize/update the jar without
    // mutating the user-managed source cookie file.
    if (hasCookieFile(cookieFile)) {
      args.push("--cookies", prepareCookieFile(cookieFile));
    } else if (cookieBrowser) {
      args.push("--cookies-from-browser", cookieBrowser);
    }
  };

  if (ui && process.env.YT_UI_FORCE_COOKIES === "1") {
    pushPreferredCookieSource();
    return args;
  }

  const stripEnv = process.env.YT_STRIP_COOKIES;
  if (stripEnv === "1") return args;

  pushPreferredCookieSource();

  return args;
}

// Returns js runtime args used for core application logic.
export function getJsRuntimeArgs() {
  const envVal = (process.env.YTDLP_JS_RUNTIME || "").trim();
  if (envVal) {
    return ["--js-runtimes", envVal];
  }
  try {
    if (DENO_BIN && fs.existsSync(DENO_BIN) && path.isAbsolute(DENO_BIN)) {
      return ["--js-runtimes", `deno:${DENO_BIN}`];
    }
  } catch {}
  return [];
}
