/**
 * 收藏 v3 · 模型 / 存储 / 迁移（src/lib/favorites/v3.ts，v3.3.0 · ADR-104 / AC-111/117）
 *
 * ── 模型（两实体，方案层退役）────────────────────────────────────────────
 *   `ComboV3` = 一对「起点 → 终点」（**无** `chain`/`walk`/`tiers`/`plans`）；
 *   `PlaceV3` = 单个地点（我们库站点 / 高德 POI / 任意选点）。
 *   键 `must.favorites.v3`；备份键 `must.favorites.v2.backup`。
 *
 * ── 迁移状态机（AC-111 · 不可逆操作前必双层备份）──────────────────────────
 *   ```
 *   readV3():
 *     ① 有 v3 → 校验返回（终态）
 *     ② 无 v3，但存在 v2 / v1：
 *        a. 备份① 触发「导出 JSON」下载（v2 全文，含 v1）
 *        b. 备份② 写隐藏键 must.favorites.v2.backup（v2 + v1 + ts）
 *        c. migrate → combos 保留自建（丢 plans/chain/walk/tiers）、places 由端点去重派生、
 *           **删全部 isDefault 组合**（预置清退）
 *        d. 写 v3；**v1 / v2 键一律不删**（可回滚：删 v3 键即回读 v2）
 *     ③ 均无 → 空 v3
 *   失败回滚：任一步异常 → **不写 v3、不删任何键** → 返回空 + `migrationFailed`（UI 提示，旧数据完好）
 *   ```
 *   ⚠️ 备份① 为**尽力而为**（浏览器可能拦截下载）；备份②（本地隐藏键）是**可回滚的硬前置** ——
 *      它写失败 ⇒ **中止迁移**，本次只读。
 *
 * ⚠️ 纯 localStorage 模块：**禁止 import 任何含 pg 的模块**（client 组件直接引用）。
 */
import { isStorageAvailable, newId, FAVORITES_KEY } from "./storage";
/* ⚠️ `FAVORITES_KEY_V2` 定义在 `types.ts`（`storage.ts` 只是 import 它、**不 re-export**）
   ⇒ 必须从 `types` 取，否则拿到 `undefined`（键读不到 ⇒ 迁移静默走空路径）。 */
import { FAVORITES_KEY_V2, type FavoriteEndpoint, type FavoriteEndpointKind } from "./types";

export const FAVORITES_KEY_V3 = "must.favorites.v3";
export const FAVORITES_BACKUP_KEY = "must.favorites.v2.backup";
/** v3 schema 版本 */
export const FAVORITES_SCHEMA_VERSION_V3 = 3;
/** 上限护栏（置顶保留 + 其余按最近使用最旧剔除） */
export const COMBO_V3_CAP = 30;
export const PLACE_V3_CAP = 60;

/** 组合（v3）：一对起终点；**无方案层** */
export interface ComboV3 {
  id: string;
  type: "combo";
  /** 默认「{起点} → {终点}」 */
  name: string;
  from: FavoriteEndpoint;
  to: FavoriteEndpoint;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  /** 停用（灰字 + 沉底；不参与「点卡即算」）—— 设计 §3.2 的 ⋯ 菜单项 */
  disabled?: boolean;
  lastUsedAt?: number;
}

/** 地点（v3）：单个地点 */
export interface PlaceV3 {
  id: string;
  type: "place";
  endpoint: FavoriteEndpoint;
  /** 用户改名（缺省用 `endpoint.label`） */
  name?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  lastUsedAt?: number;
}

export interface FavoritesFileV3 {
  schemaVersion: 3;
  updatedAt: number;
  /** 迁移来源（仅作审计）；`v2` 路径含「v1→v2→v3」两跳 */
  migratedFrom?: "v1" | "v2";
  combos: ComboV3[];
  places: PlaceV3[];
}

export interface ReadV3Result {
  file: FavoritesFileV3;
  available: boolean;
  readOnly: boolean;
  /** 本次读取是否发生了 v1/v2 → v3 迁移 */
  migrated?: boolean;
  /** 迁移被中止（异常 / 备份写失败）⇒ UI 提示「稍后再试」，旧数据完好 */
  migrationFailed?: boolean;
  migrateError?: string;
}

export function emptyV3(): FavoritesFileV3 {
  return { schemaVersion: 3, updatedAt: 0, combos: [], places: [] };
}

/* ─────────────────────────── 底层读写 ─────────────────────────── */

interface Raw {
  present: boolean;
  parsed: unknown;
  broken: boolean;
}

function readRaw(key: string): Raw {
  if (typeof window === "undefined") return { present: false, parsed: null, broken: false };
  let s: string | null = null;
  try {
    s = window.localStorage.getItem(key);
  } catch {
    return { present: false, parsed: null, broken: false };
  }
  if (!s) return { present: false, parsed: null, broken: false };
  try {
    const p = JSON.parse(s);
    if (!p || typeof p !== "object") return { present: true, parsed: null, broken: true };
    return { present: true, parsed: p, broken: false };
  } catch {
    return { present: true, parsed: null, broken: true };
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const KINDS = new Set<string>(["gps", "poi", "station", "place"]);

/** 端点校验（越界/缺字段 → null，不废整条） */
function sanitizeEndpoint(raw: unknown): FavoriteEndpoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === "string" && KINDS.has(r.kind) ? (r.kind as FavoriteEndpointKind) : null;
  const label = str(r.label, 60);
  const lng = num(r.lng);
  const lat = num(r.lat);
  if (!kind || !label || lng == null || lat == null) return null;
  if (lng < 110 || lng > 115 || lat < 21 || lat > 23.5) return null; // 澳门邻近外拒收
  const ep: FavoriteEndpoint = { kind, label, lng, lat };
  const code = str(r.code, 24);
  const poiId = str(r.poiId, 48);
  const adcode = str(r.adcode, 12);
  if (code) ep.code = code;
  if (poiId) ep.poiId = poiId;
  if (adcode) ep.adcode = adcode;
  return ep;
}

function sanitizeCombo(raw: unknown): ComboV3 | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "combo") return null;
  const from = sanitizeEndpoint(r.from);
  const to = sanitizeEndpoint(r.to);
  if (!from || !to) return null;
  const now = Date.now();
  const c: ComboV3 = {
    id: str(r.id, 64) ?? newId(),
    type: "combo",
    name: str(r.name, 40) ?? `${from.label} → ${to.label}`,
    from,
    to,
    createdAt: num(r.createdAt) ?? now,
    updatedAt: num(r.updatedAt) ?? now,
  };
  if (r.pinned === true) c.pinned = true;
  if (r.disabled === true) c.disabled = true;
  const lu = num(r.lastUsedAt);
  if (lu != null) c.lastUsedAt = lu;
  return c;
}

function sanitizePlace(raw: unknown): PlaceV3 | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "place") return null;
  const endpoint = sanitizeEndpoint(r.endpoint);
  if (!endpoint) return null;
  const now = Date.now();
  const p: PlaceV3 = {
    id: str(r.id, 64) ?? newId(),
    type: "place",
    endpoint,
    createdAt: num(r.createdAt) ?? now,
    updatedAt: num(r.updatedAt) ?? now,
  };
  const nm = str(r.name, 40);
  if (nm) p.name = nm;
  if (r.pinned === true) p.pinned = true;
  const lu = num(r.lastUsedAt);
  if (lu != null) p.lastUsedAt = lu;
  return p;
}

/** 上限护栏：置顶保留 → 其余按「最近使用」最旧优先剔除 */
function prune<T extends { pinned?: boolean; lastUsedAt?: number; createdAt: number }>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const sorted = [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    return (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt);
  });
  return sorted.slice(0, cap);
}

/** 组合去重键（同起终点 = 同一条） */
export function comboV3Key(c: Pick<ComboV3, "from" | "to">): string {
  const ep = (e: FavoriteEndpoint) => `${e.kind}|${e.code ?? e.poiId ?? ""}|${e.lng.toFixed(5)},${e.lat.toFixed(5)}`;
  return `${ep(c.from)}→${ep(c.to)}`;
}

/** 地点去重键 */
export function placeV3Key(p: Pick<PlaceV3, "endpoint">): string {
  const e = p.endpoint;
  return `${e.kind}|${e.code ?? e.poiId ?? ""}|${e.lng.toFixed(5)},${e.lat.toFixed(5)}`;
}

function sanitizeFile(raw: Record<string, unknown>): FavoritesFileV3 {
  const rc = Array.isArray(raw.combos) ? raw.combos : [];
  const rp = Array.isArray(raw.places) ? raw.places : [];
  const combos = rc.map(sanitizeCombo).filter((c): c is ComboV3 => !!c);
  const places = rp.map(sanitizePlace).filter((p): p is PlaceV3 => !!p);
  // 组合去重（同起终点只留一条）
  const seen = new Set<string>();
  const uniqCombos = combos.filter((c) => {
    const k = comboV3Key(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const seenP = new Set<string>();
  const uniqPlaces = places.filter((p) => {
    const k = placeV3Key(p);
    if (seenP.has(k)) return false;
    seenP.add(k);
    return true;
  });
  const f: FavoritesFileV3 = {
    schemaVersion: 3,
    updatedAt: num(raw.updatedAt) ?? 0,
    combos: prune(uniqCombos, COMBO_V3_CAP),
    places: prune(uniqPlaces, PLACE_V3_CAP),
  };
  if (raw.migratedFrom === "v1" || raw.migratedFrom === "v2") f.migratedFrom = raw.migratedFrom;
  return f;
}

export function writeV3(file: FavoritesFileV3): { ok: boolean; error?: string } {
  if (typeof window === "undefined") return { ok: false, error: "非浏览器环境" };
  const next: FavoritesFileV3 = {
    ...file,
    schemaVersion: 3,
    updatedAt: Date.now(),
    combos: prune(file.combos ?? [], COMBO_V3_CAP),
    places: prune(file.places ?? [], PLACE_V3_CAP),
  };
  try {
    window.localStorage.setItem(FAVORITES_KEY_V3, JSON.stringify(next));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ─────────────────────────── 迁移 ─────────────────────────── */

/** 写隐藏备份键（**可回滚的硬前置**；失败 ⇒ 抛错中止迁移）
 *  ⚠️ 2026-09-27 口径修正：迁移**只做静默备份**（本函数）——「导出 JSON」为**用户手动入口**
 *     （`FavoritesClient` 的「下载备份」按钮）；**禁止**在迁移路径自动触发下载
 *     （曾因自动 `a.click()` 直接下载文件惊吓用户，已移除该路径）。 */
function writeBackupKey(v2: unknown, v1: unknown): void {
  window.localStorage.setItem(
    FAVORITES_BACKUP_KEY,
    JSON.stringify({ ts: Date.now(), v2: v2 ?? null, v1: v1 ?? null }),
  );
}

/** 由 v2/v1 原始数据派生 v3（丢 plans/chain/walk/tiers；删 isDefault 预设） */
export function migrateToV3(v2: unknown, v1: unknown): FavoritesFileV3 {
  const combos: ComboV3[] = [];
  const rawCombos = (v2 && typeof v2 === "object" && Array.isArray((v2 as Record<string, unknown>).combos)
    ? ((v2 as Record<string, unknown>).combos as unknown[])
    : []) as Record<string, unknown>[];
  for (const rc of rawCombos) {
    if (rc && typeof rc === "object" && rc.isDefault === true) continue; // ★ 预置清退
    const c = sanitizeCombo(rc);
    if (c) combos.push(c);
  }
  // 组合去重
  const seen = new Set<string>();
  const uniqCombos = combos.filter((c) => {
    const k = comboV3Key(c);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // places：由「组合端点」+「v1 地点对端点」去重派生（ADR-104）
  const places: PlaceV3[] = [];
  const seenP = new Set<string>();
  const now = Date.now();
  const push = (ep: FavoriteEndpoint | null) => {
    if (!ep || places.length >= PLACE_V3_CAP) return;
    const k = `${ep.kind}|${ep.code ?? ep.poiId ?? ""}|${ep.lng.toFixed(5)},${ep.lat.toFixed(5)}`;
    if (seenP.has(k)) return;
    seenP.add(k);
    places.push({ id: newId(), type: "place", endpoint: ep, createdAt: now, updatedAt: now });
  };
  for (const c of uniqCombos) {
    push(c.from);
    push(c.to);
  }
  const v1Items = v1 && typeof v1 === "object" && Array.isArray((v1 as Record<string, unknown>).items)
    ? ((v1 as Record<string, unknown>).items as unknown[])
    : [];
  for (const it of v1Items) {
    const r = it as Record<string, unknown> | null;
    if (r && r.type === "place") {
      push(sanitizeEndpoint(r.from));
      push(sanitizeEndpoint(r.to));
    }
  }

  return {
    schemaVersion: 3,
    updatedAt: now,
    migratedFrom: v2 && typeof v2 === "object" ? "v2" : "v1",
    combos: prune(uniqCombos, COMBO_V3_CAP),
    places,
  };
}

/**
 * 读 v3（含迁移）。**任何异常 → 不写 v3、不删任何键**，返回空 + `migrationFailed`。
 */
export function readV3(): ReadV3Result {
  if (typeof window === "undefined") return { file: emptyV3(), available: false, readOnly: false };
  const available = isStorageAvailable();
  if (!available) return { file: emptyV3(), available: false, readOnly: true };

  const rv3 = readRaw(FAVORITES_KEY_V3);
  if (rv3.present) {
    if (rv3.broken) {
      console.warn("[favorites] v3 文件解析失败（已忽略，不覆盖原数据）");
      return { file: emptyV3(), available: true, readOnly: true };
    }
    const obj = rv3.parsed as Record<string, unknown>;
    const ver = num(obj.schemaVersion) ?? 0;
    if (ver > FAVORITES_SCHEMA_VERSION_V3) return { file: emptyV3(), available: true, readOnly: true };
    try {
      return { file: sanitizeFile(obj), available: true, readOnly: false };
    } catch {
      return { file: emptyV3(), available: true, readOnly: true };
    }
  }

  // ── 无 v3 → 迁移 ──
  const rv2 = readRaw(FAVORITES_KEY_V2);
  const rv1 = readRaw(FAVORITES_KEY);
  if (!rv2.present && !rv1.present) return { file: emptyV3(), available: true, readOnly: false };
  if (rv2.broken || rv1.broken) {
    console.warn("[favorites] 旧版收藏解析失败 → 迁移中止（原键保留）");
    return {
      file: emptyV3(),
      available: true,
      readOnly: true,
      migrationFailed: true,
      migrateError: "旧收藏数据解析失败（已原样保留）",
    };
  }
  try {
    writeBackupKey(rv2.parsed, rv1.parsed); // 静默备份（硬前置：失败即抛 → 中止迁移）
    const file = migrateToV3(rv2.parsed, rv1.parsed);
    const w = writeV3(file);
    if (!w.ok) throw new Error(w.error ?? "写入失败");
    return { file, available: true, readOnly: false, migrated: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[favorites] v3 迁移中止（未写 v3、未删任何键）:", msg);
    return { file: emptyV3(), available: true, readOnly: true, migrationFailed: true, migrateError: msg };
  }
}

/** 是否已有隐藏备份键（UI 一次性提示用） */
export function hasBackupKey(): boolean {
  return readRaw(FAVORITES_BACKUP_KEY).present;
}

/** 生成组合（v3） */
export function makeComboV3(args: { from: FavoriteEndpoint; to: FavoriteEndpoint; name?: string }): ComboV3 {
  const now = Date.now();
  return {
    id: newId(),
    type: "combo",
    name: (args.name?.trim() || `${args.from.label} → ${args.to.label}`).slice(0, 40),
    from: args.from,
    to: args.to,
    createdAt: now,
    updatedAt: now,
  };
}

/** 生成地点（v3） */
export function makePlaceV3(endpoint: FavoriteEndpoint, name?: string): PlaceV3 {
  const now = Date.now();
  const p: PlaceV3 = { id: newId(), type: "place", endpoint, createdAt: now, updatedAt: now };
  const nm = name?.trim();
  if (nm) p.name = nm.slice(0, 40);
  return p;
}
