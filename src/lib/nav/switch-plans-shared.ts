/**
 * `switch-plans` 组内 top-K 的**纯函数**（2026-09-25，v2.14.0 §3.4）
 *
 * 为什么单列一个模块：Next.js App Router 的 `route.ts` 只允许导出 HTTP 方法与少量保留字段，
 * **不允许导出任意函数** —— 想给「组内排序 / 去重 / top-K 截断」写单元测试，必须把纯逻辑
 * 搬到可 `import` 的模块。故本文件是 `src/app/api/nav/switch-plans/route.ts` 内联逻辑的
 * **纯搬迁 + 导出**（行为与原内联实现完全一致）。
 *
 * 口径（07 §3.4，勿改）：
 *   · 每组（＝首程线路）保留 **top-K（`SIBLING_TOP_K` = 3）**：top-1 = 主卡 `card`，其余 = `siblings`；
 *   · 组内按 `totalMin` **升序**（直达 / 换乘**混排**）；
 *   · 去重键 = `chainRoutes.join(">") + "@" + alightMain`，同键保留 `totalMin` 最小者；
 *     主卡即排序后首条 ⇒ 「与主卡同键的兄弟」天然被剔除；
 *   · `siblings` 为空（该组仅 1 条走法）时**不返回该键**（＝不下发）。
 *
 * 幂等：纯函数，无 IO、无副作用（不 import `pg`）。
 */
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import type { RecommendCard } from "@/lib/recommend/types";

/**
 * 每组在折叠区「一父多子」里保留的方案数 **top-K**（主卡 `card` + 至多 `K-1` 条 `siblings`）。
 * 须 ≤ `route.ts` 的 `PER_GROUP_MAX`。
 */
export const SIBLING_TOP_K = 3;

/** 卡片的乘车段线路链（如 `25>26A`）—— 与响应 `chainRoutes` 同源 */
export const chainRoutesOf = (c: RecommendCard): string => c.rides.map((r) => r.route).join(">");

/** 卡片末程下车站主码（无乘车段 ⇒ null） */
export const alightMainOf = (c: RecommendCard): string | null => {
  const last = c.rides[c.rides.length - 1];
  return last ? mainCodeOf(last.alight) : null;
};

/** 组内去重键 = `chainRoutes.join(">") + "@" + alightMain` —— 同键＝同一走法（保留 `totalMin` 最小者） */
export const dedupKeyOf = (c: RecommendCard): string => `${chainRoutesOf(c)}@${alightMainOf(c) ?? ""}`;

/**
 * 组内排序 comparator：`totalMin` 升序（直达 / 换乘混排）；
 * 同值时按线路链稳定排序（消除非确定顺序）。
 */
export const cmpByTotalMin = (a: RecommendCard, b: RecommendCard): number =>
  a.totalMin - b.totalMin || chainRoutesOf(a).localeCompare(chainRoutesOf(b));

/** `splitPlanCards` 的返回：主卡必有，兄弟为空时省略该键 */
export interface PlanCards {
  card: RecommendCard;
  siblings?: RecommendCard[];
}

/**
 * 组内收敛：**排序（`totalMin` 升序）→ 按 `dedupKeyOf` 去重（留最小）→ 截断 top-K → 拆分主卡/兄弟**。
 *
 * @param cards 同一父线路（＝首程路线）下的全部候选卡；**调用方保证非空**（route 侧每组至少 1 条）。
 * @returns `{ card, siblings? }`：`card` = 组内最优（top-1）；`siblings` = 其余（≤ `SIBLING_TOP_K - 1` 条、
 *   `totalMin` 升序）；**无兄弟时不返回 `siblings` 键**（＝不下发，向后兼容）。
 * @remarks 不修改入参（内部 `[...cards]` 复制后再排序）。
 */
export function splitPlanCards(cards: readonly RecommendCard[]): PlanCards {
  // 组内排序：`totalMin` 升序（直达 / 换乘混排）
  const sorted = [...cards].sort(cmpByTotalMin);
  // 去重：同 `dedupKey` 只留首个（＝ `totalMin` 最小者）；主卡同键兄弟由此剔除
  const seen = new Set<string>();
  const top: RecommendCard[] = [];
  for (const c of sorted) {
    const k = dedupKeyOf(c);
    if (seen.has(k)) continue;
    seen.add(k);
    top.push(c);
    if (top.length >= SIBLING_TOP_K) break;
  }
  // 调用方保证 cards 非空 ⇒ top 至少 1 条
  const [card, ...siblings] = top;
  return siblings.length ? { card, siblings } : { card };
}
