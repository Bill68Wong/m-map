/**
 * 本地枚举 · 候选装配（src/lib/nav/enumerate-nav.ts，v1.3.0 提案 · T03 / G4）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   把 `graph-search` 的**站点级路径**装配成:
 *     · `NavCandidate`（含 from/to `NavPoint` + 复用旧 `RideSegment`/`TransferSegment`）；
 *     · `OptionSeed`（喂 `modelOption`，与旧链路**同一形状** → 计时口径零漂移）。
 *
 *   站码归一与共享口径全部复用 `src/lib/recommend/enumerate.ts` 的纯函数
 *   （`segmentsOf` / `idxsOf` / `deriveDirInMemory`）—— 不在本文件重写站序逻辑。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.5 / §B.6 / §4（NavCandidate）
 */
import type { RideSegment, TransferSegment } from "@/lib/recommend/types";
import type { OptionSeed, RouteIndex } from "@/lib/recommend/types";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import { segmentsOf } from "@/lib/recommend/enumerate";
import type { ChainStep } from "./combo-params";
import type { NavCandidate, NavPoint } from "./types";
import type { RidePath, StationPath } from "./graph-search";

/** 线路码 → 载具种类（我们库轻轨码统一 `LRT-` 前缀） */
export function kindOfRoute(route: string): "bus" | "lrt" {
  return route.startsWith("LRT-") ? "lrt" : "bus";
}

const candidateKey = (segments: RideSegment[]): string =>
  segments.map((s) => `${s.route}@${mainCodeOf(s.board)}>${mainCodeOf(s.alight)}`).join("|");

/** 站点级路径 → `NavCandidate[]` */
export function pathsToCandidates(
  paths: StationPath[],
  from: NavPoint,
  to: NavPoint,
): NavCandidate[] {
  const out: NavCandidate[] = [];
  for (const p of paths) {
    const segments: RideSegment[] = p.rides.map((r) => ({
      route: r.route,
      kind: kindOfRoute(r.route),
      board: r.board,
      alight: r.alight,
      hops: r.hops,
    }));
    if (!segments.length) continue;
    const transfers: TransferSegment[] = p.transfers.map((t, i) => {
      const a = segments[i];
      const b = segments[i + 1];
      const sameField =
        mainCodeOf(t.at) === mainCodeOf(t.to) && !a.alight.startsWith("LRT-") && !b.board.startsWith("LRT-");
      return { at: a.alight, to: b.board, sameField };
    });
    const key = candidateKey(segments);
    out.push({
      id: key,
      from,
      to,
      segments,
      transfers,
      crossBorder: false,
      key,
    });
  }
  // 去重（同一 key）
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
}

/** 中性展示文案（产品口径：不写「本地算法」，§B.5） */
/**
 * 本地补漏方案的**中性文案**（单一真源）。
 * ★ 修复包 v2.2.1-B3（08 §A.2 定稿）：`其他組合` → **`本地补充`**。
 *   理由：① 旧值含**繁体「組」**，违反「界面文案一律简体」；② 「其他」缺参照系；
 *   ③ 它是**来源标注**（provenance），与 POI 结果里的「来自高德」天然成对；只陈述事实、不做承诺。
 * ⚠️ 不得暴露「本地/自算/高德」以外的推断性描述，也不得写成营销式承诺。
 */
export const LOCAL_SUMMARY = "本地补充";

// ─────────────────── ★ v2.3.0：自定义站链 → 候选（07 §2.2）───────────────────

/** 单段并行线变体上限（防「段内多线」笛卡尔积膨胀） */
const MAX_VARIANTS_PER_SEG = 4;
/** 整链方案上限 */
const MAX_CHAIN_COMBOS = 12;

/** 该 `board→alight` 上所有能顺向解出站序的线路 */
function routesServing(routeIdx: RouteIndex, board: string, alight: string): string[] {
  const out: string[] = [];
  for (const route of routeIdx.dirsOf.keys()) {
    const seg = segmentsOf(routeIdx, route, board, alight);
    if (seg && seg.segs.length) out.push(route);
  }
  return out;
}

/**
 * 自定义站链 → `NavCandidate[]`（服务端 `/api/nav` 的 `chain` 参数）。
 *
 * 口径（07 §2.2 ①）：**段 = 用户指定 board/alight/routes** ——
 *   · 相邻两节点即一段（`chain[i] → chain[i+1]`）；
 *   · 该段线路 = `chain[i].routes`（若有）否则「所有能解出该段站序的线路」；
 *   · 段内多线各自成候选（D1 段内并行）；段与段之间做有界笛卡尔积。
 *
 * 返回的候选走**与本地枚举同一条** `pathsToCandidates` → `candidatesToSeeds`
 *   管线（口径唯一的硬约束：不新建并行计算器）。
 * 任一段无解 ⇒ 整链无解（返回 `[]` → 上层 `emptyReason='no_candidate'`）。
 */
export function chainToCandidates(
  chain: ChainStep[],
  routeIdx: RouteIndex,
  from: NavPoint,
  to: NavPoint,
): NavCandidate[] {
  if (chain.length < 2) return [];

  // ① 逐段解出「可乘线路 × 逐跳」
  const perSeg: RidePath[][] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const board = chain[i].code;
    const alight = chain[i + 1].code;
    if (!board || !alight) return [];
    const declared = (chain[i].routes ?? []).filter(Boolean);
    const routes = declared.length ? declared : routesServing(routeIdx, board, alight);
    const rides: RidePath[] = [];
    for (const route of routes) {
      const seg = segmentsOf(routeIdx, route, board, alight);
      if (!seg || !seg.segs.length) continue;
      rides.push({ route, board, alight, hops: seg.segs });
      if (rides.length >= MAX_VARIANTS_PER_SEG) break;
    }
    if (!rides.length) return [];
    perSeg.push(rides);
  }

  // ② 段间有界笛卡尔积
  let combos: RidePath[][] = [[]];
  for (const rides of perSeg) {
    const next: RidePath[][] = [];
    outer: for (const combo of combos) {
      for (const r of rides) {
        next.push([...combo, r]);
        if (next.length >= MAX_CHAIN_COMBOS) break outer;
      }
    }
    combos = next;
    if (!combos.length) return [];
  }

  // ③ 换乘节点 = 链的中间节点（相邻两段共用同一站台码 → sameField）
  const transferNodes = chain.slice(1, -1);
  const paths: StationPath[] = combos.map((rides) => ({
    rides,
    transfers: transferNodes.map((s) => ({ at: s.code ?? "", to: s.code ?? "" })),
  }));
  return pathsToCandidates(paths, from, to);
}

/**
 * `NavCandidate[]` → `OptionSeed[]`（喂 `modelOption`）。
 * @param planIdBase 合成 planId 起点（避免与高德方案撞号；本地用 ≥900000）
 * @param fromSlug/toSlug 合成 slug（`model.ts` 用不到真实 slug —— 步行由 `walkIdx` 提供）
 */
export function candidatesToSeeds(
  candidates: NavCandidate[],
  opts: { planIdBase?: number; fromSlug?: string; toSlug?: string } = {},
): OptionSeed[] {
  const base = opts.planIdBase ?? 900_000;
  const fromSlug = opts.fromSlug ?? "from";
  const toSlug = opts.toSlug ?? "to";
  return candidates.map((c, i) => ({
    planId: base + i,
    summary: LOCAL_SUMMARY,
    fromSlug,
    toSlug,
    crossBorder: c.crossBorder,
    segments: c.segments,
    transfers: c.transfers,
    key: c.key,
  }));
}
