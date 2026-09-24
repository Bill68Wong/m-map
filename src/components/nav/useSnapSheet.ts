"use client";

/**
 * 三档可变高度面板 · 拖拽/吸附 hook（src/components/nav/useSnapSheet.ts，2026-09-23 新增）
 *
 * ── 从 `StepSheet` 的成熟实现抽出（`StepSheet.tsx:108-216`）────────────────
 *   Pointer Events（`setPointerCapture`，不用 touch/mouse 双绑）+ 方向锁（垂直分量优先）+
 *   越界 rubber-band + 「位移 + 速度」双判定吸附。
 *
 * ── 与 `StepSheet` 的差别（本轮口径）────────────────────────────────────
 *   · **三档**（full / half / peek，非等距）而非两点；阈值**逐对现算** `0.28 × 相邻档距`；
 *   · 位移走 **`transform: translateY(--sheet-y-anim)`**（GPU 合成，不动画 top/height）；
 *   · `--sheet-y-layout` 仅在**档位落定**时同步（喂滚动容器 padding，拖动中不动 ⇒ 零重排）；
 *   · 拖动中 `data-dragging="on"`（CSS `transition:none` ⇒ **0ms 跟手**），释放后 260ms 标准缓动；
 *   · 关闭是 **contextual**：仅最低档 peek 才允许「继续下拉关闭」，动作由调用方按 pane 决定。
 *
 * ── 关键参数（锁定）────────────────────────────────────────────────────
 *   换档阈值 = `0.28 × 相邻档距`；flick = `|v| > 0.5px/ms`；关闭 = peek 下拖 > 96px
 *   或 `v > 0.5 && 位移 > 32px`；速度投影 120ms（允许一次跨两档）。
 */
import { useEffect, useRef, useState } from "react";
import { DETENTS, type Detent } from "./sheet-detents";

/** 起拖区高度（px）：grip + 头部（命中区 ≥44×24） */
const HANDLE_H = 56;
/** 越界橡皮筋阻尼（1/3） */
const RUBBER = 1 / 3;
/** flick 速度阈值（px/ms） */
const FLICK_V = 0.5;
/** 换档位移比例（× 相邻档距） */
const SWITCH_RATIO = 0.28;
/** 速度投影时长（ms）—— 决定 flick 能否跨两档 */
const PROJECT_MS = 120;
/** peek 继续下拉关闭：位移阈值（px） */
const CLOSE_DIST = 96;
/** peek 继续下拉关闭：flick 判定所需最小位移（px） */
const CLOSE_MIN_DIST = 32;

export interface UseSnapSheetOpts {
  /** 面板是否打开（关闭时 translateY 推到 100dvh） */
  open: boolean;
  /** 当前档（受控） */
  detent: Detent;
  /** 各档顶边像素（升序，与 DETENTS 对齐） */
  topsPx: number[];
  onDetentChange: (d: Detent) => void;
  /** contextual 关闭（pane 决定语义；调用方处理） */
  onDismiss: () => void;
}

export interface UseSnapSheet {
  dragging: boolean;
  /** 面板当前 translateY（px）—— 每帧更新，只喂 transform */
  translateY: number;
  /** 滚动容器需补的 padding（px）—— 仅档位落定变化 */
  layoutY: number;
  /** peek 区「点一下回默认档」是否有效（刚发生过拖拽 ⇒ false，避免拖完误触） */
  tapOk: () => boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function useSnapSheet(opts: UseSnapSheetOpts): UseSnapSheet {
  const { open, detent, topsPx, onDetentChange, onDismiss } = opts;
  const [dragPx, setDragPx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const moved = useRef(false);
  const drag = useRef({
    y0: 0,
    x0: 0,
    t0: 0,
    on: false,
    decided: false,
    rawDy: 0,
    dispDy: 0,
  });

  const last = Math.max(0, topsPx.length - 1);
  const index = Math.min(last, Math.max(0, DETENTS.indexOf(detent)));
  const cur = topsPx[index] ?? 0;
  const winH = topsPx.length ? topsPx[topsPx.length - 1] / 0.8 : 844;

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    /**
     * ★ 2026-09-23：**交互控件不启动拖拽**（否则鼠标口径下头部按钮点击被吞）。
     * 根因：整条 bar（含返回箭头 / 关闭 X / 刷新）都包在 `.route-sheet__handle` 里，
     *   而本函数**无条件** `setPointerCapture` 到 handle ⇒ pointerup/click 被重定向到 handle、
     *   按钮的 native click **触发 0 次**（触摸口径因 click 合成规则不同而侥幸正常）。
     * ⇒ pointerdown 落点在 button/a/input/select/textarea 上时**直接放行**，让按钮正常 click。
     */
    const t = e.target as Element | null;
    if (t && typeof t.closest === "function" && t.closest("button,a,input,select,textarea")) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // 只在「grip + 头部」区起拖 —— 其余交给内容滚动 / 列表
    if (e.clientY - rect.top > HANDLE_H) return;
    drag.current = {
      y0: e.clientY,
      x0: e.clientX,
      t0: performance.now(),
      on: true,
      decided: false,
      rawDy: 0,
      dispDy: 0,
    };
    moved.current = false;
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d.on) return;
    const dyRaw = e.clientY - d.y0;
    const dx = e.clientX - d.x0;
    if (!d.decided) {
      if (Math.abs(dyRaw) < 6) return;
      if (Math.abs(dx) > Math.abs(dyRaw)) {
        d.on = false; // 横向为主 → 放弃接管
        setDragging(false);
        setDragPx(0);
        return;
      }
      d.decided = true;
    }
    moved.current = true;
    // 越界阻尼：上界 full / 下界 peek
    const minDy = -(cur - (topsPx[0] ?? 0));
    const maxDy = (topsPx[last] ?? cur) - cur;
    let v = dyRaw;
    if (v < minDy) v = minDy + (v - minDy) * RUBBER;
    if (v > maxDy) v = maxDy + (v - maxDy) * RUBBER;
    d.rawDy = dyRaw;
    d.dispDy = v;
    setDragPx(v);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d.on) return;
    d.on = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDragging(false);
    setDragPx(0);

    const rawDy = d.rawDy;
    const dt = Math.max(1, performance.now() - d.t0);
    const v = rawDy / dt; // px/ms，向下为正

    // ① contextual 关闭：仅最低档 peek 才允许「继续下拉关闭」
    if (index === last && (rawDy > CLOSE_DIST || (v > FLICK_V && rawDy > CLOSE_MIN_DIST))) {
      onDismiss();
      return;
    }

    // ② 吸附：「结束位置 + 速度投影」落点取最近可用档
    const projected = cur + rawDy + v * PROJECT_MS;
    let nearest = 0;
    let nd = Infinity;
    for (let i = 0; i < topsPx.length; i++) {
      const dd = Math.abs(topsPx[i] - projected);
      if (dd < nd) {
        nd = dd;
        nearest = i;
      }
    }
    const dir = projected > cur ? 1 : -1;
    const adjIdx = index + dir;
    // 越界（已在端点同向拖）或未变档 → 回弹当前档
    if (nearest === index || adjIdx < 0 || adjIdx > last) {
      onDetentChange(DETENTS[index]);
      return;
    }
    const adjGap = Math.abs((topsPx[adjIdx] ?? cur) - cur);
    const fast = Math.abs(v) > FLICK_V;
    if (fast || Math.abs(projected - cur) > SWITCH_RATIO * adjGap) {
      onDetentChange(DETENTS[Math.max(0, Math.min(last, nearest))]);
    } else {
      onDetentChange(DETENTS[index]); // 未达阈值 → 弹回
    }
  }

  // 键盘：Esc = contextual 关闭；↑/↓ 在档间切换（桌面/外接键盘）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onDismiss();
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const i = DETENTS.indexOf(detent);
      const next = e.key === "ArrowUp" ? Math.max(0, i - 1) : Math.min(DETENTS.length - 1, i + 1);
      onDetentChange(DETENTS[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, detent, onDetentChange, onDismiss]);

  return {
    dragging,
    translateY: open ? cur + dragPx : winH, // 关闭 → 100dvh（推出视口）
    layoutY: cur,
    tapOk: () => !moved.current,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
