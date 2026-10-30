/**
 * 换乘保守余量 · before/after 对比 + A1~A4 复核门（scripts/compare-slack-impact.ts，需求 7 · v3.6.1）
 *
 * ── 用途 ───────────────────────────────────────────────────────────────
 *   验证「巴士第 2 段补 `slackMin`（三档保守余量）」之后：
 *     A1 逐位相等（`totalMin` / 换乘数 / `walkMinutesOf` / 每段 ride.minutes / 每段 waitMin）
 *     A2 方案集不缩水
 *     A3 排序翻转可解释（三条同时满足）
 *     A4 `tight` 分布（新增 tight 全部来自巴士段；轻轨新增即红；同场换乘仍 `yes`）
 *   ＋ 档 ③（连 `headwayMedian` 都没有）的占比/线路分布/top3 翻转组数（供主控定 `SLACK_NO_DATA`）
 *
 * ── 为什么用「同一批卡 + 变体」而不是跑两遍代码 ─────────────────────────
 *   旧版与新版在**卡片内容上只差一个字段**：`transfers[i].slackMin`
 *   （旧版：第 2 段是巴士 ⇒ 恒 `null`；新版：三档保守余量）。
 *   `totalMin` 的构造路径（`cursor` 链）本次**未被触碰**。
 *   ⇒ `legacy = {...card, transfers:[… 巴士后继段 slackMin:null]}` 即**精确等于**旧版产物。
 *   ⚠️ 因此 A1 是**结构性断言**（不是重跑对比）：它的价值是「将来谁改了顺延逻辑/字段
 *      拷贝，deep-diff 立刻红」，而不是「本次证明」。这一点在报告里已如实写明。
 *   ⚠️ A2 同理：`slackMin` 只被 `costOf` 与 H8 读取，不参与任何剔除路径 ⇒ 方案集不可能缩水。
 *
 * ── 只读保证 ───────────────────────────────────────────────────────────
 *   只 SELECT（`loadStatics` / `loadHeadway` / `fetchLive`）；外部只有 DSAT GET。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────
 *   node node_modules/tsx/dist/cli.mjs scripts/compare-slack-impact.ts
 *   node … --limit=3 --no-chain
 */
import { Pool } from "pg";
import { nowBucketOfHolidayAware } from "../src/lib/rebuild/holidays";
import type { HeadwayIndex } from "../src/lib/recommend/headway";
import { loadHeadway } from "../src/lib/recommend/headway";
import { fetchLive } from "../src/lib/recommend/live";
import { modelOption } from "../src/lib/recommend/model";
import { contextFor, loadStatics, optionsFor, type RecStatic } from "../src/lib/recommend/query";
import { PREF_ALPHA, PREF_BETA, PREF_DEFAULTS, TRANSFER_SAFETY_MIN, costOf, walkMinutesOf } from "../src/lib/recommend/score";
import { slackTierSink, type SlackTierSample } from "../src/lib/recommend/transfer-slack";
import type { OptionSeed, RecommendCard } from "../src/lib/recommend/types";
import type { WalkResolver } from "../src/lib/nav/types";

process.loadEnvFile("D:/Projects/University/Studio/musttoukou/.env");

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (n: string) => {
  const h = argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : undefined;
};
const LIMIT = Number(val("limit") ?? "3") || 3;
const CHAIN_MAX = Number(val("chains") ?? "24") || 24;

const u = new URL(process.env.DATABASE_URL!);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ssl: { rejectUnauthorized: false },
});

const f1 = (x: number) => Math.round(x * 10) / 10;
const R = (s: string) => `《${s}》`;
const head = (s: string) => console.log(`\n${"═".repeat(78)}\n${s}\n${"═".repeat(78)}`);
const mainOf = (c: string) => /^[A-Za-z]+\d+/.exec(String(c ?? ""))?.[0] ?? String(c ?? "");

/** 全部 active OD（本项目只有 4 个地点 → 6 对；覆盖 ①②③④⑥；⑤由站链级覆盖） */
const ODS: { from: string; to: string; tags: string[] }[] = [
  { from: "home", to: "school", tags: ["①有直达"] },
  { from: "school", to: "home", tags: ["①有直达", "②必须换乘"] },
  { from: "home", to: "gate", tags: ["③跨海 氹仔→半岛", "④关闸↔路氹"] },
  { from: "gate", to: "home", tags: ["③跨海 半岛→氹仔", "④关闸↔路氹"] },
  { from: "home", to: "hengqin", tags: ["⑥不换乘无解"] },
  { from: "hengqin", to: "home", tags: ["⑥不换乘无解"] },
];

/* ── 变体与派生量 ───────────────────────────────────────────────────── */

/** 旧版等价卡：**第 2 段是巴士**的换乘 ⇒ `slackMin = null`（其余一字不动） */
function legacyOf(card: RecommendCard): RecommendCard {
  return {
    ...card,
    transfers: card.transfers.map((t, i) =>
      card.rides[i + 1]?.kind === "bus" ? { ...t, slackMin: null } : t,
    ),
  };
}

/** 与 `RecommendCard.tsx#transferFeasibleOf` 同源（宽松等号，取最差） */
function feasibleOf(slackMin: number | null | undefined): "yes" | "tight" | "no" {
  if (slackMin == null) return "yes";
  return slackMin < 0 ? "no" : slackMin < TRANSFER_SAFETY_MIN ? "tight" : "yes";
}
/**
 * 卡片级「最差换乘可行度」（三档取最差）。
 * ⚠️ 当前**无任何调用点** —— 脚本里真正在用的是逐段的 `feasibleOf`（见下方 H8 对比段）。
 *    保留是因为它与 `RecommendCard.tsx#transferFeasibleOf` 同源，将来若要做「卡片级」汇总可直接复用。
 *    加 `_` 前缀表示「有意保留不使用」，不是漏接。
 */
const _cardFeasible = (c: RecommendCard) => {
  let worst: "yes" | "tight" | "no" = "yes";
  for (const t of c.transfers) {
    const v = feasibleOf(t.slackMin);
    if (v === "no") return "no";
    if (v === "tight") worst = "tight";
  }
  return worst;
};

/** risk 分量（与 `costOf` 同源；用来做 A3 的「差额只由 risk 解释」） */
function riskOf(card: RecommendCard, p = PREF_DEFAULTS.balanced): number {
  let r = 0;
  for (const t of card.transfers)
    if (t.slackMin != null) r += p.riskFactor * Math.max(0, p.safetyMin - t.slackMin);
  return r;
}

/* ── 累计器 ─────────────────────────────────────────────────────────── */
interface Acc {
  cards: number;
  groups: number;
  busCards: number;
  lrtCards: number;
  // A1
  a1Checked: number;
  a1Bad: number;
  // A2
  a2Checked: number;
  a2Bad: number;
  // A3
  a3GroupsTop1Changed: number;
  a3C1Bad: number;
  a3C2Bad: number;
  a3C3Bad: number;
  a3FlipDirection: string[];
  /** 组内任意两卡相对次序翻转（top1 不变也可能内部换位） */
  pairFlips: number;
  pairFlipSamples: string[];
  // A4
  tightBefore: number;
  tightAfter: number;
  newTightBus: number;
  newTightLrt: number;
  lrtTightBefore: number;
  lrtTightAfter: number;
  sameFieldNotYes: number;
  // 档位
  tier: Record<SlackTierSample["tier"], number>;
  tierNoDataRoute: Map<string, number>;
  tierNoDataRoutes: Set<string>;
  // 档③ 若判 yes（null）时的 top3 翻转
  tier3FlipGroups: number;
  tier3GroupsWithNoData: number;
  lines: string[];
}
const acc: Acc = {
  cards: 0,
  groups: 0,
  busCards: 0,
  lrtCards: 0,
  a1Checked: 0,
  a1Bad: 0,
  a2Checked: 0,
  a2Bad: 0,
  a3GroupsTop1Changed: 0,
  a3C1Bad: 0,
  a3C2Bad: 0,
  a3C3Bad: 0,
  a3FlipDirection: [],
  pairFlips: 0,
  pairFlipSamples: [],
  tightBefore: 0,
  tightAfter: 0,
  newTightBus: 0,
  newTightLrt: 0,
  lrtTightBefore: 0,
  lrtTightAfter: 0,
  sameFieldNotYes: 0,
  tier: { hit: 0, median: 0, noData: 0, sameField: 0 },
  tierNoDataRoute: new Map(),
  tierNoDataRoutes: new Set(),
  tier3FlipGroups: 0,
  tier3GroupsWithNoData: 0,
  lines: [],
};

const tag = (m: string) => (m === "bus" ? "bus" : m === "lrt" ? "lrt" : "?");

/** A1：五个字段族逐位相等（不设容差） */
function a1Check(card: RecommendCard): void {
  const lg = legacyOf(card);
  acc.a1Checked++;
  const bad: string[] = [];
  if (card.totalMin !== lg.totalMin) bad.push(`totalMin ${card.totalMin}≠${lg.totalMin}`);
  if (card.transfers.length !== lg.transfers.length) bad.push("transfers.length");
  if (walkMinutesOf(card) !== walkMinutesOf(lg)) bad.push("walkMinutesOf");
  for (let i = 0; i < card.rides.length; i++) {
    if (card.rides[i].minutes !== lg.rides[i].minutes) bad.push(`rides[${i}].minutes`);
    if ((card.rides[i].waitMin ?? null) !== (lg.rides[i].waitMin ?? null)) bad.push(`rides[${i}].waitMin`);
  }
  for (let i = 0; i < card.transfers.length; i++)
    if (card.transfers[i].minutes !== lg.transfers[i].minutes) bad.push(`transfers[${i}].minutes`);
  // A3 条件 3：cost 差必须**完全**由 risk 差解释
  const dCost = costOf(card) - costOf(lg);
  const dRisk = riskOf(card) - riskOf(lg);
  if (Math.abs(dCost - dRisk) > 1e-9) {
    acc.a3C3Bad++;
    bad.push(`dCost(${dCost.toFixed(3)}) ≠ dRisk(${dRisk.toFixed(3)})`);
  }
  if (bad.length) {
    acc.a1Bad++;
    if (acc.a1Bad <= 3) console.log(`    ✗ A1 ${card.rides.map((r) => r.route).join("→")}: ${bad.slice(0, 4).join(", ")}`);
  }
}

/** A4：逐换乘分类（新增 tight 必须来自巴士段） */
function a4Check(card: RecommendCard): void {
  const lg = legacyOf(card);
  for (let i = 0; i < card.transfers.length; i++) {
    const after = feasibleOf(card.transfers[i].slackMin);
    const before = feasibleOf(lg.transfers[i].slackMin);
    const nextKind = tag(card.rides[i + 1]?.kind ?? "?");
    if (before === "tight") acc.tightBefore++;
    if (after === "tight") acc.tightAfter++;
    if (nextKind === "lrt") {
      if (before === "tight") acc.lrtTightBefore++;
      if (after === "tight") acc.lrtTightAfter++;
    }
    if (after === "tight" && before !== "tight") {
      if (nextKind === "bus") acc.newTightBus++;
      else acc.newTightLrt++;
    }
    /**
     * 同场换乘的显式映射断言：**巴士**后继段的同场换乘必须保持 `undefined`（⇒ H8 = yes）。
     * （轻轨同场换乘仍写真实 `gapMin`，属既有线上行为，不在本断言范围。）
     */
    if (card.transfers[i].sameField && nextKind === "bus") {
      if (card.transfers[i].slackMin !== undefined) acc.sameFieldNotYes++;
      else if (after !== "yes") acc.sameFieldNotYes++;
    }
  }
}

/** 一批卡的 before/after（含 A1/A2/A3/A4），累加进 acc */
function compareBatch(label: string, cards: RecommendCard[], tiers: SlackTierSample[]): void {
  if (!cards.length) {
    acc.lines.push(`\n${label} —— 本时刻无可行卡（实时层剔除），跳过`);
    return;
  }
  acc.groups++;
  acc.cards += cards.length;
  acc.a2Checked++;

  const costNew = new Map(cards.map((c) => [c, costOf(c)]));
  const costOld = new Map(cards.map((c) => [c, costOf(legacyOf(c))]));
  const rankNew = [...cards].sort((a, b) => costNew.get(a)! - costNew.get(b)!);
  const rankOld = [...cards].sort((a, b) => costOld.get(a)! - costOld.get(b)!);

  for (const c of cards) {
    if (c.transfers.some((_, i) => c.rides[i + 1]?.kind === "bus")) acc.busCards++;
    if (c.transfers.some((_, i) => c.rides[i + 1]?.kind === "lrt")) acc.lrtCards++;
    a1Check(c);
    a4Check(c);
  }

  /**
   * A2：方案集不缩水。
   * ⚠️ 结构性事实：`slackMin` 只被 `costOf`（排序）与 H8（展示）读取，**不参与任何剔除路径**
   *   （`ctx.excluded` / `ctx.missed` 的判定都在赋值 `slackMin` 之前完成）⇒ 方案集不可能缩水。
   *   这里能机器验的是「排序没有丢卡」：两套 cost 的排序结果必须是同一集合的排列。
   */
  if (rankNew.length !== cards.length || rankOld.length !== cards.length) acc.a2Bad++;
  if (new Set(rankNew).size !== cards.length || new Set(rankOld).size !== cards.length) acc.a2Bad++;

  // A3：top1 变化时三条同时满足
  const nTop = rankNew[0];
  const oTop = rankOld[0];
  if (nTop !== oTop) {
    acc.a3GroupsTop1Changed++;
    // ① 用新规则复算：新 top1 严格更优
    if (!(costNew.get(nTop)! < costNew.get(oTop)!)) acc.a3C1Bad++;
    // ② 为稳定付出的分钟数 ≤ 为旧赢家买到的风险分
    const dMin = nTop.totalMin - oTop.totalMin;
    const dRiskOld = riskOf(oTop) - riskOf(legacyOf(oTop));
    if (!(dMin <= dRiskOld + 1e-9)) acc.a3C2Bad++;
    // 方向：新 top1 的 risk 是否更低（更确定）+ 旧 top1 是否仍可行
    acc.a3FlipDirection.push(
      `${oTop.rides.map((r) => r.route).join("→")}(T=${f1(oTop.totalMin)},risk+${dRiskOld.toFixed(2)})` +
        ` → ${nTop.rides.map((r) => r.route).join("→")}(T=${f1(nTop.totalMin)},risk ${riskOf(nTop).toFixed(2)})`,
    );
  }
  // A3 补充：组内任意两卡的相对次序翻转对数（top1 不变也可能内部换位）
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) {
      const o = Math.sign(costOld.get(cards[i])! - costOld.get(cards[j])!);
      const n = Math.sign(costNew.get(cards[i])! - costNew.get(cards[j])!);
      if (o !== 0 && n !== 0 && o !== n) {
        acc.pairFlips++;
        if (acc.pairFlipSamples.length < 5)
          acc.pairFlipSamples.push(
            `${cards[j].rides.map((r) => r.route).join("→")}(T=${f1(cards[j].totalMin)},risk ${riskOf(cards[j]).toFixed(2)})` +
              ` 反超 ${cards[i].rides.map((r) => r.route).join("→")}(T=${f1(cards[i].totalMin)},risk ${riskOf(cards[i]).toFixed(2)})`,
          );
      }
    }

  // 档③ 若改判 yes(null) 会不会改 top3 —— **上界估计**（见下方说明）
  if (tiers.some((t) => t.tier === "noData")) {
    acc.tier3GroupsWithNoData++;
    /**
     * 说明：sink 样本不带卡片身份，无法精确回指「哪些 transfer 是档③」。这里取**上界**：
     * 把所有 `slackMin === 0` 的巴士换乘都当成档③并改判 `null`（= yes）。
     * 若这种"最坏情况"下 top3 都不变，则档③ 的真实取值对排序一定无影响。
     */
    const nullify = (c: RecommendCard): RecommendCard => ({
      ...c,
      transfers: c.transfers.map((t, i) =>
        c.rides[i + 1]?.kind === "bus" && t.slackMin === 0 ? { ...t, slackMin: null } : t,
      ),
    });
    const alt = [...cards].sort((a, b) => costOf(nullify(a)) - costOf(nullify(b))).slice(0, 3);
    const cur = rankNew.slice(0, 3);
    if (alt.some((c, i) => c !== cur[i])) acc.tier3FlipGroups++;
  }

  // 展示 top N
  const desc = (c: RecommendCard) => {
    const sl = c.transfers.map((t) => (t.slackMin == null ? "—" : f1(t.slackMin))).join(",") || "—";
    return `${c.rides.map((r) => (r.kind === "lrt" ? "轻" : r.route)).join("→")} T=${f1(c.totalMin)} slack=[${sl}]`;
  };
  const rows: string[] = [];
  for (let k = 0; k < Math.min(LIMIT, cards.length); k++) {
    const a = rankNew[k];
    const b = rankOld[k];
    rows.push(
      `  #${k + 1} before(cost ${f1(costOld.get(b)!)}) ${desc(b)}\n` +
        `      after (cost ${f1(costNew.get(a)!)}) ${desc(a)}` +
        (a === b ? "   ← 名次不变" : "   ⚠️ 名次互换"),
    );
  }
  acc.lines.push(`\n${label}   候选卡 ${cards.length} 张\n${rows.join("\n")}`);

  /**
   * 追加「非-同场换乘」子集视图：同场换乘按契约不写 slack（恒 yes），
   * 若只看整组 top3 会被同场卡挤满 ⇒ 看不到风险项的真实作用。子集表才看得出翻转。
   */
  const walkCards = cards.filter((c) => c.transfers.some((t) => !t.sameField));
  if (walkCards.length && walkCards.length < cards.length) {
    const wNew = [...walkCards].sort((a, b) => costNew.get(a)! - costNew.get(b)!);
    const wOld = [...walkCards].sort((a, b) => costOld.get(a)! - costOld.get(b)!);
    const wRows: string[] = [];
    for (let k = 0; k < Math.min(LIMIT, walkCards.length); k++) {
      const a = wNew[k];
      const b = wOld[k];
      wRows.push(
        `  #${k + 1} before ${desc(b)} (cost ${f1(costOld.get(b)!)})` +
          `\n      after  ${desc(a)} (cost ${f1(costNew.get(a)!)})` +
          (a === b ? "   ← 名次不变" : "   ⚠️ 名次互换"),
      );
    }
    acc.lines.push(`  ── 其中「非-同场换乘」子集 ${walkCards.length} 张 ──\n${wRows.join("\n")}`);
  }
}

/**
 * 站链级种子：真实站序里的「巴士→巴士」换乘链（OD 由脚本指定）。
 *
 * 每对线路出**两条**，缺一不可：
 * · `@hub`   —— 同站台换乘（`sameField=true`）：验「同场换乘必须保持 undefined ⇒ H8 yes」；
 * · `@hub~walk` —— B 在**相邻的另一个站**上车（`sameField=false`，走 `transfer_walks`/兜底 3 分）：
 *   这才是能让巴士保守余量真正生效、验 A3/A4 的样本（同站台那批按契约不写 slack）。
 */
function chainSeeds(st: RecStatic, max: number): OptionSeed[] {
  const busDirs: { route: string; dir: string; stops: string[] }[] = [];
  for (const [k, stops] of st.routeIdx.dirStops) {
    const [route, dir] = k.split("|");
    if (!route || route.startsWith("LRT-") || !dir) continue;
    if (stops.length >= 8) busDirs.push({ route, dir, stops });
  }
  const at = new Map<string, { r: string; d: string; i: number }[]>();
  for (const b of busDirs)
    b.stops.forEach((code, i) => {
      const m = mainOf(code);
      const list = at.get(m) ?? [];
      list.push({ r: b.route, d: b.dir, i });
      at.set(m, list);
    });
  const hubs = [...at.entries()]
    .filter(([, l]) => new Set(l.map((x) => x.r)).size >= 4)
    .sort((a, b) => new Set(b[1].map((x) => x.r)).size - new Set(a[1].map((x) => x.r)).size);
  const LEG = 4;
  const out: OptionSeed[] = [];
  const seen = new Set<string>();
  const push = (a: { r: string; d: string; i: number }, b: { r: string; d: string; i: number }, hub: string, walk: boolean) => {
    const sa = busDirs.find((x) => x.route === a.r && x.dir === a.d)!.stops;
    const sb = busDirs.find((x) => x.route === b.r && x.dir === b.d)!.stops;
    const boardA = a.i - LEG;
    const bStart = walk ? b.i + 1 : b.i; // walk 变体：B 在 hub 的**下一站**上车
    const alightB = bStart + LEG;
    if (boardA < 0 || bStart >= sb.length || alightB >= sb.length) return;
    const hopsA: [string, string][] = [];
    for (let k = boardA; k < a.i; k++) hopsA.push([sa[k], sa[k + 1]]);
    const hopsB: [string, string][] = [];
    for (let k = bStart; k < alightB; k++) hopsB.push([sb[k], sb[k + 1]]);
    if (!hopsA.length || !hopsB.length) return;
    const key = `${a.r}>${b.r}@${hub}${walk ? "~walk" : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      planId: 950_000 + out.length,
      summary: `链 ${a.r}→${b.r} @ ${hub}${walk ? "（步行换乘）" : ""}`,
      fromSlug: "chain-from",
      toSlug: "chain-to",
      crossBorder: false,
      segments: [
        { route: a.r, kind: "bus", board: sa[boardA], alight: sa[a.i], hops: hopsA },
        { route: b.r, kind: "bus", board: sb[bStart], alight: sb[alightB], hops: hopsB },
      ],
      transfers: [{ at: sa[a.i], to: sb[bStart], sameField: !walk }],
      key,
    });
  };
  for (const [hub, list] of hubs) {
    for (const a of list)
      for (const b of list) {
        if (a.r === b.r || a.i < LEG) continue;
        const sb = busDirs.find((x) => x.route === b.r && x.dir === b.d)?.stops;
        if (!sb || b.i + LEG + 1 >= sb.length) continue;
        push(a, b, hub, false); // 同站台
        push(a, b, hub, true); // 相邻站（步行换乘）
        if (out.length >= max) return out;
      }
  }
  return out;
}

/** 站链级专用：固定首末步行（3 分 / 3 分），几何无关（本测试只关心换乘段） */
const FIXED_WALK: WalkResolver = {
  out: () => ({ minutes: 3, distanceM: 250, toLabel: "上车站", source: "fallback", estimated: true, samples: 0 }),
  in: () => ({ minutes: 3, distanceM: 250, toLabel: "目的地", source: "fallback", estimated: true, samples: 0 }),
};

(async () => {
  const nowMs = Date.now();
  const st = await loadStatics(pool);
  const headway: HeadwayIndex = await loadHeadway(pool);
  const nowBucket = await nowBucketOfHolidayAware(pool, nowMs);
  console.log(`对比时刻 ${new Date(nowMs + 8 * 3600e3).toISOString().replace("Z", " +08")}  查询桶=${nowBucket}`);
  console.log("before：巴士第2段 slackMin=null（无风险项） | after：三档 clamp→max(0,2lo−hi) / 0 / SLACK_NO_DATA");
  console.log(`常量：α=${PREF_ALPHA} β=${PREF_BETA} safety=${TRANSFER_SAFETY_MIN} riskFactor=${PREF_DEFAULTS.balanced.riskFactor}`);

  const live = async (seeds: OptionSeed[], hw: HeadwayIndex | undefined) =>
    fetchLive(pool, seeds, st.routeIdx, st.segIdx, { nowBucket, nowMs, lrtPre: st.lrtPre, headway: hw });

  /** 跑一批 seeds，同时收集档位样本 */
  const runSeeds = async (seeds: OptionSeed[], walkResolver?: WalkResolver) => {
    const batch = await live(seeds, headway);
    const ctx = { ...contextFor(st, nowMs, null, batch.live, nowBucket), headway, walkResolver };
    const tiers: SlackTierSample[] = [];
    slackTierSink.on = (s) => tiers.push(s);
    const cards: RecommendCard[] = [];
    try {
      for (const seed of seeds) {
        const m = modelOption(seed, ctx);
        if (m) cards.push(m.card);
      }
    } finally {
      slackTierSink.on = undefined;
    }
    return { cards, tiers };
  };

  /* ── A. OD 级 ── */
  if (!has("--no-od")) {
    for (const od of ODS) {
      const seeds = optionsFor(st, od.from, od.to);
      if (!seeds.length) {
        acc.lines.push(`\n${R(`${od.from}→${od.to}`)} —— 无方案种子，跳过`);
        continue;
      }
      const { cards, tiers } = await runSeeds(seeds);
      for (const t of tiers) {
        acc.tier[t.tier]++;
        if (t.tier === "noData") {
          acc.tierNoDataRoute.set(t.route, (acc.tierNoDataRoute.get(t.route) ?? 0) + 1);
          acc.tierNoDataRoutes.add(t.route);
        }
      }
      compareBatch(`${R(`${od.from}→${od.to}`)}  ${od.tags.join(" · ")}`, cards, tiers);
    }
  }

  /* ── B. 站链级（巴士→巴士，真实站序）── */
  const chainInfo = { seeds: 0, cards: 0 };
  if (!has("--no-chain")) {
    const seeds = chainSeeds(st, CHAIN_MAX);
    chainInfo.seeds = seeds.length;
    if (seeds.length) {
      const { cards, tiers } = await runSeeds(seeds, FIXED_WALK);
      chainInfo.cards = cards.length;
      for (const t of tiers) {
        acc.tier[t.tier]++;
        if (t.tier === "noData") {
          acc.tierNoDataRoute.set(t.route, (acc.tierNoDataRoute.get(t.route) ?? 0) + 1);
          acc.tierNoDataRoutes.add(t.route);
        }
      }
      compareBatch(`《站链级 · 巴士→巴士 同站台》  构造 ${seeds.length} 条链`, cards, tiers);
    }
  }

  /* ── A-补充：系统级降级（ctx.headway 未加载）时档③占比 + 0 vs null 的排序影响 ── */
  const degrA = { transfers: 0, nonSame: 0, noData: 0, flip0vsNull: 0, top3a: "", top3b: "" };
  if (!has("--no-chain") && chainInfo.seeds) {
    const seeds = chainSeeds(st, CHAIN_MAX);
    // 实时层照常注入 headway（否则会连锁漏掉「未发车估算」→ 卡片集合都变了）；
    // **只把 ctx.headway 置空** —— 这才是「整表未加载」在模型侧的真实形态。
    const batch = await live(seeds, headway);
    const ctx = { ...contextFor(st, nowMs, null, batch.live, nowBucket), headway: undefined, walkResolver: FIXED_WALK };
    const tiers: SlackTierSample[] = [];
    slackTierSink.on = (s) => tiers.push(s);
    const cards: RecommendCard[] = [];
    try {
      for (const seed of seeds) {
        const m = modelOption(seed, ctx);
        if (m) cards.push(m.card);
      }
    } finally {
      slackTierSink.on = undefined;
    }
    degrA.transfers = tiers.length;
    degrA.nonSame = tiers.filter((t) => t.tier !== "sameField").length;
    degrA.noData = tiers.filter((t) => t.tier === "noData").length;
    // 档③ 取 0（现状）vs 取 null（改判 yes）在本状态下的 top3 差异
    if (cards.length) {
      const asNull = (c: RecommendCard): RecommendCard => ({
        ...c,
        transfers: c.transfers.map((t, i) =>
          c.rides[i + 1]?.kind === "bus" && t.slackMin === 0 ? { ...t, slackMin: null } : t,
        ),
      });
      const r0 = [...cards].sort((a, b) => costOf(a) - costOf(b)).slice(0, 3);
      const rN = [...cards].sort((a, b) => costOf(asNull(a)) - costOf(asNull(b))).slice(0, 3);
      degrA.flip0vsNull = r0.filter((c, i) => c !== rN[i]).length;
      const key = (c: RecommendCard) => c.rides.map((r) => r.route).join("→");
      degrA.top3a = r0.map(key).join(" / ");
      degrA.top3b = rN.map(key).join(" / ");
    }
  }

  /* ── 输出 ── */
  head("A1 逐位相等（totalMin / 换乘数 / walkMinutesOf / 每段 minutes+waitMin / transfers.minutes）");
  console.log(
    `  检查 ${acc.a1Checked} 张卡 · 违例 ${acc.a1Bad} · cost−totalMin 差 ≠ risk 差的卡 ${acc.a3C3Bad}`,
  );
  console.log(`  ⇒ A1 ${acc.a1Bad === 0 && acc.a3C3Bad === 0 ? "PASS" : "FAIL"}`);

  head("A2 方案集不缩水");
  console.log(`  批次 ${acc.a2Checked} · 键集合不一致 ${acc.a2Bad} ⇒ A2 ${acc.a2Bad === 0 ? "PASS" : "FAIL"}`);

  head("A3 排序翻转可解释");
  console.log(`  top1 变化组数 ${acc.a3GroupsTop1Changed} · 组内任意两卡相对次序翻转 ${acc.pairFlips} 对`);
  console.log(`  ① 新 top1 在新规则下严格更优：违例 ${acc.a3C1Bad}`);
  console.log(`  ② 多花分钟数 ≤ 旧赢家买到的风险分：违例 ${acc.a3C2Bad}`);
  console.log(`  ③ 差额完全由 risk 解释：违例 ${acc.a3C3Bad}`);
  for (const d of acc.a3FlipDirection) console.log(`   · top1: ${d}`);
  for (const d of acc.pairFlipSamples) console.log(`   · 内部换位: ${d}`);
  console.log(
    `  ⇒ A3 ${acc.a3C1Bad === 0 && acc.a3C2Bad === 0 && acc.a3C3Bad === 0 ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  （top1 未变时 ①②③ 空跑；真正的效应看「内部换位」与下方子集表）`,
  );

  head("A4 tight 分布");
  console.log(`  tight 换乘点：before ${acc.tightBefore} → after ${acc.tightAfter}`);
  console.log(`  新增 tight：来自巴士段 ${acc.newTightBus} · 来自轻轨段 ${acc.newTightLrt}（后者必须 = 0）`);
  console.log(`  轻轨换乘 tight：before ${acc.lrtTightBefore} → after ${acc.lrtTightAfter}（不得增加）`);
  console.log(`  同场换乘被判非 yes 的点：${acc.sameFieldNotYes}（必须 = 0）`);
  console.log(
    `  ⇒ A4 ${acc.newTightLrt === 0 && acc.lrtTightAfter <= acc.lrtTightBefore && acc.sameFieldNotYes === 0 ? "PASS" : "FAIL"}`,
  );

  head("档 ③（连 headwayMedian 都没有）测量");
  const tot = acc.tier.hit + acc.tier.median + acc.tier.noData + acc.tier.sameField;
  /** 分母只用「真正需要算余量的换乘点」—— 同场换乘按契约不写 slack，不能混进占比 */
  const nonSame = tot - acc.tier.sameField;
  const pct = (n: number, d = nonSame) => (d ? ((n / d) * 100).toFixed(2) + "%" : "—");
  console.log(
    `  巴士段换乘点 ${tot} 个（其中同场换乘 ${acc.tier.sameField} 个，按契约不写 slack ⇒ 不进占比分母）`,
  );
  console.log(
    `  非-同场 ${nonSame} 个：档①命中 ${acc.tier.hit} · 档②中位数 ${acc.tier.median} · 档③无数据 ${acc.tier.noData}`,
  );
  console.log(`  【B】真数据缺失（headway 有值、无命中、且无中位数）：${acc.tier.noData} / ${nonSame} = ${pct(acc.tier.noData)}`);
  console.log(
    `  【A】系统级降级（ctx.headway 整表未加载）：${degrA.noData} / ${degrA.nonSame} = ${pct(degrA.noData, degrA.nonSame)}`,
  );
  console.log(
    `      该状态下 档③取 0 vs 取 null 的 top3 差异：${degrA.flip0vsNull} 名` +
      (degrA.top3a ? `\n      取0   → ${degrA.top3a}\n      取null→ ${degrA.top3b}` : ""),
  );
  console.log(
    "      注：该状态同时让 waitBusMin=null（等车不计入 totalMin）⇒ totalMin 本身已失真，" +
      "风险罚不是这里的主要问题",
  );
  if (acc.tierNoDataRoute.size) {
    const rows = [...acc.tierNoDataRoute.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`  按线路分布（${rows.length} 条线）：${rows.map(([r, n]) => `${r}×${n}`).join("  ")}`);
  } else {
    console.log("  按线路分布：空 —— 档③在本批样本中一次都未命中（B = 0）");
  }
  console.log(
    `  档③ 若改判 yes(null)（**上界估计**：把所有 slack==0 的巴士换乘都当档③）：` +
      `含档③组 ${acc.tier3GroupsWithNoData} · top3 翻转组数 ${acc.tier3FlipGroups}`,
  );

  head("top 对比（before = 旧规则 / after = 新规则）");
  for (const l of acc.lines) console.log(l);

  await pool.end();
})().catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
