import 'dotenv/config';
import SpotifyWebApi from "spotify-web-api-node";
import { resolveMarket, withMarketFallback } from "./market.js";
import fetch from "node-fetch";
import { findAppleTrackMetaByQuery } from "./apple.js";

let _spotifyApiSingleton = null;
let _spotifyAccessToken = null;
let _spotifyTokenExpiresAtMs = 0;
const _SPOTIFY_TOKEN_SAFETY_WINDOW_MS = 60_000;
const _SPOTIFY_PUBLIC_FETCH_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.8"
});
const _spotifyPublicHtmlCache = new Map();
const _spotifyPublicEmbedCache = new Map();
const _spotifyPublicTrackMetaCache = new Map();

// Checks whether Spotify metadata URL is valid for Spotify mapping and metadata flow.
export function isSpotifyUrl(url) {
  return /^(https?:\/\/open\.spotify\.com|spotify:)/i.test(String(url || ""));
}

// Parses Spotify metadata URL for Spotify mapping and metadata flow.
export function parseSpotifyUrl(url) {
  const s = String(url || "").trim();
  let m = s.match(/^spotify:(track|playlist|album):([A-Za-z0-9]+)$/i);
  if (m) return { type: m[1].toLowerCase(), id: m[2] };

  m = s.match(
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|playlist|album)\/([A-Za-z0-9]+)(?:[/?].*)?$/i
  );
  if (m) return { type: m[1].toLowerCase(), id: m[2] };

  return { type: "unknown", id: null };
}

// Checks whether personalized mix id is valid for Spotify mapping and metadata flow.
export function isPersonalizedMixId(id="") {
  const s = String(id || "");
  return /^37i9dQZF1E/i.test(s);
}

// Handles make Spotify metadata in Spotify mapping and metadata flow.
export async function makeSpotify() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET is required");
  }
  if (!_spotifyApiSingleton) {
    _spotifyApiSingleton = new SpotifyWebApi({ clientId, clientSecret });
  }

  const api = _spotifyApiSingleton;

  if (process.env.SPOTIFY_CLIENT_ID !== clientId || process.env.SPOTIFY_CLIENT_SECRET !== clientSecret) {
    _spotifyApiSingleton = new SpotifyWebApi({ clientId, clientSecret });
  }

  const now = Date.now();
  const tokenStillValid =
    _spotifyAccessToken &&
    (_spotifyTokenExpiresAtMs - _SPOTIFY_TOKEN_SAFETY_WINDOW_MS) > now;

  if (tokenStillValid) {
    api.setAccessToken(_spotifyAccessToken);
    return api;
  }

  const grant = await api.clientCredentialsGrant();
  const accessToken = grant?.body?.access_token;
  const expiresInSec = Number(grant?.body?.expires_in || 0);
  if (!accessToken || !expiresInSec) {
    throw new Error("Spotify token grant failed (missing access_token/expires_in)");
  }
  _spotifyAccessToken = accessToken;
  _spotifyTokenExpiresAtMs = now + (expiresInSec * 1000);
  api.setAccessToken(_spotifyAccessToken);
  return api;
}

// Selects best image for Spotify mapping and metadata flow.
export function pickBestImage(images=[]) {
  if (!Array.isArray(images) || !images.length) return null;
  return images.slice().sort((a,b)=> (b.width||0) - (a.width||0))[0]?.url || null;
}

function _cacheGet(cache, key) {
  return cache.has(key) ? cache.get(key) : undefined;
}

function _cacheSet(cache, key, value, max = 400) {
  cache.set(key, value);
  if (cache.size > max) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

function _pickBestPublicImage(entity) {
  const visualImages = Array.isArray(entity?.visualIdentity?.image)
    ? entity.visualIdentity.image.map((img) => ({
        url: img?.url || "",
        width: img?.maxWidth || 0,
        height: img?.maxHeight || 0
      }))
    : [];
  const coverSources = Array.isArray(entity?.coverArt?.sources)
    ? entity.coverArt.sources.map((img) => ({
        url: img?.url || "",
        width: img?.width || 0,
        height: img?.height || 0
      }))
    : [];
  return pickBestImage([...visualImages, ...coverSources]);
}

function _spotifyPageUrl(type, id) {
  return `https://open.spotify.com/${type}/${id}`;
}

function _spotifyEmbedUrl(type, id) {
  return `https://open.spotify.com/embed/${type}/${id}?utm_source=oembed`;
}

async function _fetchSpotifyHtml(url, cache) {
  const cached = _cacheGet(cache, url);
  if (cached !== undefined) return cached;

  const res = await fetch(url, {
    headers: _SPOTIFY_PUBLIC_FETCH_HEADERS
  });
  if (!res.ok) {
    throw new Error(`Spotify public fetch failed (${res.status})`);
  }

  const html = await res.text();
  _cacheSet(cache, url, html);
  return html;
}

function _extractNextData(html = "") {
  const match = String(html || "").match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i
  );
  if (!match?.[1]) return null;
  return JSON.parse(match[1]);
}

function _parseMetaContent(html = "", attr = "property", key = "") {
  const safeKey = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrRe = new RegExp(`${attr}="${safeKey}"`, "i");
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match?.[0] || "";
    if (!attrRe.test(tag)) continue;
    return tag.match(/\bcontent="([^"]*)"/i)?.[1] || "";
  }
  return "";
}

function _parseAllMetaContents(html = "", attr = "name", key = "") {
  const safeKey = String(key || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attrRe = new RegExp(`${attr}="${safeKey}"`, "i");
  const out = [];
  for (const match of String(html || "").matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match?.[0] || "";
    if (!attrRe.test(tag)) continue;
    const content = tag.match(/\bcontent="([^"]*)"/i)?.[1] || "";
    if (content) out.push(content);
  }
  return out;
}

function _parseSpotifyUriId(value = "", expectedType = "") {
  const raw = String(value || "").trim();
  let match = raw.match(/^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)$/i);
  if (match) {
    if (expectedType && match[1].toLowerCase() !== expectedType.toLowerCase()) {
      return null;
    }
    return match[2];
  }

  match = raw.match(
    /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)(?:[/?].*)?$/i
  );
  if (match) {
    if (expectedType && match[1].toLowerCase() !== expectedType.toLowerCase()) {
      return null;
    }
    return match[2];
  }

  return null;
}

async function _fetchSpotifyEmbedEntity(type, id) {
  const cacheKey = `${type}:${id}`;
  const cached = _cacheGet(_spotifyPublicEmbedCache, cacheKey);
  if (cached !== undefined) return cached;

  const html = await _fetchSpotifyHtml(_spotifyEmbedUrl(type, id), _spotifyPublicEmbedCache);
  const nextData = _extractNextData(html);
  const entity = nextData?.props?.pageProps?.state?.data?.entity || null;
  _cacheSet(_spotifyPublicEmbedCache, cacheKey, entity);
  return entity;
}

async function _fetchSpotifyPageHtml(type, id) {
  return _fetchSpotifyHtml(_spotifyPageUrl(type, id), _spotifyPublicHtmlCache);
}

function _normalizeArtistList(value = "") {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _buildPublicTrackItem(
  track,
  {
    albumTitle = "",
    albumArtist = "",
    trackTotal = null,
    discNumbers = [],
    albumCoverUrl = "",
    releaseDate = "",
    sourceType = ""
  } = {}
) {
  const uri = String(track?.uri || "");
  const spId = _parseSpotifyUriId(uri, "track");
  const trackNumber =
    Number.isFinite(track?.trackNumber) && track.trackNumber > 0
      ? Number(track.trackNumber)
      : Number.isFinite(track?.position) && track.position > 0
      ? Number(track.position)
      : null;
  const discNumber =
    trackNumber && Array.isArray(discNumbers) && Number.isFinite(discNumbers[trackNumber - 1])
      ? Number(discNumbers[trackNumber - 1])
      : null;

  return {
    title: track?.title || "",
    artist: _normalizeArtistList(
      track?.subtitle ||
        (Array.isArray(track?.artists)
          ? track.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
          : "")
    ),
    album: albumTitle || "",
    year: String(releaseDate || "").slice(0, 4) || "",
    date: releaseDate || "",
    track_number: trackNumber,
    disc_number: discNumber,
    track_total: trackTotal,
    disc_total:
      Array.isArray(discNumbers) && discNumbers.length
        ? Math.max(...discNumbers.filter((n) => Number.isFinite(n)))
        : null,
    isrc: "",
    coverUrl: sourceType === "playlist" ? "" : albumCoverUrl || "",
    spUrl: spId ? _spotifyPageUrl("track", spId) : "",
    album_artist: albumArtist || _normalizeArtistList(track?.subtitle || ""),
    label: "",
    copyright: "",
    genre: "",
    duration_ms: Number(track?.duration || 0) || null,
    spId
  };
}

async function _resolveSpotifyUrlPublic(url) {
  const { type, id } = parseSpotifyUrl(url);
  if (!id || type === "unknown") {
    throw new Error("Unsupported Spotify URL");
  }

  if (type === "track") {
    const [entity, pageHtml] = await Promise.all([
      _fetchSpotifyEmbedEntity("track", id),
      _fetchSpotifyPageHtml("track", id)
    ]);

    const albumId = _parseSpotifyUriId(
      _parseMetaContent(pageHtml, "name", "music:album"),
      "album"
    );
    let albumEntity = null;
    if (albumId) {
      try {
        albumEntity = await _fetchSpotifyEmbedEntity("album", albumId);
      } catch {}
    }

    const releaseDate =
      _parseMetaContent(pageHtml, "name", "music:release_date") ||
      entity?.releaseDate?.isoString ||
      albumEntity?.releaseDate?.isoString ||
      "";
    const trackNumberRaw = Number(
      _parseMetaContent(pageHtml, "name", "music:album:track") || 0
    );
    const albumTrackList = Array.isArray(albumEntity?.trackList) ? albumEntity.trackList : [];
    const trackTotal = albumTrackList.length || null;
    const trackNumber =
      Number.isFinite(trackNumberRaw) && trackNumberRaw > 0
        ? trackNumberRaw
        : (() => {
            const pos = albumTrackList.findIndex(
              (track) => _parseSpotifyUriId(track?.uri, "track") === id
            );
            return pos >= 0 ? pos + 1 : null;
          })();

    const albumCoverUrl = _pickBestPublicImage(entity) || _pickBestPublicImage(albumEntity) || "";
    const item = {
      title: entity?.title || entity?.name || "",
      artist: _normalizeArtistList(
        Array.isArray(entity?.artists)
          ? entity.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
          : ""
      ),
      album: albumEntity?.title || albumEntity?.name || "",
      year: String(releaseDate || "").slice(0, 4) || "",
      date: releaseDate || "",
      track_number: trackNumber,
      disc_number: null,
      track_total: trackTotal,
      disc_total: null,
      isrc: "",
      coverUrl: albumCoverUrl,
      spUrl: _spotifyPageUrl("track", id),
      album_artist: albumEntity?.subtitle || "",
      label: "",
      copyright: "",
      genre: "",
      duration_ms: Number(entity?.duration || 0) || null,
      spId: id,
      album_id: albumId || null
    };
    const richTrack = await findSpotifyMetaById(id);
    const mergedItem = { ...item };
    for (const [key, value] of Object.entries(richTrack || {})) {
      if (value == null) continue;
      if (typeof value === "string" && !value.trim()) continue;
      mergedItem[key] = value;
    }

    return {
      kind: "track",
      title: `${mergedItem.artist} - ${mergedItem.title}`.trim(),
      items: [mergedItem]
    };
  }

  if (type === "playlist") {
    if (isPersonalizedMixId(id)) {
      throw new Error("SPOTIFY_MIX_UNSUPPORTED: This URL is a personalized Spotify Mix. The Spotify Web API does not provide this content (404). Please copy the tracks from the mix into a new playlist in the Spotify app and use that playlist URL instead.");
    }

    const entity = await _fetchSpotifyEmbedEntity("playlist", id);
    const trackList = Array.isArray(entity?.trackList) ? entity.trackList : [];
    const items = trackList.map((track, index) =>
      _buildPublicTrackItem(
        { ...track, position: index + 1 },
        {
          albumTitle: "",
          albumArtist: "",
          trackTotal: null,
          discNumbers: [],
          albumCoverUrl: "",
          releaseDate: "",
          sourceType: "playlist"
        }
      )
    );

    return {
      kind: "playlist",
      title: entity?.title || entity?.name || "Spotify Playlist",
      items
    };
  }

  if (type === "album") {
    const [entity, pageHtml] = await Promise.all([
      _fetchSpotifyEmbedEntity("album", id),
      _fetchSpotifyPageHtml("album", id)
    ]);
    const trackList = Array.isArray(entity?.trackList) ? entity.trackList : [];
    const discNumbers = _parseAllMetaContents(pageHtml, "name", "music:song:disc")
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const releaseDate =
      _parseMetaContent(pageHtml, "name", "music:release_date") ||
      entity?.releaseDate?.isoString ||
      "";
    const albumCoverUrl =
      _pickBestPublicImage(entity) ||
      _parseMetaContent(pageHtml, "property", "og:image") ||
      "";
    const items = trackList.map((track, index) =>
      _buildPublicTrackItem(
        { ...track, trackNumber: index + 1 },
        {
          albumTitle: entity?.title || entity?.name || "",
          albumArtist: entity?.subtitle || "",
          trackTotal: trackList.length || null,
          discNumbers,
          albumCoverUrl,
          releaseDate,
          sourceType: "album"
        }
      )
    );

    const albumTitle = entity?.title || entity?.name || "Spotify Album";
    const albumArtist = entity?.subtitle || "";
    return {
      kind: "playlist",
      title: albumArtist ? `${albumArtist} - ${albumTitle}` : albumTitle,
      items
    };
  }

  throw new Error("This type of Spotify URL is not supported yet");
}

// Handles search Spotify metadata best track in Spotify mapping and metadata flow.
export async function searchSpotifyBestTrack(artist, title, market) {
  return searchSpotifyBestTrackStrict(artist, title, market, {});
}

// Handles norm in Spotify mapping and metadata flow.
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

function _foldLocaleChars(s = "") {
  return String(s).replace(
    /[IİıŞşĞğÜüÖöÇçßÆæŒœ]/g,
    (ch) => LOCALE_CHAR_FOLD_MAP[ch] || ch
  );
}

function _norm(s=""){
  return _foldLocaleChars(String(s))
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"")
    .replace(/&/g, " and ")
    .replace(/[\[\](){}"'“”‘’`´·•.,!?]/g," ")
    .replace(/\b(feat|ft|with)\b.*$/i,"")
    .replace(/\s+/g," ")
    .trim();
}

function _buildSearchQueries(artist, title) {
  const queries = [];
  const seen = new Set();

  const push = (q = "") => {
    const v = String(q || "").trim();
    if (!v) return;
    const key = _norm(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(v);
  };

  const main = [artist, title].filter(Boolean).join(" ").trim();
  const cross = [title, artist].filter(Boolean).join(" ").trim();

  push(main);
  push(cross);

  return queries;
}

function _stripTitleSearchNoise(s = "") {
  return String(s || "")
    .replace(
      /\s*[–—-]\s*(cover|official\s*video|official\s*audio|audio|mv|hd|4k|lyrics?|lyric|visualizer|remaster(?:ed)?)\b.*$/i,
      ""
    )
    .replace(/\s+(feat\.?|ft\.?|with)\s+.+$/i, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _buildTitleOnlyQueries(title, titleRaw) {
  const queries = [];
  const seen = new Set();

  const push = (q = "") => {
    const v = String(q || "").trim();
    if (!v) return;
    const key = _norm(v);
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(v);
  };

  push(title);
  push(_stripTitleSearchNoise(title));
  push(_stripTitleSearchNoise(titleRaw));

  return queries;
}

function _durationMatches(item, targetDurationSec) {
  if (!Number.isFinite(targetDurationSec) || !item?.duration_ms) return false;
  const spSec = Math.round(item.duration_ms / 1000);
  const tol = Math.max(2, Math.round(targetDurationSec * 0.02));
  return Math.abs(spSec - targetDurationSec) <= tol;
}

function _startsWithNormTitle(spTitleNorm = "", titleNorm = "") {
  if (!spTitleNorm || !titleNorm) return false;
  return spTitleNorm === titleNorm || spTitleNorm.startsWith(`${titleNorm} `);
}

// Handles search Spotify metadata best track strict in Spotify mapping and metadata flow.
export async function searchSpotifyBestTrackStrict(
  artist, title, market,
  {
    targetDurationSec = null,
    minScore = 7,
    titleRaw = null
  } = {}
) {
  try {
    const api = await makeSpotify();
    const queries = _buildSearchQueries(artist, title);
    if (!queries.length) return null;

    const mkt = resolveMarket(market);
    const aN = _norm(artist || "");
    const tN = _norm(title || "");
    const tRawN = _norm(titleRaw || title || "");
    const tTokenCount = tN ? tN.split(/\s+/).filter(Boolean).length : 0;

    // Handles score in Spotify mapping and metadata flow.
    const score = (it) => {
      const spTitle = _norm(it?.name || "");
      const spArtist = _norm(it?.artists?.[0]?.name || "");
      let s = 0;
      if (spTitle === tN || spTitle === tRawN) s += 4;
      else if (spTitle.includes(tN) || tN.includes(spTitle)) s += 2;
      if (aN) {
        if (spArtist === aN) s += 3;
        else if (spArtist.includes(aN) || aN.includes(spArtist)) s += 1;
      }

      if (_durationMatches(it, targetDurationSec)) s += 2;
      return s;
    };

    let best = null,
      bestScore = -1;
    const seenIds = new Set();
    for (const q of queries) {
      const resp = await api.searchTracks(q, {
        limit: 10,
        ...(mkt ? { market: mkt } : {})
      });
      const items = resp?.body?.tracks?.items || [];

      for (const it of items) {
        const id = it?.id || null;
        if (id && seenIds.has(id)) continue;
        if (id) seenIds.add(id);

        const s = score(it);
        if (s > bestScore) {
          best = it;
          bestScore = s;
        }
      }

      if (bestScore >= minScore) {
        return best;
      }
    }

    if (!tN) return null;

    const titleOnlyQueries = _buildTitleOnlyQueries(title, titleRaw);
    if (!titleOnlyQueries.length) return null;

    const seenRelaxedIds = new Set();
    let relaxedBest = null;
    let relaxedBestScore = -1;

    for (const q of titleOnlyQueries) {
      const resp = await api.searchTracks(q, {
        limit: 12,
        ...(mkt ? { market: mkt } : {})
      });
      const items = resp?.body?.tracks?.items || [];

      for (const it of items) {
        const id = it?.id || null;
        if (id && seenRelaxedIds.has(id)) continue;
        if (id) seenRelaxedIds.add(id);

        const spTitle = _norm(it?.name || "");
        const spArtist = _norm(it?.artists?.[0]?.name || "");
        if (!spTitle) continue;

        const titleExact = spTitle === tN || spTitle === tRawN;
        const titleContains = spTitle.includes(tN) || tN.includes(spTitle);
        if (!titleExact && !titleContains) continue;

        const startsWithTitle = _startsWithNormTitle(spTitle, tN);
        const artistExact = !!aN && spArtist === aN;
        const artistPartial =
          !!aN && !artistExact && (spArtist.includes(aN) || aN.includes(spArtist));
        const durationMatch = _durationMatches(it, targetDurationSec);

        let s = 0;
        if (titleExact) s += 6;
        else if (titleContains) s += 4;
        if (startsWithTitle) s += 2;
        if (artistExact) s += 3;
        else if (artistPartial) s += 1;
        if (durationMatch) s += 2;

        if (/\b(karaoke|cover|instrumental|nightcore|slowed|sped)\b/.test(spTitle)) {
          s -= 2;
        }

        const safeWithoutArtist = tTokenCount >= 5 && startsWithTitle;
        const acceptable =
          artistPartial || durationMatch || safeWithoutArtist;
        if (!acceptable) continue;

        if (s > relaxedBestScore) {
          relaxedBest = it;
          relaxedBestScore = s;
        }
      }
    }

    if (relaxedBest) {
      const relaxedMinScore = Math.max(7, minScore);
      if (relaxedBestScore >= relaxedMinScore) {
        return relaxedBest;
      }
    }
  } catch {}

  return null;
}

// Handles track to ID3 metadata meta in Spotify mapping and metadata flow.
export function trackToId3Meta(track) {
  if (!track) return null;
  const releaseDate = track.album?.release_date || "";
  const year = releaseDate.slice(0,4);
  const artist = (track.artists||[]).map(a=>a?.name).filter(Boolean).join(", ");
  const albumArtist = track.album?.artists?.[0]?.name || artist || "";
  const copyrightText = (track.album?.copyrights && track.album.copyrights[0]?.text) || "";
  const label = track.album?.label || "";
  return {
    track: track.name || "",
    title: track.name || "",
    artist,
    uploader: artist,
    album: track.album?.name || "",
    release_year: year || "",
    release_date: releaseDate || "",
    track_number: track.track_number || null,
    disc_number: track.disc_number || null,
    track_total: track.album?.total_tracks || null,
    disc_total: (track.album?.tracks?.items
                 ? Math.max(...track.album.tracks.items.map(t=>t.disc_number||1))
                 : null),
    isrc: track.external_ids?.isrc || "",
    coverUrl: pickBestImage(track.album?.images || []),
    spotifyUrl: track.external_urls?.spotify || "",
    album_artist: albumArtist,
    copyright: copyrightText,
    genre: "",
    album_id: track.album?.id || null,
    label: label,
    publisher: label
  };
}

export async function findSpotifyMetaById(id) {
  const trackId = String(id || "").trim();
  if (!trackId) return null;

  const cached = _cacheGet(_spotifyPublicTrackMetaCache, trackId);
  if (cached !== undefined) return cached;

  try {
    const [trackEntity, trackPageHtml] = await Promise.all([
      _fetchSpotifyEmbedEntity("track", trackId),
      _fetchSpotifyPageHtml("track", trackId)
    ]);

    if (!trackEntity) {
      _cacheSet(_spotifyPublicTrackMetaCache, trackId, null);
      return null;
    }

    const albumId = _parseSpotifyUriId(
      _parseMetaContent(trackPageHtml, "name", "music:album"),
      "album"
    );

    let albumEntity = null;
    let albumPageHtml = "";
    if (albumId) {
      try {
        [albumEntity, albumPageHtml] = await Promise.all([
          _fetchSpotifyEmbedEntity("album", albumId),
          _fetchSpotifyPageHtml("album", albumId)
        ]);
      } catch {}
    }

    const albumTrackList = Array.isArray(albumEntity?.trackList)
      ? albumEntity.trackList
      : [];
    const releaseDate =
      _parseMetaContent(trackPageHtml, "name", "music:release_date") ||
      trackEntity?.releaseDate?.isoString ||
      albumEntity?.releaseDate?.isoString ||
      "";
    const trackNumberMeta = Number(
      _parseMetaContent(trackPageHtml, "name", "music:album:track") || 0
    );
    const trackIndex = albumTrackList.findIndex(
      (track) => _parseSpotifyUriId(track?.uri, "track") === trackId
    );
    const trackNumber =
      Number.isFinite(trackNumberMeta) && trackNumberMeta > 0
        ? trackNumberMeta
        : trackIndex >= 0
        ? trackIndex + 1
        : null;
    const discNumbers = _parseAllMetaContents(
      albumPageHtml,
      "name",
      "music:song:disc"
    )
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const discNumber =
      trackNumber && Number.isFinite(discNumbers[trackNumber - 1])
        ? Number(discNumbers[trackNumber - 1])
        : null;
    const coverUrl =
      _pickBestPublicImage(trackEntity) ||
      _pickBestPublicImage(albumEntity) ||
      _parseMetaContent(trackPageHtml, "property", "og:image") ||
      _parseMetaContent(albumPageHtml, "property", "og:image") ||
      "";
    const artist = _normalizeArtistList(
      Array.isArray(trackEntity?.artists)
        ? trackEntity.artists.map((item) => item?.name).filter(Boolean).join(", ")
        : ""
    );
    const meta = {
      title: trackEntity?.title || trackEntity?.name || "",
      track: trackEntity?.title || trackEntity?.name || "",
      artist,
      album: albumEntity?.title || albumEntity?.name || "",
      album_artist: albumEntity?.subtitle || artist || "",
      release_year: String(releaseDate || "").slice(0, 4) || "",
      release_date: releaseDate || "",
      isrc: "",
      coverUrl,
      webpage_url: _spotifyPageUrl("track", trackId),
      genre: "",
      label: "",
      publisher: "",
      copyright: "",
      track_number: trackNumber,
      disc_number: discNumber,
      track_total: albumTrackList.length || null,
      disc_total:
        discNumbers.length > 0 ? Math.max(...discNumbers) : null,
      duration_ms: Number(trackEntity?.duration || 0) || null,
      spId: trackId,
      album_id: albumId || null
    };

    const appleMeta = await findAppleTrackMetaByQuery(artist, meta.title, {
      album: meta.album || "",
      targetDurationMs: meta.duration_ms || null
    });
    const merged = { ...meta };
    for (const [key, value] of Object.entries(appleMeta || {})) {
      if (value == null) continue;
      if (typeof value === "string" && !value.trim()) continue;
      if (merged[key] == null || merged[key] === "") {
        merged[key] = value;
      }
    }

    _cacheSet(_spotifyPublicTrackMetaCache, trackId, merged);
    return merged;
  } catch {
    _cacheSet(_spotifyPublicTrackMetaCache, trackId, null);
    return null;
  }
}

// Loads track for Spotify mapping and metadata flow.
async function fetchTrack(api, id, market) {
  const t = await withMarketFallback(async (mkt) => {
    const r = await api.getTrack(id, { ...(mkt ? { market: mkt } : {}) });
    return r?.body || null;
  }, resolveMarket(market));
  if (!t) throw new Error("Track could not be fetched");
  const meta = trackToId3Meta(t);

    let albumInfo = null, artistGenres = [];
  try {
    if (t.album?.id) {
      const a = await api.getAlbum(t.album.id);
      albumInfo = a?.body || null;
    }
  } catch {}
  try {
    if (t.artists?.[0]?.id) {
      const ar = await api.getArtist(t.artists[0].id);
      artistGenres = ar?.body?.genres || [];
    }
  } catch {}

  const copyrightText = (albumInfo?.copyrights && albumInfo.copyrights[0]?.text) || "";
  const genreStr = (albumInfo?.genres && albumInfo.genres[0]) || (artistGenres[0] || "");

  return {
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    year: meta.release_year,
    date: meta.release_date,
    track_number: meta.track_number,
    disc_number: meta.disc_number,
    track_total: meta.track_total,
    disc_total: meta.disc_total,
    isrc: meta.isrc,
    spUrl: meta.spotifyUrl,
    coverUrl: meta.coverUrl,
    album_artist: meta.album_artist,
    label: albumInfo?.label || meta.label || "",
    copyright: copyrightText || "",
    genre: genreStr || ""
  };
}

// Loads playlist data items for Spotify mapping and metadata flow.
async function fetchPlaylistItems(api, id, market) {
  const out = [];
  const albumCache = new Map();
  const artistCache = new Map();
  let page = await withMarketFallback(async (mkt) => {
    const r = await api.getPlaylistTracks(id, { limit: 100, ...(mkt ? { market: mkt } : {}) });
    return r || null;
  }, resolveMarket(market));
  if (!page) return out;
  while (true) {
    for (const it of page.body.items || []) {
      const t = it.track;
      if (!t) continue;
      const meta = trackToId3Meta(t);
      if (meta?.title && meta?.artist) {
        let albumInfo = null, artistGenres = [];
        try {
          const albId = t.album?.id;
          if (albId) {
            if (albumCache.has(albId)) albumInfo = albumCache.get(albId);
            else {
              const a = await api.getAlbum(albId);
              albumInfo = a?.body || null;
              albumCache.set(albId, albumInfo);
            }
          }
        } catch {}
        try {
          const arId = t.artists?.[0]?.id;
          if (arId) {
            if (artistCache.has(arId)) artistGenres = artistCache.get(arId);
            else {
              const ar = await api.getArtist(arId);
              artistGenres = ar?.body?.genres || [];
              artistCache.set(arId, artistGenres);
            }
          }
        } catch {}
        const copyrightText = (albumInfo?.copyrights && albumInfo.copyrights[0]?.text) || "";
        const genreStr = (albumInfo?.genres && albumInfo.genres[0]) || (artistGenres[0] || "");
        out.push({
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          year: meta.release_year,
          date: meta.release_date,
          track_number: meta.track_number,
          disc_number: meta.disc_number,
          track_total: meta.track_total,
          disc_total: meta.disc_total,
          isrc: meta.isrc,
          coverUrl: meta.coverUrl,
          spUrl: meta.spotifyUrl,
          album_artist: meta.album_artist,
          label: albumInfo?.label || meta.label || "",
          copyright: copyrightText || "",
          genre: genreStr || ""
        });
      }
    }
    if (page.body.next) {
      const url = new URL(page.body.next);
      const offset = Number(url.searchParams.get("offset") || 0);
      page = await withMarketFallback(async (mkt) => {
        const r = await api.getPlaylistTracks(id, { limit: 100, offset, ...(mkt ? { market: mkt } : {}) });
        return r || null;
      }, resolveMarket(market));
      if (!page) break;
    } else break;
  }
  return out;
}

// Loads album items for Spotify mapping and metadata flow.
async function fetchAlbumItems(api, id, market) {
  const out = [];
  let page = await withMarketFallback(async (mkt) => {
    const r = await api.getAlbumTracks(id, { limit: 50, ...(mkt ? { market: mkt } : {}) });
    return r || null;
  }, resolveMarket(market));
  if (!page) return out;

  let albumInfo = null;
  try {
    const albumData = await withMarketFallback(async (mkt) => {
      const r = await api.getAlbum(id, { ...(mkt ? { market: mkt } : {}) });
      return r?.body || null;
    }, resolveMarket(market));

    if (albumData) {
      albumInfo = {
        name: albumData.name,
        artist: albumData.artists?.[0]?.name || "",
        release_date: albumData.release_date || "",
        total_tracks: albumData.total_tracks,
        coverUrl: pickBestImage(albumData.images || []),
        label: albumData.label || "",
        genres: albumData.genres || [],
        copyrights: albumData.copyrights || []
      };
    }
  } catch (e) {
    console.warn("Album info could not be fetched:", e);
  }

  while (true) {
    for (const track of page.body.items || []) {
      const meta = trackToId3Meta({
        ...track,
        album: {
          name: albumInfo?.name || "",
          release_date: albumInfo?.release_date || "",
          total_tracks: albumInfo?.total_tracks || null,
          images: albumInfo?.coverUrl ? [{ url: albumInfo.coverUrl }] : [],
          artists: [{ name: albumInfo?.artist || "" }],
          label: albumInfo?.label || null
        }
      });

      if (meta?.title && meta?.artist) {
        out.push({
          title: meta.title,
          artist: meta.artist,
          album: albumInfo?.name || "",
          year: meta.release_year,
          date: meta.release_date,
          track_number: meta.track_number,
          disc_number: meta.disc_number,
          track_total: albumInfo?.total_tracks || null,
          disc_total: meta.disc_total,
          isrc: meta.isrc,
          coverUrl: albumInfo?.coverUrl,
          spUrl: `https://open.spotify.com/track/${track.id}`,
          album_artist: albumInfo?.artist || meta.album_artist || "",
          label: albumInfo?.label || "",
          copyright: (albumInfo?.copyrights && albumInfo.copyrights[0]?.text) || "",
          genre: (albumInfo?.genres && albumInfo.genres[0]) || ""
        });
      }
    }

    if (page.body.next) {
      const url = new URL(page.body.next);
      const offset = Number(url.searchParams.get("offset") || 0);
      page = await withMarketFallback(async (mkt) => {
        const r = await api.getAlbumTracks(id, { limit: 50, offset, ...(mkt ? { market: mkt } : {}) });
        return r || null;
      }, resolveMarket(market));
      if (!page) break;
    } else {
      break;
    }
  }
  return out;
}

// Resolves Spotify metadata URL via Spotify Web API for Spotify mapping and metadata flow.
async function _resolveSpotifyUrlViaApi(url, { market } = {}) {
  const { type, id } = parseSpotifyUrl(url);
  if (!id || type === "unknown") throw new Error("Unsupported Spotify URL");

  const api = await makeSpotify();

  if (type === "track") {
    const t = await fetchTrack(api, id, market);
    const title = `${t.artist} - ${t.title}`;
    return { kind: "track", title, items: [t] };
  }

  if (type === "playlist") {
    if (isPersonalizedMixId(id)) {
      throw new Error("SPOTIFY_MIX_UNSUPPORTED: This URL is a personalized Spotify Mix. The Spotify Web API does not provide this content (404). Please copy the tracks from the mix into a new playlist in the Spotify app and use that playlist URL instead.");
    }
    let plTitle = "Spotify Playlist";
    try {
      const pl = (await api.getPlaylist(id, { fields: "name" })).body;
      plTitle = pl?.name || plTitle;
    } catch {}
    let items;
    try {
      items = await fetchPlaylistItems(api, id, market);
    } catch (e) {
      const msg = String(e?.message || "");
      const notFound = /Resource not found|status\s*:\s*404/i.test(msg);
      if (notFound || isPersonalizedMixId(id)) {
        throw new Error("SPOTIFY_MIX_UNSUPPORTED: This URL may be a personalized or inaccessible Mix. The Spotify Web API does not provide this content (404). Please copy the tracks from the mix into a new playlist in the Spotify app and use that playlist URL instead.");
      }
      throw e;
    }
    return { kind: "playlist", title: plTitle, items };
  }

  if (type === "album") {
    let albumTitle = "Spotify Album";
    let albumArtist = "";

    try {
      const albumData = await withMarketFallback(async (mkt) => {
        const r = await api.getAlbum(id, { ...(mkt ? { market: mkt } : {}) });
        return r?.body || null;
      }, resolveMarket(market));

      if (albumData) {
        albumTitle = albumData.name;
        albumArtist = albumData.artists?.[0]?.name || "";
      }
    } catch (e) {
      console.warn("Album title could not be retrieved:", e);
    }

    const items = await fetchAlbumItems(api, id, market);
    const title = albumArtist ? `${albumArtist} - ${albumTitle}` : albumTitle;

    return { kind: "playlist", title, items };
  }

  throw new Error("This type of Spotify URL is not supported yet");
}

export async function resolveSpotifyUrlLite(url, { market } = {}) {
  try {
    return await _resolveSpotifyUrlPublic(url);
  } catch (publicError) {
    try {
      return await _resolveSpotifyUrlViaApi(url, { market });
    } catch {
      throw publicError;
    }
  }
}

// Resolves Spotify metadata URL for Spotify mapping and metadata flow.
export async function resolveSpotifyUrl(url, { market } = {}) {
  return resolveSpotifyUrlLite(url, { market });
}

// Finds Spotify metadata meta by query for Spotify mapping and metadata flow.
export async function findSpotifyMetaByQuery(artist, title, market) {
  const artistSafe = String(artist || "").trim();
  const titleSafe = String(title || "").trim();
  if (!titleSafe) return null;

  const fromApple = async () => findAppleTrackMetaByQuery(artistSafe, titleSafe, {
    market
  });

  let item = null;
  try {
    item = await searchSpotifyBestTrackStrict(artistSafe, titleSafe, market, {
      titleRaw: titleSafe,
      minScore: 7
    });
  } catch {}

  if (!item) {
    return fromApple();
  }

  const publicTrackId = String(item?.id || "").trim();
  if (publicTrackId) {
    const publicMeta = await findSpotifyMetaById(publicTrackId);
    if (publicMeta) {
      const appleMeta = await fromApple();
      return {
        ...appleMeta,
        ...publicMeta,
        genre: publicMeta.genre || appleMeta?.genre || "",
        label: publicMeta.label || appleMeta?.label || "",
        publisher: publicMeta.publisher || appleMeta?.publisher || appleMeta?.label || "",
        copyright: publicMeta.copyright || appleMeta?.copyright || "",
        album: publicMeta.album || appleMeta?.album || "",
        album_artist: publicMeta.album_artist || appleMeta?.album_artist || publicMeta.artist || "",
        track_number: publicMeta.track_number ?? appleMeta?.track_number ?? null,
        disc_number: publicMeta.disc_number ?? appleMeta?.disc_number ?? null,
        track_total: publicMeta.track_total ?? appleMeta?.track_total ?? null,
        disc_total: publicMeta.disc_total ?? appleMeta?.disc_total ?? null,
        coverUrl: publicMeta.coverUrl || appleMeta?.coverUrl || "",
        webpage_url: publicMeta.webpage_url || appleMeta?.webpage_url || ""
      };
    }
  }

  let api = null;
  try {
    api = await makeSpotify();
  } catch {
    return fromApple();
  }
  let album = null, leadArtist = null;
  try {
    if (item.album?.id) {
      album = (await api.getAlbum(item.album.id, { ...(market ? { market: resolveMarket(market) } : {}) }))?.body || null;
    }
  } catch {}
  try {
    if (item.artists?.[0]?.id) {
      leadArtist = (await api.getArtist(item.artists[0].id))?.body || null;
    }
  } catch {}

  const genres = (album?.genres?.length ? album.genres : (leadArtist?.genres || [])) || [];
  const copyrightText = (album?.copyrights && album.copyrights[0]?.text) || "";
  const appleMeta = await fromApple();

  return {
    title: item.name || appleMeta?.title || "",
    track: item.name || appleMeta?.track || "",
    artist: (item.artists || []).map(a => a?.name).filter(Boolean).join(", ") || appleMeta?.artist || "",
    album: item.album?.name || appleMeta?.album || "",
    album_artist: item.album?.artists?.[0]?.name || item.artists?.[0]?.name || appleMeta?.album_artist || "",
    release_year: (item.album?.release_date || "").slice(0, 4) || appleMeta?.release_year || "",
    release_date: item.album?.release_date || appleMeta?.release_date || "",
    isrc: item.external_ids?.isrc || appleMeta?.isrc || "",
    coverUrl: pickBestImage(album?.images || []) || appleMeta?.coverUrl || "",
    webpage_url: item.external_urls?.spotify || appleMeta?.webpage_url || "",
    genre: genres[0] || appleMeta?.genre || "",
    label: album?.label || appleMeta?.label || "",
    publisher: album?.label || appleMeta?.publisher || appleMeta?.label || "",
    copyright: copyrightText || appleMeta?.copyright || "",
    track_number: appleMeta?.track_number ?? null,
    disc_number: appleMeta?.disc_number ?? null,
    track_total: appleMeta?.track_total ?? null,
    disc_total: appleMeta?.disc_total ?? null
  };
}
