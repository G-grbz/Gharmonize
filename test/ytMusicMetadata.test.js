import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeYtMusicAlbumEntry,
  normalizeYtMusicByline
} from "../modules/ytMusicMetadata.js";

test("YouTube Music bylines keep only the creator", () => {
  assert.equal(
    normalizeYtMusicByline("Video • Yiğit Mahzuni ve Aysel Yakupoglu • 50 Mn görüntüleme • 3:05"),
    "Yiğit Mahzuni ve Aysel Yakupoglu"
  );
  assert.equal(
    normalizeYtMusicByline("Şarkı • Erkan Acar • 4:55"),
    "Erkan Acar"
  );
  assert.equal(
    normalizeYtMusicByline("Şarkı • Özcan Deniz, Haluk Bilginer, Cem Özer ve Ruhi Sarı - 6,7 Mn kez dinlendi"),
    "Özcan Deniz, Haluk Bilginer, Cem Özer ve Ruhi Sarı"
  );
});

test("plain artist names are preserved", () => {
  assert.equal(normalizeYtMusicByline("Derya Bedavacı"), "Derya Bedavacı");
  assert.equal(normalizeYtMusicByline("AC/DC • Live"), "AC/DC • Live");
});

test("frozen YouTube entries cannot carry display metadata into artist fields", () => {
  const entry = normalizeYtMusicAlbumEntry({
    title: "Kaybolurdun Gözlerimde",
    uploader: "Video • Yiğit Mahzuni ve Aysel Yakupoglu • 50 Mn görüntüleme • 3:05",
    artist: "Video • Yiğit Mahzuni ve Aysel Yakupoglu • 50 Mn görüntüleme • 3:05"
  });

  assert.equal(entry.uploader, "Yiğit Mahzuni ve Aysel Yakupoglu");
  assert.equal(entry.artist, "Yiğit Mahzuni ve Aysel Yakupoglu");
  assert.equal(entry.title, "Kaybolurdun Gözlerimde");
});

test("previously saved YT Live download lists are cleaned when read", async (t) => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "gharmonize-ytlive-byline-"));
  t.after(() => fs.rmSync(cacheDir, { recursive: true, force: true }));
  const previousDir = process.env.YTLIVE_DOWNLOAD_LISTS_DIR;
  process.env.YTLIVE_DOWNLOAD_LISTS_DIR = cacheDir;
  t.after(() => {
    if (previousDir === undefined) delete process.env.YTLIVE_DOWNLOAD_LISTS_DIR;
    else process.env.YTLIVE_DOWNLOAD_LISTS_DIR = previousDir;
  });

  fs.writeFileSync(path.join(cacheDir, "ytlive-download-lists.json"), JSON.stringify({
    version: 1,
    lists: [{
      id: "ytl_existing",
      name: "Kirlenmiş Gömleğim",
      items: [{
        id: "video123",
        title: "Kaybolurdun Gözlerimde",
        uploader: "Video • Yiğit Mahzuni ve Aysel Yakupoglu • 50 Mn görüntüleme • 3:05",
        webpage_url: "https://music.youtube.com/watch?v=video123"
      }]
    }]
  }));

  const { getDownloadListsState } = await import(`../modules/ytliveDownloadLists.js?test=${Date.now()}`);
  const state = getDownloadListsState();
  assert.equal(state.lists[0].items[0].uploader, "Yiğit Mahzuni ve Aysel Yakupoglu");
});
