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
  COMBO_CAP,
  COMBO_NAME_MAX,
  FAVORITES_CAP,
  FAVORITES_KEY_V2,
  FAVORITES_SCHEMA_VERSION,
  FAVORITES_SCHEMA_VERSION_V2,
  comboDefaultName,
  comboDedupeKey,
  type ChainStepKind,
  type Combo,
  type ComboChainStep,
  type ComboPlan,
  type ComboTierNumber,
  type ComboTiers,
  type ComboWalk,
  type FavoriteEndpoint,
  type FavoriteItem,
  type FavoritesFile,
  type FavoritesFileV2,
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

/* ══════════════════════════════════════════════════════════════════════════
   ★ v2 存储（v2.3.0 · 07 §1.1 / §1.3 / §1.4）
   键 `must.favorites.v2` —— 「组合 Combo → 组合下方案 ComboPlan」两级；
   读时**一次性**从 v1 迁移（**v1 键不删**，留作回滚/审计）。
   ══════════════════════════════════════════════════════════════════════════ */

export interface ReadCombosResult {
  file: FavoritesFileV2;
  available: boolean;
  readOnly: boolean;
  /** 本次读取是否发生了 v1 → v2 迁移 */
  migrated?: boolean;
  /** 迁移被中止 / 写入失败的原因（→ 上层提示「本次只读」） */
  migrateError?: string;
}

export function emptyFileV2(): FavoritesFileV2 {
  return { schemaVersion: FAVORITES_SCHEMA_VERSION_V2, updatedAt: 0, combos: [] };
}

const CHAIN_KINDS = new Set<string>(["board", "transfer", "alight"]);

/** 组合下方案校验（坏 → null） */
function sanitizeComboPlan(raw: unknown, now: number): ComboPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  if (typeof p.fingerprint !== "string" || !p.fingerprint) return null;
  const createdAt = typeof p.createdAt === "number" && Number.isFinite(p.createdAt) ? p.createdAt : now;
  const out: ComboPlan = {
    id: typeof p.id === "string" && p.id ? p.id : newId(),
    fingerprint: p.fingerprint,
    snapshot: sanitizeSnapshot(p.snapshot, p.fingerprint, createdAt),
    createdAt,
    updatedAt: typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : createdAt,
  };
  if (typeof p.note === "string" && p.note.trim()) out.note = p.note.slice(0, 40);
  if (p.pinned === true) out.pinned = true;
  return out;
}

/**
 * 站链校验（**坏 → 整条链丢弃**，安全回落到「自动选线」）。
 * 规则同 `combo-params.decodeChain`：2~5 节点 · 首 `board` / 末 `alight` / 中间 `transfer` · 每节点须有 `code`。
 */
function sanitizeChain(raw: unknown): ComboChainStep[] | undefined {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 5) return undefined;
  const out: ComboChainStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as Record<string, unknown> | null;
    if (!it || typeof it !== "object" || Array.isArray(it)) return undefined;
    const kind = String(it.kind ?? "");
    const want = i === 0 ? "board" : i === raw.length - 1 ? "alight" : "transfer";
    if (!CHAIN_KINDS.has(kind) || kind !== want) return undefined;
    const code = typeof it.code === "string" ? it.code.trim() : "";
    if (!code) return undefined;
    const step: ComboChainStep = {
      kind: kind as ChainStepKind,
      code,
      label: typeof it.label === "string" && it.label ? it.label : code,
    };
    if (typeof it.lng === "number" && Number.isFinite(it.lng)) step.lng = it.lng;
    if (typeof it.lat === "number" && Number.isFinite(it.lat)) step.lat = it.lat;
    if (Array.isArray(it.routes)) {
      const rs = it.routes.filter((r): r is string => typeof r === "string" && !!r.trim());
      if (rs.length) step.routes = rs;
    }
    out.push(step);
  }
  return out;
}

/** 步行覆盖校验（越界项**丢该字段**，不废整条） */
function sanitizeWalk(raw: unknown): ComboWalk | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const walk: ComboWalk = {};
  for (const k of ["seg1", "seg2"] as const) {
    const s = o[k];
    if (!s || typeof s !== "object") continue;
    const r = s as Record<string, unknown>;
    const seg: NonNullable<ComboWalk["seg1"]> = {};
    if (typeof r.distanceM === "number" && Number.isFinite(r.distanceM) && r.distanceM >= 0 && r.distanceM <= 20000) {
      seg.distanceM = r.distanceM;
    }
    if (typeof r.minutes === "number" && Number.isFinite(r.minutes) && r.minutes >= 0 && r.minutes <= 180) {
      seg.minutes = r.minutes;
    }
    if (typeof r.link === "boolean") seg.link = r.link;
    if (Object.keys(seg).length) walk[k] = seg;
  }
  return Object.keys(walk).length ? walk : undefined;
}

/** 五档覆盖校验（范围同 `combo-params`：速度 0.5~6 m/s、用时 0~120 分） */
function sanitizeTiers(raw: unknown): ComboTiers | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const tiers: ComboTiers = {};
  for (const k of ["speedMps", "minutes"] as const) {
    const m = o[k];
    if (!m || typeof m !== "object") continue;
    const src = m as Record<string, unknown>;
    const dst: Partial<Record<ComboTierNumber, number>> = {};
    const min = k === "speedMps" ? 0.5 : 0;
    const max = k === "speedMps" ? 6 : 120;
    for (const t of [1, 2, 3, 4, 5] as const) {
      const v = src[String(t)];
      if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) dst[t] = v;
    }
    if (Object.keys(dst).length) tiers[k] = dst;
  }
  return Object.keys(tiers).length ? tiers : undefined;
}

/** 组合校验（坏 → null，静默剔除） */
function sanitizeCombo(raw: unknown, now: number): Combo | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const from = sanitizeEndpoint(c.from);
  const to = sanitizeEndpoint(c.to);
  if (!from || !to) return null;
  if (typeof c.query !== "string" || !c.query.trim()) return null;
  const createdAt = typeof c.createdAt === "number" && Number.isFinite(c.createdAt) ? c.createdAt : now;
  const out: Combo = {
    id: typeof c.id === "string" && c.id ? c.id : newId(),
    type: "combo",
    name:
      typeof c.name === "string" && c.name.trim()
        ? c.name.trim().slice(0, COMBO_NAME_MAX)
        : comboDefaultName(from, to),
    from,
    to,
    query: c.query,
    plans: (Array.isArray(c.plans) ? c.plans : [])
      .map((p) => sanitizeComboPlan(p, now))
      .filter((p): p is ComboPlan => !!p),
    createdAt,
    updatedAt: typeof c.updatedAt === "number" && Number.isFinite(c.updatedAt) ? c.updatedAt : createdAt,
  };
  const chain = sanitizeChain(c.chain);
  if (chain) out.chain = chain;
  const walk = sanitizeWalk(c.walk);
  if (walk) out.walk = walk;
  const tiers = sanitizeTiers(c.tiers);
  if (tiers) out.tiers = tiers;
  if (c.isDefault === true) out.isDefault = true;
  if (c.nameEdited === true) out.nameEdited = true;
  if (c.disabled === true) out.disabled = true;
  if (c.pinned === true) out.pinned = true;
  if (typeof c.lastUsedAt === "number" && Number.isFinite(c.lastUsedAt)) out.lastUsedAt = c.lastUsedAt;
  return out;
}

/** 组合去重：同 `query` 合并为一个（保留较新者，**方案按 fingerprint 合并、不丢**） */
function dedupeCombos(combos: Combo[]): Combo[] {
  const map = new Map<string, Combo>();
  for (const c of combos) {
    const k = comboDedupeKey(c);
    const prev = map.get(k);
    if (!prev) {
      map.set(k, c);
      continue;
    }
    const keep = (c.updatedAt ?? 0) >= (prev.updatedAt ?? 0) ? c : prev;
    const other = keep === c ? prev : c;
    const fps = new Set(keep.plans.map((p) => p.fingerprint));
    map.set(k, { ...keep, plans: [...keep.plans, ...other.plans.filter((p) => !fps.has(p.fingerprint))] });
  }
  return [...map.values()];
}

/** 组合上限护栏（置顶保留 + 其余按「最近使用」最旧优先剔除） */
export function pruneCombosToCap(combos: Combo[], cap = COMBO_CAP): Combo[] {
  if (combos.length <= cap) return combos;
  const pinned = combos.filter((c) => c.pinned);
  const rest = combos.filter((c) => !c.pinned);
  const recency = (c: Combo) => c.lastUsedAt ?? c.updatedAt ?? c.createdAt ?? 0;
  rest.sort((a, b) => recency(b) - recency(a)); // 新 → 旧
  const keepRest = Math.max(0, cap - Math.min(pinned.length, cap));
  return [...pinned, ...rest.slice(0, keepRest)];
}

/**
 * **v1 → v2 迁移（纯函数）** —— 07 §1.3 / 06 §3.5。
 *
 * 映射：`PlaceFavorite → Combo(plans:[])`；`PlanFavorite → 按 query 归入同一 Combo 的 ComboPlan`
 * （同 query 已由某 `PlaceFavorite` 建过 Combo 则**复用**，不重复建）。
 * 命名：v1 `note` **优先**作为新名（无损用户既有命名）；无 note 用默认名。
 *
 * ★ **守恒校验（条目不减少）**：`#comboPlan === #plan` 且 `#combo ≥ #place`；否则 `ok:false`
 *   ⇒ 调用方**中止迁移、保留 v1**（防半迁移，07 §1.3 / 风险 #1）。
 *   ⚠️ 07 §1.3 的字面表述是「`#place + #plan` vs `#combo + #comboPlan` 必须**相等**」——
 *      该等式对**「只有方案、没有地点对」的 query 不成立**（此时必须新建 Combo，`#combo` 会多于 `#place`）。
 *      故此处实现为上面两条**等价且更强**的「无丢失」判据（多出的 Combo 只可能来自 plan 分组）。
 */
export function migrateV1(v1: FavoritesFile): { ok: true; combos: Combo[] } | { ok: false; reason: string } {
  const now = Date.now();
  const combos: Combo[] = [];
  const byQuery = new Map<string, Combo>();
  const placeCount = v1.items.filter((i) => i.type === "place").length;
  const planCount = v1.items.filter((i) => i.type === "plan").length;

  // ① 地点对 → Combo（plans: []）
  for (const it of v1.items) {
    if (it.type !== "place") continue;
    const note = it.note?.trim();
    const c: Combo = {
      id: it.id,
      type: "combo",
      name: (note || comboDefaultName(it.from, it.to)).slice(0, COMBO_NAME_MAX),
      from: it.from,
      to: it.to,
      query: it.query,
      plans: [],
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
    };
    if (note) c.nameEdited = true; // v1 note 被当作名称 ⇒ 视为用户命名，后续不被默认名覆盖
    if (it.pinned) c.pinned = true;
    if (it.lastUsedAt !== undefined) c.lastUsedAt = it.lastUsedAt;
    combos.push(c);
    byQuery.set(it.query, c);
  }

  // ② 方案 → 按 query 归入 Combo（复用已有 or 新建）
  for (const it of v1.items) {
    if (it.type !== "plan") continue;
    let c = byQuery.get(it.query);
    if (!c) {
      const note = it.note?.trim();
      c = {
        id: it.id,
        type: "combo",
        name: (note || comboDefaultName(it.from, it.to)).slice(0, COMBO_NAME_MAX),
        from: it.from,
        to: it.to,
        query: it.query,
        plans: [],
        createdAt: it.createdAt,
        updatedAt: it.updatedAt,
      };
      if (note) c.nameEdited = true;
      if (it.pinned) c.pinned = true;
      combos.push(c);
      byQuery.set(it.query, c);
    }
    const plan: ComboPlan = {
      id: it.id,
      fingerprint: it.fingerprint,
      snapshot: it.snapshot,
      createdAt: it.createdAt,
      updatedAt: it.updatedAt,
    };
    if (it.note?.trim()) plan.note = it.note.trim().slice(0, 40);
    if (it.pinned) plan.pinned = true;
    c.plans.push(plan);
  }

  // ③ 守恒校验（无丢失）
  const merged = dedupeCombos(combos);
  const outPlans = merged.reduce((n, c) => n + c.plans.length, 0);
  if (outPlans !== planCount) {
    return { ok: false, reason: `方案条目不守恒（v1 ${planCount} → v2 ${outPlans}）` };
  }
  if (merged.length < placeCount) {
    return { ok: false, reason: `组合条目减少（v1 地点对 ${placeCount} → v2 组合 ${merged.length}）` };
  }
  void now;
  return { ok: true, combos: merged };
}

/**
 * 默认组合种子注入（幂等，07 §1.4）。
 * 仅当 `file.seedVersion < version` 时，补「**同名不存在**」的默认组合，然后置位。
 * 用户删掉的默认组合**不再复活**（seedVersion 已置位）。
 */
export function applySeed(
  file: FavoritesFileV2,
  seeds: Combo[],
  version: number,
): { file: FavoritesFileV2; added: number } {
  const cur = file.seedVersion ?? 0;
  if (cur >= version) return { file, added: 0 };
  const names = new Set(file.combos.map((c) => c.name));
  const queries = new Set(file.combos.map((c) => comboDedupeKey(c)));
  const add = seeds.filter((s) => !names.has(s.name) && !queries.has(comboDedupeKey(s)));
  return {
    file: { ...file, seedVersion: version, updatedAt: Date.now(), combos: [...file.combos, ...add] },
    added: add.length,
  };
}

/**
 * 读取组合。**读优先 `must.favorites.v2`**；缺失时从 v1 迁移（v1 键不删）。
 * · 写失败（隐私/配额）→ **不写、不删 v1**，本次会话**只读降级**（返回已迁移数据 + `readOnly`）。
 * · 迁移守恒校验不过 → **中止迁移、保留 v1**，只读。
 */
export function readCombos(): ReadCombosResult {
  if (typeof window === "undefined") return { file: emptyFileV2(), available: false, readOnly: false };
  const available = isStorageAvailable();
  if (!available) return { file: emptyFileV2(), available: false, readOnly: true };

  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(FAVORITES_KEY_V2);
  } catch {
    return { file: emptyFileV2(), available: false, readOnly: true };
  }

  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[favorites] v2 文件解析失败（已忽略，不覆盖原数据）");
      return { file: emptyFileV2(), available: true, readOnly: true };
    }
    if (!parsed || typeof parsed !== "object") return { file: emptyFileV2(), available: true, readOnly: true };
    const obj = parsed as Record<string, unknown>;
    const ver = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 0;
    // F4：未知更高版本 → 只读不写
    if (ver > FAVORITES_SCHEMA_VERSION_V2) return { file: emptyFileV2(), available: true, readOnly: true };

    const now = Date.now();
    const rawCombos = Array.isArray(obj.combos) ? obj.combos : [];
    const combos = pruneCombosToCap(
      dedupeCombos(rawCombos.map((c) => sanitizeCombo(c, now)).filter((c): c is Combo => !!c)),
    );
    const file: FavoritesFileV2 = {
      schemaVersion: FAVORITES_SCHEMA_VERSION_V2,
      updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
      combos,
    };
    if (obj.migratedFrom === "v1") file.migratedFrom = "v1";
    if (typeof obj.seedVersion === "number" && Number.isFinite(obj.seedVersion)) file.seedVersion = obj.seedVersion;
    // 自愈：坏条被剔除 → 回写（避免脏数据长期滞留）
    if (combos.length !== rawCombos.length) writeCombos(file);
    return { file, available: true, readOnly: false };
  }

  // ── 无 v2 键 → 尝试从 v1 迁移 ──
  const v1 = readFavorites();
  if (!v1.available) return { file: emptyFileV2(), available: false, readOnly: true };
  if (!v1.file.items.length) return { file: emptyFileV2(), available: true, readOnly: false };
  const mig = migrateV1(v1.file);
  if (!mig.ok) {
    console.warn("[favorites] v1→v2 迁移中止（保留 v1）:", mig.reason);
    return { file: emptyFileV2(), available: true, readOnly: true, migrateError: mig.reason };
  }
  const file: FavoritesFileV2 = {
    schemaVersion: FAVORITES_SCHEMA_VERSION_V2,
    updatedAt: Date.now(),
    migratedFrom: "v1",
    combos: mig.combos,
  };
  const w = writeCombos(file);
  if (!w.ok) {
    // 写失败 ⇒ 不写、不删 v1；本次会话只读降级（数据仍可展示）
    return { file, available: true, readOnly: true, migrateError: w.error ?? "写入失败" };
  }
  return { file, available: true, readOnly: false, migrated: true };
}

/**
 * 写入组合（含去重 + 上限清理）。
 * `try/catch` 包住 `setItem`（隐私模式 / 配额满）→ `{ok:false}`，不崩 UI。
 */
export function writeCombos(file: FavoritesFileV2): { ok: boolean; error?: string } {
  if (typeof window === "undefined") return { ok: false, error: "非浏览器环境" };
  const next: FavoritesFileV2 = {
    ...file,
    schemaVersion: FAVORITES_SCHEMA_VERSION_V2,
    updatedAt: Date.now(),
    combos: pruneCombosToCap(dedupeCombos(file.combos)),
  };
  try {
    window.localStorage.setItem(FAVORITES_KEY_V2, JSON.stringify(next));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
