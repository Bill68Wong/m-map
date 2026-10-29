"use client";

/**
 * 推荐卡「只刷数字不换路线」的稳定合并（src/components/nav/merge-cards.ts，★ v3.6.0 S4 新增）
 *
 * ── 要解决什么 ────────────────────────────────────────────────────────
 *   用户点刷新时，`/api/nav` 会重算候选池并按 `score` 重新排序。若直接 `setData(新列表)`：
 *   · 卡片**换位**（用户正在看的那张跳到第 3 位）；
 *   · 偶尔**增删**（某条刚好赶不上被踢、或冒出新方案）。
 *   于是「刷新」看起来像「换了一批路线」，用户失去位置感。
 *
 * ── 做法 ──────────────────────────────────────────────────────────────
 *   以**路线指纹** `sig` 匹配新旧卡片：
 *     · 新列表里能匹配上 ⇒ 保留**旧的展示顺序与结构**，只覆盖**会变的数字**；
 *     · 旧有新无 ⇒ **丢弃**（该方案本轮已不可乘；保留会让列表随刷新单调膨胀，实测 5→7）；
 *     · 新有旧无 ⇒ 追加在末尾（真出现路线时才新增，不去挤掉用户正在看的卡）。
 *
 * ── 为什么用指纹而不是 `planId` ────────────────────────────────────────
 *   `planId` 在 amap 侧是**索引派生**的（候选池顺序一变就重新编号），
 *   不能当稳定身份；用 `route@board>alight` 拼串才是路线的稳定身份。
 *
 * ── 边界（务必遵守）──────────────────────────────────────────────────
 *   **只覆盖数字/展示字段**（`totalMin` / `arriveAt` / 每段 `waitMin` / `minutes` / `live*` /
 *   `tier*` / `directionName` / `altBuses` / 卡级 `lrtPromoted` …）；`rides` 长度、`route`、
 *   `boardLabel`、`alightLabel`、`walkOut` / `walkIn` 等**结构字段一律不动** ——
 *   结构变了就是另一条路线，应走 AST 不匹配分支。
 *
 * ⚠️⚠️ **调用时机铁律（S4 评审阻断 ①，比本文件任何一行都重要）**：
 *   本函数**只能**用于「**同一 query** 的刷新」。换 OD / 切偏好 / 切轻轨优先 ⇒
 *   **必须整体替换**（直接 `setData(nextCards)`）。否则：
 *     · 换目的地 ⇒ 旧目的地的路线残留在列表最前（实测 3 张变 6 张）；
 *     · 切偏好 / 切轻轨优先 ⇒ 服务端已重排，却被旧顺序覆盖 ⇒ **排序永久失效**。
 *   ⇒ 守卫在 `useRecommend.ts` 的 `mergedForRef`（同 query 才 merge）；
 *     断言在 `.verify/_check-merge-guard.ts`（4 条，防"纯函数对、调用时机错"复发）。
 *
 * ⚠️ **本清单是手写的**：`RideLegView` / `RecommendCard` 新增任何**展示字段**后必须同步加进
 *   `mergeLeg` / `mergeCard` 的覆盖表，否则表现为「刷新后该字段不更新」的**静默 bug**
 *   （编译器不会提醒 —— 因为 `...prev` 已经把新字段带过去了，只是带着旧值）。
 */

import type { RecommendCard, RideLegView } from "@/lib/recommend/types";

/** 路线指纹：各乘车段的「线路@上车站>下车站」拼接（结构身份） */
export function sigOf(c: RecommendCard): string {
  return c.rides.map((r) => `${r.route}@${r.boardLabel}>${r.alightLabel}`).join("|");
}

/**
 * 每段里**会随实时数据变化**的字段。
 * 只列这些 ⇒ 其余（`route` / `boardLabel` / `alightLabel` / `hops` / `levels` /
 * `parallelRoutes` / `directionName` …）天然保持不变，不会因合并而漂移。
 */
function mergeLeg(next: RideLegView, prev: RideLegView): RideLegView {
  return {
    ...prev, // 结构以**旧**为准（保证界面不跳）
    // ── 数值 ──
    minutes: next.minutes,
    waitMin: next.waitMin,
    // ── 实时展示（首段巴士/轻轨报站、邻班、档位）──
    liveText: next.liveText,
    liveDepartures: next.liveDepartures,
    liveClocks: next.liveClocks,
    liveMainMs: next.liveMainMs,
    livePrecise: next.livePrecise,
    rideSecText: next.rideSecText,
    lrtState: next.lrtState,
    /**
     * ★ S4 评审阻断 ①-2：轻轨**终点方向名**是实时派生（服务端取 `LrtLive.directionName`）
     *   ⇒ 不覆盖会出现「换了方向，卡面还写旧终点」。
     */
    directionName: next.directionName,
    // ── 赶车档位（随实时班次变）──
    tier: next.tier,
    tierText: next.tierText,
    tierHint: next.tierHint,
    catchHint: next.catchHint,
  };
}

/** 卡片级：只覆盖数字与实时字段，结构以旧为准 */
function mergeCard(next: RecommendCard, prev: RecommendCard): RecommendCard {
  return {
    ...prev,
    // ── 数值 ──
    totalMin: next.totalMin,
    arriveAt: next.arriveAt,
    // ── 后续班次（会随实时车距变）──
    altBuses: next.altBuses,
    /**
     * ★ S4 评审阻断 ①-1：「轻轨优先」角标开关（`RouteResultPane` 渲染用）。
     *   不覆盖 ⇒ 同 query 刷新时角标会停留在上一次的判定结果。
     */
    lrtPromoted: next.lrtPromoted,
    // ── 逐段：按**旧**段序覆盖数字；段数不同则不合并（结构已变，交给调用方当新卡）──
    rides: prev.rides.map((p, i) => (next.rides[i] ? mergeLeg(next.rides[i], p) : p)),
    // ── 换乘等待/余量（同理会变）──
    transfers: prev.transfers.map((p, i) => {
      const n = next.transfers[i];
      return n ? { ...p, minutes: n.minutes, waitMin: n.waitMin, slackMin: n.slackMin } : p;
    }),
    // ── 标记：本卡在最新一轮里仍有对应方案 ──
    stale: false,
  };
}

/**
 * 稳定合并：以**旧列表顺序**为主轴，用 `sig` 匹配新数据。
 *
 * @param prev  旧列表（用户当前看到的顺序 / 结构）
 * @param next  新列表（本轮 `/api/nav` 返回，已按 score 排序）
 * @returns 合并后的列表（长度 ≥ `prev.length`；旧有新无的标 `stale: true`）
 */
export function mergeCardsStable(prev: RecommendCard[], next: RecommendCard[]): RecommendCard[] {
  // 同一 sig 可能重复（极少：同线同上下站的不同方案）⇒ 队列消费，避免一串匹配到同一张
  const pool = new Map<string, RecommendCard[]>();
  for (const c of next) {
    const k = sigOf(c);
    const arr = pool.get(k);
    if (arr) arr.push(c);
    else pool.set(k, [c]);
  }

  const out: RecommendCard[] = [];
  const used = new Set<RecommendCard>();

  for (const p of prev) {
    const k = sigOf(p);
    const arr = pool.get(k);
    const n = arr?.shift(); // 取该指纹下的第一个未用新卡
    if (n && n.rides.length === p.rides.length) {
      used.add(n);
      out.push(mergeCard(n, p));
    }
    /**
     * ★★ **旧有新无 ⇒ 丢弃（不保留、不标 stale）** —— S4 评审阻断 ①-3 的最终处置。
     *
     * 最初实现是「保留原位 + `stale:true`」，但真浏览器实测证明那是错的：
     *   同一 OD 刷新时列表**从 5 张涨到 7 张** —— 因为某条方案在这一轮真的不可乘了
     *   （车刚开走 ⇒ 赶不上被服务端过滤），而"保留"让它以灰卡形式**永远留在列表里**，
     *   每刷一次多留几张。`stale` 只要没人清理就会**单调累积**，这是结构性缺陷。
     *
     * 判断依据：`stale` 唯一的收益是"失去位置感"，但它只在**方案仍然存在**时才有意义；
     *   方案已经不可乘了，把它留在屏幕上（哪怕是灰的）只会占位 + 让人误以为还能走。
     *   ⇒ 直接丢；位置感由"匹配上的卡保持旧序"承担（这才是绝大多数刷新场景）。
     */
  }

  // 新出现、旧列表里没有的路线 ⇒ 追加末尾（真新增才出现，不去挤掉用户正在看的卡）
  for (const n of next) {
    if (!used.has(n)) out.push(n);
  }
  return out;
}
