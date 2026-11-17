/**
 * 剩余行程的**分量清单**（src/lib/nav/remain-parts.ts，★ 2026-11-13 · R1 阶段2 新增）
 *
 * ── 这个文件为什么存在（一句话）──────────────────────────────────────────
 *   「总剩余由哪几项相加而成、按什么顺序相加」—— 这条知识**只能有一份**。
 *   服务端 `remaining.ts#recomputeRemaining` 与客户端（`off` / `boarding` 相位的实时总剩余）
 *   都要用同一份清单；各写一遍 ⇒ 迟早一项对不上，而两边各自都"自洽"，**没有任何断言会红**。
 *
 * ── 清单（顺序有意义，串行累加）─────────────────────────────────────────
 *   ```
 *   [当前换乘步行]  ← 仅「刚到换乘站、还没走到新站台」时有（client boarding && legIndex>0）
 *   [当前腿候车]    ← 仅「还没上车」时有（client boarding/off）；服务端恒不计（假设已上车）
 *   当前腿乘车      ← riding 传实时剩余；boarding 传静态 minutes
 *   ── 以下逐段 ──
 *   transfer[i-1].minutes   （第 i 段之前的换乘步行）
 *   wait_i                  （第 i 段候车；**由调用方注入**，见下）
 *   ride_i.minutes          （第 i 段乘车，静态）
 *   ── 末段 ──
 *   walk-in                 （末段步行；调用方可传实时比例值）
 *   ```
 *   ⚠️ **首段步行（`walkOut`）刻意不在本清单内**：它发生在「当前腿」之前，且
 *     服务端口径明确「已发生的出发步行一律不计入」（`remaining.ts:12`）。
 *      客户端要把它算进去时**自己加在前面**（`NavShell` 的 `walkOutLive`），
 *      本模块保持与服务端同构。
 *
 * ── 为什么 `waitMinAt` 是注入的 ──────────────────────────────────────────
 *   同一个位置的候车，两侧取值方式**本来就不同**，但不是"两份清单"而是"同一清单的两个取值器"：
 *     · 服务端：`headwayAt(班距索引)` 按「预计到达该换乘站的时刻」重估（`reestimateWait`）；
 *     · 客户端：拿不到 `HeadwayIndex`（`loadHeadway` 需要 `Pool`）⇒ 用 `card.rides[i].waitMin`
 *       静态值（source `"kept"`）。**这是刻意的降级，不是遗漏**，两侧都写在这里。
 *   `arrivalMs` 由本模块按串行累加算出后传给取值器 —— 服务端的 `headwayAt` 必须吃它，
 *   所以这个回调不能"先算好再传"，必须边走边问。
 *
 *   ⚠️ **客户端永远不许自己算 headway**：一旦复制一份 `headwayAt` 到客户端"让它更准"，
 *     两侧就从「同一清单、两个取值器」退化成**两份真相**（各自自洽、没有断言会红）。
 *
 * ── 已知边界（写在这里，别在后面各层重复解释）──────────────────────────
 *   ① ★ **KI-7「换乘步行无几何，无法按比例衰减」**
 *      `TransferView` 只有 `minutes`、**没有折线**（逐字段核过：`at/atLabel/minutes/estimated/
 *      sameField/waitMin/slackMin`）⇒ 换乘步行不能像首/末段那样用 `progressOnPath` 按剩余比例算。
 *      后果：`boarding`（`legIndex > 0`）期间换乘步行**按整段计**、不随走动递减，
 *      登车那一帧整段移出 ⇒ 出现一次台阶（幅度 = `transfers[legIndex-1].minutes`）。
 *
 *      ⚠️⚠️ **这是刻意选择，不是没做完 —— 别把它当 bug「修」。**
 *      两个方向都可行，我们**方向定死在保守侧**：
 *        · 整段计入 ⇒ 剩余**偏多**。用户以为还有时间而慢慢走 ⇒ 最坏是**迟到**。
 *        · 不计入   ⇒ 剩余**偏少**。用户以为时间不够而去赶 ⇒ 可能**闯红灯**。
 *      在「赶不赶得上」这个最敏感的位置上，后者后果更严重 ⇒ 宁可多显示。
 *      真要消掉它只能补几何（给 `transfers[i]` 加 polyline，或复用 `useWalkRoute` 给换乘段取数）
 *      —— 那是**新取数链路**，属独立批次。**谁要改这条，先改这一段的裁定，不要只改代码。**
 *   ② **下游候车（i>legIndex）客户端恒为静态**：客户端拿不到班距索引（`loadHeadway` 需要 `Pool`）⇒
 *      恒取 `card.rides[i].waitMin`（`source:"kept"`）。**这是刻意的降级，不是遗漏**。
 *      ⚠️ **客户端永远不要在本地自己算班距/headway** —— 一旦为了"更准"在客户端复制一份
 *      `headwayAt`，两侧就不再是「同一清单、两个取值器」，而是**两份真相**，且两边各自自洽、
 *      没有任何断言会红。（服务端的 `reestimateWait` 就是唯一那份。）
 *   ③ 本模块**不做任何 clamp** —— 各分量原样累加，负值/NaN 的兜底由调用方按自己的口径做
 *      （服务端 `Math.max(0, …)` + `round1`；客户端 clamp 0）。理由：两条路径的上屏规则不同，
 *      在这里统一反而会掩盖差异。
 *
 * 纯函数：无 I/O、无 `Pool`、除注入的 `arrivalMs` 外不读时钟。client-safe。
 */
import type { RecommendCard, RideLegView } from "@/lib/recommend/types";

/** 一个剩余分量 */
export interface RemainPart {
  kind: "transfer" | "wait" | "ride" | "walk-in";
  /**
   * 关联的 `card.rides` 下标。- 换乘步行 = **其后**那一段（= `i`，对应 `transfers[i-1]`）；
   * - 候车 / 乘车 = 该段；- 末段步行 = 最后一段。
   */
  legIndex: number;
  /** 该分量分钟（**候车项已按 `round1` 归一**，与服务端逐字一致） */
  minutes: number;
  /** 候车来源（仅 `kind === "wait"` 且取值器给了才有）—— 服务端用它填 `retimedWaits.source` */
  waitSource?: string;
}

/** 候车取值器的返回 */
export interface RemainWaitResolution {
  minutes: number;
  /** `"headway"` / `"median"` / `"kept"` …（服务端诊断用；客户端可不给） */
  source?: string;
}

export interface RemainPartsInput {
  card: RecommendCard;
  /** 当前所在载具段下标（`card.rides` 下标） */
  legIndex: number;
  /** 串行累加的起点（`waitMinAt` 的 `arrivalMs` 以它为基准） */
  nowMs: number;
  /**
   * 当前腿**之前**那次换乘步行的分钟；`null` = 不计（服务端恒传 `null`；
   * 客户端仅在 `boarding` 且 `legIndex > 0` 时传 `transfers[legIndex-1].minutes`）。
   */
  curTransferMin?: number | null;
  /** 当前腿候车分钟；`null` = 不计（已上车 / 服务端恒 `null`） */
  curWaitMin?: number | null;
  /** 当前腿乘车分钟（riding: 实时剩余；boarding/off: 静态 `rides[legIndex].minutes`） */
  curRideMin: number;
  /** 下游第 `i` 段候车取值器（`arrivalMs` = 预计到达该段上车站的时刻） */
  waitMinAt: (legIndex: number, ride: RideLegView, arrivalMs: number) => RemainWaitResolution;
  /** 末段步行分钟（调用方可传实时比例值） */
  walkInMin: number;
}

export interface RemainPartsResult {
  /** 有序分量（串行累加顺序） */
  parts: RemainPart[];
  /**
   * 所有分量的和（分钟，**未 clamp、未取整**）。
   *
   * ⚠️ 计算方式刻意与 `remaining.ts` 原实现**逐位相同**：内部按毫秒累加
   *   `cursorMs += minutes * 60000`，最后 `(cursorMs - nowMs) / 60000`。
   *   不要在调用方改成「先把分钟加起来再乘 60000」—— 浮点次序变了，
   *   服务端 `恒等式 0ms` 那条契约断言会开始抖（虽然 round1 通常能盖住）。
   */
  totalMinutesRaw: number;
}

/** 取 1 位小数（与服务端 `remaining.ts` 原 `round1` 同式；此处是唯一定义） */
export function round1Min(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 非有限值统一归 0 */
const numOr0 = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 展开剩余分量并求总分钟。
 * @see 文件头「清单」段 —— 顺序与包含关系就是契约，改之前先看那里。
 */
export function remainPartsOf(input: RemainPartsInput): RemainPartsResult {
  const card = input.card;
  const rides = Array.isArray(card.rides) ? card.rides : [];
  const legIndex = Math.max(0, Math.min(Math.trunc(numOr0(input.legIndex)), Math.max(0, rides.length - 1)));
  const parts: RemainPart[] = [];

  /** 当前腿起点：换乘步行 + 候车 + 乘车（三项顺序 = 用户真实经历顺序） */
  let cursorMs = input.nowMs;
  if (input.curTransferMin !== null && input.curTransferMin !== undefined) {
    const m = Math.max(0, numOr0(input.curTransferMin));
    parts.push({ kind: "transfer", legIndex, minutes: m });
    cursorMs += m * 60_000;
  }
  if (input.curWaitMin !== null && input.curWaitMin !== undefined) {
    /** 与服务端同一归一：`round1(max(0, numOr0(x)))` —— 累加的是**归一后**的值 */
    const m = round1Min(Math.max(0, numOr0(input.curWaitMin)));
    parts.push({ kind: "wait", legIndex, minutes: m });
    cursorMs += m * 60_000;
  }
  {
    const m = Math.max(0, numOr0(input.curRideMin));
    parts.push({ kind: "ride", legIndex, minutes: m });
    cursorMs += m * 60_000;
  }

  /** 下游逐段：换乘步行 → 候车（注入取值）→ 乘车 */
  for (let i = legIndex + 1; i < rides.length; i++) {
    const ride = rides[i]!;
    const t = card.transfers?.[i - 1];
    if (t) {
      const m = Math.max(0, numOr0(t.minutes));
      parts.push({ kind: "transfer", legIndex: i, minutes: m });
      cursorMs += m * 60_000;
    }
    const w = input.waitMinAt(i, ride, cursorMs);
    const wMin = round1Min(Math.max(0, numOr0(w.minutes)));
    parts.push({ kind: "wait", legIndex: i, minutes: wMin, waitSource: w.source });
    cursorMs += wMin * 60_000;

    const rm = Math.max(0, numOr0(ride.minutes));
    parts.push({ kind: "ride", legIndex: i, minutes: rm });
    cursorMs += rm * 60_000;
  }

  /** 末段步行 */
  {
    const m = Math.max(0, numOr0(input.walkInMin));
    parts.push({ kind: "walk-in", legIndex: Math.max(0, rides.length - 1), minutes: m });
    cursorMs += m * 60_000;
  }

  return { parts, totalMinutesRaw: (cursorMs - input.nowMs) / 60_000 };
}

/** 分量求和的便捷出口（**只用于展示型调用方**；服务端仍用 `totalMinutesRaw` 保浮点同序） */
export function remainPartsTotalMin(parts: readonly RemainPart[]): number {
  let ms = 0;
  for (const p of parts) ms += Math.max(0, numOr0(p.minutes)) * 60_000;
  return ms / 60_000;
}

/** `off` / `boarding` 实时总剩余的输入 */
export interface PreRideRemainInput {
  card: RecommendCard;
  legIndex: number;
  /** 串行累加起点（只影响注入的 `arrivalMs`；客户端取值器忽略它） */
  nowMs: number;
  /** 首段步行**实时**剩余分钟（调用方用 `walkRemainMinOf` 按比例算出来） */
  walkOutRemainMin: number;
  /**
   * 当前腿候车的**实时**值（`boardingEtaLive.etaMin`）。
   * `null` ⇒ **回落** `card.rides[legIndex].waitMin`（静态）。
   * ⚠️ 这是全链路**唯一**允许回落成静态分钟的地方 —— 只用静态等于「等了 5 分钟数字不减」。
   */
  waitLiveMin: number | null;
  /** 末段步行分钟（实时比例值）；`null` ⇒ 回落 `card.walkIn.minutes` */
  walkInRemainMin: number | null;
}

/**
 * `off` / `boarding`（**还没上车**）的实时总剩余分钟。
 *
 * `total = walkOutLive + [当前换乘步行] + [当前腿候车] + 当前腿乘车 + 下游各段 + 末段步行`
 *
 * 与 `remaining.ts` 的唯一差别就是那两个「还没发生」的方括号项 ——
 * 服务端假设用户已在车上，故恒传 `null`；这里按实际相位传。**清单本身是同一份。**
 */
export function preRideRemainMinOf(input: PreRideRemainInput): number {
  const card = input.card;
  const rides = Array.isArray(card.rides) ? card.rides : [];
  const legIndex = Math.max(0, Math.min(Math.trunc(numOr0(input.legIndex)), Math.max(0, rides.length - 1)));
  const curRide = rides[legIndex];

  const walkOut = Math.max(0, numOr0(input.walkOutRemainMin));
  /** 【唯一回落点】实时到站分钟优先；缺省才用规划静态值 */
  const curWaitMin =
    input.waitLiveMin !== null && Number.isFinite(Number(input.waitLiveMin))
      ? Number(input.waitLiveMin)
      : (curRide?.waitMin ?? null);
  const curTransferMin =
    legIndex > 0 ? (card.transfers?.[legIndex - 1]?.minutes ?? null) : null;

  const { totalMinutesRaw } = remainPartsOf({
    card,
    legIndex,
    nowMs: input.nowMs,
    curTransferMin,
    curWaitMin,
    curRideMin: curRide?.minutes ?? 0,
    /** 客户端拿不到班距索引 ⇒ 下游候车恒取静态值（service 侧同档为 `kept`） */
    waitMinAt: (_i, ride) => ({ minutes: ride.waitMin, source: "kept" }),
    walkInMin: input.walkInRemainMin ?? (card.walkIn?.minutes ?? 0),
  });

  return Math.max(0, walkOut + totalMinutesRaw);
}
