/**
 * switch-plans 组内 top-K（siblings）口径 · 回归断言（scripts/test-siblings.ts，2026-09-25）
 *
 * 为什么有这个测试：v2.14.0 §3.4 把「本站台其他线路」折叠区改成「线路为父、方案为子」——
 *   每个父线路（＝首程线路）下挂 top-K（K=3）条走法：top-1 = 主卡 `card`，其余 = `siblings`。
 *   这套「排序 / 去重 / 截断 / 省略」是**纯口径逻辑**，写错不报错、只悄悄算错（沉默逻辑错误）⇒
 *   用机器断言钉死，任何未来改动一旦破坏立刻红灯。
 *
 * 口径（07 §3.4，勿改）：
 *   · 组内按 `totalMin` **升序**（**直达 / 换乘混排**，不按「直达优先」）；
 *   · 去重键 = `chainRoutes.join(">") + "@" + alightMain`，同键保留 `totalMin` 最小者；
 *   · 与主卡同键的兄弟剔除；每组 top-K（`SIBLING_TOP_K` = 3）；
 *   · `siblings` 空（该组仅 1 条走法）时**不返回该键**（＝不下发，向后兼容）。
 *
 * 运行：npm run test:siblings（= tsx scripts/test-siblings.ts）
 */
import {
  SIBLING_TOP_K,
  dedupKeyOf,
  splitPlanCards,
} from "../src/lib/nav/switch-plans-shared";
import type { RecommendCard } from "../src/lib/recommend/types";

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

/**
 * 造一张最小卡（只填 top-K 逻辑会用到的字段）。
 * @param chain       乘车段线路链（如 `["25","26A"]` ⇒ `chainRoutes` = `"25>26A"`）
 * @param alightMain  末程下车站码（`mainCodeOf` 归一后所得即去重键的 alightMain 部分）
 */
function mkCard(planId: number, totalMin: number, chain: string[], alightMain = "M99/1"): RecommendCard {
  const rides = chain.map((route, i) => ({
    route,
    kind: "bus",
    board: i === 0 ? "M1/1" : "T10/1",
    alight: i === chain.length - 1 ? alightMain : "T10/1",
    boardLabel: "上车站",
    alightLabel: "下车站",
    minutes: totalMin,
    hops: 1,
  }));
  return { planId, totalMin, rides } as unknown as RecommendCard;
}

console.log("switch-plans 组内 top-K（siblings）口径 · 回归断言\n");

// ── ① 常量 ──
assert(SIBLING_TOP_K === 3, "SIBLING_TOP_K = 3");

// ── ② 去重键 = chainRoutes.join('>') + '@' + alightMain ──
assert(dedupKeyOf(mkCard(1, 10, ["25", "26A"], "M9/1")) === "25>26A@M9", "dedupKeyOf：chainRoutes@alightMain");
assert(dedupKeyOf(mkCard(1, 10, ["25"], "C690/3")) === "25@C690", "dedupKeyOf：站台码归一为主码（C690/3 → C690）");

// ── ③ 组内按 totalMin 升序（主卡 = 最小，兄弟升序） ──
{
  const r = splitPlanCards([
    mkCard(1, 30, ["25"], "M1/1"),
    mkCard(2, 10, ["25"], "M2/1"),
    mkCard(3, 20, ["25"], "M3/1"),
  ]);
  assert(r.card.totalMin === 10, "升序：主卡 = 组内最小（10）");
  assert((r.siblings ?? []).map((s) => s.totalMin).join(",") === "20,30", "升序：兄弟 20 → 30");
}

// ── ④ 直达 / 换乘混排（不按「直达优先」） ──
{
  const transfer = mkCard(1, 15, ["25", "26A"], "M2/1"); // 换乘，但更快
  const direct = mkCard(2, 20, ["25"], "M1/1"); // 直达，但更慢
  const r = splitPlanCards([direct, transfer]);
  assert(r.card.totalMin === 15 && r.card.rides.length === 2, "混排：换乘(15) 快 ⇒ 排直达(20) 之前、作主卡");
  assert((r.siblings ?? [])[0]?.totalMin === 20 && r.siblings?.[0]?.rides.length === 1, "混排：直达(20) 作兄弟，未被『直达优先』提前");
}

// ── ⑤ 去重键同键留最小 ──
{
  const big = mkCard(1, 12, ["25"], "M1/1");
  const small = mkCard(2, 8, ["25"], "M1/1"); // 同 chainRoutes "25" + 同 alightMain "M1"
  const r = splitPlanCards([big, small]);
  assert(r.card.planId === 2 && r.card.totalMin === 8, "去重：同键保留 totalMin 最小者（8）");
  assert(r.siblings === undefined, "去重：同键另一条被剔除 ⇒ 无兄弟（字段省略）");
}

// ── ⑥ 与主卡同键的兄弟剔除 ──
{
  const main = mkCard(1, 10, ["25"], "M1/1");
  const dupOfMain = mkCard(2, 14, ["25"], "M1/1"); // 与主卡同键、更大 ⇒ 剔除
  const other = mkCard(3, 18, ["25", "26A"], "M2/1");
  const r = splitPlanCards([main, dupOfMain, other]);
  assert(r.card.planId === 1, "同主卡键：主卡 = 组内最小（10）");
  assert((r.siblings ?? []).length === 1 && r.siblings?.[0]?.planId === 3, "与主卡同键的兄弟被剔除，另一走法保留为兄弟");
}

// ── ⑦ top-K = 3 截断 ──
{
  const cards = [10, 20, 30, 40, 50].map((t, i) => mkCard(i + 1, t, ["25"], `M${i + 1}/1`));
  const r = splitPlanCards(cards);
  assert(1 + (r.siblings?.length ?? 0) === SIBLING_TOP_K, "top-K：主卡 + 兄弟 = K = 3");
  assert(
    r.card.totalMin === 10 && (r.siblings ?? []).map((s) => s.totalMin).join(",") === "20,30",
    "top-K：仅保留最小 3 条且升序（40 / 50 被截断）",
  );
}

// ── ⑧ siblings 空则省略不下发 ──
{
  const r = splitPlanCards([mkCard(1, 10, ["25"], "M1/1")]);
  assert(!("siblings" in r), "单条走法：不返回 siblings 键（不下发）");
  assert(r.card.totalMin === 10, "单条走法：主卡仍正常返回");
}

// ── ⑨ 同 totalMin 稳定 tiebreak（按线路链升序） ──
{
  const r = splitPlanCards([
    mkCard(1, 20, ["26A"], "M1/1"),
    mkCard(2, 20, ["25"], "M2/1"),
  ]);
  assert(r.card.planId === 2, "同 totalMin：按线路链升序稳定 tiebreak（25 < 26A）");
}

// ── ⑩ 纯函数：不修改入参数组 ──
{
  const a = mkCard(1, 30, ["25"], "M1/1");
  const b = mkCard(2, 10, ["25"], "M2/1");
  const input = [a, b];
  splitPlanCards(input);
  assert(input[0] === a && input[1] === b, "纯函数：不修改入参数组顺序（内部复制后排序）");
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
