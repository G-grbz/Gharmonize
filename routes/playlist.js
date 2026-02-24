import express from "express";
import { sendOk, sendError } from "../modules/utils.js";
import { getCache, setCache } from "../modules/cache.js";
import {
  isYouTubeUrl,
  isDailymotionUrl,
  isYouTubePlaylist,
  isDailymotionPlaylist,
  isYouTubeAutomix,
  normalizeYouTubeUrl,
  extractPlaylistAllFlat,
  extractPlaylistPage,
  getPlaylistMetaLite,
  extractAutomixAllFlat,
  extractAutomixPage
} from "../modules/yt.js";
import { isSpotifyUrl, resolveSpotifyUrl } from "../modules/spotify.js";
import { searchYtmBestId } from "../modules/sp.js";
import { resolveMarket } from "../modules/market.js";

const router = express.Router();

router.post("/api/playlist/preview", async (req, res) => {
  try {
    const { url, page = 1, pageSize = 25 } = req.body || {};

    if (url && isSpotifyUrl(url)) {
      try {
        const sp = await resolveSpotifyUrl(url, { market: resolveMarket(req.body?.market) });
        const ps = Math.max(1, Math.min(100, Number(pageSize) || 25));
        const p  = Math.max(1, Number(page) || 1);
        const start = (p - 1) * ps; const slice = (sp.items || []).slice(start, start + ps);
        const items = [];
        for (let i=0; i<slice.length; i++) {
          const it = slice[i]; let vid = null; try { vid = await searchYtmBestId(it.artist, it.title); } catch {}
          items.push({ index: start + i + 1, id: vid || null, title: it.title, uploader: it.artist, duration: null, duration_string: null, webpage_url: vid ? (process.env.YT_USE_MUSIC !== "0" ? `https://music.youtube.com/watch?v=${vid}` : `https://www.youtube.com/watch?v=${vid}`) : "", thumbnail: null });
        }
        return sendOk(res, { playlist: { title: sp.title || (sp.kind === "track" ? "Spotify Track" : "Spotify Playlist"), count: (sp.items || []).length, isAutomix: false, isSpotify: true }, page: p, pageSize: ps, items });
      } catch (e) { return sendError(res, 'PREVIEW_FAILED', e.message || "Spotify önizleme hatası", 400); }
    }

    const isYouTubeSource = isYouTubeUrl(url);
    const isDailymotionSource = !isYouTubeSource && isDailymotionUrl(url);
    if (!url || (!isYouTubeSource && !isDailymotionSource)) {
      return sendError(res, 'PREVIEW_NEED_YT_URL', "A valid YouTube or Dailymotion URL is required", 400);
    }

    const keyUrl = isYouTubeSource ? normalizeYouTubeUrl(url) : String(url).trim();
    const isAutomix = isYouTubeSource && isYouTubeAutomix(keyUrl);
    const ps = Math.max(1, Math.min(100, Number(pageSize) || (isAutomix ? 50 : 25)));
    const p  = Math.max(1, Number(page) || 1);

    if (isAutomix) {
    console.log("[AUTOMIX] preview request", {
    url: keyUrl,
    page: p,
    pageSize: ps
  });

  let cached = getCache(keyUrl);

  if (!cached) {
    console.log("[AUTOMIX] no cache, calling extractAutomixAllFlat...");
    try {
      const t0 = Date.now();
      const all = await extractAutomixAllFlat(keyUrl);
      const entries = Array.isArray(all.items) ? all.items : [];

      const effectiveCount =
        entries.length > 0
          ? Math.min(all.count || entries.length, entries.length)
          : (all.count || 0);

      cached = {
        title: all.title,
        count: effectiveCount,
        isAutomix: true,
        entries,
        paged: false
      };

      console.log("[AUTOMIX] extractAutomixAllFlat done", {
        ms: Date.now() - t0,
        allCount: all.count,
        entriesLen: entries.length,
        effectiveCount
      });

      setCache(keyUrl, cached);
    } catch (e) {
      console.error("[AUTOMIX] extractAutomixAllFlat FAILED:", e?.message || e);

      const meta = await getPlaylistMetaLite(keyUrl);
      const total = meta.count || 50;
      const start = (p - 1) * ps + 1;
      const end   = Math.min(p * ps, total);
      const pageData = await extractAutomixPage(keyUrl, start, end);

      if (pageData) {
        setCache(keyUrl, {
          title: pageData.title || meta.title || "YouTube Automix",
          count: total,
          isAutomix: true,
          entries: [],
          paged: true
        });

        console.log("[AUTOMIX] fallback extractAutomixPage ok (paged mode init)", {
          total,
          itemsLen: pageData.items?.length || 0
        });

        return sendOk(res, {
          playlist: {
            title: pageData.title || meta.title || "YouTube Automix",
            count: total,
            isAutomix: true
          },
          page: p,
          pageSize: ps,
          items: pageData.items || []
        });
      }

      console.warn("[AUTOMIX] fallback pageData empty (paged init)");
      return sendOk(res, {
        playlist: {
          title: meta.title || "YouTube Automix",
          count: total,
          isAutomix: true
        },
        page: p,
        pageSize: ps,
        items: []
      });
    }
    cached = getCache(keyUrl) || cached;
  }

    if (cached?.paged) {
      try {
        const total = cached.count || 50;
        const start = (p - 1) * ps + 1;
        const end   = Math.min(p * ps, total);
        const pageData = await extractAutomixPage(keyUrl, start, end);

        console.log("[AUTOMIX] paged mode serve page", {
          page: p,
          pageSize: ps,
          total,
          start,
          end,
          itemsLen: pageData?.items?.length || 0
        });

        return sendOk(res, {
          playlist: {
            title: pageData?.title || cached.title || "YouTube Automix",
            count: total,
            isAutomix: true
          },
          page: p,
          pageSize: ps,
          items: pageData?.items || []
        });
      } catch (err) {
        console.error("[AUTOMIX] paged mode error:", err);
        return sendError(res, 'PREVIEW_FAILED', err.message || "Automix preview failed", 500);
      }
    }

    const entries = Array.isArray(cached.entries) ? cached.entries : [];
    const total   = cached.count ?? entries.length;

    const startIdx = (p - 1) * ps;
    const endIdx   = Math.min(p * ps, entries.length);
    const slice    = startIdx < entries.length ? entries.slice(startIdx, endIdx) : [];

    console.log("[AUTOMIX] serve page (flat mode)", {
      page: p,
      pageSize: ps,
      total,
      entriesLen: entries.length,
      startIdx,
      endIdx,
      sliceLen: slice.length
    });

    return sendOk(res, {
      playlist: {
        title: cached.title,
        count: total,
        isAutomix: true
      },
      page: p,
      pageSize: ps,
      items: slice
    });
  }

    if (!isYouTubePlaylist(keyUrl) && !isDailymotionPlaylist(keyUrl)) {
      return sendError(res, 'PLAYLIST_REQUIRED', "This URL is not a playlist", 400);
    }

    let cached = getCache(keyUrl);
    if (!cached) {
      try {
        const all = await extractPlaylistAllFlat(keyUrl);
        if (!all.count) {
          return sendError(res, 'PREVIEW_FAILED', "Playlist is empty or could not be read", 404);
        }
        const entries = Array.isArray(all.items) ? all.items : [];
        const effectiveCount =
          entries.length > 0
            ? Math.min(all.count || entries.length, entries.length)
            : (all.count || 0);

        cached = {
          title: all.title,
          count: effectiveCount,
          isAutomix: false,
          entries
        };
        setCache(keyUrl, cached);
      } catch (e) {
        const meta = await getPlaylistMetaLite(keyUrl);
        if (!meta.count) return sendError(res, 'PREVIEW_FAILED', "Playlist is empty or could not be read", 404);
        const start = (p - 1) * ps + 1; const end = Math.min(p * ps, meta.count);
        const pageData = await extractPlaylistPage(keyUrl, start, end);
        return sendOk(res, { playlist: { title: pageData.title || meta.title, count: meta.count, isAutomix: false }, page: p, pageSize: ps, items: pageData.items });
      }
    }
    const startIdx = (p - 1) * ps; const endIdx = Math.min(p * ps, cached.entries.length);
    const slice = cached.entries.slice(startIdx, endIdx);
    sendOk(res, { playlist: { title: cached.title, count: cached.count, isAutomix: false }, page: p, pageSize: ps, items: slice });
  } catch (e) {
    console.error("Playlist preview error:", e);
    return sendError(res, 'PREVIEW_FAILED', String(e.message || e), 500);
  }
});

export default router;
