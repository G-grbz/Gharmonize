import https from 'https';
import crypto from 'crypto';
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

function sanitizeLogValue(value, maxLength = 1000) {
  return String(value ?? '')
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .replace(/\u2028/g, '')
    .replace(/\u2029/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
    .slice(0, Math.max(1, Number(maxLength) || 1000));
}

const TRUSTED_BINARY_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'mkvtoolnix.download'
]);
const MAX_DOWNLOAD_BYTES = Number(process.env.GHARMONIZE_BINARY_MAX_BYTES || 2 * 1024 * 1024 * 1024);

function normalizeSha256(value) {
  const raw = String(value || '').trim().replace(/^sha256:/i, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(raw) ? raw : '';
}

function assertTrustedDownloadUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') throw new Error(`Only HTTPS binary downloads are allowed: ${parsed.protocol}`);
  if (!TRUSTED_BINARY_HOSTS.has(parsed.hostname.toLowerCase()) && process.env.GHARMONIZE_ALLOW_UNVERIFIED_BINARY_URLS !== '1') {
    throw new Error(`Untrusted binary download host: ${parsed.hostname}`);
  }
  return parsed;
}

async function sha256File(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function resolveGithubAssetDigest(downloadUrl) {
  try {
    const parsed = new URL(downloadUrl);
    if (parsed.hostname !== 'github.com') return '';
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
    if (!match) return '';
    const [, owner, repo, tag, assetNameEncoded] = match;
    const assetName = decodeURIComponent(assetNameEncoded);
    const api = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`;
    const res = await fetch(api, {
      headers: {
        'User-Agent': 'Gharmonize-Binary-Downloader',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (!res.ok) throw new Error(`GitHub release API failed (${res.status} ${res.statusText})`);
    const release = await res.json();
    const asset = (Array.isArray(release?.assets) ? release.assets : []).find((item) => String(item?.name || '') === assetName);
    return normalizeSha256(asset?.digest);
  } catch (error) {
    if (process.env.GHARMONIZE_ALLOW_UNVERIFIED_BINARY_URLS === '1') {
      log(`Digest lookup skipped: ${error.message}`);
      return '';
    }
    throw error;
  }
}

// Handles log in project setup tooling.
function log(...a) {
  console.log('[download-binaries]', ...a);
}
// Handles log error in project setup tooling.
function logError(...a) {
  // User-controlled log fields are normalized by sanitizeLogValue before reaching the sink.
  console.error('[download-binaries][ERROR]', ...a.map((value) => sanitizeLogValue(value?.message || value)));
}

// Handles which in project setup tooling.
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

// Handles ensure dir in project setup tooling.
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// Downloads file with redirect for project setup tooling.
function downloadFileWithRedirect(url, dest, onProgress = null, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const visited = [];

    // Handles do request in project setup tooling.
    function doRequest(currentUrl, redirectsLeft) {
      visited.push(currentUrl);

      const urlObj = assertTrustedDownloadUrl(currentUrl);

      const req = https.get(urlObj, (res) => {
        const { statusCode, headers } = res;

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          if (redirectsLeft <= 0) {
            res.resume();
            return reject(
              new Error(`Too many redirects: ${visited.join(' -> ')} -> ${headers.location}`)
            );
          }
          const nextUrl = new URL(headers.location, currentUrl).toString();
          assertTrustedDownloadUrl(nextUrl);
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
        if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
          res.resume();
          return reject(new Error(`Binary download exceeds size limit (${contentLength} bytes)`));
        }
        let downloaded = 0;
        let progressReported = 0;

        const file = fs.createWriteStream(dest);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (downloaded > MAX_DOWNLOAD_BYTES) {
            req.destroy(new Error(`Binary download exceeds size limit (${MAX_DOWNLOAD_BYTES} bytes)`));
            try { file.destroy(); } catch {}
            try { fs.unlinkSync(dest); } catch {}
            return;
          }
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

// Creates progress bar for project setup tooling.
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

// Runs run for project setup tooling.
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

// Extracts tar xz for project setup tooling.
async function extractTarXZ(archivePath, outputDir) {
  await run('tar', ['-xf', archivePath, '-C', outputDir]);
}

// Extracts zip for project setup tooling.
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

// Finds file recursive for project setup tooling.
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
      url: null,
      source: 'btbn-stable',
      type: 'tar',
      find: 'ffmpeg'
    },
    ffprobe: {
      url: null,
      source: 'btbn-stable',
      type: 'tar',
      find: 'ffprobe'
    },
    mkvmerge: {
      url: 'https://mkvtoolnix.download/appimage/MKVToolNix_GUI-100.0-x86_64.AppImage',
      type: 'direct',
      out: 'mkvmerge'
    },
    ytdlp: {
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_linux',
      type: 'direct',
      out: 'yt-dlp'
    },
    deno: {
      url: 'https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-unknown-linux-gnu.zip',
      type: 'zip',
      find: 'deno'
    }
  },

  win32: {
    ffmpeg: {
      url: null,
      source: 'btbn-stable',
      type: 'zip',
      find: 'ffmpeg.exe'
    },
    ffprobe: {
      url: null,
      source: 'btbn-stable',
      type: 'zip',
      find: 'ffprobe.exe'
    },
    mkvmerge: {
      url: 'https://mkvtoolnix.download/windows/releases/100.0/mkvtoolnix-64-bit-100.0.zip',
      type: 'zip',
      find: 'mkvmerge.exe'
    },
    ytdlp: {
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp.exe',
      type: 'direct',
      out: 'yt-dlp.exe'
    },
    deno: {
      url: 'https://github.com/denoland/deno/releases/download/v2.9.5/deno-x86_64-pc-windows-msvc.zip',
      type: 'zip',
      find: 'deno.exe'
    }
  }
};

const TOOL_ORDER = ['ffmpeg', 'ffprobe', 'mkvmerge', 'ytdlp', 'deno'];


const BTBN_STABLE_TARGETS = {
  linux: {
    x64: { token: 'linux64', extension: '.tar.xz' },
    arm64: { token: 'linuxarm64', extension: '.tar.xz' }
  },
  win32: {
    x64: { token: 'win64', extension: '.zip' },
    arm64: { token: 'winarm64', extension: '.zip' }
  }
};

let btbnStableUrlPromise = null;

function compareNumericVersionsDesc(a, b) {
  const aa = String(a || '').split('.').map((n) => Number(n) || 0);
  const bb = String(b || '').split('.').map((n) => Number(n) || 0);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (bb[i] || 0) - (aa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function resolveBtbnStableArchiveUrl() {
  if (btbnStableUrlPromise) return btbnStableUrlPromise;

  btbnStableUrlPromise = (async () => {
    const target = BTBN_STABLE_TARGETS?.[PLATFORM]?.[ARCH];
    if (!target) {
      throw new Error(`No BtbN stable FFmpeg target for ${PLATFORM}/${ARCH}`);
    }

    const res = await fetch('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest', {
      headers: {
        'User-Agent': 'Gharmonize-Binary-Downloader',
        'Accept': 'application/vnd.github+json'
      }
    });
    if (!res.ok) {
      throw new Error(`BtbN GitHub API failed (${res.status} ${res.statusText})`);
    }

    const release = await res.json();
    const escapedToken = target.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedExt = target.extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `^ffmpeg-n(\\d+(?:\\.\\d+)+)-latest-${escapedToken}-gpl(?:-[0-9.]+)?${escapedExt}$`,
      'i'
    );

    const candidates = (Array.isArray(release?.assets) ? release.assets : [])
      .map((asset) => {
        const name = String(asset?.name || '');
        if (/shared/i.test(name)) return null;
        const match = name.match(re);
        if (!match || !asset?.browser_download_url) return null;
        return { version: match[1], url: asset.browser_download_url, name, digest: normalizeSha256(asset?.digest) };
      })
      .filter(Boolean)
      .sort((a, b) => compareNumericVersionsDesc(a.version, b.version));

    if (!candidates.length) {
      throw new Error('BtbN stable/release-branch FFmpeg asset was not found');
    }

    log(`BtbN stable FFmpeg selected: ${candidates[0].name}`);
    return candidates[0];
  })();

  return btbnStableUrlPromise;
}
const downloadCache = new Map();
const extractCache = new Map();

// Processes tool in project setup tooling.
async function processTool(tool) {
  const defaults = DEFAULTS[PLATFORM]?.[tool];
  if (!defaults) {
    logError(`${tool}: no defaults for platform ${PLATFORM}`);
    return;
  }

  const envVarName = `GHARMONIZE_${tool.toUpperCase()}_URL`;
  const envDigestName = `GHARMONIZE_${tool.toUpperCase()}_SHA256`;
  const envUrl = process.env[envVarName];
  const btbnAsset = !envUrl && !defaults.url && defaults.source === 'btbn-stable'
    ? await resolveBtbnStableArchiveUrl()
    : null;
  const url = envUrl || defaults.url || btbnAsset?.url || null;

  if (!url) {
    throw new Error(`${tool}: no download URL could be resolved`);
  }
  assertTrustedDownloadUrl(url);
  let expectedDigest = normalizeSha256(process.env[envDigestName]) || normalizeSha256(btbnAsset?.digest);
  if (!expectedDigest && new URL(url).hostname === 'github.com') {
    expectedDigest = await resolveGithubAssetDigest(url);
    if (!expectedDigest && process.env.GHARMONIZE_ALLOW_UNVERIFIED_BINARY_URLS !== '1') {
      throw new Error(`${tool}: GitHub release asset has no SHA-256 digest; refusing unverified download`);
    }
  }

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
      if (expectedDigest) {
        const actualDigest = await sha256File(tmpFile);
        if (actualDigest !== expectedDigest) {
          try { await fsp.unlink(tmpFile); } catch {}
          throw new Error(`${tool}: SHA-256 mismatch (expected ${expectedDigest}, got ${actualDigest})`);
        }
        log(`${tool}: SHA-256 verified`);
      } else {
        log(`${tool}: warning: no SHA-256 digest is available for this trusted vendor download`);
      }
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

// Runs the script entrypoint and orchestrates the full workflow.
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
