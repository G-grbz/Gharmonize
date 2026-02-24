import { exec as _exec, spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { MKVMERGE_BIN } from "./binaries.js";

let currentRipProcess = null;
let ripCancelled = false;

// Handles exec json unlimited in disc scanning and ripping.
function execJsonUnlimited(cmd, progressCallback = null) {
    if (progressCallback) {
      progressCallback(0, { __i18n: true, key: "disc.progress.analyzingTracks", vars: {} });
    }
  return new Promise((resolve, reject) => {
    _exec(
      cmd,
      {
        maxBuffer: 1024 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          return reject(error);
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

// Runs rip progress command for disc scanning and ripping.
function runRipCommand(
  args,
  outputPath,
  progressCallback = null,
  expectedSizeBytes = null
) {
  ripCancelled = false;

  return new Promise((resolve, reject) => {
    const child = spawn(MKVMERGE_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    currentRipProcess = child;
    console.log("[rip] started pid:", child.pid);

    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const str = chunk.toString();
      stderrBuf += str;
    });

    if (progressCallback && outputPath) {
      let lastSize = 0;
      let checkCount = 0;
      const maxChecks = 1800;

      const fileCheckInterval = setInterval(async () => {
        if (currentRipProcess !== child) {
          clearInterval(fileCheckInterval);
          return;
        }

        try {
          const stats = await fs.stat(outputPath);
          const currentSize = stats.size;

          if (currentSize > lastSize) {
            lastSize = currentSize;

            let sizePercent = null;
            if (expectedSizeBytes && expectedSizeBytes > 0) {
              sizePercent = Math.round((currentSize / expectedSizeBytes) * 100);
              sizePercent = Math.max(1, Math.min(sizePercent, 99));
            }

            const timeRatio = checkCount / maxChecks;
            let timePercent = Math.min(
              95,
              Math.max(5, Math.round(timeRatio * 100))
            );

            const progress =
              sizePercent !== null ? Math.max(sizePercent, timePercent) : timePercent;

            let msg;
            if (expectedSizeBytes && expectedSizeBytes > 0) {
              msg = {
                __i18n: true,
                key: "disc.progress.writingFileWithTotal",
                vars: {
                  current: formatFileSize(currentSize),
                  total: formatFileSize(expectedSizeBytes)
                }
              };
            } else {
              msg = {
                __i18n: true,
                key: "disc.progress.writingFile",
                vars: {
                  current: formatFileSize(currentSize)
                }
              };
            }
            progressCallback(progress, msg);
          }

          checkCount++;
          if (checkCount >= maxChecks) {
            clearInterval(fileCheckInterval);
          }
        } catch (error) {
          if (checkCount < 10 && progressCallback) {
            progressCallback(5, {
              __i18n: true,
              key: "disc.progress.creatingFile",
              vars: {}
            });
          }
          checkCount++;
        }
      }, 1000);

      child.on("exit", () => {
        clearInterval(fileCheckInterval);
      });
    }

    child.on("error", (err) => {
      if (currentRipProcess === child) {
        currentRipProcess = null;
      }
      err.stdout = stdoutBuf;
      err.stderr = stderrBuf;
      reject(err);
    });

    child.on("close", (code, signal) => {
      if (currentRipProcess === child) {
        currentRipProcess = null;
      }

      if (code === 0) {
        return resolve({ stdout: stdoutBuf, stderr: stderrBuf });
      }

      if (ripCancelled || signal) {
        const cancelled = new Error("RIP_CANCELLED");
        cancelled.killed = true;
        cancelled.stdout = stdoutBuf;
        cancelled.stderr = stderrBuf;
        return reject(cancelled);
      }

      const err = new Error(
        `mkvmerge exited with code ${code}${signal ? `, signal ${signal}` : ""}`
      );
      err.stdout = stdoutBuf;
      err.stderr = stderrBuf;
      reject(err);
    });
  });
}

// Handles estimate dvd title size in disc scanning and ripping.
async function estimateDvdTitleSize(videoTsPath, titleIndex) {
  const vobFiles = await getMainVOBFilesForTitle(videoTsPath, titleIndex);
  let total = 0;

  for (const f of vobFiles) {
    try {
      const stats = await fs.stat(f);
      total += stats.size;
    } catch (err) {
      console.warn("Failed to read VOB size:", f, err.message);
    }
  }
  return total;
}

// Formats file size for disc scanning and ripping.
function formatFileSize(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Parses mkv merge progress for disc scanning and ripping.
function parseMkvMergeProgress(output) {
  const patterns = [
    /Progress:\s*(\d+)%/i,
    /(\d+)%/i,
    /progress.*?(\d+)%/i,
    /Writing.*?(\d+)%/i
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      const percent = parseInt(match[1], 10);
      if (percent >= 0 && percent <= 100) {
        return percent;
      }
    }
  }

  return null;
}

// Parses file based progress for disc scanning and ripping.
function parseFileBasedProgress(output) {
  const sizeMatch = output.match(/(\d+\.?\d*)\s*MiB\s*\/\s*(\d+\.?\d*)\s*MiB/i);
  if (sizeMatch) {
    const current = parseFloat(sizeMatch[1]);
    const total = parseFloat(sizeMatch[2]);
    if (total > 0) {
      const percent = Math.round((current / total) * 100);
      return Math.min(95, percent);
    }
  }

  const mbMatch = output.match(/(\d+)\s*MB\s+of\s+(\d+)\s*MB/i);
  if (mbMatch) {
    const current = parseInt(mbMatch[1], 10);
    const total = parseInt(mbMatch[2], 10);
    if (total > 0) {
      const percent = Math.round((current / total) * 100);
      return Math.min(95, percent);
    }
  }

  return null;
}

// Cancels rip progress in disc scanning and ripping.
function cancelRip() {
  if (!currentRipProcess) return;

  ripCancelled = true;

  const pid = currentRipProcess.pid;
  console.log("[rip] cancel requested, pid:", pid);

  try {
    currentRipProcess.kill("SIGINT");
    console.log("[rip] sent SIGINT to pid", pid);
  } catch (e) {
    console.warn("Rip SIGINT error:", e.message);
  }

  setTimeout(() => {
    if (!currentRipProcess) return;

    try {
      currentRipProcess.kill("SIGKILL");
      console.log("[rip] sent SIGKILL to pid", pid);
    } catch (e) {
      console.warn("Rip SIGKILL error:", e.message);
    }
  }, 5000);
}

// Handles rip progress title in disc scanning and ripping.
async function ripTitle(
  sourcePath,
  titleIndex,
  outputPath,
  options = {},
  progressCallback = null
) {
  const {
    discType = "DVD",
    playlistFile = null,
    audioTracks = [],
    subtitleTracks = []
  } = options;

  // Sends progress in disc scanning and ripping.
  const sendProgress = (percent, message = "") => {
    if (!progressCallback) return;

    const normalizedMessage =
      typeof message === "string"
        ? message
        : message && typeof message.message === "string"
        ? message.message
        : "";

    const payload = {
      type: "progress",
      titleIndex,
      percent,
      message: normalizedMessage || `Title ${titleIndex}: %${percent}`,
      overlayPercent: percent
    };
    if (
      message &&
      typeof message === "object" &&
      message.__i18n &&
      message.key
    ) {
      payload.__i18n = true;
      payload.key = message.key;
      payload.vars = message.vars || {};
    }

    progressCallback(payload);
  };

  if (discType === "Blu-ray") {
    return ripBluRayTitle(
      sourcePath,
      titleIndex,
      outputPath,
      {
        playlistFile,
        audioTracks,
        subtitleTracks
      },
      sendProgress
    );
  } else {
    return ripDvdTitle(
      sourcePath,
      titleIndex,
      outputPath,
      {
        audioTracks,
        subtitleTracks
      },
      sendProgress
    );
  }
}

// Handles rip progress dvd title in disc scanning and ripping.
async function ripDvdTitle(
  sourcePath,
  titleIndex,
  outputPath,
  options = {},
  progressCallback = null
) {
  const { audioTracks = [], subtitleTracks = [] } = options;

  try {
    if (progressCallback) progressCallback(5, { __i18n: true, key: "disc.progress.preparing", vars: {} });

    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    let videoTsPath = sourcePath;
    if (path.basename(sourcePath) !== "VIDEO_TS") {
      videoTsPath = path.join(sourcePath, "VIDEO_TS");
    }

    if (progressCallback)
    progressCallback(10, "Searching VOB/IFO files...");
    const vobFiles = await getMainVOBFilesForTitle(videoTsPath, titleIndex);

    if (vobFiles.length === 0) {
      throw new Error(`No VOB found for title ${titleIndex}`);
    }

    const expectedSizeBytes = await estimateDvdTitleSize(
      videoTsPath,
      titleIndex
    );

    if (progressCallback) progressCallback(20, { __i18n: true, key: "disc.progress.analyzingTracks", vars: {} });
    const trackInfo = await analyzeDvdTracks(videoTsPath, titleIndex);

    const args = [];

    args.push("-o", outputPath);

    if (
      audioTracks.length > 0 &&
      Array.isArray(trackInfo.audioIds) &&
      trackInfo.audioIds.length
    ) {
      const selectedAudioIds = audioTracks
        .map((idx) => trackInfo.audioIds[idx])
        .filter((id) => id !== undefined);

      if (selectedAudioIds.length > 0) {
        args.push("--audio-tracks", selectedAudioIds.join(","));
      }
    }

    if (
      subtitleTracks.length > 0 &&
      Array.isArray(trackInfo.subtitleIds) &&
      trackInfo.subtitleIds.length
    ) {
      const selectedSubtitleIds = subtitleTracks
        .map((idx) => trackInfo.subtitleIds[idx])
        .filter((id) => id !== undefined);

      if (selectedSubtitleIds.length > 0) {
        args.push("--subtitle-tracks", selectedSubtitleIds.join(","));
      }
    }

    const inputSource = vobFiles[0];
    args.push(inputSource);

    console.log("DVD rip args:", [MKVMERGE_BIN, ...args].join(" "));

    if (progressCallback) progressCallback(30, { __i18n: true, key: "disc.progress.creatingMkv", vars: {} });

    let stdout, stderr;
    try {
      const result = await runRipCommand(
        args,
        outputPath,
        progressCallback,
        expectedSizeBytes
      );
      stdout = result.stdout;
      stderr = result.stderr;

      if (progressCallback) progressCallback(100, "Completed successfully");
        } catch (execError) {
        if (execError.message === "RIP_CANCELLED") {
        throw execError;
      }

      stdout = execError.stdout;
      stderr = execError.stderr;

      try {
        await fs.access(outputPath);
        const stats = await fs.stat(outputPath);
        if (stats.size > 0) {
          if (progressCallback)
            progressCallback(100, { __i18n: true, key: "disc.progress.completedWithWarnings", vars: {} });
          return {
            success: true,
            outputPath,
            message: `DVD title ${titleIndex} created as MKV - completed with warnings`
          };
        }
      } catch (accessError) {
        throw new Error(`mkvmerge hatası: ${execError.message}`);
      }

      throw execError;
    }

    if (stdout) console.log("mkvmerge stdout:", stdout);
    if (stderr) console.log("mkvmerge stderr:", stderr);

    try {
      await fs.access(outputPath);
      const stats = await fs.stat(outputPath);
      console.log(`Created file size: ${stats.size} bytes`);

      if (stats.size === 0) {
        throw new Error("Created file is empty");
      }
    } catch (accessError) {
      throw new Error("Output file could not be created: " + accessError.message);
    }

    return {
      success: true,
      outputPath,
      message: `DVD title ${titleIndex} created as MKV`
    };
  } catch (error) {
    if (progressCallback) progressCallback(0, `Error: ${error.message}`);
    throw error;
  }
}

// Handles rip progress blu ray title in disc scanning and ripping.
async function ripBluRayTitle(
  sourcePath,
  titleIndex,
  outputPath,
  options = {},
  progressCallback = null
) {
  const { playlistFile, audioTracks = [], subtitleTracks = [] } = options;

  try {
    if (progressCallback) progressCallback(5, { __i18n: true, key: "disc.progress.preparing", vars: {} });

    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    if (!playlistFile) {
      throw new Error(
        `No playlist (mpls) info for Blu-ray title ${titleIndex}`
      );
    }

    const playlistPath = path.join(
      sourcePath,
      "BDMV",
      "PLAYLIST",
      playlistFile
    );

    try {
      await fs.access(playlistPath);
    } catch {
      throw new Error(`Playlist file not found: ${playlistPath}`);
    }

    if (progressCallback) progressCallback(15, { __i18n: true, key: "disc.progress.gettingTrackInfo", vars: {} });

    let audioTrackIds = [];
    let subtitleTrackIds = [];
    let mkvmergeInfo = null;

    try {
      const { stdout: tracksJson } = await execJsonUnlimited(
        `"${MKVMERGE_BIN}" -J "${playlistPath}"`, progressCallback
      );
      const info = JSON.parse(tracksJson || "{}");
      mkvmergeInfo = info;

      (info.tracks || []).forEach((track) => {
        if (track.type === "audio") {
          audioTrackIds.push(track.id);
        } else if (track.type === "subtitles") {
          subtitleTrackIds.push(track.id);
        }
      });
    } catch (err) {
      console.warn(
        "Blu-ray track ID analysis failed, all tracks will be included:",
        err.message
      );
    }

    const args = [];

    args.push("-o", outputPath);

    if (audioTrackIds.length > 0) {
      let selectedAudioIds;

      if (audioTracks.length > 0) {
        selectedAudioIds = audioTracks
          .map((idx) => audioTrackIds[idx])
          .filter((id) => id !== undefined);
      } else {
        selectedAudioIds = audioTrackIds;
      }

      if (selectedAudioIds.length > 0) {
        args.push("--audio-tracks", selectedAudioIds.join(","));
      }
    }

    if (subtitleTrackIds.length > 0) {
      let selectedSubtitleIds;

      if (subtitleTracks.length > 0) {
        selectedSubtitleIds = subtitleTracks
          .map((idx) => subtitleTrackIds[idx])
          .filter((id) => id !== undefined);
      } else {
        selectedSubtitleIds = subtitleTrackIds;
      }

      if (selectedSubtitleIds.length > 0) {
        args.push("--subtitle-tracks", selectedSubtitleIds.join(","));
      }
    }

    args.push(playlistPath);

    console.log("Blu-ray rip args:", [MKVMERGE_BIN, ...args].join(" "));

    let expectedSizeBytes = 0;
    if (mkvmergeInfo) {
      expectedSizeBytes = await estimateBluRayTitleSize(
        sourcePath,
        mkvmergeInfo
      );
    }

    if (progressCallback) progressCallback(25, { __i18n: true, key: "disc.progress.processingBluray", vars: {} });

    const { stdout, stderr } = await runRipCommand(
      args,
      outputPath,
      progressCallback,
      expectedSizeBytes || null
    );

    if (progressCallback) progressCallback(100, { __i18n: true, key: "disc.progress.successfullyCompleted", vars: {} });
    if (stdout) console.log("mkvmerge stdout:", stdout);
    if (stderr) console.log("mkvmerge stderr:", stderr);

    try {
      await fs.access(outputPath);
      const stats = await fs.stat(outputPath);
      console.log(`Created file size: ${stats.size} bytes`);

      if (stats.size === 0) {
        throw new Error("Created file is empty");
      }
    } catch (accessError) {
      throw new Error("Output file could not be created: " + accessError.message);
    }

    return {
      success: true,
      outputPath,
      message: "Blu-ray title created as MKV"
    };
  } catch (error) {
    if (progressCallback) progressCallback(0, `Error: ${error.message}`);
    throw error;
  }
}

// Handles estimate blu ray title size in disc scanning and ripping.
async function estimateBluRayTitleSize(sourcePath, mkvmergeInfo) {
  try {
    const props = mkvmergeInfo?.container?.properties || {};
    if (typeof props.playlist_size === "number" && props.playlist_size > 0) {
      console.log(
        "Blu-ray total size (playlist_size):",
        props.playlist_size,
        "(" + formatFileSize(props.playlist_size) + ")"
      );
      return props.playlist_size;
    }

    let total = 0;

    if (Array.isArray(props.playlist_file) && props.playlist_file.length > 0) {
      for (const filePath of props.playlist_file) {
        const fullPath = path.isAbsolute(filePath)
          ? filePath
          : path.join(sourcePath, "BDMV", "STREAM", filePath);

        try {
          const stats = await fs.stat(fullPath);
          total += stats.size;
        } catch (err) {
          console.warn("Failed to read M2TS size:", fullPath, err.message);
        }
      }

      if (total > 0) {
        console.log(
          "Blu-ray total size (playlist_file sum):",
          total,
          "(" + formatFileSize(total) + ")"
        );
        return total;
      }
    }

    const bdmvPath = path.join(sourcePath, "BDMV");
    const streamPath = path.join(bdmvPath, "STREAM");
    let legacyTotal = 0;

    const playlistEntry = Array.isArray(mkvmergeInfo.playlist)
      ? mkvmergeInfo.playlist[0]
      : null;

    if (playlistEntry && Array.isArray(playlistEntry.files)) {
      for (const f of playlistEntry.files) {
        const fileName = f.file_name || f.name || null;
        if (!fileName) continue;

        const fullPath = path.join(streamPath, fileName);
        try {
          const stats = await fs.stat(fullPath);
          legacyTotal += stats.size;
        } catch (err) {
          console.warn(
            "Failed to read M2TS size (legacy):",
            fullPath,
            err.message
          );
        }
      }
    }

    if (legacyTotal > 0) {
      console.log(
        "Blu-ray total size (legacy playlist files):",
        legacyTotal,
        "(" + formatFileSize(legacyTotal) + ")"
      );
      return legacyTotal;
    }
    console.log("Blu-ray size could not be estimated, returning 0");
    return 0;
  } catch (err) {
    console.warn("Blu-ray size estimation error:", err.message);
    return 0;
  }
}

// Handles analyze dvd tracks in disc scanning and ripping.
async function analyzeDvdTracks(videoTsPath, titleIndex) {
  // Parses tracks for disc scanning and ripping.
  const parseTracks = (info) => {
    const audioIds = [];
    const subtitleIds = [];

    (info.tracks || []).forEach((track) => {
      if (track.type === "audio") {
        audioIds.push(track.id);
      } else if (track.type === "subtitles") {
        subtitleIds.push(track.id);
      }
    });

    return {
      audioCount: audioIds.length,
      subtitleCount: subtitleIds.length,
      totalTracks: (info.tracks || []).length,
      audioIds,
      subtitleIds
    };
  };

  try {
    const vobFiles = await getMainVOBFilesForTitle(videoTsPath, titleIndex);
    if (!vobFiles.length) {
      throw new Error(`No VOB found for title ${titleIndex}`);
    }

    const sampleVob = vobFiles[0];
    const { stdout } = await execJsonUnlimited(
      `"${MKVMERGE_BIN}" -J "${sampleVob}"`, null
    );
    const info = JSON.parse(stdout || "{}");
    return parseTracks(info);
  } catch (error) {
    console.log(
      "DVD track analysis error, using fallback defaults:",
      error.message
    );
    return {
      audioCount: 3,
      subtitleCount: 3,
      totalTracks: 7,
      audioIds: [],
      subtitleIds: []
    };
  }
}

// Returns main vobfiles for title used for disc scanning and ripping.
async function getMainVOBFilesForTitle(videoTsPath, titleIndex) {
  try {
    const files = await fs.readdir(videoTsPath);
    const titlePrefix = `VTS_${titleIndex.toString().padStart(2, "0")}_`;

    const vobFiles = files
      .filter(
        (f) =>
          f.toUpperCase().startsWith(titlePrefix) &&
          f.toUpperCase().endsWith(".VOB") &&
          !f.toUpperCase().includes("_0.VOB")
      )
      .sort((a, b) => {
        const numA = parseInt(
          a.match(/_(\d+)\.VOB$/i)?.[1] || "0"
        );
        const numB = parseInt(
          b.match(/_(\d+)\.VOB$/i)?.[1] || "0"
        );
        return numA - numB;
      })
      .map((f) => path.join(videoTsPath, f));

    return vobFiles;
  } catch (err) {
    throw new Error(`VOB search error: ${err.message}`);
  }
}

export { ripTitle, cancelRip };
