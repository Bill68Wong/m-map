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
 *
 * ── ★ 2026-09-25：拖动位移**改走命令式**（不每帧 `setState`）────────────────
 *   根因（用户实测：「拖动弹窗后面的地图会抖动」）：原实现 `onPointerMove` 每帧 `setDragPx`
 *   ⇒ `RouteSheet` 整棵子树（推荐列表 + 详情主体：站条 / 折叠区 / 操作条）**逐帧 reconcile**，
 *   主线程被占满 ⇒ 高德画布/瓦片的渲染循环被饿死 ⇒ 视觉「地图抖」。此法与项目自身「拖拽期
 *   零 JS、零 React 更新」（`VehicleLayer` 注释）冲突。
 *   ⇒ 拖动中**只写 `--sheet-y-anim`**（`sheetRef` 直改 DOM，与既有注释口径一致：「位移走
 *   transform」）；React 状态仅在**起拖 / 释放**各变一次（`dragging`）。落定/开合由 effect +
 *   React style 双写同值（幂等），保证回弹也能被 260ms 过渡接住。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
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
  /**
   * ★ 2026-09-24：是否允许「最低档继续下拉关闭」。
   *   推荐 pane 传 `false` ⇒ 拉到底**硬停/回弹**（不再整体拖没）；详情 pane 传 `true`（下拉 = 回推荐）。
   */
  dismissible?: boolean;
  /**
   * ★ 2026-09-25：`.route-sheet` 根元素 ref —— 拖动中**直接命令式**写 `--sheet-y-anim`
   *   （不触发 React 重渲染 ⇒ 主线程不阻塞地图渲染循环）。
   */
  sheetRef?: RefObject<HTMLElement | null>;
}

export interface UseSnapSheet {
  dragging: boolean;
  /** 面板**落定** translateY（px）—— 只喂初始/落定 transform；拖动跟手值走命令式 `--sheet-y-anim` */
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
  const { open, detent, topsPx, onDetentChange, onDismiss, dismissible = true, sheetRef } = opts;
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

  /** 命令式写面板位移（GPU 合成；拖动中每帧调用，不触发 React 渲染）
   *  ★ 2026-09-26（P1-②）：**同时镜像到 `document.documentElement`** —— 供 `.nav-map__recenter`
   *  「动态贴可见地图区下沿」读取（地图子树不在 `.route-sheet` 内，拿不到面板内联变量；走根继承）。
   *  仍为零 React 更新（直接 `style.setProperty`）。 */
  const paint = (y: number) => {
    const px = `${Math.round(y)}px`;
    sheetRef?.current?.style.setProperty("--sheet-y-anim", px);
    if (typeof document !== "undefined") {
      document.documentElement.style.setProperty("--sheet-y-anim", px);
    }
  };

  /** 卸载兜底：清掉根上的 `--sheet-y-anim`（回落 `fallback` = 面板关闭态行为） */
  useEffect(() => {
    return () => {
      try {
        document.documentElement.style.removeProperty("--sheet-y-anim");
        delete document.documentElement.dataset.sheetDragging;
      } catch {
        /* ignore */
      }
    };
  }, []);

  /**
   * ★ 2026-09-26（P1-②）：把「拖动中」也镜像到 `<html>`（`data-sheet-dragging`）。
   * 用途：`.nav-map__recenter` 不在 `.route-sheet` 子树内，无法用 `[data-dragging]` 选择器选中；
   *   它需要「拖动期 0ms 跟手 / 落定期与面板同缓动」—— 借此属性区分（与面板同步、无跑位）。
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.sheetDragging = dragging ? "on" : "off";
    return () => {
      delete document.documentElement.dataset.sheetDragging;
    };
  }, [dragging]);

  /**
   * 落定 / 开合时把位移刷回目标值：
   *   · 拖动中（`dragging`）不刷 ⇒ 不覆盖命令式的跟手值；
   *   · 释放后刷 ⇒ 未换档的「回弹」也能被 260ms 过渡接住（React style 不写「无变化」的 var）。
   */
  useEffect(() => {
    if (dragging) return;
    paint(open ? cur : winH);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, open, cur, winH]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    /**
     * ★ 2026-09-24：**桌面（≥1024）忽略整段拖拽手势**。
     *   桌面端 CSS 把面板固定为右上栏（`transform:none`、不做 peek）——拖 handle
     *   不会改变面板视觉，却会改档位 ⇒ 触发地图重取景（用户实测反馈：
     *   「拖动调整弹窗时后面的地图也会动」）。档位在桌面仅由程序控制。
     */
    if (typeof window !== "undefined" && window.matchMedia?.("(min-width: 1024px)").matches) return;
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
        paint(cur);
        setDragging(false);
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
    // ★ 命令式跟手（不 setState ⇒ 拖动期零 React 更新；不动画 top/height）
    paint(cur + v);
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
    setDragging(false); // 落定目标由下方 effect 命令式刷回（含未换档「回弹」）

    const rawDy = d.rawDy;
    const dt = Math.max(1, performance.now() - d.t0);
    const v = rawDy / dt; // px/ms，向下为正

    // ① contextual 关闭：仅最低档 peek **且 dismissible** 才允许「继续下拉关闭」
    //    ★ 2026-09-24：推荐 pane 传 dismissible=false ⇒ 拉到底硬停（走下方回弹分支落回 peek），
    //    不再"整体拖没"；关闭改走 X 键。详情 pane 保持 true（下拉 = 回推荐）。
    if (dismissible && index === last && (rawDy > CLOSE_DIST || (v > FLICK_V && rawDy > CLOSE_MIN_DIST))) {
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
    /**
     * 落定位移（拖动中不参与渲染 —— 拖动值由 `paint()` 命令式写 `--sheet-y-anim`）。
     * React 仅在**值变化**时写该 var ⇒ 拖动期不会覆盖命令式跟手值；落定/回弹由 effect 兜底。
     */
    translateY: open ? cur : winH, // 关闭 → 100dvh（推出视口）
    layoutY: cur,
    tapOk: () => !moved.current,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
