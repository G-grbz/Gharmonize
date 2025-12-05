import fs from "fs/promises";
import path from "path";
import { sanitizeFilename } from "./utils.js";

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

export async function writeMetadataToMKV(mkvPath, metadata) {
  let command = `mkvpropedit "${mkvPath}" `;

  if (metadata.title) {
    command += `--set title="${metadata.title}" `;
  }

  try {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    await execAsync(command);
    return { success: true };
  } catch (error) {
    console.warn("Metadata write error:", error.message);
    return { success: false, error: error.message };
  }
}

export function generateDiscFilename(titleInfo, extension = "mkv") {
  const sourceNameRaw = path.basename(titleInfo.sourcePath || "disc");
  const sourceName = sanitizeFilename(sourceNameRaw);
  const trackNumber = String(titleInfo.index ?? 0).padStart(2, "0");
  const durationMinutes = Math.max(1, Math.round((titleInfo.duration || 0) / 60));
  return `${sourceName}_title${trackNumber}_${durationMinutes}min.${extension}`;
}
