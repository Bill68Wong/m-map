"use client";

/**
 * 面板内容层浮层（src/components/nav/NavAlarmOverlay.tsx，2026-09-26 新增 · 需求③ / AC-34~36）
 *
 * ── 为什么独立成层（设计 §2.3「横幅浮层化」）─────────────────────────────
 *   原先在 `.route-sheet__scroll` 滚动流内 ⇒ 被滚走 + 出现/消失**推挤内容**（布局抖动）。
 *   现挂到 `.route-sheet__pane`（内容层，position:absolute）内、**滚动容器之外**，绝对定位于
 *   内容顶部 ⇒ 不参与滚动、不推挤内容。
 *
 * ── 本层保留（★ v3.2.0 拆分后）────────────────────────────────────────────
 *   · 自动上车瞬态 toast（`.nav-toast-layer`，≤2.5s，含「不是这辆」纠错）；
 *   · 自动下车瞬态（`.nav-alight-layer`，`justAlighted`，含「还没到」撤销）。
 *   ⇒ 二者为**反馈级**瞬态，留在面板内（架构师 02 §8.1 / 03 §2.5）。
 *
 * ── ◇ 已迁出 ─────────────────────────────────────────────────────────────
 *   **下车提醒横幅**（安全级）已迁至**页面级顶部** `.nav-alarm--top`（由 `NavShell` 承载、
 *   `AlightBanner` 渲染，AC-81/82）—— 面板内不再渲染横幅。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   全 Token 上色；无 emoji；`prefers-reduced-motion` 下停动画（globals.css 已覆盖）。
 */
import { useEffect, useState } from "react";
import Icon from "@/components/ui/Icon";
import type { RideTrackView } from "./useRideTracking";

export interface NavAlarmOverlayProps {
  track: RideTrackView | null;
}

export default function NavAlarmOverlay({ track }: NavAlarmOverlayProps) {
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

  const showAlightDone = !!track && track.justAlighted;

  if (!showToast && !showAlightDone) return null;

  return (
    <>
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
