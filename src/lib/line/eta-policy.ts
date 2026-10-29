/**
 * 报站懒加载的**队列策略**（src/lib/line/eta-policy.ts，v3.6.0 · S6）
 *
 * ── 为什么把这几行抽出来 ────────────────────────────────────────────────
 *   `useLazyEta` 的六条硬约束里，有三条是**纯算术**（并发上限 / 队列上限 / 请求硬闸），
 *   它们最容易在后续改动中被无声破坏，而「在真浏览器里数请求」既慢又难在 CI 跑。
 *   ⇒ 把决策抽成**纯函数**，`useLazyEta` 只负责 IO 与状态，策略本身可被直接断言。
 *
 *   ⚠️ 抽的是**实现本体**，不是复刻：hook 里调用的就是这两个函数。
 *      若哪天有人改了常量或比较方向，单测立刻红。
 */

/** 六条硬约束里与「数量」有关的三条（`useLazyEta` 与单测共用同一份常量） */
export const ETA_LIMITS = {
  /** ② 并发上限：同时最多几个 `fetch` 在飞 */
  MAX_CONCURRENT: 3,
  /** ④ 待取队列上限：超出丢「离视口中心最远」的 */
  MAX_QUEUE: 8,
  /** ⑤ 单页自动请求硬闸：到顶后剩余站永久停在 idle */
  MAX_REQUESTS: 30,
  /** ③ 滚动静默期（毫秒） */
  DEBOUNCE_MS: 250,
  /** ⑤ 本地缓存 TTL（命中不计入硬闸） */
  CACHE_TTL_MS: 60_000,
} as const;

/**
 * 合并待取队列并按「离视口中心」裁剪（④）。
 *
 * @param queue      已在队列里的（保持相对顺序，通常更近）
 * @param candidates 新发现的、尚未入队的
 * @param distOf     取某站到视口中心的距离（越小越近）
 * @returns 新队列，长度 **≤ MAX_QUEUE**，且**保留最近的若干个**
 */
export function mergeQueue(
  queue: readonly string[],
  candidates: readonly string[],
  distOf: (code: string) => number,
): string[] {
  const merged = [...queue];
  for (const c of candidates) if (!merged.includes(c)) merged.push(c);
  if (merged.length <= ETA_LIMITS.MAX_QUEUE) return merged;
  // 超限 ⇒ 按距离升序（近的在前）后截断。**不按发现顺序**截断：用户最可能马上看到的
  // 那几站必须留在队列里，否则「滚到哪儿哪儿没数」。
  return [...merged].sort((a, b) => distOf(a) - distOf(b)).slice(0, ETA_LIMITS.MAX_QUEUE);
}

/**
 * 本次可以发几个请求（② 并发 + ⑤ 硬闸）。
 *
 * @returns `{ slots, capped }` —— `slots === 0 && capped` 表示硬闸已到顶（永久停）
 */
export function slotsFor(
  inflight: number,
  sent: number,
): { slots: number; capped: boolean } {
  if (sent >= ETA_LIMITS.MAX_REQUESTS) return { slots: 0, capped: true };
  const free = ETA_LIMITS.MAX_CONCURRENT - inflight;
  if (free <= 0) return { slots: 0, capped: false };
  // 本次最多只能把「总请求数」推到硬闸
  const budget = ETA_LIMITS.MAX_REQUESTS - sent;
  return { slots: Math.min(free, budget), capped: false };
}
