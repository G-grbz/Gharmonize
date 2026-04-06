import fs from "fs/promises";
import path from "path";
import { sanitizeFilename } from "./utils.js";
import { MKVPROPEDIT_BIN } from "./binaries.js";

// Generates metadata for disc scanning and ripping.
export async function generateMetadata(titleInfo, outputPath) {
  let baseTitle;

  if (titleInfo.discTitle && typeof titleInfo.discTitle === "string") {
    baseTitle = titleInfo.discTitle.trim();
  } else if (titleInfo.name && typeof titleInfo.name === "string") {
    baseTitle = titleInfo.name.trim();
  } else {
    baseTitle = `Title_${titleInfo.index}`;
  }

  const finalTitle = baseTitle;

  const metadata = {
    title: finalTitle,
    discTitle: titleInfo.discTitle || null,
    discLanguage: titleInfo.discLanguage || null,
    playlistFile: titleInfo.playlistFile || null,
    duration: titleInfo.duration,
    chapters: titleInfo.chapters || [],
    audioTracks: titleInfo.audioTracks || [],
    subtitleTracks: titleInfo.subtitleTracks || [],
    sourceType: titleInfo.sourceType,
    sourcePath: titleInfo.sourcePath || null,
    creationDate: new Date().toISOString()
  };

  const metadataPath = outputPath.replace(/\.mkv$/i, ".json");
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  return metadata;
}

// Persists metadata to mkv for disc scanning and ripping.
export async function writeMetadataToMKV(mkvPath, metadata) {
  const args = [];

  if (metadata.title) {
    args.push("--edit", "info", "--set", `title=${metadata.title}`);
  }

  if (args.length === 0) {
    return { success: true, skipped: true };
  }

  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    await execFileAsync(MKVPROPEDIT_BIN, [mkvPath, ...args]);
    return { success: true };
  } catch (error) {
    console.warn("Metadata write error:", error.message);
    return { success: false, error: error.message };
  }
}

// Generates disc metadata filename for disc scanning and ripping.
export function generateDiscFilename(titleInfo, extension = "mkv") {
  const sourceNameRaw = path.basename(titleInfo.sourcePath || "disc");
  const sourceName = sanitizeFilename(sourceNameRaw);
  const trackNumber = String(titleInfo.index ?? 0).padStart(2, "0");
  const durationMinutes = Math.max(1, Math.round((titleInfo.duration || 0) / 60));
  return `${sourceName}_title${trackNumber}_${durationMinutes}min.${extension}`;
}
