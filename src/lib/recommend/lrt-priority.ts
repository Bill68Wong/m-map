/**
 * 轻轨优先开关（src/lib/recommend/lrt-priority.ts · v3.3.0 · AC-105）
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────
 *   轻轨方案（氹仔线/石排湾线/横琴线）常在时间上略慢于公交，被纯时长排序挤到 `limit` 之外。
 *   用户为「去某个只有轻轨才顺的 OD」时希望**轻轨方案能被看见**（可经 `/api/nav?lrtFirst=1` 开启）。
 *
 * ── 口径（写死 · fail-safe）───────────────────────────────────────────
 *   · `!enabled` / 候选不足 2 条 → **原样返回**（零副作用）；
 *   · `baseline` = **前 `limit` 张里最慢的 `totalMin`**；
 *   · 命中 = 含轻轨段（`rides.some(kind==='lrt')`）**且** `totalMin <= baseline + 15`；
 *     （命中意味着其建模时 `LrtLive.state==='running'` 且有可赶班次 —— 由 `modelOption` 保证）
 *   · 命中者按 `totalMin` 升序**稳定置顶**；其余**相对序不变**；**只重排、不增删**；
 *   · 无命中 → **静默**原样（不置顶、不报错）。
 *
 * ⚠️ 纯函数（无 pg、无 IO）；不改卡片内容，只改数组顺序。
 */
import type { RankedItem } from "@/lib/nav/rank";

/** 阈值余量（分钟）：轻轨方案总时长 ≤ 前 limit 张最慢 + 该值 → 具备置顶资格 */
export const LRT_PRIORITY_SLACK_MIN = 15;

/**
 * 轻轨优先重排。
 * @param items   已按 `rankItems` 排好序的候选（**不修改入参**，返回新数组）
 * @param limit   展示张数（用于取 baseline）
 * @param enabled 是否开启（`/api/nav?lrtFirst=1`）
 */
export function applyLrtPriority(items: RankedItem[], limit: number, enabled: boolean): RankedItem[] {
  if (!enabled || items.length < 2) return items;

  // ★ v3.3.0（AC-105）：**角标唯一产生点** —— 先清标记（幂等），仅对真正置顶的命中者回写。
  for (const i of items) i.card.lrtPromoted = false;

  const head = items.slice(0, Math.max(1, Math.trunc(limit) || 1));
  const baseline = Math.max(...head.map((i) => i.card.totalMin));

  const isLrtHit = (i: RankedItem): boolean =>
    i.card.rides.some((r) => r.kind === "lrt") && i.card.totalMin <= baseline + LRT_PRIORITY_SLACK_MIN;

  const hits = items.filter(isLrtHit);
  if (!hits.length) return items; // 未命中 → 静默（保持已清空状态）

  // 命中者按 totalMin 升序稳定置顶（`Array#sort` 稳定 ⇒ 同值保持原相对序）
  const orderedHits = [...hits].sort((a, b) => a.card.totalMin - b.card.totalMin);
  for (const h of orderedHits) h.card.lrtPromoted = true; // 命中者确实被置顶 ⇒ 回写角标
  const hitSet = new Set(hits);
  const rest = items.filter((i) => !hitSet.has(i));
  return [...orderedHits, ...rest];
}
