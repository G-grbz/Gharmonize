import { exec as _exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { FFPROBE_BIN, MKVMERGE_BIN } from "./binaries.js";

const execAsync = promisify(_exec);

let currentScanProcess = null;
let scanCancelled = false;

function sendScanLogPayload(payload) {
  if (typeof global.discScanLog === "function") {
    global.discScanLog(payload);
  }
}

function sendScanLog(message) {
  sendScanLogPayload(message);
}

function sendScanLogKey(key, vars = {}) {
  sendScanLogPayload({
    __i18n: true,
    key,
    vars
  });
}

function t(key, vars = {}) {
  let str = key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
  }
  return str;
}

async function readBluRayMeta(rawPath) {
  try {
    let discRoot = rawPath;
    const baseName = path.basename(discRoot);
    if (baseName === "BDMV") {
      discRoot = path.dirname(discRoot);
    }

    const candidates = [
      path.join(discRoot, "BDMV", "META", "DL"),
      path.join(discRoot, "BDMV", "META"),
      path.join(discRoot, "META", "DL"),
      path.join(discRoot, "META")
    ];

    let metaDir = null;

    for (const dir of candidates) {
      try {
        const stat = await fs.stat(dir);
        if (stat.isDirectory()) {
          metaDir = dir;
          break;
        }
      } catch {
      }
    }

    if (!metaDir) {
      sendScanLogKey("disc.log.blurayMetaNotFound");
      return null;
    }

    sendScanLogKey("disc.log.blurayMetaFound", { path: metaDir });

    const files = await fs.readdir(metaDir);
    let xmlFile =
      files.find((f) => /^bdtm_[a-z0-9]+\.xml$/i.test(f)) ||
      files.find((f) => /^bdmt_[a-z0-9]+\.xml$/i.test(f)) ||
      files.find((f) => f.toLowerCase().endsWith(".xml"));

    if (!xmlFile) {
      sendScanLogKey("disc.log.blurayMetaXmlNotFound");
      return null;
    }

    const fullPath = path.join(metaDir, xmlFile);
    sendScanLogKey("disc.log.blurayMetaXmlFile", { file: xmlFile });

    const xml = await fs.readFile(fullPath, "utf8");
    const discTitleMatch = xml.match(/<di:name>([^<]+)<\/di:name>/);
    const languageMatch = xml.match(/<di:language>([^<]+)<\/di:language>/);
    const discTitle = discTitleMatch ? discTitleMatch[1].trim() : null;
    const language = languageMatch ? languageMatch[1].trim() : null;
    const titleNames = {};
    const titleNameRegex =
      /<di:titleName[^>]*titleNumber="(\d+)"[^>]*>([^<]+)<\/di:titleName>/g;

    let m;
    while ((m = titleNameRegex.exec(xml)) !== null) {
      const num = parseInt(m[1], 10);
      const name = m[2].trim();
      titleNames[num] = name;
    }

    if (discTitle) {
      sendScanLogKey("disc.log.blurayDiscTitle", {
        title: discTitle,
        language: language || t("disc.log.unknownLanguage")
      });
    }

    return {
      discTitle,
      language,
      titleNames,
      metaFile: xmlFile
    };
  } catch (err) {
    sendScanLogKey("disc.log.blurayMetaReadError", { error: err.message });
    return null;
  }
}

function cancelScan() {
  scanCancelled = true;
  if (currentScanProcess) {
    try {
      currentScanProcess.kill("SIGINT");
    } catch (e) {
      console.warn("Scan cancel kill error:", e.message);
    } finally {
      currentScanProcess = null;
    }
  }
}

async function scanDisc(sourcePath) {
  scanCancelled = false;

  try {
    await fs.access(sourcePath);
  } catch (error) {
    throw new Error(t("disc.error.sourceNotFound", { path: sourcePath }));
  }

  const discInfo = await detectDiscType(sourcePath);
  sendScanLogKey("disc.log.discTypeDetected", {
    type: discInfo.type,
    path: discInfo.actualPath
  });

  if (discInfo.type === "DVD") {
    return await scanDVD(discInfo.actualPath);
  } else if (discInfo.type === "Blu-ray") {
    return await scanBluRay(discInfo.actualPath);
  } else {
    throw new Error(t("disc.error.unsupportedFormat"));
  }
}

async function detectDiscType(sourcePath) {
  try {
    const stats = await fs.stat(sourcePath);
    if (stats.isDirectory() && path.basename(sourcePath) === "BDMV") {
      const parentPath = path.dirname(sourcePath);
      return {
        type: "Blu-ray",
        actualPath: parentPath
      };
    }

    if (stats.isDirectory() && path.basename(sourcePath) === "VIDEO_TS") {
      const parentPath = path.dirname(sourcePath);
      try {
        await fs.access(path.join(parentPath, "VIDEO_TS"));
        return {
          type: "DVD",
          actualPath: parentPath
        };
      } catch {
        return {
          type: "DVD",
          actualPath: sourcePath
        };
      }
    }

    const files = await fs.readdir(sourcePath);
    sendScanLogKey("disc.log.sourceDirectoryContent", { count: files.length });

    if (files.includes("BDMV")) {
      const bdmvPath = path.join(sourcePath, "BDMV");
      const bdmvStats = await fs.stat(bdmvPath);
      if (bdmvStats.isDirectory()) {
        return { type: "Blu-ray", actualPath: sourcePath };
      }
    }

    if (files.includes("VIDEO_TS")) {
      const videoTsPath = path.join(sourcePath, "VIDEO_TS");
      const videoTsStats = await fs.stat(videoTsPath);
      if (videoTsStats.isDirectory()) {
        return { type: "DVD", actualPath: sourcePath };
      }
    }

    const allFiles = await fs.readdir(sourcePath);
    const vobFiles = allFiles.filter((f) => f.toLowerCase().endsWith(".vob"));
    if (vobFiles.length > 0) {
      return { type: "DVD", actualPath: path.dirname(sourcePath) };
    }
  } catch (error) {
    console.error("Disc type detection error:", error);
  }

  throw new Error(t("disc.error.noValidStructure"));
}

async function scanDVD(sourcePath) {
  try {
    let videoTsPath = path.join(sourcePath, "VIDEO_TS");
    if (path.basename(sourcePath) === "VIDEO_TS") {
      videoTsPath = sourcePath;
    }

    sendScanLogKey("disc.log.dvdScanPath", { path: videoTsPath });

    let vobFiles;
    try {
      vobFiles = await fs.readdir(videoTsPath);
      vobFiles = vobFiles.filter((f) => f.toUpperCase().endsWith(".VOB"));
      sendScanLogKey("disc.log.vobFilesFound", { count: vobFiles.length });
    } catch (error) {
      throw new Error(t("disc.error.videoTsNotFound", { path: videoTsPath }));
    }

    if (vobFiles.length === 0) {
      throw new Error(t("disc.error.noVobFiles"));
    }

    return await scanDVDManual(sourcePath);
  } catch (error) {
    if (error.message === "SCAN_CANCELLED") {
      sendScanLogKey("disc.log.dvdScanCancelled");
      throw error;
    }
    sendScanLogKey("disc.log.dvdScanError", { error: error.message });
    throw new Error(t("disc.error.dvdScanFailed", { error: error.message }));
  }
}

async function scanBluRay(sourcePath) {
  try {
    const bdmvPath = path.join(sourcePath, "BDMV");
    const playlistPath = path.join(bdmvPath, "PLAYLIST");

    sendScanLogKey("disc.log.blurayScanPath", { path: sourcePath });
    sendScanLogKey("disc.log.playlistPath", { path: playlistPath });

    const discMeta = await readBluRayMeta(sourcePath);

    try {
      await fs.access(playlistPath);
      sendScanLogKey("disc.log.playlistFolderFound");
    } catch {
      throw new Error(t("disc.error.noPlaylistFolder"));
    }

    const files = await fs.readdir(playlistPath);
    const mplsFiles = files.filter(
      (f) => f.endsWith(".mpls") && f !== "BU.backup"
    );
    sendScanLogKey("disc.log.playlistFilesFound", { count: mplsFiles.length });

    const titles = [];
    let foundCount = 0;
    let skippedCount = 0;

    const MIN_DURATION_SECONDS = 120;
    const MAX_DURATION_SECONDS = 8 * 60 * 60;

    for (const mplsFile of mplsFiles) {
      if (scanCancelled) {
        const cancelled = new Error("SCAN_CANCELLED");
        cancelled.killed = true;
        throw cancelled;
      }

      const playlistPathFull = path.join(playlistPath, mplsFile);
      const playlistNumber = parseInt(mplsFile.replace(".mpls", ""), 10);

      try {
        sendScanLogKey("disc.log.analyzingPlaylist", { file: mplsFile });
        const titleInfo = await analyzeBluRayPlaylist(playlistPathFull);

        const hasTracks =
          (titleInfo.audioTracks && titleInfo.audioTracks.length > 0) ||
          (titleInfo.subtitleTracks && titleInfo.subtitleTracks.length > 0);

        const d = Number(titleInfo.duration || 0);

        if (!Number.isFinite(d)) {
          sendScanLogKey("disc.log.skippedInvalidDuration", { file: mplsFile });
          skippedCount++;
          continue;
        }

        if (d < MIN_DURATION_SECONDS) {
          sendScanLogKey("disc.log.skippedTooShort", {
            file: mplsFile,
            duration: Math.round(d)
          });
          skippedCount++;
          continue;
        }

        if (d > MAX_DURATION_SECONDS) {
          sendScanLogKey("disc.log.skippedTooLong", {
            file: mplsFile,
            duration: Math.round(d)
          });
          skippedCount++;
          continue;
        }

        if (!hasTracks) {
          sendScanLogKey("disc.log.skippedNoTracks", { file: mplsFile });
          skippedCount++;
          continue;
        }

        const metaTitleName =
          discMeta?.titleNames?.[playlistNumber] ||
          discMeta?.titleNames?.[titles.length + 1] ||
          null;
        const displayName =
          metaTitleName ||
          discMeta?.discTitle ||
          `Playlist ${String(playlistNumber).padStart(5, "0")}`;

        titles.push({
          index: playlistNumber,
          playlistFile: mplsFile,
          discTitle: discMeta?.discTitle || null,
          discLanguage: discMeta?.language || null,
          name: displayName,
          ...titleInfo
        });

        foundCount++;
        sendScanLogKey("disc.log.playlistAdded", {
          file: mplsFile,
          duration: Math.round(d),
          audio: (titleInfo.audioTracks || []).length,
          subtitle: (titleInfo.subtitleTracks || []).length,
          chapters: (titleInfo.chapters || []).length
        });
      } catch (error) {
        sendScanLogKey("disc.log.skippedError", {
          file: mplsFile,
          error: error.message
        });
        skippedCount++;
      }
    }

    titles.sort((a, b) => b.duration - a.duration);

    sendScanLogKey("disc.log.scanCompletedStats", {
      found: foundCount,
      skipped: skippedCount
    });

    if (titles.length === 0) {
      throw new Error(t("disc.error.noValidTitles"));
    }

    return {
      type: "Blu-ray",
      source: sourcePath,
      titles: titles,
      discMeta: discMeta || null,
      scanStats: {
        found: foundCount,
        skipped: skippedCount,
        total: mplsFiles.length
      }
    };
  } catch (error) {
    if (error.message === "SCAN_CANCELLED") {
      sendScanLogKey("disc.log.blurayScanCancelled");
      throw error;
    }
    sendScanLogKey("disc.log.blurayScanError", { error: error.message });
    throw new Error(t("disc.error.blurayScanFailed", { error: error.message }));
  }
}

async function analyzeBluRayPlaylist(playlistPath) {
  const playlistFileName = path.basename(playlistPath);
  const playlistNumber = parseInt(playlistFileName.replace(".mpls", ""), 10);
  const discRoot = path.resolve(playlistPath, "../../..");

  let duration = 0;
  const audioTracks = [];
  const subtitleTracks = [];
  let chapters = [];
  let sizeBytes = 0;

  try {
    const ffprobeCmd =
      `"${FFPROBE_BIN}" -v error -show_entries format=duration -of json ` +
      `"bluray:${discRoot}:playlist=${playlistNumber}"`;

    sendScanLogKey("disc.log.runningFfprobe", { file: playlistFileName });

    const { stdout } = await runScanCommand(ffprobeCmd);
    const probeData = JSON.parse(stdout || "{}");

    if (probeData.format && probeData.format.duration) {
      duration = parseFloat(probeData.format.duration) || 0;
    }

    sendScanLogKey("disc.log.ffprobeResult", {
      file: playlistFileName,
      duration: duration.toFixed(2)
    });
  } catch (error) {
    sendScanLogKey("disc.log.ffprobeFailed", {
      file: playlistFileName,
      error: error.message
    });
  }

  try {
    const { stdout } = await runScanCommand(`"${MKVMERGE_BIN}" -J "${playlistPath}"`);
    const info = JSON.parse(stdout);
    const props = info.container?.properties || {};

    if (!duration || duration === 0) {
      if (typeof props.playlist_duration === "number") {
        duration = props.playlist_duration / 1000000000;
      } else if (typeof props.duration === "number") {
        duration = props.duration / 1000000000;
      } else if (
        Array.isArray(info.playlist) &&
        info.playlist[0]?.playlist_duration
      ) {
        duration = info.playlist[0].playlist_duration / 1000000000;
      }
    }

    if (typeof props.playlist_size === "number" && props.playlist_size > 0) {
      sizeBytes = props.playlist_size;
    } else if (
      Array.isArray(props.playlist_file) &&
      props.playlist_file.length > 0
    ) {
      for (const filePath of props.playlist_file) {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(discRoot, "BDMV", "STREAM", filePath);

        try {
          const st = await fs.stat(fullPath);
          sizeBytes += st.size;
        } catch (err) {
          sendScanLogKey("disc.log.m2tsSizeError", { file: filePath });
        }
      }
    }

    if (info.chapters && info.chapters.length > 0) {
      const chapterEntry = info.chapters[0];
      if (chapterEntry.num_entries) {
        const chapterCount = chapterEntry.num_entries;
        chapters = Array.from({ length: chapterCount }, (_, i) => ({
          index: i + 1,
          startTime: 0
        }));
      } else if (Array.isArray(chapterEntry.chapters)) {
        chapters = chapterEntry.chapters.map((chap, idx) => ({
          index: idx + 1,
          startTime: chap.start_time || 0,
          name: chap.name || `Chapter ${idx + 1}`
        }));
      }
    }

    (info.tracks || []).forEach((track) => {
      if (track.type === "audio") {
        audioTracks.push({
          index: audioTracks.length,
          language: track.properties?.language || "unknown",
          codec: track.codec || "unknown",
          channels: track.properties?.audio_channels || 2
        });
      } else if (track.type === "subtitles") {
        subtitleTracks.push({
          index: subtitleTracks.length,
          language: track.properties?.language || "unknown",
          codec: track.codec || "unknown"
        });
      }
    });

    sendScanLogKey("disc.log.playlistAnalysisComplete", {
      file: playlistFileName,
      duration: duration.toFixed(2),
      audio: audioTracks.length,
      subtitle: subtitleTracks.length
    });

    return {
      duration,
      audioTracks,
      subtitleTracks,
      chapters,
      sizeBytes
    };
  } catch (error) {
      sendScanLogKey("disc.log.playlistAnalysisError", {
        file: playlistFileName,
        error: error.message
      });
      const err = new Error("disc.error.playlistAnalysisFailed");
      throw err;
  }
}

async function analyzeWithMkvmerge(playlistPath) {
  try {
    sendScanLogKey("disc.log.analyzingVobTracks", {
      file: path.basename(playlistPath)
    });

    const parseMkvmergeInfo = (trackInfo) => {
      const duration =
        trackInfo.container &&
        trackInfo.container.properties &&
        trackInfo.container.properties.duration
          ? trackInfo.container.properties.duration / 1000
          : 0;

      const audioTracks = [];
      const subtitleTracks = [];

      (trackInfo.tracks || []).forEach((track) => {
        let lang =
          track.properties?.language_ietf ||
          track.properties?.language ||
          track.properties?.track_name ||
          "unknown";

        if (typeof lang === "string") {
          lang = lang.toLowerCase();
          if (lang === "und" || lang === "undefined") {
            lang = "unknown";
          }
        } else {
          lang = "unknown";
        }

        if (track.type === "audio") {
          audioTracks.push({
            index: audioTracks.length,
            language: lang,
            codec: track.codec || "unknown",
            channels: track.properties?.audio_channels || 2
          });
        } else if (track.type === "subtitles") {
          subtitleTracks.push({
            index: subtitleTracks.length,
            language: lang,
            codec: track.codec || "unknown"
          });
        }
      });

      return { duration, audioTracks, subtitleTracks };
    };

    const { stdout } = await runScanCommand(`"${MKVMERGE_BIN}" -J "${playlistPath}"`);
    const trackInfo = JSON.parse(stdout || "{}");
    const result = parseMkvmergeInfo(trackInfo);

    sendScanLogKey("disc.log.vobTrackAnalysisComplete", {
      audio: result.audioTracks.length,
      subtitle: result.subtitleTracks.length
    });

    return {
      duration: result.duration,
      audioTracks: result.audioTracks,
      subtitleTracks: result.subtitleTracks,
      chapters: []
    };
  } catch (error) {
    sendScanLogKey("disc.log.vobTrackAnalysisError", { error: error.message });
    throw new Error(
      t("disc.error.vobTrackAnalysisFailed", { error: error.message })
    );
  }
}

async function scanDVDManual(sourcePath) {
  try {
    const videoTsPath =
      path.basename(sourcePath) === "VIDEO_TS"
        ? sourcePath
        : path.join(sourcePath, "VIDEO_TS");

    const discRoot =
      path.basename(sourcePath) === "VIDEO_TS"
        ? path.dirname(sourcePath)
        : sourcePath;
    const discTitle = path.basename(discRoot);

    const files = await fs.readdir(videoTsPath);
    const vobFiles = files.filter((f) => f.toUpperCase().endsWith(".VOB"));
    const titleGroups = {};

    vobFiles.forEach((file) => {
      const match = file.match(/VTS_(\d+)_\d+\.VOB/i);
      if (match) {
        const titleNum = parseInt(match[1], 10);
        if (!titleGroups[titleNum]) {
          titleGroups[titleNum] = [];
        }
        titleGroups[titleNum].push(file);
      }
    });

    const titles = [];
    let foundCount = 0;
    let skippedCount = 0;

    const MIN_DURATION_SECONDS = 120;
    const MAX_DURATION_SECONDS = 240 * 60;

    for (const [titleNum, groupFiles] of Object.entries(titleGroups)) {
      if (scanCancelled) {
        const cancelled = new Error("SCAN_CANCELLED");
        cancelled.killed = true;
        throw cancelled;
      }

      const sortedFiles = groupFiles.slice().sort((a, b) => {
      const na = parseInt(a.match(/_(\d+)\.VOB$/i)?.[1] || "0", 10);
      const nb = parseInt(b.match(/_(\d+)\.VOB$/i)?.[1] || "0", 10);
        return na - nb;
      });
      const allVobs = sortedFiles.map((f) => path.join(videoTsPath, f));
      const durationVobs = allVobs.filter(
      (p) => !path.basename(p).toUpperCase().includes("_0.VOB")
      );
      const fullVobs = durationVobs.length > 0 ? durationVobs : allVobs;
      const groupName = `VTS_${titleNum}`;

      sendScanLogKey("disc.log.vobGroupFound", {
        group: groupName,
        count: fullVobs.length
      });

      try {
        let totalDuration = 0;
        let totalSizeBytes = 0;

        for (const vobPath of fullVobs) {
          try {
            const st = await fs.stat(vobPath);
            totalSizeBytes += st.size;
          } catch (e) {
            sendScanLogKey("disc.log.vobSizeError", {
              file: path.basename(vobPath)
            });
          }

          const cmd = `"${FFPROBE_BIN}" -v quiet -print_format json -show_format "${vobPath}"`;
          const { stdout } = await runScanCommand(cmd);
          const probeData = JSON.parse(stdout || "{}");

          const dur = parseFloat(probeData.format?.duration) || 0;
          totalDuration += dur;
        }

        const trackProbeVob =
          fullVobs.find((p) =>
            !path.basename(p).toUpperCase().includes("_0.VOB")
          ) || fullVobs[0];

        let audioTracks = [];
        let subtitleTracks = [];
        let mkvInfo = null;

        try {
          mkvInfo = await analyzeWithMkvmerge(trackProbeVob);
          if (
            mkvInfo.duration &&
            mkvInfo.duration >= MIN_DURATION_SECONDS &&
            mkvInfo.duration <= MAX_DURATION_SECONDS
          ) {
            totalDuration = mkvInfo.duration;
          }

          audioTracks = mkvInfo.audioTracks || [];
          subtitleTracks = mkvInfo.subtitleTracks || [];
        } catch (e) {
          sendScanLogKey("disc.log.vobTrackFallback", { error: e.message });

          try {
            const cmdTracks = `"${FFPROBE_BIN}" -v quiet -print_format json -show_streams "${trackProbeVob}"`;
            const { stdout: s2 } = await runScanCommand(cmdTracks);
            const data = JSON.parse(s2 || "{}");

            (data.streams || []).forEach((s) => {
              if (s.codec_type === "audio") {
                audioTracks.push({
                  index: audioTracks.length,
                  language: (s.tags && s.tags.language) || "unknown",
                  codec: s.codec_name || "unknown",
                  channels: s.channels || 2
                });
              } else if (s.codec_type === "subtitle") {
                subtitleTracks.push({
                  index: subtitleTracks.length,
                  language: (s.tags && s.tags.language) || "unknown",
                  codec: s.codec_name || "unknown"
                });
              }
            });
          } catch (inner) {
            sendScanLogKey("disc.log.vobTrackFallbackFailed", {
              error: inner.message
            });
          }
        }
        const avgBitrate =
          totalDuration > 0 ? (totalSizeBytes * 8) / totalDuration : 0;
        if (
          totalDuration > 0 &&
          (avgBitrate < 500_000 || avgBitrate > 15_000_000)
        ) {
          sendScanLogKey("disc.log.vobDurationInvalidBitrate", {
            group: groupName,
            duration: totalDuration.toFixed(2),
            bitrate: Math.round(avgBitrate)
          });
          if (
            mkvInfo &&
            mkvInfo.duration &&
            mkvInfo.duration >= MIN_DURATION_SECONDS &&
            mkvInfo.duration <= MAX_DURATION_SECONDS
          ) {
            totalDuration = mkvInfo.duration;
          } else {
            const assumedBitrate = 5_000_000;
            totalDuration = (totalSizeBytes * 8) / assumedBitrate;
          }
        }
        if (
          !Number.isFinite(totalDuration) ||
          totalDuration < MIN_DURATION_SECONDS
        ) {
          sendScanLogKey("disc.log.skippedVobTooShort", {
            group: groupName,
            duration: totalDuration.toFixed(2)
          });
          skippedCount++;
          continue;
        }

        if (totalDuration > MAX_DURATION_SECONDS) {
          const sizeGB = totalSizeBytes / (1024 * 1024 * 1024);
          if (sizeGB < 10) {
            sendScanLogKey("disc.log.vobDurationSuspiciousButAccepted", {
              group: groupName,
              duration: totalDuration.toFixed(2)
            });
          } else {
            sendScanLogKey("disc.log.skippedVobTooLong", {
              group: groupName,
              duration: totalDuration.toFixed(2)
            });
            skippedCount++;
            continue;
          }
        }

        titles.push({
          index: parseInt(titleNum, 10),
          duration: totalDuration,
          chapters: [{ index: 1, startTime: 0 }],
          audioTracks,
          subtitleTracks,
          vobFiles: sortedFiles,
          sizeBytes: totalSizeBytes,
          discTitle
        });

        foundCount++;
        sendScanLogKey("disc.log.vobGroupAdded", {
          group: groupName,
          duration: totalDuration.toFixed(2),
          audio: audioTracks.length,
          subtitle: subtitleTracks.length
        });
      } catch (error) {
        sendScanLogKey("disc.log.skippedVobError", {
          group: groupName,
          error: error.message
        });
        skippedCount++;
      }
    }

    sendScanLogKey("disc.log.dvdScanCompletedStats", {
      found: foundCount,
      skipped: skippedCount
    });

    return {
      type: "DVD",
      source: sourcePath,
      titles: titles.sort((a, b) => a.index - b.index),
      scanStats: {
        found: foundCount,
        skipped: skippedCount,
        total: Object.keys(titleGroups).length
      }
    };
  } catch (error) {
    sendScanLogKey("disc.log.dvdScanError", { error: error.message });
    throw new Error(t("disc.error.dvdScanFailed", { error: error.message }));
  }
}

function runScanCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (scanCancelled) {
      const cancelled = new Error("SCAN_CANCELLED");
      cancelled.killed = true;
      return reject(cancelled);
    }

    const child = _exec(
      cmd,
      { maxBuffer: 1024 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (currentScanProcess === child) {
          currentScanProcess = null;
        }

        if (error) {
          if (error.killed) {
            const cancelled = new Error("SCAN_CANCELLED");
            cancelled.killed = true;
            return reject(cancelled);
          }
          error.stderr = stderr;
          return reject(error);
        }

        resolve({ stdout, stderr });
      }
    );

    currentScanProcess = child;
  });
}

export { scanDisc, detectDiscType, cancelScan };
