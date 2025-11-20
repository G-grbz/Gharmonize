import express from "express";
import path from "path";
import fs from "fs";

const router = express.Router();
const BASE_DIR = process.env.DATA_DIR || process.cwd();
const OUTPUT_DIR = path.resolve(BASE_DIR, "outputs");

router.get("/download/:file", (req, res) => {
  const requested = req.params.file || "";
  const filename = path.basename(requested);
  const abs = path.join(OUTPUT_DIR, filename);

  if (!abs.startsWith(OUTPUT_DIR)) {
    return res.status(400).send("Bad path");
  }

  if (!fs.existsSync(abs)) {
    console.warn("[download] Not found:", abs);
    return res.status(404).send("Not found");
  }

  const isZip = filename.toLowerCase().endsWith(".zip");
  res.setHeader("Content-Type", isZip ? "application/zip" : "application/octet-stream");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
  );

  return res.download(abs, filename);
});

export default router;
