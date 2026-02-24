import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { getCache, setCache } from "./cache.js";
import { FFMPEG_BIN } from "./binaries.js";
import { rewriteId3v11Tag } from "./id3.js";

const LYRICS_CACHE_TTL = 24 * 60 * 60 * 1000;

// Handles emit log in core application logic.
function emitLog(onLog, payload) {
  if (payload?.fallback) console.log(payload.fallback);
  if (onLog) onLog(payload);
}

// Normalizes artist name for core application logic.
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

// Normalizes title for core application logic.
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
  // Initializes class state and defaults for core application logic.
  constructor() {
    this.baseURL = "https://lrclib.net/api";
  }

  // Handles search lyrics metadata in core application logic.
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

  // Downloads lyrics metadata for core application logic.
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

  // Converts to lrc for core application logic.
  convertToLRC(plainLyrics) {
    const lines = plainLyrics.split("\n").filter((line) => line.trim());
    const lrcLines = lines.map((line) => `[00:00.00]${line.trim()}`);
    return lrcLines.join("\n");
  }

  // Formats lrc time for core application logic.
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

// Handles strip lrc timestamps in core application logic.
function stripLrcTimestamps(text = "") {
  return String(text)
    .split("\n")
    .map((line) => line.replace(/\[[0-9]{1,2}:[0-9]{2}(?:\.[0-9]{1,3})?\]/g, "").trim())
    .filter(Boolean)
    .join("\n");
}

// Checks whether embeddable audio format is valid for core application logic.
function isEmbeddableAudioFormat(filePath) {
  const ext = String(path.extname(filePath) || "").toLowerCase();
  return [".mp3", ".m4a", ".mp4", ".flac", ".ogg", ".opus", ".wav", ".aac", ".alac"].includes(ext);
}

// Embeds lyrics in media into media.
async function embedLyricsInMedia(filePath, lyricsContent, options = {}) {
  const { onLog = null, metadata = null } = options;
  const inputFile = path.basename(filePath);

  if (!isEmbeddableAudioFormat(filePath)) {
    emitLog(onLog, {
      logKey: "log.lyrics.embeddingSkippedUnsupported",
      logVars: { file: inputFile },
      fallback: `⚠️ Lyrics embedding is not supported for this format: ${inputFile}`,
    });
    return false;
  }

  const cleaned = stripLrcTimestamps(lyricsContent);
  const finalLyrics = (cleaned || lyricsContent || "").trim();
  if (!finalLyrics) return false;

  emitLog(onLog, {
    logKey: "log.lyrics.embedding",
    logVars: { file: inputFile },
    fallback: `🧩 Embedding lyrics into track: ${inputFile}`,
  });

  const ext = path.extname(filePath);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, ext);
  const tmpPath = path.join(dir, `${base}.lyrics_embed_tmp${ext}`);
  const backupPath = path.join(dir, `${base}.lyrics_embed_backup${ext}`);
  const isMp3 = String(ext).toLowerCase() === ".mp3";
  const args = [
    "-y",
    "-i",
    filePath,
    "-map",
    "0",
    "-c",
    "copy",
    "-metadata",
    `lyrics=${finalLyrics}`,
    "-metadata:s:a:0",
    `lyrics=${finalLyrics}`,
  ];
  if (isMp3) {
    args.push("-id3v2_version", "3");
    if (process.env.WRITE_ID3V1 !== "0") args.push("-write_id3v1", "1");
  }
  args.push(tmpPath);

  try {
    await new Promise((resolve, reject) => {
      const stderrChunks = [];
      const child = spawn(FFMPEG_BIN, args);

      child.stderr.on("data", (d) => {
        const line = String(d || "");
        stderrChunks.push(line);
        if (stderrChunks.length > 50) stderrChunks.shift();
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) return resolve(stderrChunks.join("").trim());
        return reject(new Error(stderrChunks.join("").trim() || `ffmpeg exited with code ${code}`));
      });
    });

    if (!fs.existsSync(tmpPath)) {
      throw new Error("Temporary output missing after embedding");
    }

    fs.renameSync(filePath, backupPath);
    fs.renameSync(tmpPath, filePath);
    try {
      fs.unlinkSync(backupPath);
    } catch {}

    if (isMp3 && process.env.WRITE_ID3V1 !== "0") {
      rewriteId3v11Tag(filePath, metadata || {});
    }

    emitLog(onLog, {
      logKey: "log.lyrics.embedded",
      logVars: { file: inputFile },
      fallback: `✅ Lyrics embedded into track: ${inputFile}`,
    });
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    try {
      if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) {
        fs.renameSync(backupPath, filePath);
      }
    } catch {}
    try {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    } catch {}

    emitLog(onLog, {
      logKey: "log.lyrics.embeddingError",
      logVars: { err: error.message, file: inputFile },
      fallback: `❌ Error embedding lyrics: ${error.message} — ${inputFile}`,
    });
    return false;
  }
}

// Handles attach lyrics metadata to media in core application logic.
export async function attachLyricsToMedia(filePath, metadata, options = {}) {
  const {
    includeLyrics = true,
    embedLyrics = false,
    jobId = null,
    onLog = null,
    onLyricsStats = null
  } = options;

  if (!includeLyrics && !embedLyrics) {
    const disabledLogMsg = {
      logKey: "log.lyrics.disabled",
      logVars: { file: path.basename(filePath) },
      fallback: `⚙️ Lyrics download and embedding are disabled — ${path.basename(filePath)}`,
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

    let lyricsPath = null;
    let lyricsContentForEmbed = null;

    if (includeLyrics) {
      lyricsPath = await lyricsFetcher.downloadLyrics(
        artist,
        title,
        duration,
        filePath,
        { onLog }
      );
      if (lyricsPath && embedLyrics) {
        try {
          lyricsContentForEmbed = fs.readFileSync(lyricsPath, "utf8");
        } catch {}
      }
    } else if (embedLyrics) {
      const lyricsData = await lyricsFetcher.searchLyrics(
        artist,
        title,
        duration,
        { onLog }
      );
      lyricsContentForEmbed = (
        lyricsData?.syncedLyrics ||
        lyricsData?.plainLyrics ||
        ""
      ).trim();
    }

    const hasLyrics = !!lyricsPath || !!lyricsContentForEmbed;
    if (onLyricsStats) {
      onLyricsStats(hasLyrics ? { found: 1, notFound: 0 } : { found: 0, notFound: 1 });
    }

    if (!hasLyrics) {
      const notFoundForTrackLogMsg = {
        logKey: "log.lyrics.notFoundForTrack",
        logVars: { artist, title },
        fallback: `❌ Lyrics not found: "${artist}" - "${title}"`,
      };
      emitLog(onLog, notFoundForTrackLogMsg);
      return null;
    }

    if (embedLyrics && lyricsContentForEmbed) {
      try {
        await embedLyricsInMedia(filePath, lyricsContentForEmbed, {
          onLog,
          metadata
        });
      } catch (embedError) {
        emitLog(onLog, {
          logKey: "log.lyrics.embeddingError",
          logVars: { err: embedError.message, file: path.basename(filePath) },
          fallback: `❌ Error embedding lyrics: ${embedError.message} — ${path.basename(filePath)}`,
        });
      }
    }

    if (lyricsPath) {
      const attachedLogMsg = {
        logKey: "log.lyrics.attached",
        logVars: { file: path.basename(lyricsPath) },
        fallback: `✅ Lyrics successfully attached: ${path.basename(lyricsPath)}`,
      };
      emitLog(onLog, attachedLogMsg);
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
