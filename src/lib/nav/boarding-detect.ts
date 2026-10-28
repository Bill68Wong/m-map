/**
 * 全自动上车判定 + 安全网（src/lib/nav/boarding-detect.ts，2026-09-25 · v2.14）
 *
 * ── 职责（05-Spec §4.3 / 07 §1）────────────────────────────────────────
 *   把「车辆通道（R1）」与「GPS 通道（R2）」的判据抽成**纯函数**（可单测、可关开关），
 *   供 `useRideTracking` 调用：
 *     · `r1Of`      —— 车辆侧：车停靠/刚离开本上车站；
 *     · `r2Of`      —— GPS 侧：45s 窗口内投影 / 沿线位移 / 速度；
 *     · `autoBoardOf` —— 组合判定（巴士 R1 优先；轻轨仅 R2 收紧档）；
 *     · `anomalyOf` —— 安全网异常检出（A1 疑似未上车 / A2 疑似提前下车）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **client-safe 纯函数**：不 import `pg` / server-only；坐标一律 GCJ-02；
 *   · **宁可晚判、不误判**：保守阈值 + 冷却 + 单次会话单次自动；
 *   · 一切「对不上」都如实返回，**绝不猜测**（沿用项目铁律）。
 */
import { cumDistM, distM, nearestOnPath, type LL } from "./route-overview";
import { mainOf, rankBoardingVehicles, type TrackVehicle } from "./track";

/** 自动上车总开关（Spec R-1：关掉即回退 v2.13「我已上车」手动） */
export const AUTO_BOARDING_ENABLED = true;

/** 用户定位一帧（GCJ-02；已由 wgs84ToGcj02 转换） */
export interface FixLite {
  lng: number;
  lat: number;
  accuracy: number;
  ts: number;
}

/* ── R2 参数（07 §1.2 最终值）── */
export const R2_WINDOW_MS = 45_000;
export const R2_TOL_M = 80; // 巴士 R2 投影容差
export const R2_LRT_TOL_M = 60; // 轻轨收紧档
export const R2_DISPLACE_M = 150; // 沿线位移（保留：R2Opts 缺省用）
export const R2_SPEED_MIN_KMH = 8;
export const R2_SPEED_MAX_KMH = 80;
export const R2_LRT_SPEED_MIN_KMH = 12;
export const R2_MIN_SAMPLES_WITH_R1 = 2; // 有 R1 佐证
export const R2_MIN_SAMPLES_ALONE = 3; // R2 单独判定

/* ── ★ 本批 R2 自适应 + 多帧确认（需求⑨ / AC-56）── */
/** 位移下限（米）——按 dt 缩放后的**下限**，保证 GPS 慢速漂移不被误判 */
export const R2_DISPLACE_MIN_M = 60;
/** 巴士速度下限（原 8 太严 ⇒ 上车瞬间低速被判漏）；轻轨仍用 R2_LRT_SPEED_MIN_KMH */
export const R2_SPEED_MIN_KMH_FLEX = 5.5;
/** `tol = max(基准容差, accuracy × 1.5)` —— 手机在车内定位精度差时的自适应 */
export const R2_ACC_TOL_FACTOR = 1.5;
/** 多帧确认：连续命中帧数（R1 strong 立即切换，不等 streak） */
export const R2_STREAK = 2;
/** 精度门（米）：单帧 accuracy 超此值 ⇒ 该帧不可信，不参与 R2 */
export const R2_FIX_MAX_ACC_M = 150;

/** 状态切换后的冷却（毫秒）—— 防抖 + 防死循环 */
export const SWITCH_COOLDOWN_MS = 20_000;
/** 安全网：连续确认次数与最小间隔 */
export const ANOMALY_CONFIRM = 2;
export const ANOMALY_MIN_GAP_MS = 45_000;

/* ══════════════════════════ R1（车辆侧） ══════════════════════════ */

export interface R1Result {
  /** strong = 车刚从本上车站开走；weak = 车正停靠本上车站；none = 不触发 */
  kind: "strong" | "weak" | "none";
  plate: string | null;
}

/**
 * R1 判定（07 §1.1）：只用 `rankBoardingVehicles` 的分档 0/1，不用距离项。
 * @param list     本帧车辆（`status ∈ {moving,stopping,terminal}` 的过滤已由 rank 完成）
 * @param boardMain 本段上车站主码
 * @param boardPos  上车站坐标（可空）
 */
export function r1Of(
  list: TrackVehicle[],
  boardMain: string,
  boardPos?: { lng: number; lat: number } | null,
): R1Result {
  const board = mainOf(boardMain);
  if (!board) return { kind: "none", plate: null };
  const ranked = rankBoardingVehicles(list, board, boardPos);

  const strongs = ranked.filter(
    (v) => v.interval?.from?.code && mainOf(v.interval.from.code) === board,
  );
  const weaks = ranked.filter(
    (v) => v.atStation?.code && mainOf(v.atStation.code) === board && v.status === "stopping",
  );

  if (strongs.length > 0) {
    // 多车歧义：strong 与 weak 车牌不同 ⇒ 不触发
    if (weaks.length > 0 && strongs[0].plate !== weaks[0].plate) {
      return { kind: "none", plate: null };
    }
    if (strongs.length === 1) return { kind: "strong", plate: strongs[0].plate };
    // strong 多辆：取排序第 1，且必须在 strong 集合内；否则不唯一 ⇒ 不触发
    const top = ranked[0];
    if (top && strongs.some((s) => s.plate === top.plate)) {
      return { kind: "strong", plate: top.plate };
    }
    return { kind: "none", plate: null };
  }
  if (weaks.length > 0) return { kind: "weak", plate: weaks[0].plate };
  return { kind: "none", plate: null };
}

/* ══════════════════════════ R2（GPS 侧） ══════════════════════════ */

export interface R2Opts {
  tolM?: number;
  displaceM?: number;
  speedMinKmh?: number;
  speedMaxKmh?: number;
  minSamples?: number;
  windowMs?: number;
}

/**
 * R2 判定（07 §1.2）：45s 窗口内
 *   · 每个采样点到 `colored` 投影 ≤ tolM；
 *   · 沿线位移（最早→最新投影里程差）≥ displaceM；
 *   · 平均速度 ∈ [speedMin, speedMax]；
 *   · 采样数 ≥ minSamples。
 */
export function r2Of(fixes: FixLite[], colored: LL[], opts: R2Opts = {}): boolean {
  if (colored.length < 2) return false;
  const tol = opts.tolM ?? R2_TOL_M;
  const displace = opts.displaceM ?? R2_DISPLACE_M;
  const vMin = opts.speedMinKmh ?? R2_SPEED_MIN_KMH;
  const vMax = opts.speedMaxKmh ?? R2_SPEED_MAX_KMH;
  const minSamples = opts.minSamples ?? R2_MIN_SAMPLES_ALONE;
  const windowMs = opts.windowMs ?? R2_WINDOW_MS;

  const latest = fixes[fixes.length - 1];
  if (!latest) return false;
  const win = fixes.filter((f) => latest.ts - f.ts <= windowMs && f.ts <= latest.ts);
  if (win.length < minSamples) return false;

  const cum = cumDistM(colored);
  const projs = win.map((f) => nearestOnPath(colored, f));
  if (projs.some((p) => p.distM > tol)) return false;

  const i0 = projs[0].idx;
  const i1 = projs[projs.length - 1].idx;
  const disp = Math.abs(cum[i1] - cum[i0]);
  if (disp < displace) return false;

  const dtSec = (win[win.length - 1].ts - win[0].ts) / 1000;
  if (dtSec <= 0) return false;
  const kmh = (disp / dtSec) * 3.6;
  return kmh >= vMin && kmh <= vMax;
}

/* ══════════════════════════ 组合判定 ══════════════════════════ */

export interface AutoBoardInput {
  legKind: "bus" | "lrt";
  /** 几何不可用（colored < 2 或 degraded）⇒ 巴士退化为 R1-only；轻轨不自动 */
  legDegraded: boolean;
  colored: LL[];
  boardMain: string;
  boardPos?: { lng: number; lat: number } | null;
  vehicles: TrackVehicle[];
  fixes: FixLite[];
  /** 上次切换时刻（冷却用） */
  lastSwitchTs: number;
  nowMs: number;
  /** 本次会话该 leg 是否已自动触发过（单次会话单次） */
  autoUsed: boolean;
  /** ★ 本批：调用方维护的连续命中帧数（多帧确认 R2_STREAK） */
  streak?: number;
}

export interface AutoBoardResult {
  hit: boolean;
  plate: string | null;
  source: "vehicle" | "gps";
  reason: "r1" | "r1weak+r2" | "r2" | "none";
  /** ★ 本批：更新后的连续命中帧数（`hit` 时累加，未命中归零） */
  streak: number;
}

/** 未命中基线（`streak` 由调用方覆盖） */
const NO_HIT: AutoBoardResult = { hit: false, plate: null, source: "vehicle", reason: "none", streak: 0 };

/** 取「可信帧」（accuracy ≤ 精度门；缺失按 0 视为可信） */
function trustedFixes(fixes: FixLite[]): FixLite[] {
  return fixes.filter((f) => !(Number.isFinite(f.accuracy) && f.accuracy > R2_FIX_MAX_ACC_M));
}

/** 由 GPS 采样自适应算 R2 阈值（tol 随 accuracy、displace 随 dt 缩放） */
function adaptiveOpts(fixes: FixLite[], baseTolM: number): R2Opts {
  const latest = fixes[fixes.length - 1] ?? null;
  const acc = latest && Number.isFinite(latest.accuracy) ? latest.accuracy : 0;
  const tol = Math.max(baseTolM, acc * R2_ACC_TOL_FACTOR);
  const win = latest ? fixes.filter((f) => latest.ts - f.ts <= R2_WINDOW_MS) : [];
  const dtSec = win.length >= 2 ? (win[win.length - 1].ts - win[0].ts) / 1000 : 0;
  const displace = Math.max(R2_DISPLACE_MIN_M, (R2_SPEED_MIN_KMH_FLEX / 3.6) * dtSec);
  return { tolM: tol, displaceM: displace };
}

export function autoBoardOf(input: AutoBoardInput): AutoBoardResult {
  const prevStreak = Math.max(0, input.streak ?? 0);
  if (!AUTO_BOARDING_ENABLED) return { ...NO_HIT, streak: 0 };
  if (input.autoUsed) return { ...NO_HIT, streak: 0 };
  if (input.nowMs - input.lastSwitchTs < SWITCH_COOLDOWN_MS) return { ...NO_HIT, streak: 0 };

  const geomOk = input.colored.length >= 2 && !input.legDegraded;
  const fixes = trustedFixes(input.fixes); // ★ 精度门：剔除不可信帧

  if (input.legKind === "lrt") {
    // 轻轨：仅 R2 收紧档（投影 ≤60m、速度 ≥12、采样 ≥3）；tol 随 accuracy 自适应
    if (!geomOk) return { ...NO_HIT, streak: 0 };
    const opts = adaptiveOpts(fixes, R2_LRT_TOL_M);
    const hit = r2Of(fixes, input.colored, {
      tolM: opts.tolM,
      displaceM: opts.displaceM,
      speedMinKmh: R2_LRT_SPEED_MIN_KMH,
      minSamples: R2_MIN_SAMPLES_ALONE,
    });
    return hit
      ? { hit: true, plate: null, source: "gps", reason: "r2", streak: prevStreak + 1 }
      : { ...NO_HIT, streak: 0 };
  }

  // 巴士：R1 优先
  const r1 = r1Of(input.vehicles, input.boardMain, input.boardPos);
  if (r1.kind === "strong") {
    return { hit: true, plate: r1.plate, source: "vehicle", reason: "r1", streak: prevStreak + 1 };
  }
  if (!geomOk) return { ...NO_HIT, streak: 0 }; // 几何缺失 ⇒ 退化为 R1-only（已判定无 strong）

  const opts = adaptiveOpts(fixes, R2_TOL_M);
  if (r1.kind === "weak") {
    const ok = r2Of(fixes, input.colored, {
      tolM: opts.tolM,
      displaceM: opts.displaceM,
      speedMinKmh: R2_SPEED_MIN_KMH_FLEX,
      minSamples: R2_MIN_SAMPLES_WITH_R1,
    });
    if (ok) {
      return { hit: true, plate: r1.plate, source: "vehicle", reason: "r1weak+r2", streak: prevStreak + 1 };
    }
  }
  // R2 单独（无车牌，进度来源 = GPS）
  if (
    r2Of(fixes, input.colored, {
      tolM: opts.tolM,
      displaceM: opts.displaceM,
      speedMinKmh: R2_SPEED_MIN_KMH_FLEX,
      minSamples: R2_MIN_SAMPLES_ALONE,
    })
  ) {
    return { hit: true, plate: null, source: "gps", reason: "r2", streak: prevStreak + 1 };
  }
  return { ...NO_HIT, streak: 0 };
}

/* ══════════════════════════ 安全网 ══════════════════════════ */

export type Anomaly = "none" | "not_boarded" | "alighted";

/** 近 `windowMs` 内 GPS 原始平均速度（km/h）—— 样本不足 ⇒ null */
export function gpsSpeedKmh(fixes: FixLite[], windowMs: number): number | null {
  const latest = fixes[fixes.length - 1];
  if (!latest) return null;
  const win = fixes.filter((f) => latest.ts - f.ts <= windowMs);
  if (win.length < 2) return null;
  const a = win[0];
  const b = win[win.length - 1];
  const dtSec = (b.ts - a.ts) / 1000;
  if (dtSec <= 0) return null;
  const m = distM([a.lng, a.lat], [b.lng, b.lat]);
  return (m / dtSec) * 3.6;
}

export interface AnomalyInput {
  /** 本次 riding 是否由自动判定进入（非手动） */
  autoSwitched: boolean;
  /** 进度来源：vehicle = 有车牌；gps = GPS 驱动 */
  progressSource: "vehicle" | "gps";
  fixes: FixLite[];
  /** 最新定位到 leg.colored 的投影距离（无几何 ⇒ null） */
  projDistM: number | null;
  /** 车辆已推进 ≥1 站（GPS 驱动时为「投影里程持续增长」） */
  advanced: boolean;
}

/**
 * 异常检出（**瞬时**条件；连续 2 次 + 间隔 ≥45s 的确认在调用方累计）。
 *   A1 疑似未上车：自动进入 + 近 60s 静止(<2km/h) + 离线 >250m + 已推进。
 *   A2 疑似提前下车：riding + 近 45s 静止(<3km/h) + 离线 >250m + 已推进。
 */
export function anomalyOf(input: AnomalyInput): Anomaly {
  const farOff = input.projDistM != null && input.projDistM > 250;
  if (!farOff) return "none";

  const v60 = gpsSpeedKmh(input.fixes, 60_000);
  if (input.autoSwitched && v60 != null && v60 < 2 && input.advanced) return "not_boarded";

  const v45 = gpsSpeedKmh(input.fixes, 45_000);
  if (v45 != null && v45 < 3 && input.advanced) return "alighted";
  return "none";
}
