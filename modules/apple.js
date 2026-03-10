import fetch from "node-fetch";
import { resolveMarket } from "./market.js";

const APPLE_SEARCH_CACHE = new Map();
const APPLE_SEARCH_CACHE_MAX = 500;
const APPLE_LOOKUP_CACHE = new Map();
const APPLE_LOOKUP_CACHE_MAX = 500;

const CHAR_FOLD_MAP = Object.freeze({
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
  œ: "oe"
});

function cacheGet(cache, key) {
  return cache.has(key) ? cache.get(key) : undefined;
}

function cacheSet(cache, key, value, max = 500) {
  cache.set(key, value);
  if (cache.size > max) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function foldLocaleChars(s = "") {
  return String(s).replace(
    /[IİıŞşĞğÜüÖöÇçßÆæŒœ]/g,
    (ch) => CHAR_FOLD_MAP[ch] || ch
  );
}

function norm(s = "") {
  return foldLocaleChars(String(s))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[\[\](){}"'“”‘’`´·•.,!?]/g, " ")
    .replace(/\b(feat|ft|with)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildArtworkUrl(url = "", size = 1200) {
  const s = String(url || "").trim();
  if (!s) return "";
  return s.replace(/\/\d+x\d+(?:bb)?\./i, `/${size}x${size}bb.`);
}

function durationMatches(result, targetDurationMs) {
  const target =
    Number.isFinite(targetDurationMs) && Number(targetDurationMs) > 0
      ? Number(targetDurationMs)
      : null;
  const duration = Number(result?.trackTimeMillis || 0);
  if (!target || !duration) return false;
  const tol = Math.max(3_000, Math.round(target * 0.02));
  return Math.abs(duration - target) <= tol;
}

function buildSearchKey(artist = "", title = "", album = "", market = "", targetDurationMs = null) {
  return JSON.stringify({
    artist: norm(artist),
    title: norm(title),
    album: norm(album),
    market: String(market || "").toUpperCase(),
    duration: Number.isFinite(targetDurationMs) ? Math.round(targetDurationMs) : null
  });
}

function buildLookupKey(collectionId = "", market = "") {
  const id = numberOrNull(collectionId);
  return JSON.stringify({
    collectionId: id && id > 0 ? Math.round(id) : null,
    market: String(market || "").toUpperCase()
  });
}

function scoreResult(result, { artist = "", title = "", album = "", targetDurationMs = null } = {}) {
  const aN = norm(artist);
  const tN = norm(title);
  const albN = norm(album);
  const rTitle = norm(result?.trackName || "");
  const rArtist = norm(result?.artistName || "");
  const rAlbum = norm(result?.collectionName || "");
  let score = 0;

  if (tN) {
    if (rTitle === tN) score += 6;
    else if (rTitle.includes(tN) || tN.includes(rTitle)) score += 3;
  }

  if (aN) {
    if (rArtist === aN) score += 5;
    else if (rArtist.includes(aN) || aN.includes(rArtist)) score += 2;
  }

  if (albN) {
    if (rAlbum === albN) score += 2;
    else if (rAlbum.includes(albN) || albN.includes(rAlbum)) score += 1;
  }

  if (durationMatches(result, targetDurationMs)) score += 3;

  if (/\b(karaoke|cover|instrumental|nightcore|sped|slowed|remix)\b/i.test(result?.trackName || "")) {
    score -= 3;
  }

  return score;
}

async function searchAppleTracks(query, { market, limit = 8 } = {}) {
  const params = new URLSearchParams({
    term: query,
    entity: "song",
    limit: String(Math.max(1, Math.min(20, Number(limit) || 8)))
  });

  const mkt = resolveMarket(market);
  if (mkt && /^[A-Z]{2}$/i.test(mkt)) {
    params.set("country", mkt.toLowerCase());
  }

  const res = await fetch(`https://itunes.apple.com/search?${params.toString()}`, {
    headers: {
      "user-agent": "Gharmonize/1.2"
    }
  });

  if (!res.ok) {
    throw new Error(`Apple search failed (${res.status})`);
  }

  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

async function lookupAppleCollection(collectionId, { market } = {}) {
  const id = numberOrNull(collectionId);
  if (!id || id <= 0) return null;

  const mkt = resolveMarket(market);
  const cacheKey = buildLookupKey(id, mkt);
  const cached = cacheGet(APPLE_LOOKUP_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const params = new URLSearchParams({
    id: String(Math.round(id))
  });

  if (mkt && /^[A-Z]{2}$/i.test(mkt)) {
    params.set("country", mkt.toLowerCase());
  }

  const res = await fetch(`https://itunes.apple.com/lookup?${params.toString()}`, {
    headers: {
      "user-agent": "Gharmonize/1.2"
    }
  });

  if (!res.ok) {
    throw new Error(`Apple lookup failed (${res.status})`);
  }

  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  const collection =
    results.find((item) => String(item?.wrapperType || "").toLowerCase() === "collection") ||
    results[0] ||
    null;

  cacheSet(APPLE_LOOKUP_CACHE, cacheKey, collection, APPLE_LOOKUP_CACHE_MAX);
  return collection;
}

export function appleTrackToMeta(result, collectionResult = null) {
  if (!result) return null;

  const releaseDate = String(result.releaseDate || collectionResult?.releaseDate || "");
  const artworkSource =
    result.artworkUrl100 ||
    result.artworkUrl60 ||
    collectionResult?.artworkUrl100 ||
    collectionResult?.artworkUrl60 ||
    "";
  const collectionUrl =
    result.collectionViewUrl ||
    collectionResult?.collectionViewUrl ||
    "";
  const artistUrl =
    result.artistViewUrl ||
    collectionResult?.artistViewUrl ||
    "";
  const trackUrl =
    result.trackViewUrl ||
    collectionUrl ||
    artistUrl ||
    "";
  const advisoryRating = String(
    result.contentAdvisoryRating ||
    result.trackExplicitness ||
    collectionResult?.collectionExplicitness ||
    ""
  );
  const advisoryRatingKey = advisoryRating.replace(/\s+/g, "").toLowerCase();
  const copyrightText = String(
    collectionResult?.copyright ||
    result.copyright ||
    ""
  );

  return {
    title: result.trackName || result.trackCensoredName || "",
    track: result.trackName || result.trackCensoredName || "",
    artist: result.artistName || "",
    uploader: result.artistName || "",
    album:
      result.collectionName ||
      result.collectionCensoredName ||
      collectionResult?.collectionName ||
      "",
    album_artist:
      result.collectionArtistName ||
      collectionResult?.artistName ||
      result.artistName ||
      "",
    release_year: releaseDate ? releaseDate.slice(0, 4) : "",
    release_date: releaseDate || "",
    track_number: numberOrNull(result.trackNumber),
    disc_number: numberOrNull(result.discNumber),
    track_total:
      numberOrNull(result.trackCount) ??
      numberOrNull(collectionResult?.trackCount),
    disc_total: numberOrNull(result.discCount),
    isrc: String(result.isrc || ""),
    coverUrl: buildArtworkUrl(artworkSource, 1200),
    thumbnailUrl: buildArtworkUrl(artworkSource, 600),
    imageUrl: buildArtworkUrl(artworkSource, 1200),
    webpage_url: trackUrl,
    genre: result.primaryGenreName || collectionResult?.primaryGenreName || "",
    label: "",
    publisher: "",
    copyright: copyrightText,
    duration_ms: numberOrNull(result.trackTimeMillis),
    preview_url: result.previewUrl || "",
    advisory_rating: advisoryRating,
    explicit: advisoryRatingKey === "explicit",
    apple_track_id: numberOrNull(result.trackId),
    apple_collection_id:
      numberOrNull(result.collectionId) ??
      numberOrNull(collectionResult?.collectionId),
    apple_artist_id:
      numberOrNull(result.artistId) ??
      numberOrNull(collectionResult?.artistId),
    apple_track_url: result.trackViewUrl || "",
    apple_collection_url: collectionUrl,
    apple_artist_url: artistUrl,
    apple_collection_type: collectionResult?.collectionType || "",
    apple_country: result.country || collectionResult?.country || "",
    apple_currency: result.currency || collectionResult?.currency || "",
    apple_kind: result.kind || "",
    source_provider: "apple",
    source_store: "apple_music"
  };
}

export async function findAppleTrackMetaByQuery(
  artist,
  title,
  {
    album = "",
    market = "",
    targetDurationMs = null,
    targetDurationSec = null,
    limit = 8
  } = {}
) {
  const artistSafe = String(artist || "").trim();
  const titleSafe = String(title || "").trim();
  if (!titleSafe) return null;

  const durationMs =
    Number.isFinite(targetDurationMs) && Number(targetDurationMs) > 0
      ? Number(targetDurationMs)
      : Number.isFinite(targetDurationSec) && Number(targetDurationSec) > 0
      ? Number(targetDurationSec) * 1000
      : null;

  const cacheKey = buildSearchKey(
    artistSafe,
    titleSafe,
    album,
    market,
    durationMs
  );
  const cached = cacheGet(APPLE_SEARCH_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const queries = [];
  const seen = new Set();
  const push = (value = "") => {
    const v = String(value || "").trim();
    if (!v) return;
    const key = norm(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(v);
  };

  push(`${artistSafe} ${titleSafe}`);
  push(`${titleSafe} ${artistSafe}`);
  push(titleSafe);

  let bestResult = null;
  let bestScore = -1;

  for (const query of queries) {
    let results = [];
    try {
      results = await searchAppleTracks(query, { market, limit });
    } catch {
      continue;
    }

    for (const result of results) {
      const score = scoreResult(result, {
        artist: artistSafe,
        title: titleSafe,
        album,
        targetDurationMs: durationMs
      });

      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
      }
    }

    if (bestScore >= 8) break;
  }

  let collectionResult = null;
  if (bestScore >= 4) {
    try {
      collectionResult = await lookupAppleCollection(bestResult?.collectionId, { market });
    } catch {}
  }

  const meta = bestScore >= 4 ? appleTrackToMeta(bestResult, collectionResult) : null;
  cacheSet(APPLE_SEARCH_CACHE, cacheKey, meta, APPLE_SEARCH_CACHE_MAX);
  return meta;
}
