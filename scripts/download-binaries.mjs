//scripts/download-binaries.mjs

import https from 'https';
import http from 'http';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PLATFORM = process.platform;
const ARCH = process.arch;

const args = process.argv.slice(2);
const NO_PATH = args.includes('--no-path');

const TARGET_DIR = path.join(__dirname, '..', 'build', 'bin');

function log(...a) {
  console.log('[download-binaries]', ...a);
}
function logError(...a) {
  console.error('[download-binaries][ERROR]', ...a);
}

async function which(bin) {
  const paths = process.env.PATH ? process.env.PATH.split(path.delimiter) : [];
  for (const p of paths) {
    const full = path.join(p, bin);
    try {
      await fsp.access(full, fs.constants.X_OK);
      return full;
    } catch {}
  }
  return null;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function downloadFileWithRedirect(url, dest, onProgress = null, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const visited = [];

    function doRequest(currentUrl, redirectsLeft) {
      visited.push(currentUrl);

      const urlObj = new URL(currentUrl);
      const lib = urlObj.protocol === 'http:' ? http : https;

      const req = lib.get(urlObj, (res) => {
        const { statusCode, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          if (redirectsLeft <= 0) {
            res.resume();
            return reject(
              new Error(`Too many redirects: ${visited.join(' -> ')} -> ${headers.location}`)
            );
          }
          const nextUrl = new URL(headers.location, currentUrl).toString();
          res.resume();
          log(`Redirected: ${currentUrl} -> ${nextUrl}`);
          return doRequest(nextUrl, redirectsLeft - 1);
        }

        if (statusCode !== 200) {
          res.resume();
          return reject(
            new Error(`Request failed with status ${statusCode} ${res.statusMessage}`)
          );
        }

        const contentLength = parseInt(headers['content-length'], 10);
        let downloaded = 0;
        let progressReported = 0;

        const file = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (onProgress && contentLength) {
            const percent = Math.round((downloaded / contentLength) * 100);
            if (percent > progressReported) {
              progressReported = percent;
              onProgress(downloaded, contentLength, percent);
            }
          }
        });

        res.pipe(file);
        file.on('finish', () => {
          file.close();
          if (onProgress && contentLength) {
            onProgress(contentLength, contentLength, 100);
          }
          resolve();
        });
        file.on('error', (err) => {
          fs.unlink(dest, () => reject(err));
        });
      });

      req.on('error', (err) => {
        reject(err);
      });
    }

    doRequest(url, maxRedirects);
  });
}

function createProgressBar(toolName) {
  let lastPercent = -1;

  return function(downloaded, total, percent) {
    if (percent === lastPercent) return;
    lastPercent = percent;

    const barLength = 20;
    const filled = Math.round((percent / 100) * barLength);
    const empty = barLength - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);

    const sizeInfo = total
      ? `(${(downloaded / 1024 / 1024).toFixed(1)}MB/${(total / 1024 / 1024).toFixed(1)}MB)`
      : `(${(downloaded / 1024 / 1024).toFixed(1)}MB)`;

    process.stdout.write(`\r${toolName}: [${bar}] ${percent}% ${sizeInfo}`);

    if (percent === 100) {
      process.stdout.write('\n');
    }
  };
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function extractTarXZ(archivePath, outputDir) {
  await run('tar', ['-xf', archivePath, '-C', outputDir]);
}

async function extractZip(zipPath, outputDir) {
  if (PLATFORM === 'win32') {
    const psArgs = [
      '-NoLogo',
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outputDir}' -Force`
    ];

    await run('powershell', psArgs);
  } else {
    await run('unzip', ['-o', zipPath, '-d', outputDir]);
  }
}

async function findFileRecursive(dir, fileName) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFileRecursive(full, fileName).catch(() => null);
      if (found) return found;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  throw new Error(`${fileName} not found in extracted archive`);
}

const DEFAULTS = {
  linux: {
    ffmpeg: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
      type: 'tar',
      find: 'ffmpeg'
    },
    ffprobe: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
      type: 'tar',
      find: 'ffprobe'
    },
    mkvmerge: {
      url: 'https://mkvtoolnix.download/appimage/MKVToolNix_GUI-96.0-x86_64.AppImage',
      type: 'direct',
      out: 'mkvmerge'
    },
    ytdlp: {
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2025.12.08/yt-dlp',
      type: 'direct',
      out: 'yt-dlp'
    },
    deno: {
      url: 'https://github.com/denoland/deno/releases/download/v2.6.0/deno-x86_64-unknown-linux-gnu.zip',
      type: 'zip',
      find: 'deno'
    }
  },

  win32: {
    ffmpeg: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
      type: 'zip',
      find: 'ffmpeg.exe'
    },
    ffprobe: {
      url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip',
      type: 'zip',
      find: 'ffprobe.exe'
    },
    mkvmerge: {
      url: 'https://mkvtoolnix.download/windows/releases/96.0/mkvtoolnix-64-bit-96.0.zip',
      type: 'zip',
      find: 'mkvmerge.exe'
    },
    ytdlp: {
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2025.12.08/yt-dlp.exe',
      type: 'direct',
      out: 'yt-dlp.exe'
    },
    deno: {
      url: 'https://github.com/denoland/deno/releases/download/v2.6.0/deno-x86_64-pc-windows-msvc.zip',
      type: 'zip',
      find: 'deno.exe'
    }
  }
};

const TOOL_ORDER = ['ffmpeg', 'ffprobe', 'mkvmerge', 'ytdlp', 'deno'];
const downloadCache = new Map();
const extractCache = new Map();

async function processTool(tool) {
  const defaults = DEFAULTS[PLATFORM]?.[tool];
  if (!defaults) {
    logError(`${tool}: no defaults for platform ${PLATFORM}`);
    return;
  }

  const envVarName = `GHARMONIZE_${tool.toUpperCase()}_URL`;
  const envUrl = process.env[envVarName];

  const url = envUrl || defaults.url;

  const outName =
    PLATFORM === 'win32'
      ? (tool === 'ytdlp' ? 'yt-dlp.exe' : `${tool}.exe`)
      : (defaults.out || (tool === 'ytdlp' ? 'yt-dlp' : tool));

  const outPath = path.join(TARGET_DIR, outName);

  if (fs.existsSync(outPath)) {
    log(`${tool}: already exists at ${outPath}, skipping`);
    return;
  }

  await ensureDir(TARGET_DIR);

  let tmpFile = downloadCache.get(url);

  if (!tmpFile) {
    log(`${tool}: downloading from: ${url}`);

    let tmpFileName;
    if (defaults.type === 'zip') {
      tmpFileName = `${tool}-${Date.now()}.zip`;
    } else if (defaults.type === 'tar') {
      tmpFileName = `${tool}-${Date.now()}.tar.xz`;
    } else {
      tmpFileName = `${tool}-${Date.now()}`;
    }

    tmpFile = path.join(os.tmpdir(), tmpFileName);

    try {
      const progressBar = createProgressBar(tool);
      await downloadFileWithRedirect(url, tmpFile, progressBar);
      downloadCache.set(url, tmpFile);
    } catch (err) {
      logError(`${tool}: download failed: ${err.message}`);

      if (!NO_PATH) {
        const fromPath = await which(outName);
        if (fromPath) {
          log(`${tool}: using system PATH at ${fromPath}`);
          await fsp.copyFile(fromPath, outPath);
          if (PLATFORM !== 'win32') await fsp.chmod(outPath, 0o755);
          log(`${tool}: copied from PATH`);
          return;
        }
      }

      throw err;
    }
  } else {
    log(`${tool}: reusing downloaded archive for ${url} → ${tmpFile}`);
  }

  if (defaults.type === 'direct') {
    await fsp.copyFile(tmpFile, outPath);
  } else if (defaults.type === 'tar' || defaults.type === 'zip') {
    let extractDir = extractCache.get(url);

    if (!extractDir) {
      extractDir = path.join(os.tmpdir(), `extract-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      await ensureDir(extractDir);

      log(`${tool}: extracting archive...`);

      if (defaults.type === 'tar') {
        await extractTarXZ(tmpFile, extractDir);
      } else {
        await extractZip(tmpFile, extractDir);
      }

      extractCache.set(url, extractDir);
    } else {
      log(`${tool}: reusing extracted archive for ${url} → ${extractDir}`);
    }

    const f = await findFileRecursive(extractDir, defaults.find);
    await fsp.copyFile(f, outPath);
  }

  if (PLATFORM !== 'win32') {
    await fsp.chmod(outPath, 0o755);
  }

  log(`${tool}: OK → ${outPath}`);
}

async function main() {
  log(`Platform: ${PLATFORM}  Arch: ${ARCH}`);
  log(`Target bin: ${TARGET_DIR}`);
  if (NO_PATH) log('PATH fallback disabled (--no-path)');

  for (const tool of TOOL_ORDER) {
    try {
      await processTool(tool);
    } catch (err) {
      logError(`${tool} failed: ${err.message}`);
    }
  }

  log('Done.');
}

main().catch((err) => {
  logError('Fatal:', err.message);
  process.exitCode = 1;
});
