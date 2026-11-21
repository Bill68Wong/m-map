"use client";

/**
 * 未锁车牌 · 定期重试的状态机（src/components/nav/match-retry.ts，R11 · 2026-11-21）
 *
 * ── 这个文件负责什么（其余一律不碰）──────────────────────────────────────────
 *   ① **节奏**：第几个车辆帧起算、连续无 high 后降频、累计 15 分钟后降频；
 *   ② **双帧确认**：high 连续 2 次同车牌才算数；medium 连续 2 次同车牌才给「一键确认」；
 *   ③ **6 条放弃条件**（写死，不改判据阈值）。
 *
 *   ⚠️ 它**不**判断"哪辆车是这辆"——那是 `match-vehicle.ts` 的事，本文件只消费
 *      `MatchResult` 的 `confidence/plate/frames/ranking/poolSize`。
 *   ⚠️ 它**不**写 `plate` / 不碰 `progressSource`：写库动作在 `useRideTracking` 里，
 *      本文件只回"可以锁 X"或"可以让用户确认 X"。
 *
 * ── 为什么必须双帧确认（不是"更保险一点"）──────────────────────────────────
 *   `match-vehicle.ts` 的分数门测的是「已有证据有多一致」，**不测证据数量**：未参与项按比例
 *   回填权重（`match-params.ts` 里那段分母塌缩说明）⇒ 单帧 score 能到 ≈1.0。帧数门只保证
 *   `frames ≥ 3`，而相邻两次 12s 调用的窗口高度重叠 —— 这仍不足以排除"一个瞬间的巧合"。
 *   ⇒ 要求**两次独立 run 都 high 且同一车牌**才写库。代价是首次锁牌最晚延后 12s，
 *     收益是把误锁概率压到平方级。误锁的后果是不可逆的（坐过站），这个交换很划算。
 *
 * ── 为什么 medium 只做展示 ──────────────────────────────────────────────────
 *   medium 一旦被当成"已锁"，`useRideTracking` 的轮询会改走 `fetchFrame(plate)`
 *   ⇒ `progressOf` 从车牌推报站值 ⇒ 违反「medium 不得据以报站」的既有契约。
 *   所以 medium 只走 `pendingPlate`（展示）+ `data-match-pending`（观测），
 *   连续 2 次同车牌后额外给一个**用户一键确认**（人确认过才写库，责任在用户）。
 *
 * ── 开关 ────────────────────────────────────────────────────────────────────
 *   由调用方 `matchEnabled` 控制（`NavShell.tsx` 传入）；本文件不读
 *   `MATCH_VEHICLE_ENABLED`（那个常量是灰度回滚闸，**不许改**，也不许在这里再读一遍）。
 */
import { FOLLOW_AMBIG_M } from "@/lib/nav/follow-slope";
import type { MatchResult } from "@/lib/nav/match-params";

/* ══════════════════ 常量（全部来自需求原文，改前先看条款）══════════════════ */

/** 进入 riding 后**第 2 个**车辆帧起算（第 1 帧没有历史，跑也是白跑） */
export const RETRY_START_FRAME = 2;
/** 连续多少帧无 high ⇒ 降频到 60s */
export const RETRY_NO_HIGH_TO_SLOW = 6;
/** 降频后的间隔 */
export const RETRY_SLOW_MS = 60_000;
/** 累计骑行多久之后进入"慢速档" */
export const RETRY_LATE_AFTER_MS = 15 * 60_000;
/** 慢速档间隔（**不是停止**：需求原话「降到每 2 分钟一次（不是停止）」） */
export const RETRY_LATE_MS = 120_000;
/** 双帧确认所需次数 */
export const RETRY_CONFIRM = 2;

/** 放弃条件①②的判据常量 */
export const RETRY_AMBIG_GAP_M = FOLLOW_AMBIG_M; // 12m：与 `plate-lock` 的"多车无法分辨"同源
export const RETRY_AMBIG_POOL_MIN = 4; // 「候选 >3 辆」⇒ poolSize ≥ 4
export const RETRY_AMBIG_STREAK = 3;
export const RETRY_NEAR_STOPS = 1; // 剩余 ≤1 站
export const RETRY_NEAR_M = 300; // 剩余里程 <300m
export const RETRY_STILL_KMH = 3;
export const RETRY_STILL_STOP_M = 200;
export const RETRY_STILL_STREAK = 3;
export const RETRY_BAD_ACC_M = 150;
export const RETRY_BAD_ACC_STREAK = 5;
export const RETRY_EXCLUDED_MAX = 3;
export const RETRY_EMPTY_STREAK = 5;

/** 放弃原因（写进 `data-match-retry` 的 `giveUp`） */
export type AbandonReason =
  | "ambiguous"
  | "near-end"
  | "standing"
  | "accuracy"
  | "excluded"
  | "empty-pool";

/* ══════════════════ 状态 ══════════════════ */

export interface RetryState {
  /** 本段第几个车辆帧（1 起） */
  frameSeq: number;
  /** 下一次允许跑算法的时刻（ms）；未降频时恒为 0 */
  nextDueAt: number;
  /** 连续未出 high 的帧数（降频依据；出一次 high 就归零） */
  noHigh: number;
  /** high 双帧确认 */
  highPlate: string | null;
  highTimes: number;
  /** medium 双帧确认 */
  mediumPlate: string | null;
  mediumTimes: number;
  /** 放弃原因（非 null ⇒ 本段不再重试，也不再跑算法） */
  givenUp: AbandonReason | null;
  /** 需要连续次数的四条放弃条件的计数器 */
  ambigStreak: number;
  stillStreak: number;
  badAccStreak: number;
  emptyStreak: number;
}

export function createRetryState(): RetryState {
  return {
    frameSeq: 0,
    nextDueAt: 0,
    noHigh: 0,
    highPlate: null,
    highTimes: 0,
    mediumPlate: null,
    mediumTimes: 0,
    givenUp: null,
    ambigStreak: 0,
    stillStreak: 0,
    badAccStreak: 0,
    emptyStreak: 0,
  };
}

/**
 * 每帧的**外部事实**（全部由调用方在**跑算法之前**取好）。
 * `null` 一律表示"不知道"⇒ 依赖它的放弃条件**不计数**（宁可多跑一帧，也不凭猜想放弃）。
 */
export interface FrameCtx {
  nowMs: number;
  /** 进入 riding 至今（ms） */
  ridingMs: number;
  /** 用户沿线速度（km/h）；`null` = 不可信 */
  userSpeedKmh: number | null;
  /** 距最近站的沿线里程（米）；`null` = 阶梯未就绪 */
  nearestStopM: number | null;
  /** 剩余沿线里程（米）；`null` = 不知 */
  remainM: number | null;
  /** 剩余站数；`null` = 不知 */
  remainStops: number | null;
  /** 最新定位精度（米）；`null` = 无定位 */
  accuracyM: number | null;
  /** 本段已累积排除的车牌数（「不是这辆」累计） */
  excludedCount: number;
  /** 上一帧结果的候选池大小；`null` = 还没跑过 */
  poolSize: number | null;
  /** 上一帧结果前二名的沿线里程差（米）；不足两辆 ⇒ `null` */
  topGapM: number | null;
}

/** 本帧要不要跑算法 */
export type BeginOutcome =
  | { run: true }
  | { run: false; why: "given-up" | "warmup" | "rate"; reason?: AbandonReason };

/**
 * 本帧是否该跑算法（顺带推进帧序号与放弃状态）。
 *
 * 顺序：已放弃 → 预热帧 → 降频闸 → 6 条放弃条件。
 * ⚠️ 预热帧（`frameSeq < RETRY_START_FRAME`）也**计入** `frameSeq`，否则永远到不了第 2 帧。
 */
export function begin(st: RetryState, ctx: FrameCtx): BeginOutcome {
  if (st.givenUp) return { run: false, why: "given-up", reason: st.givenUp };
  st.frameSeq += 1;
  if (st.frameSeq < RETRY_START_FRAME) return { run: false, why: "warmup" };
  if (ctx.nowMs < st.nextDueAt) return { run: false, why: "rate" };
  const reason = abandonOf(st, ctx);
  if (reason) {
    st.givenUp = reason;
    return { run: false, why: "given-up", reason };
  }
  return { run: true };
}

/**
 * 六条放弃条件（R11 原文，写死）。
 * 需要"连续 N 次"的四条在这里推进计数器；**任何一条命中即整段放弃**（不再重试）。
 */
export function abandonOf(st: RetryState, ctx: FrameCtx): AbandonReason | null {
  // ② 快到了：剩余 ≤1 站 或 剩余 <300m —— 这两条不需要连续，命中即停
  //    （越接近下车，误锁的代价越大、可纠正的时间越少）
  if (ctx.remainStops != null && ctx.remainStops <= RETRY_NEAR_STOPS) return "near-end";
  if (ctx.remainM != null && ctx.remainM < RETRY_NEAR_M) return "near-end";

  // ⑤ 本段已累积排除 ≥3 辆 ⇒ 候选被我们自己排空，再猜就是猜
  if (ctx.excludedCount >= RETRY_EXCLUDED_MAX) return "excluded";

  // ① 多车分不清：候选 >3 且前二里程差 <12m，连续 3 次
  if (
    ctx.poolSize != null &&
    ctx.poolSize >= RETRY_AMBIG_POOL_MIN &&
    ctx.topGapM != null &&
    ctx.topGapM < RETRY_AMBIG_GAP_M
  ) {
    st.ambigStreak += 1;
  } else {
    st.ambigStreak = 0;
  }
  if (st.ambigStreak >= RETRY_AMBIG_STREAK) return "ambiguous";

  // ③ 停着不动且不在站边：连续 3 帧速度 <3km/h 且距最近站 >200m
  if (
    ctx.userSpeedKmh != null &&
    ctx.userSpeedKmh < RETRY_STILL_KMH &&
    ctx.nearestStopM != null &&
    ctx.nearestStopM > RETRY_STILL_STOP_M
  ) {
    st.stillStreak += 1;
  } else {
    st.stillStreak = 0;
  }
  if (st.stillStreak >= RETRY_STILL_STREAK) return "standing";

  // ④ 定位不可信：连续 5 帧精度 >150m
  if (ctx.accuracyM != null && ctx.accuracyM > RETRY_BAD_ACC_M) {
    st.badAccStreak += 1;
  } else {
    st.badAccStreak = 0;
  }
  if (st.badAccStreak >= RETRY_BAD_ACC_STREAK) return "accuracy";

  // ⑥ 候选池空：连续 5 帧
  if (ctx.poolSize === 0) {
    st.emptyStreak += 1;
  } else {
    st.emptyStreak = 0;
  }
  if (st.emptyStreak >= RETRY_EMPTY_STREAK) return "empty-pool";

  return null;
}

/** 一帧结果的处置 */
export interface NoteOutcome {
  /**
   * 可以**写库**的车牌（high 双帧确认通过）。
   * 调用方据此执行：`setPlate` / `progressSource="vehicle"` / `boardMatch="auto"`。
   */
  lockPlate: string | null;
  /** 只做展示的车牌（medium，或 high 的第 1 帧） */
  pendingPlate: string | null;
  /** 连续 2 次 medium 同车牌 ⇒ 可以给用户「一键确认」（全程常驻，直到锁上或放弃） */
  confirmPlate: string | null;
  /** 本帧是否命中放弃条件（跑完算法才发现的那种，目前只有候选池空） */
  giveUp: AbandonReason | null;
}

/**
 * 处置一帧结果（**必须**与 `begin` 成对调用：`begin` 返回 `run: true` 才跑、跑完才 note）。
 *
 * 双帧语义：
 *   · high 连续 2 次**同车牌** ⇒ `lockPlate`；车牌一变就重新从 1 数起；
 *   · medium 连续 2 次同车牌 ⇒ `confirmPlate`（**不写库**）。
 * 降频语义：
 *   · 连续 6 帧无 high ⇒ 60s；
 *   · 累计 ≥15 分钟 ⇒ 120s（覆盖前一条）。
 *
 * @param opts.mediumOk 调用方的 medium 帧数门（`usableMedium(res)`，即
 *   `frames >= MATCH_MEDIUM_MIN_FRAMES`）。**默认 false**：本模块不认识算法层常量，
 *   由调用方明确告诉"这条 medium 够不够格"，避免两处各判一遍。
 */
export function note(
  st: RetryState,
  res: MatchResult,
  ctx: FrameCtx,
  opts: { mediumOk?: boolean } = {},
): NoteOutcome {
  let lockPlate: string | null = null;
  let pendingPlate: string | null = null;
  let confirmPlate: string | null = null;

  const isHigh = res.confidence === "high" && res.plate != null;
  const isMedium = res.confidence === "medium" && res.plate != null && opts.mediumOk === true;

  if (isHigh) {
    const plate = res.plate as string;
    if (st.highPlate === plate) st.highTimes += 1;
    else {
      st.highPlate = plate;
      st.highTimes = 1;
    }
    st.noHigh = 0;
    // 出了 high ⇒ medium 链断（两者的证据强度不同，不能混着数）
    st.mediumPlate = null;
    st.mediumTimes = 0;
    // 第 1 帧 high 也让人看见车牌（但**不**写库），避免"明明对上了却什么都不显示"
    pendingPlate = plate;
    if (st.highTimes >= RETRY_CONFIRM) lockPlate = plate;
  } else if (isMedium) {
    const plate = res.plate as string;
    if (st.mediumPlate === plate) st.mediumTimes += 1;
    else {
      st.mediumPlate = plate;
      st.mediumTimes = 1;
    }
    // high 链断：medium 出现说明当前证据不足以再一次 high
    st.highPlate = null;
    st.highTimes = 0;
    pendingPlate = plate;
    if (st.mediumTimes >= RETRY_CONFIRM) confirmPlate = plate;
  } else {
    st.highPlate = null;
    st.highTimes = 0;
    st.mediumPlate = null;
    st.mediumTimes = 0;
    st.noHigh += 1;
  }

  // ── 降频（只影响"下一次什么时候跑"，不影响已得出的结论）──
  let interval = 0;
  if (st.noHigh >= RETRY_NO_HIGH_TO_SLOW) interval = RETRY_SLOW_MS;
  if (ctx.ridingMs >= RETRY_LATE_AFTER_MS) interval = RETRY_LATE_MS;
  st.nextDueAt = interval > 0 ? ctx.nowMs + interval : 0;

  return { lockPlate, pendingPlate, confirmPlate, giveUp: null };
}

/** 观测值（写 `data-match-retry`：`<frameSeq>/<interval 档>/<放弃原因>`） */
export function retryTag(st: RetryState): string {
  const mode = st.nextDueAt > 0 ? "slow" : "fast";
  return `${st.frameSeq}/${mode}${st.givenUp ? `/${st.givenUp}` : ""}`;
}
