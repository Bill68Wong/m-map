/**
 * 时间分桶（共享纯函数层，v3.4.0）
 *
 * ── 为什么独立成文件 ──────────────────────────────────────────────
 *   消费方横跨「离线重建（rebuild）」与「查询链（segment-lookup，多端复用）」；
 *   本文件必须**零依赖**（不 import pg / 不 import 任何 server 模块），避免客户端打包风险。
 *
 * ── 两套口径 ─────────────────────────────────────────────────────
 *   bucketOf(hour)             旧四桶（保留：样本存储字段等历史兼容场景）
 *   bucketOfRoute(weekday, hour)  ★ v3.4.0 新五桶（数据驱动推导）
 *       am_work      工作日（周一~五）07:00-09:00
 *       am_weekend   周末（周六日）  07:00-09:00
 *       day          全周           09:00-16:00
 *       pm           全周           16:00-20:00
 *       night        全周           20:00-07:00
 *   推导依据：docs/量化方案-导航站间时长-20260927.md §6
 *     （全天真峰 18 时 1.21 · 16 时已慢 1.14 · 19 时回落 · 周末晨间 0.92 快于工作日 1.15）
 *   决策记录（实验⑦b/⑦c）：仅「早高峰桶」按工作日/周末分池（全时段分池样本切碎、反而更差）；
 *     周一与周二~四无显著差异（比值 0.96-1.00）→ 合并为「工作日」。
 */

/** 澳门时间分量（GMT+8）。★ 全站唯一实现，勿另起一套。 */
export const macauParts = (t: Date) => {
  const m = new Date(t.getTime() + 8 * 3600e3);
  return { weekday: m.getUTCDay(), hour: m.getUTCHours() };
};

/** 旧四桶（am_peak 7-10 / day 10-17 / pm_peak 17-20 / night 20-7）——仅保留兼容，不用于新聚合。 */
export function bucketOf(h: number): string {
  if (h >= 7 && h < 10) return "am_peak";
  if (h >= 10 && h < 17) return "day";
  if (h >= 17 && h < 20) return "pm_peak";
  return "night";
}

/** ★ v3.4.0 新五桶（数据驱动版；聚合与查询链的唯一口径）。 */
export function bucketOfRoute(weekday: number, hour: number): string {
  if (hour >= 7 && hour < 9) return weekday >= 1 && weekday <= 5 ? "am_work" : "am_weekend";
  if (hour >= 9 && hour < 16) return "day";
  if (hour >= 16 && hour < 20) return "pm";
  return "night";
}

/** 查找上下文：由 epoch ms 构造（供 lookupHop 等消费方一键取桶）。 */
export function nowBucketOf(ms: number): string {
  const mp = macauParts(new Date(ms));
  return bucketOfRoute(mp.weekday, mp.hour);
}
