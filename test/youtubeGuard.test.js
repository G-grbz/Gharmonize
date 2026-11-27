import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createYouTubeGuard, isYouTubeBlockMessage, needsYouTubeAccount } from "../modules/youtubeGuard.js";

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; }
  };
}

test("bot checks and account-only videos are told apart", () => {
  assert.equal(isYouTubeBlockMessage("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"), true);
  assert.equal(isYouTubeBlockMessage("HTTP Error 429: Too Many Requests"), true);
  assert.equal(isYouTubeBlockMessage("our systems have detected unusual traffic ... automated queries"), true);
  assert.equal(isYouTubeBlockMessage("ERROR: unable to download video data: HTTP Error 403: Forbidden"), false);

  assert.equal(needsYouTubeAccount("Sign in to confirm your age. This video may be inappropriate for some users."), true);
  assert.equal(needsYouTubeAccount("Join this channel to get access to members-only content"), true);
  assert.equal(needsYouTubeAccount("Sign in to confirm you're not a bot"), false);
  assert.equal(needsYouTubeAccount("Video unavailable"), false);
});

test("requests start at once below half of the hourly budget, then slow down", async () => {
  const c = clock();
  const guard = createYouTubeGuard({ ...c, random: () => 0.5, hourlyBudget: 100, logger: null });
  for (let i = 0; i < 50; i++) {
    const before = c.now();
    await guard.before("download");
    assert.equal(c.now(), before, `request ${i + 1} waited`);
  }
  const before = c.now();
  await guard.before("download");
  assert.ok(c.now() > before, "requests past the free share are spaced out");
  assert.ok(c.now() - before < 60_000);
});

test("the hourly budget is a hard cap", async () => {
  const c = clock();
  const guard = createYouTubeGuard({ ...c, random: () => 0.5, hourlyBudget: 40, freeShare: 0.9, logger: null });
  for (let i = 0; i < 36; i++) await guard.before("download");
  for (let i = 0; i < 20; i++) await guard.before("download");
  // 56 downloads cannot fit in one hour with a budget of 40.
  assert.ok(c.now() - 1_000_000 >= 60 * 60 * 1000 * 0.25);
  const lastHour = guard._usage().filter(([at]) => at > c.now() - 3600_000).reduce((s, [, w]) => s + w, 0);
  assert.ok(lastHour <= 40, `used ${lastHour} in the last hour`);
});

test("searches weigh less than downloads", async () => {
  const c = clock();
  const guard = createYouTubeGuard({ ...c, hourlyBudget: 100, logger: null });
  for (let i = 0; i < 3; i++) await guard.before("search");
  assert.ok(guard.status().usedLastHour < 1.1);
});

test("a bot check pauses all requests; repeated checks pause longer", async () => {
  const c = clock();
  const guard = createYouTubeGuard({ ...c, pauseMs: 30 * 60_000, logger: null });
  assert.equal(guard.observe("Video unavailable"), false);
  assert.equal(guard.observe("Sign in to confirm you’re not a bot"), true);
  assert.equal(guard.status().paused, true);
  assert.equal(guard.status().retryAfterMs, 30 * 60_000);

  await assert.rejects(() => guard.before("info", { wait: false }), (e) => e.code === "YOUTUBE_PAUSED");

  let waited = null;
  const start = c.now();
  await guard.before("download", { onWait: (s) => { waited = s; } });
  assert.ok(waited?.paused, "the waiting caller is told about the pause");
  assert.ok(c.now() - start >= 30 * 60_000);

  // A second check soon after doubles the pause.
  guard.observe("HTTP Error 429: Too Many Requests");
  assert.equal(guard.status().retryAfterMs, 60 * 60_000);
});

test("a canceled job stops waiting", async () => {
  const c = clock();
  const guard = createYouTubeGuard({ ...c, logger: null });
  guard.observe("Sign in to confirm you're not a bot");
  let calls = 0;
  await assert.rejects(
    () => guard.before("download", { isCanceled: () => ++calls > 3 }),
    /CANCELED/
  );
});

test("pause and usage survive a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yt-guard-"));
  const file = path.join(dir, "youtube-guard.json");
  try {
    const c = clock();
    const first = createYouTubeGuard({ ...c, file, logger: null });
    await first.before("download");
    first.observe("Sign in to confirm you're not a bot");
    first.flush();
    const second = createYouTubeGuard({ ...c, file, logger: null });
    assert.equal(second.status().paused, true);
    assert.equal(second.status().usedLastHour, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("at most two downloads run at the same time", async () => {
  const guard = createYouTubeGuard({ logger: null, slots: { download: 2 } });
  let active = 0, peak = 0;
  const releases = [];
  const runs = Array.from({ length: 5 }, () => guard.withSlot("download", async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => releases.push(resolve));
    active -= 1;
  }));
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
    releases.shift()?.();
  }
  await Promise.all(runs);
  assert.equal(peak, 2);
});

test("switched off, the guard never waits, counts or pauses", async () => {
  const c = clock();
  let on = false;
  const guard = createYouTubeGuard({ ...c, hourlyBudget: 30, logger: null, enabled: () => on });
  for (let i = 0; i < 100; i++) await guard.before("download", { wait: false });
  assert.equal(c.now(), 1_000_000);
  assert.equal(guard.observe("Sign in to confirm you're not a bot"), false);
  assert.equal(guard.status().paused, false);
  assert.equal(guard.status().enabled, false);
  on = true;
  assert.equal(guard.observe("Sign in to confirm you're not a bot"), true);
  assert.equal(guard.status().paused, true);
  on = false;
  assert.equal(guard.pausedForMs(), 0, "a saved pause is ignored while off");
});
