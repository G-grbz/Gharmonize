import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import fetch from "node-fetch";
import { downloadYouTubeVideo } from "./yt.js";

const DEFAULT_UA =
  process.env.PLATFORM_DL_UA ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const FETCH_TIMEOUT_MS = Number(process.env.PLATFORM_DL_TIMEOUT_MS || 30000);
const YTDLP_FALLBACK_PLATFORMS = new Set([
  "vimeo",
  "tiktok",
  "instagram",
  "facebook",
  "twitter"
]);

// Handles with timeout in core application logic.
function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => {
    try {
      ctrl.abort();
    } catch {}
  }, ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t), controller: ctrl };
}

// Parses meta tag for core application logic.
function parseMetaTag(html, key) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const m = html.match(re);
  return m?.[1] || "";
}

// Handles decode escaped in core application logic.
function decodeEscaped(str) {
  if (!str) return "";
  return str
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u002F/g, "/")
    .replace(/\\\\\//g, "/")
    .replace(/\\\//g, "/")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "")
    .trim();
}

// Selects ext from URL for core application logic.
function pickExtFromUrl(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".mp4")) return "mp4";
    if (p.endsWith(".webm")) return "webm";
    if (p.endsWith(".m4a")) return "m4a";
    if (p.endsWith(".mp3")) return "mp3";
    if (p.endsWith(".mov")) return "mov";
    if (p.endsWith(".mkv")) return "mkv";
  } catch {}
  return "mp4";
}

// Selects ext from content type for core application logic.
function pickExtFromContentType(contentType, fallback = "mp4") {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("video/mp4")) return "mp4";
  if (ct.includes("video/webm")) return "webm";
  if (ct.includes("audio/mp4")) return "m4a";
  if (ct.includes("audio/mpeg")) return "mp3";
  if (ct.includes("video/quicktime")) return "mov";
  return fallback;
}

// Extracts vimeo progressive from html for core application logic.
function extractVimeoProgressiveFromHtml(html) {
  const urls = new Set();
  // Handles push if http in core application logic.
  const pushIfHttp = (u) => {
    const v = decodeEscaped(String(u || ""));
    if (/^https?:\/\//i.test(v)) urls.add(v);
  };

  const m3 = html.matchAll(/"url":"(https?:\\\/\\\/[^"]+\.mp4[^"]*)"/gi);
  for (const m of m3) pushIfHttp(m[1]);

  const m2 = html.matchAll(/https?:\/\/[^"'<\s]+\.mp4[^"'<\s]*/gi);
  for (const m of m2) pushIfHttp(m[0]);

  return Array.from(urls);
}

// Handles detect platform in core application logic.
export function detectPlatform(inputUrl) {
  try {
    const host = new URL(inputUrl).hostname.toLowerCase();
    if (host.includes("vimeo.com")) return "vimeo";
    if (host.includes("tiktok.com")) return "tiktok";
    if (host.includes("instagram.com") || host.includes("instagr.am")) return "instagram";
    if (host.includes("facebook.com") || host === "fb.watch" || host.endsWith(".fb.watch")) {
      return "facebook";
    }
    if (
      host.includes("twitter.com") ||
      host === "x.com" ||
      host.endsWith(".x.com")
    ) {
      return "twitter";
    }
    return null;
  } catch {
    return null;
  }
}

// Checks whether supported platform URL is valid for core application logic.
export function isSupportedPlatformUrl(inputUrl) {
  return !!detectPlatform(inputUrl);
}

// Loads text for core application logic.
async function fetchText(url, headers = {}) {
  const t = withTimeout(FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: {
        "user-agent": DEFAULT_UA,
        accept:
          "text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8",
        ...headers
      },
      signal: t.signal,
      redirect: "follow"
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} for ${url}`);
    }
    return await resp.text();
  } finally {
    t.clear();
  }
}

// Resolves vimeo for core application logic.
async function resolveVimeo(inputUrl) {
  const u = new URL(inputUrl);
  const m = u.pathname.match(/(?:\/video\/|\/)(\d+)(?:$|[/?#])/);
  const id = m?.[1];
  if (!id) {
    throw new Error("Unsupported Vimeo URL");
  }

  // Handles to result in core application logic.
  const toResult = (cfg) => {
    const progressive = Array.isArray(cfg?.request?.files?.progressive)
      ? cfg.request.files.progressive
      : [];
    progressive.sort((a, b) => Number(b?.height || 0) - Number(a?.height || 0));
    const best = progressive.find((x) => x?.url);
    if (!best?.url) return null;

    return {
      mediaUrl: best.url,
      extHint: pickExtFromUrl(best.url),
      metadata: {
        title: cfg?.video?.title || "",
        uploader: cfg?.video?.owner?.name || "",
        artist: cfg?.video?.owner?.name || "",
        webpage_url: inputUrl,
        thumbnail:
          cfg?.video?.thumbs?.base ||
          cfg?.video?.thumbs?.["640"] ||
          cfg?.video?.thumbs?.["960"] ||
          "",
        duration: cfg?.video?.duration || null
      }
    };
  };

  // Loads vimeo config for core application logic.
  const fetchVimeoConfig = async (configUrl) => {
    const playerRef = `https://player.vimeo.com/video/${id}`;
    const attemptHeaders = [
      {
        referer: inputUrl,
        origin: "https://vimeo.com"
      },
      {
        referer: playerRef,
        origin: "https://player.vimeo.com"
      },
      {
        referer: playerRef
      }
    ];
    let lastErr = null;

    for (const extraHeaders of attemptHeaders) {
      const t = withTimeout(FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(configUrl, {
          headers: {
            "user-agent": DEFAULT_UA,
            accept: "application/json,text/plain,*/*",
            ...extraHeaders
          },
          signal: t.signal,
          redirect: "follow"
        });
        if (!resp.ok) {
          lastErr = new Error(`Vimeo config HTTP ${resp.status}`);
          continue;
        }
        return await resp.json();
      } catch (e) {
        lastErr = e;
      } finally {
        t.clear();
      }
    }

    throw lastErr || new Error("Vimeo config fetch failed");
  };

  const configCandidates = new Set([`https://player.vimeo.com/video/${id}/config`]);
  const progressiveCandidates = new Set();
  const scrapedMeta = {
    title: "",
    thumbnail: ""
  };
  const attemptErrors = [];

  try {
    const html = await fetchText(inputUrl, {
      referer: "https://vimeo.com/",
      origin: "https://vimeo.com"
    });

    const mConfig = html.match(/"config_url":"([^"]+)"/i);
    if (mConfig?.[1]) {
      configCandidates.add(decodeEscaped(mConfig[1]));
    }

    const all = html.match(/https:\/\/player\.vimeo\.com\/video\/\d+\/config[^"'\\\s<]*/gi) || [];
    for (const raw of all) configCandidates.add(decodeEscaped(raw));
    for (const raw of extractVimeoProgressiveFromHtml(html)) {
      progressiveCandidates.add(raw);
    }
    scrapedMeta.title = parseMetaTag(html, "og:title") || "";
    scrapedMeta.thumbnail = parseMetaTag(html, "og:image") || "";
  } catch (e) {
    attemptErrors.push(`html:${e?.message || e}`);
  }

  try {
    const playerHtml = await fetchText(`https://player.vimeo.com/video/${id}`, {
      referer: inputUrl,
      origin: "https://player.vimeo.com"
    });
    const mCfgPlayer = playerHtml.match(/"config_url":"([^"]+)"/i);
    if (mCfgPlayer?.[1]) {
      configCandidates.add(decodeEscaped(mCfgPlayer[1]));
    }
    for (const raw of extractVimeoProgressiveFromHtml(playerHtml)) {
      progressiveCandidates.add(raw);
    }
  } catch (e) {
    attemptErrors.push(`player-html:${e?.message || e}`);
  }

  for (const cfgUrl of configCandidates) {
    try {
      const cfg = await fetchVimeoConfig(cfgUrl);
      const out = toResult(cfg);
      if (out) return out;
      attemptErrors.push(`config:${cfgUrl}:no-progressive`);
    } catch (e) {
      attemptErrors.push(`config:${cfgUrl}:${e?.message || e}`);
    }
  }

  if (progressiveCandidates.size > 0) {
    const bestUrl = Array.from(progressiveCandidates)
      .sort((a, b) => b.length - a.length)[0];
    return {
      mediaUrl: bestUrl,
      extHint: pickExtFromUrl(bestUrl),
      metadata: {
        title: scrapedMeta.title || "",
        uploader: "",
        artist: "",
        webpage_url: inputUrl,
        thumbnail: scrapedMeta.thumbnail || "",
        duration: null
      }
    };
  }

  throw new Error(`Vimeo media could not be resolved (${attemptErrors.join(" | ")})`);
}

// Extracts tik tok media URLs for core application logic.
function extractTikTokMediaUrls(html) {
  const urls = new Set();

  const patterns = [
    /"(?:downloadAddr|playAddr|download_url|play_url)":"([^"]+)"/gi
  ];

  // Handles push if http for core application logic.
  const pushIfHttp = (raw) => {
    const v = decodeEscaped(String(raw || ""));
    if (/^https?:\/\//i.test(v)) {
      urls.add(v);
    }
  };

  for (const re of patterns) {
    const all = html.matchAll(re);
    for (const m of all) {
      if (m?.[1]) pushIfHttp(m[1]);
    }
  }

  // Some pages expose escaped raw CDN urls outside JSON keys.
  const rawEscapedUrls =
    html.match(/https?:\\\/\\\/[^"'\\\s]+(?:video\/tos\/[^"'\\\s]*)?/gi) || [];
  for (const raw of rawEscapedUrls) {
    pushIfHttp(raw);
  }

  return Array.from(urls);
}

// Resolves tik tok for core application logic.
async function resolveTikTok(inputUrl) {
  const html = await fetchText(inputUrl, {
    referer: "https://www.tiktok.com/"
  });

  const mediaUrls = extractTikTokMediaUrls(html);
  if (!mediaUrls.length) {
    throw new Error("TikTok media URL could not be extracted");
  }
  const mediaUrl = mediaUrls[0];

  const title = parseMetaTag(html, "og:title") || parseMetaTag(html, "twitter:title");
  const image = parseMetaTag(html, "og:image") || parseMetaTag(html, "twitter:image");

  return {
    mediaUrl,
    mediaUrls,
    extHint: pickExtFromUrl(mediaUrl),
    metadata: {
      title: title || "TikTok",
      track: title || "TikTok",
      uploader: "",
      artist: "",
      webpage_url: inputUrl,
      thumbnail: image || ""
    }
  };
}

// Builds media request header attempts for platform direct download.
function buildMediaRequestHeaders(platformName, inputUrl) {
  const base = {
    "user-agent": DEFAULT_UA,
    accept: "*/*"
  };

  if (platformName === "tiktok") {
    return [
      {
        ...base,
        referer: inputUrl
      },
      {
        ...base,
        referer: "https://www.tiktok.com/",
        origin: "https://www.tiktok.com"
      },
      {
        ...base,
        referer: "https://www.tiktok.com/"
      }
    ];
  }

  return [
    {
      ...base,
      referer: inputUrl
    }
  ];
}

// Resolves platform media for core application logic.
export async function resolvePlatformMedia(inputUrl) {
  const platform = detectPlatform(inputUrl);
  if (!platform) {
    throw new Error("Unsupported platform URL");
  }

  if (platform === "vimeo") {
    const v = await resolveVimeo(inputUrl);
    return { platform, ...v };
  }
  if (platform === "tiktok") {
    const t = await resolveTikTok(inputUrl);
    return { platform, ...t };
  }

  throw new Error("Unsupported platform");
}

// Downloads platform media for core application logic.
export async function downloadPlatformMedia(
  inputUrl,
  jobId,
  tempDir,
  progressCallback = null,
  opts = {},
  ctrl = {}
) {
  fs.mkdirSync(tempDir, { recursive: true });
  const platform = detectPlatform(inputUrl);
  const fallbackViaYtDlp = async (
    platformName,
    baseMetadata = null,
    rootError = null
  ) => {
    try {
      const fallbackPath = await downloadYouTubeVideo(
        inputUrl,
        jobId,
        false,
        null,
        false,
        null,
        tempDir,
        (progress) => {
          if (typeof progressCallback === "function") progressCallback(progress);
        },
        {
          video: opts?.video === true,
          maxHeight:
            Number.isFinite(Number(opts?.maxHeight))
              ? Number(opts.maxHeight)
              : undefined,
          preferTitleTemplate: true,
          forceCookies: true,
          requestHeaders:
            platformName === "vimeo"
              ? { Referer: inputUrl, Origin: "https://vimeo.com" }
              : platformName === "tiktok"
                ? { Referer: inputUrl, Origin: "https://www.tiktok.com" }
                : platformName === "instagram"
                  ? { Referer: inputUrl, Origin: "https://www.instagram.com" }
                  : platformName === "facebook"
                    ? { Referer: inputUrl, Origin: "https://www.facebook.com" }
                    : platformName === "twitter"
                      ? { Referer: inputUrl, Origin: "https://x.com" }
                : { Referer: inputUrl }
        },
        ctrl
      );

      return {
        filePath: fallbackPath,
        platform: platformName,
        metadata: {
          title: baseMetadata?.title || "",
          uploader: baseMetadata?.uploader || "",
          artist: baseMetadata?.artist || "",
          webpage_url: baseMetadata?.webpage_url || inputUrl,
          thumbnail: baseMetadata?.thumbnail || "",
          duration:
            typeof baseMetadata?.duration === "number"
              ? baseMetadata.duration
              : null
        }
      };
    } catch (fallbackErr) {
      const rootMsg = rootError?.message || "unknown platform resolve/download error";
      const fbMsg = fallbackErr?.message || "unknown yt-dlp fallback error";
      const needsLogin =
        platformName === "vimeo" &&
        /logged-?in|cookies-from-browser|--cookies|account credentials/i.test(
          String(fbMsg)
        );
      const loginHint = needsLogin
        ? " Vimeo requires account cookies. Set YTDLP_COOKIES_FROM_BROWSER or YTDLP_COOKIES and keep YT_UI_FORCE_COOKIES=1."
        : "";
      throw new Error(
        `${platformName} media could not be resolved (${rootMsg}); yt-dlp fallback failed (${fbMsg})${loginHint}`
      );
    }
  };

  let resolved = null;
  let resolveError = null;
  try {
    resolved = await resolvePlatformMedia(inputUrl);
  } catch (e) {
    resolveError = e;
  }

  if (!resolved && YTDLP_FALLBACK_PLATFORMS.has(platform)) {
    return fallbackViaYtDlp(platform, null, resolveError);
  }

  if (!resolved) {
    throw resolveError || new Error("Platform media could not be resolved");
  }

  const t = withTimeout(FETCH_TIMEOUT_MS * 2);
  const ac = t.controller;
  try {
    const mediaCandidates = Array.from(
      new Set(
        [
          resolved.mediaUrl,
          ...(Array.isArray(resolved.mediaUrls) ? resolved.mediaUrls : [])
        ]
          .map((u) => String(u || "").trim())
          .filter((u) => /^https?:\/\//i.test(u))
      )
    );
    if (!mediaCandidates.length) {
      throw new Error("Resolved media URL is empty");
    }

    const headerAttempts = buildMediaRequestHeaders(
      resolved.platform || platform,
      inputUrl
    );

    let resp = null;
    let usedMediaUrl = mediaCandidates[0];
    let lastDownloadErr = null;

    for (const mediaUrl of mediaCandidates) {
      usedMediaUrl = mediaUrl;
      for (const headers of headerAttempts) {
        if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
          throw new Error("CANCELED");
        }
        try {
          const attemptResp = await fetch(mediaUrl, {
            headers,
            signal: t.signal,
            redirect: "follow"
          });
          if (attemptResp.ok && attemptResp.body) {
            resp = attemptResp;
            break;
          }
          lastDownloadErr = new Error(`Media download failed: HTTP ${attemptResp.status}`);
          try {
            attemptResp.body?.destroy?.();
          } catch {}
        } catch (e) {
          lastDownloadErr = e;
          if (String(e?.name || "").toLowerCase() === "aborterror") break;
        }
      }
      if (resp) break;
    }

    if (!resp) {
      const downloadErr =
        lastDownloadErr || new Error("Media download failed: unknown error");
      if (YTDLP_FALLBACK_PLATFORMS.has(resolved.platform)) {
        return fallbackViaYtDlp(resolved.platform, resolved.metadata, downloadErr);
      }
      throw downloadErr;
    }

    const extFallback = usedMediaUrl
      ? pickExtFromUrl(usedMediaUrl)
      : (resolved.extHint || "mp4");
    const ext = pickExtFromContentType(
      resp.headers.get("content-type"),
      extFallback
    );
    const outputPath = path.join(tempDir, `${jobId}.${ext}`);
    const total = Number(resp.headers.get("content-length") || 0) || 0;
    let done = 0;

    const out = fs.createWriteStream(outputPath);
    resp.body.on("data", (chunk) => {
      done += chunk?.length || 0;
      if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
        try {
          ac.abort();
        } catch {}
      }
      if (progressCallback && total > 0) {
        const pct = Math.max(0, Math.min(100, (done / total) * 100));
        progressCallback(pct);
      }
    });

    await pipeline(resp.body, out);

    if (typeof ctrl?.isCanceled === "function" && ctrl.isCanceled()) {
      throw new Error("CANCELED");
    }

    if (progressCallback) progressCallback(100);
    return {
      filePath: outputPath,
      platform: resolved.platform,
      metadata: resolved.metadata
    };
  } catch (e) {
    if (String(e?.name || "").toLowerCase() === "aborterror") {
      throw new Error("CANCELED");
    }
    throw e;
  } finally {
    t.clear();
  }
}
