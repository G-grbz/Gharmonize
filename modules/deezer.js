import fetch from "node-fetch";
import { normalizeDeezerArl } from "./security.js";

const DEEZER_API_BASE = "https://api.deezer.com";
const DEEZER_WEB_GATEWAY = "https://www.deezer.com/ajax/gw-light.php";
const DEEZER_WEB_HEADERS = Object.freeze({
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  accept: "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.8"
});

const DEEZER_SEARCH_CACHE = new Map();
const DEEZER_SEARCH_CACHE_MAX = 500;
const DEEZER_TRACK_CACHE = new Map();
const DEEZER_TRACK_CACHE_MAX = 1000;
const DEEZER_ALBUM_CACHE = new Map();
const DEEZER_ALBUM_CACHE_MAX = 400;
const DEEZER_ALBUM_BUNDLE_CACHE = new Map();
const DEEZER_ALBUM_BUNDLE_CACHE_MAX = 300;
const DEEZER_PLAYLIST_CACHE = new Map();
const DEEZER_PLAYLIST_CACHE_MAX = 200;
const DEEZER_PLAYLIST_BUNDLE_CACHE = new Map();
const DEEZER_PLAYLIST_BUNDLE_CACHE_MAX = 150;
const DEEZER_ARTIST_CACHE = new Map();
const DEEZER_ARTIST_CACHE_MAX = 250;
const DEEZER_ARTIST_TOP_BUNDLE_CACHE = new Map();
const DEEZER_ARTIST_TOP_BUNDLE_CACHE_MAX = 200;
const DEEZER_ALBUM_BUNDLE_CONCURRENCY = 4;
const DEEZER_SMARTTRACKLIST_META_CONCURRENCY = 6;
const DEEZER_ARTIST_SEARCH_MAX_TRACKS = 1000;
const DEEZER_ARTIST_SEARCH_PAGE_SIZE = 100;
const DEEZER_RESOURCE_TYPES = Object.freeze(["track", "album", "playlist", "artist"]);
const DEEZER_SMARTTRACKLIST_ID = /^inspired-by-\d+$/i;
const DEEZER_GATEWAY_METHODS = new Set([
  "deezer.getUserData",
  "deezer.pageSmartTracklist",
  "smartTracklist.getSongs"
]);

const LOCALE_CHAR_FOLD_MAP = Object.freeze({
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

// Reads cached Deezer lookup values for Deezer mapping and metadata flow.
function cacheGet(cache, key) {
  return cache.has(key) ? cache.get(key) : undefined;
}

// Stores Deezer lookup values with simple size trimming for Deezer mapping and metadata flow.
function cacheSet(cache, key, value, max = 500) {
  cache.set(key, value);
  if (cache.size > max) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// Converts Deezer numeric ids and counters safely for Deezer mapping and metadata flow.
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Normalizes locale-specific characters for Deezer matching and metadata flow.
function foldLocaleChars(value = "") {
  return String(value).replace(
    /[IİıŞşĞğÜüÖöÇçßÆæŒœ]/g,
    (ch) => LOCALE_CHAR_FOLD_MAP[ch] || ch
  );
}

// Builds normalized comparison text for Deezer matching and metadata flow.
function norm(value = "") {
  return foldLocaleChars(String(value))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[\[\](){}"'“”‘’`´·•.,!?]/g, " ")
    .replace(/\b(feat|ft|with)\b.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Splits normalized text into tokens for Deezer matching and metadata flow.
function tokenizeNorm(value = "") {
  return norm(value)
    .split(/\s+/)
    .filter(Boolean);
}

// Counts overlapping normalized tokens for Deezer artist/title matching.
function countTokenOverlap(left = [], right = []) {
  if (!left.length || !right.length) return 0;
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of left) {
    if (rightSet.has(token)) overlap += 1;
  }
  return overlap;
}

function compactArtistAliases(value = "") {
  const normalized = norm(value);
  if (!normalized) return [];
  const parts = normalized.split(/\s+(?:and|ve|x)\s+/i).filter(Boolean);
  return Array.from(new Set([normalized, ...parts]
    .map((entry) => entry.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((entry) => entry.length >= 5)));
}

function hasSafeCompactArtistMatch(expected = "", candidate = "") {
  const expectedAliases = compactArtistAliases(expected);
  const candidateAliases = new Set(compactArtistAliases(candidate));
  return expectedAliases.some((alias) => candidateAliases.has(alias));
}

// Scores artist similarity for Deezer query matching and metadata flow.
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

  if (hasSafeCompactArtistMatch(expectedNorm, candidateNorm)) {
    return {
      exact: false,
      partial: true,
      overlap: 1,
      acceptable: true
    };
  }

  const expectedTokens = tokenizeNorm(expectedNorm).filter((token) => token.length > 1);
  const candidateTokens = tokenizeNorm(candidateNorm).filter((token) => token.length > 1);
  const overlap = countTokenOverlap(expectedTokens, candidateTokens);
  const expectedRatio = expectedTokens.length ? overlap / expectedTokens.length : 0;
  const candidateRatio = candidateTokens.length ? overlap / candidateTokens.length : 0;
  const partial =
    overlap >= 2 &&
    (expectedRatio >= 0.67 || candidateRatio >= 0.67);

  return {
    exact: false,
    partial,
    overlap,
    acceptable: partial
  };
}

// Builds stable cache keys for Deezer search lookups and metadata flow.
function buildSearchKey(
  artist = "",
  title = "",
  album = "",
  targetDurationMs = null
) {
  return JSON.stringify({
    artist: norm(artist),
    title: norm(title),
    album: norm(album),
    duration: Number.isFinite(targetDurationMs)
      ? Math.round(targetDurationMs)
      : null
  });
}

// Builds stable cache keys for Deezer entity lookups and metadata flow.
function buildLookupKey(kind = "", id = "") {
  const resolvedId = numberOrNull(id);
  return JSON.stringify({
    kind: String(kind || "").toLowerCase(),
    id: resolvedId && resolvedId > 0 ? Math.round(resolvedId) : null
  });
}

// Builds canonical Deezer web URLs for Deezer mapping and metadata flow.
function buildDeezerPageUrl(type = "", id = "") {
  const resolvedId = numberOrNull(id);
  if (!resolvedId || !type) return "";
  return `https://www.deezer.com/${String(type).toLowerCase()}/${Math.round(resolvedId)}`;
}

// Checks whether a Deezer host is a short-link host for Deezer mapping flow.
function isDeezerShortHost(host = "") {
  const value = String(host || "").toLowerCase();
  return (
    value === "link.deezer.com" ||
    value.endsWith(".link.deezer.com") ||
    value === "deezer.page.link" ||
    value.endsWith(".deezer.page.link")
  );
}

// Checks whether a Deezer URL is a short-link URL for Deezer mapping flow.
function isDeezerShortUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return isDeezerShortHost(parsed.hostname);
  } catch {
    return /^https?:\/\/(?:link\.)?deezer\.com\/s\//i.test(raw) ||
      /^https?:\/\/(?:www\.)?deezer\.page\.link\//i.test(raw);
  }
}

// Normalizes short-link redirect targets into Deezer entity URLs for Deezer mapping flow.
function normalizeDeezerRedirectTarget(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const candidates = [raw, raw.replace(/&amp;/gi, "&")];
  for (const candidate of [...candidates]) {
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded && !candidates.includes(decoded)) candidates.push(decoded);
    } catch {}
  }

  for (const candidate of candidates) {
    const parsed = parseDeezerUrl(candidate);
    if (parsed?.id && parsed.type !== "unknown") {
      return candidate;
    }

    const match = candidate.match(
      /https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}\/)?(?:track|album|playlist)\/\d+(?:\?[^"'<>\s]*)?/i
    );
    if (match?.[0]) {
      return match[0];
    }
  }

  return "";
}

// Extracts the real Deezer target URL from short-link redirects for Deezer mapping flow.
function extractDeezerRedirectTarget(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const direct = normalizeDeezerRedirectTarget(raw);
  if (direct) return direct;

  try {
    const parsed = new URL(raw);
    for (const key of ["dest", "awf", "gwf", "iwf", "url", "target", "u"]) {
      const resolved = normalizeDeezerRedirectTarget(parsed.searchParams.get(key));
      if (resolved) return resolved;
    }
  } catch {}

  return "";
}

// Resolves Deezer short links into canonical Deezer URLs for Deezer mapping flow.
async function resolveDeezerCanonicalUrl(url = "") {
  const raw = String(url || "").trim();
  if (!raw || !isDeezerShortUrl(raw)) return raw;

  try {
    const target = new URL(raw);
    const host = target.hostname.toLowerCase();
    const allowedShortHost =
      host === "link.deezer.com" ||
      host === "deezer.page.link";
    if (target.protocol !== "https:" || !allowedShortHost || target.username || target.password) {
      return raw;
    }

    const origin = host === "link.deezer.com"
      ? "https://link.deezer.com"
      : "https://deezer.page.link";
    const pathname = target.pathname
      .split("/")
      .map((segment) => encodeURIComponent(decodeURIComponent(segment)))
      .join("/");
    const query = [...target.searchParams.entries()]
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
    const safeTarget = `${origin}${pathname}${query ? `?${query}` : ""}`;

    // The origin is selected from fixed Deezer hosts and every untrusted URL
    // component is encoded before it reaches fetch.
    const res = await fetch(safeTarget, {
      headers: DEEZER_WEB_HEADERS,
      redirect: "manual"
    });

    const redirectTarget = extractDeezerRedirectTarget(res.headers.get("location"));
    if (redirectTarget) return redirectTarget;

    const responseTarget = extractDeezerRedirectTarget(res?.url);
    if (responseTarget) return responseTarget;

    const bodyTarget = extractDeezerRedirectTarget(await res.text());
    if (bodyTarget) return bodyTarget;
  } catch {}

  return raw;
}

// Fetches Deezer JSON payloads with shared headers for Deezer metadata flow.
async function fetchDeezerJson(url = "") {
  const target = new URL(String(url || ""));
  const host = target.hostname.toLowerCase();
  if (
    target.protocol !== "https:" ||
    host !== "api.deezer.com" ||
    target.username ||
    target.password
  ) {
    throw new Error("Unsafe Deezer API URL");
  }
  const res = await fetch(target.toString(), {
    headers: DEEZER_WEB_HEADERS,
    redirect: "error"
  });

  if (!res.ok) {
    throw new Error(`Deezer API request failed (${res.status})`);
  }

  const data = await res.json();
  if (data?.error) {
    throw new Error(
      String(data.error?.message || data.error?.type || "Unknown Deezer API error")
    );
  }

  return data;
}

// Returns a stable error for personalized Deezer lists without exposing secrets.
function deezerSmartTracklistError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Extracts cookie pairs set by Deezer without forwarding cookie attributes.
function extractDeezerResponseCookies(headers) {
  const values = headers?.raw?.()["set-cookie"] || [];
  return values
    .map((value) => String(value || "").split(";", 1)[0].trim())
    .filter((value) => /^[A-Za-z0-9_!#$%&'*+.^`|~-]+=[^\r\n;]*$/.test(value));
}

// Combines the configured ARL and Deezer session cookies by cookie name.
function buildDeezerCookieHeader(arl, responseCookies = []) {
  const cookies = new Map();
  const add = (pair) => {
    const raw = String(pair || "").trim();
    const separator = raw.indexOf("=");
    if (separator <= 0) return;
    const name = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/.test(name)) return;
    if (/[\r\n;]/.test(value)) return;
    cookies.set(name, value);
  };

  for (const pair of responseCookies) add(pair);
  // The configured credential must win if Deezer also emits an arl cookie.
  add(`arl=${arl}`);
  return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

// Reads Deezer's gateway error shape while keeping tokens and cookies out of logs.
function getDeezerGatewayError(payload) {
  const error = payload?.error;
  if (!error) return "";
  if (Array.isArray(error)) return error.length ? "Deezer web API returned an error" : "";
  if (typeof error === "object") {
    const keys = Object.keys(error);
    return keys.length ? `Deezer web API error: ${keys.join(", ")}` : "";
  }
  return "Deezer web API returned an error";
}

// Calls a fixed allowlist of Deezer web gateway methods for personalized lists.
async function fetchDeezerGateway(method, data = {}, { apiToken = "", cookie = "" } = {}) {
  if (!DEEZER_GATEWAY_METHODS.has(method)) {
    throw new Error("Unsupported Deezer web API method");
  }

  const target = new URL(DEEZER_WEB_GATEWAY);
  target.searchParams.set("method", method);
  target.searchParams.set("input", "3");
  target.searchParams.set("api_version", "1.0");
  target.searchParams.set("api_token", String(apiToken || ""));

  const headers = {
    ...DEEZER_WEB_HEADERS,
    accept: "application/json",
    "content-type": "application/json"
  };
  if (cookie) headers.cookie = cookie;

  const res = await fetch(target.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(data || {}),
    redirect: "error"
  });
  if (!res.ok) {
    throw new Error(`Deezer web API request failed (${res.status})`);
  }

  const payload = await res.json();
  const gatewayError = getDeezerGatewayError(payload);
  if (gatewayError) throw new Error(gatewayError);

  return {
    payload,
    cookies: extractDeezerResponseCookies(res.headers)
  };
}

// Opens an authenticated Deezer web session for personalized smart tracklists.
async function createDeezerSmartTracklistSession() {
  let arl = "";
  try {
    arl = normalizeDeezerArl(process.env.DEEZER_ARL);
  } catch {
    throw deezerSmartTracklistError(
      "DEEZER_ARL_INVALID",
      "DEEZER_ARL is invalid. Update it in Settings before using Deezer smart tracklists."
    );
  }
  if (!arl) {
    throw deezerSmartTracklistError(
      "DEEZER_ARL_REQUIRED",
      "Deezer inspired-by lists are personalized. Add DEEZER_ARL in Settings first."
    );
  }

  const initialCookie = buildDeezerCookieHeader(arl);
  const sessionResponse = await fetchDeezerGateway(
    "deezer.getUserData",
    {},
    { cookie: initialCookie }
  );
  const session = sessionResponse?.payload?.results || {};
  const userId = numberOrNull(session?.USER?.USER_ID);
  const apiToken = String(session?.checkForm || "").trim();
  if (!userId || userId <= 0 || !apiToken) {
    throw deezerSmartTracklistError(
      "DEEZER_ARL_INVALID",
      "Deezer rejected DEEZER_ARL. Copy a current ARL cookie from a signed-in Deezer session."
    );
  }

  return {
    apiToken,
    cookie: buildDeezerCookieHeader(arl, sessionResponse.cookies)
  };
}

// Extracts track rows from both Deezer smart-tracklist gateway response shapes.
function extractDeezerSmartTrackRows(payload) {
  const results = payload?.results;
  const candidates = [
    results?.data,
    results?.SONGS?.data,
    results?.DATA?.SONGS?.data,
    Array.isArray(results) ? results : null
  ];
  return candidates.find((rows) => Array.isArray(rows))?.filter(Boolean) || [];
}

// Loads paged Deezer tracklists fully for albums, playlists, and artists.
async function fetchAllTrackPages(tracklistUrl, totalHint = null) {
  const raw = String(tracklistUrl || "").trim();
  if (!raw) return [];

  const limit = 100;
  const totalLimit = numberOrNull(totalHint);
  const out = [];
  let index = 0;
  let loops = 0;

  while (loops < 50) {
    const parsed = new URL(raw);
    parsed.searchParams.set("limit", String(limit));
    parsed.searchParams.set("index", String(index));

    const page = await fetchDeezerJson(parsed.toString());
    const rows = Array.isArray(page?.data) ? page.data.filter(Boolean) : [];
    if (!rows.length) break;

    out.push(...rows);
    index += rows.length;
    loops += 1;

    const pageTotal = numberOrNull(page?.total) ?? totalLimit;
    if (pageTotal && out.length >= pageTotal) break;
    if (rows.length < limit && !(pageTotal && out.length < pageTotal)) break;
  }

  return out;
}

// Deduplicates artist names for Deezer metadata flow.
function uniqueNames(values = []) {
  const out = [];
  const seen = new Set();

  for (const value of values) {
    const raw = String(value || "").trim();
    const key = norm(raw);
    if (!raw || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }

  return out;
}

// Collects display artist names from Deezer track and album payloads.
function collectDeezerArtistNames(track = {}, albumResult = null) {
  const contributors = Array.isArray(track?.contributors)
    ? track.contributors.map((item) => item?.name)
    : [];
  const albumContributors = Array.isArray(albumResult?.contributors)
    ? albumResult.contributors.map((item) => item?.name)
    : [];

  const names = uniqueNames([
    ...contributors,
    ...albumContributors,
    track?.artist?.name,
    albumResult?.artist?.name
  ]);

  return names.join(", ");
}

// Selects the best Deezer cover image for metadata flow.
function pickCoverUrl(track = {}, albumResult = null) {
  const album = track?.album || {};
  return (
    albumResult?.cover_xl ||
    albumResult?.cover_big ||
    albumResult?.cover_medium ||
    albumResult?.cover_small ||
    album?.cover_xl ||
    album?.cover_big ||
    album?.cover_medium ||
    album?.cover_small ||
    albumResult?.cover ||
    album?.cover ||
    ""
  );
}

// Matches a Deezer track against its expanded album bundle when available.
function trackFromAlbumBundle(track = {}, albumResult = null) {
  const trackId = numberOrNull(track?.id);
  const albumTracks = Array.isArray(albumResult?.tracks?.data)
    ? albumResult.tracks.data
    : [];
  if (!trackId || !albumTracks.length) return null;
  return (
    albumTracks.find((item) => numberOrNull(item?.id) === trackId) ||
    null
  );
}

// Computes Deezer album disc totals from expanded album track data.
function computeDiscTotal(albumResult = null) {
  const albumTracks = Array.isArray(albumResult?.tracks?.data)
    ? albumResult.tracks.data
    : [];
  if (!albumTracks.length) return null;
  const discs = albumTracks
    .map((item) => Number(item?.disk_number || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return discs.length ? Math.max(...discs) : null;
}

// Merges expanded Deezer track arrays back into album payloads for metadata flow.
function mergeTracksIntoAlbum(album = null, tracks = []) {
  if (!album) return null;
  return {
    ...album,
    tracks: {
      ...(album.tracks || {}),
      data: Array.isArray(tracks) ? tracks : []
    }
  };
}

// Checks Deezer duration tolerance for query matching and metadata flow.
function durationMatches(result, targetDurationMs) {
  const target =
    Number.isFinite(targetDurationMs) && Number(targetDurationMs) > 0
      ? Number(targetDurationMs)
      : null;
  const durationSec = Number(result?.duration || 0);
  if (!target || !durationSec) return false;
  const durationMs = durationSec * 1000;
  const tol = Math.max(3_000, Math.round(target * 0.02));
  return Math.abs(durationMs - target) <= tol;
}

// Scores Deezer search results for artist/title/album matching.
function scoreResult(
  result,
  { artist = "", title = "", album = "", targetDurationMs = null } = {}
) {
  const artistNorm = norm(artist);
  const titleNorm = norm(title);
  const albumNorm = norm(album);
  const resultTitle = norm(result?.title || result?.title_short || "");
  const resultArtist = norm(
    result?.artist?.name ||
      (Array.isArray(result?.contributors)
        ? result.contributors.map((item) => item?.name).filter(Boolean).join(", ")
        : "")
  );
  const resultAlbum = norm(result?.album?.title || "");
  const titleExact = !!titleNorm && resultTitle === titleNorm;
  const titleContains =
    !!titleNorm &&
    !titleExact &&
    (resultTitle.includes(titleNorm) || titleNorm.includes(resultTitle));
  const artistMatch = buildArtistMatchInfo(artistNorm, resultArtist);

  let score = 0;

  if (titleExact) score += 6;
  else if (titleContains) score += 3;

  if (artistNorm) {
    if (artistMatch.exact) score += 5;
    else if (artistMatch.partial) score += 2;
  }

  if (albumNorm) {
    if (resultAlbum === albumNorm) score += 2;
    else if (resultAlbum.includes(albumNorm) || albumNorm.includes(resultAlbum)) score += 1;
  }

  if (durationMatches(result, targetDurationMs)) score += 3;

  if (
    /\b(karaoke|cover|instrumental|nightcore|sped|slowed|remix)\b/i.test(
      result?.title || ""
    )
  ) {
    score -= 3;
  }

  return {
    score,
    acceptable:
      (titleExact || titleContains) &&
      (!artistNorm || artistMatch.acceptable),
    titleExact,
    titleContains,
    artistMatch
  };
}

// Searches Deezer tracks by free text for metadata lookup flow.
async function searchDeezerTracks(query, { limit = 8 } = {}) {
  const parsed = new URL(`${DEEZER_API_BASE}/search/track`);
  parsed.searchParams.set(
    "limit",
    String(Math.max(1, Math.min(25, Number(limit) || 8)))
  );
  parsed.searchParams.set("q", String(query || "").trim());
  const data = await fetchDeezerJson(parsed.toString());
  return Array.isArray(data?.data) ? data.data : [];
}

// Searches Deezer artists so /search/<artist>/track URLs can reuse artist resolution.
async function searchDeezerArtists(query, { limit = 10 } = {}) {
  const parsed = new URL(`${DEEZER_API_BASE}/search/artist`);
  parsed.searchParams.set(
    "limit",
    String(Math.max(1, Math.min(25, Number(limit) || 10)))
  );
  parsed.searchParams.set("q", String(query || "").trim());
  const data = await fetchDeezerJson(parsed.toString());
  return Array.isArray(data?.data) ? data.data.filter(Boolean) : [];
}

// Picks the closest Deezer artist result for a search-page URL.
function pickDeezerArtistSearchResult(query, artists = []) {
  const queryNorm = norm(query);
  if (!queryNorm || !Array.isArray(artists) || !artists.length) return null;

  let best = null;
  let bestScore = -1;
  for (const artist of artists) {
    const name = String(artist?.name || "").trim();
    const nameNorm = norm(name);
    if (!nameNorm) continue;

    let score = 0;
    if (nameNorm === queryNorm) score = 100;
    else if (nameNorm.includes(queryNorm) || queryNorm.includes(nameNorm)) score = 70;
    else {
      const match = buildArtistMatchInfo(queryNorm, nameNorm);
      if (match.acceptable) score = 40 + Math.min(20, match.overlap * 5);
    }

    // Deezer search order remains the tie-breaker.
    if (score > bestScore) {
      bestScore = score;
      best = artist;
    }
  }

  return bestScore >= 40 ? best : null;
}

// Resolves the canonical artist behind Deezer /search/<artist>/track URLs.
async function resolveDeezerArtistSearchTarget(query) {
  const artists = await searchDeezerArtists(query, { limit: 10 });
  const artist = pickDeezerArtistSearchResult(query, artists);
  const artistId = numberOrNull(artist?.id);
  if (!artistId || artistId <= 0) {
    throw new Error("Deezer artist could not be resolved from search URL");
  }
  return {
    id: Math.round(artistId),
    name: String(artist?.name || query || "").trim(),
    artist
  };
}

// Builds Deezer's advanced track-search expression for one exact artist.
function buildDeezerArtistTrackSearchQuery(artistName = "") {
  const safe = String(artistName || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim();
  return safe ? `artist:"${safe}"` : "";
}

// Streams Deezer artist-search results in bounded pages so mapping can start immediately.
async function* streamDeezerArtistSearchBatches(
  parsed,
  { maxItems = DEEZER_ARTIST_SEARCH_MAX_TRACKS, pageSize = DEEZER_ARTIST_SEARCH_PAGE_SIZE } = {}
) {
  const target = await resolveDeezerArtistSearchTarget(parsed?.query);
  const max = Math.max(1, Math.min(DEEZER_ARTIST_SEARCH_MAX_TRACKS, Number(maxItems) || DEEZER_ARTIST_SEARCH_MAX_TRACKS));
  const pageLimit = Math.max(1, Math.min(DEEZER_ARTIST_SEARCH_PAGE_SIZE, Number(pageSize) || DEEZER_ARTIST_SEARCH_PAGE_SIZE));
  const searchQuery = buildDeezerArtistTrackSearchQuery(target.name || parsed?.query);
  const seenTrackIds = new Set();

  let apiIndex = 0;
  let emitted = 0;
  let totalHint = null;

  while (emitted < max) {
    const requested = Math.min(pageLimit, max - emitted);
    const url = new URL(`${DEEZER_API_BASE}/search/track`);
    url.searchParams.set("q", searchQuery);
    url.searchParams.set("limit", String(requested));
    url.searchParams.set("index", String(apiIndex));

    const page = await fetchDeezerJson(url.toString());
    const rows = Array.isArray(page?.data) ? page.data.filter(Boolean) : [];
    const apiTotal = numberOrNull(page?.total);
    if (totalHint == null && apiTotal != null && apiTotal >= 0) {
      totalHint = Math.min(max, Math.max(0, Math.round(apiTotal)));
    }
    if (!rows.length) break;

    const items = [];
    for (const track of rows) {
      const trackId = numberOrNull(track?.id);
      const dedupeKey = trackId && trackId > 0
        ? `id:${Math.round(trackId)}`
        : `fallback:${norm(track?.artist?.name)}|${norm(track?.title || track?.title_short)}|${numberOrNull(track?.duration) || ""}`;
      if (seenTrackIds.has(dedupeKey)) continue;
      seenTrackIds.add(dedupeKey);

      const item = buildDeezerResolvedItem(deezerTrackToMeta(track, null));
      if (!item?.title) continue;
      items.push(item);
      emitted += 1;
      if (emitted >= max) break;
    }

    apiIndex += rows.length;
    const cappedTotal = totalHint ?? Math.min(max, emitted + (rows.length === requested ? requested : 0));
    if (items.length) {
      yield {
        items,
        offset: emitted - items.length,
        total: Math.max(emitted, cappedTotal),
        artist: target.artist,
        artistId: target.id,
        artistName: target.name
      };
    }

    if (emitted >= max) break;
    if (apiTotal != null && apiIndex >= apiTotal) break;
    if (rows.length < requested) break;
  }
}

// Resolves a Deezer artist-search URL either fully or as a first-page + async batch stream.
async function resolveDeezerArtistSearch(parsed, options = {}) {
  const iterator = streamDeezerArtistSearchBatches(parsed, {
    maxItems: options?.maxItems,
    pageSize: options?.pageSize
  });
  const first = await iterator.next();
  if (first.done || !first.value?.items?.length) {
    throw new Error("Deezer artist tracks not found");
  }

  const firstBatch = first.value;
  const titleBase = String(firstBatch.artistName || parsed?.query || "").trim();
  const collection = {
    kind: "playlist",
    provider: "deezer",
    title: titleBase ? `${titleBase} - Tracks` : "Deezer Artist - Tracks",
    items: firstBatch.items,
    totalHint: Math.max(firstBatch.items.length, Number(firstBatch.total) || 0),
    deezerArtistId: firstBatch.artistId || null,
    streamed: options?.streamBatches === true
  };

  if (options?.streamBatches === true) {
    collection.itemBatches = iterator;
    return collection;
  }

  for await (const batch of iterator) {
    if (Array.isArray(batch?.items) && batch.items.length) {
      collection.items.push(...batch.items);
      collection.totalHint = Math.max(
        collection.items.length,
        Number(batch.total) || 0
      );
    }
  }
  collection.totalHint = collection.items.length;
  return collection;
}

// Loads a Deezer track entity by id for metadata flow.
async function lookupDeezerTrack(trackId) {
  const id = numberOrNull(trackId);
  if (!id || id <= 0) return null;

  const cacheKey = buildLookupKey("track", id);
  const cached = cacheGet(DEEZER_TRACK_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  try {
    const track = await fetchDeezerJson(`${DEEZER_API_BASE}/track/${Math.round(id)}`);
    const resolved = numberOrNull(track?.id) ? track : null;
    cacheSet(DEEZER_TRACK_CACHE, cacheKey, resolved, DEEZER_TRACK_CACHE_MAX);
    return resolved;
  } catch {
    cacheSet(DEEZER_TRACK_CACHE, cacheKey, null, DEEZER_TRACK_CACHE_MAX);
    return null;
  }
}

// Loads a Deezer album entity by id for metadata flow.
async function lookupDeezerAlbum(albumId) {
  const id = numberOrNull(albumId);
  if (!id || id <= 0) return null;

  const cacheKey = buildLookupKey("album", id);
  const cached = cacheGet(DEEZER_ALBUM_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  try {
    const album = await fetchDeezerJson(`${DEEZER_API_BASE}/album/${Math.round(id)}`);
    const resolved = numberOrNull(album?.id) ? album : null;
    cacheSet(DEEZER_ALBUM_CACHE, cacheKey, resolved, DEEZER_ALBUM_CACHE_MAX);
    return resolved;
  } catch {
    cacheSet(DEEZER_ALBUM_CACHE, cacheKey, null, DEEZER_ALBUM_CACHE_MAX);
    return null;
  }
}

// Loads a Deezer album with its full track bundle for metadata flow.
async function lookupDeezerAlbumBundle(albumId) {
  const id = numberOrNull(albumId);
  if (!id || id <= 0) return { album: null, tracks: [] };

  const cacheKey = buildLookupKey("album_bundle", id);
  const cached = cacheGet(DEEZER_ALBUM_BUNDLE_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const album = await lookupDeezerAlbum(id);
  if (!album) {
    const empty = { album: null, tracks: [] };
    cacheSet(DEEZER_ALBUM_BUNDLE_CACHE, cacheKey, empty, DEEZER_ALBUM_BUNDLE_CACHE_MAX);
    return empty;
  }

  let tracks = Array.isArray(album?.tracks?.data)
    ? album.tracks.data.filter(Boolean)
    : [];

  try {
    if (album.tracklist) {
      const fullTracks = await fetchAllTrackPages(album.tracklist, album.nb_tracks);
      if (fullTracks.length) tracks = fullTracks;
    }
  } catch {}

  const payload = {
    album: mergeTracksIntoAlbum(album, tracks),
    tracks
  };
  cacheSet(DEEZER_ALBUM_BUNDLE_CACHE, cacheKey, payload, DEEZER_ALBUM_BUNDLE_CACHE_MAX);
  return payload;
}

// Loads a Deezer playlist entity by id for metadata flow.
async function lookupDeezerPlaylist(playlistId) {
  const id = numberOrNull(playlistId);
  if (!id || id <= 0) return null;

  const cacheKey = buildLookupKey("playlist", id);
  const cached = cacheGet(DEEZER_PLAYLIST_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  try {
    const playlist = await fetchDeezerJson(`${DEEZER_API_BASE}/playlist/${Math.round(id)}`);
    const resolved = numberOrNull(playlist?.id) ? playlist : null;
    cacheSet(DEEZER_PLAYLIST_CACHE, cacheKey, resolved, DEEZER_PLAYLIST_CACHE_MAX);
    return resolved;
  } catch {
    cacheSet(DEEZER_PLAYLIST_CACHE, cacheKey, null, DEEZER_PLAYLIST_CACHE_MAX);
    return null;
  }
}

// Loads a Deezer playlist with all tracks for metadata flow.
async function lookupDeezerPlaylistBundle(playlistId) {
  const id = numberOrNull(playlistId);
  if (!id || id <= 0) return { playlist: null, tracks: [] };

  const cacheKey = buildLookupKey("playlist_bundle", id);
  const cached = cacheGet(DEEZER_PLAYLIST_BUNDLE_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const playlist = await lookupDeezerPlaylist(id);
  if (!playlist) {
    const empty = { playlist: null, tracks: [] };
    cacheSet(
      DEEZER_PLAYLIST_BUNDLE_CACHE,
      cacheKey,
      empty,
      DEEZER_PLAYLIST_BUNDLE_CACHE_MAX
    );
    return empty;
  }

  let tracks = Array.isArray(playlist?.tracks?.data)
    ? playlist.tracks.data.filter(Boolean)
    : [];

  try {
    if (playlist.tracklist) {
      const fullTracks = await fetchAllTrackPages(playlist.tracklist, playlist.nb_tracks);
      if (fullTracks.length) tracks = fullTracks;
    }
  } catch {}

  const payload = {
    playlist: {
      ...playlist,
      tracks: {
        ...(playlist.tracks || {}),
        data: tracks
      }
    },
    tracks
  };
  cacheSet(
    DEEZER_PLAYLIST_BUNDLE_CACHE,
    cacheKey,
    payload,
    DEEZER_PLAYLIST_BUNDLE_CACHE_MAX
  );
  return payload;
}

// Loads a Deezer artist entity by id for metadata flow.
async function lookupDeezerArtist(artistId) {
  const id = numberOrNull(artistId);
  if (!id || id <= 0) return null;

  const cacheKey = buildLookupKey("artist", id);
  const cached = cacheGet(DEEZER_ARTIST_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  try {
    const artist = await fetchDeezerJson(`${DEEZER_API_BASE}/artist/${Math.round(id)}`);
    const resolved = numberOrNull(artist?.id) ? artist : null;
    cacheSet(DEEZER_ARTIST_CACHE, cacheKey, resolved, DEEZER_ARTIST_CACHE_MAX);
    return resolved;
  } catch {
    cacheSet(DEEZER_ARTIST_CACHE, cacheKey, null, DEEZER_ARTIST_CACHE_MAX);
    return null;
  }
}

// Loads Deezer artist top tracks for artist URL resolution flow.
async function lookupDeezerArtistTopBundle(artistId) {
  const id = numberOrNull(artistId);
  if (!id || id <= 0) return { artist: null, tracks: [] };

  const cacheKey = buildLookupKey("artist_top_bundle", id);
  const cached = cacheGet(DEEZER_ARTIST_TOP_BUNDLE_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const artist = await lookupDeezerArtist(id);
  if (!artist) {
    const empty = { artist: null, tracks: [] };
    cacheSet(
      DEEZER_ARTIST_TOP_BUNDLE_CACHE,
      cacheKey,
      empty,
      DEEZER_ARTIST_TOP_BUNDLE_CACHE_MAX
    );
    return empty;
  }

  let tracks = [];
  try {
    const tracklistUrl =
      String(artist?.tracklist || "").trim() ||
      `${DEEZER_API_BASE}/artist/${Math.round(id)}/top`;
    tracks = await fetchAllTrackPages(tracklistUrl, null);
  } catch {}

  const payload = {
    artist,
    tracks: Array.isArray(tracks) ? tracks.filter(Boolean) : []
  };
  cacheSet(
    DEEZER_ARTIST_TOP_BUNDLE_CACHE,
    cacheKey,
    payload,
    DEEZER_ARTIST_TOP_BUNDLE_CACHE_MAX
  );
  return payload;
}

// Preloads album bundles for Deezer track collections to enrich metadata.
async function fetchAlbumBundleMap(trackRows = []) {
  const albumIds = Array.from(
    new Set(
      (Array.isArray(trackRows) ? trackRows : [])
        .map((track) => numberOrNull(track?.album?.id))
        .filter((value) => value && value > 0)
        .map((value) => Math.round(value))
    )
  );

  const bundles = new Map();
  if (!albumIds.length) return bundles;

  const queue = albumIds.slice();
  const workerCount = Math.min(DEEZER_ALBUM_BUNDLE_CONCURRENCY, queue.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length) {
        const albumId = queue.shift();
        if (!albumId) continue;
        try {
          const bundle = await lookupDeezerAlbumBundle(albumId);
          if (bundle?.album) bundles.set(albumId, bundle.album);
        } catch {}
      }
    })
  );

  return bundles;
}

// Checks whether a Deezer URL is valid for Deezer mapping and metadata flow.
export function isDeezerUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  if (/^deezer:(track|album|playlist|artist):\d+$/i.test(raw)) return true;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return (
      host === "www.deezer.com" ||
      host === "deezer.com" ||
      host === "link.deezer.com" ||
      host.endsWith(".deezer.com") ||
      host.endsWith("deezer.page.link")
    );
  } catch {
    return /^https?:\/\/(?:(?:www|link)\.)?deezer\.com\//i.test(raw);
  }
}

// Parses Deezer URLs into typed entities for Deezer mapping and metadata flow.
export function parseDeezerUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return { type: "unknown", id: null, view: "" };

  let match = raw.match(/^deezer:(track|album|playlist|artist):(\d+)$/i);
  if (match) {
    return {
      type: match[1].toLowerCase(),
      id: Math.round(Number(match[2])),
      view: ""
    };
  }

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (!/(^|\.)deezer\.com$/.test(host)) {
      return { type: "unknown", id: null, view: "" };
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (!parts.length) return { type: "unknown", id: null, view: "" };

    const first = String(parts[0] || "").toLowerCase();
    const second = String(parts[1] || "").toLowerCase();
    const searchIndex = first === "search"
      ? 0
      : second === "search"
        ? 1
        : -1;
    if (searchIndex >= 0) {
      const locale = searchIndex === 1 ? first : "";
      const localeIsValid = !locale || /^[a-z]{2}(?:-[a-z]{2})?$/.test(locale);
      const rawQuery = String(parts[searchIndex + 1] || "").trim();
      const view = String(parts[searchIndex + 2] || "").toLowerCase();
      let query = "";
      try {
        query = decodeURIComponent(rawQuery.replace(/\+/g, "%20")).trim();
      } catch {
        query = rawQuery.trim();
      }

      // Deezer uses /search/<artist>/track when opening an artist track search.
      if (
        localeIsValid &&
        query &&
        view === "track" &&
        parts.length === searchIndex + 3
      ) {
        return {
          type: "artist_search",
          id: null,
          query,
          view,
          locale
        };
      }

      return { type: "unknown", id: null, view: "" };
    }

    const smartTracklistIndex =
      String(parts[0] || "").toLowerCase() === "smarttracklist"
        ? 0
        : String(parts[1] || "").toLowerCase() === "smarttracklist"
          ? 1
          : -1;
    if (smartTracklistIndex >= 0) {
      const locale = smartTracklistIndex === 1
        ? String(parts[0] || "").toLowerCase()
        : "";
      const smartTracklistId = String(parts[smartTracklistIndex + 1] || "").toLowerCase();
      const localeIsValid = !locale || /^[a-z]{2}(?:-[a-z]{2})?$/.test(locale);
      if (
        localeIsValid &&
        parts.length === smartTracklistIndex + 2 &&
        DEEZER_SMARTTRACKLIST_ID.test(smartTracklistId)
      ) {
        return {
          type: "smarttracklist",
          id: smartTracklistId,
          view: "",
          locale
        };
      }
      return { type: "unknown", id: null, view: "" };
    }

    let typeIndex = 0;

    if (!DEEZER_RESOURCE_TYPES.includes(first) && DEEZER_RESOURCE_TYPES.includes(second)) {
      typeIndex = 1;
    }

    const type = String(parts[typeIndex] || "").toLowerCase();
    const id = numberOrNull(parts[typeIndex + 1]);
    const view = String(parts[typeIndex + 2] || "").toLowerCase();

    if (!DEEZER_RESOURCE_TYPES.includes(type) || !id || id <= 0) {
      return { type: "unknown", id: null, view: "" };
    }

    return {
      type,
      id: Math.round(id),
      view
    };
  } catch {
    return { type: "unknown", id: null, view: "" };
  }
}

// Converts Deezer track payloads into internal metadata objects.
export function deezerTrackToMeta(track, albumResult = null) {
  if (!track) return null;

  const albumTrack = trackFromAlbumBundle(track, albumResult);
  const trackId = numberOrNull(track?.id);
  const albumId =
    numberOrNull(track?.album?.id) ??
    numberOrNull(albumResult?.id) ??
    null;
  const artistId =
    numberOrNull(track?.artist?.id) ??
    numberOrNull(albumResult?.artist?.id) ??
    null;
  const trackUrl = track?.link || buildDeezerPageUrl("track", trackId);
  const albumUrl =
    track?.album?.link ||
    albumResult?.link ||
    buildDeezerPageUrl("album", albumId);
  const artistUrl =
    track?.artist?.link ||
    albumResult?.artist?.link ||
    buildDeezerPageUrl("artist", artistId);
  const artistNames = collectDeezerArtistNames(track, albumResult);
  const artist = String(artistNames || track?.artist?.name || "").trim();
  const albumArtist = String(
    albumResult?.artist?.name ||
    track?.artist?.name ||
    artist
  ).trim();
  const releaseDate = String(
    track?.release_date ||
    albumResult?.release_date ||
    track?.album?.release_date ||
    ""
  ).trim();
  const explicit =
    track?.explicit_lyrics === true ||
    Number(track?.explicit_content_lyrics || 0) > 0;
  const label = String(albumResult?.label || "").trim();
  const genre = Array.isArray(albumResult?.genres?.data)
    ? String(albumResult.genres.data[0]?.name || "").trim()
    : "";
  const title = String(track?.title || track?.title_short || "").trim();
  const durationMs = numberOrNull(track?.duration)
    ? Math.round(Number(track.duration) * 1000)
    : null;

  return {
    title,
    track: title,
    artist,
    uploader: artist,
    album: String(albumResult?.title || track?.album?.title || "").trim(),
    album_artist: albumArtist,
    release_year: releaseDate ? releaseDate.slice(0, 4) : "",
    release_date: releaseDate,
    track_number:
      numberOrNull(track?.track_position) ??
      numberOrNull(albumTrack?.track_position),
    disc_number:
      numberOrNull(track?.disk_number) ??
      numberOrNull(albumTrack?.disk_number),
    track_total: numberOrNull(albumResult?.nb_tracks),
    disc_total: computeDiscTotal(albumResult),
    isrc: String(track?.isrc || "").trim(),
    coverUrl: pickCoverUrl(track, albumResult),
    thumbnailUrl: pickCoverUrl(track, albumResult),
    imageUrl: pickCoverUrl(track, albumResult),
    webpage_url: trackUrl,
    preview_url: String(track?.preview || "").trim(),
    genre,
    label,
    publisher: label,
    copyright: "",
    duration_ms: durationMs,
    advisory_rating: explicit ? "Explicit" : "Clean",
    explicit,
    deezer_track_id: trackId,
    deezer_album_id: albumId,
    deezer_artist_id: artistId,
    deezer_track_url: trackUrl,
    deezer_album_url: albumUrl,
    deezer_artist_url: artistUrl,
    deezerUrl: trackUrl,
    dzUrl: trackUrl,
    source_provider: "deezer",
    source_store: "deezer"
  };
}

// Converts Deezer gateway song rows into the public-API-shaped metadata model.
export function deezerGatewayTrackToMeta(track) {
  const trackId = numberOrNull(track?.SNG_ID ?? track?.TRACK_ID ?? track?.id);
  const title = String(track?.SNG_TITLE ?? track?.TITLE ?? track?.title ?? "").trim();
  if (!trackId || trackId <= 0 || !title) return null;

  const albumId = numberOrNull(track?.ALB_ID ?? track?.album?.id);
  const artistId = numberOrNull(track?.ART_ID ?? track?.artist?.id);
  const artistName = String(track?.ART_NAME ?? track?.artist?.name ?? "").trim();
  const albumTitle = String(track?.ALB_TITLE ?? track?.album?.title ?? "").trim();
  const pictureMd5 = String(
    track?.ALB_PICTURE ??
    track?.ALB_PICTURE_MD5 ??
    track?.album?.md5_image ??
    ""
  ).trim();
  const coverUrl = pictureMd5
    ? `https://cdn-images.dzcdn.net/images/cover/${encodeURIComponent(pictureMd5)}/1000x1000-000000-80-0-0.jpg`
    : "";

  return deezerTrackToMeta({
    id: Math.round(trackId),
    title,
    title_short: title,
    link: buildDeezerPageUrl("track", trackId),
    duration: numberOrNull(track?.DURATION ?? track?.duration),
    isrc: String(track?.ISRC ?? track?.isrc ?? "").trim(),
    release_date: String(
      track?.PHYSICAL_RELEASE_DATE ??
      track?.DIGITAL_RELEASE_DATE ??
      track?.release_date ??
      ""
    ).trim(),
    track_position: numberOrNull(track?.TRACK_NUMBER ?? track?.track_position),
    disk_number: numberOrNull(track?.DISK_NUMBER ?? track?.disk_number),
    explicit_lyrics:
      track?.EXPLICIT_LYRICS === "1" ||
      track?.EXPLICIT_LYRICS === true ||
      track?.explicit_lyrics === true,
    artist: {
      id: artistId,
      name: artistName,
      link: buildDeezerPageUrl("artist", artistId)
    },
    album: {
      id: albumId,
      title: albumTitle,
      link: buildDeezerPageUrl("album", albumId),
      cover: coverUrl,
      cover_big: coverUrl,
      cover_xl: coverUrl,
      md5_image: pictureMd5
    }
  });
}

// Hydrates personalized smart-tracklist rows through Deezer's public metadata API.
async function hydrateDeezerSmartTrackRows(rows = []) {
  const uniqueRows = [];
  const seen = new Set();
  for (const row of rows.slice(0, 500)) {
    const id = numberOrNull(row?.SNG_ID ?? row?.TRACK_ID ?? row?.id);
    if (!id || id <= 0 || seen.has(Math.round(id))) continue;
    seen.add(Math.round(id));
    uniqueRows.push(row);
  }

  const resolved = new Array(uniqueRows.length);
  let nextIndex = 0;
  const workerCount = Math.min(DEEZER_SMARTTRACKLIST_META_CONCURRENCY, uniqueRows.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < uniqueRows.length) {
        const index = nextIndex++;
        const row = uniqueRows[index];
        const id = numberOrNull(row?.SNG_ID ?? row?.TRACK_ID ?? row?.id);
        let meta = null;
        try {
          meta = await findDeezerTrackMetaById(id);
        } catch {}
        resolved[index] = buildDeezerResolvedItem(
          meta || deezerGatewayTrackToMeta(row)
        );
      }
    })
  );

  return resolved.filter((item) => item?.title);
}

// Resolves a personalized Deezer smart-tracklist using its authenticated web session.
async function resolveDeezerSmartTracklist(parsed) {
  const session = await createDeezerSmartTracklistSession();
  const lang = String(parsed?.locale || "en").split("-", 1)[0].toLowerCase();
  const requestOptions = {
    apiToken: session.apiToken,
    cookie: session.cookie
  };
  const [pageResponse, songsResponse] = await Promise.all([
    fetchDeezerGateway(
      "deezer.pageSmartTracklist",
      { smarttracklist_id: parsed.id, lang },
      requestOptions
    ),
    fetchDeezerGateway(
      "smartTracklist.getSongs",
      { smartTracklist_id: parsed.id },
      requestOptions
    )
  ]);

  const songRows = extractDeezerSmartTrackRows(songsResponse.payload);
  const pageRows = extractDeezerSmartTrackRows(pageResponse.payload);
  const rows = songRows.length ? songRows : pageRows;
  if (!rows.length) {
    throw deezerSmartTracklistError(
      "DEEZER_SMARTTRACKLIST_EMPTY",
      "Deezer returned no tracks for this inspired-by list. It may be unavailable or expired."
    );
  }

  const items = await hydrateDeezerSmartTrackRows(rows);
  if (!items.length) {
    throw deezerSmartTracklistError(
      "DEEZER_SMARTTRACKLIST_METADATA_NOT_FOUND",
      "Deezer smart-tracklist metadata could not be resolved."
    );
  }

  const pageData = pageResponse?.payload?.results?.DATA || {};
  const title = String(
    pageData.AUTO_GENERATED_TITLE ||
    pageData.TITLE ||
    `Deezer ${parsed.id}`
  ).trim();

  return {
    kind: "playlist",
    provider: "deezer",
    title,
    items
  };
}

// Builds lightweight resolved Deezer items for playlist and preview flow.
function buildDeezerResolvedItem(meta, fallback = {}) {
  const base = meta || fallback || {};
  const artist = String(base.artist || base.uploader || fallback.artist || "").trim();
  const title = String(base.track || base.title || fallback.title || "").trim();
  const webpageUrl =
    base.deezer_track_url ||
    base.deezerUrl ||
    base.dzUrl ||
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
    dzUrl: webpageUrl,
    deezerUrl: webpageUrl,
    webpage_url: webpageUrl,
    deezer_track_id: base.deezer_track_id ?? fallback.deezer_track_id ?? null,
    deezer_album_id: base.deezer_album_id ?? fallback.deezer_album_id ?? null,
    deezer_artist_id: base.deezer_artist_id ?? fallback.deezer_artist_id ?? null
  };
}

// Builds fallback Deezer titles for unresolved or partial entities.
function buildDeezerFallbackTitle(type = "", payload = null) {
  const title = String(payload?.title || payload?.name || "").trim();
  if (title) return title;
  if (type === "track") return "Deezer Track";
  if (type === "playlist") return "Deezer Playlist";
  if (type === "album") return "Deezer Album";
  if (type === "artist") return "Deezer Artist";
  return "Deezer";
}

// Loads Deezer track metadata by id for mapping and enrichment flow.
export async function findDeezerTrackMetaById(trackId) {
  const track = await lookupDeezerTrack(trackId);
  if (!track) return null;

  const albumBundle = await lookupDeezerAlbumBundle(track?.album?.id);
  const albumResult = albumBundle?.album || null;
  return deezerTrackToMeta(track, albumResult);
}

// Finds the best Deezer track metadata by artist/title query.
export async function findDeezerTrackMetaByQuery(
  artist,
  title,
  {
    album = "",
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
    durationMs
  );
  const cached = cacheGet(DEEZER_SEARCH_CACHE, cacheKey);
  if (cached !== undefined) return cached;

  const queries = [];
  const seen = new Set();
  const push = (value = "") => {
    const raw = String(value || "").trim();
    const key = norm(raw);
    if (!raw || !key || seen.has(key)) return;
    seen.add(key);
    queries.push(raw);
  };

  push([artistSafe, `"${titleSafe}"`].filter(Boolean).join(" "));
  push([artistSafe, titleSafe, album].filter(Boolean).join(" "));
  push([artistSafe, titleSafe].filter(Boolean).join(" "));
  push([titleSafe, artistSafe].filter(Boolean).join(" "));
  push(titleSafe);

  let bestResult = null;
  let bestScore = -1;

  for (const query of queries) {
    let results = [];
    try {
      results = await searchDeezerTracks(query, { limit });
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

  if (!bestResult || bestScore < 4) {
    cacheSet(DEEZER_SEARCH_CACHE, cacheKey, null, DEEZER_SEARCH_CACHE_MAX);
    return null;
  }

  let meta = null;
  try {
    meta = await findDeezerTrackMetaById(bestResult.id);
  } catch {}

  if (!meta) {
    try {
      const albumBundle = await lookupDeezerAlbumBundle(bestResult?.album?.id);
      meta = deezerTrackToMeta(bestResult, albumBundle?.album || null);
    } catch {
      meta = deezerTrackToMeta(bestResult, null);
    }
  }

  cacheSet(DEEZER_SEARCH_CACHE, cacheKey, meta, DEEZER_SEARCH_CACHE_MAX);
  return meta;
}

// Resolves only the display title for a supported Deezer URL without enumerating full albums/playlists/artists.
export async function resolveDeezerUrlTitle(url) {
  const canonicalUrl = await resolveDeezerCanonicalUrl(url);
  const parsed = parseDeezerUrl(canonicalUrl);

  if (parsed.type === "artist_search") {
    const query = String(parsed.query || "").trim();
    if (!query) throw new Error("Deezer search title could not be resolved");
    return `${query} - Tracks`;
  }

  if (parsed.type === "smarttracklist") {
    const resolved = await resolveDeezerSmartTracklist(parsed);
    const title = String(resolved?.title || "").trim();
    if (!title) throw new Error("Deezer smart-tracklist title could not be resolved");
    return title;
  }

  if (!parsed?.id || parsed.type === "unknown") {
    throw new Error("Unsupported Deezer URL");
  }

  if (parsed.type === "track") {
    const track = await lookupDeezerTrack(parsed.id);
    const title = [track?.artist?.name, track?.title]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" - ");
    if (!title) throw new Error("Deezer track title could not be resolved");
    return title;
  }

  if (parsed.type === "album") {
    const album = await lookupDeezerAlbum(parsed.id);
    const title = [album?.artist?.name, album?.title]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" - ");
    if (!title) throw new Error("Deezer album title could not be resolved");
    return title;
  }

  if (parsed.type === "playlist") {
    const playlist = await lookupDeezerPlaylist(parsed.id);
    const title = String(playlist?.title || "").trim();
    if (!title) throw new Error("Deezer playlist title could not be resolved");
    return title;
  }

  if (parsed.type === "artist") {
    const artist = await lookupDeezerArtist(parsed.id);
    const name = String(artist?.name || "").trim();
    if (!name) throw new Error("Deezer artist title could not be resolved");
    return `${name} - Top Tracks`;
  }

  throw new Error("Unsupported Deezer URL");
}

// Resolves Deezer URLs into preview-ready track collections for mapping flow.
export async function resolveDeezerUrlLite(url, _options = {}) {
  const canonicalUrl = await resolveDeezerCanonicalUrl(url);
  const parsed = parseDeezerUrl(canonicalUrl);

  if (parsed.type === "artist_search") {
    return resolveDeezerArtistSearch(parsed, {
      maxItems: _options?.maxItems ?? DEEZER_ARTIST_SEARCH_MAX_TRACKS,
      pageSize: _options?.pageSize ?? DEEZER_ARTIST_SEARCH_PAGE_SIZE,
      streamBatches: _options?.streamBatches === true
    });
  }

  if (!parsed?.id || parsed.type === "unknown") {
    throw new Error("Unsupported Deezer URL");
  }

  if (parsed.type === "smarttracklist") {
    return resolveDeezerSmartTracklist(parsed);
  }

  if (parsed.type === "track") {
    const meta = await findDeezerTrackMetaById(parsed.id);
    if (!meta) {
      throw new Error("Deezer track metadata not found");
    }

    const title = [meta.artist, meta.track || meta.title]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" - ");

    return {
      kind: "track",
      provider: "deezer",
      title: title || buildDeezerFallbackTitle("track", meta),
      items: [buildDeezerResolvedItem(meta)]
    };
  }

  if (parsed.type === "album") {
    const bundle = await lookupDeezerAlbumBundle(parsed.id);
    const albumResult = bundle?.album || null;
    const tracks = Array.isArray(bundle?.tracks) ? bundle.tracks : [];
    if (!albumResult || !tracks.length) {
      throw new Error("Deezer album metadata not found");
    }

    const items = tracks
      .map((track) => buildDeezerResolvedItem(deezerTrackToMeta(track, albumResult)))
      .filter((item) => item.title);

    if (!items.length) {
      throw new Error("Deezer album metadata not found");
    }

    const artistName = String(albumResult?.artist?.name || "").trim();
    const title = [artistName, albumResult.title]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" - ");

    return {
      kind: "playlist",
      provider: "deezer",
      title: title || buildDeezerFallbackTitle("album", albumResult),
      items
    };
  }

  if (parsed.type === "playlist") {
    const bundle = await lookupDeezerPlaylistBundle(parsed.id);
    const playlistResult = bundle?.playlist || null;
    const tracks = Array.isArray(bundle?.tracks) ? bundle.tracks : [];
    if (!playlistResult || !tracks.length) {
      throw new Error("Deezer playlist metadata not found");
    }

    const albumBundleMap = await fetchAlbumBundleMap(tracks);
    const items = tracks
      .map((track) => {
        const albumId = numberOrNull(track?.album?.id);
        const albumResult = albumId ? albumBundleMap.get(albumId) || null : null;
        return buildDeezerResolvedItem(deezerTrackToMeta(track, albumResult));
      })
      .filter((item) => item.title);

    if (!items.length) {
      throw new Error("Deezer playlist metadata not found");
    }

    return {
      kind: "playlist",
      provider: "deezer",
      title:
        String(playlistResult?.title || "").trim() ||
        buildDeezerFallbackTitle("playlist", playlistResult),
      items
    };
  }

  if (parsed.type === "artist") {
    const bundle = await lookupDeezerArtistTopBundle(parsed.id);
    const artistResult = bundle?.artist || null;
    const tracks = Array.isArray(bundle?.tracks) ? bundle.tracks : [];
    if (!artistResult || !tracks.length) {
      throw new Error("Deezer artist top tracks not found");
    }

    const albumBundleMap = await fetchAlbumBundleMap(tracks);
    const items = tracks
      .map((track) => {
        const albumId = numberOrNull(track?.album?.id);
        const albumResult = albumId ? albumBundleMap.get(albumId) || null : null;
        return buildDeezerResolvedItem(deezerTrackToMeta(track, albumResult));
      })
      .filter((item) => item.title);

    if (!items.length) {
      throw new Error("Deezer artist top tracks not found");
    }

    const titleBase = String(artistResult?.name || "").trim();
    const title = titleBase ? `${titleBase} - Top Tracks` : buildDeezerFallbackTitle("artist", artistResult);

    return {
      kind: "playlist",
      provider: "deezer",
      title,
      items
    };
  }

  throw new Error("This type of Deezer URL is not supported yet");
}

// Resolves Deezer URLs using the shared lightweight Deezer resolver.
export async function resolveDeezerUrl(url, options = {}) {
  return resolveDeezerUrlLite(url, options);
}
