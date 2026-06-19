import { toNFC } from "./utils.js";

const ALBUM_PREFIX_RE = /^\s*(album|albums|alb[üu]m(?:ler|leri|u|ü)?)\s*[-–—:|]\s*(.+?)\s*$/i;
const YTM_ALBUM_ID_RE = /^MPRE[A-Za-z0-9_-]+$/i;

function cleanText(value = "") {
  return toNFC(String(value || "").replace(/\s+/g, " ").trim());
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

export function isGenericYtMusicAlbumLabel(value = "") {
  const folded = foldText(value);
  return folded === "album" || folded === "albums" || folded === "albumler" || folded === "albumleri";
}

export function stripYtMusicAlbumPrefix(value = "") {
  const text = cleanText(value);
  const match = text.match(ALBUM_PREFIX_RE);
  return match ? cleanText(match[2]) : text;
}

export function hasYtMusicAlbumPrefix(value = "") {
  return ALBUM_PREFIX_RE.test(cleanText(value));
}

export function isYouTubeMusicAlbumUrl(value = "") {
  const source = String(value || "").trim();
  if (!source) return false;

  try {
    const url = new URL(source);
    const browseId = url.pathname.split("/").filter(Boolean).at(-1) || "";
    return /(^|\.)youtube\.com$/i.test(url.hostname) &&
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
  const parentMeta = context?.parentMeta || {};
  const sourceUrl = context?.sourceUrl || parentMeta?.webpage_url || parentMeta?.url || "";
  const isAlbum = context?.force || isYtMusicAlbumContext(parentMeta, sourceUrl) || isYtMusicAlbumContext(entry, sourceUrl);
  if (!isAlbum && !hasYtMusicAlbumPrefix(entry?.title) && !isGenericYtMusicAlbumLabel(entry?.uploader || entry?.artist)) {
    return entry;
  }

  const parentTitle = context?.playlistTitle || parentMeta?.album || parentMeta?.title || parentMeta?.playlist_title || "";
  const albumArtist = cleanText(context?.albumArtist) || pickYtMusicAlbumArtist(entry, parentMeta);
  const title = normalizeAlbumText(entry?.track || entry?.title || entry?.alt_title || entry?.name || "", "");
  const album = normalizeAlbumText(entry?.album || "", parentTitle);
  let uploader = cleanText(entry?.uploader || entry?.channel || "");
  let artist = cleanText(entry?.artist || entry?.artist_uploader || uploader || "");
  let albumArtistOut = cleanText(entry?.album_artist || "");

  if (isGenericYtMusicAlbumLabel(uploader)) uploader = "";
  if (isGenericYtMusicAlbumLabel(artist)) artist = "";
  if (isGenericYtMusicAlbumLabel(albumArtistOut)) albumArtistOut = "";

  if (!artist && albumArtist) artist = albumArtist;
  if (!uploader && artist) uploader = artist;
  if (!albumArtistOut && (albumArtist || artist)) albumArtistOut = albumArtist || artist;

  return {
    ...entry,
    title: title || cleanText(entry?.title || ""),
    track: title || cleanText(entry?.track || entry?.title || ""),
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
