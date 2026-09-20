"use client";

/**
 * 收藏 · React 绑定（src/lib/favorites/useFavorites.ts，M Map 改版 S5）
 *
 * ── 模式 ──────────────────────────────────────────────────────────────
 *   与 `src/lib/dev-mode.ts` 同一套：模块级读写 + **自定义事件订阅**（同页即时同步）
 *   + `storage` 事件（跨标签同步）。写操作**一律经本模块**，保证缓存一致。
 *
 * ── F1 SSR 水合守卫（02 §2.6）─────────────────────────────────────────
 *   服务端读不到 `localStorage` ⇒ 首帧恒为「空 + 未挂载」，`useEffect` 挂载后再读。
 *   消费方须用 `mounted` 决定是否渲染**空态**（首帧渲染「加载中」骨架，避免 hydration 失败）。
 *
 * ── F5 gps 端点 ───────────────────────────────────────────────────────
 *   回放时 `kind === "gps"` 的端点**重新定位**（由回放方在本机重新取坐标），
 *   失败则回落收藏坐标并提示 —— 本模块只负责存取，回放逻辑在调用方。
 */
import { useEffect, useState } from "react";
import {
  dedupeKey,
  emptyFile,
  newId,
  readFavorites,
  writeFavorites,
  type ReadResult,
} from "./storage";
import {
  type FavoriteItem,
  type PlaceFavorite,
  type PlanFavorite,
  type FavoriteEndpoint,
} from "./types";

const EVT = "must:favorites";

/** 缓存最近一次读取结果（供同步判断「是否已收藏」） */
let lastRead: ReadResult = { file: emptyFile(), available: false, readOnly: false };
let lastReadAt = 0;

/** 读一次（带 300ms 内缓存；写操作后强制失效） */
function readCached(force = false): ReadResult {
  const now = Date.now();
  if (!force && lastReadAt && now - lastReadAt < 300) return lastRead;
  lastRead = readFavorites();
  lastReadAt = now;
  return lastRead;
}

/** 广播给同页订阅者（+ `storage` 事件自动跨标签） */
function emit() {
  lastReadAt = 0;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVT));
}

/** 订阅收藏变化；返回取消订阅 */
export function subscribeFavorites(cb: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = () => cb();
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith("must.favorites")) {
      lastReadAt = 0;
      cb();
    }
  };
  window.addEventListener(EVT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

// ─────────────────────────── 变更操作（模块级） ───────────────────────────

export type AddResult = { ok: boolean; reason?: "duplicate" | "unavailable" | "error"; message?: string };

/** 新增一条收藏（自动去重 + 上限清理）；不可用（隐私模式）→ `unavailable` */
export function addFavorite(item: FavoriteItem): AddResult {
  const { available, readOnly, file } = readCached(true);
  if (!available || readOnly) return { ok: false, reason: "unavailable" };
  const key = dedupeKey(item);
  if (file.items.some((i) => dedupeKey(i) === key)) return { ok: false, reason: "duplicate" };
  const next = { ...file, items: [...file.items, item] };
  const res = writeFavorites(next);
  if (!res.ok) return { ok: false, reason: "error", message: res.error };
  emit();
  return { ok: true };
}

/** 删除一条（按 id） */
export function removeFavorite(id: string): AddResult {
  const { available, readOnly, file } = readCached(true);
  if (!available || readOnly) return { ok: false, reason: "unavailable" };
  const next = { ...file, items: file.items.filter((i) => i.id !== id) };
  const res = writeFavorites(next);
  if (!res.ok) return { ok: false, reason: "error", message: res.error };
  emit();
  return { ok: true };
}

/** 更新一条（部分字段） */
export function updateFavorite(id: string, patch: Partial<FavoriteItem>): AddResult {
  const { available, readOnly, file } = readCached(true);
  if (!available || readOnly) return { ok: false, reason: "unavailable" };
  let found = false;
  const items = file.items.map((i) => {
    if (i.id !== id) return i;
    found = true;
    return { ...i, ...patch, updatedAt: Date.now() } as FavoriteItem;
  });
  if (!found) return { ok: false, reason: "error", message: "未找到该收藏" };
  const res = writeFavorites({ ...file, items });
  if (!res.ok) return { ok: false, reason: "error", message: res.error };
  emit();
  return { ok: true };
}

/** 置顶 / 取消置顶 */
export function togglePinFavorite(id: string, pinned: boolean): AddResult {
  return updateFavorite(id, { pinned } as Partial<FavoriteItem>);
}

/** 记录「最近使用」（排序 / 清理依据） */
export function touchFavorite(id: string): void {
  updateFavorite(id, { lastUsedAt: Date.now() } as Partial<FavoriteItem>);
}

// ─────────────────────────── 构造器 ───────────────────────────

/** 造一条「地点对」收藏 */
export function makePlaceFavorite(from: FavoriteEndpoint, to: FavoriteEndpoint, query: string, note?: string): PlaceFavorite {
  const now = Date.now();
  const fav: PlaceFavorite = { id: newId(), type: "place", from, to, query, createdAt: now, updatedAt: now };
  if (note) fav.note = note.slice(0, 40);
  return fav;
}

/** 造一条「路线方案」收藏 */
export function makePlanFavorite(
  from: FavoriteEndpoint,
  to: FavoriteEndpoint,
  query: string,
  fingerprint: string,
  snapshot: PlanFavorite["snapshot"],
  note?: string,
): PlanFavorite {
  const now = Date.now();
  const fav: PlanFavorite = {
    id: newId(),
    type: "plan",
    from,
    to,
    query,
    fingerprint,
    snapshot,
    createdAt: now,
    updatedAt: now,
  };
  if (note) fav.note = note.slice(0, 40);
  return fav;
}

// ─────────────────────────── Hook ───────────────────────────

export interface UseFavorites {
  /** 是否已挂载（false = SSR 首帧，消费方应渲染骨架） */
  mounted: boolean;
  /** `localStorage` 是否可用（false = 隐私模式 → 只读降级） */
  available: boolean;
  /** 只读（含 storage 不可用 / schemaVersion 过高） */
  readOnly: boolean;
  items: FavoriteItem[];
  /** 地点对收藏 */
  places: PlaceFavorite[];
  /** 路线方案收藏 */
  plans: PlanFavorite[];
  /** 某 key 是否已收藏（key 由 `dedupeKey()` 生成） */
  has: (key: string) => boolean;
  add: (item: FavoriteItem) => AddResult;
  remove: (id: string) => AddResult;
  update: (id: string, patch: Partial<FavoriteItem>) => AddResult;
  /** 同步读一次最新文件（事件回调用） */
  file: ReadResult["file"];
}

export function useFavorites(): UseFavorites {
  const [state, setState] = useState<ReadResult>(() => ({ file: emptyFile(), available: false, readOnly: false }));
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setState(readCached(true));
    return subscribeFavorites(() => setState(readCached(true)));
  }, []);

  const places = state.file.items.filter((i): i is PlaceFavorite => i.type === "place");
  const plans = state.file.items.filter((i): i is PlanFavorite => i.type === "plan");
  const keys = new Set(state.file.items.map(dedupeKey));

  return {
    mounted,
    available: state.available,
    readOnly: state.readOnly || !state.available,
    items: state.file.items,
    places,
    plans,
    has: (key: string) => keys.has(key),
    add: addFavorite,
    remove: removeFavorite,
    update: updateFavorite,
    file: state.file,
  };
}
