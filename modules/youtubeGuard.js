import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveRuntimeCacheDir } from "./runtimeEnvironment.js";

// One guard per server for everything Gharmonize asks YouTube (yt-dlp runs and
// YouTube Music API calls). YouTube judges an IP address, not a job, so the
// hourly budget, the pause after a bot check and the parallel limit are shared
// by every job, the Player and YTLive.

// "Are you a bot?" answers. A plain 403 is not one: expired media links also
// give 403, and those are fixed by a normal retry.
export const YOUTUBE_BLOCK_RE = /sign in to confirm you(?:'|’|&#39;)?re not a bot|automated queries|unusual traffic|rate-limited by youtube|http error 429|too many requests/i;

// Videos that only open with an account. Only these may be retried with the
// configured account cookies; everything else stays anonymous.
export const YOUTUBE_ACCOUNT_RE = /sign in to confirm your age|age[- ]restricted|inappropriate for some users|members[- ]only|join this channel to get access|sign in if you(?:'|’)?ve been granted access|requires payment|music premium members/i;

export function isYouTubeBlockMessage(text = "") {
  return YOUTUBE_BLOCK_RE.test(String(text || ""));
}

export function needsYouTubeAccount(text = "") {
  const value = String(text || "");
  return !isYouTubeBlockMessage(value) && YOUTUBE_ACCOUNT_RE.test(value);
}

// Request weights in "video" units: a download or full info extraction asks the
// player API, a search or flat list page is a single lighter call.
export const YOUTUBE_REQUEST_WEIGHT = Object.freeze({ download: 1, info: 1, list: 0.34, search: 0.34 });

const HOUR_MS = 60 * 60 * 1000;

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class YouTubeBlockedError extends Error {
  constructor(status) {
    const minutes = Math.max(1, Math.ceil((status.retryAfterMs || 0) / 60000));
    super(`YouTube asked to confirm this is not a bot; YouTube requests are paused for about ${minutes} min to protect your IP and account.`);
    this.name = "YouTubeBlockedError";
    this.code = "YOUTUBE_PAUSED";
    this.status = 429;
    this.retryAfterMs = status.retryAfterMs || 0;
  }
}

export function createYouTubeGuard({
  file = null,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); }),
  random = Math.random,
  hourlyBudget = 250,
  freeShare = 0.5,
  pauseMs = 30 * 60 * 1000,
  maxPauseMs = 4 * HOUR_MS,
  slots = { download: 2, lookup: 2 },
  enabled = () => true,
  logger = console
} = {}) {
  // Off: no waiting, no budget and no automatic pause (the behaviour before
  // the guard existed). Only the parallel download limit stays.
  const on = () => { try { return enabled() !== false; } catch { return true; } };
  // A function lets Settings change the budget without a restart.
  const budgetNow = () => positive(typeof hourlyBudget === "function" ? hourlyBudget() : hourlyBudget, 250);
  const share = Math.min(0.95, Math.max(0, Number(freeShare) || 0));
  let usage = [];          // [startedAt, weight], last hour only
  let pause = null;        // { until, reason, strikes, at }
  let nextStart = 0;
  let loaded = !file;
  let writeTimer = null;
  const pools = new Map();

  const load = () => {
    if (loaded) return;
    loaded = true;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved?.usage)) {
        usage = saved.usage
          .filter((row) => Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1]))
          .slice(-5000);
      }
      if (saved?.pause && Number.isFinite(saved.pause.until)) pause = saved.pause;
    } catch { /* No saved state yet, or a disposable corrupt file. */ }
  };

  const write = () => {
    clearTimeout(writeTimer);
    writeTimer = null;
    if (!file) return;
    let temporary = "";
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      temporary = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, usage, pause }), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, file);
      temporary = "";
    } catch { /* A read-only data folder keeps the guard in memory only. */ }
    finally { if (temporary) { try { fs.unlinkSync(temporary); } catch {} } }
  };

  const changed = () => {
    if (!file || writeTimer) return;
    writeTimer = setTimeout(write, 2000);
    writeTimer.unref?.();
  };

  const prune = () => {
    const from = now() - HOUR_MS;
    if (usage.length && usage[0][0] <= from) usage = usage.filter((row) => row[0] > from);
  };

  const used = () => {
    prune();
    return usage.reduce((sum, row) => sum + row[1], 0);
  };

  const pausedForMs = () => {
    if (!on()) return 0;
    load();
    return pause ? Math.max(0, pause.until - now()) : 0;
  };

  // Below the free share of the hourly budget requests start at once. Past it
  // the gap between requests grows with use, so a long batch slows down
  // smoothly and settles well under YouTube's limit instead of hitting it.
  const gapMs = (weight) => {
    const budget = budgetNow();
    const free = budget * share;
    const u = used();
    if (u + weight <= free) return 0;
    const ratio = Math.min(1, (u + weight - free) / Math.max(1, budget - free));
    let gap = ratio * 2 * (HOUR_MS / budget) * weight;
    if (u + weight > budget) {
      // Hard cap: wait until enough of the last hour has expired.
      let excess = u + weight - budget;
      for (const [at, w] of usage) {
        excess -= w;
        if (excess <= 0) { gap = Math.max(gap, at + HOUR_MS - now()); break; }
      }
    }
    return gap > 0 ? Math.round(gap * (0.85 + random() * 0.3)) : 0;
  };

  const status = () => {
    const retryAfterMs = pausedForMs();
    return {
      enabled: on(),
      paused: retryAfterMs > 0,
      retryAfterMs,
      until: retryAfterMs ? pause.until : null,
      reason: retryAfterMs ? pause.reason : "",
      usedLastHour: Math.round(used() * 10) / 10,
      hourlyBudget: budgetNow()
    };
  };

  const waitFor = async (ms, isCanceled) => {
    const end = now() + ms;
    while (now() < end) {
      if (isCanceled?.()) throw new Error("CANCELED");
      await sleep(Math.min(1000, Math.max(1, end - now())));
    }
  };

  // Waits for a pause to end and for this request's turn under the budget.
  // wait:false (interactive previews, searches typed by a person) fails fast
  // during a pause instead of hanging the page.
  const before = async (kind = "info", { wait = true, isCanceled = null, onWait = null } = {}) => {
    if (!on()) return;
    load();
    const weight = YOUTUBE_REQUEST_WEIGHT[kind] ?? 1;
    let notified = false;
    for (;;) {
      if (isCanceled?.()) throw new Error("CANCELED");
      const pausedMs = pausedForMs();
      if (pausedMs > 0) {
        if (!wait) throw new YouTubeBlockedError(status());
        if (!notified) { notified = true; try { onWait?.(status()); } catch {} }
        await waitFor(Math.min(pausedMs, 15000), isCanceled);
        continue;
      }
      const start = Math.max(now(), nextStart + gapMs(weight));
      if (start - now() > 1000 && !wait) {
        // A person is waiting: skip the slow-down but keep the hard cap.
        if (used() + weight <= budgetNow()) break;
        throw new YouTubeBlockedError({ retryAfterMs: start - now() });
      }
      nextStart = start;
      if (start > now()) {
        if (!notified && start - now() > 3000) { notified = true; try { onWait?.(status()); } catch {} }
        await waitFor(start - now(), isCanceled);
        if (pausedForMs() > 0) continue;
      }
      break;
    }
    usage.push([now(), weight]);
    nextStart = Math.max(nextStart, now());
    changed();
  };

  // Records what YouTube answered; a bot check pauses every YouTube request.
  const observe = (text = "") => {
    if (!on() || !isYouTubeBlockMessage(text)) return false;
    load();
    const at = now();
    const recent = pause && at - (pause.at || 0) < 6 * HOUR_MS;
    if (pause && pause.until > at) return true; // already paused; parallel runs report the same block
    const strikes = recent ? (pause.strikes || 1) + 1 : 1;
    const duration = Math.min(maxPauseMs, pauseMs * 2 ** (strikes - 1));
    const line = String(text).split(/\r?\n/).find((l) => YOUTUBE_BLOCK_RE.test(l)) || "";
    pause = { until: at + duration, reason: line.replace(/\s+/g, " ").trim().slice(0, 200), strikes, at };
    try { logger?.warn?.(`[youtube] YouTube asked for a bot check; pausing YouTube requests for ${Math.round(duration / 60000)} min`); } catch {}
    changed();
    write();
    return true;
  };

  const pool = (name) => {
    if (!pools.has(name)) pools.set(name, { size: Math.max(1, Number(slots?.[name]) || 2), active: 0, queue: [] });
    return pools.get(name);
  };

  // At most `slots[name]` YouTube runs of that kind at the same time, server wide.
  const withSlot = async (name, fn, { isCanceled = null } = {}) => {
    const p = pool(name);
    if (p.active >= p.size) {
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, isCanceled };
        p.queue.push(entry);
      });
    } else {
      p.active += 1;
    }
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next live waiter.
      let next;
      while ((next = p.queue.shift())) {
        if (next.isCanceled?.()) { next.reject(new Error("CANCELED")); continue; }
        break;
      }
      if (next) next.resolve();
      else p.active -= 1;
    }
  };

  return {
    before,
    observe,
    withSlot,
    status,
    pausedForMs,
    clearPause() { load(); pause = null; changed(); },
    flush: write,
    _usage: () => usage.slice()
  };
}

// 0 or empty = off (default). Otherwise videos per hour, 30–2000.
export function youtubeHourlyBudget(value = process.env.YOUTUBE_HOURLY_BUDGET) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(2000, Math.max(30, n));
}

// The server-wide guard. YOUTUBE_HOURLY_BUDGET (Settings → YouTube) switches
// the budget and the automatic pause on; it is off by default. YouTube allows
// roughly 300 videos per hour without an account, so 250 is a good value.
export const youtubeGuard = createYouTubeGuard({
  file: process.env.YOUTUBE_GUARD_PERSIST === "0" ? null : path.join(resolveRuntimeCacheDir(), "youtube-guard.json"),
  enabled: () => youtubeHourlyBudget() > 0,
  hourlyBudget: () => youtubeHourlyBudget() || 250
});
