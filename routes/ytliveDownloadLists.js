import express from "express";
import { sendError, sendOk } from "../modules/utils.js";
import {
  addItemsToDownloadList,
  createDownloadList,
  deleteDownloadList,
  getDownloadListsState,
  removeDownloadListItem
} from "../modules/ytliveDownloadLists.js";

const router = express.Router();

router.get("/api/ytlive/download-lists", (_req, res) => {
  return sendOk(res, getDownloadListsState());
});

router.post("/api/ytlive/download-lists", (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return sendError(res, "LIST_NAME_REQUIRED", "List name is required", 400);
    }
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const state = createDownloadList({ name, items });
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] create failed:", error);
    return sendError(res, "LIST_CREATE_FAILED", error.message || "List could not be created", 500);
  }
});

router.post("/api/ytlive/download-lists/:id/items", (req, res) => {
  try {
    const items = Array.isArray(req.body?.items)
      ? req.body.items
      : (req.body?.item ? [req.body.item] : []);
    if (!items.length) {
      return sendError(res, "LIST_ITEMS_REQUIRED", "At least one item is required", 400);
    }
    const state = addItemsToDownloadList(req.params.id, items);
    if (!state) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] add items failed:", error);
    return sendError(res, "LIST_ADD_FAILED", error.message || "Items could not be added", 500);
  }
});

router.delete("/api/ytlive/download-lists/:id", (req, res) => {
  try {
    const state = deleteDownloadList(req.params.id);
    if (!state) {
      return sendError(res, "LIST_NOT_FOUND", "Download list not found", 404);
    }
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] delete failed:", error);
    return sendError(res, "LIST_DELETE_FAILED", error.message || "List could not be deleted", 500);
  }
});

router.delete("/api/ytlive/download-lists/:id/items/:itemKey", (req, res) => {
  try {
    const state = removeDownloadListItem(req.params.id, req.params.itemKey);
    if (!state) {
      return sendError(res, "LIST_ITEM_NOT_FOUND", "Download list item not found", 404);
    }
    return sendOk(res, state);
  } catch (error) {
    console.error("[ytlive-download-lists] remove item failed:", error);
    return sendError(res, "LIST_ITEM_DELETE_FAILED", error.message || "Item could not be removed", 500);
  }
});

export default router;
