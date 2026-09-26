/**
 * 重排序（src/lib/nav/rank.ts，v1.3.0 提案 · T03）
 *
 * ── 排序判据（设计 §C.6，产品要求「更快的排上面」）────────────────────
 *   主判据：**`T_ours`（我们算出的门到门总时长）升序**
 *   tie-break ①：换乘次数升序（同耗时优先少换乘）
 *   tie-break ②：总步行量升序（再同则少走路）
 *   tie-break ③：来源（高德优先，背书画强）
 *   tie-break ④：`planId` 升序（稳定）
 *
 * ★ **不用高德原始排序**（仅作对照基准）—— 产品口径：「我们有数据优势，算出更准确的结果」。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §C.6
 */
import type { RecommendCard } from "@/lib/recommend/types";
import { cmpByPref, PREF_DEFAULTS, type Prefs } from "@/lib/recommend/score";
import type { AmapPlanSeed, RecomputeProvenance } from "./types";

export interface RankedItem {
  card: RecommendCard;
  /** 来源：'amap'（主路径）/ 'local'（本地补漏 / 降级） */
  origin: "amap" | "local";
  /** 展示键（去重用）：`route@上>下` 链 —— 与 `OptionSeed.key` 同口径 */
  key: string;
  /** 高德骨架（local 项为 undefined） */
  seed?: AmapPlanSeed;
  /** 二次计算凭据（local 项为 undefined） */
  provenance?: RecomputeProvenance;
  /** 本地候选的「我们实测覆盖度」（质量闸门 §B.5-③；amap 项可省） */
  coverage?: number;
}

/** 换乘次数（= 换乘段数） */
export function transfersOf(item: RankedItem): number {
  return item.card.transfers.length;
}

/** 总步行量（米）：首段 + 末段（换乘步行无距离口径，不计入） */
export function walkMetersOf(item: RankedItem): number {
  const o = item.card.walkOut.distanceM ?? 0;
  const i = item.card.walkIn.distanceM ?? 0;
  return o + i;
}

/**
 * 按用户偏好三档排序（返回新数组，稳定）。
 *
 * ★ B4（需求 8）：主判据由 `cmpByPref` 决定 ——
 *   · `balanced`（缺省）：cost 升序（cost = totalMin + α·换乘 + (β−1)·步行 + 紧接换乘风险）；
 *   · `fewer_transfers`：换乘次数升序（tie-break cost↑）；
 *   · `less_walk`：步行量升序（tie-break cost↑）。
 * 三档 tie-break 均**回收 `cost` 作次级判据**，末位保留既有「来源（高德优先）/ `planId`」稳定序。
 *
 * @param prefs 缺省 = `PREF_DEFAULTS.balanced`（与原「综合」档等价）
 */
export function rankItems(items: RankedItem[], prefs: Prefs = PREF_DEFAULTS.balanced): RankedItem[] {
  // `cmpByPref` 以 **card** 为键，而来源（amap/local）挂在 `RankedItem` 上 ⇒ 先建 card→origin 查表
  const originByCard = new Map<RecommendCard, "amap" | "local">();
  for (const it of items) originByCard.set(it.card, it.origin);
  const originOf = (c: RecommendCard): "amap" | "local" => originByCard.get(c) ?? "local";
  return [...items].sort((a, b) => cmpByPref(a.card, b.card, prefs, originOf));
}
