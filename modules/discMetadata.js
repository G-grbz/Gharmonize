import fs from "fs/promises";
import path from "path";
import { sanitizeFilename } from "./utils.js";
import { MKVPROPEDIT_BIN } from "./binaries.js";
import { assertPathWithinAny, sanitizeLogValue } from "./security.js";
import { execMkvpropeditSafe } from "./safeProcess.js";


function discOutputRoots() {
  const baseDir = path.resolve(process.env.DATA_DIR || process.cwd());
  const roots = [
    path.resolve(baseDir, "outputs"),
    path.resolve(baseDir, "temp"),
    path.resolve(baseDir, process.env.LOCAL_INPUT_DIR || "local-inputs")
  ];
  const extra = String(process.env.DISC_OUTPUT_ROOTS || "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));
  return [...roots, ...extra];
}

function safeDiscOutputPath(value) {
  return assertPathWithinAny(path.resolve(String(value || "")), discOutputRoots());
}

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

  const safeOutputPath = safeDiscOutputPath(outputPath);
  const metadataPath = safeDiscOutputPath(safeOutputPath.replace(/\.mkv$/i, ".json"));
  // The sidecar path is derived only from a disc output path confined to the allowed output roots.
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), { mode: 0o600 });

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
    const safeMkvPath = safeDiscOutputPath(mkvPath);
    await new Promise((resolve, reject) => {
      execMkvpropeditSafe(MKVPROPEDIT_BIN, [safeMkvPath, ...args], (error) => error ? reject(error) : resolve());
    });
    return { success: true };
  } catch (error) {
    // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
    console.warn("Metadata write error:", sanitizeLogValue(error?.message || error));
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
