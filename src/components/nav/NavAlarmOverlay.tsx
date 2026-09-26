"use client";

/**
 * 面板内容层浮层（src/components/nav/NavAlarmOverlay.tsx，2026-09-26 新增 · 需求③ / AC-34~36）
 *
 * ── 为什么独立成层（设计 §2.3「横幅浮层化」）─────────────────────────────
 *   横幅 / toast 原先在 `.route-sheet__scroll` 滚动流内 ⇒ 被滚走 + 出现/消失**推挤内容**
 *   （布局抖动）。现挂到 `.route-sheet__pane`（内容层，position:absolute）内、**滚动容器之外**，
 *   绝对定位于内容顶部 ⇒ 不参与滚动、不推挤内容。
 *
 * ── 三层（互斥/可叠加，均非模态 pointer-events:none 容器）──────────────
 *   · 下车横幅（`.nav-alarm-layer`，soon/now，`role="alert"`）；
 *   · 自动上车瞬态 toast（`.nav-toast-layer`，≤2.5s，含「不是这辆」纠错）；
 *   · 自动下车瞬态（`.nav-alight-layer`，`justAlighted`，含「还没到」撤销）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   全 Token 上色；无 emoji；`prefers-reduced-motion` 下停动画（globals.css 已覆盖）。
 */
import { useEffect, useState } from "react";
import AlightBanner from "./AlightBanner";
import Icon from "@/components/ui/Icon";
import type { SegmentStrip, RecommendCard } from "@/lib/recommend/types";
import type { RideTrackView } from "./useRideTracking";

export interface NavAlarmOverlayProps {
  track: RideTrackView | null;
  strips: SegmentStrip[] | null;
  card: RecommendCard;
}

export default function NavAlarmOverlay({ track, strips, card }: NavAlarmOverlayProps) {
  const legIdx = track?.legIndex ?? 0;
  const trackStops = strips?.[legIdx]?.stops ?? [];
  const legRide = card.rides[legIdx];
  const alightLabel =
    (trackStops.length ? trackStops[trackStops.length - 1].label : "") ||
    legRide?.alightLabel ||
    card.rides[0]?.alightLabel ||
    "";

  /** 自动上车瞬态反馈（2.5s 自动消失；可关闭） */
  const [toastDismissed, setToastDismissed] = useState(false);
  useEffect(() => {
    if (track?.phase === "riding" && track.autoSwitched && track.autoNote) {
      setToastDismissed(false);
      const t = window.setTimeout(() => setToastDismissed(true), 2500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [track?.phase, track?.autoSwitched, track?.autoNote]);
  const showToast =
    !!track && track.phase === "riding" && track.autoSwitched && !!track.autoNote && !toastDismissed;

  const showBanner = !!track && track.phase === "riding" && track.alarm !== "none";
  const showAlightDone = !!track && track.justAlighted;

  if (!showBanner && !showToast && !showAlightDone) return null;

  return (
    <>
      {/* 下车提醒横幅（警告色；绿只标记站名）—— 浮层，不参与滚动 */}
      {showBanner && track && (
        <div className="nav-alarm-layer">
          <AlightBanner alarm={track.alarm as "soon" | "now"} destLabel={alightLabel} />
        </div>
      )}

      {/* 自动上车瞬态反馈（非模态，role=status） */}
      {showToast && track && (
        <div className="nav-toast-layer">
          <div className="nav-toast" role="status">
            <span className="nav-toast__icon" aria-hidden="true">
              <Icon name="locate" size={20} />
            </span>
            <span className="nav-toast__text">{track.autoNote}</span>
            <button type="button" className="nav-toast__fix" onClick={track.onNotThisBus}>
              不是这辆
            </button>
            <button
              type="button"
              className="nav-toast__close"
              aria-label="关闭提示"
              onClick={() => setToastDismissed(true)}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        </div>
      )}

      {/* 自动下车瞬态（唯一纠错出口「还没到」= 撤销；按钮常驻防误判） */}
      {showAlightDone && track && (
        <div className="nav-alight-layer">
          <div className="nav-alight-done" role="status">
            <span className="nav-alight-done__text">已到站 · 导航结束</span>
            <button type="button" className="nav-alight-done__undo" onClick={track.onUndoAlight}>
              还没到
            </button>
          </div>
        </div>
      )}
    </>
  );
}
