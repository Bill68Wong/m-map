/**
 * 磁扰检测与降级判定（src/lib/compass/disturbance.ts，★ 2026-11-16 · F4）
 *
 * ── 要解决的两个真问题 ────────────────────────────────────────────────
 *   ① **磁扰时不能装作没事**：进电梯、贴铁栏杆、靠近音箱，磁力计读数会乱摆几十度；
 *      此时把噪声当朝向画给用户，箭头会自己转圈，比不画更糟（用户会以为自己走错方向）。
 *   ② **也不能一抖就报"磁扰"**：手抖、走路晃动、正常转身都会让读数变化；
 *      动辄弹「画 8 字校准」，用户会把它当噪音（本项目 P6 的教训：错误归因比不提示更伤）。
 *
 * ── 判据（沿用 F1，不另立口径）────────────────────────────────────────
 *   · iOS：`webkitCompassAccuracy` —— 系统融合多传感器的结论，**有它就只信它**；
 *   · Android / 无该字段：`headingJitterDeg`（路径总长 − 净位移）。
 *     这个定义天然排除匀速转身（转身时路径 ≈ 净位移 ⇒ 抖动 ≈ 0），
 *     所以「转身时不误报」是**判据本身的数学性质**，不是靠调阈值调出来的。
 *   判定基准与阈值全部复用 `lib/compass/heading.ts`（`headingQualityOf`），
 *   本模块**不新增任何精度阈值** —— 没有真机基线就去拍新数字，只是把 bug 换个位置。
 *
 * ── 本模块唯一新增的维度是「时间」──────────────────────────────────────
 *   单帧下结论会误伤：一次碰撞、一次抬手都能造成瞬时跳变。
 *   所以噪声证据必须**连续** `DISTURB_CONFIRM_MS` 才升级状态；
 *   恢复也要连续 `DISTURB_RECOVER_MS` 正常才降级（否则阈值边缘来回闪，提示一闪一闪）。
 *
 * ── GPS 佐证（"一致性融合"的唯一正当用法）──────────────────────────────
 *   ⚠️ **不能**用"罗盘与行进方向偏差大 ⇒ 磁扰"来判定：人边走边侧着拿手机看地图，
 *      朝向与行进方向差 90° 是完全正常的，那样会把绝大多数正常用户判成磁扰。
 *   ⇒ GPS 只在**反方向**上使用：读数已被判不可信时，如果正在稳定直线行走，
 *      且**平滑后**的朝向仍与行进方向一致（≤25°），说明"抖的是噪声、方向没跑偏"
 *      ⇒ 降为 `mild`（保留箭头，交给平滑器吸收），不打扰用户去校准。
 *      只有"方向也说不通"才判 `strong`（不画 + 提示校准）。
 *   这也是 `resolveHeading` 的分工：**strong 才降级，mild 仍可用**。
 *
 * ── 与 F1/F3 的关系 ───────────────────────────────────────────────────
 *   · 本模块**不碰**平滑器（`createHeadingSmoother`）与选源（`pickHeadingMode`）；
 *   · 输入里的 `smoothed` 由调用方先过平滑器再传进来（佐证需要"已经压过噪声"的值）；
 *   · 输出 `quality` 直接替换 F1 的单帧质量判定 ⇒ 选源那层不必知道磁扰的存在。
 *
 * 纯逻辑、无 React、无副作用 ⇒ `scripts/test-compass-robust.ts` 用模拟序列直接验收
 * （静止漂移、跟踪误差、磁扰响应时间、匀速转身不误报都无法在真机上复现）。
 */
import {
  COMPASS_JITTER_SAMPLES,
  COURSE_MIN_SPEED_MPS,
  headingJitterDeg,
  headingQualityOf,
  normalizeDeg,
  shortestDeltaDeg,
  type HeadingQuality,
  type HeadingSample,
} from "./heading";

/**
 * 升级确认期（ms）：噪声证据要连续这么久才认为"真的受扰"。
 * 取 1.2s 而不是更短：单次碰撞/抬手的瞬时跳变典型持续 1~3 帧；
 * 而计划验收要求"磁扰 3s 内出提示"，1.2s 确认后立即出，留足余量。
 */
export const DISTURB_CONFIRM_MS = 1_200;
/** 降级确认期（ms）：连续正常这么久才回到 `none`，避免阈值边缘闪烁 */
export const DISTURB_RECOVER_MS = 1_500;
/** GPS 佐证：平滑朝向与行进方向的最大允许偏差（度） */
export const CORROBORATE_MAX_DIFF_DEG = 25;
/** 抖动样本数（与 F1 的质量窗口同一口径） */
export const DISTURB_SAMPLE_MAX = COMPASS_JITTER_SAMPLES;
/** 行进方向样本数（GPS 航向也会抖，取一段的均值再比） */
export const COURSE_SAMPLE_MAX = COMPASS_JITTER_SAMPLES;

/** `none` = 正常；`mild` = 读数抖但方向可信（保留箭头）；`strong` = 不可信（降级 + 提示校准） */
export type DisturbLevel = "none" | "mild" | "strong";

export interface DisturbSample {
  /** 本帧原始朝向（度，未平滑） */
  deg: number;
  /** 本帧**平滑后**朝向（度）；GPS 佐证用它，避免拿噪声去比 */
  smoothed: number;
  /** 采样时刻（ms） */
  ts: number;
  /** iOS `webkitCompassAccuracy`（度）；本机不提供时 `null` */
  accuracyDeg: number | null;
  /** GPS 行进方向（度）；无则 `null` */
  courseDeg: number | null;
  /** 速度（m/s）；无则 `null` */
  speedMps: number | null;
}

export interface DisturbState {
  level: DisturbLevel;
  /** 合成后的质量（`strong` ⇒ poor，`mild` ⇒ ok）—— 选源那层直接用这个 */
  quality: HeadingQuality;
  /** 最近窗口的累计抖动度（度），供观测与门禁断言 */
  jitterDeg: number;
  /** 本帧是否靠 GPS 佐证把 `strong` 降成了 `mild` */
  corroborated: boolean;
  /** 本轮受扰开始时刻（ms）；`level === "none"` 时为 `null` */
  sinceTs: number | null;
}

export interface DisturbanceDetector {
  push(sample: DisturbSample): DisturbState;
  readonly state: DisturbState;
  reset(): void;
}

export interface DisturbanceDetectorOpts {
  confirmMs?: number;
  recoverMs?: number;
}

/**
 * 圆形均值（度）。
 *
 * ⚠️ 不能直接算术平均：359° 与 1° 的算术平均是 180°（正南），而真实均值是 0°（正北）。
 * 做法：以首样本为基准累加**最短弧差**，再取平均 —— 只要样本离散度 < 180° 就正确，
 * 而行进方向的样本本来就在同向附近（真转弯时这个均值会滞后半拍，可接受：
 * 佐证只在"已经被判不可信"时才用，那里不需要毫秒级跟随）。
 */
function circularMeanDeg(samples: HeadingSample[]): number | null {
  if (samples.length === 0) return null;
  const base = samples[0].deg;
  let sum = 0;
  for (const s of samples) sum += shortestDeltaDeg(base, s.deg);
  return normalizeDeg(base + sum / samples.length);
}

const IDLE: DisturbState = {
  level: "none",
  quality: "ok",
  jitterDeg: 0,
  corroborated: false,
  sinceTs: null,
};

export function createDisturbanceDetector(opts: DisturbanceDetectorOpts = {}): DisturbanceDetector {
  const confirmMs = opts.confirmMs ?? DISTURB_CONFIRM_MS;
  const recoverMs = opts.recoverMs ?? DISTURB_RECOVER_MS;

  const buf: HeadingSample[] = [];
  const courseBuf: HeadingSample[] = [];

  let state: DisturbState = IDLE;
  /** 本轮噪声证据的起点 */
  let overSince: number | null = null;
  /** 上一次"有噪声证据"的时刻（恢复确认期用） */
  let lastOverTs: number | null = null;

  return {
    push(s: DisturbSample): DisturbState {
      if (!Number.isFinite(s.ts) || !Number.isFinite(s.deg)) return state;

      /**
       * 窗口按**样本数**固定（与 F1 一致），不按时间 —— 见 `COMPASS_JITTER_MAX_DEG`
       * 注释里那段"单位不能混"的说明。
       */
      buf.push({ deg: normalizeDeg(s.deg), ts: s.ts });
      while (buf.length > DISTURB_SAMPLE_MAX) buf.shift();

      const moving =
        s.courseDeg != null &&
        Number.isFinite(s.courseDeg) &&
        s.speedMps != null &&
        s.speedMps >= COURSE_MIN_SPEED_MPS;
      if (moving) {
        courseBuf.push({ deg: normalizeDeg(s.courseDeg as number), ts: s.ts });
        while (courseBuf.length > COURSE_SAMPLE_MAX) courseBuf.shift();
      } else {
        // 停下来了 ⇒ 旧的行走样本不再代表"当前行进方向"，留着会让佐证判断滞后
        courseBuf.length = 0;
      }

      const jitterDeg = headingJitterDeg(buf);
      const base = headingQualityOf(s.accuracyDeg, jitterDeg);
      const over = base !== "ok";

      /**
       * GPS 佐证 —— 只在"已被判不可信"时才算，省掉绝大多数帧的算力。
       * `base === "invalid"`（iOS 报 -1，即罗盘本身没校准）**不允许**佐证：
       * 那种情况下方向可能整圈都是错的，靠 GPS 偶然对上就保留箭头等于赌运气。
       */
      let corroborated = false;
      if (over && base !== "invalid" && moving && courseBuf.length >= 6) {
        const courseMean = circularMeanDeg(courseBuf);
        if (courseMean != null) {
          corroborated = Math.abs(shortestDeltaDeg(s.smoothed, courseMean)) <= CORROBORATE_MAX_DIFF_DEG;
        }
      }

      let level: DisturbLevel = state.level;
      if (over) {
        if (overSince == null) overSince = s.ts;
        lastOverTs = s.ts;
        if (s.ts - overSince >= confirmMs) level = corroborated ? "mild" : "strong";
      } else if (lastOverTs != null && s.ts - lastOverTs < recoverMs) {
        // 刚恢复但没满恢复期 ⇒ 保持上一档（阈值边缘不闪）
        overSince = null;
      } else {
        overSince = null;
        lastOverTs = null;
        level = "none";
      }

      const quality: HeadingQuality = level === "strong" ? "poor" : level === "mild" ? "ok" : base;
      state = {
        level,
        quality,
        jitterDeg,
        corroborated,
        sinceTs: level === "none" ? null : overSince,
      };
      return state;
    },
    get state() {
      return state;
    },
    reset() {
      buf.length = 0;
      courseBuf.length = 0;
      overSince = null;
      lastOverTs = null;
      state = IDLE;
    },
  };
}
