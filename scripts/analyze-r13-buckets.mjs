#!/usr/bin/env node
/**
 * R13 分桶策略分析（scripts/analyze-r13-buckets.mjs）
 *
 * 输入：**本地原始采集分片**派生出的样本（不是 DB 聚合表）
 *   data/tracking/<label>-meta.json           轮次元数据（起止时刻 / 时长 / 是否硬熔断）
 *   data/tracking/r13-<label>-derived.json    ← 由 scripts/track-derive.mjs 重建
 *
 * 重建命令（每轮一条，可复算）：
 *   node scripts/track-derive.mjs --label=r13-<label> \
 *        --in=data/tracking/<label>-part*.jsonl.gz --truth=none
 *
 * 输出：.verify/r13-analysis.json（全部数字）+ 控制台摘要
 * 只读：不连库、不写 data/。唯一写的是 .verify/r13-analysis*.json。
 *
 * ── 输出规约（2026-11-20 负责人定的通用规则）────────────────────
 *   诊断输出不许「沉默即正常」：为 0 也要打印结论与数值。
 *   本脚本的时段分布已改成 24 小时全打印（含 00–06 全 0）、早高峰轮次为 0 时也打一行说明。
 *
 * ── 样本口径（与生产完全一致的取舍，任何一处不同都会让数字对不上）──────────
 *   ① 取 `rawDepartSamples`（离开口径：相邻两站「离开」事件之差）+ `rawTerminalSamples`
 *      （末站口径：到达末站 − 离开倒数第二站）。
 *   ② 剔除同键一致性护栏命中项（`outlierGuard.departCandidates`，按 route|dir|plate|t|minutes 全等匹配；
 *      末站样本按 `arriveCandidates` 的 route|dir|plate|t 匹配）。
 *   ③ **不使用** arrive 口径（它与 depart 口径是同一批事件的两套算法，双计会重复；
 *      生产 ETA 走 depart，见 src/lib/rebuild/segment-stats.ts 主口径）。
 *   ④ 不使用 `rawSpannedSamples`（跨站段，生产上不进主查询）。
 *   ⑤ 分桶用生产定义 `bucketOfRoute`：am 7–9（按日型分池）/ day 9–16 / pm 16–20 / night 其余。
 *      ⚠️ 本脚本**不查 lrt_holidays**，节假日按普通日型处理 —— 这是已知偏差，见报告「局限」。
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARGV = process.argv.slice(2);
const flag = (k, d) => { const a = ARGV.find((x) => x === `--${k}` || x.startsWith(`--${k}=`)); if (!a) return d; return a.includes("=") ? a.split("=").slice(1).join("=") : "true"; };
/** 敏感性开关（报告里要能复算「换个口径结论变不变」） */
const EXCLUDE_TERMINAL = flag("exclude-terminal", "false") === "true";
const MIN_HOLD = Number(flag("min-hold", "3"));
/** pool=am ⇒ 预测源**只**取早高峰轮次（其余轮次不参与）；默认 allrounds */
const POOL_SCOPE = flag("pool", "allrounds");

const ROOT = join(import.meta.dirname, "..");
const TRACK = join(ROOT, "data", "tracking");
const OUT = join(ROOT, ".verify", `r13-analysis${process.env.R13_TAG ? "-" + process.env.R13_TAG : ""}.json`);

/* ════════════ 0. 小工具 ════════════ */
const P = (n) => String(n).padStart(2, "0");
/** 澳门时间分量（UTC+8，无夏令时） */
const macau = (ms) => {
  const d = new Date(ms + 8 * 3600e3);
  return { weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), day: d.toISOString().slice(0, 10) };
};
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 生产聚合桶（src/lib/rebuild/buckets.ts · bucketOfRoute，节假日按普通日型） */
function bucketOfRoute(weekday, hour) {
  const weekendLike = weekday === 0 || weekday === 6;
  if (hour >= 7 && hour < 9) return weekendLike ? "am_weekend" : "am_work";
  if (hour >= 9 && hour < 16) return "day";
  if (hour >= 16 && hour < 20) return "pm";
  return "night";
}

const median = (a) => (a.length ? quantile(a, 0.5) : NaN);
function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}
const pct = (arr, q) => quantile(arr, q);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const r3 = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null);

/* ════════════ 1. 轮次清单 + 排除判据（按 meta 内容，不按文件名猜）════════════ */
const metaFiles = readdirSync(TRACK).filter((f) => f.endsWith("-meta.json")).sort();
const all = [];
for (const f of metaFiles) {
  const label = f.replace(/-meta\.json$/, "");
  const m = JSON.parse(readFileSync(join(TRACK, f), "utf8"));
  const t0 = Date.parse(m.startedAt), t1 = Date.parse(m.finishedAt);
  const mp0 = macau(t0), mp1 = macau(t1);
  all.push({
    label, meta: m,
    startedAt: m.startedAt, finishedAt: m.finishedAt,
    durationMin: m.durationMin, aborted: m.aborted,
    weekday: mp0.weekday, day: mp0.day,
    win: `${P(mp0.hour)}:${P(mp0.minute)}~${P(mp1.hour)}:${P(mp1.minute)}`,
    hours: [mp0.hour, mp1.hour],
  });
}

/**
 * 排除判据（两条，均只看 meta 字段；互相独立）
 *   E1 硬熔断：`aborted !== null`（采集中断 ⇒ 尾部时间缺失，样本不完整但**不是**无效数据；
 *      它的问题是没有可比性 —— 别的轮次跑满 30 分钟）
 *   E2 时长不足：`durationMin < 10`。10 分钟的来源：状态机要「0→1→0」至少两次转移才有
 *      一条段样本，5s 间隔下 10 分钟 ≈ 120 帧/线，是能稳定产出样本的下限；实测 4 条
 *      <10 分的轮次全是 smoke/selftest（1 / 0.5 / 3 / 1 分）。
 */
const E2_MIN = 10;
const excluded = [], kept = [];
for (const r of all) {
  const why = [];
  if (r.aborted !== null && r.aborted !== undefined) why.push(`E1 硬熔断：${r.aborted}`);
  if (!(r.durationMin >= E2_MIN)) why.push(`E2 时长 ${r.durationMin} 分 < ${E2_MIN}`);
  (why.length ? excluded : kept).push(why.length ? { ...r, why } : r);
}
kept.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

/* ════════════ 2. 逐轮载入派生样本 ════════════ */
const rounds = [];
const missingDerived = [];
for (const r of kept) {
  let d;
  try {
    d = JSON.parse(readFileSync(join(TRACK, `r13-${r.label}-derived.json`), "utf8"));
  } catch {
    missingDerived.push(r.label);
    continue;
  }
  const og = d.outlierGuard ?? {};
  const depOut = new Set((og.departCandidates ?? []).map((c) => `${c.route}|${c.dir}|${c.plate}|${c.t}|${c.minutes}`));
  const arrOut = new Set((og.arriveCandidates ?? []).map((c) => `${c.route}|${c.dir}|${c.plate}|${c.t}`));
  const samples = [];
  let nDep = 0, nTerm = 0, nOutlier = 0;
  for (const s of d.rawDepartSamples ?? []) {
    if (depOut.has(`${s.route}|${s.dir}|${s.plate}|${s.t}|${s.minutes}`)) { nOutlier++; continue; }
    samples.push({ route: s.route, from: s.from, to: s.to, minutes: s.minutes, t: s.t, kind: "depart" });
    nDep++;
  }
  for (const s of EXCLUDE_TERMINAL ? [] : (d.rawTerminalSamples ?? [])) {
    if (arrOut.has(`${s.route}|${s.dir}|${s.plate}|${s.t}`)) { nOutlier++; continue; }
    samples.push({ route: s.route, from: s.from, to: s.to, minutes: s.minutes, t: s.t, kind: "terminal" });
    nTerm++;
  }
  rounds.push({ ...r, nDep, nTerm, nOutlier, samples });
}

/* ════════════ 3. 全局规模 + 时段覆盖 ════════════ */
const allSamples = rounds.flatMap((r) => r.samples);
const hourHist = new Array(24).fill(0);
const bucketHist = {};
const wdBucketHist = {};
const keySet = new Set();
const dateHour = {};
for (const s of allSamples) {
  const mp = macau(s.t);
  hourHist[mp.hour]++;
  const b = bucketOfRoute(mp.weekday, mp.hour);
  bucketHist[b] = (bucketHist[b] ?? 0) + 1;
  const k = `${WD[mp.weekday]}|${b}`;
  wdBucketHist[k] = (wdBucketHist[k] ?? 0) + 1;
  keySet.add(`${s.route}|${s.from}|${s.to}`);
  const dh = `${mp.day}#${P(mp.hour)}`;
  dateHour[dh] = (dateHour[dh] ?? 0) + 1;
}

/* ════════════ 4. 按 (route, from, to) 归集 ════════════ */
/** key -> { am_work:[], day:[], pm:[], night:[], am_weekend:[], all:[] } */
const byKey = new Map();
for (const s of allSamples) {
  const mp = macau(s.t);
  const k = `${s.route}|${s.from}|${s.to}`;
  if (!byKey.has(k)) byKey.set(k, { am_work: [], am_weekend: [], day: [], pm: [], night: [], all: [] });
  const rec = byKey.get(k);
  const b = bucketOfRoute(mp.weekday, mp.hour);
  rec[b].push(s.minutes);
  rec.all.push(s.minutes);
}

/* ════════════ 5. Q1 早高峰是否真有差异 ════════════ */
const q1 = {};
for (const [name, bk] of [["workday", "am_work"], ["weekend", "am_weekend"]]) {
  const ns = [...byKey.values()].filter((v) => v[bk].length > 0).map((v) => v[bk].length);
  q1[name] = {
    keysWithAm: ns.length,
    nP50: r3(pct(ns, 0.5)), nP90: r3(pct(ns, 0.9)), nMax: ns.length ? Math.max(...ns) : 0,
    ge30: ns.filter((x) => x >= 30).length, ge20: ns.filter((x) => x >= 20).length, ge10: ns.filter((x) => x >= 10).length,
    ge5: ns.filter((x) => x >= 5).length, ge3: ns.filter((x) => x >= 3).length, ge1: ns.length,
  };
}
/** 可比子集：AM 与 day 都有 ≥N 条，且同键 ⇒ 相对差 (amMed − dayMed)/dayMed */
const cmpDiffs = (N) => {
  const out = [];
  for (const [k, v] of byKey) {
    if (v.am_work.length < N || v.day.length < N) continue;
    const am = median(v.am_work), dy = median(v.day);
    if (!(dy > 0)) continue;
    out.push({ k, nAm: v.am_work.length, nDay: v.day.length, am, day: dy, rel: (am - dy) / dy, abs: am - dy });
  }
  return out;
};
for (const N of [5, 10, 20, 30]) {
  const rows = cmpDiffs(N);
  const rel = rows.map((x) => x.rel).sort((a, b) => a - b);
  q1[`cmpN${N}`] = {
    keys: rows.length,
    relP10: r3(pct(rel, 0.1)), relP50: r3(pct(rel, 0.5)), relP90: r3(pct(rel, 0.9)),
    shareSlower: rows.length ? r3(rows.filter((x) => x.rel > 0).length / rows.length) : null,
    shareSlower20: rows.length ? r3(rows.filter((x) => x.rel > 0.2).length / rows.length) : null,
    absP50: r3(pct(rows.map((x) => x.abs), 0.5)), absP90: r3(pct(rows.map((x) => x.abs), 0.9)),
  };
}

/* ════════════ 6. Q2 桶内方差 vs 桶间差异 ════════════ */
/** 每键：桶间中位数极差 ÷ 桶内 IQR 均值（桶内 IQR 只算 n≥5 的桶）*/
const q2rows = [];
for (const [k, v] of byKey) {
  const buckets = ["am_work", "day", "pm", "night"].filter((b) => v[b].length >= 5);
  if (v.all.length < 30 || buckets.length < 2) continue;
  const meds = buckets.map((b) => median(v[b]));
  const iqrs = buckets.map((b) => pct(v[b], 0.75) - pct(v[b], 0.25));
  const spread = Math.max(...meds) - Math.min(...meds);
  const iqrMean = mean(iqrs);
  if (!(iqrMean > 0)) continue;
  q2rows.push({ k, buckets: buckets.length, n: v.all.length, spread, iqrMean, ratio: spread / iqrMean });
}
const q2ratios = q2rows.map((r) => r.ratio).sort((a, b) => a - b);
const q2 = {
  keys: q2rows.length,
  ratioP10: r3(pct(q2ratios, 0.1)), ratioP25: r3(pct(q2ratios, 0.25)), ratioP50: r3(pct(q2ratios, 0.5)),
  ratioP75: r3(pct(q2ratios, 0.75)), ratioP90: r3(pct(q2ratios, 0.9)),
  shareGt1: r3(q2rows.filter((r) => r.ratio > 1).length / q2rows.length),
  shareGt2: r3(q2rows.filter((r) => r.ratio > 2).length / q2rows.length),
  shareLt05: r3(q2rows.filter((r) => r.ratio < 0.5).length / q2rows.length),
  spreadP50: r3(pct(q2rows.map((r) => r.spread), 0.5)),
  spreadP90: r3(pct(q2rows.map((r) => r.spread), 0.9)),
  iqrP50: r3(pct(q2rows.map((r) => r.iqrMean), 0.5)),
  iqrP90: r3(pct(q2rows.map((r) => r.iqrMean), 0.9)),
};

/* ════════════ 7. Q3 取消早高峰分池的损失（留一轮交叉验证）════════════ */
/** 只有窗口落在工作日 7:00–9:00 的轮次能当「留出集」 */
const amRounds = rounds.filter((r) => r.samples.some((s) => bucketOfRoute(macau(s.t).weekday, macau(s.t).hour) === "am_work"));
/** 轮次 -> key -> 桶样本 */
const roundBuckets = new Map();
for (const r of rounds) {
  const m = new Map();
  for (const s of r.samples) {
    const mp = macau(s.t);
    const k = `${s.route}|${s.from}|${s.to}`;
    if (!m.has(k)) m.set(k, { am_work: [], am_weekend: [], day: [], pm: [], night: [], all: [] });
    m.get(k)[bucketOfRoute(mp.weekday, mp.hour)].push(s.minutes);
    m.get(k).all.push(s.minutes);
  }
  roundBuckets.set(r.label, m);
}
const MIN_PRED = 5;
const schemes = {
  A: { name: "现状（am_work 优先，回退 all）", pick: (pool) => pickA(pool) },
  B: { name: "只用 day（回退 all）", pick: (pool) => pickOne(pool, "day") },
  C: { name: "am_work+day 合并（回退 all）", pick: (pool) => pickMerge(pool, ["am_work", "day"]) },
  D: { name: "只用 all（全周池）", pick: (pool) => pickAll(pool) },
};
function pickA(pool) {
  const am = pool.am_work ?? [];
  if (am.length >= MIN_PRED) return { v: median(am), src: "am_work", n: am.length };
  return pickAll(pool);
}
function pickOne(pool, b) {
  const x = pool[b] ?? [];
  if (x.length >= MIN_PRED) return { v: median(x), src: b, n: x.length };
  return pickAll(pool);
}
function pickMerge(pool, bs) {
  const x = bs.flatMap((b) => pool[b] ?? []);
  if (x.length >= MIN_PRED) return { v: median(x), src: bs.join("+"), n: x.length };
  return pickAll(pool);
}
function pickAll(pool) {
  const x = pool.all ?? [];
  if (x.length >= MIN_PRED) return { v: median(x), src: "all", n: x.length };
  return null;
}

const amRoundLabels = new Set(amRounds.map((r) => r.label));
const q3detail = [];
for (const held of amRounds) {
  const holdMap = roundBuckets.get(held.label);
  // 其余轮次合并成一个池（同键跨轮累加；轮次之间时间窗不重叠，见下面 overlap 检查）
  const poolMap = new Map();
  for (const r of rounds) {
    if (r.label === held.label) continue;
    if (POOL_SCOPE === "am" && !amRoundLabels.has(r.label)) continue;
    for (const [k, v] of roundBuckets.get(r.label)) {
      if (!poolMap.has(k)) poolMap.set(k, { am_work: [], am_weekend: [], day: [], pm: [], night: [], all: [] });
      const dst = poolMap.get(k);
      for (const b of ["am_work", "am_weekend", "day", "pm", "night", "all"]) dst[b].push(...(v[b] ?? []));
    }
  }
  const perKey = [];
  for (const [k, v] of holdMap) {
    if (v.am_work.length < MIN_HOLD) continue; // 留出集本身的 AM 中位数要站得住
    const actual = median(v.am_work);
    const pool = poolMap.get(k);
    if (!pool) continue;
    const preds = {};
    for (const [tag, sch] of Object.entries(schemes)) preds[tag] = sch.pick(pool);
    perKey.push({ k, nHold: v.am_work.length, actual, preds });
  }
  q3detail.push({ round: held.label, weekday: WD[held.weekday], window: held.win, keys: perKey.length, perKey });
}
/** 公平比较：只取「四方案都能预测」的键集合 */
const q3 = { rounds: q3detail.map((r) => ({ round: r.round, weekday: r.weekday, window: r.window, keys: r.keys })), perScheme: {}, coverage: {} };
for (const tag of Object.keys(schemes)) {
  const errs = [];
  for (const d of q3detail) for (const x of d.perKey) {
    const p = x.preds[tag];
    if (p) errs.push(Math.abs(p.v - x.actual));
  }
  q3.perScheme[tag] = { name: schemes[tag].name, n: errs.length, mae: r3(mean(errs)), p90: r3(pct(errs, 0.9)) };
}
{
  const errs = { A: [], B: [], C: [], D: [] };
  let common = 0;
  for (const d of q3detail) for (const x of d.perKey) {
    if (!x.preds.A || !x.preds.B || !x.preds.C || !x.preds.D) continue;
    common++;
    for (const tag of Object.keys(errs)) errs[tag].push(Math.abs(x.preds[tag].v - x.actual));
  }
  q3.common = { keys: common };
  for (const tag of Object.keys(errs)) {
    q3.common[tag] = { mae: r3(mean(errs[tag])), p90: r3(pct(errs[tag], 0.9)), n: errs[tag].length };
  }
}
/** A 方案的实际取材分布（真的用了 am_work 的比例） */
{
  const dist = {};
  for (const d of q3detail) for (const x of d.perKey) {
    const s = x.preds.A?.src ?? "none";
    dist[s] = (dist[s] ?? 0) + 1;
  }
  q3.aSourceMix = dist;
  const bySrc = {};
  for (const d of q3detail) for (const x of d.perKey) {
    const s = x.preds.A?.src ?? "none";
    if (!x.preds.A) continue;
    (bySrc[s] ??= []).push(Math.abs(x.preds.A.v - x.actual));
  }
  q3.aMaeBySrc = Object.fromEntries(Object.entries(bySrc).map(([k, v]) => [k, { n: v.length, mae: r3(mean(v)) }]));
}

/* ════════════ 8. Q4 采集时段偏差 ════════════ */
const wdCount = {};
for (const r of rounds) wdCount[WD[r.weekday]] = (wdCount[WD[r.weekday]] ?? 0) + 1;
const dateSet = new Set(rounds.map((r) => r.day));
const q4 = {
  rounds: rounds.length,
  dates: dateSet.size,
  weekdayRounds: wdCount,
  hourHist,
  hourPct: hourHist.map((n) => r3(n / allSamples.length)),
  bucketHist,
  morningRounds: amRounds.map((r) => ({ label: r.label, weekday: WD[r.weekday], window: r.win, nAm: roundBuckets.get(r.label) ? [...roundBuckets.get(r.label).values()].reduce((a, v) => a + v.am_work.length, 0) : 0 })),
  morningDates: [...new Set(amRounds.map((r) => r.day))],
};
/** 轮次时间窗是否互相重叠（重叠会让"同一次经过"被两轮各算一次）*/
const overlaps = [];
for (let i = 1; i < rounds.length; i++) {
  const prevEnd = Date.parse(rounds[i - 1].finishedAt), curStart = Date.parse(rounds[i].startedAt);
  if (curStart < prevEnd) overlaps.push([rounds[i - 1].label, rounds[i].label, (prevEnd - curStart) / 1000]);
}

/* ════════════ 9. 落盘 ════════════ */
const report = {
  generatedAt: new Date().toISOString(),
  variant: { excludeTerminal: EXCLUDE_TERMINAL, minHold: MIN_HOLD, pool: POOL_SCOPE },
  source: {
    roundsFound: all.length,
    roundsKept: rounds.length,
    roundsMissingDerived: missingDerived,
    excluded: excluded.map((r) => ({ label: r.label, why: r.why, startedAt: r.startedAt, durationMin: r.durationMin })),
    span: rounds.length ? { from: rounds[0].startedAt, to: rounds[rounds.length - 1].finishedAt } : null,
    overlapPairs: overlaps,
  },
  totals: {
    samples: allSamples.length,
    depart: rounds.reduce((a, r) => a + r.nDep, 0),
    terminal: rounds.reduce((a, r) => a + r.nTerm, 0),
    outliersRemoved: rounds.reduce((a, r) => a + r.nOutlier, 0),
    distinctKeys: keySet.size,
    distinctPairs: new Set(allSamples.map((s) => `${s.from}|${s.to}`)).size,
  },
  dateHour,
  perRound: rounds.map((r) => ({ label: r.label, weekday: WD[r.weekday], day: r.day, win: r.win, durationMin: r.durationMin, nDep: r.nDep, nTerm: r.nTerm, nOutlier: r.nOutlier, total: r.samples.length })),
  q1, q2, q3, q4,
};
writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");

/* ════════════ 10. 控制台摘要 ════════════ */
const lines = [];
lines.push(`轮次 ${all.length} → 保留 ${rounds.length}（排除 ${excluded.length}）· 派生缺失 ${missingDerived.length}`);
lines.push(`样本 ${allSamples.length}（depart ${report.totals.depart} / terminal ${report.totals.terminal}）· 剔除护栏 ${report.totals.outliersRemoved} · 唯一键 ${keySet.size}`);
lines.push(`窗口重叠 ${overlaps.length} 对`);
lines.push(`时段分布（含 0，共 24 小时）：${hourHist.map((n, h) => `${P(h)}=${n}`).join(" ")}`);
lines.push(`桶分布：${JSON.stringify(bucketHist)}`);
lines.push(`Q1 workday: ${JSON.stringify(q1.workday)}`);
lines.push(`Q1 weekend: ${JSON.stringify(q1.weekend)}`);
lines.push(`Q1 cmp: N5 ${JSON.stringify(q1.cmpN5)} | N10 ${JSON.stringify(q1.cmpN10)} | N20 ${JSON.stringify(q1.cmpN20)} | N30 ${JSON.stringify(q1.cmpN30)}`);
lines.push(`Q2: keys=${q2.keys} ratio p10=${q2.ratioP10} p50=${q2.ratioP50} p90=${q2.ratioP90} >1=${q2.shareGt1} >2=${q2.shareGt2} <0.5=${q2.shareLt05}`);
lines.push(`Q3 各方案（全键）: ${Object.entries(q3.perScheme).map(([t, v]) => `${t} n=${v.n} MAE=${v.mae} p90=${v.p90}`).join(" | ")}`);
lines.push(`Q3 共同键 ${q3.common.keys}: ${["A", "B", "C", "D"].map((t) => `${t} MAE=${q3.common[t].mae} p90=${q3.common[t].p90}`).join(" | ")}`);
lines.push(`Q3 A 取材分布: ${JSON.stringify(q3.aSourceMix)} · MAE by src ${JSON.stringify(q3.aMaeBySrc)}`);
lines.push(`Q4 轮次/日期 ${rounds.length}/${dateSet.size} · 星期 ${JSON.stringify(wdCount)}`);
lines.push(q4.morningRounds.length
  ? `Q4 早高峰轮次 ${q4.morningRounds.length}: ${q4.morningRounds.map((r) => `${r.label}(${r.weekday} ${r.window} n=${r.nAm})`).join(" · ")}`
  : "Q4 早高峰轮次 0: （没有任何轮次落在工作日 7–9 点——这本身是结论，不是无输出）");
console.log(lines.join("\n"));
console.log(`\n已写出 ${OUT}`);
