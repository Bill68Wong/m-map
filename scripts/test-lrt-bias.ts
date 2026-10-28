/**
 * 轻轨读秒契约（`fixDeparture`）· 单测（scripts/test-lrt-bias.ts · v3.2.0）
 *
 * 覆盖（对 AC-63/64/65/67 + AC-71/72）：
 *   · 氹仔线命中（叠加逐站偏差）/ 未命中（回落 0 + secPrecise=false）
 *   · 模式为**非四主力变体**（表里没有）→ 仍回落（**不得猜模式**）
 *   · 石排湾 -5 / 横琴 +40（线路级）
 *   · biasIndex 缺值 / NaN / undefined → 一律 secPrecise=false, biasSec=0
 *   · `pattern=null` → 未命中分支
 *   · 跨午夜 `tableMin>1440`（depMs 数值自洽）
 *   · **AC-67 不变式**：同参两次调用 ⇒ depMs 完全相等
 *   · `LRT_HOP_SEC` 逐段命中 + 未收录回落 120 + 氹仔全线求和（正向 1605s / 反向 1570s）
 *
 * 运行：npm run test:lrt-bias（= tsx scripts/test-lrt-bias.ts）
 */
import { buildBiasIndex, fixDeparture, type BiasIndex } from "../src/lib/lrt/apply-bias";
import { LRT_HOP_FALLBACK_SEC, LRT_HOP_SEC } from "../src/lib/recommend/types";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}

const LINE_TPL = "LRT-氹仔线";
const LINE_SPVL = "LRT-石排湾线";
const LINE_HQL = "LRT-横琴线";
const DAY_START = 0; // 用 0 基准，depMs = (tableMin*60 + biasSec)*1000

/** 造一个偏差索引（station 键域 `route_code|direction|pattern|api_station`） */
function mkIndex(
  station: [string, string, string, string, number][],
  line: [string, number][],
): BiasIndex {
  return buildBiasIndex(
    station.map(([route_code, direction, pattern, api_station, dep_bias_sec]) => ({
      route_code,
      direction,
      pattern,
      api_station,
      dep_bias_sec,
    })),
    line.map(([route_code, dep_bias_sec]) => ({ route_code, dep_bias_sec })),
  );
}

console.log("fixDeparture · 轻轨读秒契约单测\n");

// ── ① 氹仔线命中（逐站偏差叠加）──
{
  const idx = mkIndex([[LINE_TPL, "TFT", "52222222222", "OCE", 10]], []);
  const f = fixDeparture({
    lineCode: LINE_TPL,
    routeNo: "TPL",
    directionApi: "TFT",
    apiStation: "OCE",
    dayType: "mon_thurs",
    tableMin: 600,
    dayStartMs: DAY_START,
    pattern: "52222222222",
    biasIndex: idx,
  });
  assert(f.secPrecise === true, "氹仔命中：secPrecise=true");
  assert(f.biasSec === 10, "氹仔命中：biasSec = +10");
  assert(f.depMs === (600 * 60 + 10) * 1000, "氹仔命中：depMs = 表定秒 + 偏差");
  assert(f.pattern === "52222222222", "氹仔命中：pattern 原样透传");
}

// ── ② 氹仔线未命中（pattern=null）──
{
  const idx = mkIndex([[LINE_TPL, "TFT", "52222222222", "OCE", 10]], []);
  const f = fixDeparture({
    lineCode: LINE_TPL,
    routeNo: "TPL",
    directionApi: "TFT",
    apiStation: "OCE",
    dayType: "mon_thurs",
    tableMin: 600,
    dayStartMs: DAY_START,
    pattern: null,
    biasIndex: idx,
  });
  assert(f.secPrecise === false, "氹仔未命中（null）：secPrecise=false");
  assert(f.biasSec === 0, "氹仔未命中（null）：biasSec=0（不得猜）");
  assert(f.depMs === 600 * 60 * 1000, "氹仔未命中（null）：depMs = 纯表定");
}

// ── ③ 氹仔线模式为「非四主力变体」（表里没有该键）→ 回落，不得猜 ──
{
  const idx = mkIndex([[LINE_TPL, "TFT", "52222222222", "OCE", 10]], []);
  const f = fixDeparture({
    lineCode: LINE_TPL,
    routeNo: "TPL",
    directionApi: "TFT",
    apiStation: "OCE",
    dayType: "mon_thurs",
    tableMin: 600,
    dayStartMs: DAY_START,
    pattern: "52222312223", // 变体：不在偏差表
    biasIndex: idx,
  });
  assert(f.secPrecise === false, "氹仔变体模式：secPrecise=false（不猜模式）");
  assert(f.biasSec === 0, "氹仔变体模式：biasSec=0");
}

// ── ④ 石排湾 -5（线路级）──
{
  const idx = mkIndex([], [[LINE_SPVL, -5]]);
  const f = fixDeparture({
    lineCode: LINE_SPVL,
    routeNo: "SPVL",
    directionApi: "SPV",
    apiStation: "UH",
    dayType: "mon_thurs",
    tableMin: 900,
    dayStartMs: DAY_START,
    pattern: null,
    biasIndex: idx,
  });
  assert(f.secPrecise === true, "石排湾：secPrecise=true（线路级）");
  assert(f.biasSec === -5, "石排湾：biasSec = -5");
  assert(f.depMs === (900 * 60 - 5) * 1000, "石排湾：depMs = 表定秒 − 5");
}

// ── ⑤ 横琴 +40（线路级）──
{
  const idx = mkIndex([], [[LINE_HQL, 40]]);
  const f = fixDeparture({
    lineCode: LINE_HQL,
    routeNo: "HQL",
    directionApi: "HQ",
    apiStation: "LOT",
    dayType: "fri",
    tableMin: 900,
    dayStartMs: DAY_START,
    pattern: null,
    biasIndex: idx,
  });
  assert(f.secPrecise === true, "横琴：secPrecise=true");
  assert(f.biasSec === 40, "横琴：biasSec = +40");
  assert(f.depMs === (900 * 60 + 40) * 1000, "横琴：depMs = 表定秒 + 40");
}

// ── ⑥ 线路级缺值 → 回落 ──
{
  const idx = mkIndex([], []);
  const f = fixDeparture({
    lineCode: LINE_SPVL,
    routeNo: "SPVL",
    directionApi: "SPV",
    apiStation: "UH",
    dayType: "mon_thurs",
    tableMin: 900,
    dayStartMs: DAY_START,
    pattern: null,
    biasIndex: idx,
  });
  assert(f.secPrecise === false && f.biasSec === 0, "线路级缺值：回落 0 / false");
}

// ── ⑦ NaN / undefined / 非有限 → 一律回落 ──
{
  const idx: BiasIndex = { station: new Map(), line: new Map() };
  idx.station.set(`${LINE_TPL}|TFT|52222222222|OCE`, Number.NaN);
  idx.line.set(LINE_SPVL, Number.NaN);
  const fTpl = fixDeparture({
    lineCode: LINE_TPL, routeNo: "TPL", directionApi: "TFT", apiStation: "OCE",
    dayType: "mon_thurs", tableMin: 600, dayStartMs: DAY_START, pattern: "52222222222", biasIndex: idx,
  });
  const fSpv = fixDeparture({
    lineCode: LINE_SPVL, routeNo: "SPVL", directionApi: "SPV", apiStation: "UH",
    dayType: "mon_thurs", tableMin: 600, dayStartMs: DAY_START, pattern: null, biasIndex: idx,
  });
  assert(fTpl.secPrecise === false && fTpl.biasSec === 0, "NaN（站级）：回落 0 / false");
  assert(fSpv.secPrecise === false && fSpv.biasSec === 0, "NaN（线路级）：回落 0 / false");

  const idx2: BiasIndex = { station: new Map(), line: new Map() };
  idx2.station.set(`${LINE_TPL}|TFT|52222222222|OCE`, undefined as unknown as number);
  const fU = fixDeparture({
    lineCode: LINE_TPL, routeNo: "TPL", directionApi: "TFT", apiStation: "OCE",
    dayType: "mon_thurs", tableMin: 600, dayStartMs: DAY_START, pattern: "52222222222", biasIndex: idx2,
  });
  assert(fU.secPrecise === false && fU.biasSec === 0, "undefined（站级）：回落 0 / false");
}

// ── ⑧ 跨午夜（服务日轴）──
//    ⚠️ v3.3.0 澄清：`fixDeparture` 的 `tableMin` = **服务日 00:00 起分钟偏移**，`dayStartMs` = **该服务日的 00:00**。
//       昨日行跨午夜续班（offset ≥ 1440）由**调用方**（`queryLrtDepartures`）把 `dayStartMs` 传为**昨日 00:00**
//       ⇒ 绝对时刻落在**今日凌晨**。（v3.2.0 曾对昨/今两行同用「今日 00:00」⇒ 该班被整整推迟一天，QA 复现。）
{
  const idx = mkIndex([], [[LINE_HQL, 40]]);
  const DAY_MS_T = 86_400_000;
  // ⑧a：今日服务日行、offset>1440（今日末班跨入次日凌晨）→ 以「今日 00:00」为基
  const todayAxis = fixDeparture({
    lineCode: LINE_HQL, routeNo: "HQL", directionApi: "HQ", apiStation: "LOT",
    dayType: "fri", tableMin: 1445, dayStartMs: DAY_START, pattern: null, biasIndex: idx,
  });
  assert(todayAxis.depMs === (1445 * 60 + 40) * 1000, "今日服务日 offset=1445 ⇒ dayStart(今日0点) + 1445*60 + 40");
  // ⑧b：昨日行跨午夜续班 → 以「昨日 00:00」为基 ⇒ 落在**今日** 00:05:40（**不得**被推迟一天）
  const prevAxis = fixDeparture({
    lineCode: LINE_HQL, routeNo: "HQL", directionApi: "HQ", apiStation: "LOT",
    dayType: "fri", tableMin: 1445, dayStartMs: DAY_START - DAY_MS_T, pattern: null, biasIndex: idx,
  });
  assert(prevAxis.depMs === (5 * 60 + 40) * 1000, "昨日跨午夜(offset=1445) ⇒ 昨日0点为基 ⇒ 今日 00:05:40（不被推迟一天）");
}

// ── ⑨ AC-67 不变式：同参两次调用 ⇒ depMs 完全相等 ──
{
  const idx = mkIndex([[LINE_TPL, "BAR", "22222232222", "COE", 90]], []);
  const args = {
    lineCode: LINE_TPL, routeNo: "TPL", directionApi: "BAR", apiStation: "COE",
    dayType: "sat_sun_holiday", tableMin: 800, dayStartMs: 1_700_000_000_000, pattern: "22222232222", biasIndex: idx,
  } as const;
  const a = fixDeparture({ ...args });
  const b = fixDeparture({ ...args });
  assert(a.depMs === b.depMs && a.biasSec === b.biasSec && a.secPrecise === b.secPrecise, "AC-67：同参两次 ⇒ depMs/biasSec/secPrecise 完全相等");
}

// ── ⑩ LRT_HOP_SEC：值表 + 兜底 + 全线求和 ──
console.log("\nLRT_HOP_SEC · 氹仔线逐段乘车秒表\n");
{
  // 正向（媽閣→氹仔碼頭）逐段（db_code 域）—— 与 06 §5.1 一致
  const FORWARD: [string, number][] = [
    ["LRT-BAR|LRT-OCH", 285], ["LRT-OCH|LRT-JCK", 115], ["LRT-JCK|LRT-STD", 145],
    ["LRT-STD|LRT-PAK", 115], ["LRT-PAK|LRT-CWE", 120], ["LRT-CWE|LRT-LOT", 135],
    ["LRT-LOT|LRT-UH", 100], ["LRT-UH|LRT-EAG", 130], ["LRT-EAG|LRT-LDE", 110],
    ["LRT-LDE|LRT-MUST", 125], ["LRT-MUST|LRT-AP", 145], ["LRT-AP|LRT-TFT", 80],
  ];
  // 反向（氹仔碼頭→媽閣）
  const REVERSE: [string, number][] = [
    ["LRT-TFT|LRT-AP", 110], ["LRT-AP|LRT-MUST", 135], ["LRT-MUST|LRT-LDE", 140],
    ["LRT-LDE|LRT-EAG", 100], ["LRT-EAG|LRT-UH", 130], ["LRT-UH|LRT-LOT", 105],
    ["LRT-LOT|LRT-CWE", 125], ["LRT-CWE|LRT-PAK", 120], ["LRT-PAK|LRT-STD", 105],
    ["LRT-STD|LRT-JCK", 130], ["LRT-JCK|LRT-OCH", 120], ["LRT-OCH|LRT-BAR", 250],
  ];

  let segBad = 0;
  for (const [k, v] of [...FORWARD, ...REVERSE]) {
    if (LRT_HOP_SEC[k] !== v) {
      segBad++;
      console.error(`    段不符：${k} 期望 ${v} 实际 ${LRT_HOP_SEC[k]}`);
    }
  }
  assert(segBad === 0, `LRT_HOP_SEC 全 24 段逐段值正确`);
  assert(Object.keys(LRT_HOP_SEC).length === 24, "LRT_HOP_SEC 键数 = 24（正反各 12）");

  const fSum = FORWARD.reduce((s, [k]) => s + LRT_HOP_SEC[k], 0);
  const rSum = REVERSE.reduce((s, [k]) => s + LRT_HOP_SEC[k], 0);
  assert(fSum === 1605, `正向全线求和 = 1605 s（实际 ${fSum}）`);
  assert(rSum === 1570, `反向全线求和 = 1570 s（实际 ${rSum}）`);

  // 未收录跳段 → 120 s 兜底
  const unknown = LRT_HOP_SEC["LRT-BAR|LRT-TFT"] ?? LRT_HOP_FALLBACK_SEC;
  assert(unknown === 120, "未收录跳段 → 回落 120 s/跳");
  assert(LRT_HOP_FALLBACK_SEC === 120, "LRT_HOP_FALLBACK_SEC = 120");
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
