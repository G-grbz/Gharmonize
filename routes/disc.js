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
    res.status(500).json({ error: error.message });
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
  let outputPath = "";
  let currentTitleIndex = null;

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

    currentTitleIndex = titleIndex;

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

    outputPath = path.join(LOCAL_INPUTS_DIR, fileName);
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

    const ripResult = await ripTitle(
      sourcePath,
      titleIndex,
      safeOutputPath,
      options || {},
      progressCallback
    );

    let metadata = null;
    try {
      const enrichedTitleInfo = {
        ...titleInfo,
        sourcePath,
        sourceType: options?.discType || titleInfo?.sourceType || "Unknown"
      };
      metadata = await generateMetadata(enrichedTitleInfo, safeOutputPath);
      await writeMetadataToMKV(safeOutputPath, metadata);
    } catch (metaErr) {
      console.warn("[disc] metadata warning:", metaErr.message);
    }

    broadcastProgress({
      type: "title_complete",
      titleIndex,
      message: `Title ${titleIndex} tamamlandı`,
      outputFile: fileName
    });

    res.json({
      ...ripResult,
      metadata,
      downloadPath: `/download/${encodeURIComponent(
        path.basename(safeOutputPath)
      )}`
    });
  } catch (error) {
    console.error("[disc] rip error:", error);

    if (error.message === "RIP_CANCELLED") {
      if (currentTitleIndex !== null) {
        broadcastProgress({
          type: "rip_cancelled",
          titleIndex: currentTitleIndex,
          message: "Rip işlemi iptal edildi"
        });
      }

      try {
        if (outputPath && fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      } catch {}

      return res.status(499).json({ error: "Rip cancelled" });
    }

    if (currentTitleIndex !== null) {
      broadcastProgress({
        type: "title_error",
        titleIndex: currentTitleIndex,
        message: `Title ${currentTitleIndex} hatası: ${error.message}`
      });
    }

    try {
      if (outputPath && fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    } catch {}

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
