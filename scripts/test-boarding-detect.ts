/**
 * scripts/test-boarding-detect.ts —— ★ v3.6.0 S3 上车判定纯函数对拍
 *
 * 为什么必须有这份：上车判定是「沉默逻辑错误」最高危的地方 ——
 *   · 误判 = 用户还没上车就被切进"乘车中"，进度/到站提醒全错；
 *   · 漏判 = 用户已经在车上却一直显示"等待上车"。
 * 这两种都不会抛异常、不会报错，只能靠纯函数对拍把边界钉死
 * （见 references/01-standards/generated-code-failure-modes.md §2）。
 *
 * 断言口径 = 架构 §3.1 判定模型（定位主导 + 车辆只降门槛）。
 *
 * 跑法（铁律 17：npx 本机可能静默失效 ⇒ 直喂 tsx CLI 实体）：
 *   node node_modules/tsx/dist/cli.mjs scripts/test-boarding-detect.ts
 */
import {
  ANOMALY_CONFIRM,
  ANOMALY_MIN_GAP_MS,
  BOARDING_START_GRACE_MS,
  R1_ACCEL_DISPLACE_FACTOR,
  R2_DISPLACE_MIN_M,
  R2_FIX_MAX_ACC_M,
  R2_SPEED_MAX_KMH,
  R2_STREAK_ALONE,
  R2_STREAK_WITH_VEHICLE,
  R2_TOL_M,
  SWITCH_COOLDOWN_MS,
  autoBoardOf,
  auxOf,
  detectPausedOf,
  GPS_PAUSE_MS,
  type AutoBoardInput,
  type FixLite,
} from "@/lib/nav/boarding-detect";
import type { TrackVehicle } from "@/lib/nav/track";
import type { LL } from "@/lib/nav/route-overview";

/* ── 断言器（禁硬编码聚合；逐条打点）──────────────────────────────── */
let fail = 0;
let pass = 0;
function ok(cond: boolean, name: string, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}
function eq<T>(actual: T, expected: T, name: string): void {
  ok(Object.is(actual, expected), name, `实际=${String(actual)} 期望=${String(expected)}`);
}

/* ── 几何夹具：一条正东向直线（GCJ-02），覆盖 -400m ~ +1600m ─────────
   1 度经度 ≈ 111320·cos(22.15°) ≈ 103,140 m。
   ★ 顶点必须**密**（2m 一个）：`r2Of` 的沿线位移用「最近顶点里程差」量化，
     量化误差 ≈ ±STEP_M；顶点越稀，位移门的边界越不可靠
     （10m 顶点时「12 km/h × 20s = 66.7m」会被量成 40m ⇒ 假失败）。
     生产环境的 `route_shapes` 顶点是密集的，夹具必须同构，否则测试是测夹具不是测逻辑。
   ★ 路径向**西**多留 400m：`fixesOf` 的早帧落在起点以西，否则投影距离超 tol 假失败。 */
const BASE_LNG = 113.55;
const BASE_LAT = 22.15;
const STEP_M = 2;
const DEG_PER_M_LNG = 1 / 103_140;
const PATH: LL[] = Array.from({ length: 1001 }, (_, i) => {
  const m = -400 + i * STEP_M; // -400m … +1600m
  return [BASE_LNG + m * DEG_PER_M_LNG, BASE_LAT] as LL;
});
/** 沿线相对 BASE_LNG 的第 `meters` 米处 */
const atM = (meters: number): { lng: number; lat: number } => ({
  lng: BASE_LNG + meters * DEG_PER_M_LNG,
  lat: BASE_LAT,
});

/** 构造 n 个采样点：**最后一帧**落在 `startM` 与 `endTs`，往前按 speedKmh / gapMs 回推 */
function fixesOf(startM: number, speedKmh: number, n: number, gapMs: number, endTs = 100_000): FixLite[] {
  const mps = speedKmh / 3.6;
  const out: FixLite[] = [];
  for (let i = 0; i < n; i++) {
    const dtMs = (i - (n - 1)) * gapMs; // 末帧 = 0
    const p = atM(startM + mps * (dtMs / 1000));
    out.push({ lng: p.lng, lat: p.lat, accuracy: 10, ts: endTs + dtMs });
  }
  return out;
}

/** 基准输入：几何可用、无车、冷却已过、未触发过 */
function inputOf(patch: Partial<AutoBoardInput> = {}): AutoBoardInput {
  return {
    legKind: "bus",
    legDegraded: false,
    colored: PATH,
    boardMain: "T100",
    boardPos: { ...atM(0) },
    vehicles: [],
    fixes: [],
    lastSwitchTs: 0,
    nowMs: 1_000_000,
    autoUsed: false,
    streak: 0,
    ...patch,
  };
}

/** 车：刚从本站开走（A1 = strong） */
const vJustLeft: TrackVehicle = {
  plate: "MA0001",
  lat: atM(120).lat,
  lng: atM(120).lng,
  status: "moving",
  interval: { from: { code: "T100" }, to: { code: "T101" } },
  atStation: { code: "T100" },
};
/** 车：正停靠本站（A2 = weak） */
const vStopping: TrackVehicle = {
  plate: "MA0002",
  lat: atM(0).lat,
  lng: atM(0).lng,
  status: "stopping",
  interval: null,
  atStation: { code: "T100" },
};
/** 车：与本上车站无关 */
const vElsewhere: TrackVehicle = {
  plate: "MA0003",
  lat: atM(800).lat,
  lng: atM(800).lng,
  status: "moving",
  interval: { from: { code: "T900" }, to: { code: "T901" } },
  atStation: null,
};

console.log("═══ v3.6.0 S3 上车判定对拍（定位主导）═══\n");

/* ══════════ ① 核心口径：车辆**单独**绝不可触发 ══════════ */
console.log("[① 车辆不得单独触发]");
{
  const noFix = autoBoardOf(inputOf({ vehicles: [vJustLeft] }));
  eq(noFix.hit, false, "A1 车刚离站 + 无任何定位 ⇒ 不判");
  eq(noFix.streak, 0, "A1 无定位 ⇒ streak 保持 0");

  const stillFixes = fixesOf(0, 0, 4, 5_000); // 站着不动
  const still = autoBoardOf(inputOf({ vehicles: [vJustLeft], fixes: stillFixes }));
  eq(still.hit, false, "A1 车刚离站 + 用户静止 ⇒ 不判（旧版会误判）");

  const twoFrames = fixesOf(0, 20, 2, 10_000);
  const few = autoBoardOf(inputOf({ vehicles: [vJustLeft], fixes: twoFrames }));
  eq(few.hit, false, "可信帧 <3 ⇒ 不判（即便有车佐证）");
}

/* ══════════ ② 定位主导：纯定位可命中，且需要 3 连帧 ══════════ */
console.log("\n[② 纯定位主导]");
{
  const fixes = fixesOf(0, 20, 3, 10_000); // 20s 走 111m，3 帧
  const r1 = autoBoardOf(inputOf({ fixes, streak: 0 }));
  eq(r1.hit, true, "沿线移动 20km/h × 20s ⇒ 命中");
  eq(r1.need, R2_STREAK_ALONE, "无车佐证 ⇒ need=3");
  eq(r1.streak, 1, "第 1 帧 streak=1");
  eq(r1.plate, null, "无车佐证 ⇒ 不锁车牌");
  eq(r1.source, "gps", "来源 = gps");
  eq(r1.reason, "gps", "reason = gps");

  const r3 = autoBoardOf(inputOf({ fixes, streak: 2 }));
  eq(r3.streak, 3, "第 3 连续帧 streak=3");
  ok(r3.hit && r3.streak >= r3.need, "第 3 帧满足 hit && streak>=need ⇒ 调用方切换");
}

/* ══════════ ③ 车辆辅助：只降门槛（need 2 + 位移 ×0.6） ══════════ */
console.log("\n[③ 车辆辅助降门槛]");
{
  const fixes = fixesOf(0, 20, 3, 10_000);
  const withCar = autoBoardOf(inputOf({ fixes, vehicles: [vJustLeft] }));
  eq(withCar.need, R2_STREAK_WITH_VEHICLE, "A1 佐证 ⇒ need=2");
  eq(withCar.plate, "MA0001", "A1 唯一 ⇒ 锁定该车牌");
  eq(withCar.source, "vehicle", "A1 ⇒ 来源 vehicle");
  eq(withCar.reason, "gps+vehicle", "reason = gps+vehicle");

  const withWeak = autoBoardOf(inputOf({ fixes, vehicles: [vStopping] }));
  eq(withWeak.need, R2_STREAK_WITH_VEHICLE, "A2 停靠佐证 ⇒ need=2");
  eq(withWeak.plate, null, "A2 **不锁车牌**（站里可能多辆）");
  eq(withWeak.source, "gps", "A2 ⇒ 来源仍 gps");

  const unrelated = autoBoardOf(inputOf({ fixes, vehicles: [vElsewhere] }));
  eq(unrelated.need, R2_STREAK_ALONE, "无关车 ⇒ need 仍 3");
  eq(unrelated.plate, null, "无关车 ⇒ 不锁车牌");

  /**
   * 位移门被降到 0.6 倍的**独立**证明：必须挑一个「速度过门、位移只过缩放后的门」的用例，
   * 否则速度门会先把用例拦掉、证明不了缩放是否生效。
   *   9 km/h × 20s ⇒ 位移 50m；gate(assisted) = max(60, 8/3.6×20)=60 → ×0.6 = 36m ⇒ 50≥36 命中
   *                     gate(alone)    = 60m ⇒ 50<60 不命中
   *   （速度 9 > 8，两条用例速度门都过，差异只可能来自位移门缩放。）
   */
  const midFixes = fixesOf(0, 9, 3, 10_000); // 20s × 2.5m/s = 50m
  const assisted = autoBoardOf(inputOf({ fixes: midFixes, vehicles: [vJustLeft] }));
  const alone = autoBoardOf(inputOf({ fixes: midFixes, vehicles: [] }));
  eq(assisted.hit, true, `位移 50m 有佐证 ⇒ 命中（门槛 ${R2_DISPLACE_MIN_M}×${R1_ACCEL_DISPLACE_FACTOR}=36m）`);
  eq(alone.hit, false, `位移 50m 无佐证 ⇒ 不命中（门槛 ${R2_DISPLACE_MIN_M}m）`);
}

/* ══════════ ④ 速度门：静止漂移 / 过快 都不判 ══════════ */
console.log("\n[④ 速度门]");
{
  const stand = autoBoardOf(inputOf({ fixes: fixesOf(0, 0, 4, 10_000) }));
  eq(stand.hit, false, "静止（0km/h）⇒ 不判");

  const slow = autoBoardOf(inputOf({ fixes: fixesOf(0, 3, 4, 12_000) })); // 3km/h 步行
  eq(slow.hit, false, "步行 3km/h ⇒ 不判（低于 5.5 下限）");

  const fast = autoBoardOf(inputOf({ fixes: fixesOf(0, R2_SPEED_MAX_KMH + 20, 4, 10_000) }));
  eq(fast.hit, false, `>${R2_SPEED_MAX_KMH}km/h ⇒ 不判（视为投影漂移）`);

  /**
   * ⚠️ v3.6.0 起 7 km/h **不再算"随车"**（8 km/h 是步行/车速分界，见 ⑫ 组）——
   *   这里改为「真实车速 12 km/h 必须命中」，与本轮 blocking 改动保持一致。
   */
  const busSlow = autoBoardOf(inputOf({ fixes: fixesOf(0, 12, 4, 12_000) }));
  eq(busSlow.hit, true, "12km/h（真实慢速乘车） ⇒ 命中（改阈值后不得漏判）");
}

/* ══════════ ⑤ 邻线门：投影过远不判 ══════════ */
console.log("\n[⑤ 邻线投影门]");
{
  // 整条轨迹搬到北侧 400m 外（远超 tol=80m）
  const offsetLat = BASE_LAT + 400 / 111_320;
  const offPath = PATH.map(([lng, lat]) => [lng, lat + (offsetLat - BASE_LAT)] as LL);
  const fixes = fixesOf(0, 20, 3, 10_000).map((f) => ({ ...f, lat: f.lat + (offsetLat - BASE_LAT) }));
  const r = autoBoardOf(inputOf({ colored: offPath, fixes }));
  // 轨迹与采样同时平移 ⇒ 投影距离仍为 0（这是同源平移），应当命中 —— 反向验证门没写死
  eq(r.hit, true, "轨迹与采样同源平移 ⇒ 仍命中（门是相对投影，不是绝对坐标）");

  const r2 = autoBoardOf(
    inputOf({ fixes: fixesOf(0, 20, 3, 10_000).map((f) => ({ ...f, lat: f.lat + 400 / 111_320 })) }),
  );
  eq(r2.hit, false, `采样离线 ${R2_TOL_M}m 以上 ⇒ 不判`);
}

/* ══════════ ⑥ 硬门：几何 / 冷却 / 单次会话 ══════════ */
console.log("\n[⑥ 硬门]");
{
  const fixes = fixesOf(0, 20, 4, 10_000);

  eq(autoBoardOf(inputOf({ fixes, colored: [] })).hit, false, "几何缺失（colored 空）⇒ 不判");
  eq(autoBoardOf(inputOf({ fixes, colored: [PATH[0]] })).hit, false, "几何仅 1 点 ⇒ 不判");
  eq(autoBoardOf(inputOf({ fixes, legDegraded: true })).hit, false, "legDegraded ⇒ 不判（旧版巴士会退化成 R1-only）");

  eq(autoBoardOf(inputOf({ fixes, autoUsed: true })).hit, false, "本腿已自动触发过 ⇒ 不判");

  const cooling = autoBoardOf(
    inputOf({ fixes, lastSwitchTs: 1_000_000 - (SWITCH_COOLDOWN_MS - 1), nowMs: 1_000_000 }),
  );
  eq(cooling.hit, false, "冷却未过 ⇒ 不判");

  const cooled = autoBoardOf(
    inputOf({ fixes, lastSwitchTs: 1_000_000 - SWITCH_COOLDOWN_MS, nowMs: 1_000_000 }),
  );
  eq(cooled.hit, true, "冷却刚到 ⇒ 可判");
}

/* ══════════ ⑦ 轻轨：收紧档、无车牌 ══════════ */
console.log("\n[⑦ 轻轨]");
{
  const fast = fixesOf(0, 40, 4, 10_000);
  const hit = autoBoardOf(inputOf({ legKind: "lrt", fixes: fast, vehicles: [vJustLeft] }));
  eq(hit.hit, true, "轻轨 40km/h 沿线移动 ⇒ 命中");
  eq(hit.plate, null, "轻轨无逐车数据 ⇒ 不锁车牌");
  eq(hit.source, "gps", "轻轨来源 = gps");
  eq(hit.need, R2_STREAK_ALONE, "轻轨恒需 3 连帧");

  const lightspeed = fixesOf(0, 10, 4, 10_000); // 10 < 12 轻轨下限
  eq(autoBoardOf(inputOf({ legKind: "lrt", fixes: lightspeed })).hit, false, "轻轨 10km/h ⇒ 不判（下限 12）");

  eq(
    autoBoardOf(inputOf({ legKind: "lrt", fixes: fast, legDegraded: true })).hit,
    false,
    "轻轨几何缺失 ⇒ 不判",
  );
}

/* ══════════ ⑧ 精度门 ══════════ */
console.log("\n[⑧ 精度门]");
{
  const fixes = fixesOf(0, 20, 3, 10_000).map((f) => ({ ...f, accuracy: R2_FIX_MAX_ACC_M + 10 }));
  eq(autoBoardOf(inputOf({ fixes })).hit, false, `所有帧 accuracy > ${R2_FIX_MAX_ACC_M}m ⇒ 全部丢弃，不判`);

  const mixed = fixesOf(0, 20, 5, 10_000).map((f, i) => ({ ...f, accuracy: i < 2 ? 500 : 10 }));
  eq(autoBoardOf(inputOf({ fixes: mixed })).hit, true, "仅末 3 帧可信 ⇒ 仍可判（不因历史噪点卡死）");
}

/* ══════════ ⑨ auxOf 语义 ══════════ */
console.log("\n[⑨ auxOf]");
{
  const a1 = auxOf([vJustLeft], "T100");
  ok(a1.strong && !a1.weak && a1.plate === "MA0001", "A1 ⇒ strong + 车牌");

  const a2 = auxOf([vStopping], "T100");
  ok(!a2.strong && a2.weak && a2.plate === "MA0002", "A2 ⇒ weak + 车牌");

  const none = auxOf([vElsewhere], "T100");
  ok(!none.strong && !none.weak && none.plate === null, "无关车 ⇒ 无信号");

  // 主码归一：T100/2 应等于 T100
  const plat = auxOf([vStopping], "T100/2");
  ok(plat.weak, "站台后缀归一（T100/2 → T100）");
}

/* ══════════ ⑩ detectPausedOf（AC-25a） ══════════ */
console.log("\n[⑩ 判定是否已暂停]");
{
  const now = 200_000;
  eq(detectPausedOf([], now), true, "一帧都没有 ⇒ paused");

  const fresh = fixesOf(0, 20, 3, 5_000, now);
  eq(detectPausedOf(fresh, now), false, "刚有可信帧 ⇒ on");

  const stale = fixesOf(0, 20, 3, 5_000, now - GPS_PAUSE_MS - 1);
  eq(detectPausedOf(stale, now), true, `超过 ${GPS_PAUSE_MS}ms 无新帧 ⇒ paused`);

  const bad = fixesOf(0, 20, 2, 500, now).map((f) => ({ ...f, accuracy: R2_FIX_MAX_ACC_M + 1 }));
  eq(detectPausedOf(bad, now), true, "连续 2 帧低精度 ⇒ paused");

  const oneBad = fixesOf(0, 20, 2, 500, now);
  oneBad[0] = { ...oneBad[0], accuracy: 999 };
  eq(detectPausedOf(oneBad, now), false, "仅 1 帧低精度 ⇒ 仍 on（不因偶发噪点停机）");

  /**
   * ★ 启动宽限（advisory）：刚进候车态、一帧都没有时**不得**立刻报 paused ——
   *   否则界面会先闪「定位不可用 · 判定已暂停」再转正常（首帧 1~3s 才到）。
   */
  eq(detectPausedOf([], now, now - 1_000), false, "启动 1s（宽限内）且无帧 ⇒ 不判 paused（防首帧闪烁）");
  eq(
    detectPausedOf([], now, now - BOARDING_START_GRACE_MS - 1),
    true,
    `启动超过 ${BOARDING_START_GRACE_MS}ms 且无帧 ⇒ paused（宽限不掩盖真故障）`,
  );
  eq(detectPausedOf([], now, null), true, "未提供启动时刻（null）⇒ 维持原语义 paused");
}

/* ══════════ ⑪ streak 单调性与归零 ══════════ */
console.log("\n[⑪ streak]");
{
  const good = fixesOf(0, 20, 3, 10_000);
  let s = 0;
  const seq: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = autoBoardOf(inputOf({ fixes: good, streak: s }));
    s = r.streak;
    seq.push(s);
  }
  eq(seq.join(","), "1,2,3", "连续命中 ⇒ streak 1→2→3");

  const dropped = autoBoardOf(inputOf({ fixes: fixesOf(0, 0, 3, 10_000), streak: 2 }));
  eq(dropped.streak, 0, "一帧不命中 ⇒ streak 立即归零（不保留半程）");
}

/* ══════════ ⑫ 步行不得判上车（v3.6.0 blocking：速度下限 8 km/h） ══════════ */
/**
 * 这组是本次 blocking 改动的**回归防线**：`R2_SPEED_MIN_KMH_FLEX` 若是 5.5，
 * 位移门 `max(60, 5.5/3.6×45) = 68.75m` 与「5.5 km/h × 45s」是同一约束的两种写法，
 * 速度门成了唯一实际生效的门 ⇒ 6~7 km/h 的**快走**会被判成「已上车」。
 *
 * 夹具：10m 稠密顶点外的 2m 稠密顶点 + accuracy=10m + **45s 满窗**（4 帧 × 15s）。
 * 逐条断言、不聚合（铁律 24：断言基于契约取值域，不靠汇总掩盖）。
 */
console.log("\n[⑫ 步行不得判上车 · 45s 满窗]");
{
  /** 45s 满窗：4 帧、间隔 15s */
  const WALK_FIXES = (kmh: number) => fixesOf(0, kmh, 4, 15_000);

  /** 三种车辆场景：无车 / A1（车刚离站）/ A2（车正停靠） */
  const SCENARIOS: { label: string; vehicles: TrackVehicle[] }[] = [
    { label: "无车", vehicles: [] },
    { label: "A1 有车", vehicles: [vJustLeft] },
    { label: "A2 弱车", vehicles: [vStopping] },
  ];

  for (const kmh of [5.0, 5.5, 6.0, 7.0, 8.0]) {
    for (const sc of SCENARIOS) {
      const r = autoBoardOf(inputOf({ fixes: WALK_FIXES(kmh), vehicles: sc.vehicles }));
      eq(r.hit, false, `步行 ${kmh.toFixed(1)}km/h · ${sc.label} ⇒ 不得判上车`);
    }
  }

  /**
   * 防矫枉过正：真实乘车（12 km/h）不能因为抬高下限而漏判 / 延迟。
   * 20s 窗（3 帧 × 10s）：位移 66.7m ≥ 位移门 max(60, 8/3.6×20=44.4)=60m，速度 12 > 8。
   */
  const realRide = autoBoardOf(inputOf({ fixes: fixesOf(0, 12, 3, 10_000) }));
  eq(realRide.hit, true, "真实乘车 12km/h · 20s 窗 ⇒ 必须命中（防矫枉过正）");
}

/* ══════════ ⑬ 安全网参数契约 ══════════ */
console.log("\n[⑬ 安全网参数契约]");
{
  /**
   * 这两条以前只是 `console.log` 的"提示"，看着测了其实没断言。
   * 改成真断言：确认参数在契约区间内（连续确认 ≥2 次才判异常；两次确认间隔不得过短）。
   */
  ok(ANOMALY_CONFIRM >= 2, "ANOMALY_CONFIRM ≥ 2（单次抖动不得判异常）", `实际=${ANOMALY_CONFIRM}`);
  ok(ANOMALY_MIN_GAP_MS >= 20_000, "ANOMALY_MIN_GAP_MS ≥ 20s（确认间隔不得过短）", `实际=${ANOMALY_MIN_GAP_MS}`);
}

/* ══════════ 汇总 ══════════ */
const total = pass + fail;
console.log(`\n结果：${fail === 0 ? "PASS" : "FAIL"} · ${pass}/${total} 通过${fail ? ` · ${fail} 失败` : ""}`);
process.exit(fail === 0 ? 0 : 1);
