/**
 * 全自动下车判定（src/lib/nav/alight-detect.ts，2026-09-26 新增 · 需求⑨ / AC-55）
 *
 * ── 职责（05-Spec §4.3 / 07 §2.f）──────────────────────────────────────
 *   把「到站即自动下车」的判据抽成**纯函数**（可单测、可关开关），供 `useRideTracking` 调用：
 *     · 车辆源：车**停靠在本段下车站**（`atIdx === lastIdx`）；
 *     · GPS 源：用户沿线里程**越过下车站 ≥ 30m**（`dNow >= dAlight + 30`）；
 *     · **多帧确认**（连续 2 帧命中才判）；**环线排除**（首尾同站恒不判）；**冻结不判**。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **client-safe 纯函数**：不 import `pg` / server-only；坐标一律 GCJ-02；
 *   · **宁可晚判、不误判**：多帧确认 + 冻结不判 + 环线排除；
 *   · 一切「对不上」都如实返回（`reason`），**绝不猜测**（沿用项目铁律）。
 */

/** 连续命中帧数 */
export const ALIGHT_CONFIRM = 2;
/** GPS 越过下车站的距离阈值（米）——≥ 此值视为已下车 */
export const ALIGHT_GPS_OVER_M = 30;
/** 预留：时间保持窗口（当前不要求时间保持，置 0） */
export const ALIGHT_HOLD_MS = 0;

export interface AlightInput {
  /** 进度来源 */
  source: "vehicle" | "gps";
  /** 本段下车站下标 = `stopMains.length - 1` */
  lastIdx: number;
  /** 车辆源：当前停靠站下标（`null` = 行驶中/未知） */
  atIdx: number | null;
  /** 已驶过（保留字段，供诊断） */
  passedIdx: number;
  /** GPS 源：用户沿线里程（米） */
  dNow: number | null;
  /** GPS 源：下车站沿线里程（`ladder[lastIdx]`） */
  dAlight: number | null;
  /** 环线（首尾同站）⇒ 恒不判（避免起点即终点误判） */
  loop: boolean;
  /** 冻结 / 丢信号 ⇒ 不判（保留横幅提醒） */
  frozen: boolean;
  /** 调用方维护的连续命中帧数 */
  streak: number;
}

export type AlightReason =
  | "at_alight"
  | "passed_alight"
  | "none"
  | "loop"
  | "frozen"
  | "unsat";

export interface AlightResult {
  hit: boolean;
  /** 更新后的连续命中帧数 */
  streak: number;
  reason: AlightReason;
}

/**
 * 自动下车判定（纯函数）。
 * · 环线 / 冻结 / 段太短（`lastIdx < 1`）⇒ 直接不判（`streak` 归零）；
 * · 瞬时命中 ⇒ `streak += 1`，达到 `ALIGHT_CONFIRM` ⇒ `hit: true`。
 */
export function autoAlightOf(input: AlightInput): AlightResult {
  if (input.loop) return { hit: false, streak: 0, reason: "loop" }; // 环线排除
  if (input.frozen) return { hit: false, streak: 0, reason: "frozen" }; // 冻结不判
  if (input.lastIdx < 1) return { hit: false, streak: 0, reason: "unsat" };

  let inst = false;
  if (input.source === "vehicle") {
    inst = input.atIdx === input.lastIdx; // 停靠在下车站
  } else {
    inst =
      input.dNow != null && input.dAlight != null && input.dNow >= input.dAlight + ALIGHT_GPS_OVER_M;
  }

  const streak = inst ? input.streak + 1 : 0;
  if (streak >= ALIGHT_CONFIRM) {
    return {
      hit: true,
      streak,
      reason: input.source === "vehicle" ? "at_alight" : "passed_alight",
    };
  }
  return {
    hit: false,
    streak,
    reason: inst ? (input.source === "vehicle" ? "at_alight" : "passed_alight") : "none",
  };
}
