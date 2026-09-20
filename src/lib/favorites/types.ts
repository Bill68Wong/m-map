/**
 * 收藏 · 类型与 Schema（src/lib/favorites/types.ts，M Map 改版 S5）
 *
 * ── 权威来源 ──────────────────────────────────────────────────────────
 *   `docs/改版-M-Map-20260920/02-技术方案.md §2.3`（字段级 Schema）。
 *   存储：`localStorage["must.favorites.v1"] = JSON.stringify(FavoritesFile)`。
 *
 * ⚠️ 纯类型 / 纯工具模块：**禁止 import 任何含 pg 的模块**（client 组件会直接引用）。
 *
 * ── 两类实体 ──────────────────────────────────────────────────────────
 *   · `PlaceFavorite`（地点对）：只存起终点，规划结果**每次实时算**；
 *   · `PlanFavorite`（路线方案）：地点对 + **方案指纹 `fingerprint`** + 展示用快照。
 *     ★ **不落 `planId`** —— planId 每次请求临时生成、跨请求不稳定（存它必然「回放即失效」）。
 *
 * ── 回放 ──────────────────────────────────────────────────────────────
 *   · 地点对 → `/nav?${query}`（重新规划取最新 5 条）；
 *   · 方案 → 先重算 → 按指纹比对：命中用**当前卡 planId** 跳 `/nav/detail?${query}&plan=<当前planId>`；
 *     未命中 → 落 `/nav?${query}` + 「已重新规划」提示。
 *
 * ⚠️ 坐标一律 **GCJ-02**（与项目坐标铁律一致）。
 */

/** 端点类型（与 `NavPointKind` 一致） */
export type FavoriteEndpointKind = "gps" | "poi" | "station" | "place";

/** 端点（与 `NavPoint` 同构；坐标 GCJ-02） */
export interface FavoriteEndpoint {
  kind: FavoriteEndpointKind;
  /** 展示名（站名用繁体官方原文） */
  label: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** 我们库站码（kind="station" 时） */
  code?: string;
  /** 高德 POI id（kind="poi" 时，可选） */
  poiId?: string;
  /** 行政区划码（澳门 = 820000，可选） */
  adcode?: string;
}

/** 公共字段 */
export interface FavoriteBase {
  /** uuid v4（crypto.randomUUID） */
  id: string;
  /** 首次收藏时刻（ms） */
  createdAt: number;
  /** 最近修改时刻（ms） */
  updatedAt: number;
  /** 置顶（可选，默认 false；清理时优先保留） */
  pinned?: boolean;
}

/** ①「地点对」收藏：只存起终点，规划结果每次实时算 */
export interface PlaceFavorite extends FavoriteBase {
  type: "place";
  from: FavoriteEndpoint;
  to: FavoriteEndpoint;
  /** 规范化查询串（= `parseNavParams().query`，**不含 plan**）—— 回放/重算的唯一依据 */
  query: string;
  /** 用户备注（可选，≤40 字） */
  note?: string;
  /** 最近一次使用时刻（排序 / 清理用） */
  lastUsedAt?: number;
}

/** 方案快照（**仅展示**，「保存于 MM-DD」；不作真值） */
export interface PlanSnapshot {
  /** 采集时刻（ms） */
  capturedAt: number;
  /** 同 `PlanFavorite.fingerprint`（快照自洽，便于校验/迁移） */
  fingerprint: string;
  /** 门到门总时长（分钟，我们的口径） */
  totalMin: number;
  /** 步行合计（分钟） */
  walkMin?: number;
  /** 换乘次数 */
  transfers: number;
  /** 载具摘要，如 ["51A 關閘→科大", "輕軌 科大→媽閣"] */
  legs: string[];
  /** 方案来源（与 `NavPlan.origin` 一致） */
  origin: "amap" | "local";
}

/** ②「路线方案」收藏：地点对 + 一条具体方案的快照 */
export interface PlanFavorite extends FavoriteBase {
  type: "plan";
  from: FavoriteEndpoint;
  to: FavoriteEndpoint;
  /** 同 `PlaceFavorite.query`（不含 plan） */
  query: string;
  /**
   * ★ 方案指纹（**不存 planId**）。
   *   算法：`rides.map(r => \`${r.route}@${r.board}->${r.alight}\`).join("|")`
   *   与本地枚举的 `OptionSeed.key` 同构，只依赖「坐哪条线、哪站上、哪站下」，稳定可复算。
   */
  fingerprint: string;
  /** 采集时的方案摘要快照（用于离线展示；**不作真值**） */
  snapshot: PlanSnapshot;
  note?: string;
  lastUsedAt?: number;
}

export type FavoriteItem = PlaceFavorite | PlanFavorite;

/** 顶层文件（一个 key 装全部收藏） */
export interface FavoritesFile {
  /** 迁移锚点；未来加字段时自增 */
  schemaVersion: 1;
  /** 最后写入时间（ms） */
  updatedAt: number;
  /** 全部收藏 */
  items: FavoriteItem[];
}

/** 收藏上限（混合；§2.4） */
export const FAVORITES_CAP = 200;
/** 当前 schema 版本 */
export const FAVORITES_SCHEMA_VERSION = 1 as const;

/** 参与指纹计算的最小载具段结构（与 `RideLegView` 结构兼容） */
export interface RideLike {
  route: string;
  board: string;
  alight: string;
}

/**
 * 方案指纹：`rides.map(r => \`${r.route}@${r.board}->${r.alight}\`).join("|")`
 *
 * ★ 与 `OptionSeed.key` 同构 —— **收藏与回放必须调用同一算法**（此处是唯一真源）。
 */
export function planFingerprint(rides: RideLike[]): string {
  return rides.map((r) => `${r.route}@${r.board}->${r.alight}`).join("|");
}

/** 载具摘要文案（快照 legs 用；界面简体外壳 + 繁体站名/线路名） */
export function legSummary(rides: { route: string; boardLabel: string; alightLabel: string }[]): string[] {
  return rides.map((r) => `${r.route} ${r.boardLabel}→${r.alightLabel}`);
}

/**
 * `NavPoint`（同构）→ 收藏端点。
 * ⚠️ 不 import `@/lib/nav/types`（保持本模块零依赖，纯函数）；按结构取字段。
 */
export function endpointOf(p: {
  kind: string;
  label: string;
  lng: number;
  lat: number;
  code?: string;
  poiId?: string;
  adcode?: string;
}): FavoriteEndpoint {
  const e: FavoriteEndpoint = { kind: p.kind as FavoriteEndpointKind, label: p.label, lng: p.lng, lat: p.lat };
  if (p.code) e.code = p.code;
  if (p.poiId) e.poiId = p.poiId;
  if (p.adcode) e.adcode = p.adcode;
  return e;
}

/** 「保存于 MM-DD」（澳门时区 UTC+8；卡片**永远显示**，§2.5） */
export function savedAtText(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `保存于 ${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/* ══════════════════════════════════════════════════════════════════════════
   ★ v2（v2.3.0 · 07 §1 / 06 §3.7）：两级模型「组合 Combo → 组合下方案 ComboPlan」
   ══════════════════════════════════════════════════════════════════════════
   · **组合 = "去哪"**（一个 OD + 可选站链/参数）；**组合下方案 = "怎么走"**（被显式存下的一条指纹+快照）
   · **「多方案」不是存储**：点组合卡 → 现场实时算出的候选列表；`ComboPlan` 只是其子集
   · 复用（不重写）：`FavoriteEndpoint` / `PlanSnapshot` / `planFingerprint` / `endpointOf` / `savedAtText`
   ══════════════════════════════════════════════════════════════════════════ */

/** 站链节点种类：上车 / 换乘 / 下车 */
export type ChainStepKind = "board" | "transfer" | "alight";

/**
 * 站链节点（与 `src/lib/nav/combo-params.ts` 的 `ChainStep` **结构一致**）。
 * ⚠️ 此处**故意不 import** `combo-params`（保持本模块零依赖、纯类型）——由消费方做结构兼容。
 * `routes?` = 该「上车/换乘」节点容许的**并行线路候选**（D1 段内并行）。
 */
export interface ComboChainStep {
  kind: ChainStepKind;
  /** 站码（可为站台码如 `T373/1`） */
  code?: string;
  label: string;
  lng?: number;
  lat?: number;
  routes?: string[];
}

/** 步行覆盖（单段）：`link=false` 表示距离与时长**不联动**（各自独立，07 §2.5） */
export interface ComboWalkSeg {
  distanceM?: number;
  minutes?: number;
  link?: boolean;
}
/** 两段步行覆盖：seg1 = 出发地→上车站；seg2 = 下车站→目的地 */
export interface ComboWalk {
  seg1?: ComboWalkSeg;
  seg2?: ComboWalkSeg;
}

export type ComboTierNumber = 1 | 2 | 3 | 4 | 5;
/** 五档覆盖：`speedMps` 覆盖派生速度；`minutes` 直接覆盖该档用时 */
export interface ComboTiers {
  speedMps?: Partial<Record<ComboTierNumber, number>>;
  minutes?: Partial<Record<ComboTierNumber, number>>;
}

/** 组合下**已保存方案**（≈ v1 `PlanFavorite` 去 OD 化；指纹真源同 `planFingerprint`） */
export interface ComboPlan {
  id: string;
  /** 复用 `planFingerprint`（唯一真源） */
  fingerprint: string;
  /** 采集时快照（**只作离线/降级展示**，不作真值；含 `capturedAt` → 「保存于 MM-DD」） */
  snapshot: PlanSnapshot;
  note?: string;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
}

/** 组合 = 一对「出发地 → 目的地」+ 可选站链/参数 + 已保存方案 */
export interface Combo {
  id: string;
  type: "combo";
  /** ≤24 字；默认「出发地 label → 目的地 label」 */
  name: string;
  from: FavoriteEndpoint;
  to: FavoriteEndpoint;
  /** = `parseNavParams().query`（**不含 plan**，也不含 chain/walk/tiers）—— 重算锚点 */
  query: string;
  /** 站链；空/缺省 = 自动选线 */
  chain?: ComboChainStep[];
  walk?: ComboWalk;
  tiers?: ComboTiers;
  /** 组合下已保存方案（0..N） */
  plans: ComboPlan[];
  /** 旧计时预设内置（可被用户删除） */
  isDefault?: boolean;
  /** 用户改过名 → 默认名不再覆盖（07 §1.1 落定要点） */
  nameEdited?: boolean;
  /**
   * ★ S2：**已停用**（08 §C.2 停用态）—— 灰字、排序沉底、不参与「点卡即算」；
   * 仅作静默停用（08 §E7：**不新增任何"该功能已下线"告知**）。
   */
  disabled?: boolean;
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  lastUsedAt?: number;
}

/** v2 顶层文件（键 `must.favorites.v2`） */
export interface FavoritesFileV2 {
  schemaVersion: 2;
  updatedAt: number;
  /** 迁移来源标记（仅作审计） */
  migratedFrom?: "v1";
  /** 默认组合种子版本（幂等键，07 §1.4） */
  seedVersion?: number;
  combos: Combo[];
}

export const FAVORITES_KEY_V2 = "must.favorites.v2";
export const FAVORITES_SCHEMA_VERSION_V2 = 2 as const;
/** 组合上限（沿用 v1 的 200 量级） */
export const COMBO_CAP = 200;
/** 组合名上限（06 §3.2） */
export const COMBO_NAME_MAX = 24;

/** 组合默认名：`出发地 → 目的地`（06 §3.2；超长截断到 24 字） */
export function comboDefaultName(from: { label: string }, to: { label: string }): string {
  return `${from.label} → ${to.label}`.slice(0, COMBO_NAME_MAX);
}

/** 组合去重键：按 `query`（同一 OD 只应有一个组合，07 §1.2） */
export function comboDedupeKey(c: { query: string }): string {
  return `combo:${c.query}`;
}

/**
 * 规范化查询串（与 `parseNavParams().query` **逐字节一致**）—— 组合的 `query` 由此生成。
 * ★ 唯一真源：`StepSheet.queryOf` 已按同格式实现，S4/S5 统一改调本函数。
 * ⚠️ `chain/walk/tiers` **不进 query**（它们由 `combo-params` 的 `encodeComboParam` 单独拼）。
 */
export function comboQueryOf(from: FavoriteEndpoint, to: FavoriteEndpoint): string {
  const sp = new URLSearchParams({
    fromLng: String(from.lng),
    fromLat: String(from.lat),
    toLng: String(to.lng),
    toLat: String(to.lat),
    fromLabel: from.label,
    toLabel: to.label,
    fromKind: from.kind,
    toKind: to.kind,
  });
  if (from.code) sp.set("fromCode", from.code);
  if (to.code) sp.set("toCode", to.code);
  return sp.toString();
}
