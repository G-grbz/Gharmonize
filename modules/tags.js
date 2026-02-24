import { searchSpotifyBestTrackStrict, trackToId3Meta } from "./spotify.js";
import { withMarketFallback } from "./market.js";

// Handles strip tail after delims in core application logic.
function stripTailAfterDelims(s = "") {
  let out = String(s || "").trim();

  // Trim obvious trailing promo parts such as "- Cover", "— Official Video", etc.
  out = out.replace(
    /\s*[–—-]\s*(cover|official\s*video|official\s*audio|audio|mv|hd|4k|lyrics?|lyric|visualizer|remaster(?:ed)?)\b.*$/i,
    ""
  ).trim();

  // Trim trailing separator chunks only when they start with known noise words.
  out = out.replace(
    /\s*(?:\||｜|\/|／|•|·|\bl\b)\s*(cover|official\s*video|official\s*audio|audio|mv|hd|4k|lyrics?|lyric|visualizer|remaster(?:ed)?)\b.*$/i,
    ""
  ).trim();

  // Titles using " l " may include extra source suffixes; keep the first two logical parts.
  const lParts = out.split(/\s+\bl\b\s+/i).map((p) => p.trim()).filter(Boolean);
  if (lParts.length >= 3) {
    const tail = lParts.slice(2).join(" ").toLowerCase();
    if (/(project|official|channel|records?|label|legend|anatolian|video|audio|lyrics?|:|—|–|-)/i.test(tail)) {
      out = `${lParts[0]} l ${lParts[1]}`.trim();
    }
  }

  return out;
}

// Normalizes title noise for core application logic.
function normalizeTitleNoise(s = "") {
  return String(s)
    .replace(/[–—]/g, "-")
    .replace(/\s*[\[\(（【〔﹝〖].*?[\]\)）】〕﹞〗]\s*/g, " ")
    .replace(/\s+(feat\.?|ft\.?|with)\s+.+$/i, " ")
    .replace(/\b(official\s*video|audio|mv|hd|4k|lyrics|lyric|visualizer|remastered|remaster|cover)\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Handles compact spaced letters in core application logic.
function compactSpacedLetters(s = "") {
  const tokens = String(s).trim().split(/\s+/);
  if (tokens.length >= 2 && tokens.every(t => t.length === 1)) {
    return tokens.join("").toUpperCase();
  }
  return s;
}

// Handles split artist title in core application logic.
function splitArtistTitle(title, uploader) {
  const t0 = stripTailAfterDelims(String(title || ""));
  const t  = normalizeTitleNoise(t0);
  let u = compactSpacedLetters(String(uploader || "").replace(/\s+/g, " ").trim());

  const m = t.match(/^\s*(.+?)\s*[–—-]\s*(.+)$/);
  if (m) {
    let left = m[1].trim();
    let rightRaw = m[2].trim();
    let right = stripTailAfterDelims(rightRaw);

    const episodeRe = /^\d+(\.\s*)?\s*(bölüm|bolum|episode|ep\.?)\b/i;
    const rightIsNoise = /^(cover|official\s*video|official\s*audio|audio|mv|hd|4k|lyrics?|lyric|visualizer|remaster(?:ed)?)\b/i.test(right);
    const leftLooksLikeFullTitle = /(?:\s+\bl\b\s+|[•|｜／/·:]|\s{2,})/i.test(left);

    if (episodeRe.test(right) && u) {
      return {
        artist: u,
        title: left
      };
    }
    if (rightIsNoise || leftLooksLikeFullTitle) {
      return {
        artist: u || "",
        title: left
      };
    }
    return {
      artist: left,
      title: right
    };
  }

  if (u && t) {
    return { artist: u, title: stripTailAfterDelims(t) };
  }
  return { artist: "", title: stripTailAfterDelims(t) };
}

// Handles sanitize you tube artist in core application logic.
function sanitizeYouTubeArtist(a = "") {
  return /^(youtube|youtube\s+mix)$/i.test(a.trim()) ? "" : a;
}

// Builds ID3 metadata from you tube for core application logic.
export function buildId3FromYouTube(ytLikeMeta) {
  const spl = splitArtistTitle(ytLikeMeta?.title, ytLikeMeta?.uploader);
  const artist = sanitizeYouTubeArtist(spl.artist);
  const title  = stripTailAfterDelims(spl.title);
  return {
    track: title || "",
    title: title || "",
    artist: artist || "",
    uploader: artist || "",
    album: "",
    release_year: "",
    release_date: "",
    track_number: null,
    disc_number: null,
    track_total: null,
    disc_total: null,
    isrc: "",
    coverUrl: ytLikeMeta?.thumbnail || null,
    spotifyUrl: "",
    webpage_url: ytLikeMeta?.webpage_url || ""
  };
}

// Resolves ID3 metadata from Spotify metadata fallback for core application logic.
export async function resolveId3FromSpotifyFallback(ytLikeMeta) {
  const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";
  if (!preferSpotify) {
    return null;
  }

  try {
    const { artist, title } = splitArtistTitle(
      ytLikeMeta?.title,
      ytLikeMeta?.uploader
    );
    if (!title) return null;

    const durationSec = Number.isFinite(ytLikeMeta?.duration)
      ? Number(ytLikeMeta.duration)
      : null;

    const options = {
      targetDurationSec: durationSec,
      titleRaw: ytLikeMeta?.title,
      minScore: 7
    };

    const preferredMarket = ytLikeMeta?.market;

    const found = await withMarketFallback(
      (market) => searchSpotifyBestTrackStrict(artist, title, market, options),
      preferredMarket
    );

    if (!found) return null;

    const meta = trackToId3Meta(found);
    return meta;
  } catch {
    return null;
  }
}

// Resolves ID3 metadata strict for you tube for core application logic.
export async function resolveId3StrictForYouTube(
  ytLikeMeta,
  { market = "TR", isPlaylist = false } = {}
) {
  const preferSpotify = process.env.PREFER_SPOTIFY_TAGS === "1";

  try {
    const { artist, title } = splitArtistTitle(
      ytLikeMeta?.title,
      ytLikeMeta?.uploader
    );
    if (!title) return null;

    let fromSpotify = null;

    if (preferSpotify) {
      if (isPlaylist) {
        const durationSec = Number.isFinite(ytLikeMeta?.duration)
          ? Number(ytLikeMeta.duration)
          : null;

        const options = {
          targetDurationSec: durationSec,
          titleRaw: ytLikeMeta?.title,
          minScore: 7
        };

        const preferredMarket = ytLikeMeta?.market || market;

        const found = await withMarketFallback(
          (m) => searchSpotifyBestTrackStrict(artist, title, m, options),
          preferredMarket
        );

        if (found) {
          fromSpotify = trackToId3Meta(found);
        }
      } else {
        fromSpotify = await resolveId3FromSpotifyFallback({
          ...ytLikeMeta,
          market: ytLikeMeta?.market || market
        });
      }
    }
    if (fromSpotify) {
      return fromSpotify;
    }
    return buildId3FromYouTube(ytLikeMeta);
  } catch {
    return buildId3FromYouTube(ytLikeMeta);
  }
}
