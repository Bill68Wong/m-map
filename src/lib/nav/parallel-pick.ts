/**
 * 段内并行线「反查补漏」收口判据（src/lib/nav/parallel-pick.ts，R2 · 2026-11-17）
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────
 *   段内并行线名单此前**100% 来自高德** `leg.parallelNames`
 *   （`amap/transit.ts:284-289` 取 `segments[i].bus.buslines[1..]`），没有第二条路。
 *   实测（`transit_cache` 985 条真实响应 / 5074 个方案）：**79.0% 的方案首段只有 1 条线**
 *   ⇒ `parallelRoutes = []` ⇒ `siblingSeedsOf`（`parallel-alts.ts:32`）不造 sibling
 *   ⇒ `backfillAltBuses`（`nav-service.ts:949`）的 `for (const pr of ...)` 一圈都不跑
 *   ⇒ 界面「后续班车」只剩推荐线。
 *   更糟的是**高德自身不稳定**：同一 OD 相隔 15 分钟，首段并行线从 5 条掉到 1 条
 *   （`113.5642,22.1272|113.5504,22.1375`，13:00 vs 13:15）；90 个跨时刻 OD 里 22 个波动。
 *
 * ── 价值主张（**不要**按「更多条」卖）────────────────────────────────────
 *   目标不是「把后续班车变多」，而是「**名单可复现、不随高德抽风**」。
 *   最硬的证据：`T300→T330` 高德自己给了 `50`（当时 `closed`），却漏了同样 `closed` 的
 *   `50B`/`MT5` —— 高德名单本身不自洽。
 *   ⇒ 验收口径 = **同一 OD 在相同时段重复请求，候选名单必须一致**；条数不作验收指标
 *     （条数本就随日类型漂：早高峰覆盖 `mon_fri` 7 条 / `sat` 5 / `sun_holiday` 4）。
 *
 * ── 为什么必须设门槛（不加会拉进什么）──────────────────────────────────
 *   「两站都被该线经过」是**必要不充分**条件：环线上两站可以相邻却「绕完整个半岛」。
 *   全库实测（`n=11675` 个「OD × 候选线」对）绕路度 d× = 候选线里程 ÷ 推荐线里程：
 *     `p50=1.00 / p75=1.23 / p90=1.85 / p95=2.45 / p99=5.81 / max=210.82`
 *   尾部样本（>1.3 的 2578 条里最离谱的）：
 *     `M263 仙德麗街 → M69 葡京酒店  39 号  d×=210.82  里程=11595m`
 *     `T408/T409 湖畔大廈 → 湖畔公園  56 号  d×=170.51  里程=16539m`
 *     `M219 → M235（東北大馬路）      AP1  d×=83.67   里程=20918m`
 *   把它们列进「后续班车」= 明确误导。**门槛不是可选项。**
 *
 * ── `d×` 的分子分母口径（**换口径就会得到荒谬值，见下**）────────────────
 *   分子 = 候选线在该 OD 段的沿线里程；分母 = 推荐线（高德 `mappedRoute`）同段里程。
 *   两者都 = **`route_station_mileage` 逐跳求和**（与 `recommend/query.ts` 里
 *   `rows.hopDist` 同源；该表由 `scripts/build-station-mileage.ts` 构建，构建时做了
 *   「站序单调贪心」消歧，专治「往返合一几何上同一物理站出现两次」）。
 *
 *   ⛔ **反面证据（踩过，别再踩）**：曾改用「把站点投影到 `route_shapes` 折线的**最近顶点**」
 *     算里程 —— 环线会**跨圈误配**（同一物理站在折线上出现两次，最近顶点可能落在另一圈）：
 *     实测 `50`/`50B`/`N3` 投影误差 2.6~3.1 km、`M1→T330` 达 **5.8 km**，
 *     算出 `M1→T330: 25B d×=49.08` 这种荒谬值（真实 `d×=1.09`）。
 *     **只要看到 d× 上百，先怀疑投影口径，不要怀疑数据。**
 *
 * ── 门槛取值：N = 1.3（下界有论证，不是拍的）───────────────────────────
 *   下界：**高德自己给过的最大 d× = 1.29**（`T300→T330` 的 11/22/25/25B/26A/50/MT1 全为 1.29；
 *        `M139→M184` 的 6B = 1.26）。若取 N < 1.3，就会出现
 *        「高德列的算并行线、我们补的同样里程却不算」的自相矛盾。
 *   上界：N=1.5 只比 1.3 多放行 6.3% 的样本，且已进入 p90(1.85) 之后 ⇒ 不值得。
 *   代价（实测）：N=1.3 下每条 OD 平均保留 2.15 条线、23% 的 OD 有 ≥3 条。
 *
 * ── 纯函数边界（**收口判据全住在这里，不许散到调用点**）────────────────
 *   本文件：无 DB、无时钟、无 `pg`、无环境变量、无模块级可变状态。
 *   外部事实（该线该段几跳、几米）由 `MeasureFn` 注入 ⇒ 单测可穷举边界。
 *   ⚠️ 若把任何一条判据挪到 `map-stations.ts` 的调用点，单测就只能守半个判据，
 *      剩下那半个永远没人守 —— 这是本文件存在的唯一理由。
 */
import { segmentsOf } from "@/lib/recommend/enumerate";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RouteIndex } from "@/lib/recommend/types";

/** 判据 ①：候选线里程 / 推荐线里程 的上限（含）。取值见文件头「门槛取值」 */
export const PARALLEL_MAX_RATIO = 1.3;
/** 判据 ②：候选线跳数 − 推荐线跳数 的上限（含）。兼作「里程口径异常时的方向性兜底」 */
export const PARALLEL_HOP_SLACK = 2;
/** 判据 ④：每段最多**新增**几条（不含高德原名单）。CPU 理由：每条并行线多一次 `modelOption` */
export const PARALLEL_MAX_ADD = 2;

/**
 * 浮点容差：`d×` 恰好 1.30 必须算「含」。
 * 判定一律写 `ratio <= maxRatio + RATIO_EPS`，不要写 `ratio < maxRatio`：
 * 里程是整数米，商可能落在 1.3000000000000003 这种位置。
 */
const RATIO_EPS = 1e-9;

/** 某条线在某段上的可测事实 */
export interface SegmentFacts {
  /** 该线在该 `board→alight` 上顺向解出的跳数 */
  hops: number;
  /** 沿线里程（米）；`null` = 里程数据缺失（**不是 0**，0 会被误当「同站」） */
  meters: number | null;
}

/** 取外部事实的注入点：生产实现 `makeMeasure()`；单测注入固定值 */
export type MeasureFn = (route: string) => SegmentFacts | null;

export interface PickArgs {
  /** 推荐线（高德给的主线本库线码）。它自己永远不会被「新增」 */
  mainRoute: string;
  /** **高德已给**的并行线（本库线码，保序）。只做加法，一条不动、顺序不改 */
  declared: readonly string[];
  /** 反查得到的候选线（本库线码，可含 `mainRoute` 与 `declared`；本函数自行剔） */
  candidates: readonly string[];
}

export interface PickOpts {
  maxRatio?: number;
  hopSlack?: number;
  maxAdd?: number;
}

/** 拒因（供诊断与单测；不进 UI） */
export type RejectReason =
  /** 该线解不出这段（不同方向 / 不经过） */
  | "no_segment"
  /** 里程数据缺失（判据 ③：宁少不误） */
  | "no_mileage"
  /** 判据 ①：绕路 */
  | "detour"
  /** 判据 ②：跳数超限 */
  | "too_many_hops"
  /** 高德已给（不重复添加） */
  | "already_declared"
  /** 判据 ④：排序后超出 `maxAdd` */
  | "overflow"
  /** 推荐线自身测不出来 ⇒ 整段不新增（无分母，任何比值都无意义） */
  | "main_unmeasurable";

export interface PickResult {
  /** 待**追加**在高德原名单之后的线（已按 d× 升序；调用方用 `mergeParallels` 合并） */
  picked: string[];
  /** 按候选出现顺序输出（`overflow` 按 d× 升序在后） */
  rejected: { route: string; reason: RejectReason }[];
}

/**
 * 从反查候选里挑出「可以补进并行线名单」的线。
 *
 * 判据顺序（**顺序即语义**，改顺序会改变拒因归属）：
 *   0. `mainRoute` 自身 ⇒ 跳过（不进 `rejected`，它不是候选）
 *   1. 已在 `declared` 里 ⇒ `already_declared`（不重复添加，也不改原顺序）
 *   2. 测不出该段 ⇒ `no_segment`；里程为 `null` ⇒ `no_mileage`（判据 ③）
 *   3. 跳数 > 推荐线跳数 + `hopSlack` ⇒ `too_many_hops`（判据 ②）
 *   4. `d×` > `maxRatio` ⇒ `detour`（判据 ①）
 *   5. 幸存者按 (d× 升序, 线码码位序) 排序后取前 `maxAdd` 条，其余 ⇒ `overflow`（判据 ④）
 *
 * 秩相等时按**线码码位序**（`<`/`>`，不用 `localeCompare`）⇒ 跨环境确定，
 * 保证「同一输入重复调用结果逐字相同」（验收要的「可复现」）。
 *
 * 推荐线测不出来（`no_segment` / 里程 `null`）⇒ **一条都不新增**，全部记 `main_unmeasurable`。
 * 理由：没有分母就没有 d×，任何「大概差不多」的替代口径都会退化成文件头那个 d×=49 的坑。
 *
 * @param measure 注入外部事实（须是纯函数：同一 route 恒返回同一值，否则本函数不确定）
 */
export function pickExtraParallels(args: PickArgs, measure: MeasureFn, opts: PickOpts = {}): PickResult {
  const maxRatio = opts.maxRatio ?? PARALLEL_MAX_RATIO;
  const hopSlack = opts.hopSlack ?? PARALLEL_HOP_SLACK;
  const maxAdd = Math.max(0, opts.maxAdd ?? PARALLEL_MAX_ADD);
  const declaredSet = new Set(args.declared);

  const main = measure(args.mainRoute);
  const mainOk = !!main && main.meters !== null && main.meters > 0;

  const rejected: { route: string; reason: RejectReason }[] = [];
  const considered: string[] = [];
  const seen = new Set<string>();
  for (const r of args.candidates) {
    if (!r || r === args.mainRoute) continue;
    if (declaredSet.has(r)) {
      if (!seen.has(r)) {
        seen.add(r);
        rejected.push({ route: r, reason: "already_declared" });
      }
      continue;
    }
    if (seen.has(r)) continue;
    seen.add(r);
    considered.push(r);
  }

  if (!mainOk) {
    return {
      picked: [],
      rejected: [...rejected, ...considered.map((route) => ({ route, reason: "main_unmeasurable" as const }))],
    };
  }
  const mainMeters = main!.meters as number;
  const mainHops = main!.hops;

  const pass: { route: string; ratio: number }[] = [];
  for (const route of considered) {
    const f = measure(route);
    if (!f) {
      rejected.push({ route, reason: "no_segment" });
      continue;
    }
    // 判据 ③：里程缺失不新增（不做任何替代估算）
    if (f.meters === null || f.meters <= 0) {
      rejected.push({ route, reason: "no_mileage" });
      continue;
    }
    // 判据 ②
    if (f.hops > mainHops + hopSlack) {
      rejected.push({ route, reason: "too_many_hops" });
      continue;
    }
    // 判据 ①
    const ratio = f.meters / mainMeters;
    if (ratio > maxRatio + RATIO_EPS) {
      rejected.push({ route, reason: "detour" });
      continue;
    }
    pass.push({ route, ratio });
  }

  // 判据 ④：确定性排序后截断
  pass.sort((a, b) => {
    const d = a.ratio - b.ratio;
    if (d !== 0) return d;
    return a.route < b.route ? -1 : a.route > b.route ? 1 : 0;
  });
  const picked = pass.slice(0, maxAdd).map((p) => p.route);
  for (const p of pass.slice(maxAdd)) rejected.push({ route: p.route, reason: "overflow" });

  return { picked, rejected };
}

/**
 * 判据 ⑤：**只做加法**的合并。
 *
 * `declared`（高德原名单）**逐字保留**：内容、顺序、重复项都不动 —— 这是「高德已给的一条不动」
 * 的机器化表达。`extra` 里已在 `declared` 中的跳过，`extra` 内部也去重（保序）。
 *
 * ⚠️ 不要把这里写成 `dedupe([...declared, ...extra])`：那样会顺手把高德自己给的重复项
 *    也去掉，属于「改了高德原名单」，与判据 ⑤ 冲突（且会让「名单可复现」的比对基线漂移）。
 */
export function mergeParallels(declared: readonly string[], extra: readonly string[]): string[] {
  if (!extra.length) return [...declared];
  const have = new Set(declared);
  const out = [...declared];
  for (const r of extra) {
    if (!r || have.has(r)) continue;
    have.add(r);
    out.push(r);
  }
  return out;
}

/**
 * 生产用的事实提供者：从 `RouteIndex` 组装 `MeasureFn`。
 *
 * 放在本文件而不是 `map-stations.ts`，是为了让「几跳 + 几米」的口径与判据待在一处；
 * `map-stations` 只负责给 `board/alight` 与索引。
 *
 * ⚠️ 方向择优复用 `segmentsOf`（跨方向取**跳数最多**者），不另写第二套：
 *    实测 63 个真实候选逐条对照「最少跳数」方向，**0/63 不一致**（63 = 7 组真实 OD 的
 *    全部反查候选）⇒ 不需要第二个方向解，`segmentsOf` 就是唯一口径。
 *
 * `hopMeters` 为空（库未跑 `db:station-mileage`，或手工夹具索引）⇒ 恒返回 `null`
 * ⇒ 判据 ③ 让整段不新增。**这是有意的降级**：宁可一条都不补，也不用别的口径硬算。
 */
export function makeMeasure(routeIdx: RouteIndex, board: string, alight: string): MeasureFn {
  const hopMeters = routeIdx.hopMeters;
  return (route: string): SegmentFacts | null => {
    if (!hopMeters || !hopMeters.size) return null;
    const seg = segmentsOf(routeIdx, route, board, alight);
    if (!seg || !seg.segs.length) return null;
    let meters = 0;
    for (const [f, t] of seg.segs) {
      const m = hopMeters.get(`${route}|${mainCodeOf(f)}|${mainCodeOf(t)}`);
      if (m === undefined) return { hops: seg.segs.length, meters: null };
      meters += m;
    }
    return { hops: seg.segs.length, meters };
  };
}
