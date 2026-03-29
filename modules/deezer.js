import fetch from "node-fetch";

const DEEZER_API_BASE = "https://api.deezer.com";
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
const DEEZER_RESOURCE_TYPES = Object.freeze(["track", "album", "playlist", "artist"]);

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
    value.endsWith("deezer.page.link")
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
    const res = await fetch(raw, {
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
  const res = await fetch(url, {
    headers: DEEZER_WEB_HEADERS
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

    let typeIndex = 0;
    const first = String(parts[0] || "").toLowerCase();
    const second = String(parts[1] || "").toLowerCase();

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

// Resolves Deezer URLs into preview-ready track collections for mapping flow.
export async function resolveDeezerUrlLite(url, _options = {}) {
  const canonicalUrl = await resolveDeezerCanonicalUrl(url);
  const parsed = parseDeezerUrl(canonicalUrl);
  if (!parsed?.id || parsed.type === "unknown") {
    throw new Error("Unsupported Deezer URL");
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
