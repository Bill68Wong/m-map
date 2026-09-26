/**
 * 乘车追踪引擎（src/lib/nav/track.ts，2026-09-24 新增）
 *
 * ── 定位（v2.13 导航界面 · 用户实时进度）────────────────────────────────
 *   把「官方班车实时数据」（`/api/route-vehicles`：车牌 / 坐标 / 挂载站 / 状态 / 区间）
 *   翻译成「用户在站序中的进度」：
 *     · `pickBoarding` —— 「我已上车」时从在途车中锁定**用户坐的那辆**；
 *     · `progressOf`   —— 由车辆区间/挂靠站推导「已过到第几站 / 下一站是谁」；
 *     · `cutAt`        —— 把车辆坐标投影到该段乘车 polyline 上，供「已驶过路段变绿」切割。
 *
 * ── 为什么车道数据当主信号（用户拍板 2026-09-24）────────────────────────
 *   官方数据与报站同源（站点级准确）、车牌可稳定锁定、无定位权限门槛；
 *   手机 GPS 仅作后续增强（PWA 锁屏/后台被系统暂停，且隧道/桥上会漂）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **client-safe 纯函数**：不 import `pg`、不 import server-only 模块
 *     （`mainCodeOf` 在本文件内联 —— `segment-lookup` 是 server-only，客户端禁引）；
 *   · 一切「找不到 / 对不上」都**如实返回**（unknown/lost），由调用方决定冻结或提示，
 *     **绝不猜测**（呼应「报站数必须符合物理常识」的项目口径）。
 */
import { nearestOnPath, type LL } from "./route-overview";

/** 追踪用的车辆子集（= `/api/route-vehicles` 的 vehicles[] 元素；坐标已 GCJ-02） */
export interface TrackVehicle {
  plate: string;
  lat: number;
  lng: number;
  /** moving | stopping | terminal | unknown | lost */
  status: string;
  /** 行驶区间（status='moving' 时存在）；code 为主码 */
  interval: { from: { code: string }; to: { code: string } } | null;
  /** 挂靠站（status='stopping'/'terminal' 时存在）；code 为主码 */
  atStation: { code: string } | null;
}

/** 站码归一（剥站台后缀：`T373/1` → `T373`）—— 与全站口径一致 */
export function mainOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(String(code ?? ""))?.[0] ?? String(code ?? "");
}

/** 进度（相对**本段站序**；下标 0 = 上车站，-1 = 未知） */
export interface TrackProgress {
  /**
   * `at`      = 车停靠在某站（含总站待发）；
   * `between` = 车在某区间行驶中；
   * `unknown` = 数据对不上本段站序（调用方应**冻结**上次进度，不可乱跳）；
   * `lost`    = 本帧无车辆数据。
   */
  kind: "at" | "between" | "unknown" | "lost";
  /** 已**完全驶过**的最后一站下标（-1 = 一站未过）；站条据此把文字变绿 */
  passedIdx: number;
  /** 车当前停靠站下标（kind='at' 时有效） */
  atIdx: number | null;
  /** 下一站下标（kind='between' 时为区间终点站；'at' 时为停靠站的下一站） */
  nextIdx: number | null;
}

const EMPTY_PROGRESS: TrackProgress = { kind: "lost", passedIdx: -1, atIdx: null, nextIdx: null };

/**
 * 由车辆数据推导进度。
 * @param stopMains 本段站序（主码数组，0 = 上车站、末位 = 下车站）
 * @param v         追踪中的车辆（null = 尚未锁定/本帧无数据）
 */
export function progressOf(stopMains: string[], v: TrackVehicle | null): TrackProgress {
  if (!v || !stopMains.length) return EMPTY_PROGRESS;
  const lastIdx = stopMains.length - 1;

  // ① 停靠中（含总站待发）—— 以挂靠站为准
  if (v.atStation?.code) {
    const idx = stopMains.indexOf(mainOf(v.atStation.code));
    if (idx >= 0) {
      return {
        kind: "at",
        passedIdx: idx - 1,
        atIdx: idx,
        nextIdx: idx < lastIdx ? idx + 1 : null,
      };
    }
  }

  // ② 行驶中 —— 以区间为准：已离开 from（= 已驶过 from），驶向 to
  if (v.interval?.from?.code) {
    const fromIdx = stopMains.indexOf(mainOf(v.interval.from.code));
    if (fromIdx >= 0) {
      const toIdx = v.interval.to?.code ? stopMains.indexOf(mainOf(v.interval.to.code)) : -1;
      return {
        kind: "between",
        passedIdx: fromIdx,
        atIdx: null,
        nextIdx: toIdx >= 0 ? toIdx : fromIdx < lastIdx ? fromIdx + 1 : null,
      };
    }
  }

  // ③ 都对不上本段站序（可能尚未到上车站后方 / 数据异常）→ 如实报 unknown
  return { kind: "unknown", passedIdx: -1, atIdx: null, nextIdx: null };
}

/**
 * 「我已上车」候选排序：把在途车按「更可能是用户乘坐的那辆」排序。
 * 打分：停靠**本上车站** > 刚离开本上车站 > 距上车站更近。
 * @param boardPos 上车站坐标（GCJ-02；来自 detail-body legs，缺失时跳过距离项）
 */
export function rankBoardingVehicles(
  vehicles: TrackVehicle[],
  boardMain: string,
  boardPos?: { lng: number; lat: number } | null,
): TrackVehicle[] {
  const board = mainOf(boardMain);
  const score = (v: TrackVehicle): number => {
    if (v.atStation?.code && mainOf(v.atStation.code) === board) return 0;
    if (v.interval?.from?.code && mainOf(v.interval.from.code) === board) return 1;
    if (boardPos) {
      const dx = (v.lng - boardPos.lng) * 111320 * Math.cos((boardPos.lat * Math.PI) / 180);
      const dy = (v.lat - boardPos.lat) * 111320;
      return 2 + Math.hypot(dx, dy) / 100000; // 距离作次级项（除大数，不改变分组序）
    }
    return 3;
  };
  return [...vehicles]
    .filter((v) => v.status === "moving" || v.status === "stopping" || v.status === "terminal")
    .sort((a, b) => score(a) - score(b));
}

/**
 * 把「当前位置」投影到乘车段 polyline（GCJ-02）的**最近顶点**。
 * 供两种用途：① 已驶过路段切割（`slice(0, idx+1)`）② 判断投影是否可信（`dist` ≤ 容差才切线）。
 */
export function cutAt(poly: LL[], pos: { lng: number; lat: number }): { idx: number; dist: number } {
  if (!poly.length) return { idx: -1, dist: Number.POSITIVE_INFINITY };
  const r = nearestOnPath(poly, pos);
  return { idx: r.idx, dist: r.distM };
}

/** 投影可信容差（米）：超过则**冻结**上次进度（隧道/漂移时宁可不更新，不画错） */
export const CUT_TOLERANCE_M = 250;

/**
 * ★ 本批（需求⑤ / AC-43/44）：**段内位置比** `frac ∈ [0,1]`（纯函数，`07 §d.2`）。
 *
 * 用途：把「用户沿线里程 `dNow`」在「第 `i0` 站 → 第 `i1` 站」区间内插值 ⇒ 纵条骑线浮标
 *   `youAt.frac`（**仅视觉插值**，不参与 `passedIdx/atIdx/nextIdx` 判定）。
 * · `cum` 为 `cumDistM(colored)` 累积里程（与顶点等长）；
 * · `i0 < 0` / `i1 <= i0` / 区间零长（两站重合）⇒ 恒 0（点贴站）；
 * · 越界在函数内 clamp（`07 §d.4`）。
 */
export function fracBetween(cum: number[], i0: number, i1: number, dNow: number): number {
  if (i0 < 0 || i1 <= i0) return 0;
  const a = cum[i0];
  const b = cum[i1];
  if (!(b > a)) return 0;
  return Math.max(0, Math.min(1, (dNow - a) / (b - a)));
}

/**
 * 「快/慢多少分」文案口径（下车提醒与换乘行共用）：
 * 负 = 更快（「快 N 分」）、正 = 更慢（「慢 N 分」）、0 = 「时长相当」。
 */
export function fmtDelta(deltaMin: number): string {
  const d = Math.round(deltaMin);
  if (d < 0) return `快 ${-d} 分`;
  if (d > 0) return `慢 ${d} 分`;
  return "时长相当";
}
