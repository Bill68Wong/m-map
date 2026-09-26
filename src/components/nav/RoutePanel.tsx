"use client";

/**
 * 下半屏起终点面板（src/components/nav/RoutePanel.tsx，2026-09-22 搜索界面重构）
 *
 * ── 它是什么 ──────────────────────────────────────────────────────────
 *   新交互的「半屏态」：**弹窗覆盖在地图下半部分**，上半屏留给地图。
 *   面板里是「出发地 / 目的地」两行 + 「出发」按钮 —— 与高德/谷歌选完点后的形态一致。
 *
 * ── 下拉手势（产品口径 2026-09-22）────────────────────────────────────
 *   · **半屏时往下拉** → 面板收起 ⇒ **近乎全屏展示地图**（方便看两点位置）；
 *   · 收起后顶部留一条**细把手**，点它重新展开；
 *   · 手势只覆盖「把手 + 头部」区（`HANDLE_H`），不抢下面按钮的点击。
 *   ⚠️ 旧版那套「三个吸附点 + 惯性 + 橡皮筋」已按产品口径**整体废弃**，这里只保留
 *     「下拉收起 / 点把手展开」两态。
 */
import { useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import { endpointOf } from "@/lib/favorites/types";
import type { NavPoint } from "@/lib/nav/types";

/** 起拖区高度（px）：把手 + 头部 */
const HANDLE_H = 48;
/** 下拖超过此像素 ⇒ 收起 */
const COLLAPSE_PX = 60;

export interface RoutePanelProps {
  dest: NavPoint | null;
  from: NavPoint | null;
  userPos: { lng: number; lat: number } | null;
  canGo: boolean;
  going: boolean;
  /** 查询串（收藏按钮用）—— 由父组件按统一口径生成 */
  query: string;
  onGo: () => void;
  /** 点出发地行 ⇒ 打开全屏搜索（选出发地） */
  onTapFrom: () => void;
  /** 点目的地行 ⇒ 打开全屏搜索（换目的地） */
  onTapDest: () => void;
}

export default function RoutePanel({
  dest,
  from,
  userPos,
  canGo,
  going,
  /* `query` 仍为可选 prop（兼容调用方）；v3.3.0 起收藏按钮不再需要它（只收组合 OD） */
  onGo,
  onTapFrom,
  onTapDest,
}: RoutePanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [dragPx, setDragPx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ y0: 0, on: false });

  const myLocation: NavPoint | null = userPos
    ? { kind: "gps", label: "我的位置", lng: userPos.lng, lat: userPos.lat }
    : null;
  const effectiveFrom = from ?? myLocation;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientY - rect.top > HANDLE_H) return; // 只让把手/头部起拖
    drag.current = { y0: e.clientY, on: true };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.on) return;
    const dy = e.clientY - drag.current.y0;
    if (dy > 0) setDragPx(dy); // 只接受向下
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current.on) return;
    drag.current.on = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDragging(false);
    if (dragPx > COLLAPSE_PX) setCollapsed(true);
    setDragPx(0);
  }

  // ── 收起态：只留一条细把手（点它展开）──
  if (collapsed) {
    return (
      <section className="rpanel rpanel--collapsed" aria-label="起终点面板（已收起）">
        <button
          type="button"
          className="rpanel__expandbar"
          onClick={() => setCollapsed(false)}
          aria-label="展开起终点面板"
        >
          <span className="rpanel__grip" aria-hidden="true" />
          <span className="rpanel__expandtext t-label">
            {effectiveFrom?.label ?? "出发地"} <span className="t-muted">→</span> {dest?.label ?? "目的地"}
          </span>
          <Icon name="arrowUp" size={16} />
        </button>
      </section>
    );
  }

  return (
    <section
      className="rpanel"
      aria-label="规划路线"
      data-dragging={dragging ? "on" : undefined}
      style={dragPx ? { transform: `translateY(${dragPx}px)` } : undefined}
    >
      <div
        className="rpanel__handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="rpanel__grip" aria-hidden="true" />
      </div>

      <div className="rpanel__body">
        <button type="button" className="rpanel__row" onClick={onTapFrom}>
          <span className="rpanel__dot rpanel__dot--from" aria-hidden="true" />
          <span className="rpanel__label t-label">出发地</span>
          <span className={`rpanel__value${from ? "" : " rpanel__value--gps"}`}>
            {effectiveFrom?.label ?? "选择出发地"}
          </span>
          <Icon name="arrowRight" size={16} />
        </button>

        <button type="button" className="rpanel__row" onClick={onTapDest}>
          <span className="rpanel__dot rpanel__dot--to" aria-hidden="true" />
          <span className="rpanel__label t-label">目的地</span>
          <span className="rpanel__value">{dest?.label ?? "选择目的地"}</span>
          <Icon name="arrowRight" size={16} />
        </button>

        <div className="rpanel__actions">
          <button
            type="button"
            className="btn btn--primary btn--block btn--lg"
            disabled={!canGo || going}
            onClick={onGo}
          >
            {going ? "正在规划…" : "出发"}
          </button>
          {/* ★ v3.3.0（AC-115）：v3 起 = 只收藏「组合」（OD） */}
          {effectiveFrom && dest && (
            <FavoriteButton
              from={endpointOf(effectiveFrom)}
              to={endpointOf(dest)}
              withLabel
              className="fav-btn--block"
            />
          )}
        </div>
      </div>
    </section>
  );
}
