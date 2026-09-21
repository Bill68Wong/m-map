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

/* ── ★ v2.4.0：路线流程图结构（`ComboPlan.route`）───────────────────────
   为什么需要它：`PlanSnapshot.legs` 只是一串**纯文字**（`"51A 關北→科大"`），
   画不出「出发地 → 步行 → 上车站 → 线路 → 下车 → 步行 → 目的地」的纵向流程图
   （缺站码 / 站名 / 换乘落点 / 步行归属）。本结构 = 收藏那一刻的**分段结构快照**，
   与 `PlanSnapshot` 同源（都来自同一张卡），但保留可渲染的定位信息。

   ⚠️ 合规：**只存站码/站名/段类型**（派生值），**绝不存 polyline / 地图几何**（02 §2.3）。
   ⚠️ 兼容：老数据没有 `route` 字段 ⇒ 读取端必须容忍缺失（降级为「只有文字摘要」）。
   ────────────────────────────────────────────────────────────────────── */

/** 路线分段（流程图的一个节点） */
export interface RouteSeg {
  /** 段类型：步行（去站/离站）· 乘车 · 换乘（站内）· 通关（口岸，独立计时） */
  kind: "walk" | "ride" | "transfer" | "border";
  /** 站码（`walk`/`transfer` 为落点站；`border` 无） */
  code?: string;
  /** 站名 / 口岸名（展示用；繁体原文） */
  label?: string;
  /** `ride` 专用：线路码（单条；多条并行 ⇒ 用数组的第一条为主码） */
  route?: string;
  /** `ride` 专用：并行可选线路（同站上、同站下 ⇒ 渲染为 `51B/25AX`） */
  routes?: string[];
  /** `ride` 专用：上车站码 / 下车站码 */
  board?: string;
  alight?: string;
  /** `ride` 专用：上车站名 / 下车站名（展示） */
  boardLabel?: string;
  alightLabel?: string;
  /** `ride` 专用：坐几站（0 = 未知） */
  hops?: number;
  /** `walk` 专用：去程（出发地→上车站）还是离程（下车站→目的地） */
  phase?: "out" | "in";
  /** `walk` 专用：该段步行耗时（分钟；来源 = 实测/推算，见 `walkSrc`） */
  minutes?: number;
  /** `walk` 专用：取值来源（`measured` 实测 · `estimate` 推算） */
  walkSrc?: "measured" | "estimate";
}

/**
 * ★ v2.4.0：**路线级步行覆盖**（用户自定义步行耗时的存放处）。
 *
 * 语义（2026-09-21 拍板）：
 *   · 挂在**路线**上（不是组合），UI 位置 = **流程图旁**；
 *   · 但**按「步行起点 + 步行终点」共享** —— **同一组合内**，若路线 A 与路线 B
 *     有同一段「从 X 走到 Y」，改 A 的这段 ⇒ B 的这段一起变（07 §2.5 扩展）。
 *
 * 钥匙 = `walkKey(plan, seg)` = `组合内`：`${组合id}::${起点}->${终点}`
 *   —— 起点/终点取**站码**（`walk:out` = 出发地→上车站；`walk:in` = 下车站→目的地），
 *      出发地/目的地侧用 `PLACE:` 前缀 + place slug 表示（无站码）。
 */
export interface RouteWalkOv {
  /** 该段是否解锁联动（`false` = 距离与时长各自独立，同 `ComboWalkSeg.link`） */
  link?: boolean;
  /** 覆盖距离（米，0–20000） */
  distanceM?: number;
  /** 覆盖时长（分钟，0–180） */
  minutes?: number;
}

/**
 * 路线级覆盖集合。键 = `walkKey()` 产物（**组合内共享**，见上）。
 * ⚠️ 用对象而非数组：重复键天然合并（同段共享的实现基础）。
 */
export type RouteWalkOverrides = Record<string, RouteWalkOv>;

/** 组合下**已保存方案**（≈ v1 `PlanFavorite` 去 OD 化；指纹真源同 `planFingerprint`） */
export interface ComboPlan {
  id: string;
  /** 复用 `planFingerprint`（唯一真源） */
  fingerprint: string;
  /** 采集时快照（**只作离线/降级展示**，不作真值；含 `capturedAt` → 「保存于 MM-DD」） */
  snapshot: PlanSnapshot;
  /**
   * ★ v2.4.0：**路线流程图结构**（各分段：步行/乘车/换乘/通关）。
   * 缺省 = 老数据（无结构 ⇒ 流程图降级为文字摘要）。
   */
  route?: RouteSeg[];
  /**
   * ★ v2.4.0：**路线级步行覆盖**（钥匙见 `walkKey`；**同组合内同段共享**）。
   * 缺省 = 全部走系统默认（实测值 / 推算值）。
   */
  walkOv?: RouteWalkOverrides;
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
/**
 * ★ v2.4.0：**「已整理旧版组合」的一次性提示**传递键。
 *
 * 用途：`ComboSeeder` 清理掉旧版空壳组合后写入条数 → `FavoritesClient` 读到后
 * flash 一句提示并**立刻删除该键**（保证只提示一次）。
 * · 用 `sessionStorage` 而非 `localStorage` ⇒ 关掉标签页即失效，不会长期残留；
 * · 清除用户数据**必须可解释** ⇒ 这是「透明告知」的载体，不要删。
 */
export const PRUNE_NOTICE_KEY = "must.fav.pruneNotice";
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

/* ── ★ v2.4.0：路线级步行的**共享钥匙**（唯一真源）───────────────────────
   口径（2026-09-21 拍板）：**同一组合内**，只要「步行的起点 + 终点」相同，
   ⇒ 就是同一段 ⇒ 共用一份用户覆盖值（改 A 的，B 一起变）。

   钥匙构成 = `${组合 id}::${一端}->${另一端}`
     · 一端/另一端：优先**站码**（`walk:out` 的终点 = 上车站；
       `walk:in` 的起点 = 下车站）；出发地/目的地侧无站码 ⇒ 用 `PLACE:<slug>`。
     · ⚠️ **组合 id 必须进钥匙** —— 否则跨组合会误共享（拍板：只在同组合内共享）。

   ⚠️ 站台码归一：`C690/3` 与 `C690/2` 视为**不同**段（子台不同即不同步行终点），
      与「同主码不同子台」的展示合并逻辑区分开（展示可合并，步行不可混）。
   ────────────────────────────────────────────────────────────────────── */
export function walkKey(comboId: string, from: string, to: string): string {
  return `${comboId}::${from}->${to}`;
}

/** 步行段两端：`PLACE:<slug>` 前缀用于「出发地/目的地」（无站码） */
export function placeWalkEnd(slug: string): string {
  return `PLACE:${slug}`;
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
