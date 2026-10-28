/**
 * 轻轨 GPS 投影推进（src/lib/nav/lrt-progress.ts，2026-09-25 · v2.14 · 07 §8）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   轻轨无逐车数据 ⇒ 用用户 GPS 投影到本段 `leg.colored`（GCJ-02 折线）推算站序进度，
 *   输出与巴士**同构**的 `TrackProgress`（喂站条四态与「您在这里」）。
 *
 * ── 保守规则（07 §8.3，全部为「防跳站」）────────────────────────────
 *   · 预计算站点里程阶梯 `ladder[i]`（进入 riding 时算一次）；乱序 / 投影离站过远的站**剔除**；
 *   · 可信门：离线 `≤120m` 且精度 `≤100m`（弱信号不推进）；
 *   · 已过站 `passedIdx = max{ i : d_now > ladder[i] + H }`；
 *   · **单帧最多推进 1 站**；**连续 2 帧 computed 一致**才采纳；
 *   · **Hysteresis** `H = max(60m, accuracy, 0.25 × 相邻站距)`，回退需 `d_now < ladder[i] − H`；
 *   · 速度合理性 `|Δd|/Δt ∈ [8, 80] km/h`（异常大丢帧；异常小不推进）；
 *   · 连续 2 帧不满足可信门 ⇒ **冻结**（不跳不猜）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **client-safe 纯函数**（零 `pg`）；坐标 GCJ-02；「对不上就冻结」铁律不变。
 */
import { cumDistM, nearestOnPath, type LL } from "./route-overview";
import type { TrackProgress } from "./track";
import type { FixLite } from "./boarding-detect";

/** 阈值（07 §8.7：可实施期微调） */
export const LRT_TOL_M = 120; // 离线可信门
export const LRT_H_MIN_M = 60; // 迟滞下限
export const LRT_ACC_MAX_M = 100; // 精度可信门

/** 站点里程阶梯（预计算一次） */
export interface LrtLadder {
  /** 本段乘车折线（GCJ-02） */
  path: LL[];
  /** 各站沿线里程（米）；无效站为 NaN */
  ladder: number[];
  /** 各站是否有效（参与推进） */
  valid: boolean[];
}

/**
 * 预计算站点里程阶梯（进入 riding 时算一次）。
 * @param colored 本段乘车折线（GCJ-02）
 * @param stops   各站坐标（GCJ-02）；缺失为 null
 */
export function buildLrtLadder(
  colored: LL[],
  stops: ({ lng: number; lat: number } | null)[],
): LrtLadder {
  const n = stops.length;
  const ladder: number[] = new Array(n).fill(Number.NaN);
  const valid: boolean[] = new Array(n).fill(false);
  if (colored.length < 2) return { path: [], ladder, valid };
  const cum = cumDistM(colored);

  let prev = -1;
  for (let i = 0; i < n; i++) {
    const s = stops[i];
    if (!s) continue;
    const proj = nearestOnPath(colored, s);
    if (proj.distM > LRT_TOL_M) continue; // 投影离站过远 ⇒ 剔除
    const d = cum[proj.idx];
    if (d <= prev) continue; // 单调化（乱序剔除）
    ladder[i] = d;
    valid[i] = true;
    prev = d;
  }
  return { path: colored, ladder, valid };
}

/** 自下标起首个有效站的相邻站距（米）—— 用于 H 计算；无相邻 ⇒ 0 */
function minAdjacentGap(ladder: number[], valid: boolean[], from: number): number {
  const prevD = Number.isFinite(ladder[from]) ? ladder[from] : 0;
  for (let i = from + 1; i < ladder.length; i++) {
    if (valid[i]) return Math.abs(ladder[i] - prevD);
  }
  return 0;
}

export interface LrtAdvanceInput {
  prevPassedIdx: number;
  prevComputed: number;
  prevDist: number;
  prevTs: number;
  /** 连续不可信帧数 */
  badStreak: number;
  ladder: LrtLadder;
  fix: FixLite | null;
}

export interface LrtAdvanceResult {
  passedIdx: number;
  computed: number;
  distNow: number;
  ts: number;
  badStreak: number;
  /** true = 本帧冻结 / 未推进（保留上次进度） */
  frozen: boolean;
  progress: TrackProgress;
}

const EMPTY: TrackProgress = { kind: "lost", passedIdx: -1, atIdx: null, nextIdx: null };

/**
 * 推进一帧。**纯函数**：调用方持有 `prev*` 状态并回写返回的 `passedIdx/computed/distNow/ts/badStreak`。
 */
export function advanceLrt(input: LrtAdvanceInput): LrtAdvanceResult {
  const { ladder, fix } = input;
  const lastIdx = ladder.ladder.length - 1;

  const makeProgress = (passedIdx: number): TrackProgress => {
    if (lastIdx < 0) return EMPTY;
    const nextIdx = passedIdx + 1 <= lastIdx ? passedIdx + 1 : null;
    return { kind: "between", passedIdx, atIdx: null, nextIdx };
  };

  /** 冻结：保留上次进度（badStreak 由调用方累加） */
  const frozen = (badStreak: number): LrtAdvanceResult => ({
    passedIdx: input.prevPassedIdx,
    computed: input.prevComputed,
    distNow: input.prevDist,
    ts: input.prevTs,
    badStreak,
    frozen: true,
    progress: makeProgress(input.prevPassedIdx),
  });

  if (!fix || ladder.path.length < 2) return frozen(input.badStreak + 1);

  const proj = nearestOnPath(ladder.path, fix);
  const off = proj.distM;
  const cum = cumDistM(ladder.path);
  const dNow = cum[proj.idx];

  // ① 可信门
  const trusted = off <= LRT_TOL_M && fix.accuracy <= LRT_ACC_MAX_M;
  if (!trusted) {
    const badStreak = input.badStreak + 1;
    if (badStreak >= 2) return frozen(badStreak); // 连续 2 帧不可信 ⇒ 冻结
    return {
      passedIdx: input.prevPassedIdx,
      computed: input.prevComputed,
      distNow: input.prevDist,
      ts: fix.ts,
      badStreak,
      frozen: false,
      progress: makeProgress(input.prevPassedIdx),
    };
  }

  // ② 速度合理性（异常大丢帧；异常小不推进）
  const dtSec = (fix.ts - input.prevTs) / 1000;
  if (input.prevTs > 0 && dtSec > 0) {
    const kmh = (Math.abs(dNow - input.prevDist) / dtSec) * 3.6;
    if (kmh > 80) return frozen(0); // 投影跳变 ⇒ 丢帧
  }

  // ③ Hysteresis
  const H = Math.max(
    LRT_H_MIN_M,
    fix.accuracy,
    0.25 * minAdjacentGap(ladder.ladder, ladder.valid, input.prevPassedIdx + 1),
  );

  // ④ 已过站 = max{ i : d_now > ladder[i] + H }
  let computed = -1;
  for (let i = 0; i < ladder.ladder.length; i++) {
    if (!ladder.valid[i]) continue;
    if (dNow > ladder.ladder[i] + H) computed = i;
  }

  // ⑤ 连续 2 帧一致才采纳；单帧最多推进 1 站
  let adopted = input.prevPassedIdx;
  if (computed === input.prevComputed) {
    adopted = Math.min(computed, input.prevPassedIdx + 1);
  }
  // ⑥ 回退（迟滞）：需明显低于
  if (computed < input.prevPassedIdx && dNow < ladder.ladder[input.prevPassedIdx] - H) {
    adopted = Math.max(computed, input.prevPassedIdx - 1);
  } else if (computed < input.prevPassedIdx) {
    adopted = input.prevPassedIdx;
  }

  return {
    passedIdx: adopted,
    computed,
    distNow: dNow,
    ts: fix.ts,
    badStreak: 0,
    frozen: false,
    progress: makeProgress(adopted),
  };
}
