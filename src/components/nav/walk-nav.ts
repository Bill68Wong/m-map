/**
 * 步行导航共享类型（src/components/nav/walk-nav.ts，2026-10-29 新增）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   `NavDetailBody`（入口）→ `NavShell`（状态）→ `NavMap`（查询 + 画线）→ `WalkNavPanel`（结果）
 *   四处共用同一份契约；客户端 safe（纯类型 + 纯函数，绝不 import `pg`）。
 *
 * ⚠️ 坐标铁律：`from` / `to` 必须已是 **GCJ-02**（与 `/api/stations`、高德 JS API 一致）。
 * ⚠️ 结果来源：浏览器端高德 `AMap.Walking` 插件（经 `/_AMapService` 代理转发），
 *   不走服务端 `src/lib/amap/client.ts`（该模块只允许离线链路 import）。
 */

/** 步行段端点（GCJ-02） */
export interface WalkPoint {
  lng: number;
  lat: number;
  /** 展示名（起点/上车站/下车站/目的地） */
  label: string;
}

/** 一次步行导航请求（`id` 变化即触发重新查询） */
export interface WalkNavRequest {
  id: number;
  from: WalkPoint;
  to: WalkPoint;
  /** 卡片上的步行分钟（查询期间先展示，结果回来后被高德值覆盖） */
  hintMinutes?: number | null;
  /** 卡片上的步行距离（米，可能为 null） */
  hintDistanceM?: number | null;
}

/** 高德返回的一步（转向提示 + 步长） */
export interface WalkNavStep {
  /** 高德原文转向提示（如「向东步行 120 米」） */
  instruction: string;
  /** 本步距离（米） */
  distanceM: number;
}

/** 步行路径点（GCJ-02；由高德 `route.steps[].path` 拼成一条完整折线） */
export interface WalkPathPoint {
  lng: number;
  lat: number;
}

/** 查询结果（失败也为显式状态，面板不空白） */
export type WalkNavResult =
  | {
      ok: true;
      distanceM: number;
      durationMin: number;
      steps: WalkNavStep[];
      /**
       * ★ 2026-10-29（第二期）：完整步行折线 —— 跟随模式据此做「投影取剩余距离/当前步/偏航」。
       *   缺省为空数组 ⇒ 跟随降级为「只显示直线到终点距离」，不崩。
       */
      path: WalkPathPoint[];
    }
  | {
      ok: false;
      error: string;
    };

/** 面板阶段：查询中 / 成功 / 失败 */
export type WalkNavPhase = "loading" | "ready" | "failed";

/** 两点距离（米，等距近似）—— GCJ-02 小范围足够 */
export function walkGapM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const latMid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (a.lng - b.lng) * 111320 * Math.cos(latMid);
  const dy = (a.lat - b.lat) * 111320;
  return Math.hypot(dx, dy);
}

/** 换乘步行阈值（米）：小于它视为同站台，不单列步行段 */
export const TRANSFER_WALK_MIN_M = 40;

/** 跟随模式地图缩放级（街道细节足够、又不至于贴面） */
export const WALK_FOLLOW_ZOOM = 17;
/** 到达判定（米）：到终点直线距离 / 路径剩余距离任一小于它即「已到达」 */
export const WALK_ARRIVE_M = 25;
/** 偏航阈值（米）：到路径的垂直偏移超过它才算偏航（GPS 精度内不误报） */
export const WALK_OFF_ROUTE_M = 70;

/** 跟随进度（由「GPS 点 × 路径」实时算得；全部为米，路由长度为 0 时回落直线） */
export interface WalkProgress {
  /** 沿路径剩余距离（米） */
  remainingM: number;
  /** 沿路径已走距离（米） */
  traveledM: number;
  /** 当前步索引（0-based；path/steps 为空时 0） */
  stepIndex: number;
  /** 当前步剩余距离（米） */
  stepRemainingM: number;
  /** 到路径的垂直偏移（米）—— 偏航判定用 */
  offsetM: number;
  /** 到终点直线距离（米） */
  toEndM: number;
  /** 已到达终点 */
  arrived: boolean;
  /** 偏航（未到达且偏移超阈值） */
  offRoute: boolean;
}

/**
 * 把 GPS 点投影到步行折线，得到剩余距离 / 当前步 / 偏航偏移。
 *
 * 实现口径：
 *   · 小范围用「等距圆柱近似」把经纬度换算成米（GCJ-02 足够）；
 *   · 逐段投影取**垂直偏移最小**的段，其弧长 = 已走距离；
 *   · 步索引按「已走距离 / 总长 × 步距总和」线性折算（高德 `route.distance` 与步和基本一致）；
 *   · 路径缺失（空/单点）⇒ 剩余距离回落「直线到终点」，`offRoute=false`（不误报）。
 */
export function walkProgress(
  path: readonly WalkPathPoint[],
  steps: readonly WalkNavStep[],
  fix: { lng: number; lat: number },
  to: { lng: number; lat: number },
): WalkProgress {
  const toEndM = walkGapM(fix, to);

  if (path.length < 2) {
    return {
      remainingM: toEndM,
      traveledM: 0,
      stepIndex: 0,
      stepRemainingM: steps[0]?.distanceM ?? 0,
      offsetM: 0,
      toEndM,
      arrived: toEndM <= WALK_ARRIVE_M,
      offRoute: false,
    };
  }

  let bestOffsetM = Infinity;
  let bestTraveledM = 0;
  let cumulativeM = 0;

  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const latMid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const mx = 111320 * Math.cos(latMid);
    const my = 111320;
    const bx = (b.lng - a.lng) * mx;
    const by = (b.lat - a.lat) * my;
    const px = (fix.lng - a.lng) * mx;
    const py = (fix.lat - a.lat) * my;
    const segLen = Math.hypot(bx, by);
    let t = 0;
    if (segLen > 0) {
      t = (px * bx + py * by) / (segLen * segLen);
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
    }
    const offM = Math.hypot(px - bx * t, py - by * t);
    if (offM < bestOffsetM) {
      bestOffsetM = offM;
      bestTraveledM = cumulativeM + t * segLen;
    }
    cumulativeM += segLen;
  }

  const totalM = cumulativeM;
  const traveledM = Math.min(totalM, bestTraveledM);
  const remainingM = Math.max(0, totalM - traveledM);

  // 步索引：把「路径已走距离」线性折到「步距总和」上
  const stepsTotalM = steps.reduce((s, it) => s + Math.max(0, it.distanceM), 0);
  const scaledM = totalM > 0 ? (traveledM / totalM) * stepsTotalM : 0;
  let stepIndex = 0;
  let consumedM = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const d = Math.max(0, steps[i].distanceM);
    if (scaledM >= consumedM + d) {
      consumedM += d;
      stepIndex = Math.min(steps.length - 1, i + 1);
    } else break;
  }
  const stepRemainingM = Math.max(0, stepsTotalM - scaledM);

  const arrived = toEndM <= WALK_ARRIVE_M || remainingM <= WALK_ARRIVE_M;
  // 偏航仅在「已离开起点、且未到达」时判定；刚起步贴近路径不误报
  const offRoute = !arrived && traveledM > 10 && bestOffsetM > WALK_OFF_ROUTE_M;

  return {
    remainingM,
    traveledM,
    stepIndex,
    stepRemainingM,
    offsetM: Number.isFinite(bestOffsetM) ? bestOffsetM : 0,
    toEndM,
    arrived,
    offRoute,
  };
}

/** 按步行速度折算剩余时间（分钟；总时长/总距离比例，缺数据回落 4.8km/h） */
export function walkEtaMin(p: WalkProgress, result: { distanceM: number; durationMin: number }): number {
  if (p.arrived) return 0;
  if (result.distanceM > 0 && result.durationMin > 0) {
    return (p.remainingM / result.distanceM) * result.durationMin;
  }
  return p.remainingM / 80; // 80 m/min ≈ 4.8 km/h
}
