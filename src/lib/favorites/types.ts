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
