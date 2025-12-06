import fs from "fs";
import path from "path";
import { getCache, setCache } from "./cache.js";

const LYRICS_CACHE_TTL = 24 * 60 * 60 * 1000;

function emitLog(onLog, payload) {
  if (payload?.fallback) console.log(payload.fallback);
  if (onLog) onLog(payload);
}

function normalizeArtistName(name = "") {
  if (!name) return "";

  return name
    .replace(/\bofficial\b/gi, "")
    .replace(/\btopic\b/gi, "")
    .replace(/\bvevo\b/gi, "")
    .replace(/\((.*?)official(.*?)\)/gi, "")
    .replace(/\((.*?)video(.*?)\)/gi, "")
    .replace(/\((.*?)audio(.*?)\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTitle(name = "") {
  if (!name) return "";

  return name
    .replace(/\((.*?)official(.*?)\)/gi, "")
    .replace(/\((.*?)video(.*?)\)/gi, "")
    .replace(/\((.*?)audio(.*?)\)/gi, "")
    .replace(/\[(.*?)official(.*?)\]/gi, "")
    .replace(/\[(.*?)video(.*?)\]/gi, "")
    .replace(/\[(.*?)audio(.*?)\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export class LyricsFetcher {
  constructor() {
    this.baseURL = "https://lrclib.net/api";
  }

  async searchLyrics(artist, title, duration = null, options = {}) {
    const { onLog = null } = options;
    const cacheKey = `lyrics_${artist}_${title}_${duration}`;

    const searchLogMsg = {
      logKey: "log.lyrics.searching",
      logVars: { artist, title },
      fallback: `🔍 Searching lyrics: "${artist}" - "${title}"`,
    };
    emitLog(onLog, searchLogMsg);

    const cached = getCache(cacheKey);
    if (cached && Date.now() - cached.timestamp < LYRICS_CACHE_TTL) {
      const cachedLogMsg = {
        logKey: "log.lyrics.cached",
        logVars: { title },
        fallback: `✅ Loaded from cache: ${title}`,
      };
      emitLog(onLog, cachedLogMsg);
      return cached.data;
    }

    try {
      const params = new URLSearchParams({
        artist_name: artist,
        track_name: title,
      });

      if (duration) {
        params.append("duration", Math.round(duration));
      }

      const apiUrl = `${this.baseURL}/get?${params}`;
      console.log(`🌐 LRCLib API request: ${apiUrl}`);

      const response = await fetch(apiUrl);

      if (!response.ok) {
        if (response.status === 404) {
          const notFoundLogMsg = {
            logKey: "log.lyrics.notFound",
            logVars: { title },
            fallback: `❌ Lyrics not found: ${title}`,
          };
          emitLog(onLog, notFoundLogMsg);
          return null;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log("📄 API response:", data ? "Data received" : "Empty response");

      if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
        const noContentLogMsg = {
          logKey: "log.lyrics.noContent",
          logVars: { title },
          fallback: `❌ No valid lyrics content: ${title}`,
        };
        emitLog(onLog, noContentLogMsg);
        return null;
      }

      setCache(cacheKey, {
        data: data,
        timestamp: Date.now(),
      });

      const foundLogMsg = {
        logKey: "log.lyrics.found",
        logVars: { title },
        fallback: `✅ Lyrics found: ${title}`,
      };
      emitLog(onLog, foundLogMsg);
      return data;
    } catch (error) {
      const errorLogMsg = {
        logKey: "log.lyrics.error",
        logVars: { artist, title, err: error.message },
        fallback: `❌ Error while searching lyrics (${artist} - ${title}): ${error.message}`,
      };
      emitLog(onLog, errorLogMsg);
      return null;
    }
  }

  async downloadLyrics(artist, title, duration = null, outputPath, options = {}) {
    const { onLog = null } = options;

    try {
      const downloadingLogMsg = {
        logKey: "log.lyrics.downloading",
        logVars: { artist, title },
        fallback: `📥 Downloading lyrics: "${artist}" - "${title}"`,
      };
      emitLog(onLog, downloadingLogMsg);

      const lyricsData = await this.searchLyrics(artist, title, duration, { onLog });

      if (!lyricsData) {
        const nothingToDownloadLogMsg = {
          logKey: "log.lyrics.nothingToDownload",
          logVars: { title },
          fallback: `❌ No lyrics to download: ${title}`,
        };
        emitLog(onLog, nothingToDownloadLogMsg);
        return null;
      }

      let lyricsContent = "";

      if (lyricsData.syncedLyrics) {
        lyricsContent = lyricsData.syncedLyrics;
        const usingSyncedLogMsg = {
          logKey: "log.lyrics.usingSynced",
          logVars: { title },
          fallback: `🎵 Using synced lyrics: ${title}`,
        };
        emitLog(onLog, usingSyncedLogMsg);
      } else if (lyricsData.plainLyrics) {
        lyricsContent = lyricsData.plainLyrics;
        const usingPlainLogMsg = {
          logKey: "log.lyrics.usingPlain",
          logVars: { title },
          fallback: `📝 Using plain text lyrics: ${title}`,
        };
        emitLog(onLog, usingPlainLogMsg);
      }

      if (!lyricsContent.trim()) {
        const emptyContentLogMsg = {
          logKey: "log.lyrics.emptyContent",
          logVars: { title },
          fallback: `❌ Lyrics content is empty: ${title}`,
        };
        emitLog(onLog, emptyContentLogMsg);
        return null;
      }

      const lrcPath = outputPath.replace(/\.[^/.]+$/, "") + ".lrc";
      const savingLogMsg = {
        logKey: "log.lyrics.saving",
        logVars: { path: lrcPath },
        fallback: `💾 Saving lyrics: ${lrcPath}`,
      };
      emitLog(onLog, savingLogMsg);

      fs.writeFileSync(lrcPath, lyricsContent, "utf8");

      const savedLogMsg = {
        logKey: "log.lyrics.saved",
        logVars: { path: lrcPath },
        fallback: `✅ Lyrics saved: ${lrcPath}`,
      };
      emitLog(onLog, savedLogMsg);
      return lrcPath;
    } catch (error) {
      const downloadErrorLogMsg = {
        logKey: "log.lyrics.downloadError",
        logVars: { artist, title, err: error.message },
        fallback: `❌ Lyrics download error (${artist} - ${title}): ${error.message}`,
      };
      emitLog(onLog, downloadErrorLogMsg);
      return null;
    }
  }

  convertToLRC(plainLyrics) {
    const lines = plainLyrics.split("\n").filter((line) => line.trim());
    const lrcLines = lines.map((line) => `[00:00.00]${line.trim()}`);
    return lrcLines.join("\n");
  }

  formatLrcTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const cents = Math.floor((seconds % 1) * 100);
    return `[${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}.
${cents.toString().padStart(2, "0")}]`;
  }
}

export const lyricsFetcher = new LyricsFetcher();

export async function attachLyricsToMedia(filePath, metadata, options = {}) {
  const { includeLyrics = true, jobId = null, onLog = null, onLyricsStats = null } = options;

  if (!includeLyrics) {
    const disabledLogMsg = {
      logKey: "log.lyrics.disabled",
      logVars: { file: path.basename(filePath) },
      fallback: `⚙️ Lyrics embedding is disabled — ${path.basename(filePath)}`,
    };
    emitLog(onLog, disabledLogMsg);
    return null;
  }

  try {
    metadata = metadata || {};

    const fileName = path.basename(filePath);
    const baseName = fileName.replace(/\.[^/.]+$/, "");

    let artist =
      metadata.artist ||
      metadata.album_artist ||
      metadata.uploader ||
      "";
    let title =
      metadata.title ||
      metadata.track ||
      "";

    const duration = metadata.duration;

    if (!artist || !title || artist === title) {
      const parts = baseName.split(/\s*[-–—]\s*/);
      if (parts.length >= 2) {
        const fileArtist = parts[0].trim();
        const fileTitle = parts.slice(1).join(" - ").trim();

        if (!artist) artist = fileArtist;
        if (
          !title ||
          title === baseName ||
          title.toLowerCase() === artist.toLowerCase()
        ) {
          title = fileTitle;
        }
      }
    }

    const rawArtist = artist;
    const rawTitle = title;

    artist = normalizeArtistName(artist);
    title = normalizeTitle(title);

    if (artist !== rawArtist) {
      const normalizedArtistLogMsg = {
        logKey: "log.lyrics.normalizedArtist",
        logVars: { from: rawArtist, to: artist },
        fallback: `✂️ Normalized artist for lyrics: "${rawArtist}" → "${artist}"`,
      };
      emitLog(onLog, normalizedArtistLogMsg);
    }

    if (title !== rawTitle) {
      const normalizedTitleLogMsg = {
        logKey: "log.lyrics.normalizedTitle",
        logVars: { from: rawTitle, to: title },
        fallback: `✂️ Normalized title for lyrics: "${rawTitle}" → "${title}"`,
      };
      emitLog(onLog, normalizedTitleLogMsg);
    }

    const searchingForFileLogMsg = {
      logKey: "log.lyrics.searchingForFile",
      logVars: { artist, title, file: path.basename(filePath) },
      fallback: `🎵 Searching lyrics: "${artist}" - "${title}" - ${path.basename(filePath)}`,
    };
    emitLog(onLog, searchingForFileLogMsg);

    if (!artist || !title) {
      const missingMetadataLogMsg = {
        logKey: "log.lyrics.missingMetadata",
        logVars: { artist, title },
        fallback: `❌ Artist or title missing — Artist: "${artist}", Title: "${title}"`,
      };
      emitLog(onLog, missingMetadataLogMsg);
      return null;
    }

    const lyricsPath = await lyricsFetcher.downloadLyrics(
      artist,
      title,
      duration,
      filePath,
      { onLog }
    );

    if (onLyricsStats) {
      if (lyricsPath) {
        onLyricsStats({ found: 1, notFound: 0 });
      } else {
        onLyricsStats({ found: 0, notFound: 1 });
      }
    }

    if (lyricsPath) {
      const attachedLogMsg = {
        logKey: "log.lyrics.attached",
        logVars: { file: path.basename(lyricsPath) },
        fallback: `✅ Lyrics successfully attached: ${path.basename(lyricsPath)}`,
      };
      emitLog(onLog, attachedLogMsg);
    } else {
      const notFoundForTrackLogMsg = {
        logKey: "log.lyrics.notFoundForTrack",
        logVars: { artist, title },
        fallback: `❌ Lyrics not found: "${artist}" - "${title}"`,
      };
      emitLog(onLog, notFoundForTrackLogMsg);
    }

    return lyricsPath;
  } catch (error) {
    const attachmentErrorLogMsg = {
      logKey: "log.lyrics.attachmentError",
      logVars: { err: error.message, file: path.basename(filePath) },
      fallback: `❌ Error while attaching lyrics: ${error.message} — ${path.basename(filePath)}`,
    };
    emitLog(onLog, attachmentErrorLogMsg);
    return null;
  }
}
