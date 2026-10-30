/**
 * 换乘风险字段断言（scripts/test-transfer-risk.ts，需求 7 · v3.6.1 新增）
 *
 * 锁住四组契约（**纯函数、不连库、不需要网络**）：
 *   ① `transfer-slack.ts` 的保守余量三档 + 架构师冻结的 4 个基准 case（含 risk 值）
 *   ② **反向断言**：同场换乘（`SAME_FIELD_TRANSFER_MIN = 0`）必须仍是 `yes`
 *   ③ `totalMin` 口径不变量：`conservativeWaitMin` 一字未改，`slack` 不进 `waitMin`
 *   ④ `track.ts` 的候车锚/过站过滤（`anchorOf` / `passedBoardOf` / `rankBoardingVehicles`）
 *
 * ⚠️ 本脚本**不验 `no`**：`no` 在代码上不可达（轻轨 `gapMin`、巴士 `slackMin` 均 ≥ 0），
 *    验一个永远进不去的分支属于「假绿」。改为直接验 H8 的**映射表**（null/undefined/0/≥3）。
 *
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/test-transfer-risk.ts
 */
import { SAME_FIELD_TRANSFER_MIN, type RecommendCard } from "@/lib/recommend/types";
import { SLACK_NO_DATA, conservativeWaitMin, type HeadwayHit } from "@/lib/recommend/headway";
import {
  BUS_SLACK_SPREAD_WEIGHT,
  SLACK_SPAN_EDGE_ENABLED,
  busSlackPartsOf,
  busTransferSlackMin,
} from "@/lib/recommend/transfer-slack";
import { PREF_ALPHA, PREF_RISK_FACTOR, TRANSFER_SAFETY_MIN, costOf } from "@/lib/recommend/score";
import {
  PASS_ANCHOR_NEAR_M,
  PASS_MARGIN_M,
  anchorOf,
  passedBoardOf,
  rankBoardingVehicles,
  type TrackVehicle,
} from "@/lib/nav/track";

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
const eq = <T,>(actual: T, expected: T, name: string) =>
  ok(Object.is(actual, expected), name, `实际=${String(actual)} 期望=${String(expected)}`);
const near = (a: number, b: number, name: string, eps = 1e-6) =>
  ok(Math.abs(a - b) <= eps, name, `实际=${a} 期望=${b}`);

/** 造一个 HeadwayHit（默认：桶内中部到达，不触发桶尾截断） */
function hit(lo: number, hi: number, patch: Partial<HeadwayHit> = {}): HeadwayHit {
  const fromMin = 600; // 10:00
  const toMin = fromMin + 300; // 15:00
  return {
    lo,
    hi,
    span: "10:00-15:00",
    dayType: "mon_sat",
    crossesMidnight: false,
    fromMin,
    toMin,
    arrivalMin: fromMin + 60,
    ...patch,
  };
}

/** 与 `score.ts#costOf` 同源的 risk 分量（逐字复刻，用来对 architecture 的基准表） */
const riskOf = (slackMin: number | null | undefined) =>
  slackMin == null ? 0 : PREF_RISK_FACTOR * Math.max(0, TRANSFER_SAFETY_MIN - slackMin);

/**
 * 与 `RecommendCard.tsx#transferFeasibleOf` **完全同源**的 H8 派生（含宽松等号）。
 * ⚠️ `== null` 覆盖 `null` + `undefined`，与组件里那行逐字一致。
 */
function feasibleOf(slackMin: number | null | undefined): "yes" | "tight" | "no" {
  if (slackMin == null) return "yes";
  return slackMin < 0 ? "no" : slackMin < TRANSFER_SAFETY_MIN ? "tight" : "yes";
}

/* ══════════ ① 保守余量三档 + 冻结基准表 ══════════ */
console.log("\n① 保守余量（transfer-slack.ts / headway.ts#SLACK_NO_DATA）");
eq(BUS_SLACK_SPREAD_WEIGHT, 2, "权重常量 W = 2（架构师冻结）");
eq(SLACK_NO_DATA, 0, "档③常量 SLACK_NO_DATA 默认 0（待测量，非定稿）");
eq(SLACK_SPAN_EDGE_ENABLED, false, "桶尾截断默认关闭（= 与文档公式逐字一致）");

{
  /** ★ 架构师冻结的 4 个基准 case：lo / hi / wait / slack / risk */
  const TABLE: [number, number, number, number, number][] = [
    [4, 4, 4.0, 4, 0], // 定班 ⇒ 零惩罚基准
    [5, 7, 6.333333, 3, 0], // 窄桶不受罚
    [3, 5, 4.333333, 1, 1.0], // 中间档
    [8, 25, 19.333333, 0, 1.5], // 宽桶重点 case（risk 硬上界）
  ];
  for (const [lo, hi, wait, slack, risk] of TABLE) {
    const h = hit(lo, hi);
    near(conservativeWaitMin(h), wait, `基准 lo=${lo}/hi=${hi}：wait=(lo+2hi)/3 不变`);
    eq(busTransferSlackMin(h), slack, `基准 lo=${lo}/hi=${hi}：slack=max(0,2lo−hi)`);
    near(riskOf(busTransferSlackMin(h)), risk, `基准 lo=${lo}/hi=${hi}：risk=0.5·max(0,3−slack)`);
  }
}

ok(
  [hit(8, 12), hit(10, 12), hit(12, 15), hit(15, 20), hit(25, 30), hit(8, 25)].every(
    (h) => busTransferSlackMin(h) >= 0,
  ),
  "值域恒 ≥ 0（⇒ 巴士换乘永不进入 no 分支）",
);
eq(busTransferSlackMin(hit(10, 5)), 10, "脏数据 hi<lo ⇒ 被 lo 上界夹住（防御；实测全表 0 行）");
eq(busTransferSlackMin(hit(10, 12)), 8, "常见桶 lo=10/hi=12 ⇒ 8（免罚）");
eq(busTransferSlackMin(hit(25, 30)), 20, "长班距 lo=25/hi=30 ⇒ 20（免罚，已知方向性偏差，待裁决）");

{
  // 桶尾截断默认关闭 ⇒ 同一桶内不同到达时刻得到**相同**余量（与文档公式一致）
  const mid = busSlackPartsOf(hit(10, 12));
  const edge = busSlackPartsOf(hit(10, 12, { arrivalMin: 900 - 2 }));
  eq(edge.minsToSpanEnd, 2, "距时段尾 = 2 分（诊断字段照常可读）");
  eq(edge.boundaryCap, Number.POSITIVE_INFINITY, "开关关闭 ⇒ boundaryCap = ∞");
  eq(edge.value, mid.value, "开关关闭 ⇒ 到达时刻不影响余量（= 文档口径）");
  ok(
    !SLACK_SPAN_EDGE_ENABLED && mid.value === 8,
    "如需「桶内到达时刻差异化」，只能打开 SLACK_SPAN_EDGE_ENABLED（待主控批准）",
  );
  // 跨午夜仍要能算对距尾（供开关打开时使用）
  const mid2 = busSlackPartsOf(
    hit(10, 12, { fromMin: 1200, toMin: 1515, crossesMidnight: true, arrivalMin: 1440 + 30 }),
  );
  eq(mid2.minsToSpanEnd, 1515 - 1470, "跨午夜（20:00-01:15）距尾已对齐 +1440 域");
}

{
  // 三档取值：档② = 0、档③ = SLACK_NO_DATA（两者都必须走 tight 侧）
  const t2 = 0;
  const t3 = SLACK_NO_DATA;
  eq(feasibleOf(t2), "tight", "档②（中位数兜底 0）⇒ tight");
  eq(feasibleOf(t3), "tight", "档③（SLACK_NO_DATA=0）⇒ tight（不是 yes，避免「数据越少越不告警」）");
}

/* ══════════ ② 反向断言：同场换乘不得被判「需赶」 ══════════ */
console.log("\n② 同场换乘（SAME_FIELD_TRANSFER_MIN = 0）反向断言");
eq(SAME_FIELD_TRANSFER_MIN, 0, "同场换乘步行分钟恒 0（常量未被改）");
{
  /**
   * 关键断言：`slackMin` **完全不读换乘步行分钟**。
   * ⇒ 「同场（0 分）」不会因为 0 而被算成「没时间 ⇒ 需赶」。
   */
  const h = hit(10, 12);
  eq(busTransferSlackMin(h), busTransferSlackMin(h), "同场(0 分) 与非同场 的余量相同 —— 0 步行不参与计算");
  ok(!Object.keys(h).includes("transferMinutes"), "函数签名不接受换乘步行分钟（无法把 0 分读成「需赶」）");
  eq(feasibleOf(undefined), "yes", "同场换乘（model 不写该字段 ⇒ undefined）⇒ yes");
  eq(feasibleOf(null), "yes", "null（未参与计算）⇒ yes —— `== null` 宽松等号必须保留");
  eq(feasibleOf(0), "tight", "0 ⇒ tight（0 不是「无数据」）");
  eq(feasibleOf(2.9), "tight", "(0,3) ⇒ tight");
  eq(feasibleOf(3), "yes", "≥3 ⇒ yes");
}

/* ══════════ ③ totalMin 口径不变量 ══════════ */
console.log("\n③ totalMin 口径不变量");
near(conservativeWaitMin({ lo: 8, hi: 12 }), (8 + 2 * 12) / 3, "conservativeWaitMin 仍是 (lo+2hi)/3");
near(conservativeWaitMin({ lo: 4, hi: 4 }), 4, "定班时 = 班距本身");
eq(TRANSFER_SAFETY_MIN, 3, "安全余量常量 = 3 分（未改）");
eq(PREF_ALPHA, 10, "PREF_ALPHA = 10 分/换乘（未改）");
eq(PREF_RISK_FACTOR, 0.5, "riskFactor = 0.5（未改）");
ok(
  PREF_RISK_FACTOR <= PREF_ALPHA / 2,
  "调参红线：riskFactor ≤ α/2 = 5（当前 0.5，10 倍余量）",
  `α/2=${PREF_ALPHA / 2}`,
);
ok(
  PREF_RISK_FACTOR * TRANSFER_SAFETY_MIN < PREF_ALPHA * 0.15 + 1e-9,
  "单次换乘 risk 上界 1.5 分 < α 项的 15% ⇒ 不可能淹没 cost",
  `1.5 / ${PREF_ALPHA} = ${(1.5 / PREF_ALPHA) * 100}%`,
);
{
  /** 结构断言：`slackMin` 是 `TransferView` 上的另一个字段，与进 totalMin 的 `waitMin` 互不影响 */
  const card = {
    totalMin: 30,
    walkOut: { minutes: 5 },
    walkIn: { minutes: 4 },
    rides: [
      { minutes: 10, waitMin: 3, kind: "bus" },
      { minutes: 6, waitMin: 2, kind: "bus" },
    ],
    transfers: [{ minutes: 0, waitMin: 2, slackMin: 0, sameField: true }],
  } as unknown as RecommendCard;
  const sumWith = (slack: number | null) => {
    const t = card.transfers[0];
    const c2 = { ...card, transfers: [{ ...t, slackMin: slack }] };
    let s = c2.walkOut.minutes + c2.walkIn.minutes;
    for (const r of c2.rides) s += r.minutes + (r.waitMin ?? 0);
    for (const x of c2.transfers) s += x.minutes;
    return s;
  };
  eq(sumWith(0), sumWith(null), "卡面加总与 slackMin 取值无关 ⇒ slack 不进 totalMin");
  ok(
    Math.abs(costOf({ ...card, transfers: [{ ...card.transfers[0], slackMin: null }] }) - costOf(card)) >
      0,
    "但 slackMin 确实改变 cost（1.5 分量级的风险项）",
  );
}

/* ══════════ ④ track.ts：候车锚 / 过站过滤 ══════════ */
console.log("\n④ track.ts 候车锚与过站过滤");
const LNG0 = 113.55;
const LAT0 = 22.15;
const DEG_PER_M_LNG = 1 / 103_140;
const at = (m: number) => ({ lng: LNG0 + m * DEG_PER_M_LNG, lat: LAT0 });
const BOARD = { ...at(0) };

const vAtBoard: TrackVehicle = {
  plate: "MA0001",
  ...at(5),
  status: "stopping",
  interval: null,
  atStation: { code: "T100/1" },
};
const vLeftBoard: TrackVehicle = {
  plate: "MA0001",
  ...at(300),
  status: "moving",
  interval: { from: { code: "T100/1" }, to: { code: "T101" } },
  atStation: null,
};
const vNextStop: TrackVehicle = {
  plate: "MA0001",
  ...at(500),
  status: "stopping",
  interval: null,
  atStation: { code: "T101" },
};
const vApproaching: TrackVehicle = {
  plate: "MB0002",
  ...at(-400),
  status: "moving",
  interval: { from: { code: "T099" }, to: { code: "T100/1" } },
  atStation: null,
};

eq(PASS_ANCHOR_NEAR_M, 150, "锚点距离门 150m");
eq(PASS_MARGIN_M, 120, "驶离判据 120m");

const anchor = anchorOf([vApproaching, vAtBoard], "T100", BOARD, { loSec: 120, nowMs: 1_000 });
ok(anchor !== null && anchor.plate === "MA0001", "anchorOf 取「停靠本站」那辆（不是更近的后车）", JSON.stringify(anchor));
eq(anchor?.loSec, 120, "锚点带上 loSec（供对比/诊断，不参与判据）");

const stopMains = ["T100", "T101", "T102"];
eq(passedBoardOf({ vehicle: vAtBoard, stopMains, boardPos: BOARD }), false, "停靠上车站 ⇒ 未过站");
eq(passedBoardOf({ vehicle: vLeftBoard, stopMains, boardPos: BOARD }), true, "已驶离上车站（between）⇒ 过站");
eq(passedBoardOf({ vehicle: vNextStop, stopMains, boardPos: BOARD }), true, "停靠第 1 站 ⇒ 过站");
const anchorNear = { plate: "MA0001", distM: 80, loSec: 120, atMs: 0 };
eq(
  passedBoardOf({ vehicle: vLeftBoard, boardPos: BOARD, anchor: anchorNear }),
  true,
  "无站序时几何判据生效（80m → 300m，增 220m > 120m）",
);
eq(
  passedBoardOf({ vehicle: { ...vLeftBoard, ...at(150) }, boardPos: BOARD, anchor: anchorNear }),
  false,
  "距离只增大 70m（< 120m）⇒ 不判过站（宁留不误删）",
);
eq(
  passedBoardOf({
    vehicle: vLeftBoard,
    boardPos: BOARD,
    anchor: { plate: "MA0001", distM: 400, loSec: 120, atMs: 0 },
  }),
  false,
  "锚定时它并不在上车站附近（400m）⇒ 几何判据不成立",
);
eq(
  passedBoardOf({ vehicle: vLeftBoard, boardPos: BOARD, anchor: { ...anchorNear, plate: "MZ9999" } }),
  false,
  "锚点车牌不同 ⇒ 不比对（不拿别人的距离判它）",
);

{
  const list = [vLeftBoard, vApproaching, vAtBoard];
  const legacy = rankBoardingVehicles(list, "T100", BOARD);
  eq(legacy.length, 3, "默认（不开 filterPassed）⇒ 长度不变（向后兼容旧行为）");
  eq(legacy[0].plate, "MA0001", "排序第一 = 停靠本站那辆");
  const filtered = rankBoardingVehicles(list, "T100", BOARD, { filterPassed: true, stopMains });
  ok(!filtered.includes(vLeftBoard), "开了 filterPassed ⇒ 已过站的那辆被剔除", `剩余 ${filtered.length} 辆`);
  eq(filtered.length, 2, "停靠本站的车 + 还在驶来的后车都保留（只删过站的）");
  ok(filtered.includes(vAtBoard) && filtered.includes(vApproaching), "保留的正是「停在站台」与「驶来」两类");
  const allGone = rankBoardingVehicles([vLeftBoard, vNextStop], "T100", BOARD, {
    filterPassed: true,
    stopMains,
  });
  eq(allGone.length, 0, "全部已过站 ⇒ 候选为空（「候选中没车 / 错过班次」信号得以成立）");
}

/* ══════════ 汇总 ══════════ */
const total = pass + fail;
console.log(`\n结果：${fail === 0 ? "PASS" : "FAIL"} · ${pass}/${total} 通过${fail ? ` · ${fail} 失败` : ""}`);
process.exit(fail === 0 ? 0 : 1);
