"use client";

/**
 * 收藏 v3 · React 绑定与变更操作（src/lib/favorites/useCombos.ts，v3.3.0 · ADR-104）
 *
 * ── 与旧版（v2「组合 → 方案」两级）的关系 ─────────────────────────────────
 *   本文件**已整体切到 v3**：只保留**两实体**（`ComboV3` 起终点对 / `PlaceV3` 单地点）；
 *   方案层（`addPlanToCombo` / `setRouteWalkOverride` / 种子注入 / 流程图）**已随 ADR-104 退役删除**。
 *   唯一写入口仍是本模块 ⇒ 所有变更都经 `mutateV3`（读 → 改 → 写 → 广播），保证缓存一致。
 *
 * ── 迁移 ────────────────────────────────────────────────────────────────
 *   首次读（无 v3）由 `v3.readV3()` 完成「导出 JSON + 隐藏键双层备份 → 删预设 → 写 v3」；
 *   失败 ⇒ 只读 + `migrationFailed`（UI 提示，旧数据完好、可回滚）。
 *
 * ── F1 SSR 水合守卫 ────────────────────────────────────────────────────
 *   服务端读不到 `localStorage` ⇒ 首帧恒为「空 + 未挂载」；消费方用 `mounted` 决定是否渲染骨架。
 */
import { useEffect, useState } from "react";
import type { AddResult } from "./useFavorites";
import type { FavoriteEndpoint } from "./types";
import {
  comboV3Key,
  emptyV3,
  makeComboV3,
  makePlaceV3,
  placeV3Key,
  readV3,
  writeV3,
  type ComboV3,
  type FavoritesFileV3,
  type PlaceV3,
  type ReadV3Result,
} from "./v3";

export { makeComboV3, makePlaceV3, comboV3Key, placeV3Key };
export type { ComboV3, PlaceV3, FavoritesFileV3 };

const EVT = "must:favorites.v3";

/** 缓存最近一次读取结果（同步判断「是否已收藏」用） */
let lastRead: ReadV3Result = { file: emptyV3(), available: false, readOnly: false };
let lastReadAt = 0;

function readCached(force = false): ReadV3Result {
  const now = Date.now();
  if (!force && lastReadAt && now - lastReadAt < 300) return lastRead;
  lastRead = readV3();
  lastReadAt = now;
  return lastRead;
}

function emit() {
  lastReadAt = 0;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVT));
}

/** 订阅收藏变化（同页 + 跨标签）；返回取消订阅 */
export function subscribeCombos(cb: () => void): () => void {
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

// ─────────────────────────── 变更（模块级） ───────────────────────────

/** 写一次（统一收口：读 → 改 → 写 → 广播） */
function mutateV3(
  fn: (
    file: FavoritesFileV3,
  ) => { ok: false; reason: AddResult["reason"]; message?: string } | { ok: true; next: FavoritesFileV3 },
): AddResult {
  const { available, readOnly, file } = readCached(true);
  if (!available || readOnly) return { ok: false, reason: "unavailable" };
  const r = fn(file);
  if (!r.ok) return { ok: false, reason: r.reason, message: r.message };
  const res = writeV3(r.next);
  if (!res.ok) return { ok: false, reason: "error", message: res.error };
  emit();
  return { ok: true };
}

/* ── 组合 ── */

export function addCombo(c: ComboV3): AddResult {
  return mutateV3((file) => {
    if (file.combos.some((x) => comboV3Key(x) === comboV3Key(c))) return { ok: false, reason: "duplicate" };
    return { ok: true, next: { ...file, combos: [c, ...file.combos] } };
  });
}

export function removeCombo(id: string): AddResult {
  return mutateV3((file) => ({ ok: true, next: { ...file, combos: file.combos.filter((c) => c.id !== id) } }));
}

export function updateCombo(id: string, patch: Partial<ComboV3>): AddResult {
  return mutateV3((file) => {
    let found = false;
    const combos = file.combos.map((c) => {
      if (c.id !== id) return c;
      found = true;
      return { ...c, ...patch, updatedAt: Date.now() };
    });
    if (!found) return { ok: false, reason: "error", message: "未找到该组合" };
    return { ok: true, next: { ...file, combos } };
  });
}

export function togglePinCombo(id: string, pinned: boolean): AddResult {
  return updateCombo(id, { pinned });
}

/** 记录「最近使用」 */
export function touchCombo(id: string): void {
  void updateCombo(id, { lastUsedAt: Date.now() });
}

/* ── 地点 ── */

export function addPlace(p: PlaceV3): AddResult {
  return mutateV3((file) => {
    if (file.places.some((x) => placeV3Key(x) === placeV3Key(p))) return { ok: false, reason: "duplicate" };
    return { ok: true, next: { ...file, places: [p, ...file.places] } };
  });
}

export function removePlace(id: string): AddResult {
  return mutateV3((file) => ({ ok: true, next: { ...file, places: file.places.filter((p) => p.id !== id) } }));
}

export function updatePlace(id: string, patch: Partial<PlaceV3>): AddResult {
  return mutateV3((file) => {
    let found = false;
    const places = file.places.map((p) => {
      if (p.id !== id) return p;
      found = true;
      return { ...p, ...patch, updatedAt: Date.now() };
    });
    if (!found) return { ok: false, reason: "error", message: "未找到该地点" };
    return { ok: true, next: { ...file, places } };
  });
}

export function togglePinPlace(id: string, pinned: boolean): AddResult {
  return updatePlace(id, { pinned });
}

export function touchPlace(id: string): void {
  void updatePlace(id, { lastUsedAt: Date.now() });
}

/** 该端点是否已收藏为地点（「收藏地点」入口双态判定） */
export function isPlaceSaved(ep: FavoriteEndpoint): boolean {
  const { file, available } = readCached();
  if (!available) return false;
  return file.places.some((p) => placeV3Key(p) === placeV3Key({ endpoint: ep }));
}

/** 该起终点对是否已收藏为组合 */
export function isComboSaved(from: FavoriteEndpoint, to: FavoriteEndpoint): boolean {
  const { file, available } = readCached();
  if (!available) return false;
  const k = comboV3Key({ from, to });
  return file.combos.some((c) => comboV3Key(c) === k);
}

// ─────────────────────────── Hook ───────────────────────────

export interface UseCombos {
  mounted: boolean;
  available: boolean;
  readOnly: boolean;
  /** 迁移被中止（旧数据完好；UI 提示「稍后再试」） */
  migrationFailed: boolean;
  /** 收藏组合（起终点对） */
  combos: ComboV3[];
  /** 收藏地点（单点） */
  places: PlaceV3[];
  hasCombo: (from: FavoriteEndpoint, to: FavoriteEndpoint) => boolean;
  hasPlace: (ep: FavoriteEndpoint) => boolean;
  addCombo: (c: ComboV3) => AddResult;
  removeCombo: (id: string) => AddResult;
  updateCombo: (id: string, patch: Partial<ComboV3>) => AddResult;
  addPlace: (p: PlaceV3) => AddResult;
  removePlace: (id: string) => AddResult;
  updatePlace: (id: string, patch: Partial<PlaceV3>) => AddResult;
  file: FavoritesFileV3;
}

export function useCombos(): UseCombos {
  const [state, setState] = useState<ReadV3Result>(() => ({
    file: emptyV3(),
    available: false,
    readOnly: false,
  }));
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setState(readCached(true));
    return subscribeCombos(() => setState(readCached(true)));
  }, []);

  const combos = state.file.combos;
  const places = state.file.places;

  return {
    mounted,
    available: state.available,
    readOnly: state.readOnly || !state.available,
    migrationFailed: !!state.migrationFailed,
    combos,
    places,
    hasCombo: (from, to) => {
      const k = comboV3Key({ from, to });
      return combos.some((c) => comboV3Key(c) === k);
    },
    hasPlace: (ep) => places.some((p) => placeV3Key(p) === placeV3Key({ endpoint: ep })),
    addCombo,
    removeCombo,
    updateCombo,
    addPlace,
    removePlace,
    updatePlace,
    file: state.file,
  };
}
