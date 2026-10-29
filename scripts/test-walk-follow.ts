/**
 * scripts/test-walk-follow.ts —— ★ v3.6.0 S5 步行跟随纯函数对拍
 *
 * 为什么必须有：AC-04 的三条要求（**单调不减 + 1.5m 死区 + 精度劣化/偏航时冻结不回退**）
 *   全部属于「沉默逻辑错误」—— 写错了不抛异常、不报错，只让用户走错路。
 *   PM 已明确要「制造精度劣化和偏航，断言 `body[data-walk-step]` **不回退**」，
 *   故这里用合成轨迹逐条把边界钉死。
 *
 * 跑法（铁律 17：npx 本机可能静默失效 ⇒ 直喂 tsx CLI 实体）：
 *   node node_modules/tsx/dist/cli.mjs scripts/test-walk-follow.ts
 */
import {
  arrived,
  projectOnPath,
  progressOnPath,
  stepIdxAt,
  WALK_ACC_MAX_M,
  WALK_ARRIVE_M,
  WALK_DEADBAND_M,
  type WalkFix,
  type WalkProgress,
} from "@/lib/walk/follow";
import { stepGeomM, type WalkStep } from "@/lib/walk/walk-shared";

let pass = 0;
let fail = 0;
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

/* ── 几何夹具：一条正东向直线，1 米 ≈ 1/103140 度经度 ── */
const BASE_LNG = 113.55;
const BASE_LAT = 22.15;
const DEG_PER_M = 1 / 103_140;
const at = (m: number): [number, number] => [BASE_LNG + m * DEG_PER_M, BASE_LAT];

/**
 * 造一段步：从 `startM` 起、长 `lenM`、每 10m 一个顶点。
 * `cumStartM` / `cumM` 与 `polyline` 严格对应（= 服务端会下发的形态）。
 */
function makeStep(idx: number, cumStartM: number, lenM: number, text = `第 ${idx} 步`): WalkStep {
  const polyline: [number, number][] = [];
  const cumM: number[] = [];
  const n = Math.max(2, Math.round(lenM / 10) + 1);
  for (let i = 0; i < n; i++) {
    const d = (lenM * i) / (n - 1);
    polyline.push(at(cumStartM + d));
    cumM.push(cumStartM + d);
  }
  return { idx, turn: "straight", text, distM: Math.round(lenM), cumStartM, polyline, cumM };
}

/** 三段：0-100 米 / 100-300 米 / 300-400 米（总 400 米） */
const STEPS: WalkStep[] = [makeStep(0, 0, 100), makeStep(1, 100, 200), makeStep(2, 300, 100)];
const TOTAL = 400;

console.log("═══ v3.6.0 S5 步行跟随对拍（AC-04）═══\n");

/* ══════════ ① 投影基础 ══════════ */
console.log("[① 折线投影]");
{
  const p = projectOnPath(STEPS[0].polyline, { lng: at(40)[0], lat: at(40)[1], accuracy: 5 });
  ok(!!p, "在线上的点可投影");
  ok(p !== null && p.distM < 1, "线上点离线距离 ≈ 0", p ? p.distM.toFixed(3) : "-");

  // 北偏 100m
  const offLat = BASE_LAT + 100 / 111_320;
  const p2 = projectOnPath(STEPS[0].polyline, { lng: at(40)[0], lat: offLat, accuracy: 5 });
  ok(p2 !== null && Math.abs(p2.distM - 100) < 2, "离线 100m ⇒ distM ≈ 100", p2 ? p2.distM.toFixed(1) : "-");

  eq(projectOnPath([], { lng: 0, lat: 0 }), null, "空折线 ⇒ null");
}

/* ══════════ ② 二分查步（边界归后一步） ══════════ */
console.log("\n[② stepIdxAt]");
{
  eq(stepIdxAt(0, STEPS), 0, "0m ⇒ 第 0 步");
  eq(stepIdxAt(50, STEPS), 0, "50m ⇒ 第 0 步");
  eq(stepIdxAt(100, STEPS), 1, "100m（步界）⇒ **第 1 步**（边界归后一步）");
  eq(stepIdxAt(299, STEPS), 1, "299m ⇒ 第 1 步");
  eq(stepIdxAt(300, STEPS), 2, "300m ⇒ 第 2 步");
  eq(stepIdxAt(999, STEPS), 2, "超出末步 ⇒ 停在末步（不越界）");
  eq(stepIdxAt(0, []), 0, "空 steps ⇒ 0（不崩）");
}

/* ══════════ ③ 正常前进 + 步内比例 ══════════ */
console.log("\n[③ 正常前进]");
{
  const f = (m: number, acc = 5): WalkFix => ({ lng: at(m)[0], lat: at(m)[1], accuracy: acc });

  const p1 = progressOnPath(STEPS, TOTAL, f(40), null);
  eq(p1.currentIdx, 0, "走到 40m ⇒ 第 0 步");
  ok(Math.abs(p1.doneInStepM - 40) < 2, "doneInStepM ≈ 40", p1.doneInStepM.toFixed(1));
  ok(Math.abs(p1.ratio - 0.4) < 0.03, "ratio ≈ 0.4（米级，地图用）", p1.ratio.toFixed(3));
  ok(Math.abs(p1.remainM - 360) < 2, "remainM ≈ 360（stepsTotalM − 已完成）", p1.remainM.toFixed(1));

  const p2 = progressOnPath(STEPS, TOTAL, f(150), p1);
  eq(p2.currentIdx, 1, "走到 150m ⇒ 推进到第 1 步");
  ok(Math.abs(p2.doneInStepM - 50) < 2, "第 1 步内已完成 ≈ 50", p2.doneInStepM.toFixed(1));
  ok(Math.abs(p2.remainM - 250) < 2, "remainM ≈ 250", p2.remainM.toFixed(1));
}

/* ══════════ ④ 单调不减（AC-04 核心） ══════════ */
console.log("\n[④ 单调不减 + 死区]");
{
  const f = (m: number, acc = 5): WalkFix => ({ lng: at(m)[0], lat: at(m)[1], accuracy: acc });
  const p200 = progressOnPath(STEPS, TOTAL, f(200), null);

  // 回退 50m（GPS 漂移/用户回头）：不得让进度倒退
  const back = progressOnPath(STEPS, TOTAL, f(150), p200);
  eq(back.currentIdx, p200.currentIdx, "回退到 150m ⇒ 步号**不回退**");
  ok(
    back.doneInStepM >= p200.doneInStepM - 0.001,
    "回退到 150m ⇒ 步内已完成**不减**",
    `${back.doneInStepM.toFixed(1)} >= ${p200.doneInStepM.toFixed(1)}`,
  );
  ok(back.remainM <= p200.remainM + 0.001, "回退 ⇒ 剩余米**不增**", `${back.remainM.toFixed(1)} <= ${p200.remainM.toFixed(1)}`);

  // 死区：只前进 1m（< 1.5m）⇒ 不动
  const tiny = progressOnPath(STEPS, TOTAL, f(201), p200);
  eq(tiny.doneInStepM, p200.doneInStepM, `只前进 1m（< ${WALK_DEADBAND_M}m 死区）⇒ 进度不动`);

  // 超过死区 ⇒ 动
  const real = progressOnPath(STEPS, TOTAL, f(204), p200);
  ok(real.doneInStepM > p200.doneInStepM, "前进 4m（> 死区）⇒ 进度推进", real.doneInStepM.toFixed(1));
}

/* ══════════ ⑤ 精度劣化 / 偏航 ⇒ 冻结不回退（PM 明确要求） ══════════ */
console.log("\n[⑤ 精度劣化 / 偏航 ⇒ 冻结]");
{
  const f = (m: number, acc = 5): WalkFix => ({ lng: at(m)[0], lat: at(m)[1], accuracy: acc });
  const base = progressOnPath(STEPS, TOTAL, f(120), null); // 第 1 步，走了 20m

  // 精度爆掉（> 门限）
  const bad = progressOnPath(STEPS, TOTAL, f(60, WALK_ACC_MAX_M + 50), base);
  eq(bad.currentIdx, base.currentIdx, `accuracy > ${WALK_ACC_MAX_M}m ⇒ 步号不变`);
  eq(bad.doneInStepM, base.doneInStepM, "accuracy 超门限 ⇒ 步内已完成不变（不前进也不回退）");
  eq(bad.lowAccuracy, true, "标记 lowAccuracy=true（供 UI 切 manual 态）");

  // 精度刚好在门限内 ⇒ 正常
  const edge = progressOnPath(STEPS, TOTAL, f(140, WALK_ACC_MAX_M), base);
  eq(edge.lowAccuracy, false, `accuracy = ${WALK_ACC_MAX_M}m（恰好等于门限）⇒ 仍可信`);

  // 偏航：离线 80m（> 50m 阈值）—— 进度**不回退**，但 offRouteM 报出来
  const offLat = BASE_LAT + 80 / 111_320;
  const off = progressOnPath(STEPS, TOTAL, { lng: at(120)[0], lat: offLat, accuracy: 8 }, base);
  ok(off.offRouteM !== null && off.offRouteM > 50, "偏航 80m ⇒ offRouteM > 50（供 UI 切 off 态）", String(off.offRouteM?.toFixed(1)));
  ok(off.doneInStepM >= base.doneInStepM, "偏航时步内已完成**不回退**", off.doneInStepM.toFixed(1));
}

/* ══════════ ⑥ 无定位 / 空 steps ══════════ */
console.log("\n[⑥ 降级]");
{
  const base = progressOnPath(STEPS, TOTAL, { lng: at(50)[0], lat: at(50)[1], accuracy: 5 }, null);
  const noFix = progressOnPath(STEPS, TOTAL, null, base);
  eq(noFix.currentIdx, base.currentIdx, "无定位 ⇒ 沿用上次步号");
  eq(noFix.doneInStepM, base.doneInStepM, "无定位 ⇒ 沿用上次进度");

  const empty = progressOnPath([], TOTAL, { lng: 0, lat: 0, accuracy: 5 }, null);
  eq(empty.currentIdx, 0, "空 steps ⇒ 不崩（步号 0）");
  eq(empty.remainM, TOTAL, "空 steps ⇒ 剩余 = 总长");
}

/* ══════════ ⑦ 步界跨越不跳级 ══════════ */
console.log("\n[⑦ 跨步界]");
{
  const f = (m: number): WalkFix => ({ lng: at(m)[0], lat: at(m)[1], accuracy: 5 });
  const p = progressOnPath(STEPS, TOTAL, f(99), null);
  const q = progressOnPath(STEPS, TOTAL, f(305), p); // 一步跨过 100 与 300
  ok(q.currentIdx <= 2, "跨步界后步号不越界", String(q.currentIdx));
  ok(q.currentIdx >= p.currentIdx, "步号单调不减");
  ok(q.remainM <= p.remainM, "剩余米单调不增");
}

/* ══════════ ⑧ 到达判定 ══════════ */
console.log("\n[⑧ 到达]");
{
  eq(arrived(0), true, "剩余 0m ⇒ 到达");
  eq(arrived(WALK_ARRIVE_M), true, `剩余 ${WALK_ARRIVE_M}m（阈值上界）⇒ 到达`);
  eq(arrived(WALK_ARRIVE_M + 1), false, `剩余 ${WALK_ARRIVE_M + 1}m ⇒ 未到达`);
  eq(arrived(500), false, "剩余 500m ⇒ 未到达");
}

/* ══════════ ⑨ 步几何长度用 cumM（不是 distM） ══════════ */
console.log("\n[⑨ stepGeomM 口径]");
{
  const s: WalkStep = { ...makeStep(0, 0, 100), distM: 999 }; // distM 故意标错
  ok(Math.abs(stepGeomM(s) - 100) < 1, "stepGeomM 用 cumM 末−首，不受 distM 影响", stepGeomM(s).toFixed(1));

  // ratio 分母必须是几何长度：把 distM 弄成 2 倍，ratio 不应被带偏
  const p: WalkProgress = progressOnPath([s], 100, { lng: at(50)[0], lat: at(50)[1], accuracy: 5 }, null);
  ok(Math.abs(p.ratio - 0.5) < 0.03, "ratio 分母 = 几何长度（distM 标错也不影响）", p.ratio.toFixed(3));
}

const total = pass + fail;
console.log(`\n结果：${fail === 0 ? "PASS" : "FAIL"} · ${pass}/${total} 通过${fail ? ` · ${fail} 失败` : ""}`);
process.exit(fail === 0 ? 0 : 1);
