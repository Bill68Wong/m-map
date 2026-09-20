"use client";

/**
 * 组合 · React 绑定与变更操作（src/lib/favorites/useCombos.ts，v2.3.0 · 07 §1.5）
 *
 * ── 与 `useFavorites`（v1）的关系 ──────────────────────────────────────
 *   同一套模式（模块级读写 + 自定义事件同页同步 + `storage` 事件跨标签同步）；
 *   v2 的 **唯一写入口** —— 所有组合/方案变更都必须经本模块，保证缓存一致。
 *   v1（`useFavorites`）在迁移期仍存在（旧组件未改完），S5 收口后只保留本模块。
 *
 * ── F1 SSR 水合守卫 ────────────────────────────────────────────────────
 *   服务端读不到 `localStorage` ⇒ 首帧恒为「空 + 未挂载」；消费方用 `mounted`
 *   决定是否渲染空态（首帧渲染骨架，避免 hydration 失败）。
 *
 * ── 种子注入（07 §1.4）─────────────────────────────────────────────────
 *   `seedDefaultCombos(coords, zone)` 由 `/favorites` 的 `ComboSeeder` 调一次：
 *   仅当 `seedVersion < SEED_VERSION` 时**补「同名不存在」的默认组合**，然后置位；
 *   用户删掉的默认组合**不再复活**。
 */
import { useEffect, useState } from "react";
import {
  emptyFileV2,
  readCombos,
  writeCombos,
  applySeed,
  type ReadCombosResult,
} from "./storage";
import { buildDefaultComboSeeds, SEED_VERSION, type SeedPlaceCoord } from "./presets";
import type { AddResult } from "./useFavorites";
import { newId } from "./storage";
import {
  comboDedupeKey,
  type Combo,
  type ComboPlan,
} from "./types";

const EVT = "must:combos";

/** 缓存最近一次读取结果（同步判断「是否已收藏」用） */
let lastRead: ReadCombosResult = { file: emptyFileV2(), available: false, readOnly: false };
let lastReadAt = 0;

function readCached(force = false): ReadCombosResult {
  const now = Date.now();
  if (!force && lastReadAt && now - lastReadAt < 300) return lastRead;
  lastRead = readCombos();
  lastReadAt = now;
  return lastRead;
}

function emit() {
  lastReadAt = 0;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(EVT));
}

/** 订阅组合变化（同页 + 跨标签）；返回取消订阅 */
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

// ─────────────────────────── 变更操作（模块级） ───────────────────────────

/** 写一次（统一收口：读 → 改 → 写 → 广播） */
function mutate(fn: (file: ReadCombosResult["file"]) => { ok: false; reason: AddResult["reason"]; message?: string } | { ok: true; next: ReadCombosResult["file"] }): AddResult {
  const { available, readOnly, file } = readCached(true);
  if (!available || readOnly) return { ok: false, reason: "unavailable" };
  const r = fn(file);
  if (!r.ok) return { ok: false, reason: r.reason, message: r.message };
  const res = writeCombos(r.next);
  if (!res.ok) return { ok: false, reason: "error", message: res.error };
  emit();
  return { ok: true };
}

/** 新增组合（按 `query` 去重） */
export function addCombo(c: Combo): AddResult {
  return mutate((file) => {
    if (file.combos.some((x) => comboDedupeKey(x) === comboDedupeKey(c))) {
      return { ok: false, reason: "duplicate" };
    }
    return { ok: true, next: { ...file, combos: [...file.combos, c] } };
  });
}

/** 删除整个组合（含其下所有方案） */
export function removeCombo(id: string): AddResult {
  return mutate((file) => ({ ok: true, next: { ...file, combos: file.combos.filter((c) => c.id !== id) } }));
}

/** 更新组合（部分字段；`updatedAt` 自动刷新） */
export function updateCombo(id: string, patch: Partial<Combo>): AddResult {
  return mutate((file) => {
    let found = false;
    const combos = file.combos.map((c) => {
      if (c.id !== id) return c;
      found = true;
      return { ...c, ...patch, updatedAt: Date.now() } as Combo;
    });
    if (!found) return { ok: false, reason: "error", message: "未找到该组合" };
    return { ok: true, next: { ...file, combos } };
  });
}

/** 置顶 / 取消置顶 */
export function togglePinCombo(id: string, pinned: boolean): AddResult {
  return updateCombo(id, { pinned });
}

/** 记录「最近使用」 */
export function touchCombo(id: string): void {
  updateCombo(id, { lastUsedAt: Date.now() });
}

/** 往组合下新增一条已保存方案（按 `fingerprint` 去重） */
export function addPlanToCombo(comboId: string, plan: ComboPlan): AddResult {
  return mutate((file) => {
    const combo = file.combos.find((c) => c.id === comboId);
    if (!combo) return { ok: false, reason: "error", message: "未找到该组合" };
    if (combo.plans.some((p) => p.fingerprint === plan.fingerprint)) return { ok: false, reason: "duplicate" };
    const combos = file.combos.map((c) =>
      c.id !== comboId ? c : { ...c, plans: [...c.plans, plan], updatedAt: Date.now() },
    );
    return { ok: true, next: { ...file, combos } };
  });
}

/** 从组合下移除一条方案（**组合本身保留**；06 §3.6 / FA-A.14） */
export function removePlanFromCombo(comboId: string, planId: string): AddResult {
  return mutate((file) => {
    const combos = file.combos.map((c) =>
      c.id !== comboId ? c : { ...c, plans: c.plans.filter((p) => p.id !== planId), updatedAt: Date.now() },
    );
    return { ok: true, next: { ...file, combos } };
  });
}

/** 更新组合下某方案（备注 / 置顶） */
export function updateComboPlan(comboId: string, planId: string, patch: Partial<ComboPlan>): AddResult {
  return mutate((file) => {
    const combos = file.combos.map((c) =>
      c.id !== comboId
        ? c
        : {
            ...c,
            plans: c.plans.map((p) => (p.id !== planId ? p : ({ ...p, ...patch, updatedAt: Date.now() } as ComboPlan))),
            updatedAt: Date.now(),
          },
    );
    return { ok: true, next: { ...file, combos } };
  });
}

// ─────────────────────────── 收藏入口（★ S2：写入方的唯一收口） ───────────────────────────

/**
 * **收藏一条方案** —— 归入对应组合：
 * · 同 `query` 组合已存在 → 追加一条 `ComboPlan`（按 `fingerprint` 去重）；
 * · 不存在 → **新建组合并带上该 plan**（**一次写入**，避免"建了组合但 plan 没进去"的半成品）。
 */
export function savePlanFavorite(args: {
  from: Combo["from"];
  to: Combo["to"];
  query: string;
  fingerprint: string;
  snapshot: ComboPlan["snapshot"];
  name?: string;
}): AddResult {
  return mutate((file) => {
    const exist = file.combos.find((c) => c.query === args.query);
    if (exist?.plans.some((p) => p.fingerprint === args.fingerprint)) return { ok: false, reason: "duplicate" };
    const plan = makeComboPlan(args.fingerprint, args.snapshot);
    let combos: Combo[];
    if (exist) {
      combos = file.combos.map((c) =>
        c.id === exist.id ? { ...c, plans: [...c.plans, plan], updatedAt: Date.now() } : c,
      );
    } else {
      const c = makeCombo({ from: args.from, to: args.to, name: args.name });
      c.query = args.query; // `makeCombo` 不猜 query（唯一真源 = `comboQueryOf`）
      c.plans = [plan];
      combos = [...file.combos, c];
    }
    return { ok: true, next: { ...file, combos } };
  });
}

/** **收藏一个地点对**（= 新建「无方案」组合）。同 `query` 已有组合 → `duplicate`。 */
export function savePlaceCombo(args: {
  from: Combo["from"];
  to: Combo["to"];
  query: string;
  name?: string;
}): AddResult {
  return mutate((file) => {
    if (file.combos.some((c) => c.query === args.query)) return { ok: false, reason: "duplicate" };
    const c = makeCombo({ from: args.from, to: args.to, name: args.name });
    c.query = args.query;
    return { ok: true, next: { ...file, combos: [...file.combos, c] } };
  });
}

// ─────────────────────────── 构造器 ───────────────────────────

/** 造一个组合（`query` 由 `comboQueryOf()` 生成；06 §3.2 命名规则） */
export function makeCombo(args: {
  from: Combo["from"];
  to: Combo["to"];
  name?: string;
  chain?: Combo["chain"];
  walk?: Combo["walk"];
  tiers?: Combo["tiers"];
  isDefault?: boolean;
}): Combo {
  const now = Date.now();
  const c: Combo = {
    id: newId(),
    type: "combo",
    name: (args.name ?? `${args.from.label} → ${args.to.label}`).slice(0, 24),
    from: args.from,
    to: args.to,
    query: "",
    plans: [],
    createdAt: now,
    updatedAt: now,
  };
  if (args.isDefault) c.isDefault = true;
  if (args.chain?.length) c.chain = args.chain;
  if (args.walk) c.walk = args.walk;
  if (args.tiers) c.tiers = args.tiers;
  return c;
}

/** 造一条「组合下方案」 */
export function makeComboPlan(fingerprint: string, snapshot: ComboPlan["snapshot"], note?: string): ComboPlan {
  const now = Date.now();
  const p: ComboPlan = { id: newId(), fingerprint, snapshot, createdAt: now, updatedAt: now };
  if (note) p.note = note.slice(0, 40);
  return p;
}

// ─────────────────────────── 种子注入 ───────────────────────────

/**
 * 注入 6 个默认组合（幂等；**仅补同名不存在者**）。
 * @returns 实际新增条数（0 = 已注入过 / 坐标不全 / 只读）
 */
export function seedDefaultCombos(coords: SeedPlaceCoord[], zone: string | null): number {
  const { available, readOnly, file } = readCached(true);
  if (!available || readOnly) return 0;
  const seeds = buildDefaultComboSeeds(coords, zone);
  if (!seeds.length) return 0;
  const { file: next, added } = applySeed(file, seeds, SEED_VERSION);
  if (!added) return 0;
  const res = writeCombos(next);
  if (!res.ok) return 0;
  emit();
  return added;
}

// ─────────────────────────── Hook ───────────────────────────

export interface UseCombos {
  mounted: boolean;
  available: boolean;
  readOnly: boolean;
  /** 组合列表（已含默认种子） */
  combos: Combo[];
  /** 全部已保存方案数（含在各组合下） */
  planCount: number;
  /** 某组合是否已存在（按 `query` 判定，与 `comboDedupeKey` 同口径） */
  hasCombo: (query: string) => boolean;
  /** 某组合下是否已保存该指纹 */
  hasPlan: (comboId: string, fingerprint: string) => boolean;
  add: (c: Combo) => AddResult;
  remove: (id: string) => AddResult;
  update: (id: string, patch: Partial<Combo>) => AddResult;
  addPlan: (comboId: string, plan: ComboPlan) => AddResult;
  removePlan: (comboId: string, planId: string) => AddResult;
  updatePlan: (comboId: string, planId: string, patch: Partial<ComboPlan>) => AddResult;
  file: ReadCombosResult["file"];
}

export function useCombos(): UseCombos {
  const [state, setState] = useState<ReadCombosResult>(() => ({
    file: emptyFileV2(),
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
  const planCount = combos.reduce((n, c) => n + c.plans.length, 0);

  return {
    mounted,
    available: state.available,
    readOnly: state.readOnly || !state.available,
    combos,
    planCount,
    hasCombo: (query: string) => combos.some((c) => c.query === query),
    hasPlan: (comboId: string, fingerprint: string) =>
      !!combos.find((c) => c.id === comboId)?.plans.some((p) => p.fingerprint === fingerprint),
    add: addCombo,
    remove: removeCombo,
    update: updateCombo,
    addPlan: addPlanToCombo,
    removePlan: removePlanFromCombo,
    updatePlan: updateComboPlan,
    file: state.file,
  };
}
