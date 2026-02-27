import 'dotenv/config';
import SpotifyWebApi from "spotify-web-api-node";
import { resolveMarket, withMarketFallback } from "./market.js";
import assert from "node:assert";

let _spotifyApiSingleton = null;
let _spotifyAccessToken = null;
let _spotifyTokenExpiresAtMs = 0;
const _SPOTIFY_TOKEN_SAFETY_WINDOW_MS = 60_000;

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

// Resolves Spotify metadata URL for Spotify mapping and metadata flow.
export async function resolveSpotifyUrl(url, { market } = {}) {
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

// Finds Spotify metadata meta by query for Spotify mapping and metadata flow.
export async function findSpotifyMetaByQuery(artist, title, market) {
  const artistSafe = String(artist || "").trim();
  const titleSafe = String(title || "").trim();
  if (!titleSafe) return null;

  let item = null;
  try {
    item = await searchSpotifyBestTrackStrict(artistSafe, titleSafe, market, {
      titleRaw: titleSafe,
      minScore: 7
    });
  } catch {}
  if (!item) return null;

  const api = await makeSpotify();
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

  return {
    title: item.name || "",
    track: item.name || "",
    artist: (item.artists || []).map(a => a?.name).filter(Boolean).join(", "),
    album: item.album?.name || "",
    album_artist: item.album?.artists?.[0]?.name || item.artists?.[0]?.name || "",
    release_year: (item.album?.release_date || "").slice(0, 4),
    release_date: item.album?.release_date || "",
    isrc: item.external_ids?.isrc || "",
    coverUrl: pickBestImage(album?.images || []),
    webpage_url: item.external_urls?.spotify || "",
    genre: genres[0] || "",
    label: album?.label || "",
    publisher: album?.label || "",
    copyright: copyrightText
  };
}
