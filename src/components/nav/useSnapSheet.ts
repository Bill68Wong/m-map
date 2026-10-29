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
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
  /**
   * ★ v3.6.0 S5：**允许停靠的档位**（可选）。walk 态要求「强制 half、允许 full、禁 peek」，
   *   而 peek 会把"当前步"藏掉，所以必须从**可停靠集合**里排除，而不是只挡一处。
   *
   * ⚠️ **不传时行为必须一行不变**（其余 pane 完全不受影响）—— 这是硬要求：
   *   下面 `allowedIdx` 在不传时 = 全部档位，所有分支退化成与原来完全相同的算术。
   * 传了之后**三处都按它走**：① 越界阻尼上下界 ② flick / 阈值吸附的目标档 ③ 键盘 ↑↓。
   */
  allowedDetents?: Detent[];
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

/**
 * 从 `from` 往 `dir` 方向的**下一个允许档**下标（无则原样返回）。
 *
 * ★ 刻意放在**模块级**（纯函数、无闭包）：若写成组件内箭头函数，
 *   键盘监听的 effect 会因"每次渲染新建函数"而被迫把它列进 deps（或留着 accepted-stale-closure），
 *   两种都不好。纯函数 + 显式传参 ⇒ deps 只需真实输入 `allowedDetents`，lint 也干净。
 */
function nextAllowedOf(allowed: number[], from: number, dir: 1 | -1, last: number): number {
  for (let i = from + dir; i >= 0 && i <= last; i += dir) {
    if (allowed.includes(i)) return i;
  }
  return from;
}

export function useSnapSheet(opts: UseSnapSheetOpts): UseSnapSheet {
  const {
    open,
    detent,
    topsPx,
    onDetentChange,
    onDismiss,
    dismissible = true,
    sheetRef,
    allowedDetents,
  } = opts;
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

  /**
   * 可停靠档位的**下标集合**（升序）。
   * 不传 `allowedDetents` ⇒ `[0..last]`（= 原来行为，零差异）；
   * 传了就取它在 `DETENTS` 里的下标并去重排序；**过滤后为空则回落全部**（防调用方传空数组导致面板卡死）。
   */
  const allowedIdxKey = (allowedDetents ?? []).join(",");
  const allowedIdx = useMemo(() => {
    const all = Array.from({ length: last + 1 }, (_, i) => i);
    if (!allowedDetents || allowedDetents.length === 0) return all;
    const set = new Set<number>();
    for (const d of allowedDetents) {
      const i = DETENTS.indexOf(d);
      if (i >= 0 && i <= last) set.add(i);
    }
    const arr = [...set].sort((a, b) => a - b);
    return arr.length ? arr : all; // 过滤后为空 ⇒ 回落全部（防调用方传空数组把面板卡死）
    // 依赖用字符串键：调用方若传字面量数组，每次渲染都是新引用 ⇒ 用 join 稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowedIdxKey, last]);
  /** 允许范围的两端（阻尼边界用） */
  const allowedMin = allowedIdx[0] ?? 0;
  const allowedMax = allowedIdx[allowedIdx.length - 1] ?? last;
  const index = Math.min(last, Math.max(0, DETENTS.indexOf(detent)));
  const cur = topsPx[index] ?? 0;
  const winH = topsPx.length ? topsPx[topsPx.length - 1] / 0.8 : 844;

  /** 命令式写面板位移（GPU 合成；拖动中每帧调用，不触发 React 渲染）
   *  ★ 2026-09-26（P1-②）：**同时镜像到 `document.documentElement`** —— 供「随面板避让」的浮层
   *  （★ v3.2.0 起为页面级 `.nav-locate-fab`；此前为 `.nav-map__recenter`）读取 `bottom` 公式
   *  （这些浮层不在 `.route-sheet` 子树内，拿不到面板内联变量；走根继承）。
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
   * 用途：页面级浮层（★ v3.2.0 起为 `.nav-locate-fab`）不在 `.route-sheet` 子树内，无法用
   *   `[data-dragging]` 选择器选中；它需要「拖动期 0ms 跟手 / 落定期与面板同缓动」——
   *   借此属性区分（与面板同步、无跑位）。
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
    // 越界阻尼：上界 = 允许的最高档 / 下界 = 允许的最低档（不传 allowedDetents 时即 full / peek）
    const minDy = -(cur - (topsPx[allowedMin] ?? 0));
    const maxDy = (topsPx[allowedMax] ?? cur) - cur;
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
    /** ★ 只在**允许档**里找最近（禁 peek 时 peek 不参与竞争） */
    let nearest = allowedIdx[0] ?? 0;
    let nd = Infinity;
    for (const i of allowedIdx) {
      const dd = Math.abs((topsPx[i] ?? 0) - projected);
      if (dd < nd) {
        nd = dd;
        nearest = i;
      }
    }
    const dir: 1 | -1 = projected > cur ? 1 : -1;
    /** 下一个**允许**档（旧实现是 index ± 1；不传 allowedDetents 时两者完全等价） */
    const adjIdx = nextAllowedOf(allowedIdx, index, dir, last);
    // 越界（已在允许范围的端点同向拖）或未变档 → 回弹当前档
    if (nearest === index || adjIdx === index) {
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
      /** ★ 键盘也只走允许档（与拖拽同一集合，避免"键盘能到 peek、拖拽到不了"） */
      const next = nextAllowedOf(allowedIdx, i, e.key === "ArrowUp" ? -1 : 1, last);
      if (next === i) return;
      onDetentChange(DETENTS[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    /**
     * 依赖里放 `allowedDetents`（真正的外部输入）而不是 `nextAllowed`（每次渲染新建的闭包）；
     * 否则 walk 态切换导致的可停靠集合变化不会让键盘监听重建 ⇒ 闭包里还是旧的 allowedIdx。
     */
  }, [open, detent, onDetentChange, onDismiss, allowedIdx, last]);

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
