import { toNFC } from "./utils.js";

const YTM_ALBUM_ID_RE = /^MPRE[A-Za-z0-9_-]+$/i;

function cleanText(value = "") {
  return toNFC(String(value || "").replace(/\s+/g, " ").trim());
}

function parseAlbumPrefix(value = "") {
  const text = cleanText(value);
  const match = text.match(/^(album|albums|alb[üu]m(?:ler|leri|u|ü)?)/i);
  if (!match) return null;
  const rest = text.slice(match[0].length).trimStart();
  if (!rest || !"-–—:|".includes(rest[0])) return null;
  const payload = rest.slice(1).trim();
  return payload ? { prefix: match[0], payload } : null;
}

function foldText(value = "") {
  return cleanText(value)
    .toLocaleLowerCase("tr")
    .replace(/[ıİ]/g, "i")
    .replace(/[ğ]/g, "g")
    .replace(/[ü]/g, "u")
    .replace(/[ş]/g, "s")
    .replace(/[ö]/g, "o")
    .replace(/[ç]/g, "c")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const YTM_BYLINE_TYPE_RE = /^(?:song|songs|track|tracks|video|videos|album|albums|single|ep|playlist|playlists|artist|artists|podcast|episode|şarkı|şarkılar|sarki|sarkilar|parça|parca|albüm|albümler|albumler|çalma listesi|calma listesi|sanatçı|sanatci|bölüm|bolum)$/i;
const YTM_BYLINE_DURATION_RE = /^\d{1,3}:\d{2}(?::\d{2})?$/;
const YTM_BYLINE_YEAR_RE = /^(?:19|20)\d{2}$/;
const YTM_BYLINE_STAT_MAGNITUDES = new Set([
  "k", "m", "b", "mn", "bin", "milyon", "milyar", "million", "billion"
]);
const YTM_BYLINE_STAT_WORDS = new Set([
  "view", "views", "play", "plays", "listener", "listeners", "subscriber", "subscribers",
  "song", "songs", "track", "tracks", "goruntuleme", "izlenme", "dinlenme", "dinlendi",
  "abone", "sarki", "sarkilar", "parca", "icerik"
]);

function hasYtMusicStatSuffix(value = "") {
  const tokens = foldText(value).split(" ").filter(Boolean);
  if (!tokens.length || !/^\d+$/.test(tokens[0])) return false;

  let index = 1;
  while (index < tokens.length && /^\d+$/.test(tokens[index])) index += 1;
  if (YTM_BYLINE_STAT_MAGNITUDES.has(tokens[index])) index += 1;
  if (tokens[index] === "kez") index += 1;
  return YTM_BYLINE_STAT_WORDS.has(tokens[index]);
}

function stripYtMusicInlineStat(value = "") {
  for (const separator of [" - ", " – ", " — "]) {
    let offset = 0;
    while (offset < value.length) {
      const index = value.indexOf(separator, offset);
      if (index < 0) break;
      if (hasYtMusicStatSuffix(value.slice(index + separator.length))) {
        return cleanText(value.slice(0, index));
      }
      offset = index + separator.length;
    }
  }
  return value;
}

function splitYtMusicBylineParts(value = "") {
  const parts = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "•" && value[index] !== "·") continue;
    const part = cleanText(value.slice(start, index));
    if (part) parts.push(part);
    start = index + 1;
  }
  const lastPart = cleanText(value.slice(start));
  if (lastPart) parts.push(lastPart);
  return parts;
}

function isYtMusicBylineStat(value = "") {
  const text = cleanText(value);
  return !text || YTM_BYLINE_DURATION_RE.test(text) || YTM_BYLINE_YEAR_RE.test(text) || hasYtMusicStatSuffix(text);
}

// YouTube Music subtitles mix the content type, creator, counters and duration in one field.
// Keep only the creator portion so UI metadata cannot leak into tags and output filenames.
export function normalizeYtMusicByline(value = "") {
  const text = cleanText(value);
  if (!text) return "";

  const strippedInlineStats = stripYtMusicInlineStat(text);
  const parts = splitYtMusicBylineParts(strippedInlineStats);
  const hasTypePrefix = parts.length > 1 && YTM_BYLINE_TYPE_RE.test(parts[0]);
  const hasMetadataSuffix = parts.some((part, index) => index > 0 && isYtMusicBylineStat(part));
  const inlineStatsRemoved = strippedInlineStats !== text;

  if (!hasTypePrefix && !hasMetadataSuffix && !inlineStatsRemoved) return text;

  const candidates = (hasTypePrefix ? parts.slice(1) : parts)
    .filter((part) => !isYtMusicBylineStat(part) && !YTM_BYLINE_TYPE_RE.test(part));
  return cleanText(candidates[0] || "");
}

export function isGenericYtMusicAlbumLabel(value = "") {
  const folded = foldText(value);
  return folded === "album" || folded === "albums" || folded === "albumler" || folded === "albumleri";
}

export function stripYtMusicAlbumPrefix(value = "") {
  const text = cleanText(value);
  const parsed = parseAlbumPrefix(text);
  return parsed ? cleanText(parsed.payload) : text;
}

export function hasYtMusicAlbumPrefix(value = "") {
  return !!parseAlbumPrefix(value);
}

export function isYouTubeMusicAlbumUrl(value = "") {
  const source = String(value || "").trim();
  if (!source) return false;

  try {
    const url = new URL(source);
    const browseId = url.pathname.split("/").filter(Boolean).at(-1) || "";
    return (url.hostname.toLowerCase() === "youtube.com" || url.hostname.toLowerCase().endsWith(".youtube.com")) &&
      url.pathname.includes("/browse/") &&
      YTM_ALBUM_ID_RE.test(browseId);
  } catch {
    return /(?:music\.)?youtube\.com\/browse\/MPRE[A-Za-z0-9_-]+/i.test(source);
  }
}

export function isYtMusicAlbumContext(meta = {}, sourceUrl = "") {
  const urls = [
    sourceUrl,
    meta?.webpage_url,
    meta?.original_url,
    meta?.url
  ];
  if (urls.some(isYouTubeMusicAlbumUrl)) return true;

  const ids = [
    meta?.id,
    meta?.playlist_id,
    meta?.browseId,
    meta?.browse_id
  ].map((value) => String(value || "").trim());
  if (ids.some((id) => YTM_ALBUM_ID_RE.test(id))) return true;

  const type = String(meta?._type || meta?.type || meta?.ie_key || "").toLowerCase();
  if (type.includes("album")) return true;

  return hasYtMusicAlbumPrefix(meta?.title) || hasYtMusicAlbumPrefix(meta?.playlist_title);
}

function isUsefulAlbumArtist(value = "") {
  const text = cleanText(value);
  if (!text) return false;
  if (/^\d{4}$/.test(text)) return false;
  if (isGenericYtMusicAlbumLabel(text)) return false;
  return !/^(youtube|youtube music)$/i.test(text);
}

export function pickYtMusicAlbumArtist(...sources) {
  const candidates = [];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    candidates.push(
      source.album_artist,
      source.artist,
      source.artist_uploader,
      source.creator,
      source.uploader,
      source.channel
    );
  }

  for (const value of candidates) {
    const text = cleanText(value);
    if (isUsefulAlbumArtist(text)) return text;
  }

  return "";
}

function normalizeAlbumText(value = "", fallback = "") {
  const stripped = stripYtMusicAlbumPrefix(value);
  if (stripped) return stripped;
  return stripYtMusicAlbumPrefix(fallback);
}

export function normalizeYtMusicAlbumTitle(value = "", context = {}) {
  const text = cleanText(value);
  if (!text) return "";
  const isAlbum = context?.force || isYtMusicAlbumContext(context?.meta || {}, context?.sourceUrl || "") || hasYtMusicAlbumPrefix(text);
  if (isAlbum && isGenericYtMusicAlbumLabel(text)) return "";
  if (isAlbum) {
    return stripYtMusicAlbumPrefix(text);
  }
  return text;
}

export function normalizeYtMusicAlbumEntry(entry = {}, context = {}) {
  const normalizedEntry = {
    ...entry,
    uploader: normalizeYtMusicByline(entry?.uploader || entry?.channel || ""),
    artist: normalizeYtMusicByline(entry?.artist || entry?.artist_uploader || ""),
    album_artist: normalizeYtMusicByline(entry?.album_artist || "")
  };
  const parentMeta = context?.parentMeta || {};
  const sourceUrl = context?.sourceUrl || parentMeta?.webpage_url || parentMeta?.url || "";
  const isAlbum = context?.force || isYtMusicAlbumContext(parentMeta, sourceUrl) || isYtMusicAlbumContext(normalizedEntry, sourceUrl);
  if (!isAlbum && !hasYtMusicAlbumPrefix(normalizedEntry?.title) && !isGenericYtMusicAlbumLabel(normalizedEntry?.uploader || normalizedEntry?.artist)) {
    return normalizedEntry;
  }

  const parentTitle = context?.playlistTitle || parentMeta?.album || parentMeta?.title || parentMeta?.playlist_title || "";
  const albumArtist = normalizeYtMusicByline(context?.albumArtist) || pickYtMusicAlbumArtist(normalizedEntry, parentMeta);
  const title = normalizeAlbumText(normalizedEntry?.track || normalizedEntry?.title || normalizedEntry?.alt_title || normalizedEntry?.name || "", "");
  const album = normalizeAlbumText(normalizedEntry?.album || "", parentTitle);
  let uploader = cleanText(normalizedEntry?.uploader || normalizedEntry?.channel || "");
  let artist = cleanText(normalizedEntry?.artist || normalizedEntry?.artist_uploader || uploader || "");
  let albumArtistOut = cleanText(normalizedEntry?.album_artist || "");

  if (isGenericYtMusicAlbumLabel(uploader)) uploader = "";
  if (isGenericYtMusicAlbumLabel(artist)) artist = "";
  if (isGenericYtMusicAlbumLabel(albumArtistOut)) albumArtistOut = "";

  if (!artist && albumArtist) artist = albumArtist;
  if (!uploader && artist) uploader = artist;
  if (!albumArtistOut && (albumArtist || artist)) albumArtistOut = albumArtist || artist;

  return {
    ...normalizedEntry,
    title: title || cleanText(normalizedEntry?.title || ""),
    track: title || cleanText(normalizedEntry?.track || normalizedEntry?.title || ""),
    uploader,
    artist,
    album,
    album_artist: albumArtistOut
  };
}

export function normalizeYtMusicAlbumMeta(meta = {}, context = {}) {
  const sourceUrl = context?.sourceUrl || meta?.webpage_url || meta?.url || "";
  const isAlbum = context?.force || isYtMusicAlbumContext(meta, sourceUrl);
  if (!isAlbum && !hasYtMusicAlbumPrefix(meta?.title) && !isGenericYtMusicAlbumLabel(meta?.artist || meta?.uploader)) {
    return meta;
  }

  const albumArtist = cleanText(context?.albumArtist) || pickYtMusicAlbumArtist(meta, context?.parentMeta || {});
  const parentTitle =
    context?.playlistTitle ||
    context?.parentMeta?.album ||
    context?.parentMeta?.title ||
    context?.parentMeta?.playlist_title ||
    "";
  const out = { ...meta };

  if (out.title) out.title = normalizeAlbumText(out.title);
  if (out.track) out.track = normalizeAlbumText(out.track);
  if (out.album) out.album = normalizeAlbumText(out.album, parentTitle);
  else if (parentTitle) out.album = normalizeAlbumText(parentTitle);
  if (out.playlist_title) out.playlist_title = normalizeAlbumText(out.playlist_title);

  if (isGenericYtMusicAlbumLabel(out.artist)) out.artist = "";
  if (isGenericYtMusicAlbumLabel(out.uploader)) out.uploader = "";
  if (isGenericYtMusicAlbumLabel(out.album_artist)) out.album_artist = "";
  if (isGenericYtMusicAlbumLabel(out.title)) out.title = "";
  if (isGenericYtMusicAlbumLabel(out.track)) out.track = "";

  if (!out.artist && albumArtist) out.artist = albumArtist;
  if (!out.uploader && out.artist) out.uploader = out.artist;
  if (!out.album_artist && (albumArtist || out.artist)) out.album_artist = albumArtist || out.artist;

  return out;
}
