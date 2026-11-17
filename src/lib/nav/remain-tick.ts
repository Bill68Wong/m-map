/**
 * 「时钟该不该开、开多快」的唯一判据（src/lib/nav/remain-tick.ts，★ 2026-11-13 · R1 阶段2）
 *
 * ── 为什么值得单独成模块 ────────────────────────────────────────────────
 *   原先这条判断散在 `RouteSheet` 的 effect 里（`needTick` + 固定 1000ms），
 *   而它同时决定三件事：详情头与 peek 摘要的「现在」是否更新、多久更新一次、
 *   以及「已到站就别再算了」。**散在 effect 里就没法测** —— 只能靠真机盯屏。
 *   抽成纯函数后，「走完 ⇒ 停」「又走动 ⇒ 恢复」「阈值抖动」三种状态都能在脚本里验。
 *
 * ── 两档周期的理由（不是拍脑袋）────────────────────────────────────────
 *   · **1s**：屏上数字会因「时间流逝」或「用户移动」每秒变化 —— 即
 *     `peek`（摘要可见）/ `riding`（新鲜度秒数 + 服务端 12s 重算之间的插值）/
 *     `done` 且末段步行还剩 ≥1 分 / `off`·`boarding` 且**有实时值**。
 *   · **15s**：只剩「规划快照按时间递减」在用（无实时分量、或末段步行几何缺失），
 *     1s 重算一遍未 memo 的子树是纯浪费。15s 是 `NavDetailBody` 改造前的原生心跳。
 *   · **0（不开）**：屏上没有任何会变的数字。两种来源：面板不可见；或
 *     `done` 且末段步行**已走完**（剩余取整为 0 ⇒ 只剩「即将到达」）。
 *
 * ── 为什么「停」用 `walkInLiveMin < ARRIVED_BELOW_MIN` 而不是「上屏值 == 0」──────
 *   上屏值本身由这个时钟算出来 —— 用它当停条件会自指（先决定开不开、才能算出值）。
 *   用**输入侧**的原始分钟数当判据，逻辑是单向的，可测。
 *
 * 纯函数：无 `Date.now()`、无副作用、同一输入恒同一输出（无滞后状态）。
 *   ⚠️ 「无滞后」是刻意的：抖动时会来回切，但每次切换都只是重建一个 interval，
 *   没有累积状态 ⇒ 不会出现「切过去就回不来」的单向锁存。
 */
import { ARRIVED_BELOW_MIN } from "./remaining-view";

/** 时钟节拍（0 = 不开） */
export type TickPeriodMs = 0 | 1000 | 15_000;

export interface TickPlanInput {
  /** 详情 pane 是否可见（`pane === "detail" && !!detail`） */
  detailVisible: boolean;
  /** 是否停在 peek 档（摘要可见） */
  peek: boolean;
  /** 乘车相位；`null` = 未知（当作无实时值） */
  ridePhase: "off" | "boarding" | "riding" | "done" | null;
  /** 末段步行实时剩余分钟（`null` = 无几何 / 判不出来） */
  walkInLiveMin: number | null;
  /** `off` / `boarding` 的实时总剩余分钟（`null` = 不可用，走静态回落） */
  preRideLiveMin: number | null;
}

export interface TickPlan {
  /** 是否开时钟 */
  tick: boolean;
  /** 周期（`tick === false` 时为 0） */
  periodMs: TickPeriodMs;
  /** 为什么不开（诊断用；`tick === true` 时为 undefined） */
  skippedBy?: "hidden" | "walkTailSettled";
}

/**
 * 判据唯一出口。
 * @see 文件头「两档周期的理由」
 */
export function tickPlanOf(input: TickPlanInput): TickPlan {
  const walkLive = Number.isFinite(input.walkInLiveMin as number) ? (input.walkInLiveMin as number) : null;
  const preLive = Number.isFinite(input.preRideLiveMin as number) ? (input.preRideLiveMin as number) : null;

  /** ① 面板不可见 ⇒ 什么都不用算（两个渲染位都看不到） */
  if (!input.detailVisible && !input.peek) return { tick: false, periodMs: 0, skippedBy: "hidden" };

  /**
   * ② `done` 且末段步行**已走完** ⇒ 停（屏上只剩「即将到达」）。
   *   必须在「peek」之前判：peek 摘要此时同样没有会变的数字。
   *   用户再次走动 ⇒ `walkLive` 回到 ≥ 阈值 ⇒ 下一次调用自然恢复（无状态，所以不会锁死）。
   */
  if (input.ridePhase === "done" && walkLive !== null && walkLive < ARRIVED_BELOW_MIN) {
    return { tick: false, periodMs: 0, skippedBy: "walkTailSettled" };
  }

  /** ③ 1s 档 */
  const fast =
    input.peek ||
    input.ridePhase === "riding" ||
    (input.ridePhase === "done" && walkLive !== null) ||
    ((input.ridePhase === "off" || input.ridePhase === "boarding") && preLive !== null);

  return { tick: true, periodMs: fast ? 1000 : 15_000 };
}
