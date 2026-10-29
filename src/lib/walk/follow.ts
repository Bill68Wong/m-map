/**
 * 步行跟随纯函数（src/lib/walk/follow.ts，v3.6.0 · S5）
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────
 *   「我现在第几步 / 还有多远 / 是否偏航」是全程最容易被写成"看起来对、实际错"的地方：
 *   off-by-one、回退抖动、偏航后倒退，都不会抛异常也不会报错，只会让用户走错路。
 *   ⇒ 全部抽成**纯函数**（零 React、零网络、零 DOM），由 `useWalkFollow` 驱动、由
 *     `scripts/test-walk-follow.ts` 逐条对拍。
 *
 * ── AC-04 口径（PM 定稿，本节即唯一实现）────────────────────────────────
 *   ① `currentStepIdx` = 服务端下发的累计里程（`step.cumM`，**客户端不得重算**）
 *      + 客户端对定位做投影，再**二分查找**得出；
 *   ② 步内前进量 = 「本步内已完成米数 ÷ 本步距离」，取值 0~1（本步距离用**几何长度**
 *      `stepGeomM()`，不用 `distM` —— 后者是高德整数米，做分母会抖，见 walk-shared 注释）；
 *   ③ **单调不减** + **1.5 米死区**（位移小于死区不动，防 GPS 噪声让进度来回跳）；
 *   ④ 偏航 或 `accuracy > 150m` ⇒ **冻结当前步、不回退**；
 *   ⑤ 客户端**不得重算累计里程** —— 一律读服务端的 `cumM`。
 *
 * ── 与"列表 / 地图两套进度"的关系（设计 §2.3 细节 5）──────────────────────
 *   本文件同时给出两套口径，**必须分开用**：
 *     · 列表（`data-walk-state`）= **步级** → 用 `currentIdx`；
 *     · 地图（`nowPath` 切分）    = **米级** → 用 `ratio`。
 *   一步 180 米走 3 分钟，若用步级索引推地图几何，中途零反馈。
 */
import { stepGeomM, type WalkStep } from "./walk-shared";

/** 单帧定位（GCJ-02） */
export interface WalkFix {
  lng: number;
  lat: number;
  /** 精度（米）；缺失按 0 视为可信 */
  accuracy?: number;
  ts?: number;
}

/** 单帧进度结果 */
export interface WalkProgress {
  /** 当前步下标（0 起；单调不减）。无可用定位时沿用 `prevIdx` */
  currentIdx: number;
  /** **米级**：本步已完成的几何米数（0 ~ stepGeomM） */
  doneInStepM: number;
  /** **米级**：本步完成比例 0~1（地图 `nowPath` 切分用它，**不要**用索引） */
  ratio: number;
  /** 全程还剩多少米（用 `stepsTotalM − 全程已完成` 计算，见下） */
  remainM: number;
  /** 在本步里横向偏离折线的距离（米）；未定位时为 null */
  offRouteM: number | null;
  /** 定位精度不可信（> 精度门）⇒ 本帧不推进 */
  lowAccuracy: boolean;
}

/** 精度门（米）—— 与全站口径一致（`R2_FIX_MAX_ACC_M` / `YOU_ACC_MAX_M` = 150） */
export const WALK_ACC_MAX_M = 150;
/** 进度死区（米）：位移小于它不更新，防 GPS 噪声抖动（AC-04） */
export const WALK_DEADBAND_M = 1.5;
/** 偏航判定阈值（米）—— 设计 §2.2 `off` 态文案「已偏离路线 50 米」 */
export const WALK_OFF_M = 50;
/** 偏航连续确认帧数（设计：连续 2 帧才出提示，防单帧漂移误报） */
export const WALK_OFF_CONFIRM = 2;

/** 点到线段的投影（平面近似；澳门尺度 <20km，等距圆柱误差可忽略） */
function projectOnSegment(
  p: { lng: number; lat: number },
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): { t: number; distM: number } {
  const latRad = (p.lat * Math.PI) / 180;
  const mx = 111_320 * Math.cos(latRad); // 每度经度米数
  const my = 111_320; // 每度纬度米数
  const ax = (a.lng - p.lng) * mx;
  const ay = (a.lat - p.lat) * my;
  const bx = (b.lng - p.lng) * mx;
  const by = (b.lat - p.lat) * my;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  // 退化线段（两点重合）：投影到端点
  if (len2 === 0) return { t: 0, distM: Math.hypot(ax, ay) };
  let t = -(ax * dx + ay * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx;
  const py = ay + t * dy;
  return { t, distM: Math.hypot(px, py) };
}

/** 一条折线上的投影结果 */
interface PathProjection {
  /** 落在第几个顶点区间（`i` ~ `i+1`） */
  segIdx: number;
  /** 区间内插值 0~1 */
  t: number;
  /** 投影点离线距离（米） */
  distM: number;
}

/** 折线投影（逐段取最近） */
export function projectOnPath(poly: [number, number][], fix: WalkFix): PathProjection | null {
  if (poly.length === 0) return null;
  if (poly.length === 1) {
    const latRad = (fix.lat * Math.PI) / 180;
    const mx = 111_320 * Math.cos(latRad);
    const d = Math.hypot((poly[0][0] - fix.lng) * mx, (poly[0][1] - fix.lat) * 111_320);
    return { segIdx: 0, t: 0, distM: d };
  }
  let best: PathProjection | null = null;
  for (let i = 0; i < poly.length - 1; i++) {
    const a = { lng: poly[i][0], lat: poly[i][1] };
    const b = { lng: poly[i + 1][0], lat: poly[i + 1][1] };
    const r = projectOnSegment({ lng: fix.lng, lat: fix.lat }, a, b);
    if (!best || r.distM < best.distM) best = { segIdx: i, t: r.t, distM: r.distM };
  }
  return best;
}

/**
 * 二分查「当前步」：找到最后一个 `cumStartM <= targetM` 的步。
 *
 * 为什么用 `cumStartM` 而不是 `cumM` 末值：**步边界归后一步**。
 * 恰好在两步交界处时，用户已经"站在下一步的起点"，此时应显示下一步的指令
 * （否则会出现「明明该右转了，横幅还写直行」）。
 */
export function stepIdxAt(targetM: number, steps: WalkStep[]): number {
  if (!steps.length) return 0;
  let lo = 0;
  let hi = steps.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].cumStartM <= targetM) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 把 `fromIdx` 起的各步拼成**一条**折线，并给出与之等长的累计里程。
 *
 * 为什么要拼：只在「当前步」上投影会在**步界处卡死** ——
 *   用户已走到下一步 50 米，但对当前步的投影会被 clamp 到步末（t=1），
 *   得到「恰好等于步末里程」，与「站在步末没动」无法区分 ⇒ 永远推不进下一步。
 *   （这是 S5 对拍抓到的真 bug，见 `scripts/test-walk-follow.ts` ③。）
 * 拼接后投影一次即可拿到**全局**里程，跨几步都能一次算对。
 */
function flattenFrom(steps: WalkStep[], fromIdx: number): { poly: [number, number][]; cum: number[] } {
  const poly: [number, number][] = [];
  const cum: number[] = [];
  for (let i = Math.max(0, fromIdx); i < steps.length; i++) {
    const s = steps[i];
    for (let k = 0; k < s.polyline.length; k++) {
      const pt = s.polyline[k];
      const c = s.cumM[k] ?? s.cumStartM;
      // 相邻两步首尾重合时去重（否则投影会落在重复点上，t 分布不均）
      const prev = poly[poly.length - 1];
      if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue;
      poly.push(pt);
      cum.push(c);
    }
  }
  return { poly, cum };
}

/** 拼接折线上的投影 → 全局累计里程（米） */
function cumOnFlat(flat: { poly: [number, number][]; cum: number[] }, fix: WalkFix): { cumM: number; distM: number } | null {
  const proj = projectOnPath(flat.poly, fix);
  if (!proj) return null;
  const { cum } = flat;
  if (cum.length === 0) return null;
  if (cum.length === 1) return { cumM: cum[0], distM: proj.distM };
  const i0 = Math.min(proj.segIdx, cum.length - 2);
  const c0 = cum[i0];
  const c1 = cum[i0 + 1];
  return { cumM: c0 + (c1 - c0) * proj.t, distM: proj.distM };
}

/**
 * 单帧进度（AC-04 全量口径）。
 *
 * @param steps     服务端 `steps`（含 `cumStartM` / `cumM`）
 * @param stepsTotalM 服务端 `stepsTotalM`（几何链末值，**不是** `totalDistM`）
 * @param fix       当前定位（null ⇒ 沿用 `prev`）
 * @param prev      上一次结果（用于单调性 / 死区 / 偏航时的冻结）
 */
export function progressOnPath(
  steps: WalkStep[],
  stepsTotalM: number,
  fix: WalkFix | null,
  prev: WalkProgress | null,
): WalkProgress {
  const fallback: WalkProgress = prev ?? {
    currentIdx: 0,
    doneInStepM: 0,
    ratio: 0,
    remainM: stepsTotalM,
    offRouteM: null,
    lowAccuracy: false,
  };
  if (!fix || !steps.length) return fallback;

  const acc = Number.isFinite(fix.accuracy) ? (fix.accuracy as number) : 0;
  const lowAccuracy = acc > WALK_ACC_MAX_M;
  /** ④ 精度不可信 ⇒ **冻结**（不回退、也不前进） */
  if (lowAccuracy) return { ...fallback, lowAccuracy: true };

  /**
   * 在「当前步起、到全程末」的拼接折线上投影一次 ⇒ 拿到**全局**里程。
   * 从 `currentIdx` 起而非 0 起：既省算力，又天然避免"回头走到已过步"导致的越界。
   */
  const flat = flattenFrom(steps, fallback.currentIdx);
  const hit = cumOnFlat(flat, fix);
  if (!hit) return fallback;

  /** 上次的全局已完成里程（用于单调不减） */
  const prevGlobal = (() => {
    const s = steps[Math.min(fallback.currentIdx, steps.length - 1)];
    return s.cumStartM + fallback.doneInStepM;
  })();

  /** ③ 单调不减：新值不得小于上次 */
  const globalM = Math.max(prevGlobal, hit.cumM);

  /** 用二分查步（边界归后一步），并夹住下界 = `prev.currentIdx`（绝不回退） */
  const idx = Math.max(fallback.currentIdx, stepIdxAt(globalM, steps));
  const step = steps[idx];
  const geom = stepGeomM(step);
  const doneRaw = Math.max(0, globalM - step.cumStartM);
  const doneInStepM = geom > 0 ? Math.min(doneRaw, geom) : 0;
  const ratio = geom > 0 ? Math.max(0, Math.min(1, doneInStepM / geom)) : 0;

  /* ── ③ 1.5 米死区：同一 `currentIdx` 内的位移小于死区 ⇒ 不动 ── */
  if (idx === fallback.currentIdx && doneInStepM - fallback.doneInStepM < WALK_DEADBAND_M) {
    return { ...fallback, offRouteM: hit.distM };
  }

  /* ── remainM 用「几何链末值 − 全程已完成」，绝不用 totalDistM（见 walk-shared 类型注释）── */
  const doneTotalM = Math.min(globalM, stepsTotalM);
  const remainM = Math.max(0, stepsTotalM - doneTotalM);

  return {
    currentIdx: idx,
    doneInStepM,
    ratio,
    remainM,
    offRouteM: hit.distM,
    lowAccuracy: false,
  };
}

/** 是否已到达：剩余米 < 阈值（设计：距终点 <30 米即视为到达） */
export const WALK_ARRIVE_M = 30;
export function arrived(remainM: number, thresholdM = WALK_ARRIVE_M): boolean {
  return remainM <= thresholdM;
}
