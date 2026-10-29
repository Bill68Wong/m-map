"use client";

/**
 * 步行三种路的折线绘制（src/components/nav/nav-map-walk.ts，v3.6.0 · S5 · 设计 §2.3）
 *
 * ── 口径（架构锁定，**不得出现别名**）───────────────────────────────────
 *   地图上是**三条各自独立的 `AMap.Polyline`**，不是"同一条折线切三份"：
 *     `donePath`  已走过（**累积、单调增长**）  灰   w5 op0.85 z69
 *     `aheadPath` 后续步（尚未开始）            绿   w5 op0.55 z70
 *     `nowPath`   当前步**剩余**部分            绿   w7 op1.00 z73（带 showDir）
 *
 * ── 切分规则（容易写反）──────────────────────────────────────────────────
 *   · `nowPath` = 当前步折线按 `ratio` 切开后的**后半**（还没走的那截）；
 *   · `donePath` **不参与任何切分** —— 每帧把当前位置投影点**追加**到末尾，
 *     **偏航重算后不清空、不重置**（长度单调不减）。
 *   ⇒ `donePath` 与另两条**可能几何不同源**（重算后路径变了）。
 *     "灰线与新绿线接续但不完全共线"是**正确行为**：灰线是用户真实轨迹，不该跟着新路径重画。
 *
 * ── z 纪律 ────────────────────────────────────────────────────────────
 *   三条都 ≤74（不得压住公交段灰实线 74 之上的层级）；蓝点 128 / 车辆 130 永远在上。
 *   进入 `riding` 时调用方应 `clear()` 三条（0ms 移除，不做淡出）—— 把共存窗口直接消掉。
 */
import type { WalkStep } from "@/lib/walk/walk-shared";

/** 这里只依赖 AMap 的最小面（避免把 @amap 类型拖进纯逻辑） */
interface PolylineLike {
  setPath(p: [number, number][]): void;
  setOptions?(o: Record<string, unknown>): void;
  show?(): void;
  hide?(): void;
}
interface MapLike {
  add(o: unknown): void;
  remove(o: unknown): void;
}
interface PolylineCtor {
  new (o: Record<string, unknown>): PolylineLike;
}

export interface WalkLayers {
  donePath: PolylineLike | null;
  nowPath: PolylineLike | null;
  aheadPath: PolylineLike | null;
}

export interface WalkPolylineStyle {
  done: { color: string; weight: number; opacity: number; z: number };
  ahead: { color: string; weight: number; opacity: number; z: number };
  now: { color: string; weight: number; opacity: number; z: number };
}

/** 从 CSS 变量读真实色值（禁止在 JS 里写死色） */
export function readWalkStyle(root: HTMLElement | null): WalkPolylineStyle {
  const cs = root ? getComputedStyle(root) : null;
  const v = (name: string, fb: string) => (cs?.getPropertyValue(name).trim() || fb).trim();
  return {
    done: {
      color: v("--map-walk-done", "#8c93a0"),
      weight: Number(v("--map-walk-w-done", "5")) || 5,
      opacity: Number(v("--map-walk-op-done", "0.85")) || 0.85,
      z: Number(v("--map-z-walk-done", "69")) || 69,
    },
    ahead: {
      color: v("--map-walk-ahead", "#0b6e4f"),
      weight: Number(v("--map-walk-w-ahead", "5")) || 5,
      opacity: Number(v("--map-walk-op-ahead", "0.55")) || 0.55,
      z: Number(v("--map-z-walk-ahead", "70")) || 70,
    },
    now: {
      color: v("--map-walk-ahead", "#0b6e4f"),
      weight: Number(v("--map-walk-w-now", "7")) || 7,
      opacity: Number(v("--map-walk-op-now", "1")) || 1,
      z: Number(v("--map-z-walk-now", "73")) || 73,
    },
  };
}

/** 公共折线参数（`lineCap:"round"` 是"圆点"的唯一来源，缺了会被误读成施工路段） */
function common(color: string, weight: number, opacity: number, z: number, withDir = false) {
  return {
    strokeColor: color,
    strokeWeight: weight,
    strokeOpacity: opacity,
    strokeStyle: "dashed",
    strokeDasharray: [0.5, 12],
    lineJoin: "round",
    lineCap: "round",
    zIndex: z,
    bubble: false,
    showDir: withDir,
  };
}

/** 建三条（幂等：已存在则复用） */
export function ensureWalkLayers(
  map: MapLike | null,
  ctor: PolylineCtor | null,
  style: WalkPolylineStyle,
  cur: WalkLayers,
): WalkLayers {
  if (!map || !ctor) return cur;
  const next = { ...cur };
  if (!next.donePath) {
    next.donePath = new ctor({ path: [], ...common(style.done.color, style.done.weight, style.done.opacity, style.done.z) });
    map.add(next.donePath);
  }
  if (!next.aheadPath) {
    next.aheadPath = new ctor({ path: [], ...common(style.ahead.color, style.ahead.weight, style.ahead.opacity, style.ahead.z) });
    map.add(next.aheadPath);
  }
  if (!next.nowPath) {
    next.nowPath = new ctor({ path: [], ...common(style.now.color, style.now.weight, style.now.opacity, style.now.z, true) });
    map.add(next.nowPath);
  }
  return next;
}

/**
 * 按 `ratio` 把当前步折线切成「已走 / 未走」两段。
 * ⚠️ 返回的**后半**才是 `nowPath`（设计 §2.3：nowPath = 还没走的那截）。
 */
export function splitStepByRatio(
  step: WalkStep | undefined,
  ratio: number,
): { walked: [number, number][]; remaining: [number, number][] } {
  const poly = step?.polyline ?? [];
  if (poly.length < 2) return { walked: [], remaining: [] };
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  if (r <= 0) return { walked: [], remaining: poly };
  if (r >= 1) return { walked: poly, remaining: [] };

  /* 按顶点等分近似定位切点（步内顶点均匀里程由服务端 `cumM` 保证；
     这里只做几何切分，**不重算累计里程**） */
  const seg = (poly.length - 1) * r;
  const i = Math.floor(seg);
  const t = seg - i;
  const a = poly[i];
  const b = poly[i + 1] ?? a;
  const cut: [number, number] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return {
    walked: [...poly.slice(0, i + 1), cut],
    remaining: [cut, ...poly.slice(i + 1)],
  };
}

/** 清空三条（进入 riding / 退出 walk 时调用；0ms 移除，不做淡出） */
export function clearWalkLayers(map: MapLike | null, layers: WalkLayers): WalkLayers {
  if (map) {
    for (const l of [layers.donePath, layers.nowPath, layers.aheadPath]) {
      if (l) map.remove(l);
    }
  }
  return { donePath: null, nowPath: null, aheadPath: null };
}
