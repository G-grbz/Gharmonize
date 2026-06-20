import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { uniqueId } from "./utils.js";

const BASE_DIR = process.env.DATA_DIR || process.cwd();
const DEFAULT_CACHE_DIR = path.resolve(BASE_DIR, "cache");
const STATE_VERSION = 1;
const MAX_LISTS = 100;
const MAX_ITEMS_PER_LIST = 20000;

function ensureWritableDir(dirPath) {
  const target = String(dirPath || "").trim();
  if (!target) return false;
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveStatePath() {
  const envDir = String(process.env.YTLIVE_DOWNLOAD_LISTS_DIR || process.env.CACHE_DIR || "").trim();
  const dirs = [
    envDir || null,
    DEFAULT_CACHE_DIR,
    path.join(os.tmpdir(), "gharmonize-cache")
  ].filter(Boolean);
  const uniqueDirs = Array.from(new Set(dirs));
  const writableDir = uniqueDirs.find((dirPath) => ensureWritableDir(dirPath)) || DEFAULT_CACHE_DIR;
  try {
    fs.mkdirSync(writableDir, { recursive: true });
  } catch {}
  return path.join(writableDir, "ytlive-download-lists.json");
}

const STATE_FILE = resolveStatePath();

function nowIso() {
  return new Date().toISOString();
}

function safeString(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

function itemKey(seed) {
  return crypto
    .createHash("sha1")
    .update(String(seed || ""))
    .digest("hex")
    .slice(0, 20);
}

function normalizeItem(raw = {}, fallbackIndex = 0) {
  const url = safeString(raw.webpage_url || raw.url, 1500);
  const id = safeString(raw.id, 160);
  const title = safeString(raw.title || id || url || `Track ${fallbackIndex + 1}`, 500);
  const type = safeString(raw.type, 40) || "track";
  const key = itemKey([
    type,
    id,
    url,
    title,
    safeString(raw.uploader || raw.artist, 300)
  ].join("|"));

  return {
    key,
    type,
    index: Number(raw.index || raw.playlist_index || fallbackIndex + 1) || fallbackIndex + 1,
    id: id || null,
    title,
    uploader: safeString(raw.uploader || raw.artist || raw.channel, 300),
    duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : null,
    duration_string: safeString(raw.duration_string, 80) || null,
    thumbnail: safeString(raw.thumbnail || raw.thumbnails?.[0]?.url, 1500) || null,
    webpage_url: url,
    url,
    sourceTitle: safeString(raw.sourceTitle, 500) || null,
    sourceUrl: safeString(raw.sourceUrl, 1500) || null,
    addedAt: raw.addedAt || nowIso()
  };
}

function normalizeList(raw = {}) {
  const id = safeString(raw.id, 120) || uniqueId("ytl");
  const createdAt = raw.createdAt || nowIso();
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((item, index) => normalizeItem(item, index))
    .filter((item) => item.webpage_url || item.id)
    .slice(0, MAX_ITEMS_PER_LIST);

  return {
    id,
    name: safeString(raw.name, 120) || "İndirme Listesi",
    createdAt,
    updatedAt: raw.updatedAt || createdAt,
    items
  };
}

function readState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { version: STATE_VERSION, updatedAt: nowIso(), lists: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const lists = (Array.isArray(parsed?.lists) ? parsed.lists : [])
      .map(normalizeList)
      .slice(0, MAX_LISTS);
    return {
      version: STATE_VERSION,
      updatedAt: parsed?.updatedAt || nowIso(),
      lists
    };
  } catch (error) {
    console.warn("[ytlive-download-lists] Failed to read state:", error?.message || error);
    return { version: STATE_VERSION, updatedAt: nowIso(), lists: [] };
  }
}

function writeState(state) {
  const payload = {
    version: STATE_VERSION,
    updatedAt: nowIso(),
    lists: (Array.isArray(state?.lists) ? state.lists : []).map(normalizeList).slice(0, MAX_LISTS)
  };
  const tmpFile = `${STATE_FILE}.tmp`;
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), "utf8");
  fs.renameSync(tmpFile, STATE_FILE);
  return payload;
}

export function getDownloadListsState() {
  return readState();
}

export function createDownloadList({ name, items = [] } = {}) {
  const state = readState();
  const list = normalizeList({
    id: uniqueId("ytl"),
    name,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    items
  });
  state.lists.unshift(list);
  return writeState(state);
}

export function addItemsToDownloadList(listId, items = []) {
  const state = readState();
  const list = state.lists.find((entry) => entry.id === listId);
  if (!list) return null;

  const byKey = new Map(list.items.map((item) => [item.key, item]));
  const normalized = (Array.isArray(items) ? items : [items])
    .map((item, index) => normalizeItem(item, list.items.length + index))
    .filter((item) => item.webpage_url || item.id);

  for (const item of normalized) {
    byKey.set(item.key, item);
  }

  list.items = Array.from(byKey.values()).slice(0, MAX_ITEMS_PER_LIST);
  list.updatedAt = nowIso();
  return writeState(state);
}

export function deleteDownloadList(listId) {
  const state = readState();
  const before = state.lists.length;
  state.lists = state.lists.filter((list) => list.id !== listId);
  if (state.lists.length === before) return null;
  return writeState(state);
}

export function removeDownloadListItem(listId, itemKeyValue) {
  const state = readState();
  const list = state.lists.find((entry) => entry.id === listId);
  if (!list) return null;
  const before = list.items.length;
  list.items = list.items.filter((item) => item.key !== itemKeyValue);
  if (list.items.length === before) return null;
  list.updatedAt = nowIso();
  return writeState(state);
}
