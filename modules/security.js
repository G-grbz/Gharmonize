import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const SCRYPT = Object.freeze({ N: 65536, r: 8, p: 1, keylen: 64 });
const ENC_PREFIX = 'enc:v1:';

export function passwordPolicyError(password) {
  const value = String(password || '');
  if (value.length < 8) return 'Password must be at least 8 characters long.';
  if (!/[A-Za-z]/.test(value)) return 'Password must contain at least one letter.';
  if (!/[A-Z]/.test(value)) return 'Password must contain at least one uppercase letter.';
  if (!/[0-9]/.test(value)) return 'Password must contain at least one number.';
  return '';
}

export function hashPassword(password, { enforcePolicy = true } = {}) {
  const error = enforcePolicy ? passwordPolicyError(password) : "";
  if (error) throw new Error(error);
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * 1024 * 1024
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export function verifyPassword(password, encoded) {
  try {
    const [kind, n, r, p, saltB64, hashB64] = String(encoded || '').split('$');
    if (kind !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * 1024 * 1024
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function normalizeKeyBytes(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {}
  return crypto.createHash('sha256').update(value).digest();
}

export function getMasterKey() {
  const direct = normalizeKeyBytes(process.env.GHARMONIZE_MASTER_KEY);
  if (direct) return direct;

  const baseDir = process.env.DATA_DIR || process.cwd();
  const configuredFile = String(process.env.GHARMONIZE_MASTER_KEY_FILE || '').trim();
  const keyFile = configuredFile ? path.resolve(configuredFile) : path.resolve(baseDir, '.gharmonize-key');
  try {
    try {
      const raw = fs.readFileSync(keyFile, 'utf8');
      const key = normalizeKeyBytes(raw);
      if (!key) throw new Error('Invalid Gharmonize master key file');
      try { fs.chmodSync(keyFile, 0o600); } catch {}
      return key;
    } catch (readError) {
      if (readError?.code !== 'ENOENT') throw readError;
    }

    fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
    const key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(keyFile, key.toString('base64'), { mode: 0o600, flag: 'wx' });
      return key;
    } catch (createError) {
      if (createError?.code !== 'EEXIST') throw createError;
      const existing = normalizeKeyBytes(fs.readFileSync(keyFile, 'utf8'));
      if (!existing) throw new Error('Invalid Gharmonize master key file');
      try { fs.chmodSync(keyFile, 0o600); } catch {}
      return existing;
    }
  } catch (error) {
    throw new Error(`Could not load/create Gharmonize master key: ${error.message}`);
  }
}

export function encryptSecret(value, aad = '') {
  const raw = String(value ?? '');
  if (!raw || raw.startsWith(ENC_PREFIX)) return raw;
  const key = getMasterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(String(aad)));
  const ciphertext = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptSecret(value, aad = '') {
  const raw = String(value ?? '');
  if (!raw.startsWith(ENC_PREFIX)) return raw;
  const parts = raw.slice(ENC_PREFIX.length).split('.');
  if (parts.length !== 3) throw new Error('Malformed encrypted setting');
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(ivB64, 'base64url'));
  if (aad) decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function deriveSessionSecret() {
  return crypto.createHmac('sha256', getMasterKey()).update('gharmonize/session/v1').digest();
}

export function parseCookieHeader(header = '') {
  const out = new Map();
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key || key.length > 128 || !/^[A-Za-z0-9_.-]+$/.test(key)) continue;
    try { out.set(key, decodeURIComponent(value)); } catch { out.set(key, value); }
  }
  return out;
}

function ipv4ToBigInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n);
}

function ipv6ToBigInt(ip) {
  let value = ip.toLowerCase();
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  if (value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4) return ipv4ToBigInt(value.slice(7));
  const [leftRaw, rightRaw] = value.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
  if (groups.length !== 8) throw new Error('Invalid IPv6');
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group || '0', 16)), 0n);
}

export function ipInCidr(ip, cidr) {
  let address = String(ip || '').trim();
  if (address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4) address = address.slice(7);
  const [network, prefixRaw] = String(cidr || '').trim().split('/');
  const version = net.isIP(address);
  if (!version || net.isIP(network) !== version) return false;
  const bits = version === 4 ? 32 : 128;
  const prefix = prefixRaw === undefined ? bits : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const addr = version === 4 ? ipv4ToBigInt(address) : ipv6ToBigInt(address);
  const netAddr = version === 4 ? ipv4ToBigInt(network) : ipv6ToBigInt(network);
  const shift = BigInt(bits - prefix);
  return shift === 0n ? addr === netAddr : (addr >> shift) === (netAddr >> shift);
}

export function createTrustedProxyPredicate(raw = process.env.TRUSTED_PROXY_CIDRS) {
  const cidrs = String(raw || '127.0.0.1/32,::1/128').split(',').map((v) => v.trim()).filter(Boolean);
  return (ip) => cidrs.some((cidr) => ipInCidr(ip, cidr));
}

export function isPrivateIp(ip) {
  let value = String(ip || '').trim().toLowerCase();
  if (value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4) value = value.slice(7);
  if (net.isIP(value) === 4) {
    return ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','224.0.0.0/4'].some((cidr) => ipInCidr(value, cidr));
  }
  if (net.isIP(value) === 6) {
    return value === '::' || value === '::1' || ipInCidr(value, 'fc00::/7') || ipInCidr(value, 'fe80::/10') || ipInCidr(value, 'ff00::/8');
  }
  return true;
}

export async function assertSafeRemoteUrl(rawUrl, { allowPrivate = process.env.GHARMONIZE_ALLOW_PRIVATE_URLS === '1' } = {}) {
  let parsed;
  try { parsed = new URL(String(rawUrl || '')); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
  if (parsed.username || parsed.password) throw new Error('Credential-bearing URLs are not allowed');
  if (allowPrivate) return parsed.toString();
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local/private URLs are not allowed');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Local/private URLs are not allowed');
    return parsed.toString();
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some((entry) => isPrivateIp(entry.address))) throw new Error('Local/private URLs are not allowed');
  return parsed.toString();
}

export async function fetchSafeRemote(rawUrl, init = {}, {
  allowPrivate = process.env.GHARMONIZE_ALLOW_PRIVATE_URLS === '1',
  maxRedirects = 3
} = {}) {
  let current = await assertSafeRemoteUrl(rawUrl, { allowPrivate });
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (!redirectStatuses.has(response.status)) return response;
    if (redirects === maxRedirects) throw new Error('Too many redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('Redirect missing Location header');
    current = await assertSafeRemoteUrl(new URL(location, current).toString(), { allowPrivate });
  }
  throw new Error('Remote request failed');
}

export function sanitizeLogValue(value, maxLength = 1000) {
  return String(value ?? '')
    // Removing newlines entirely is both safe for line-oriented logs and a
    // sanitizer pattern understood by CodeQL's log-injection analysis.
    .replace(/\r/g, '')
    .replace(/\n/g, '')
    .replace(/\u2028/g, '')
    .replace(/\u2029/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?')
    .slice(0, Math.max(1, Number(maxLength) || 1000));
}

export function hostMatches(host, domain) {
  const value = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const expected = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  return !!value && !!expected && (value === expected || value.endsWith(`.${expected}`));
}

export function isPathInside(rootDir, candidatePath) {
  const root = path.resolve(String(rootDir || ''));
  const candidate = path.resolve(String(candidatePath || ''));
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolvePathInside(rootDir, relativePath = '') {
  const root = path.resolve(String(rootDir || ''));
  const candidate = path.resolve(root, String(relativePath || ''));
  if (!isPathInside(root, candidate)) throw new Error('Path escapes allowed root');
  return candidate;
}

export function assertPathWithinAny(candidatePath, roots = []) {
  const candidate = path.resolve(String(candidatePath || ''));
  const allowed = roots
    .map((rootDir) => String(rootDir || '').trim())
    .filter(Boolean)
    .map((rootDir) => path.resolve(rootDir));
  if (!allowed.some((rootDir) => isPathInside(rootDir, candidate))) {
    throw new Error('Path is outside allowed roots');
  }
  return candidate;
}

export async function assertAllowedDiscSource(rawPath, { extraRoots = [] } = {}) {
  const raw = String(rawPath || '').trim();
  if (!raw || raw.includes('\0')) throw new Error('Invalid disc source path');

  const configuredRoots = String(process.env.DISC_ALLOWED_ROOTS || '')
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean);

  const defaults = process.platform === 'win32'
    ? []
    : process.platform === 'darwin'
      ? ['/Volumes', '/dev']
      : ['/run/media', '/media', '/mnt', '/dev'];

  const localInput = String(process.env.LOCAL_INPUT_DIR || '').trim();
  const roots = [...configuredRoots, ...defaults, localInput, ...extraRoots].filter(Boolean);

  let candidate = path.resolve(raw);
  try {
    candidate = await fs.promises.realpath(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('Disc source path does not exist');
    throw error;
  }

  if (process.platform === 'win32') {
    const parsed = path.parse(candidate);
    if (parsed.root && isPathInside(parsed.root, candidate)) return candidate;
  }

  return assertPathWithinAny(candidate, roots);
}

const DANGEROUS_YTDLP_FLAGS = [
  /^--exec(?:=|$)/, /^--exec-before-download(?:=|$)/, /^--external-downloader(?:=|$)/,
  /^--external-downloader-args(?:=|$)/, /^--paths?(?:=|$)/, /^--output(?:=|$)/, /^-o$/,
  /^--config-locations?(?:=|$)/, /^--plugin-dirs?(?:=|$)/, /^--cookies(?:=|$)/,
  /^--cookies-from-browser(?:=|$)/, /^--ffmpeg-location(?:=|$)/
];

export function parseSafeYtDlpExtra(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  if (process.env.GHARMONIZE_ALLOW_UNSAFE_YTDLP_ARGS === '1') return parts;
  if (parts.length && !/^-{1,2}[A-Za-z0-9]/.test(parts[0])) {
    throw new Error('yt-dlp extra arguments must start with an option (for example --force-ipv4)');
  }
  for (const arg of parts) {
    if (DANGEROUS_YTDLP_FLAGS.some((re) => re.test(arg))) {
      throw new Error(`Unsafe yt-dlp option is blocked: ${arg}`);
    }
  }
  return parts;
}

export function isSafeExternalUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    return ['https:', 'mailto:'].includes(url.protocol);
  } catch { return false; }
}
