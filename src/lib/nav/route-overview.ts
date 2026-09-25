/**
 * 路线总览切割纯函数（src/lib/nav/route-overview.ts，2026-09-23 新增）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   把「乘车段」映射到线路走向 polyline 上，切出「乘车区间（彩段）」与
 *   「同线路非乘车区间（灰段）」，并给出取景外包框 —— 供 `NavMap` 双层 polyline 绘制。
 *
 * ── 为什么单独成模块 ──────────────────────────────────────────────────
 *   · **client-safe**：前端组件直接 import；**绝不 import `pg`**（纯几何）；
 *   · **纯函数、零副作用** ⇒ 可 `scripts/test-route-overview.ts` 对拍（防沉默逻辑错误）。
 *
 * ── 坐标系铁律 ────────────────────────────────────────────────────────
 *   `route_shapes.polyline`（高德）与 `/api/stations`（DSAT→GCJ）**同为 GCJ-02**，
 *   可叠加；但**来源不同**（不同源）⇒ 用「**最近顶点 + 容差 TOL_M**」而非精确相等。
 *
 * ── 关键边界（Spec §10 / 附录 A.2.1）────────────────────────────────────
 *   · 环线（26 号，首尾同站）⇒ 首尾闭合检测 + **环绕切分**；
 *   · 起终点同站（board≈alight）⇒ 整线着色（不画区间外灰色）；
 *   · 超容差 / 数据缺失 / 切割失败 ⇒ **降级**（整线着色，`degraded=true`，`console.warn`）。
 */

/** [lng, lat]（GCJ-02） */
export type LL = [number, number];

/** 站到线最近点容差（米）—— 超差视为该方向不含此站 */
export const TOL_M = 80;
/** 首尾闭合判定（米）—— 环线 */
export const LOOP_EPS_M = 25;
/** 起终点同站阈值（米）—— 整线着色 */
export const BOARD_EQ_ALIGHT_M = 50;
/** 灰底线抽稀步长（米） */
export const DECIMATE_STEP_M = 15;

/** `POST /api/nav/detail-body` 返回的逐段几何锚点（与 `card.rides` 一一对应、同序） */
export interface OverviewLegInput {
  index: number;
  route: string;
  kind: "bus" | "lrt";
  color: string | null;
  board: { code: string; lng: number; lat: number } | null;
  alight: { code: string; lng: number; lat: number } | null;
}

/** `/api/route-shapes` 的 `shapes[]` 元素（子集） */
export interface RouteShapeLite {
  /** `dsat_dir` */
  dir?: string;
  /** "lng,lat;lng,lat;..."（GCJ-02） */
  polyline: string;
  startStop?: string | null;
  endStop?: string | null;
}

/** 组装后的乘车段（供绘制 + 车辆方向） */
export interface ColoredLeg {
  index: number;
  route: string;
  kind: "bus" | "lrt";
  color: string | null;
  /** 选中方向（供 `/api/route-vehicles?dir=` 用） */
  dir: string | null;
  /** 所选方向整条线（灰底线，zIndex 68） */
  gray: LL[];
  /**
   * board→alight 乘车区间（彩段，zIndex 72）。
   *
   * ⚠️ **整线着色不变式（跨模块契约，勿改依赖方式）**：
   *   `colored === gray`（**引用相等**）⇔ 「整线着色」——两种来源：
   *     · 降级（①②③⑤：无 shapes / 缺坐标 / 双向超容差 / 切割失败）⇒ `degraded=true`；
   *     · 起终点同站（④，board≈alight）⇒ **`degraded=false`** 且 `colored===gray`。
   *   渲染层据此判定「是否再画灰底线」时**必须用本引用相等**（`nav-map-overview.ts` 的 `grayIsWhole`）；
   *   不可改判 `!degraded`——④ 会因 `degraded=false` 误判为非整线，多画一条灰虚线（回归）。
   *   对拍证据：`scripts/test-route-overview.ts` ⑧（整线着色 ∧ degraded===false）。
   */
  colored: LL[];
  /** true = 未切割成功 ⇒ colored === gray（整线着色）；**注意 ④ 同站整线着色为 false 但 colored===gray** */
  degraded: boolean;
}

/* ────────────────────────────── 基础几何 ────────────────────────────── */

/** "lng,lat;lng,lat;..." → 点列（非法段过滤；坐标非有限值丢弃） */
export function parsePolyline(s: string): LL[] {
  if (typeof s !== "string" || !s) return [];
  const out: LL[] = [];
  for (const seg of s.split(";")) {
    const parts = seg.split(",");
    if (parts.length !== 2) continue;
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push([lng, lat]);
  }
  return out;
}

/** 两点距离（米）—— 等距近似：dLat·111320、dLng·111320·cos(lat)（取两点中点纬度） */
export function distM(a: LL, b: LL): number {
  const latMid = ((a[1] + b[1]) / 2) * (Math.PI / 180);
  const dx = (a[0] - b[0]) * 111320 * Math.cos(latMid);
  const dy = (a[1] - b[1]) * 111320;
  return Math.hypot(dx, dy);
}

/** 累积距离（米）；返回与 `pts` 等长数组，`[0]=0` */
export function cumDistM(pts: LL[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < pts.length; i++) out.push(out[i - 1] + distM(pts[i - 1], pts[i]));
  return out;
}

/** 最近**顶点**（小范围，欧氏近似足够） */
export function nearestOnPath(pts: LL[], p: { lng: number; lat: number }): { idx: number; distM: number } {
  let idx = 0;
  let best = Infinity;
  const q: LL = [p.lng, p.lat];
  for (let i = 0; i < pts.length; i++) {
    const d = distM(pts[i], q);
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return { idx, distM: best };
}

/**
 * 是否环线：首尾站码相同 **或** 首尾顶点距离 ≤ LOOP_EPS_M。
 */
export function isLoop(pts: LL[], startStop?: string | null, endStop?: string | null): boolean {
  if (startStop && endStop && startStop === endStop) return true;
  if (pts.length < 2) return false;
  return distM(pts[0], pts[pts.length - 1]) <= LOOP_EPS_M;
}

/* ──────────────────────────────── 核心 ──────────────────────────────── */

export interface ChooseShapeResult {
  shape: RouteShapeLite;
  dir: string | null;
  iBoard: number;
  iAlight: number;
  dBoard: number;
  dAlight: number;
  /** 该 shape 的完整折线（省一次 parsePolyline） */
  pts: LL[];
  loop: boolean;
}

/**
 * 选方向：
 *   对每个 shape 求 board / alight 最近顶点距离；**剔除任一 > tolM 者**；
 *   在合法 shape 中取 `dBoard+dAlight` 最小者；并列优先「正向」（iBoard ≤ iAlight）。
 *   全部非法 → 返回 `null`（调用方走降级）。
 */
export function chooseShape(
  shapes: RouteShapeLite[],
  board: { lng: number; lat: number },
  alight: { lng: number; lat: number },
  tolM: number = TOL_M,
): ChooseShapeResult | null {
  let best: ChooseShapeResult | null = null;
  let bestScore = Infinity;
  for (const shape of shapes ?? []) {
    const pts = parsePolyline(shape.polyline);
    if (pts.length < 2) continue;
    const nb = nearestOnPath(pts, board);
    const na = nearestOnPath(pts, alight);
    if (nb.distM > tolM || na.distM > tolM) continue; // 该方向不含此站
    const score = nb.distM + na.distM;
    const loop = isLoop(pts, shape.startStop, shape.endStop);
    const candidate: ChooseShapeResult = {
      shape,
      dir: shape.dir ?? null,
      iBoard: nb.idx,
      iAlight: na.idx,
      dBoard: nb.distM,
      dAlight: na.distM,
      pts,
      loop,
    };
    // 更优：分更低；并列：优先正向（board 在 alight 之前）
    const forward = nb.idx <= na.idx;
    const bestForward = best ? best.iBoard <= best.iAlight : false;
    if (
      score < bestScore - 1e-6 ||
      (Math.abs(score - bestScore) <= 1e-6 && forward && !bestForward)
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 切彩段（保证 `colored[0]=board`、`colored[-1]=alight`）：
 *   · 非环线：`iBoard <= iAlight` 取正向 `slice(ib, ia+1)`；
 *     `iBoard > iAlight`（存储几何与行驶方向相反）取 `slice(ia, ib+1).reverse()`；
 *   · 环线：`iAlight >= iBoard` 取正向切片；`iAlight < iBoard` **环绕**
 *     `slice(iBoard).concat(slice(0, iAlight+1))`。
 */
export function cutColored(pts: LL[], iBoard: number, iAlight: number, loop: boolean): LL[] | null {
  const n = pts.length;
  if (n < 2) return null;
  const ib = Math.max(0, Math.min(n - 1, iBoard));
  const ia = Math.max(0, Math.min(n - 1, iAlight));
  if (!loop) {
    if (ib <= ia) return pts.slice(ib, ia + 1);
    return pts.slice(ia, ib + 1).reverse();
  }
  if (ia >= ib) return pts.slice(ib, ia + 1);
  return pts.slice(ib).concat(pts.slice(0, ia + 1));
}

/**
 * 组装全部乘车段（多段换乘逐段处理）。
 * 决策表见附录 A.2.1；任一条件不满足 → 该段 `degraded=true`、`colored=gray`。
 */
export function buildColoredLegs(
  legs: OverviewLegInput[],
  shapesByRoute: Record<string, RouteShapeLite[]>,
  opts?: { tolM?: number; boardEqAlightM?: number },
): ColoredLeg[] {
  const tolM = opts?.tolM ?? TOL_M;
  const eqM = opts?.boardEqAlightM ?? BOARD_EQ_ALIGHT_M;
  return (legs ?? []).map((leg) => {
    const shapes = shapesByRoute?.[leg.route] ?? [];
    const base = {
      index: leg.index,
      route: leg.route,
      kind: leg.kind,
      color: leg.color,
    };

    // ① 无 shapes：不画线（降级，保持 colored===gray 引用）
    if (!shapes.length) {
      const empty: LL[] = [];
      return { ...base, dir: null, gray: empty, colored: empty, degraded: true };
    }

    // ② 缺坐标：用第一个 shape 整线着色（无方向信息）
    if (!leg.board || !leg.alight) {
      const first = shapes[0];
      const gray = parsePolyline(first.polyline);
      return { ...base, dir: first.dir ?? null, gray, colored: gray, degraded: true };
    }

    // ③ 选方向
    const picked = chooseShape(shapes, leg.board, leg.alight, tolM);
    if (!picked) {
      // 两方向都超容差 → 降级：第一个 shape 整线着色
      const gray = parsePolyline(shapes[0].polyline);
      console.warn(`[route-overview] ${leg.route} 两个方向均超容差(${tolM}m) ⇒ 整线着色降级`);
      return { ...base, dir: shapes[0].dir ?? null, gray, colored: gray, degraded: true };
    }

    const gray = picked.pts;
    const dir = picked.dir;

    // ④ 起终点同站 ⇒ 整线着色（非降级）
    const boardPt: LL = [leg.board.lng, leg.board.lat];
    const alightPt: LL = [leg.alight.lng, leg.alight.lat];
    if (distM(boardPt, alightPt) <= eqM) {
      return { ...base, dir, gray, colored: gray, degraded: false };
    }

    // ⑤ 正常切割
    const colored = cutColored(gray, picked.iBoard, picked.iAlight, picked.loop);
    if (!colored || colored.length < 2) {
      console.warn(`[route-overview] ${leg.route} 切割失败（iBoard=${picked.iBoard} iAlight=${picked.iAlight}）⇒ 降级`);
      return { ...base, dir, gray, colored: gray, degraded: true };
    }
    return { ...base, dir, gray, colored, degraded: false };
  });
}

/** 并集外包框（取景用；含起终点）—— 无点则 `null` */
export function unionBox(
  pathSets: LL[][],
  extra?: { lng: number; lat: number }[],
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let n = 0;
  const eat = (lng: number, lat: number) => {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
    n++;
  };
  for (const set of pathSets ?? []) for (const p of set ?? []) eat(p[0], p[1]);
  for (const p of extra ?? []) eat(p.lng, p.lat);
  return n ? { minLng, minLat, maxLng, maxLat } : null;
}

/**
 * 灰底线抽稀：**保首尾**；相邻顶点 < `minStepM` 的中间点丢弃。
 * 用于削减数千点长线的绘制开销（彩段端点由调用方另行拼接，不受影响）。
 */
export function decimate(pts: LL[], minStepM: number = DECIMATE_STEP_M): LL[] {
  if (pts.length <= 2) return pts.slice();
  const out: LL[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    if (distM(pts[i], out[out.length - 1]) >= minStepM) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
