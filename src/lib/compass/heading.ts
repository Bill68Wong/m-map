/**
 * 朝向（compass heading）纯逻辑内核（src/lib/compass/heading.ts，★ 2026-11-12 · F1）
 *
 * ── 为什么单独抽成纯函数模块 ────────────────────────────────────────────
 *   朝向链路上有四个**只能靠推理保证正确**的点，全都无法在真机上"看一眼就知道对不对"：
 *     ① `alpha` 不是朝向（逆时针增、且竖持时 +Y 轴投影为 0）⇒ 必须倾斜补偿；
 *     ② 角度是环形量 ⇒ 359° → 1° 的平滑绝不能走线性插值（会倒转一整圈）；
 *     ③ 传感器 50~60Hz 抖动 + 磁力计噪声 ⇒ 必须死区 + 低通 + 角速度上限；
 *     ④ 不可用/精度差时要能**判定**并降级，而不是把噪声当朝向画到地图上。
 *   放在 hook 里就得靠真机人肉试；抽出来后 `scripts/test-compass-heading.ts`
 *   可以对每一种姿态给出确定断言。
 *
 * ── 坐标与角度约定（全仓统一，勿改）────────────────────────────────────
 *   · 朝向 `heading`：**0 = 正北，顺时针增大**（90 = 东，270 = 西），取值 [0, 360)；
 *     与 AMap 的 `rotation` 方向相反，也与 CSS `rotate()` 的顺时针一致 ⇒
 *     箭头直接 `rotate(heading)` 即"指向用户面朝方向"。
 *   · 设备帧：X 右、Y 上（屏幕顶端）、Z 垂直屏幕向外。设备方向角 span
 *     `alpha`(z，逆时针) / `beta`(x) / `gamma`(y) 均为**度**。
 */

/** 角度归一化到 [0, 360) */
export function normalizeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

/**
 * `from → to` 的**最短弧**有向差，取值 (-180, 180]。
 *
 * 例：`shortestDeltaDeg(350, 10) === 20`（向右转 20°），
 *     `shortestDeltaDeg(10, 350) === -20`（向左转 20°）。
 * ★ 平滑/限速一律基于本函数的结果，绝不能直接对两个角度做减法 ——
 *   否则跨 0° 时会出现 -350° 的"反向暴转"，视觉上就是箭头突然整整绕一圈。
 */
export function shortestDeltaDeg(from: number, to: number): number {
  const d = normalizeDeg(to) - normalizeDeg(from);
  if (d > 180) return d - 360;
  if (d <= -180) return d + 360;
  return d;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * ★ 屏幕旋转补偿的符号（**真机验证前保持 1**）。
 *   横屏时屏幕的"上方"不再是设备的 +Y 轴，箭头要跟着屏幕坐标系转，
 *   所以航向要叠加 `screen.orientation.angle`。符号取决于浏览器对
 *   `angle` 的定义方向（各版本历史上出现过不一致），故留成单点常量：
 *   真机横屏实测若发现箭头反向偏 90°，把这里改成 -1 即可，不用改别处。
 */
const SCREEN_ANGLE_SIGN = 1;

/** 读取屏幕旋转角（度，0/90/180/270）；SSR 或旧浏览器返回 0 */
export function screenAngleDeg(): number {
  if (typeof window === "undefined") return 0;
  const so = window.screen?.orientation;
  if (so && typeof so.angle === "number") return so.angle;
  // 旧 iOS / Android WebView 的兜底（已废弃 API，但仍是部分 WebView 唯一来源）
  const legacy = (window as unknown as { orientation?: number }).orientation;
  return typeof legacy === "number" ? normalizeDeg(legacy) : 0;
}

/** 姿态分界（度）：|beta| 小于此值按「平放」用屏幕顶端 +Y 轴；否则按「竖持」用背面 -Z 轴 */
const UPRIGHT_BETA_DEG = 45;

export interface OrientationInput {
  /** 绕 z 轴（逆时针，度） */
  alpha?: number | null;
  /** 绕 x 轴（度） */
  beta?: number | null;
  /** 绕 y 轴（度） */
  gamma?: number | null;
  /** iOS Safari 专有：已补偿好的罗盘朝向（顺时针，度） */
  webkitCompassHeading?: number | null;
  /** 屏幕旋转角（度）；缺省用 `screenAngleDeg()` */
  screenAngleDeg?: number;
}

/**
 * 由设备方向角求**用户面朝方向**（0 = 北，顺时针）。
 *
 * ── 倾斜补偿的推导（不要改成"360 - alpha"）────────────────────────────
 *   设备方向角是内旋 Z-X'-Y''，旋转矩阵 R = Rz(α)·Rx(β)·Ry(γ)。
 *   取设备 +Y（屏幕顶端）在水平面的投影：`(-sinα·cosβ, cosα·cosβ)`；
 *   取设备 -Z（背面朝向，即"手机指哪儿"）的水平投影：
 *   `(-(cosα·sinγ + sinα·sinβ·cosγ), -(sinα·sinγ - cosα·sinβ·cosγ))`。
 *   水平面内 x=东、y=北 ⇒ `heading = atan2(vx, vy)`。
 *
 *   · 平放（|β| ≤ 45°）：+Y 轴水平投影长度 cosβ 足够大 ⇒ 用它；
 *   · 竖持（|β| > 45°）：+Y 轴接近竖直（投影趋 0），但人举着手机看地图时
 *     真正"指向前方"的是**背面** ⇒ 换用 -Z 轴。
 *   · 两者在 γ=0 时恒等（下面门禁里有一条断言专门锁这件事），所以换轴不会跳变。
 *
 * @returns 朝向 [0, 360)；姿态退化（投影长度≈0，例如手机平放在桌面且只取背面）
 *          或输入非法时返回 `null`（**不要返回 0** —— 0 是"正北"，会被当成有效朝向）
 */
export function headingFromOrientation(input: OrientationInput): number | null {
  const wk = input.webkitCompassHeading;
  if (typeof wk === "number" && Number.isFinite(wk)) {
    // iOS 已经给出补偿好的罗盘朝向；仍需叠加屏幕旋转（横屏时屏幕上方≠设备上方）
    const screen = input.screenAngleDeg ?? screenAngleDeg();
    return normalizeDeg(wk + SCREEN_ANGLE_SIGN * screen);
  }

  const a = input.alpha;
  if (typeof a !== "number" || !Number.isFinite(a)) return null;
  const b = typeof input.beta === "number" && Number.isFinite(input.beta) ? input.beta : 0;
  const g = typeof input.gamma === "number" && Number.isFinite(input.gamma) ? input.gamma : 0;

  const ra = a * DEG2RAD;
  const rb = b * DEG2RAD;
  const rg = g * DEG2RAD;
  const ca = Math.cos(ra);
  const sa = Math.sin(ra);
  const cb = Math.cos(rb);
  const sb = Math.sin(rb);
  const cg = Math.cos(rg);
  const sg = Math.sin(rg);

  let vx: number;
  let vy: number;
  if (Math.abs(b) <= UPRIGHT_BETA_DEG) {
    vx = -sa * cb;
    vy = ca * cb;
  } else {
    vx = -(ca * sg + sa * sb * cg);
    vy = -(sa * sg - ca * sb * cg);
  }

  // 水平投影接近 0（姿态退化）⇒ 无有效朝向；阈值取 1e-3 以避开浮点噪声
  if (Math.hypot(vx, vy) < 1e-3) return null;

  const screen = input.screenAngleDeg ?? screenAngleDeg();
  return normalizeDeg(Math.atan2(vx, vy) * RAD2DEG + SCREEN_ANGLE_SIGN * screen);
}

/* ══════════════════════════ 箭头旋转（★ F2）══════════════════════════ */

/**
 * 把一帧朝向接到**连续角度**上（不做 [0,360) 归一化）。
 *
 * ── 为什么必须要这一步（F2 唯一的真坑）────────────────────────────────
 *   CSS 的 `rotate()` 是按数值线性解释的：`rotate(359deg)` → `rotate(1deg)`
 *   会被当作**倒退 358°**，视觉上就是箭头突然反向绕一整圈。
 *   所以喂给 CSS 的必须是一条**不回绕**的数值序列：359 → 361（+2°），
 *   而不是 359 → 1。本函数用最短弧累加，保证跨 0° 时只走那 2°。
 *
 * @param prevContinuous 上一次的连续角度（`null` = 第一次，从当前值起算）
 * @param targetDeg      新的朝向（任意实数，内部归一化）
 * @returns 连续角度（可能 >360 或 <0，这是**故意的**；不要在外面再归一化）
 */
export function nextArrowDeg(prevContinuous: number | null, targetDeg: number): number {
  if (!Number.isFinite(targetDeg)) return Number.isFinite(prevContinuous as number) ? (prevContinuous as number) : 0;
  const target = normalizeDeg(targetDeg);
  if (prevContinuous === null || !Number.isFinite(prevContinuous)) return target;
  return prevContinuous + shortestDeltaDeg(prevContinuous, target);
}

/* ══════════════ GPS 行进方向（★ F3：罗盘不可用时的第一替补）══════════════ */

/**
 * 把 `coords.heading` 收敛成「可用 / 不可用」两态。
 *
 * 各平台给的东西五花八门（实测 + 规范）：
 *   · 取不到方向 ⇒ `null`（规范值）；
 *   · 部分 Android WebView ⇒ `NaN`；
 *   · 部分机型在静止时 ⇒ `-1` 或负数（不是合法方位角）。
 * ⚠️ **0 是合法值**（正北行进），不能当「没有」—— 这正是"用 `if (!heading)` 判空"会
 *    在正北方向恰好失效的原因。
 */
export function fixHeadingOf(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return normalizeDeg(raw);
}

/**
 * 把 `coords.speed` 收敛成 m/s。
 * 负数物理上不存在（部分实现用 -1 表示未知）⇒ 一律当没有。
 */
export function fixSpeedOf(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < 0) return null;
  return raw;
}

/**
 * ★ F3：**最终画什么**的唯一判定（纯函数 —— hook 与门禁共用）。
 *
 * ── 为什么"正北"要返回 `null` 而不是 0 ────────────────────────────────
 *   计划原文写的是「无传感器 ⇒ 箭头固定朝上」。落地时改成**不画**，原因有两条：
 *     ① 主流程（导航详情面板）**没有位置**放"按正北显示"这句提示 —— 那时屏幕上
 *        只有一个恒朝北的锥形，用户会把它读成「我正朝北」；
 *     ② 本项目已经为同一类错误付过一次代价（P6：把"不在服务范围"说成"线路已收班"）。
 *        把"不知道朝向"画成一个确定的箭头，是同一个病。
 *   ⇒ 朝向**不知道就不画**，"按正北朝上"由地图本身（`rotateEnable:false`，恒北向上）
 *     与步行面板的一行小字承担，不靠一个假箭头。
 *
 * 门禁 `scripts/test-compass-fallback.ts` 对这两个分支各有断言。
 */
export function resolveHeading(o: {
  /** 是否处于需要朝向的场景（仅步行段；非步行段一律不画） */
  enabled: boolean;
  compassHeading: number | null;
  quality: HeadingQuality;
  courseDeg: number | null;
  speedMps: number | null;
}): { mode: HeadingMode; heading: number | null } {
  if (!o.enabled) return { mode: "north", heading: null };
  const mode = pickHeadingMode({
    compassHeading: o.compassHeading,
    quality: o.quality,
    courseDeg: o.courseDeg,
    speedMps: o.speedMps,
  });
  if (mode === "compass") return { mode, heading: o.compassHeading ?? null };
  if (mode === "course") return { mode, heading: o.courseDeg ?? null };
  return { mode: "north", heading: null };
}

/* ══════════════════════════ 平滑器 ══════════════════════════ */

/** 死区（度）：小于此变化视为噪声，不更新 —— 静置时箭头必须"纹丝不动" */
export const HEADING_DEADBAND_DEG = 1.2;
/** 常规低通时间常数（ms）：越小越跟手、越大越稳。180ms ≈ 跟手且不抖 */
export const HEADING_TAU_MS = 180;
/** 快速转身的判定（度/帧）：超过则改用更小的时间常数，避免"转身时箭头慢半拍" */
export const HEADING_FAST_DELTA_DEG = 25;
/** 快速转身时的时间常数（ms） */
export const HEADING_FAST_TAU_MS = 45;
/** 角速度上限（度/秒）：防磁扰时的瞬间大跳变（人转身极限约 300~400°/s） */
export const HEADING_MAX_RATE_DEG_S = 540;

export interface HeadingSmootherOpts {
  deadbandDeg?: number;
  tauMs?: number;
  fastDeltaDeg?: number;
  fastTauMs?: number;
  maxRateDegPerS?: number;
}

export interface HeadingSmoother {
  /**
   * 送入一帧原始朝向，返回平滑后的朝向。
   * @param rawDeg 原始朝向（度；非有限值直接忽略，返回上一次结果）
   * @param tsMs   采样时刻（ms；用 `event.timeStamp` 或 `performance.now()`）
   */
  push(rawDeg: number, tsMs: number): number;
  /** 当前平滑值（还没收到任何帧时为 null） */
  readonly value: number | null;
  reset(): void;
}

/**
 * 环形低通平滑器（**最短弧 + 自适应时间常数 + 死区 + 角速度上限**）。
 *
 * 为什么不用"滑动平均"：滑动平均对跳变迟钝，且跨 0° 需要额外处理；
 * 指数低通配合最短弧，代码量更小、可加死区与限速，且 dt 自适应（帧率无关）。
 */
export function createHeadingSmoother(opts: HeadingSmootherOpts = {}): HeadingSmoother {
  const deadband = opts.deadbandDeg ?? HEADING_DEADBAND_DEG;
  const tau = opts.tauMs ?? HEADING_TAU_MS;
  const fastDelta = opts.fastDeltaDeg ?? HEADING_FAST_DELTA_DEG;
  const fastTau = opts.fastTauMs ?? HEADING_FAST_TAU_MS;
  const maxRate = opts.maxRateDegPerS ?? HEADING_MAX_RATE_DEG_S;

  let value: number | null = null;
  let lastTs = 0;

  return {
    push(rawDeg: number, tsMs: number): number {
      if (!Number.isFinite(rawDeg)) return value ?? 0;
      const raw = normalizeDeg(rawDeg);
      if (value === null) {
        value = raw;
        lastTs = tsMs;
        return raw;
      }

      // dt 夹在 [1, 250]：首帧后时间戳异常（0/回退）时不至于除零，也不会一次吃掉整段
      const dt = Math.min(250, Math.max(1, tsMs - lastTs));
      lastTs = tsMs;

      const delta = shortestDeltaDeg(value, raw);
      if (Math.abs(delta) < deadband) return value; // 死区：噪声不外显

      const useTau = Math.abs(delta) > fastDelta ? fastTau : tau;
      const k = 1 - Math.exp(-dt / useTau);
      let step = delta * k;

      // 角速度上限：磁扰/校准跳变时不允许一帧转过大角度
      const maxStep = (maxRate * dt) / 1000;
      if (Math.abs(step) > maxStep) step = Math.sign(step) * maxStep;

      value = normalizeDeg(value + step);
      return value;
    },
    get value() {
      return value;
    },
    reset() {
      value = null;
      lastTs = 0;
    },
  };
}

/* ══════════════════════════ 质量与降级 ══════════════════════════ */

/** iOS `webkitCompassAccuracy` 门限（度）：超过即判"精度不足"；负值 = 无效 */
export const COMPASS_ACC_MAX_DEG = 25;
/**
 * 抖动门限（**度**，最近 `COMPASS_JITTER_SAMPLES` 帧的累计摆动量）：
 * Android（无系统精度字段）用它替代精度字段。
 *
 * ⚠️ 单位是"窗口内累计度数"，**不是度/秒**。二者不能混：
 *   同一物理抖动，50Hz 采样 24 帧只覆盖 0.48s、10Hz 覆盖 2.4s，
 *   累计量不同。本仓库的判定窗口由**样本数**固定（24 帧，见 `headingJitterDeg` 调用处），
 *   所以阈值 25 与采样率无关，只与"每帧差 ≈1°"这个量级挂钩。
 *   真要按物理速率（度/秒）判，得先拿真机标定正常噪声的基线，否则换个机型就失效
 *   —— 所以 F4 **没有**引入速率口径，只沿用 F1 这一套。
 */
export const COMPASS_JITTER_MAX_DEG = 25;
/** 抖动判定的样本数（与 F1 质量判定的窗口一致，勿单独改） */
export const COMPASS_JITTER_SAMPLES = 24;

export type HeadingQuality = "ok" | "poor" | "invalid";

/**
 * 判定罗盘质量。
 * @param webkitAccuracy iOS 的 `webkitCompassAccuracy`（度；非 iOS 传 null）
 * @param jitterDeg      `headingJitterDeg` 的结果（度；仅在没有系统精度字段时才参考）
 *                       —— iOS 自己算的精度更可信，我们自算的抖动分不清"手抖"与"磁扰"
 */
export function headingQualityOf(webkitAccuracy: number | null, jitterDeg: number): HeadingQuality {
  if (typeof webkitAccuracy === "number" && Number.isFinite(webkitAccuracy)) {
    if (webkitAccuracy < 0) return "invalid";
    return webkitAccuracy > COMPASS_ACC_MAX_DEG ? "poor" : "ok";
  }
  if (jitterDeg > COMPASS_JITTER_MAX_DEG) return "poor";
  return "ok";
}

export interface HeadingSample {
  deg: number;
  ts: number;
}

/**
 * **抖动度**（度）：最近窗口内"来回摆动的总量"。
 *
 * 定义 = Σ|相邻样本最短弧差| − |首尾最短弧差|。
 *   · 静止 + 噪声（0→4→-3→2→0）：路径 18、净位移 0 ⇒ 抖动 18（大）；
 *   · 匀速转身（0→10→20→30）：路径 30、净位移 30 ⇒ 抖动 0（小）。
 * ★ 这正是为什么不能用"相对首样本的最大偏差"：那样一次正常转身 180°
 *   会被算成 180 ⇒ 判成磁扰 ⇒ 箭头在用户转身时刚好失效（最坏的时机）。
 * 样本 < 3 时返回 0（无从判断，按稳定处理）。
 */
export function headingJitterDeg(samples: HeadingSample[]): number {
  if (samples.length < 3) return 0;
  let path = 0;
  for (let i = 1; i < samples.length; i++) {
    path += Math.abs(shortestDeltaDeg(samples[i - 1].deg, samples[i].deg));
  }
  const net = Math.abs(shortestDeltaDeg(samples[0].deg, samples[samples.length - 1].deg));
  const jitter = path - net;
  return jitter > 0 ? jitter : 0;
}

/**
 * **抖动速率**（度/秒）：把 `headingJitterDeg` 的总量按样本实际时间跨度归一化。
 *
 * ⚠️ **不参与判定**（F4 明确不用它）：阈值 25 是按"24 帧累计度"标定的，
 *   换成度/秒需要先拿真机测出各机型正常噪声的基线，否则同一台手机换个浏览器就误判。
 *   保留本函数只用于**排查与观测**（比如打印日志看某台设备的抖动量级），
 *   谁要拿它做判定，先补一份真机基线数据。
 *
 * @returns 度/秒；样本 < 3 或时间跨度为 0 时返回 0
 */
export function headingJitterRateDegPerSec(samples: HeadingSample[]): number {
  if (samples.length < 3) return 0;
  const span = samples[samples.length - 1].ts - samples[0].ts;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return (headingJitterDeg(samples) * 1000) / span;
}

/** 朝向来源：罗盘 / GPS 行进方向 / 正北（兜底） */
export type HeadingMode = "compass" | "course" | "north";

/** GPS 航向可用的最低速度（m/s）—— 静止时 `coords.heading` 是 null 或噪声 */
export const COURSE_MIN_SPEED_MPS = 1.2;

/**
 * 降级链选源（纯函数，供 hook 与门禁共用）。
 *
 * 顺序固定：① 罗盘可用且质量 ok ⇒ compass；
 *          ② 否则 GPS 航向可用（有值 + 速度达标）⇒ course（"我朝行进方向"）；
 *          ③ 都不行 ⇒ north（正北，箭头固定朝上）。
 * ⚠️ 顺序不可颠倒：行进方向是"我刚才往哪走"，站着不动时它没有意义；
 *    只有罗盘真的不可信时才退到它。
 */
export function pickHeadingMode(o: {
  compassHeading: number | null;
  quality: HeadingQuality;
  courseDeg: number | null;
  speedMps: number | null;
}): HeadingMode {
  if (o.compassHeading != null && o.quality === "ok") return "compass";
  const moving = typeof o.speedMps === "number" && o.speedMps >= COURSE_MIN_SPEED_MPS;
  if (o.courseDeg != null && Number.isFinite(o.courseDeg) && moving) return "course";
  return "north";
}
