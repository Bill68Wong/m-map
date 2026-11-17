/**
 * 站码映射（src/lib/nav/map-stations.ts，v1.3.0 提案 · T03）
 *
 * ── 职责（设计 §B.3a / §C.4）───────────────────────────────────────────
 *   ① 载入 `station_amap_map`（**人工确认优先**：`verified_by_human=true` 优先，其次置信度）；
 *   ② 把高德方案里的「高德站 + 高德线路名」**桥接**成我们的**主码 + 线路码 + 逐跳站序**；
 *   ③ 过滤：穿梭巴士（黑名单）/ 轻轨在建线（ES1–ES6）；
 *   ④ 判定「是否整方案乘车段全映射失败」（是 → 剔除该方案，§C.4）。
 *
 * ── 两个索引与两个网 ─────────────────────────────────────────────────
 *   · **站映射**：`station_amap_map`（高德站 id / 高德简体名 → 我们主码）。
 *     高德站名是**简体**、我们库是**繁体** ⇒ 桥接用 `normalizeName()` 繁简归一。
 *   · **线路映射**：高德**没有**线路映射表 ⇒ 本文件按规则从线路名推导
 *     （巴士：「30X路(…)」→ 取「路」前并大写 → 校验在我们线路集合内；
 *      轻轨：「氹仔线(…)」→ `LRT-氹仔线`）；推导不出或不在集合内 → 该腿**未映射**（回落高德时长）。
 *
 * ── 逐跳站序从哪来 ────────────────────────────────────────────────────
 *   ★ **不是**高德的 `via_stops`（那是高德站，无法直接给 `lookupHop` 用），
 *   而是用**我们的**站序索引 `segmentsOf(routeIdx, route, boardMain, alightMain)` 解出
 *   ⇒ 保证与旧版 `rideOfHops` 同口径（`segment_stats` 逐跳）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.2 / §B.3a / §B.3b·c / §C.4
 */
import type { Pool } from "pg";
import { isShuttleBus, isUnderConstruction } from "@/lib/amap/transit";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RouteIndex } from "@/lib/recommend/types";
import { segmentsOf } from "@/lib/recommend/enumerate";
import { normalizeName } from "@/lib/shared/normalize";
import { anchorMainFor } from "./anchor";
import { routesServing } from "./enumerate-nav";
import { makeMeasure, mergeParallels, pickExtraParallels } from "./parallel-pick";
import type { AmapPlanLeg, AmapStop, StationConfidence } from "./types";
import type { GeoStation } from "./graph-search";

// ─────────────────────────── 站映射 ───────────────────────────

export interface StationMapping {
  main: string;
  nameTc: string;
  verified: boolean;
  confidence: StationConfidence;
}

export interface StationMap {
  /** 高德站 id → 映射 */
  byId: Map<string, StationMapping>;
  /** 归一化高德站名（简体去噪）→ 映射 */
  byName: Map<string, StationMapping>;
  /** 主码 → 我们站名（繁体，展示用） */
  nameTcOfMain: Map<string, string>;
  /** 行数（诊断） */
  size: number;
}

/**
 * 载入映射表（★ 人工确认优先：`verified_by_human DESC, confidence DESC`）。
 * 同一高德站若有多行，**先到者胜**（已排序 ⇒ 即「最可信的那行」）。
 */
export async function loadStationMap(pool: Pool): Promise<StationMap> {
  const byId = new Map<string, StationMapping>();
  const byName = new Map<string, StationMapping>();
  const nameTcOfMain = new Map<string, string>();
  const res = await pool.query(
    `SELECT amap_station_id, amap_name, dsat_station_main, name_tc, verified_by_human, confidence
       FROM station_amap_map
      WHERE dsat_station_main IS NOT NULL
      ORDER BY verified_by_human DESC,
               CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END ASC,
               id ASC`,
  );
  for (const r of res.rows as Record<string, unknown>[]) {
    const main = String(r.dsat_station_main);
    const conf = String(r.confidence ?? "low") as StationConfidence;
    const m: StationMapping = {
      main,
      nameTc: String(r.name_tc ?? ""),
      verified: r.verified_by_human === true,
      confidence: conf,
    };
    const id = r.amap_station_id ? String(r.amap_station_id) : "";
    if (id && !byId.has(id)) byId.set(id, m);
    const nm = normalizeName(String(r.amap_name ?? ""));
    if (nm && !byName.has(nm)) byName.set(nm, m);
    if (m.nameTc && !nameTcOfMain.has(main)) nameTcOfMain.set(main, m.nameTc);
  }
  return { byId, byName, nameTcOfMain, size: byId.size };
}

/** 高德站（可带 id）→ 我们主码；映射不到返回 null */
export function bridgeStop(map: StationMap, stop: { id?: string; name?: string }): string | null {
  return bridgeStopMeta(map, stop)?.main ?? null;
}

/** 高德站（可带 id）→ 映射**行**（含 `verified`/`confidence`）；用于 §3.7 二次加固判「是否人工确认」 */
export function bridgeStopMeta(map: StationMap, stop: { id?: string; name?: string }): StationMapping | null {
  if (stop.id && map.byId.has(stop.id)) return map.byId.get(stop.id)!;
  const nm = normalizeName(stop.name ?? "");
  if (nm && map.byName.has(nm)) return map.byName.get(nm)!;
  return null;
}

// ─────────────────────────── 线路映射 ───────────────────────────

/** 高德线路名 → 我们线路码（推导不出或不在集合内 → null） */
export function routeCodeOf(name: string, kind: "bus" | "lrt", valid: Set<string>): string | null {
  if (kind === "lrt") {
    if (/氹仔[线線]/.test(name) && valid.has("LRT-氹仔线")) return "LRT-氹仔线";
    if (/石排[湾灣]/.test(name) && valid.has("LRT-石排湾线")) return "LRT-石排湾线";
    if (/[横橫]琴/.test(name) && valid.has("LRT-横琴线")) return "LRT-横琴线";
    return null;
  }
  // 巴士：'30X路(关闸广场--关闸广场)' → '30X'
  const head = name.split(/[(（]/)[0].trim();
  const cand = head.replace(/路$/, "").replace(/\s+/g, "").toUpperCase();
  if (!cand) return null;
  if (valid.has(cand)) return cand;
  // 少数线路名带前后缀（如 'N2路' 已覆盖）；再试去零宽字符
  const alt = cand.replace(/[\u200b-\u200d\ufeff]/g, "");
  return valid.has(alt) ? alt : null;
}

// ─────────────────────────── 过滤（§B.3b·c） ───────────────────────────

/** 是否含在建轻轨站（ES1–ES6；本库没有、绝不推荐） */
function hasUnderConstructionStop(leg: AmapPlanLeg): boolean {
  if (isUnderConstruction(leg.amapLineName)) return true;
  return leg.amapViaStops.some((s) => /\bES[1-6]\b/i.test(s.name));
}

/**
 * 方案是否应被**过滤掉**（穿梭巴士 / 在建轻轨）。
 * ⚠️ 只需求内任一腿命中即剔整方案 —— 因为这类方案在澳门无意义（赌场免费巴）、
 *    或含本库没有的在建站（无法逐跳重算、且不该推荐）。
 */
export function planFilterReason(legs: AmapPlanLeg[]): string | null {
  for (const leg of legs) {
    if (leg.kind === "bus" && isShuttleBus(leg.amapLineName)) return `shuttle:${leg.amapLineName}`;
    if (leg.kind === "lrt" && hasUnderConstructionStop(leg)) return `under_construction:${leg.amapLineName}`;
    if (leg.kind === "bus" && hasUnderConstructionStop(leg)) return `under_construction:${leg.amapLineName}`;
  }
  return null;
}

// ─────────────────────────── 桥接 ───────────────────────────

export interface BridgeContext {
  map: StationMap;
  validRoutes: Set<string>;
  routeIdx: RouteIndex;
  /** ★ v2.3.0：站点地理（WGS84，`loadStationGeoCached()`）—— 供 §3.7 同名站二次加固 */
  geo: GeoStation[];
}

/** 主码与载具种类是否一致（轻轨码统一 `LRT-` 前缀）——防止「LRT 站误配到巴士站码」
 *
 * ★ **待人工复核的具体行**（T01 自动映射产物；产品按此 SQL 逐行确认）：
 * ```sql
 * -- (1) 高德侧写着「地铁站/轻轨站」、却被映射到【非 LRT-】站码的行（= 本护栏兜的那类错配）
 * SELECT id, amap_station_id, amap_name, dsat_station_main, name_tc, match_dist_m, confidence
 *   FROM station_amap_map
 *  WHERE (amap_name LIKE '%地铁站%' OR amap_name LIKE '%轻轨站%' OR amap_name LIKE '%輕軌站%')
 *    AND (dsat_station_main IS NULL OR dsat_station_main NOT LIKE 'LRT-%')
 *  ORDER BY confidence, match_dist_m;
 *
 * -- (2) 我们库的 LRT 站，是否都已被高德站正确映射（应尽量命中 LRT- 站码）
 * SELECT s.code AS our_lrt, s.name_tc, m.amap_name, m.dsat_station_main,
 *        m.match_method, m.match_dist_m, m.confidence, m.verified_by_human
 *   FROM stations s
 *   LEFT JOIN station_amap_map m ON m.dsat_station_main = s.code
 *  WHERE s.kind = 'lrt'
 *  ORDER BY (m.dsat_station_main IS NULL), s.code;
 * ```
 * 复核后在 CSV 填 `我们站码` 并清空「待人工确认」，跑 `db:apply-amap-map` 回写。
 */
function mainKindOk(code: string, kind: "bus" | "lrt"): boolean {
  const isLrt = code.startsWith("LRT-");
  return kind === "lrt" ? isLrt : !isLrt;
}

/** 桥接一腿（就地返回新对象；映射失败时 mapped* 为 null） */
export function bridgeLeg(ctx: BridgeContext, leg: AmapPlanLeg): AmapPlanLeg {
  const mappedRoute = routeCodeOf(leg.amapLineName, leg.kind, ctx.validRoutes);
  // ★ 2026-09-27（实测修复「石排湾线重复变体」）：**上车站**补「同名站锚定」兜底，与 alight 对称——
  //   轻轨站**不在 `station_amap_map`**（该表仅巴士）⇒ 高德轻轨腿的 board 曾整段映射失败
  //   （实测：石排湾线腿 board 保留简体名「石排湾」+ 回落 Amap 时长 4 分 + 「上車站」占位泄漏，
  //    与本地枚举的站码级卡重复并存）。人工确认行仍优先；未命中/未人工确认 → `anchorMainFor`
  //   （L1/L2 同名 + L3 距离闸门 + 种类过滤；geo 含全站、normalizeName 繁简归一）。
  const metaBoard = bridgeStopMeta(ctx.map, leg.amapBoard);
  let mappedBoard = metaBoard?.main ?? null;
  if (!metaBoard || !metaBoard.verified) {
    const hitBoard = anchorMainFor(
      { label: leg.amapBoard.name, lng: leg.amapBoard.lng, lat: leg.amapBoard.lat },
      ctx.geo,
      ctx.routeIdx,
      leg.kind,
    );
    if (hitBoard) mappedBoard = hitBoard.main;
  }
  // ★ v2.3.0（07 §3.7-3 二次加固）：**下车锚站**优先取「同名站」（L1/L2 + L3 距离闸门）。
  //   ⚠️ 仅当映射来自**自动**（未人工确认）或未映射时才覆盖 —— **人工确认行优先**，
  //      绝不推翻 `station_amap_map` 的 curated 映射（防回归）。
  const metaAlight = bridgeStopMeta(ctx.map, leg.amapAlight);
  let mappedAlight = metaAlight?.main ?? null;
  if (!metaAlight || !metaAlight.verified) {
    const hit = anchorMainFor(
      { label: leg.amapAlight.name, lng: leg.amapAlight.lng, lat: leg.amapAlight.lat },
      ctx.geo,
      ctx.routeIdx,
      leg.kind,
    );
    if (hit) mappedAlight = hit.main;
  }
  // ★ 种类一致性护栏：LRT 腿必须映到 `LRT-` 站、巴士腿必须映到非 LRT 站
  //   （实测：T01 自动映射把高德轻轨站最近邻到了 60m 内的巴士站 C651 ⇒ 若放行，
  //     `segmentsOf` 解不出逐跳 + 上下车站标签错 ⇒ 宁可判「未映射」回落高德时长）
  if (mappedBoard && !mainKindOk(mappedBoard, leg.kind)) mappedBoard = null;
  if (mappedAlight && !mainKindOk(mappedAlight, leg.kind)) mappedAlight = null;

  let mappedHops: [string, string][] | null = null;
  if (mappedRoute && mappedBoard && mappedAlight && mainCodeOf(mappedBoard) !== mainCodeOf(mappedAlight)) {
    const seg = segmentsOf(ctx.routeIdx, mappedRoute, mappedBoard, mappedAlight);
    if (seg && seg.segs.length) mappedHops = seg.segs;
  }

  // ★ v2.3.0（B2）：同段并行线 —— 其余高德线路名 → 本库线码（**必须 `valid.has` 才认**）；
  //   去重、剔除主干线自身；映射不出（null）则不填（宁少不误）。
  const declaredParallels = dedupe(
    (leg.parallelNames ?? [])
      .map((n) => routeCodeOf(n, leg.kind, ctx.validRoutes))
      .filter((c): c is string => !!c),
  ).filter((c) => c !== mappedRoute);

  /**
   * ★ R2（2026-11-17）：**反查补漏** —— 用我们自己的站序索引补上「高德没给、但确实同段」的线。
   *
   * 为什么需要：`parallelNames` 是高德 `buslines[1..]` 的**唯一**入口，而实测 79.0% 的方案
   * 首段只有 1 条线（`transit_cache` 985 条响应 / 5074 个方案）⇒ 并行线常年为空
   * ⇒ `siblingSeedsOf` 不造 sibling ⇒ 「后续班车」只剩推荐线。
   *
   * 判据**全部**在 `nav/parallel-pick.ts`（纯函数，单测在那里守）；本处只做三件事：
   *   ① 把「反查候选」和「实测事实」喂进去；② 合并；③ 什么都不满足时**原样返回**。
   *   ⛔ 不要在这里加任何阈值/过滤 —— 散一条出去，单测就只能守半个判据。
   *
   * 只做加法：`declaredParallels`（高德原名单）内容与顺序逐字不动（`mergeParallels` 保证）。
   * 无里程数据 ⇒ `pickExtraParallels` 判 `main_unmeasurable` ⇒ `extra` 为空 ⇒ 走下面的
   * `: declaredParallels` 分支，**逐字节等价于改前**。
   */
  const extraParallels = pickExtraForSegment(ctx, mappedRoute, mappedBoard, mappedAlight, declaredParallels);
  const parallelRoutes = extraParallels.length
    ? mergeParallels(declaredParallels, extraParallels)
    : declaredParallels;

  return { ...leg, mappedRoute, mappedBoard, mappedAlight, mappedHops, parallelRoutes };
}

/**
 * R2：降级告警的**进程级**一次性开关（见 `pickExtraForSegment`）。
 *
 * 放模块作用域而不是请求作用域，正是为了「每个进程只打一次」：
 * Vercel 每个 Serverless 实例冷启动各打一次 ⇒ 日志条数 = 实例数，不随请求量增长。
 */
let warnedNoMileage = false;

/**
 * R2：反查候选 → 收口判据 → 待追加名单。
 *
 * ⚠️ **本函数不允许长判据**：它只做装配（取候选、注入事实、返回 `picked`）。
 *    任何 `if (ratio > …)` / `if (hops > …)` 都必须住在 `parallel-pick.ts`。
 */
function pickExtraForSegment(
  ctx: BridgeContext,
  mappedRoute: string | null,
  mappedBoard: string | null,
  mappedAlight: string | null,
  declared: string[],
): string[] {
  if (!mappedRoute || !mappedBoard || !mappedAlight) return [];
  if (mainCodeOf(mappedBoard) === mainCodeOf(mappedAlight)) return [];
  /**
   * ★ R2（2026-11-17 · team-lead 要求）：**里程缺失时打一次进程级告警**。
   *
   * 为什么必须有：没有 `route_mileage` 就一条都不会新增，而**线上表现与改前逐字相同**
   * ⇒ 这是 fail-safe，也是**静默空转**。「上线了但等于没上线、且没有任何痕迹」不可接受。
   * Vercel 日志里**看得见这一行** = 它没在工作；**看不见** = 它在工作。
   *
   * 约束（改动前先读）：
   *   · **进程级只打一次**（模块级 `warnedNoMileage`）—— 一次导航有多个方案、多腿，不许刷屏；
   *   · **不改任何响应结构、不动 `NavStats`**（新观测面不在 R2 范围）；
   *   · 早退返回 `[]` 与「跑一遍判据后得空」**观测结果完全相同**（后者见
   *     `parallel-pick` 的 `main_unmeasurable` 分支，`test:parallel-pick` 有断言），
   *     早退只是顺手省掉一次全库反查。
   */
  if (!ctx.routeIdx.hopMeters?.size) {
    if (!warnedNoMileage) {
      warnedNoMileage = true;
      console.warn(
        "[parallel] hopMeters 为空 ⇒ 并行线补漏整体降级（不新增）；请检查 db:station-mileage 是否已跑",
      );
    }
    return [];
  }
  const candidates = routesServing(ctx.routeIdx, mappedBoard, mappedAlight, memoOf(ctx.routeIdx));
  const { picked } = pickExtraParallels(
    { mainRoute: mappedRoute, declared, candidates },
    makeMeasure(ctx.routeIdx, mappedBoard, mappedAlight),
  );
  return picked;
}


/**
 * R2：**请求内**反查记忆（`board|alight → 线路集合`）。
 *
 * 为什么可以挂在 `RouteIndex` 上（而不是每次请求新建）：`routesServing` 的返回值是**索引的
 * 纯函数** —— 索引不变则值恒不变，缓存它不引入任何随请求变化的状态，也不会串请求。
 * 上限 4096 条后整体清空（最坏退化为无缓存），避免长尾站点把 Map 撑大。
 */
const servingMemo = new WeakMap<RouteIndex, Map<string, string[]>>();
function memoOf(idx: RouteIndex): Map<string, string[]> {
  let m = servingMemo.get(idx);
  if (!m) {
    m = new Map();
    servingMemo.set(idx, m);
  } else if (m.size > 4096) {
    m.clear();
  }
  return m;
}

/** 去重（保序） */
function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

/** 该腿是否「可用我们的数据重算」（三要素齐 + 逐跳可解） */
export function legIsMapped(leg: AmapPlanLeg): boolean {
  return !!(leg.mappedRoute && leg.mappedBoard && leg.mappedAlight && leg.mappedHops && leg.mappedHops.length);
}

/** ★ §C.4：整方案乘车段**全部**映射失败 → 剔除该方案 */
export function planFullyUnmapped(legs: AmapPlanLeg[]): boolean {
  return legs.length > 0 && legs.every((l) => !legIsMapped(l));
}

/** 高德站 id 从 `AmapStop` 未携带（解析层未取 id）—— 名称兜底已足够；此函数保留以备将来扩展 */
export function stopLabel(stop: AmapStop): string {
  return stop.name;
}
