import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { DENO_BIN } from "./binaries.js";

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

// Normalizes title for core application logic.
export function normalizeTitle(rawTitle, artist) {
  if (!rawTitle) return rawTitle;
  const a = String(artist || "").trim();
  let title = String(rawTitle).trim();
  if (!a) return title;

  const escaped = escapeRegExp(a);
  const re = new RegExp(`^(?:${escaped}\\s*[-_–]+\\s*)+`, "i");
  title = title.replace(re, "").trim();

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
  if (ui && process.env.YT_UI_FORCE_COOKIES === "1") {
    const cookieBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
    const cookieFile = process.env.YTDLP_COOKIES;

    if (cookieBrowser) {
      args.push("--cookies-from-browser", cookieBrowser);
    } else if (cookieFile) {
      args.push("--cookies", cookieFile);
    }
    return args;
  }

  const stripEnv = process.env.YT_STRIP_COOKIES;
  if (stripEnv === "1") return args;

  const cookieBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
  const cookieFile = process.env.YTDLP_COOKIES;

  if (cookieBrowser) {
    args.push("--cookies-from-browser", cookieBrowser);
  } else if (cookieFile) {
    args.push("--cookies", cookieFile);
  }

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
