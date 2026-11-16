/**
 * 抗磁扰门禁（scripts/test-compass-robust.ts · ★ F4 / 2026-11-16）
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 *   F4 的三条验收指标**没有一条能在真机上复现**：
 *     · 静止 30s 漂移 ≤3°
 *     · 直线行走跟踪误差 ≤10°
 *     · 磁扰 3s 内出提示，且匀速转身**不**触发
 *   真机上你没法让手机"精确静止 30 秒"、也没法"精确匀速转身 360°"。
 *   ⇒ 这里用**确定性伪随机**造模拟序列（同 seed 永远同一份数据），
 *     把平滑器 + 磁扰检测器串起来跑，逐条量化。
 *
 * ── 另外守三条"沉默失效"────────────────────────────────────────────
 *   ① 口径漂移：`useCompassHeading` 若又直接调 `headingQualityOf`，
 *      磁扰的"持续性 + GPS 佐证"就被绕过去了，代码看着没错、行为退回 F1；
 *   ② 顺序反了：先判磁扰再平滑，GPS 佐证就是拿噪声当证据（会随机成立/不成立）；
 *   ③ 提示变成噪音：「画 8 字」每会话只许出一次，否则用户会把它当广告。
 *
 * 跑法：`npm run test:compass-robust`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { createHeadingSmoother, shortestDeltaDeg } from "../src/lib/compass/heading";
import {
  CORROBORATE_MAX_DIFF_DEG,
  DISTURB_CONFIRM_MS,
  DISTURB_RECOVER_MS,
  createDisturbanceDetector,
  type DisturbState,
} from "../src/lib/compass/disturbance";
import {
  NOTE_HEADING_CALIBRATE,
  NOTE_HEADING_COURSE,
  NOTE_HEADING_ENABLE,
  NOTE_HEADING_NORTH,
  NOTE_HEADING_POOR,
  noteOfHeading,
  takeCalibrateTicket,
} from "../src/components/nav/compass-note";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${detail ? `  — ${detail}` : ""}`);
}

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** 去掉块注释与整行注释（本项目已三次被自己的注释骗过） */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join("\n");

/** 50Hz 采样（真机 `deviceorientation` 典型值） */
const DT = 20;

/** 确定性伪随机（xorshift32）：同 seed ⇒ 同一份序列，失败可复现 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

interface Step {
  deg: number;
  accuracyDeg?: number | null;
  courseDeg?: number | null;
  speedMps?: number | null;
}

interface Frame {
  t: number;
  raw: number;
  sm: number;
  st: DisturbState;
}

/**
 * 跑一段序列：原始帧 → 平滑器 → 磁扰检测器（与运行时**同一条链路、同一顺序**）。
 * ⚠️ 顺序必须与 `useCompassHeading` 一致（先平滑再判磁扰），
 *    否则门禁测的是一条生产环境不存在的路径。
 */
function run(seq: Step[], opts?: { confirmMs?: number; recoverMs?: number }): Frame[] {
  const smoother = createHeadingSmoother();
  const det = createDisturbanceDetector(opts);
  return seq.map((s, i) => {
    const t = i * DT;
    const sm = smoother.push(s.deg, t);
    const st = det.push({
      deg: s.deg,
      smoothed: sm,
      ts: t,
      accuracyDeg: s.accuracyDeg ?? null,
      courseDeg: s.courseDeg ?? null,
      speedMps: s.speedMps ?? null,
    });
    return { t, raw: s.deg, sm, st };
  });
}

const maxDev = (frames: Frame[], truth: number) =>
  Math.max(...frames.map((f) => Math.abs(shortestDeltaDeg(truth, f.sm))));

const p95 = (values: number[]) => {
  const a = [...values].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
};

/* ══════════════════════════════════════════════════════════════════════
 * ① 静止 30s：漂移 ≤3°，且正常噪声**不许**被判成磁扰
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ① 静止 30s（真值 90°，噪声 ±0.6°）═══\n");
{
  const rng = makeRng(7);
  // 30s × 50Hz = 1500 帧
  const seq: Step[] = Array.from({ length: 1500 }, () => ({ deg: 90 + (rng() * 2 - 1) * 0.6 }));
  const frames = run(seq);
  // 前 5s 是起步收敛，不计入稳定性（平滑器首帧取原值，必然带一帧噪声）
  const settled = frames.slice(250);
  const dev = maxDev(settled, 90);
  ok(dev <= 3, "静止 30s 最大漂移 ≤3°（验收 ①）", `实测 ${dev.toFixed(2)}°`);
  ok(
    settled.every((f) => f.st.level === "none"),
    "正常噪声**不**判磁扰（否则用户会一直被劝去画 8 字）",
  );
  ok(
    settled.every((f) => f.st.quality === "ok"),
    "正常噪声下 quality 保持 ok（箭头不会无故消失）",
  );
  const tail = settled.slice(-250).map((f) => f.sm);
  const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
  ok(Math.abs(shortestDeltaDeg(90, mean)) <= 1, "末 5s 均值贴住真值（≤1°）", `${mean.toFixed(2)}°`);
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 跟踪误差：恒定朝向 + 慢速转弯
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ② 跟踪误差（验收 ②：直线行走 ≤10°）═══\n");
{
  const rng = makeRng(11);
  const seq: Step[] = Array.from({ length: 3000 }, () => ({ deg: 45 + (rng() * 2 - 1) * 0.6 }));
  const frames = run(seq).slice(250);
  const errs = frames.map((f) => Math.abs(shortestDeltaDeg(45, f.sm)));
  ok(p95(errs) <= 3, "直线行走（6s 后）p95 误差 ≤3°", `${p95(errs).toFixed(2)}°`);
  ok(Math.max(...errs) <= 10, "直线行走最大误差 ≤10°（验收 ②）", `${Math.max(...errs).toFixed(2)}°`);
  ok(
    frames.every((f) => f.st.level === "none"),
    "行走晃动不判磁扰",
  );
}
{
  // 20°/s 匀速转 4s（80°）：测"跟手滞后"
  const frames = run(Array.from({ length: 200 }, (_, i) => ({ deg: 0.4 * i })));
  const lag = Math.max(...frames.map((f) => Math.abs(shortestDeltaDeg(f.raw, f.sm))));
  ok(lag <= 10, "20°/s 匀速转身的滞后 ≤10°", `${lag.toFixed(1)}°`);
  ok(
    frames.every((f) => f.st.level === "none"),
    "★ 匀速转身**不**触发磁扰（验收 ③ 的「不误报」；路径≈净位移 ⇒ 抖动≈0）",
  );
  ok(Math.max(...frames.map((f) => f.st.jitterDeg)) < 1, "匀速转身的抖动度≈0（判据的数学性质，不是调阈值调的）");
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 磁扰：确认时间 + 不闪回
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ③ 磁扰响应（验收 ③：3s 内出提示）═══\n");
{
  const rng = makeRng(23);
  const NORMAL = 60; // 1.2s 正常
  const seq: Step[] = [
    ...Array.from({ length: NORMAL }, () => ({ deg: (rng() * 2 - 1) * 0.4 })),
    ...Array.from({ length: 400 }, () => ({ deg: (rng() * 2 - 1) * 35 })), // ±35° 乱摆
  ];
  const frames = run(seq);
  const burstAt = NORMAL * DT;
  const firstStrong = frames.findIndex((f) => f.st.level === "strong");
  ok(firstStrong >= 0, "磁扰最终被判 strong");
  const delay = firstStrong >= 0 ? frames[firstStrong].t - burstAt : Infinity;
  ok(delay <= 3000, "★ 磁扰开始后 ≤3s 判出（验收 ③）", `实测 ${delay}ms`);
  ok(
    delay >= DISTURB_CONFIRM_MS - DT,
    `不是单帧就报（≥确认期 ${DISTURB_CONFIRM_MS}ms，避免一次碰撞就弹提示）`,
    `${delay}ms`,
  );
  ok(
    frames.slice(firstStrong + 30).every((f) => f.st.level !== "none"),
    "磁扰持续期间状态不闪回（不会一会儿画一会儿不画）",
  );
  ok(
    frames.slice(firstStrong + 10).every((f) => f.st.quality === "poor"),
    "strong ⇒ quality=poor（选源那层据此跳过罗盘）",
  );
  ok(!!frames[firstStrong].st.sinceTs, "sinceTs 有值（UI / QA 能知道这一轮从何时开始）");
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 恢复：磁扰结束后能自己回到正常
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ④ 恢复（磁扰结束 → 回到 none）═══\n");
{
  const rng = makeRng(31);
  const BURST = 150; // 3s 磁扰
  const seq: Step[] = [
    ...Array.from({ length: BURST }, () => ({ deg: (rng() * 2 - 1) * 35 })),
    ...Array.from({ length: 300 }, () => ({ deg: (rng() * 2 - 1) * 0.4 })),
  ];
  const frames = run(seq);
  const endAt = BURST * DT;
  const back = frames.find((f) => f.t > endAt && f.st.level === "none");
  ok(!!back, "磁扰结束后回到 none");
  const recoverMs = back ? back.t - endAt : Infinity;
  ok(
    recoverMs <= DISTURB_RECOVER_MS + 700, // 700 ≈ 24 帧窗口残留(480ms) + 余量
    `恢复用时 ≈ 恢复确认期 ${DISTURB_RECOVER_MS}ms（不是立刻，避免边缘闪烁）`,
    `${recoverMs}ms`,
  );
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ GPS 佐证（一致性融合）：只在"能不降级就不降级"的方向上用
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ⑤ GPS 佐证（融合）═══\n");
{
  // iOS 报精度 40（超限）但方向真的对：正在直线走，GPS 航向 90，平滑朝向 90
  const good = run(
    Array.from({ length: 100 }, () => ({
      deg: 90,
      accuracyDeg: 40,
      courseDeg: 90,
      speedMps: 2,
    })),
  );
  const last = good[good.length - 1];
  ok(last.st.level === "mild", "★ 精度超限但 GPS 佐证方向一致 ⇒ mild（保留箭头）", last.st.level);
  ok(last.st.quality === "ok", "mild ⇒ quality=ok（箭头还在）");
  ok(last.st.corroborated, "corroborated=true 可观测");

  // 同样精度超限，但朝向与行进方向差 180° ⇒ 方向说不通 ⇒ strong
  const bad = run(
    Array.from({ length: 100 }, () => ({
      deg: 90,
      accuracyDeg: 40,
      courseDeg: 270,
      speedMps: 2,
    })),
  );
  ok(bad[bad.length - 1].st.level === "strong", "朝向与行进方向相反 ⇒ strong（不赌运气）");
  ok(!bad[bad.length - 1].st.corroborated, "差 180° 不算佐证");

  // iOS 报 -1（罗盘没校准）：不允许靠 GPS 保住
  const invalid = run(
    Array.from({ length: 100 }, () => ({
      deg: 90,
      accuracyDeg: -1,
      courseDeg: 90,
      speedMps: 2,
    })),
  );
  ok(invalid[invalid.length - 1].st.level === "strong", "★ 精度 -1（未校准）⇒ 即使 GPS 一致也 strong，提示去校准");

  // 站着不动（速度不足）：没有行进方向可用，不许拿噪声当佐证
  const standing = run(
    Array.from({ length: 100 }, () => ({
      deg: 90,
      accuracyDeg: 40,
      courseDeg: 90,
      speedMps: 0.4,
    })),
  );
  ok(standing[standing.length - 1].st.level === "strong", "速度不足 ⇒ 不启用佐证");
  ok(
    !standing[standing.length - 1].st.corroborated,
    "静止时不佐证（`coords.heading` 在静止时是噪声）",
  );

  ok(CORROBORATE_MAX_DIFF_DEG === 25, `佐证容差 25°（实际 ${CORROBORATE_MAX_DIFF_DEG}）`);
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 提示文案与"每会话一次"
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ⑥ 校准提示（文案 + 每会话一次）═══\n");
{
  const BANNED = ["失败", "系统", "异常", "未知", "暂无", "N/A"];
  ok(NOTE_HEADING_CALIBRATE.includes("8"), "校准提示点到「8」字（可执行的动作，不是含糊的「信号不好」）");
  ok(
    !BANNED.some((w) => NOTE_HEADING_CALIBRATE.includes(w)),
    `校准提示不含甩锅词（${BANNED.join("/")}）`,
  );

  const base = { enabled: true, status: "poor" as const, needsGesture: false };
  const cal = noteOfHeading({ ...base, mode: "north", calibrate: true });
  ok(cal?.text === NOTE_HEADING_CALIBRATE, "磁扰确认 ⇒ 走校准文案");

  const courseCal = noteOfHeading({ ...base, mode: "course", calibrate: true });
  ok(courseCal?.text === NOTE_HEADING_CALIBRATE, "★ 校准提示优先于「跟行进方向」说明（校准才是用户能做的事）");

  const plainPoor = noteOfHeading({ ...base, mode: "north", calibrate: false });
  ok(plainPoor?.text === NOTE_HEADING_POOR, "额度用完后仍说「读数不稳」（不重复劝校准）");

  const courseOnly = noteOfHeading({ ...base, mode: "course", calibrate: false });
  ok(courseOnly?.text === NOTE_HEADING_COURSE, "非磁扰的 course 仍解释「往哪走」");

  const iosIdle = noteOfHeading({
    enabled: true,
    mode: "north",
    status: "idle",
    needsGesture: true,
    calibrate: true,
  });
  ok(iosIdle?.text === NOTE_HEADING_ENABLE, "iOS 还没授权时「点此开启」优先（没帧就不会有磁扰，顺序不影响）");

  const off = noteOfHeading({ enabled: false, mode: "north", status: "poor", needsGesture: false, calibrate: true });
  ok(off === null, "不在步行态 ⇒ 一句话都不出");

  ok(takeCalibrateTicket() === true, "★ 校准票据：本会话第一次发放");
  ok(takeCalibrateTicket() === false, "★ 校准票据：第二次不再发放（每会话一次）");
  ok(NOTE_HEADING_NORTH.length > 0 && NOTE_HEADING_ENABLE.length > 0, "其它三句文案都在（防误删）");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 接线（静态钉子）
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ⑦ 接线钉子 ═══\n");
{
  const hookCode = codeOnly(read("src/components/nav/useCompassHeading.ts"));
  ok(
    /detectorRef\.current\.push\(/.test(hookCode),
    "每帧喂给磁扰检测器",
  );
  ok(
    hookCode.indexOf("smootherRef.current.push") < hookCode.indexOf("detectorRef.current.push"),
    "★ 先平滑、再判磁扰（顺序反了，GPS 佐证就是拿噪声当证据）",
  );
  ok(
    !/headingQualityOf\s*\(/.test(hookCode),
    "★ hook 不再直接调 headingQualityOf（口径唯一，否则绕开持续性/佐证）",
  );
  ok(
    /st\.level !== levelRef\.current/.test(hookCode),
    "只在磁扰等级变化时提交（每帧 setState 会重渲染整棵导航树）",
  );
  ok(
    /fusionRef\.current/.test(hookCode),
    "融合输入走 ref（不进 effect 依赖，否则定位每更新一次就重挂传感器）",
  );

  const distCode = codeOnly(read("src/lib/compass/disturbance.ts"));
  ok(!/from "react"/.test(distCode), "检测器是纯逻辑（不引 React，可被门禁直接跑）");
  ok(
    !/COMPASS_ACC_MAX_DEG|> *25|> *35/.test(distCode),
    "★ 检测器不另立精度阈值（全部复用 headingQualityOf）",
  );
  ok(/headingQualityOf\(/.test(distCode), "判定基准取自 F1（同一口径）");
  ok(/headingJitterDeg\(/.test(distCode), "Android 方差判定复用 F1 的 headingJitterDeg");

  const userHeadingCode = codeOnly(read("src/components/nav/useUserHeading.ts"));
  ok(/fusion:\s*\{\s*courseDeg,\s*speedMps\s*\}/.test(userHeadingCode), "合成层把 GPS 航向/速度传给传感器通道");
  ok(/takeCalibrateTicket\(\)/.test(userHeadingCode), "校准票据在合成层领（UI 只读结果）");
  ok(/calibrateConsumedRef/.test(userHeadingCode), "挡住 StrictMode 双跑（否则本地永远看不到校准提示）");
  ok(/compass\.disturbance !== "strong"/.test(userHeadingCode), "只有 strong 才领票（mild 不该打扰）");

  const shellCode = codeOnly(read("src/components/nav/NavShell.tsx"));
  ok(/calibrate:\s*headingR\.calibrateHint/.test(shellCode), "宿主把校准提示传给文案层");
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}：pass=${pass} fail=${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
