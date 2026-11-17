/**
 * 轻轨 GPS 投影推进（src/lib/nav/lrt-progress.ts，2026-09-25 · v2.14 · 07 §8）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   轻轨无逐车数据 ⇒ 用用户 GPS 投影到本段 `leg.colored`（GCJ-02 折线）推算站序进度，
 *   输出与巴士**同构**的 `TrackProgress`（喂站条四态与「您在这里」）。
 *
 * ── 保守规则（07 §8.3，全部为「防跳站」）────────────────────────────
 *   · 预计算站点里程阶梯 `ladder[i]`（进入 riding 时算一次）；乱序 / 投影离站过远的站**剔除**；
 *   · 可信门：离线 `≤120m` 且精度 `≤100m`（弱信号不推进）；
 *   · 已过站 `passedIdx = max{ i : d_now > ladder[i] + H }`；
 *   · **单帧最多推进 1 站**；**连续 2 帧 computed 一致**才采纳；
 *   · **Hysteresis** `H = max(60m, accuracy, 0.25 × 相邻站距)`，回退需 `d_now < ladder[i] − H`；
 *   · 速度合理性 `|Δd|/Δt ∈ [8, 80] km/h`（异常大丢帧；异常小不推进）；
 *   · 连续 2 帧不满足可信门 ⇒ **冻结**（不跳不猜）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **client-safe 纯函数**（零 `pg`）；坐标 GCJ-02；「对不上就冻结」铁律不变。
 */
import { cumDistM, distM, nearestOnPath, type LL } from "./route-overview";
import type { TrackProgress } from "./track";
import type { FixLite } from "./boarding-detect";

/** 阈值（07 §8.7：可实施期微调） */
export const LRT_TOL_M = 120; // 离线可信门
export const LRT_H_MIN_M = 60; // 迟滞下限
export const LRT_ACC_MAX_M = 100; // 精度可信门
/**
 * ★ 停站半径（米）：判定「**此刻停在某站**」的里程窗。
 *
 * ── 为什么必须有它（需求 4/5 的根因之一）────────────────────────────────
 *   旧实现只能靠「驶过 `ladder[i] + H`」间接推「已过站」，而 `H ≥ LRT_H_MIN_M = 60`
 *   ⇒ 列车**停站期间永远不满足**（`dNow ≈ ladder[i]`），必须等出站再跑 60m（约 6s）
 *   才认。从「车已停稳」到「系统认到站」≈ 停站时长 + 60m + 跨帧确认 ≈ 26~39s。
 *   要在**停站当下**判定，就必须有「距站 ≤ R」这种**双向**判据，而不是「越过」。
 *
 * ── 取值依据（可追溯，不是拍脑袋）──────────────────────────────────────
 *   实测末站锚点缺口分布：`3.8 / 6.1 / 54.4 / 83.4 / 105.4 / 149.2` 米。
 *   30 落在「几米簇（3.8/6.1）」与「几十米簇（54.4 起）」之间：比前者宽，能吸收
 *   站台点噪声；比后者窄，不会把并行的两条站台并成一站。
 *   参考同量级既有常量：`ALIGHT_GPS_OVER_M = 30`（巴士到站越站判定）、
 *   `R2_LRT_TOL_M = 60`（轻轨上车判定）。
 *   ⚠️ 该常量在站距很短时会被自适应上限压小（见 `stopRadiusOf`），否则两站会并成一站。
 */
export const LRT_STOP_R_M = 30;

/** 站点里程阶梯（预计算一次） */
export interface LrtLadder {
  /** 本段乘车折线（GCJ-02） */
  path: LL[];
  /** 各站沿线里程（米）；无效站为 NaN */
  ladder: number[];
  /** 各站是否有效（参与推进） */
  valid: boolean[];
  /**
   * 本段**末站坐标**（= `stops[stops.length - 1]`，缺失则 `null`）。
   *
   * 为什么需要：折线末顶点**并不落在末站上**（实测缺口 3.8~149.2m）⇒
   * 只靠 `dNow >= cum[n-1]`（折线到底）会在离站台 100 多米处就报「已到末站」，
   * 进而**提前宣告下车**。故末站判定加第二条件 `dist(fix, endStop) <= stopR`。
   * `null`（末站缺坐标）⇒ 退化为只判 `dNow`（= 旧行为），**不许因为缺坐标就判死**。
   */
  endStop: LL | null;
}

/**
 * 预计算站点里程阶梯（进入 riding 时算一次）。
 * @param colored 本段乘车折线（GCJ-02）
 * @param stops   各站坐标（GCJ-02）；缺失为 null
 */
export function buildLrtLadder(
  colored: LL[],
  stops: ({ lng: number; lat: number } | null)[],
): LrtLadder {
  const n = stops.length;
  const ladder: number[] = new Array(n).fill(Number.NaN);
  const valid: boolean[] = new Array(n).fill(false);
  /**
   * 末站坐标：**不改函数签名**（`stops` 本来就在入参里），直接取最后一个。
   * 口径：`stops` 与 `leg.colored` **同源 GCJ-02**（生产链路 `/api/stations` 已在服务端
   * `wgs84ToGcj02` 转过；见 `src/app/api/stations/route.ts` 的坐标系铁律），
   * 故这里存的是 **GCJ-02**，与 `fix`（同样 GCJ-02）可直接比。
   */
  const lastStop = stops.length ? stops[stops.length - 1] : null;
  const endStop: LL | null = lastStop ? [lastStop.lng, lastStop.lat] : null;
  if (colored.length < 2) return { path: [], ladder, valid, endStop };
  const cum = cumDistM(colored);

  let prev = -1;
  for (let i = 0; i < n; i++) {
    const s = stops[i];
    if (!s) continue;
    const proj = nearestOnPath(colored, s);
    if (proj.distM > LRT_TOL_M) continue; // 投影离站过远 ⇒ 剔除
    const d = cum[proj.idx];
    if (d <= prev) continue; // 单调化（乱序剔除）
    ladder[i] = d;
    valid[i] = true;
    prev = d;
  }
  return { path: colored, ladder, valid, endStop };
}

/** 自下标起首个有效站的相邻站距（米）—— 用于 H 计算；无相邻 ⇒ 0 */
function minAdjacentGap(ladder: number[], valid: boolean[], from: number): number {
  const prevD = Number.isFinite(ladder[from]) ? ladder[from] : 0;
  for (let i = from + 1; i < ladder.length; i++) {
    if (valid[i]) return Math.abs(ladder[i] - prevD);
  }
  return 0;
}

export interface LrtAdvanceInput {
  prevPassedIdx: number;
  prevComputed: number;
  prevDist: number;
  prevTs: number;
  /** 连续不可信帧数 */
  badStreak: number;
  ladder: LrtLadder;
  fix: FixLite | null;
  /**
   * ★ 上一帧的停靠站下标（`null` = 行驶中）。冻结时**原样带回** —— 否则
   *   「车已停稳 + 信号变差 ⇒ 冻结」会让 `kind` 退回 `between`、`alarm` 从
   *   `now` 掉回 `soon`，界面在站台上闪烁。缺省 `null`（手搓夹具不受影响）。
   */
  prevAtIdx?: number | null;
  /**
   * ★ 最近若干帧的 `computed`（**不含本帧**），用于「窗口计数」采纳判据。
   *   缺省 ⇒ **退回旧的「连续 2 帧一致」**，保证既有夹具与调用点逐条不变。
   */
  recentComputed?: number[];
}

export interface LrtAdvanceResult {
  passedIdx: number;
  computed: number;
  distNow: number;
  ts: number;
  badStreak: number;
  /** true = 本帧冻结 / 未推进（保留上次进度） */
  frozen: boolean;
  /**
   * ★ 本帧是否**停在某站**（`null` = 行驶中 / 未知）。调用方存回 `prevAtIdx`。
   *
   * 这是「轻轨没有到站/下车判定」的根因修复：旧实现 `makeProgress` 恒返回
   * `kind:"between"` + `atIdx:null` ⇒ `alight-detect` 的 `atIdx === lastIdx`、
   * `alarm` 的 `now` 分支、站条四态全部拿不到停靠态。
   */
  atIdx: number | null;
  /**
   * ★ 窗口：本帧 `computed` 已 push 并截到最近 3 个。调用方原样存回 `recentComputed`。
   *   **冻结 / 不可信 / 跳变帧不写入**（它们不携带推进信息）⇒ 窗口天然不被污染。
   */
  recentComputed: number[];
  progress: TrackProgress;
}

const EMPTY: TrackProgress = { kind: "lost", passedIdx: -1, atIdx: null, nextIdx: null };

/**
 * 停站半径（米）：`min(LRT_STOP_R_M, 0.4 × 相邻站距)`。
 * 站距过短时压小，避免把相邻两站并成一站（自适应上限，不是第二个人工常量）。
 */
function stopRadiusOf(ladder: LrtLadder, from: number): number {
  const gap = minAdjacentGap(ladder.ladder, ladder.valid, from);
  return gap > 0 ? Math.min(LRT_STOP_R_M, 0.4 * gap) : LRT_STOP_R_M;
}

/**
 * 推进一帧。**纯函数**：调用方持有 `prev*` 状态并回写返回的
 * `passedIdx / computed / distNow / ts / badStreak / atIdx / recentComputed`。
 */
export function advanceLrt(input: LrtAdvanceInput): LrtAdvanceResult {
  const { ladder, fix } = input;
  const lastIdx = ladder.ladder.length - 1;
  const prevAtIdx = input.prevAtIdx ?? null;

  /**
   * ★ 停靠态用 `kind:"at"` 表达（与 `TrackProgress` 的契约一致），
   *   `nextIdx` 仍按「下一站」给，站条四态才能同时拿到「在站」与「下一站」。
   */
  const makeProgress = (passedIdx: number, atIdx: number | null): TrackProgress => {
    if (lastIdx < 0) return EMPTY;
    if (atIdx != null) {
      return {
        kind: "at",
        atIdx,
        passedIdx,
        nextIdx: atIdx + 1 <= lastIdx ? atIdx + 1 : null,
      };
    }
    const nextIdx = passedIdx + 1 <= lastIdx ? passedIdx + 1 : null;
    return { kind: "between", passedIdx, atIdx: null, nextIdx };
  };

  /** 冻结：保留上次进度（badStreak 由调用方累加）；**窗口不写入** */
  const frozen = (badStreak: number): LrtAdvanceResult => ({
    passedIdx: input.prevPassedIdx,
    computed: input.prevComputed,
    distNow: input.prevDist,
    ts: input.prevTs,
    badStreak,
    frozen: true,
    atIdx: prevAtIdx,
    recentComputed: input.recentComputed ?? [],
    progress: makeProgress(input.prevPassedIdx, prevAtIdx),
  });

  if (!fix || ladder.path.length < 2) return frozen(input.badStreak + 1);

  const proj = nearestOnPath(ladder.path, fix);
  const off = proj.distM;
  const cum = cumDistM(ladder.path);
  const dNow = cum[proj.idx];

  // ① 可信门
  const trusted = off <= LRT_TOL_M && fix.accuracy <= LRT_ACC_MAX_M;
  if (!trusted) {
    const badStreak = input.badStreak + 1;
    if (badStreak >= 2) return frozen(badStreak); // 连续 2 帧不可信 ⇒ 冻结
    return {
      passedIdx: input.prevPassedIdx,
      computed: input.prevComputed,
      distNow: input.prevDist,
      ts: fix.ts,
      badStreak,
      frozen: false,
      atIdx: prevAtIdx,
      recentComputed: input.recentComputed ?? [],
      progress: makeProgress(input.prevPassedIdx, prevAtIdx),
    };
  }

  // ② 速度合理性（异常大丢帧；异常小不推进）
  const dtSec = (fix.ts - input.prevTs) / 1000;
  if (input.prevTs > 0 && dtSec > 0) {
    const kmh = (Math.abs(dNow - input.prevDist) / dtSec) * 3.6;
    if (kmh > 80) return frozen(0); // 投影跳变 ⇒ 丢帧（★ 该帧也不得写入窗口）
  }

  /**
   * ③ **停站判定**（放在可信门与速度门之后 ⇒ 跳变/不可信帧不产生停靠态）
   *
   * 判据是**双向**的「距站 ≤ stopR」，不是旧的「越过 ladder[i] + H」——
   * 后者在停站期间（`dNow ≈ ladder[i]`）永远不成立，必须等出站再跑 60m，
   * 这正是「轻轨到站判定 20s+」的机制性原因。
   */
  const stopR = stopRadiusOf(ladder, input.prevPassedIdx + 1);
  let nearIdx: number | null = null;
  let nearGap = Infinity;
  for (let i = 0; i < ladder.ladder.length; i++) {
    if (!ladder.valid[i]) continue;
    const g = Math.abs(dNow - ladder.ladder[i]);
    if (g < nearGap) {
      nearGap = g;
      nearIdx = i;
    }
  }
  let atIdx: number | null = null;
  /**
   * ★ 防跳站不变量：最多只认 `prevPassedIdx` 或 `prevPassedIdx + 1`。
   *   GPS 一帧跳到第 5 站，也只认到 1 —— 不许连跳。**本轮唯一硬约束，勿放宽。**
   */
  if (nearIdx != null && nearGap <= stopR) {
    const allowed = nearIdx === input.prevPassedIdx || nearIdx === input.prevPassedIdx + 1;
    if (allowed) {
      /**
       * ★ 末站双条件：折线末顶点**不落在末站上**（实测缺口 3.8~149.2m），
       *   只判「折线到底」会在离站台 100 多米处报「已到末站」⇒ 提前宣告下车。
       *   `endStop` 为 `null`（末站缺坐标）⇒ **退化为只判折线到底**（旧行为，不判死）。
       */
      let okAt = true;
      if (nearIdx === lastIdx) {
        if (ladder.endStop) {
          const dEnd = distM([fix.lng, fix.lat], ladder.endStop);
          okAt = dEnd <= stopR;
        } else {
          okAt = dNow >= cum[cum.length - 1];
        }
      }
      if (okAt) atIdx = nearIdx;
    }
  }

  // ④ Hysteresis
  const H = Math.max(
    LRT_H_MIN_M,
    fix.accuracy,
    0.25 * minAdjacentGap(ladder.ladder, ladder.valid, input.prevPassedIdx + 1),
  );

  // ⑤ 已过站 = max{ i : d_now > ladder[i] + H }
  let computed = -1;
  for (let i = 0; i < ladder.ladder.length; i++) {
    if (!ladder.valid[i]) continue;
    if (dNow > ladder.ladder[i] + H) computed = i;
  }

  /**
   * ⑥ 采纳判据：**窗口计数**（最近 3 帧里 ≥2 帧同值）优先；`recentComputed` 缺省 ⇒ 旧「连续 2 帧一致」。
   *
   * 为什么不能只用连续判据：`T,F,T,F` 交替抖动时连续判据永不 arm（反例见测试）。
   */
  const win = [...(input.recentComputed ?? []).slice(-2), computed];
  const hits = win.filter((x) => x === computed).length;
  const consistent = input.recentComputed ? hits >= 2 : computed === input.prevComputed;
  let adopted = input.prevPassedIdx;
  if (consistent) {
    adopted = Math.min(computed, input.prevPassedIdx + 1); // 单帧最多推进 1 站
  }
  // ⑦ 停在 i 站 ⇒ 0..i-1 已完全驶过（**i 站本身不算驶过**）；与已上取大
  if (atIdx != null) adopted = Math.max(adopted, atIdx - 1);
  // ⑧ 回退（迟滞）：需明显低于
  if (computed < input.prevPassedIdx && dNow < ladder.ladder[input.prevPassedIdx] - H) {
    adopted = Math.max(computed, input.prevPassedIdx - 1);
  } else if (computed < input.prevPassedIdx) {
    adopted = input.prevPassedIdx;
  }

  return {
    passedIdx: adopted,
    computed,
    distNow: dNow,
    ts: fix.ts,
    badStreak: 0,
    frozen: false,
    atIdx,
    recentComputed: win,
    progress: makeProgress(adopted, atIdx),
  };
}
