import express from "express";
import path from "path";
import fs from "fs";
import { scanDisc, cancelScan } from "../modules/discScanner.js";
import { ripTitle, cancelRip } from "../modules/discRipper.js";
import {
  generateMetadata,
  writeMetadataToMKV,
  generateDiscFilename
} from "../modules/discMetadata.js";
import { requireAuth } from "../modules/settings.js";

const router = express.Router();
const BASE_DIR = process.env.DATA_DIR || process.cwd();
const LOCAL_INPUTS_DIR = process.env.LOCAL_INPUT_DIR
  ? path.resolve(process.env.LOCAL_INPUT_DIR)
  : path.resolve(BASE_DIR, "local-inputs");

fs.mkdirSync(LOCAL_INPUTS_DIR, { recursive: true });

const discClients = new Set();

// Serializes API errors so the browser can translate i18n keys.
function serializeDiscError(error) {
  if (error?.i18nKey) {
    return {
      error: error.i18nKey,
      vars: error.i18nVars || {}
    };
  }

  return {
    error:
      typeof error?.message === "string" && error.message
        ? error.message
        : String(error ?? "Unknown error")
  };
}

// Maps known disc errors to HTTP statuses.
function getDiscErrorStatus(error) {
  if (typeof error?.statusCode === "number") {
    return error.statusCode;
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return 403;
  }
  return 500;
}

// Waits until the output file size stops changing before announcing completion.
async function waitForStableOutputFile(
  filePath,
  {
    intervalMs = 1000,
    stableSamples = 3,
    timeoutMs = 30000
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableCount = 0;

  while (Date.now() < deadline) {
    try {
      const stats = await fs.promises.stat(filePath);
      const currentSize = stats.size;

      if (currentSize > 0 && currentSize === lastSize) {
        stableCount += 1;
        if (stableCount >= stableSamples) {
          return currentSize;
        }
      } else {
        stableCount = 0;
        lastSize = currentSize;
      }
    } catch {
      stableCount = 0;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return lastSize > 0 ? lastSize : 0;
}

// Sends one SSE payload to a connected client.
function sendToClient(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (e) {
  }
}

// Broadcasts progress updates to all connected SSE clients.
function broadcastProgress(payload) {
  for (const res of discClients) {
    sendToClient(res, payload);
  }
}

router.get("/api/disc/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  res.write(`: ping\n\n`);
  discClients.add(res);

  req.on("close", () => {
    discClients.delete(res);
  });
});

// Sends scan progress log in Express API request handling.
function sendScanLog(payload) {
  if (payload && typeof payload === "object" && payload.__i18n) {
    broadcastProgress({
      type: "scan_log",
      i18n: true,
      key: payload.key,
      vars: payload.vars || {}
    });
  } else {
    broadcastProgress({
      type: "scan_log",
      message:
        typeof payload === "string" ? payload : String(payload ?? "")
    });
  }
}

// Returns a download route for an output file path.
function buildDownloadPath(filePath) {
  return `/download/${encodeURIComponent(path.basename(filePath))}`;
}

// Returns output file metadata when a rip produced a usable file.
async function getExistingOutputInfo(filePath) {
  if (!filePath) {
    return null;
  }

  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile() || stats.size <= 0) {
      return null;
    }

    return {
      path: filePath,
      size: stats.size,
      downloadPath: buildDownloadPath(filePath)
    };
  } catch {
    return null;
  }
}

// Removes a rip output file if it exists.
async function removeOutputFile(filePath) {
  if (!filePath) {
    return;
  }

  await fs.promises.rm(filePath, { force: true }).catch(() => {});
}

router.post("/api/disc/scan", express.json(), async (req, res) => {
  try {
    const { sourcePath } = req.body || {};
    if (!sourcePath) {
      return res.status(400).json({ error: "sourcePath gerekli" });
    }

    global.discScanLog = sendScanLog;

    const discInfo = await scanDisc(sourcePath);

    delete global.discScanLog;

    res.json(discInfo);
  } catch (error) {
    delete global.discScanLog;

    if (error.message === "SCAN_CANCELLED") {
      return res.status(499).json({ error: "Scan cancelled" });
    }

    console.error("[disc] scan error:", error);
    res.status(getDiscErrorStatus(error)).json(serializeDiscError(error));
  }
});

router.post("/api/disc/cancel-scan", (req, res) => {
  try {
    sendScanLog({
      __i18n: true,
      key: "disc.log.scanCancelRequested",
      vars: {}
    });
    cancelScan();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/api/disc/rip", express.json(), async (req, res) => {
  try {
    const {
      sourcePath,
      titleIndex,
      options,
      titleInfo,
      outputFileName
    } = req.body || {};

    if (!sourcePath || typeof titleIndex === "undefined") {
      return res
        .status(400)
        .json({ error: "sourcePath ve titleIndex gerekli" });
    }

    let fileName = outputFileName;
    if (!fileName) {
      fileName = generateDiscFilename(
        {
          ...titleInfo,
          index: titleIndex,
          sourcePath
        },
        "mkv"
      );
    }

    const outputPath = path.join(LOCAL_INPUTS_DIR, fileName);
    const safeOutputPath = path.resolve(outputPath);
    if (!safeOutputPath.startsWith(LOCAL_INPUTS_DIR)) {
      return res.status(400).json({ error: "Geçersiz output path" });
    }

    fs.mkdirSync(path.dirname(safeOutputPath), { recursive: true });

    broadcastProgress({
      type: "title_start",
      titleIndex,
      message: `Title ${titleIndex} işleniyor...`,
      outputFile: fileName
    });

    // Handles progress callback in Express API request handling.
    const progressCallback = (payload) => {
      broadcastProgress({ ...payload, outputFile: fileName });
    };
    res.status(202).json({
      accepted: true,
      titleIndex,
      outputFile: fileName
    });

    void (async () => {
      try {
        const ripResult = await ripTitle(
          sourcePath,
          titleIndex,
          safeOutputPath,
          options || {},
          progressCallback
        );

        let metadata = null;
        let metadataWriteResult = null;
        try {
          const enrichedTitleInfo = {
            ...titleInfo,
            sourcePath,
            sourceType: options?.discType || titleInfo?.sourceType || "Unknown"
          };
          metadata = await generateMetadata(enrichedTitleInfo, safeOutputPath);
          metadataWriteResult = await writeMetadataToMKV(
            safeOutputPath,
            metadata
          );
        } catch (metaErr) {
          console.warn("[disc] metadata warning:", metaErr.message);
        }

        broadcastProgress({
          type: "progress",
          titleIndex,
          percent: 99,
          __i18n: true,
          key: "disc.progress.finalizingOutput",
          vars: {}
        });

        const stabilizedSize = await waitForStableOutputFile(safeOutputPath);
        console.log("[disc] output stabilized:", {
          titleIndex,
          path: safeOutputPath,
          size: stabilizedSize
        });

        broadcastProgress({
          type: "title_complete",
          titleIndex,
          message: `Title ${titleIndex} tamamlandı`,
          outputFile: fileName,
          downloadPath: buildDownloadPath(safeOutputPath),
          metadata: !!metadata,
          metadataWrittenToMkv: !!metadataWriteResult?.success,
          ripResult
        });
      } catch (error) {
        console.error("[disc] rip error:", error);

        if (error.message === "RIP_CANCELLED") {
          broadcastProgress({
            type: "rip_cancelled",
            titleIndex,
            message: "Rip işlemi iptal edildi"
          });

          await removeOutputFile(safeOutputPath);
          return;
        }

        const existingOutput = await getExistingOutputInfo(safeOutputPath);
        let errorMessage = error.message;

        if (existingOutput) {
          errorMessage += ` (çıktı korundu: ${fileName})`;
          console.warn("[disc] preserving output after error:", {
            titleIndex,
            path: safeOutputPath,
            size: existingOutput.size
          });
        } else {
          await removeOutputFile(safeOutputPath);
        }

        broadcastProgress({
          type: "title_error",
          titleIndex,
          message: errorMessage,
          outputFile: fileName,
          preservedOutput: !!existingOutput,
          downloadPath: existingOutput?.downloadPath || null
        });
      }
    })();
  } catch (error) {
    console.error("[disc] rip request error:", error);
    res.status(500).json({ error: error.message });
  }
});

router.post("/api/disc/cancel-rip", (req, res) => {
  try {
    cancelRip();
    broadcastProgress({
      type: "rip_cancelled",
      message: "Rip işlemi iptal edildi"
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post("/api/disc/metadata", express.json(), async (req, res) => {
  try {
    const { titleInfo, outputPath } = req.body || {};
    if (!titleInfo || !outputPath) {
      return res
        .status(400)
        .json({ error: "titleInfo ve outputPath gerekli" });
    }
    const metadata = await generateMetadata(titleInfo, outputPath);
    res.json(metadata);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
