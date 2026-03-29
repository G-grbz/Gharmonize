import fetch from "node-fetch";
import { resolveMarket, withMarketFallback } from "./market.js";

const APPLE_SEARCH_CACHE = new Map();
const APPLE_SEARCH_CACHE_MAX = 500;
const APPLE_LOOKUP_CACHE = new Map();
const APPLE_LOOKUP_CACHE_MAX = 500;
const APPLE_TRACK_LOOKUP_CACHE = new Map();
const APPLE_TRACK_LOOKUP_CACHE_MAX = 2000;
const APPLE_COLLECTION_TRACKS_CACHE = new Map();
const APPLE_COLLECTION_TRACKS_CACHE_MAX = 300;
const APPLE_PAGE_CACHE = new Map();
const APPLE_PAGE_CACHE_MAX = 150;
const APPLE_TRACK_LOOKUP_BATCH_CONCURRENCY = 4;

const APPLE_WEB_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.8"
});

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

// Reads cached Apple metadata entries for Apple mapping and metadata flow.
function cacheGet(cache, key) {
  return cache.has(key) ? cache.get(key) : undefined;
}

// Stores cached Apple metadata entries with max-size eviction for Apple mapping and metadata flow.
function cacheSet(cache, key, value, max = 500) {
  cache.set(key, value);
  if (cache.size > max) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// Coerces Apple payload values to number or null for Apple mapping and metadata flow.
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Folds locale-specific characters before Apple string normalization.
function foldLocaleChars(s = "") {
  return String(s).replace(
    /[IİıŞşĞğÜüÖöÇçßÆæŒœ]/g,
    (ch) => CHAR_FOLD_MAP[ch] || ch
  );
}

// Normalizes Apple search text for fuzzy matching in Apple mapping and metadata flow.
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

// Builds safe Apple artist query variants for short-name matching.
function buildArtistQueryVariants(artist = "") {
  const out = [];
  const seen = new Set();
  const push = (value = "") => {
    const raw = String(value || "").trim();
    const key = norm(raw);
    if (!raw || !key || seen.has(key)) return;
    seen.add(key);
    out.push(raw);
  };

  const rawArtist = String(artist || "").trim();
  push(rawArtist);

  const primaryArtist = rawArtist
    .split(/\s*(?:,|&|\/|feat\.?|ft\.?|with)\s*/i)[0]
    .trim();
  push(primaryArtist);

  const primaryTokens = primaryArtist.split(/\s+/).filter(Boolean);
  if (primaryTokens.length >= 2) {
    const firstToken = primaryTokens[0];
    if (String(firstToken || "").length >= 3) {
      push(firstToken);
    }
  }

  return out;
}

// Expands Apple artwork URLs to the requested image size for Apple mapping and metadata flow.
function buildArtworkUrl(url = "", size = 1200) {
  const s = String(url || "").trim();
  if (!s) return "";
  return s.replace(/\/\d+x\d+(?:bb)?\./i, `/${size}x${size}bb.`);
}

// Checks whether Apple result duration matches the target duration within tolerance.
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

// Splits normalized Apple text into comparable tokens for fuzzy matching.
function tokenizeNorm(value = "") {
  return norm(value)
    .split(/\s+/)
    .filter(Boolean);
}

// Counts overlapping Apple text tokens for artist matching decisions.
function countTokenOverlap(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of left) {
    if (rightSet.has(token)) overlap += 1;
  }
  return overlap;
}

// Scores Apple artist similarity for query matching and metadata flow.
function buildArtistMatchInfo(expected = "", candidate = "") {
  const expectedNorm = norm(expected);
  const candidateNorm = norm(candidate);

  if (!expectedNorm) {
    return {
      exact: false,
      partial: false,
      overlap: 0,
      acceptable: true
    };
  }

  if (!candidateNorm) {
    return {
      exact: false,
      partial: false,
      overlap: 0,
      acceptable: false
    };
  }

  if (candidateNorm === expectedNorm) {
    return {
      exact: true,
      partial: true,
      overlap: tokenizeNorm(expectedNorm).length || 1,
      acceptable: true
    };
  }

  if (
    candidateNorm.includes(expectedNorm) ||
    expectedNorm.includes(candidateNorm)
  ) {
    return {
      exact: false,
      partial: true,
      overlap: Math.min(
        tokenizeNorm(expectedNorm).length || 1,
        tokenizeNorm(candidateNorm).length || 1
      ),
      acceptable: true
    };
  }

  const expectedTokens = tokenizeNorm(expectedNorm).filter((token) => token.length > 1);
  const candidateTokens = tokenizeNorm(candidateNorm).filter((token) => token.length > 1);
  const overlap = countTokenOverlap(expectedTokens, candidateTokens);
  const expectedRatio = expectedTokens.length ? overlap / expectedTokens.length : 0;
  const candidateRatio = candidateTokens.length ? overlap / candidateTokens.length : 0;
  const partial =
    overlap >= 1 &&
    (expectedRatio >= 0.5 || candidateRatio >= 0.5);

  return {
    exact: false,
    partial,
    overlap,
    acceptable: partial
  };
}

// Builds Apple search cache keys from normalized query fields for Apple mapping and metadata flow.
function buildSearchKey(artist = "", title = "", album = "", market = "", targetDurationMs = null) {
  return JSON.stringify({
    artist: norm(artist),
    title: norm(title),
    album: norm(album),
    market: String(market || "").toUpperCase(),
    duration: Number.isFinite(targetDurationMs) ? Math.round(targetDurationMs) : null
  });
}

// Builds Apple collection lookup cache keys for Apple mapping and metadata flow.
function buildLookupKey(collectionId = "", market = "") {
  const id = numberOrNull(collectionId);
  return JSON.stringify({
    collectionId: id && id > 0 ? Math.round(id) : null,
    market: String(market || "").toUpperCase()
  });
}

// Builds Apple track lookup cache keys for Apple mapping and metadata flow.
function buildTrackLookupKey(trackId = "", market = "") {
  const id = numberOrNull(trackId);
  return JSON.stringify({
    trackId: id && id > 0 ? Math.round(id) : null,
    market: String(market || "").toUpperCase()
  });
}

// Builds Apple collection+tracks cache keys for Apple mapping and metadata flow.
function buildCollectionTracksKey(collectionId = "", market = "") {
  const id = numberOrNull(collectionId);
  return JSON.stringify({
    collectionId: id && id > 0 ? Math.round(id) : null,
    market: String(market || "").toUpperCase(),
    entity: "song"
  });
}

// Extracts a single meta tag content from Apple Music HTML for Apple mapping and metadata flow.
function parseAppleMetaContent(html = "", attr = "property", key = "") {
  const safeKey = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrRe = new RegExp(`${attr}=["']${safeKey}["']`, "i");
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match?.[0] || "";
    if (!attrRe.test(tag)) continue;
    return (
      tag.match(/\bcontent="([^"]*)"/i)?.[1] ||
      tag.match(/\bcontent='([^']*)'/i)?.[1] ||
      ""
    );
  }
  return "";
}

// Extracts all matching meta tag contents from Apple Music HTML for Apple mapping and metadata flow.
function parseAppleAllMetaContents(html = "", attr = "property", key = "") {
  const safeKey = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrRe = new RegExp(`${attr}=["']${safeKey}["']`, "i");
  const values = [];
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match?.[0] || "";
    if (!attrRe.test(tag)) continue;
    const content =
      tag.match(/\bcontent="([^"]*)"/i)?.[1] ||
      tag.match(/\bcontent='([^']*)'/i)?.[1] ||
      "";
    if (content) values.push(content);
  }
  return values;
}

// Decodes HTML entities found in Apple Music page values for Apple mapping and metadata flow.
function decodeHtmlEntities(value = "") {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? String.fromCharCode(n) : _;
    });
}

// Parses JSON-LD blocks embedded in Apple Music HTML for Apple mapping and metadata flow.
function extractJsonLdBlocks(html = "") {
  const blocks = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(String(html || "")))) {
    const raw = String(match?.[1] || "").trim();
    if (!raw) continue;
    try {
      blocks.push(JSON.parse(raw));
    } catch {}
  }
  return blocks;
}

// Parses ISO-8601 duration text to milliseconds for Apple mapping and metadata flow.
function parseIsoDurationMs(value = "") {
  const src = String(value || "").trim();
  if (!src) return null;
  const match = src.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return (((hours * 60) + minutes) * 60 + seconds) * 1000;
}

// Cleans Apple Music page titles down to the user-facing album or playlist title.
function cleanApplePageTitle(value = "") {
  return decodeHtmlEntities(String(value || ""))
    .replace(/\s+[|:-]\s+Apple Music.*$/i, "")
    .replace(/\s+on Apple Music\s*$/i, "")
    .trim();
}

// Extracts Apple track ids from Apple Music URLs for Apple mapping and metadata flow.
function appleTrackIdFromUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const queryTrackId = numberOrNull(parsed.searchParams.get("i"));
    if (queryTrackId && queryTrackId > 0) return queryTrackId;

    const parts = parsed.pathname.split("/").filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      const candidate = numberOrNull(parts[i]);
      if (candidate && candidate > 0) return candidate;
    }
  } catch {}
  return null;
}

// Builds fallback Apple collection metadata from track-level payloads for Apple mapping and metadata flow.
function buildAppleCollectionFallbackFromTrack(track, collectionId = null, fallback = {}) {
  const firstTrack = track && typeof track === "object" ? track : {};
  const resolvedCollectionId =
    numberOrNull(
      fallback.collectionId ??
      firstTrack.collectionId ??
      collectionId
    ) ?? null;

  return {
    wrapperType: "collection",
    collectionId: resolvedCollectionId ? Math.round(resolvedCollectionId) : null,
    collectionName: String(
      fallback.collectionName ||
      firstTrack.collectionName ||
      firstTrack.collectionCensoredName ||
      ""
    ).trim(),
    artistName: String(
      fallback.artistName ||
      firstTrack.collectionArtistName ||
      firstTrack.artistName ||
      ""
    ).trim(),
    artworkUrl100: String(
      fallback.artworkUrl100 ||
      firstTrack.artworkUrl100 ||
      firstTrack.artworkUrl60 ||
      ""
    ).trim(),
    artworkUrl60: String(
      fallback.artworkUrl60 ||
      firstTrack.artworkUrl60 ||
      firstTrack.artworkUrl100 ||
      ""
    ).trim(),
    releaseDate: String(
      fallback.releaseDate ||
      firstTrack.releaseDate ||
      ""
    ).trim(),
    trackCount:
      numberOrNull(fallback.trackCount) ??
      numberOrNull(firstTrack.trackCount),
    primaryGenreName: String(
      fallback.primaryGenreName ||
      firstTrack.primaryGenreName ||
      ""
    ).trim(),
    collectionViewUrl: String(
      fallback.collectionViewUrl ||
      firstTrack.collectionViewUrl ||
      fallback.url ||
      ""
    ).trim(),
    artistViewUrl: String(
      fallback.artistViewUrl ||
      firstTrack.artistViewUrl ||
      ""
    ).trim(),
    copyright: String(
      fallback.copyright ||
      firstTrack.copyright ||
      ""
    ).trim(),
    country: String(
      fallback.country ||
      firstTrack.country ||
      ""
    ).trim(),
    currency: String(
      fallback.currency ||
      firstTrack.currency ||
      ""
    ).trim(),
    collectionType: String(
      fallback.collectionType ||
      firstTrack.collectionType ||
      "Album"
    ).trim()
  };
}

// Extracts album-level fallback metadata from Apple Music HTML for Apple mapping and metadata flow.
function buildAppleAlbumPageMeta(html = "", url = "", collectionId = null) {
  const title = cleanApplePageTitle(
    parseAppleMetaContent(html, "property", "apple:title") ||
    parseAppleMetaContent(html, "name", "apple:title") ||
    parseAppleMetaContent(html, "property", "og:title") ||
    parseAppleMetaContent(html, "name", "twitter:title")
  );

  const artistMetaCandidates = [
    parseAppleMetaContent(html, "name", "apple:artist"),
    parseAppleMetaContent(html, "name", "author"),
    parseAppleMetaContent(html, "property", "music:musician")
  ]
    .map((value) => decodeHtmlEntities(value).trim())
    .filter(Boolean)
    .filter((value) => !/^https?:\/\//i.test(value));

  const image =
    parseAppleMetaContent(html, "property", "og:image") ||
    parseAppleMetaContent(html, "name", "twitter:image") ||
    "";

  return {
    collectionId: numberOrNull(collectionId) ? Math.round(numberOrNull(collectionId)) : null,
    collectionName: title,
    artistName: artistMetaCandidates[0] || "",
    artworkUrl100: image,
    artworkUrl60: image,
    collectionViewUrl: String(url || "").trim(),
    copyright: decodeHtmlEntities(
      parseAppleMetaContent(html, "name", "copyright") ||
      parseAppleMetaContent(html, "property", "copyright") ||
      ""
    ).trim()
  };
}

// Checks whether the given URL looks like an Apple Music track URL.
function isAppleTrackUrlLike(url = "") {
  const parsed = parseAppleMusicUrl(url);
  return parsed?.type === "track" && !!parsed?.id;
}

// Adds a unique Apple track candidate extracted from HTML or JSON-LD payloads.
function pushAppleTrackCandidate(candidates, seen, entry = {}) {
  if (!entry || typeof entry !== "object") return;

  const url = String(entry.url || entry["@id"] || "").trim();
  const rawId = entry.id ?? entry.trackId ?? appleTrackIdFromUrl(url);
  const id = numberOrNull(rawId);
  const looksTrack = (id && id > 0) || isAppleTrackUrlLike(url);
  if (!looksTrack) return;

  const key = id && id > 0 ? `id:${Math.round(id)}` : `url:${url}`;
  if (!key || seen.has(key)) return;
  seen.add(key);

  candidates.push({
    id: id && id > 0 ? Math.round(id) : null,
    url,
    title: decodeHtmlEntities(
      entry.name ||
      entry.title ||
      entry.trackName ||
      ""
    ).trim(),
    duration_ms:
      parseIsoDurationMs(entry.duration || "") ??
      numberOrNull(entry.duration_ms ?? entry.trackTimeMillis)
  });
}

// Walks Apple Music JSON-LD trees to collect track candidates for Apple mapping and metadata flow.
function collectAppleTrackCandidatesFromJsonLd(value, candidates, seen) {
  if (!value) return;

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAppleTrackCandidatesFromJsonLd(entry, candidates, seen);
    }
    return;
  }

  if (typeof value !== "object") return;

  const type = String(value["@type"] || "").toLowerCase();

  if (type === "listitem" && value.item && typeof value.item === "object") {
    pushAppleTrackCandidate(candidates, seen, value.item);
  }

  if (
    type.includes("musicrecording") ||
    type.includes("audioobject") ||
    type.includes("track")
  ) {
    pushAppleTrackCandidate(candidates, seen, value);
  }

  if (value.item && typeof value.item === "object") {
    collectAppleTrackCandidatesFromJsonLd(value.item, candidates, seen);
  }
  if (value.track) {
    collectAppleTrackCandidatesFromJsonLd(value.track, candidates, seen);
  }
  if (value.tracks) {
    collectAppleTrackCandidatesFromJsonLd(value.tracks, candidates, seen);
  }
  if (value.itemListElement) {
    collectAppleTrackCandidatesFromJsonLd(value.itemListElement, candidates, seen);
  }
  if (value["@graph"]) {
    collectAppleTrackCandidatesFromJsonLd(value["@graph"], candidates, seen);
  }
}

// Extracts Apple album track candidates from Apple Music HTML for Apple mapping and metadata flow.
function extractAppleAlbumTrackCandidates(html = "") {
  const candidates = [];
  const seen = new Set();

  for (const url of parseAppleAllMetaContents(html, "property", "music:song")) {
    pushAppleTrackCandidate(candidates, seen, { url });
  }

  for (const block of extractJsonLdBlocks(html)) {
    collectAppleTrackCandidatesFromJsonLd(block, candidates, seen);
  }

  if (!candidates.length) {
    const matches =
      String(html || "").match(/https?:\/\/(?:embed\.)?music\.apple\.com\/[^"'\\<>\s]+/gi) ||
      [];
    for (const url of matches) {
      if (!isAppleTrackUrlLike(url)) continue;
      pushAppleTrackCandidate(candidates, seen, { url });
    }
  }

  return candidates;
}

// Normalizes Apple storefront codes parsed from Apple Music URLs.
function normalizeAppleStorefront(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const base = raw.split("-")[0];
  return /^[A-Za-z]{2}$/i.test(base) ? base.toUpperCase() : "";
}

// Fetches and caches Apple Music page HTML for Apple mapping and metadata flow.
async function fetchAppleMusicHtml(url = "") {
  const target = String(url || "").trim();
  if (!target) throw new Error("Apple Music URL is required");

  const cached = cacheGet(APPLE_PAGE_CACHE, target);
  if (cached !== undefined) return cached;

  const res = await fetch(target, { headers: APPLE_WEB_HEADERS, redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Apple Music page fetch failed (${res.status})`);
  }

  const html = await res.text();
  cacheSet(APPLE_PAGE_CACHE, target, html, APPLE_PAGE_CACHE_MAX);
  return html;
}

// Calls the Apple lookup API and returns normalized result rows for Apple mapping and metadata flow.
async function fetchAppleLookup(params) {
  const res = await fetch(`https://itunes.apple.com/lookup?${params.toString()}`, {
    headers: { "user-agent": "Gharmonize/1.2" }
  });

  if (!res.ok) {
    throw new Error(`Apple lookup failed (${res.status})`);
  }

  const data = await res.json();
  return Array.isArray(data?.results) ? data.results : [];
}

// Scores Apple lookup rows against requested artist, title, album, and duration hints.
function scoreResult(result, { artist = "", title = "", album = "", targetDurationMs = null } = {}) {
  const aN = norm(artist);
  const tN = norm(title);
  const albN = norm(album);
  const rTitle = norm(result?.trackName || "");
  const rArtist = norm(result?.artistName || "");
  const rAlbum = norm(result?.collectionName || "");
  const titleExact = !!tN && rTitle === tN;
  const titleContains =
    !!tN &&
    !titleExact &&
    (rTitle.includes(tN) || tN.includes(rTitle));
  const artistMatch = buildArtistMatchInfo(aN, rArtist);
  let score = 0;

  if (titleExact) score += 6;
  else if (titleContains) score += 3;

  if (aN) {
    if (artistMatch.exact) score += 5;
    else if (artistMatch.partial) score += 2;
  }

  if (albN) {
    if (rAlbum === albN) score += 2;
    else if (rAlbum.includes(albN) || albN.includes(rAlbum)) score += 1;
  }

  if (durationMatches(result, targetDurationMs)) score += 3;

  if (/\b(karaoke|cover|instrumental|nightcore|sped|slowed|remix)\b/i.test(result?.trackName || "")) {
    score -= 3;
  }

  return {
    score,
    acceptable:
      (titleExact || titleContains) &&
      (!aN || artistMatch.acceptable),
    titleExact,
    titleContains,
    artistMatch
  };
}

// Searches Apple tracks through the iTunes search API for Apple mapping and metadata flow.
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

// Looks up Apple collection metadata by collection id for Apple mapping and metadata flow.
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

// Looks up Apple collection metadata together with track rows for Apple mapping and metadata flow.
async function lookupAppleCollectionWithTracks(collectionId, { market } = {}) {
  const id = numberOrNull(collectionId);
  if (!id || id <= 0) return { collection: null, tracks: [] };

  const mkt = resolveMarket(market);
  const cacheKey = buildCollectionTracksKey(id, mkt);
  const cached = cacheGet(APPLE_COLLECTION_TRACKS_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const params = new URLSearchParams({
    id: String(Math.round(id)),
    entity: "song"
  });

  if (mkt && /^[A-Z]{2}$/i.test(mkt)) {
    params.set("country", mkt.toLowerCase());
  }

  const results = await fetchAppleLookup(params);
  const tracks = results.filter((item) => numberOrNull(item?.trackId));
  const payload = {
    collection:
      results.find((item) => String(item?.wrapperType || "").toLowerCase() === "collection") ||
      buildAppleCollectionFallbackFromTrack(tracks[0], id),
    tracks
  };

  cacheSet(
    APPLE_COLLECTION_TRACKS_CACHE,
    cacheKey,
    payload,
    APPLE_COLLECTION_TRACKS_CACHE_MAX
  );
  return payload;
}

// Resolves Apple album metadata with API lookup and HTML fallback for Apple mapping and metadata flow.
async function resolveAppleAlbumBundle(collectionId, url, { market } = {}) {
  const resolvedMarket = resolveMarket(market);

  const bundle =
    await withMarketFallback(async (mkt) => {
      const hit = await lookupAppleCollectionWithTracks(collectionId, { market: mkt });
      if (Array.isArray(hit?.tracks) && hit.tracks.length) {
        return hit;
      }
      return null;
    }, resolvedMarket);

  let collection = bundle?.collection || null;
  let tracks = Array.isArray(bundle?.tracks) ? bundle.tracks.filter(Boolean) : [];

  if ((!collection || !tracks.length) && url) {
    try {
      const html = await fetchAppleMusicHtml(url);
      const pageMeta = buildAppleAlbumPageMeta(html, url, collectionId);
      const candidates = extractAppleAlbumTrackCandidates(html);
      const candidateIds = Array.from(
        new Set(
          candidates
            .map((candidate) => numberOrNull(candidate?.id))
            .filter((value) => value && value > 0)
            .map((value) => Math.round(value))
        )
      );

      let lookupTracks = [];
      if (candidateIds.length) {
        const hits =
          await withMarketFallback(async (mkt) => {
            const rows = await lookupAppleTracksByIds(candidateIds, { market: mkt });
            return Array.isArray(rows) && rows.length ? rows : null;
          }, resolvedMarket);
        lookupTracks = Array.isArray(hits) ? hits : [];
      }

      const tracksById = new Map(
        lookupTracks
          .filter((track) => numberOrNull(track?.trackId))
          .map((track) => [Math.round(numberOrNull(track.trackId)), track])
      );

      const htmlTracks = [];
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        const hit = candidate?.id ? tracksById.get(candidate.id) || null : null;
        if (hit) {
          htmlTracks.push(hit);
          continue;
        }

        if (!candidate?.title && !candidate?.url) continue;

        htmlTracks.push({
          wrapperType: "track",
          kind: "song",
          trackId: candidate.id ?? null,
          trackName: candidate.title || `Track ${i + 1}`,
          artistName: pageMeta.artistName || "",
          collectionId:
            pageMeta.collectionId ??
            (numberOrNull(collectionId) ? Math.round(numberOrNull(collectionId)) : null),
          collectionName: pageMeta.collectionName || "",
          collectionArtistName: pageMeta.artistName || "",
          trackViewUrl: candidate.url || "",
          collectionViewUrl: pageMeta.collectionViewUrl || String(url || "").trim(),
          artworkUrl100: pageMeta.artworkUrl100 || "",
          artworkUrl60: pageMeta.artworkUrl60 || "",
          trackNumber: i + 1,
          trackCount: candidates.length || null,
          trackTimeMillis: candidate.duration_ms ?? null
        });
      }

      if (!tracks.length && htmlTracks.length) {
        tracks = htmlTracks;
      }

      if (!collection) {
        collection = buildAppleCollectionFallbackFromTrack(
          lookupTracks[0] || tracks[0] || null,
          collectionId,
          {
            ...pageMeta,
            trackCount:
              numberOrNull(pageMeta.trackCount) ??
              numberOrNull(lookupTracks[0]?.trackCount) ??
              tracks.length
          }
        );
      }
    } catch {}
  }

  if (!collection && tracks.length) {
    collection = buildAppleCollectionFallbackFromTrack(tracks[0], collectionId, {
      collectionViewUrl: String(url || "").trim(),
      trackCount: tracks.length
    });
  }

  return { collection, tracks };
}

// Looks up Apple tracks in batches by track id for Apple mapping and metadata flow.
async function lookupAppleTracksByIds(trackIds, { market } = {}) {
  const ids = Array.from(
    new Set(
      (Array.isArray(trackIds) ? trackIds : [trackIds])
        .map((value) => numberOrNull(value))
        .filter((value) => value && value > 0)
        .map((value) => Math.round(value))
    )
  );

  if (!ids.length) return [];

  const mkt = resolveMarket(market);
  const out = [];
  const missing = [];

  for (const id of ids) {
    const cacheKey = buildTrackLookupKey(id, mkt);
    const cached = cacheGet(APPLE_TRACK_LOOKUP_CACHE, cacheKey);
    if (cached !== undefined) {
      if (cached) out.push(cached);
      continue;
    }
    missing.push(id);
  }

  const chunks = [];
  for (let i = 0; i < missing.length; i += 50) {
    const chunk = missing.slice(i, i + 50);
    if (chunk.length) chunks.push(chunk);
  }

  for (let i = 0; i < chunks.length; i += APPLE_TRACK_LOOKUP_BATCH_CONCURRENCY) {
    const batch = chunks.slice(i, i + APPLE_TRACK_LOOKUP_BATCH_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        const params = new URLSearchParams({
          id: chunk.join(",")
        });

        if (mkt && /^[A-Z]{2}$/i.test(mkt)) {
          params.set("country", mkt.toLowerCase());
        }

        const results = await fetchAppleLookup(params);
        return {
          chunk,
          byId: new Map(
            results
              .filter((item) => numberOrNull(item?.trackId))
              .map((item) => [Math.round(numberOrNull(item.trackId)), item])
          )
        };
      })
    );

    for (const { chunk, byId } of batchResults) {
      for (const trackId of chunk) {
        const hit = byId.get(trackId) || null;
        cacheSet(
          APPLE_TRACK_LOOKUP_CACHE,
          buildTrackLookupKey(trackId, mkt),
          hit,
          APPLE_TRACK_LOOKUP_CACHE_MAX
        );
        if (hit) out.push(hit);
      }
    }
  }

  return out;
}

// Builds normalized Apple resolved items for downstream Apple mapping and metadata flow.
function buildAppleResolvedItem(meta, fallback = {}) {
  const base = meta || fallback || {};
  const artist = String(base.artist || base.uploader || fallback.artist || "").trim();
  const title = String(base.track || base.title || fallback.title || "").trim();
  const webpageUrl =
    base.apple_track_url ||
    base.webpage_url ||
    fallback.webpage_url ||
    "";

  return {
    title,
    artist,
    album: base.album || fallback.album || "",
    album_artist: base.album_artist || artist,
    year: base.release_year || "",
    date: base.release_date || "",
    track_number: base.track_number ?? fallback.track_number ?? null,
    disc_number: base.disc_number ?? fallback.disc_number ?? null,
    track_total: base.track_total ?? fallback.track_total ?? null,
    disc_total: base.disc_total ?? fallback.disc_total ?? null,
    isrc: base.isrc || "",
    coverUrl: base.coverUrl || fallback.coverUrl || "",
    duration_ms: base.duration_ms ?? fallback.duration_ms ?? null,
    spUrl: webpageUrl,
    amUrl: webpageUrl,
    webpage_url: webpageUrl,
    apple_track_id: base.apple_track_id ?? fallback.apple_track_id ?? null,
    apple_collection_id: base.apple_collection_id ?? fallback.apple_collection_id ?? null,
    apple_artist_id: base.apple_artist_id ?? fallback.apple_artist_id ?? null
  };
}

// Builds fallback Apple titles for partial or unsupported Apple payloads.
function buildAppleFallbackTitle(type = "", payload = null) {
  const title = String(payload?.title || payload?.name || "").trim();
  if (title) return title;
  if (type === "track") return "Apple Music Track";
  if (type === "playlist") return "Apple Music Playlist";
  if (type === "album") return "Apple Music Album";
  return "Apple Music";
}

// Checks whether Apple Music URLs are valid for Apple mapping and metadata flow.
export function isAppleMusicUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return host === "music.apple.com" || host === "embed.music.apple.com";
  } catch {
    return /^https?:\/\/(?:embed\.)?music\.apple\.com\//i.test(raw);
  }
}

// Parses Apple Music URLs into type, id, and storefront for Apple mapping and metadata flow.
export function parseAppleMusicUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return { type: "unknown", id: null, storefront: "" };

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (host !== "music.apple.com" && host !== "embed.music.apple.com") {
      return { type: "unknown", id: null, storefront: "" };
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const storefront = normalizeAppleStorefront(parts[0] || "");
    const type = String(parts[1] || "").toLowerCase();
    const queryTrackId = numberOrNull(parsed.searchParams.get("i"));

    if (type === "song" || queryTrackId) {
      const directTrackId = numberOrNull(parts[parts.length - 1]);
      return {
        type: "track",
        id: Math.round(queryTrackId || directTrackId || 0) || null,
        storefront
      };
    }

    if (type === "album") {
      const collectionId = numberOrNull(parts[parts.length - 1]);
      return {
        type: "album",
        id: collectionId ? Math.round(collectionId) : null,
        storefront
      };
    }

    if (type === "playlist") {
      const playlistId = String(parts[parts.length - 1] || "").trim();
      return {
        type: "playlist",
        id: playlistId || null,
        storefront
      };
    }
  } catch {}

  return { type: "unknown", id: null, storefront: "" };
}

// Converts Apple lookup payloads into normalized track metadata for Apple mapping and metadata flow.
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

// Resolves normalized Apple track metadata by track id for Apple mapping and metadata flow.
export async function findAppleTrackMetaById(trackId, { market = "" } = {}) {
  const id = numberOrNull(trackId);
  if (!id || id <= 0) return null;

  const [track] = await lookupAppleTracksByIds([id], { market });
  if (!track) return null;

  let collectionResult = null;
  try {
    collectionResult = await lookupAppleCollection(track.collectionId, { market });
  } catch {}

  return appleTrackToMeta(track, collectionResult);
}

// Resolves Apple Music track, album, or playlist URLs into mapped items for Apple mapping and metadata flow.
export async function resolveAppleMusicUrlLite(url, { market } = {}) {
  const parsed = parseAppleMusicUrl(url);
  if (!parsed?.id || parsed.type === "unknown") {
    throw new Error("Unsupported Apple Music URL");
  }

  const effectiveMarket = resolveMarket(market || parsed.storefront || "");

  if (parsed.type === "track") {
    const meta = await findAppleTrackMetaById(parsed.id, { market: effectiveMarket });
    if (!meta) {
      throw new Error("Apple Music track metadata not found");
    }

    const title = [meta.artist, meta.track || meta.title]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" - ");

    return {
      kind: "track",
      provider: "apple_music",
      title: title || buildAppleFallbackTitle("track", meta),
      items: [buildAppleResolvedItem(meta)]
    };
  }

  if (parsed.type === "album") {
    const bundle = await resolveAppleAlbumBundle(parsed.id, url, {
      market: effectiveMarket
    });
    const collection = bundle?.collection || null;
    const tracks = Array.isArray(bundle?.tracks) ? bundle.tracks : [];
    if (!collection || !tracks.length) {
      throw new Error("Apple Music album metadata not found");
    }

    const items = tracks
      .map((track) => buildAppleResolvedItem(appleTrackToMeta(track, collection)))
      .filter((item) => item.title);
    if (!items.length) {
      throw new Error("Apple Music album metadata not found");
    }

    const artistName = String(collection.artistName || "").trim();
    const title = [artistName, collection.collectionName]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" - ");

    return {
      kind: "playlist",
      provider: "apple_music",
      title: title || buildAppleFallbackTitle("album", collection),
      items
    };
  }

  if (parsed.type === "playlist") {
    const html = await fetchAppleMusicHtml(url);
    const jsonLdBlocks = extractJsonLdBlocks(html);
    const playlistLd =
      jsonLdBlocks.find((block) => String(block?.["@type"] || "").toLowerCase() === "musicplaylist") ||
      null;

    const playlistTitle =
      decodeHtmlEntities(parseAppleMetaContent(html, "name", "apple:title")) ||
      String(playlistLd?.name || "").trim() ||
      buildAppleFallbackTitle("playlist");

    const playlistTracks = Array.isArray(playlistLd?.track) ? playlistLd.track : [];
    const playlistTrackIds = playlistTracks
      .map((entry) => appleTrackIdFromUrl(entry?.url || ""))
      .filter((value) => value && value > 0);
    const uniqueTrackIds = Array.from(new Set(playlistTrackIds));

    const lookupTracks = await lookupAppleTracksByIds(uniqueTrackIds, {
      market: effectiveMarket
    });
    const lookupById = new Map(
      lookupTracks
        .filter((track) => numberOrNull(track?.trackId))
        .map((track) => [Math.round(numberOrNull(track.trackId)), track])
    );

    const items = [];

    for (const entry of playlistTracks) {
      const trackId = appleTrackIdFromUrl(entry?.url || "");
      const track = trackId ? lookupById.get(trackId) || null : null;
      const meta = track ? appleTrackToMeta(track) : null;
      const fallback = {
        title: decodeHtmlEntities(entry?.name || ""),
        duration_ms: parseIsoDurationMs(entry?.duration || ""),
        webpage_url: entry?.url || ""
      };
      const item = buildAppleResolvedItem(meta, fallback);
      if (!item.title) continue;
      items.push(item);
    }

    if (!items.length) {
      throw new Error("Apple Music playlist tracks not found");
    }

    return {
      kind: "playlist",
      provider: "apple_music",
      title: playlistTitle,
      items
    };
  }

  throw new Error("This type of Apple Music URL is not supported yet");
}

// Resolves Apple Music URLs through the lightweight Apple resolver for Apple mapping and metadata flow.
export async function resolveAppleMusicUrl(url, { market } = {}) {
  return resolveAppleMusicUrlLite(url, { market });
}

// Finds the best Apple track metadata match from artist and title hints for Apple mapping and metadata flow.
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

  for (const artistVariant of buildArtistQueryVariants(artistSafe)) {
    push(`${artistVariant} ${titleSafe}`);
    push(`${titleSafe} ${artistVariant}`);
  }
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
      const match = scoreResult(result, {
        artist: artistSafe,
        title: titleSafe,
        album,
        targetDurationMs: durationMs
      });
      if (!match.acceptable) continue;

      if (match.score > bestScore) {
        bestScore = match.score;
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
