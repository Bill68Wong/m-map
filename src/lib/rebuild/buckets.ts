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

/** 澳门时间分量（GMT+8）。★ 全站唯一实现，勿另起一套。
 *
 * ⚠️ **`weekday` 是 `Date.getUTCDay()` 口径：0=周日 · 1=周一 · … · 5=周五 · 6=周六**
 *    （**不是** ISO-8601 的 1=周一…7=周日，也不是「5=周六、6=周日」）。
 *    因此 `weekendLike = weekday === 0 || weekday === 6` 才是「周日或周六」。
 *    这个映射是**跨模块的隐含契约**（本文件的周末判定 + segment_samples.weekday 列 +
 *    segment-stats 的分层键全都依赖它），写错不会报错，只会让周末/工作日样本悄悄换池。
 *
 *    实证（2026-10-30，183,086 条 track 样本按 observed_at 现算）：
 *      · `new Date('2026-10-31').getUTCDay() === 6`（周六）
 *      · `new Date('2026-11-01').getUTCDay() === 0`（周日）
 *      · 桶分布 `am_weekend=1319`，**全部来自 weekday=0**（周六在该时段无采样）；
 *        weekday=1/2 的晨间全部落 `am_work` ⇒ 0/6 判定正确。
 *    校验脚本：`.verify/_h-weekday.ts`（改映射前后都应先跑它）。
 */
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

/** ★ 聚合桶（重建 segment_stats 时每样本的归属）。
 *
 *  设计依据（2026-09-27 深夜 · 滚动原点 CV ①⑧/⑧b/⑧c，20.2 万段）：
 *  · **am 按日型分池**（工作日/周末晨间差异 21%——必须隔离，防周末样本污染工作日晨间池）；
 *  · **其余四桶不分日型**（CV 实证：混合池比「纯工作日池」更稳，工作日样本上 0.522 vs 0.534）；
 *  · ★ v3.5.5：**节假日按「周末同款」处理**（澳门公众假期 ≈ 周末形态——`isHoliday` 由调用方判定，
 *    数据源 = `lrt_holidays` 表，见 `./holidays`）。
 */
export function bucketOfRoute(weekday: number, hour: number, isHoliday = false): string {
  // ⚠️ 0=周日、6=周六（getUTCDay 口径，见 macauParts 注释）。改成 5/6 会把周日当工作日。
  const weekendLike = weekday === 0 || weekday === 6 || isHoliday;
  if (hour >= 7 && hour < 9) return weekendLike ? "am_weekend" : "am_work";
  if (hour >= 9 && hour < 16) return "day";
  if (hour >= 16 && hour < 20) return "pm";
  return "night";
}

/** ★ 查询桶（运行时按「用户当前时刻」选池 · v3.5.4；★ v3.5.5 加节假日）。
 *
 *  设计依据（同上实验）：
 *  · 工作日 → 五桶（与聚合桶一致：am_work/day/pm/night）；
 *  · **周末与节假日 → 仅晨间独立池（am_weekend），其余时段走 `"all"`（全周池）**——
 *    CV 实证周末分时段**有害**（周末样本 MADE 0.487 → 不分 0.442）；节假日同款处理。
 */
export function queryBucketOf(weekday: number, hour: number, isHoliday = false): string {
  const weekendLike = weekday === 0 || weekday === 6 || isHoliday;
  if (weekendLike) {
    if (hour >= 7 && hour < 9) return "am_weekend";
    return "all";
  }
  return bucketOfRoute(weekday, hour);
}

/** 查找上下文：由 epoch ms 构造（供 lookupHop 等消费方一键取桶）——查询口径。
 *  ⚠️ 节假日感知版见 `./holidays` 的 `nowBucketOfHolidayAware`（server 侧，自动查假期表）。 */
export function nowBucketOf(ms: number, isHoliday = false): string {
  const mp = macauParts(new Date(ms));
  return queryBucketOf(mp.weekday, mp.hour, isHoliday);
}

/* ══════════════════════════════════════════════════════════════════════
 * 峰 / 非峰二元归类（★ v3.6.0，长停站判据用）
 *
 * 为什么放这里而不是 `long-stop.ts`：
 *   · 它是**分桶口径的一部分**（「哪些桶算高峰」），与五桶定义必须同源同改；
 *   · 放在这里全家只有一份，`long-stop.ts` 直接 import，
 *     不会出现「buckets.ts 改了 pm 区间、长停判据还按旧区间算」的静默漂移。
 *
 * 口径：高峰 = `am_work`（工作日 07:00-09:00）∪ `pm`（16:00-20:00，**含周末**）；
 *       非高峰 = `day` ∪ `night` ∪ `am_weekend`。
 *       旧的 `am_peak` / `pm_peak` 仅兼容保留，**不得**用于新聚合。
 * ⚠️ 禁止手写小时区间判断高峰 —— 一律走本文件。
 * ══════════════════════════════════════════════════════════════════════ */

/** 分桶类别（高峰 / 非高峰） */
export type BucketKind = "peak" | "nonpeak";
const PEAK_BUCKETS = new Set(["am_work", "pm"]);

/** 观测时刻 → 分桶类别（唯一的时段判定入口） */
export function kindOfBucket(weekday: number, hour: number, isHoliday = false): BucketKind {
  return PEAK_BUCKETS.has(bucketOfRoute(weekday, hour, isHoliday)) ? "peak" : "nonpeak";
}

/**
 * 各分桶类别覆盖的「整点小时」集合 —— **由枚举反查 `bucketOfRoute` 得出**，不写死 7/9/16/20。
 * 只取小时粒度（班距表本身就是小时级 `HH:MM` 区间，再细无意义）。
 *
 * ★ 意义：分桶口径一旦调整（比如 pm 改成 16-21），本集合自动跟随，
 *   长停判据里「该时段班距」的计算面不会静默漂移。
 */
export const KIND_HOURS: Record<BucketKind, Set<number>> = (() => {
  const out: Record<BucketKind, Set<number>> = { peak: new Set(), nonpeak: new Set() };
  for (let wd = 0; wd <= 6; wd++) for (let h = 0; h < 24; h++) out[kindOfBucket(wd, h)].add(h);
  return out;
})();
