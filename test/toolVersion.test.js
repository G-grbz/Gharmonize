import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeYtDlpVersion,
  isSameYtDlpRelease,
  normalizeDenoVersion,
  isSameDenoRelease
} from "../modules/toolVersion.js";

test("normalizes yt-dlp stable versions and release tags", () => {
  assert.equal(normalizeYtDlpVersion("2026.08.19"), "2026.08.19");
  assert.equal(normalizeYtDlpVersion("v2026.08.19"), "2026.08.19");
  assert.equal(normalizeYtDlpVersion("yt-dlp 2026.08.19"), "2026.08.19");
});

test("matches only the installed yt-dlp release actually present", () => {
  assert.equal(isSameYtDlpRelease("2026.08.19", "2026.08.19"), true);
  assert.equal(isSameYtDlpRelease("2026.06.09", "2026.08.19"), false);
  assert.equal(isSameYtDlpRelease("", "2026.08.19"), false);
});


test("normalizes Deno versions and release tags", () => {
  assert.equal(normalizeDenoVersion("deno 2.9.5 (stable, release, x86_64-unknown-linux-gnu)"), "2.9.5");
  assert.equal(normalizeDenoVersion("v2.9.5"), "2.9.5");
  assert.equal(normalizeDenoVersion("2.9.0"), "2.9.0");
});

test("matches only the installed Deno release actually present", () => {
  assert.equal(isSameDenoRelease("deno 2.9.5 (stable, release)", "v2.9.5"), true);
  assert.equal(isSameDenoRelease("deno 2.9.0 (stable, release)", "v2.9.5"), false);
  assert.equal(isSameDenoRelease("", "v2.9.5"), false);
});
