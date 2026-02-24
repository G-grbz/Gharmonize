import fs from "fs";
import path from "path";

const TURKISH_SPECIFIC_RE = /[ĞğİıŞş]/;

// Parses track number for core application logic.
function parseTrackNumber(meta = {}) {
  const direct = Number(meta.track_number);
  if (Number.isFinite(direct) && direct >= 0) {
    return Math.max(0, Math.min(255, Math.floor(direct)));
  }
  const fromTrack = String(meta.track || "").match(/^\s*(\d{1,3})(?:\s*\/\s*\d{1,3})?\s*$/);
  if (fromTrack) {
    const n = Number(fromTrack[1]);
    if (Number.isFinite(n) && n >= 0) return Math.max(0, Math.min(255, Math.floor(n)));
  }
  return 0;
}

// Returns id3v1 encoding used for core application logic.
function getId3v1Encoding(values = []) {
  const env = String(process.env.ID3V1_ENCODING || "auto").trim().toLowerCase();
  if (["latin1", "iso-8859-1"].includes(env)) return "latin1";
  if (["latin5", "iso-8859-9", "windows-1254", "cp1254"].includes(env)) return "latin5";

  const joined = values.filter(Boolean).join(" ");
  return TURKISH_SPECIFIC_RE.test(joined) ? "latin5" : "latin1";
}

// Handles map latin5 byte in core application logic.
function mapLatin5Byte(ch) {
  switch (ch) {
    case "Ğ":
      return 0xd0;
    case "ğ":
      return 0xf0;
    case "İ":
      return 0xdd;
    case "ı":
      return 0xfd;
    case "Ş":
      return 0xde;
    case "ş":
      return 0xfe;
    default:
      return null;
  }
}

// Handles encode id3v1 field in core application logic.
function encodeId3v1Field(text, maxLen, encoding) {
  const out = Buffer.alloc(maxLen, 0x00);
  const s = String(text || "").normalize("NFC");
  let i = 0;

  for (const ch of s) {
    if (i >= maxLen) break;
    const latin5 = encoding === "latin5" ? mapLatin5Byte(ch) : null;
    if (latin5 !== null) {
      out[i++] = latin5;
      continue;
    }

    const code = ch.codePointAt(0);
    if (Number.isFinite(code) && code >= 0x20 && code <= 0xff) {
      out[i++] = code;
    } else {
      out[i++] = 0x3f;
    }
  }

  return out;
}

// Handles rewrite id3v11 tag in core application logic.
export function rewriteId3v11Tag(filePath, meta = {}) {
  try {
    if (String(path.extname(filePath) || "").toLowerCase() !== ".mp3") return false;
    if (!fs.existsSync(filePath)) return false;

    const title = meta.track || meta.title || "";
    const artist = meta.artist || meta.album_artist || meta.uploader || "";
    const album = meta.album || meta.playlist_title || "";
    const year = String(meta.release_year || meta.upload_year || "").slice(0, 4);
    const comment = meta.comment || "";

    const encoding = getId3v1Encoding([title, artist, album, comment]);
    const trackNo = parseTrackNumber(meta);
    const genre = 255;

    const tag = Buffer.alloc(128, 0x00);
    tag.write("TAG", 0, 3, "ascii");
    encodeId3v1Field(title, 30, encoding).copy(tag, 3);
    encodeId3v1Field(artist, 30, encoding).copy(tag, 33);
    encodeId3v1Field(album, 30, encoding).copy(tag, 63);
    encodeId3v1Field(year, 4, encoding).copy(tag, 93);
    encodeId3v1Field(comment, 28, encoding).copy(tag, 97);
    tag[125] = 0x00;
    tag[126] = trackNo;
    tag[127] = genre;

    const fd = fs.openSync(filePath, "r+");
    try {
      const stat = fs.fstatSync(fd);
      let offset = stat.size;
      if (stat.size >= 128) {
        const tail = Buffer.alloc(128);
        fs.readSync(fd, tail, 0, 128, stat.size - 128);
        if (tail.slice(0, 3).toString("ascii") === "TAG") {
          offset = stat.size - 128;
        }
      }
      fs.writeSync(fd, tag, 0, tag.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}
