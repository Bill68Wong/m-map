/**
 * 收藏 · 存储读写（src/lib/favorites/storage.ts，M Map 改版 S5）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   `localStorage` 单键 `must.favorites.v1` 的**读 / 写 / 校验 / 迁移 / 清理**。
 *   纯浏览器 API（`typeof window` 守卫），**不做任何网络/上报** —— 收藏数据不出设备（合规）。
 *
 * ── 关键坑（02 §2.6）──────────────────────────────────────────────────
 *   F2 Safari ITP / 隐私模式：`setItem` 可能抛（配额满 / 被禁）→ 捕获，返回 `ok:false`，
 *      **不崩 UI**（上层降级为只读 + 行内提示）。
 *   F3 脏数据：读取时**逐条校验**（type/id/坐标数值范围），坏条**静默剔除**并回写，
 *      避免「一条坏记录阻塞整份文件」。
 *   F4 schema 演进：顶层 `schemaVersion`；**未知更高版本只读不写**（防降级覆盖）。
 *
 * ── 容量（§2.4）───────────────────────────────────────────────────────
 *   上限 **200 条**（混合）≈ 60~140 KB（远低于 5MB）。
 *   超出时按 `pinned`（保留）→ `lastUsedAt ?? updatedAt` **最旧优先剔除**。
 */
import {
  FAVORITES_CAP,
  FAVORITES_SCHEMA_VERSION,
  type FavoriteEndpoint,
  type FavoriteItem,
  type FavoritesFile,
  type PlaceFavorite,
  type PlanFavorite,
  type PlanSnapshot,
} from "./types";

/** 存储键（Spec §4 锁定；带版本后缀，便于未来迁移） */
export const FAVORITES_KEY = "must.favorites.v1";

export interface ReadResult {
  file: FavoritesFile;
  /** `localStorage` 是否可用（隐私模式/被禁 → false → 上层降级为只读） */
  available: boolean;
  /** 顶层 `schemaVersion` 高于当前 → **只读不写**（防降级覆盖） */
  readOnly: boolean;
}

const KINDS = new Set(["gps", "poi", "station", "place"]);

/** 空文件 */
export function emptyFile(): FavoritesFile {
  return { schemaVersion: FAVORITES_SCHEMA_VERSION, updatedAt: 0, items: [] };
}

/** 合法坐标？（GCJ-02 经纬度全局范围 + 有限数） */
function validCoord(lng: unknown, lat: unknown): boolean {
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    lng >= -180 &&
    lng <= 180 &&
    lat >= -90 &&
    lat <= 90
  );
}

/** 端点校验（坏 → null） */
function sanitizeEndpoint(raw: unknown): FavoriteEndpoint | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.kind !== "string" || !KINDS.has(e.kind)) return null;
  if (typeof e.label !== "string" || !e.label.trim()) return null;
  if (!validCoord(e.lng, e.lat)) return null;
  const out: FavoriteEndpoint = {
    kind: e.kind as FavoriteEndpoint["kind"],
    label: e.label.slice(0, 60),
    lng: e.lng as number,
    lat: e.lat as number,
  };
  if (typeof e.code === "string" && e.code) out.code = e.code.slice(0, 16);
  if (typeof e.poiId === "string" && e.poiId) out.poiId = e.poiId;
  if (typeof e.adcode === "string" && e.adcode) out.adcode = e.adcode;
  return out;
}

/** 快照校验（坏 → 最小可用快照） */
function sanitizeSnapshot(raw: unknown, fingerprint: string, now: number): PlanSnapshot {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  return {
    capturedAt: num(s.capturedAt, now),
    fingerprint: typeof s.fingerprint === "string" && s.fingerprint ? s.fingerprint : fingerprint,
    totalMin: num(s.totalMin, 0),
    walkMin: typeof s.walkMin === "number" && Number.isFinite(s.walkMin) ? s.walkMin : undefined,
    transfers: num(s.transfers, 0),
    legs: Array.isArray(s.legs) ? s.legs.filter((x): x is string => typeof x === "string").slice(0, 12) : [],
    origin: s.origin === "local" ? "local" : "amap",
  };
}

/** 单条收藏校验（坏 → null，静默剔除） */
function sanitizeItem(raw: unknown): FavoriteItem | null {
  if (!raw || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  if (typeof it.id !== "string" || !it.id) return null;
  if (it.type !== "place" && it.type !== "plan") return null;
  const from = sanitizeEndpoint(it.from);
  const to = sanitizeEndpoint(it.to);
  if (!from || !to) return null;
  if (typeof it.query !== "string" || !it.query.trim()) return null;

  const now = Date.now();
  const createdAt = typeof it.createdAt === "number" && Number.isFinite(it.createdAt) ? it.createdAt : now;
  const updatedAt = typeof it.updatedAt === "number" && Number.isFinite(it.updatedAt) ? it.updatedAt : createdAt;
  const base = {
    id: it.id,
    createdAt,
    updatedAt,
    pinned: it.pinned === true,
  };
  const note = typeof it.note === "string" && it.note.trim() ? it.note.slice(0, 40) : undefined;
  const lastUsedAt = typeof it.lastUsedAt === "number" && Number.isFinite(it.lastUsedAt) ? it.lastUsedAt : undefined;

  if (it.type === "place") {
    const fav: PlaceFavorite = { ...base, type: "place", from, to, query: it.query };
    if (note) fav.note = note;
    if (lastUsedAt !== undefined) fav.lastUsedAt = lastUsedAt;
    return fav;
  }
  // plan：必须要有 fingerprint（无则坏条剔除）
  if (typeof it.fingerprint !== "string" || !it.fingerprint) return null;
  const fav: PlanFavorite = {
    ...base,
    type: "plan",
    from,
    to,
    query: it.query,
    fingerprint: it.fingerprint,
    snapshot: sanitizeSnapshot(it.snapshot, it.fingerprint, createdAt),
  };
  if (note) fav.note = note;
  if (lastUsedAt !== undefined) fav.lastUsedAt = lastUsedAt;
  return fav;
}

/** 去重键：地点对按 `query`；方案按 `query + '#' + fingerprint`（§2.4-2） */
export function dedupeKey(it: FavoriteItem): string {
  return it.type === "place" ? `place:${it.query}` : `plan:${it.query}#${it.fingerprint}`;
}

/** 按去重键去重（保留**较新**的一条） */
function dedupe(items: FavoriteItem[]): FavoriteItem[] {
  const map = new Map<string, FavoriteItem>();
  for (const it of items) {
    const k = dedupeKey(it);
    const prev = map.get(k);
    if (!prev || (it.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) map.set(k, it);
  }
  return [...map.values()];
}

/** 上限护栏：超过 `FAVORITES_CAP` → 置顶保留 + 其余按「最近使用」最旧优先剔除 */
export function pruneToCap(items: FavoriteItem[], cap = FAVORITES_CAP): FavoriteItem[] {
  if (items.length <= cap) return items;
  const pinned = items.filter((i) => i.pinned);
  const rest = items.filter((i) => !i.pinned);
  const recency = (i: FavoriteItem) => i.lastUsedAt ?? i.updatedAt ?? i.createdAt ?? 0;
  rest.sort((a, b) => recency(b) - recency(a)); // 新 → 旧
  const keepRest = Math.max(0, cap - Math.min(pinned.length, cap));
  return [...pinned, ...rest.slice(0, keepRest)];
}

/** `localStorage` 是否可用（写探针 + 立即移除；隐私模式返回 false） */
export function isStorageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const probe = "__mm_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取收藏（含校验 / 迁移）。
 * 任何解析失败 → 空文件（不抛错）；坏条剔除后若与原文不同 → **回写**（自愈）。
 */
export function readFavorites(): ReadResult {
  if (typeof window === "undefined") return { file: emptyFile(), available: false, readOnly: false };
  const available = isStorageAvailable();
  if (!available) return { file: emptyFile(), available: false, readOnly: true };

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(FAVORITES_KEY);
  } catch {
    return { file: emptyFile(), available: false, readOnly: true };
  }
  if (!raw) return { file: emptyFile(), available: true, readOnly: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // F3：整份文件坏 → 不复用，返回空（不删原键，留痕）
    console.warn("[favorites] 文件解析失败（已忽略，不覆盖原数据）");
    return { file: emptyFile(), available: true, readOnly: true };
  }
  if (!parsed || typeof parsed !== "object") return { file: emptyFile(), available: true, readOnly: true };
  const obj = parsed as Record<string, unknown>;

  const ver = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 0;
  // F4：未知的**更高**版本 → 只读不写（防降级覆盖新数据）
  if (ver > FAVORITES_SCHEMA_VERSION) {
    return {
      file: { schemaVersion: FAVORITES_SCHEMA_VERSION, updatedAt: 0, items: [] },
      available: true,
      readOnly: true,
    };
  }

  const rawItems = Array.isArray(obj.items) ? obj.items : [];
  const items: FavoriteItem[] = [];
  for (const r of rawItems) {
    const it = sanitizeItem(r);
    if (it) items.push(it);
  }
  const cleaned = pruneToCap(dedupe(items));
  const removed = rawItems.length - cleaned.length;
  const file: FavoritesFile = {
    schemaVersion: FAVORITES_SCHEMA_VERSION,
    updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
    items: cleaned,
  };
  // 自愈：剔除坏条后回写（避免脏数据长期滞留）
  if (removed > 0) writeFavorites(file);
  return { file, available: true, readOnly: false };
}

/**
 * 写入收藏（含上限清理）。
 * `try/catch` 包住 `setItem`（隐私模式 / 配额满抛 QuotaExceededError）→ `{ok:false}`，不崩 UI。
 */
export function writeFavorites(file: FavoritesFile): { ok: boolean; error?: string } {
  if (typeof window === "undefined") return { ok: false, error: "非浏览器环境" };
  const next: FavoritesFile = {
    schemaVersion: FAVORITES_SCHEMA_VERSION,
    updatedAt: Date.now(),
    items: pruneToCap(dedupe(file.items)),
  };
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

/** 生成 id（`crypto.randomUUID`；不可用时退回时间戳+随机） */
export function newId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
