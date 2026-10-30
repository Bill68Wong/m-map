"use client";

/**
 * 步行跟随顶部横幅（src/components/walk/WalkTurnBanner.tsx，v3.6.0 · S5 · 设计 §2.2）
 *
 * ── 四态一条横幅（绝不叠两条）──────────────────────────────────────────
 *   `turn`   正常跟随：转向图标 + 本步指令 + 「120 米」（绿 20px/700）
 *   `off`    偏离 > 50 米：黄底 + alertTriangle + 「已偏离路线 N 米」+「回到路线」
 *   `arrive` 最后一步完成：绿浅底 + 旗 + 「已到达 X」
 *   `manual` 定位不可用：surface-2 + infoCircle + 「定位不可用，无法跟随」+「重试」
 *
 * ── 三条硬约束（都踩过坑）─────────────────────────────────────────────
 *   ① **必须挂在 `.nav-map-wrap` 之外**：wrap 是层叠上下文，挂进去永远低于底部 chrome
 *      （`NavShell.tsx` 顶部注释记过两次教训）；本组件自己是 `position:fixed; z-index:__walkturn-z`。
 *   ② **投影只属于 `turn` 态**：`off/arrive/manual` 一律 `box-shadow:none` ——
 *      同色硬影在这里表达"正在跟随"（站牌被立起来），异常态撤影 = 自动降权。
 *   ③ **不脉动**：全屏只允许 `--track-alight-now` 一处脉动（下车是秒级安全事件，偏航不是）。
 *
 * ── AC-05：只用视觉 + 文字 ──────────────────────────────────────────────
 *   偏航**不加震动、不加提示音**（本组件无 `navigator.vibrate` 调用，也不得以后加）。
 *
 * ── 无障碍 ────────────────────────────────────────────────────────────
 *   整条 `role="status" aria-live="polite"`；指令文字必须成句可读（不得只有箭头图标），
 *   且字号 ≥16px（本规格 17px）。
 */
import Icon from "@/components/ui/Icon";
import type { WalkTurn } from "@/lib/walk/walk-shared";
import { distText } from "./WalkStepList";

const TURN_ICON: Record<WalkTurn, "turnStraight" | "turnLeft" | "turnRight" | "undo" | "walkArrive"> = {
  straight: "turnStraight",
  left: "turnLeft",
  right: "turnRight",
  uturn: "undo",
  arrive: "walkArrive",
};

export type WalkBannerState = "turn" | "off" | "arrive" | "manual";

export interface WalkTurnBannerProps {
  state: WalkBannerState;
  /** `turn` 态：本步指令（成句） */
  text?: string;
  /** `turn` 态：补充说明（高德 road_name） */
  sub?: string;
  /** `turn` 态：转向图标种类 */
  turn?: WalkTurn;
  /** `turn` 态：本步剩余米数 */
  distM?: number;
  /** `off` 态：偏离米数 */
  offM?: number;
  /**
   * ★ `off` 态的**替代文案**（不传 = 「已偏离路线 N 米」）。
   *   用途：本段重算额度用尽时换成定稿口径
   *   「步行路段暂时无法更新，可重新选择路线」——
   *   必须用现有横幅文案位，不新造弹层；且**不得**出现「失败/错误/超时/额度/配额/接口」等词。
   */
  offText?: string;
  /** `arrive` 态：目的地名 */
  destLabel?: string;
  /** `off` 态：「回到路线」 */
  onRecover?: () => void;
  /** `manual` 态：「重试」（重新申请/重定位） */
  onRetry?: () => void;
}

export default function WalkTurnBanner({
  state,
  text,
  sub,
  turn = "straight",
  distM = 0,
  offM = 0,
  destLabel,
  offText,
  onRecover,
  onRetry,
}: WalkTurnBannerProps) {
  /** 各态图标（`arrive` 用旗、`off` 用警示、`manual` 用 i；`turn` 用转向） */
  const icon =
    state === "arrive"
      ? "walkArrive"
      : state === "off"
        ? "alertTriangle"
        : state === "manual"
          ? "info-circle"
          : TURN_ICON[turn] ?? "turnStraight";

  const left =
    state === "arrive"
      ? `已到达${destLabel ? ` ${destLabel}` : ""}`
      : state === "off"
        ? (offText ?? `已偏离路线 ${Math.round(offM)} 米`)
        : state === "manual"
          ? "定位不可用，无法跟随"
          : (text ?? "");

  return (
    <div
      className="walkturn"
      data-state={state}
      role="status"
      aria-live="polite"
    >
      <span className="walkturn__mark" aria-hidden="true">
        <Icon name={icon} size={24} />
      </span>

      <span className="walkturn__body">
        <span className="walkturn__txt">{left}</span>
        {state === "turn" && sub ? <span className="walkturn__sub">{sub}</span> : null}
      </span>

      {state === "turn" && (
        <span className="walkturn__dist" aria-label={`还有 ${distText(distM)}`}>
          {distText(distM)}
        </span>
      )}

      {/* ★ `off` 态：**没有可执行动作就不渲染按钮**（额度用尽时点了也发不出请求 = 假按钮） */}
      {state === "off" && onRecover && (
        <button type="button" className="walkturn__act" onClick={onRecover}>
          回到路线
        </button>
      )}

      {state === "manual" && (
        <button type="button" className="walkturn__act" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}
