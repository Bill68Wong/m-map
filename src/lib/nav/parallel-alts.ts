/**
 * 并行线「后续班次」候选生产者（src/lib/nav/parallel-alts.ts，v2.3.0 · B2/A3 · 07 §3.3）
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────
 *   一张卡的「后续班次」（`altBuses`）取自 `modelOption` 对**首段线路**的实时池
 *   （`ctx.live.get(first.route)`）。而「段内并行线」（同站上、同站下，如 `51/51A`）
 *   各有独立实时数据 ⇒ **并行线 B 的后续班次取不到**（B 未被建模）。
 *   ⇒ 本模块为**首段的每条并行线各造一个 sibling seed**，交由服务端一并建模，
 *     仅为「取其 `alts`」，**不参与排序 / 不单独出卡**。
 *
 * ⚠️ 纯函数（无 pg）：`segmentsOf` 从我们的站序索引解并行线自己的逐跳（与主干线不同）。
 */
import { segmentsOf } from "@/lib/recommend/enumerate";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { OptionSeed, RouteIndex } from "@/lib/recommend/types";

/** 一条并行线的 sibling seed（`route` = 该并行线线码） */
export interface SiblingSeed {
  route: string;
  seed: OptionSeed;
}

/**
 * 依「主干线首段的 `parallelRoutes`」造 sibling seeds。
 * @param opt       主干线的 `OptionSeed`（高德种子；其 `segments[0].parallelRoutes` 已由 `bridgeLeg` 填好）
 * @param routeIdx  站序索引（解并行线自身的逐跳 `segmentsOf(routeIdx, pr, board, alight)`）
 * @returns 每条**站序可解**的并行线一个 sibling；解不出逐跳的并行线跳过（宁少不误）
 */
export function siblingSeedsOf(opt: OptionSeed, routeIdx: RouteIndex): SiblingSeed[] {
  const first = opt.segments[0];
  if (!first) return [];
  const parallels = (first.parallelRoutes ?? []).filter((r) => !!r && r !== first.route);
  if (!parallels.length) return [];
  const allowed = [first.route, ...parallels];

  const out: SiblingSeed[] = [];
  for (const pr of parallels) {
    const seg = segmentsOf(routeIdx, pr, first.board, first.alight);
    if (!seg || !seg.segs.length) continue;
    const segments = [...opt.segments];
    // 首段换成并行线（逐跳由该线自身解出）；其余段原样
    segments[0] = {
      ...first,
      route: pr,
      hops: seg.segs,
      // 该 sibling 的并行集合 = 其余线（含主干线）——供其自身渲染/递归一致
      parallelRoutes: allowed.filter((r) => r !== pr),
    };
    const key = segments.map((s) => `${s.route}@${mainCodeOf(s.board)}>${mainCodeOf(s.alight)}`).join("|");
    out.push({ route: pr, seed: { ...opt, segments, key } });
  }
  return out;
}
