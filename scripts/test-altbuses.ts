/**
 * altBuses（后续班车）回填口径 · 回归断言（scripts/test-altbuses.ts，2026-09-24）
 *
 * 为什么有这个测试：用户两度反馈「卡底后续班车看不到了」——
 *   两次深查（代码链路 / 线上探针 / 引用一致性）均证明**功能正常**，
 *   空结果显示是「符合口径的时段性结果」（深夜单卡/邻车稀疏/卡片密集）。
 * ⇒ 用机器断言把口径钉死，任何未来改动**一旦破坏回填**立刻红灯。
 *
 * 口径（v1.1.5 用户拍板，勿改）：
 *   · 阈值 = **最后一张卡**的 totalMin（「坐这班后车，门到门总时长不差于最差一张卡」才列出）；
 *   · `totalMin ≤ 阈值 + 1e-9` 为**含等号**（临界值保留）；
 *   · 只有**进入前 N 张**的卡才回填（topSet 语义）；
 *   · 单卡 ⇒ 阈值 = 自身 ⇒ 后车（必然更晚）一律被滤 —— **这是口径，不是 bug**（敏感度见 09-18 验收）。
 *
 * 运行：npm run test:altbuses（= tsx scripts/test-altbuses.ts）
 */
import { backfillAltBuses } from "../src/lib/nav/nav-service";
import type { AltBusView, RecommendCard } from "../src/lib/recommend/types";

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

/** 造一张最小卡（只填回填逻辑会用到的字段） */
function mkCard(planId: number, totalMin: number): RecommendCard {
  return {
    planId,
    summary: "测试",
    fromSlug: "home",
    toSlug: "school",
    totalMin,
    arriveAt: Date.now() + totalMin * 60_000,
    walkOut: { minutes: 3, distanceM: 200, estimated: false, toLabel: "上车站" },
    rides: [
      {
        route: "51",
        board: "C690/1",
        alight: "T363/1",
        boardLabel: "C690 站",
        alightLabel: "T363 站",
        minutes: totalMin,
        waitMin: 2,
        kind: "bus",
        liveText: "",
        tier: 3,
        tierText: "常速",
        levels: [],
      },
    ],
    transfers: [],
    walkIn: { minutes: 4, distanceM: 300, estimated: false, toLabel: "澳科大" },
    hints: [],
    crossBorder: false,
  } as unknown as RecommendCard;
}

function mkAlt(route: string, totalMin: number, stopsAway = 3): AltBusView {
  return { route, stopsAway, waitText: "约 3~5 分", tier: 3, tierText: "常速", totalMin };
}

function modeledOf(card: RecommendCard, alts: AltBusView[]) {
  return [{ card, alts }] as { card: RecommendCard; alts: AltBusView[] }[];
}

console.log("altBuses 回填口径 · 回归断言\n");

// ── ① 两卡：阈值 = 第二张（33）—— 24 保留、40 滤掉 ──
{
  const c1 = mkCard(1, 20);
  const c2 = mkCard(2, 33);
  backfillAltBuses([c1, c2], [...modeledOf(c1, [mkAlt("51", 24), mkAlt("51", 40)]), ...modeledOf(c2, [mkAlt("51", 40)])]);
  assert((c1.altBuses?.length ?? 0) === 1, "两卡：卡1 的后车 24 分 ≤ 阈值 33 ⇒ 保留 1 条");
  assert(c1.altBuses?.[0]?.totalMin === 24, "两卡：保留的是 24 分那条");
  assert(c2.altBuses === undefined || c2.altBuses.length === 0, "两卡：卡2 的后车 40 分 > 33 ⇒ 不列");
}

// ── ② 单卡（阈值 = 自身）—— 后车必然更晚 ⇒ 一律滤掉（口径敏感度） ──
{
  const c1 = mkCard(1, 20);
  backfillAltBuses([c1], modeledOf(c1, [mkAlt("51", 21), mkAlt("51", 30)]));
  assert((c1.altBuses?.length ?? 0) === 0, "单卡：阈值=自身 20 ⇒ 21/30 分后车被滤（符合 09-18 验收口径）");
}

// ── ③ 临界值含等号（totalMin == 阈值）→ 保留 ──
{
  const c1 = mkCard(1, 20);
  const c2 = mkCard(2, 25);
  backfillAltBuses([c1, c2], modeledOf(c1, [mkAlt("51", 25)]));
  assert((c1.altBuses?.length ?? 0) === 1, "临界：后车 = 阈值（25）⇒ 含等号保留");
}

// ── ④ 非前 N 张的卡不回填（topSet 语义） ──
{
  const c1 = mkCard(1, 20);
  const c2 = mkCard(2, 25);
  const c3 = mkCard(3, 30); // 未进入榜单
  const m3 = modeledOf(c3, [mkAlt("51", 22)]);
  backfillAltBuses([c1, c2], [...modeledOf(c1, []), ...modeledOf(c2, []), ...m3]);
  assert(c3.altBuses === undefined, "榜单外卡片不回填（即使后车更优）");
}

// ── ⑤ 并行线 sibling 合并（按 route 分组、阈值同口径） ──
{
  const c1 = mkCard(1, 20);
  const c2 = mkCard(2, 34);
  // ★ sibling 合并的触发条件 = 卡首段的 parallelRoutes（与 nav-service 生成 siblings 的条件一致）
  (c1.rides[0] as { parallelRoutes?: string[] }).parallelRoutes = ["51A"];
  backfillAltBuses(
    [c1, c2],
    modeledOf(c1, [mkAlt("51", 24)]),
    [{ parentPlanId: 1, route: "51A", alts: [mkAlt("51A", 26), mkAlt("51A", 99)] }],
  );
  const routes = (c1.altBuses ?? []).map((a) => a.route).sort();
  assert(routes.join(",") === "51,51A", "sibling：51A 的合格后车（26）并入列表");
  assert(!(c1.altBuses ?? []).some((a) => a.totalMin === 99), "sibling：超阈值（99）仍被滤");
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
