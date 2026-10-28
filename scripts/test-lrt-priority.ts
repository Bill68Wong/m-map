/**
 * 轻轨优先（applyLrtPriority）· 单测（scripts/test-lrt-priority.ts · v3.3.0 · AC-105）
 *
 * 覆盖：
 *   · `enabled=false` → 原样（同引用）；
 *   · 营运中（`lrtState==='running'`）且 ≤ baseline+15 → 稳定置顶、`lrtPromoted=true`；
 *   · **非营运（before_first/after_last/no_data）→ 不置顶、不标角标**（收班后只能赶次日首班 ⇒ 静默）★
 *   · 混合：仅 running 者被置顶，非 running 者保持原位；
 *   · 无命中（running 但超阈值 / 全非轻轨）→ 静默原样。
 *
 * 运行：npm run test:lrt-priority（= tsx scripts/test-lrt-priority.ts）
 */
import type { RankedItem } from "../src/lib/nav/rank";
import { applyLrtPriority } from "../src/lib/recommend/lrt-priority";

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

type LrtState = "running" | "before_first" | "after_last" | "no_data";

/** 造一条 RankedItem；`lrtState=null` ⇒ 巴士段 */
function mk(totalMin: number, lrtState: LrtState | null, id: number): RankedItem {
  const rides = lrtState === null
    ? [{ kind: "bus", route: `B${id}` }]
    : [{ kind: "lrt", route: "LRT-氹仔线", lrtState }];
  return {
    card: { totalMin, planId: id, rides },
    origin: "local",
    key: `k${id}`,
  } as unknown as RankedItem;
}

const ids = (arr: RankedItem[]) => arr.map((i) => i.card.planId).join(",");

console.log("applyLrtPriority · 轻轨优先单测\n");

// ① running 命中 → 置顶 + 角标
{
  const items = [mk(10, null, 1), mk(40, "running", 2), mk(12, null, 3), mk(50, "running", 4)];
  const on = applyLrtPriority(items, 2, true); // baseline=max(10,40)=40；命中 ≤55
  assert(ids(on) === "2,4,1,3", "营运中命中者按 totalMin 升序置顶，其余相对序不变");
  assert(on[0].card.lrtPromoted === true && on[1].card.lrtPromoted === true, "命中者 lrtPromoted=true");
  assert(on[2].card.lrtPromoted === false && on[3].card.lrtPromoted === false, "非命中者 lrtPromoted=false");
}

// ② ★ 非营运（次日首班场景）→ 不置顶（本批 QA 修正的核心）
{
  const states: LrtState[] = ["before_first", "after_last", "no_data"];
  for (const st of states) {
    const items = [mk(10, null, 1), mk(40, st, 2), mk(12, null, 3)];
    const on = applyLrtPriority(items, 2, true);
    assert(ids(on) === "1,2,3", `lrtState=${st} ⇒ 不置顶（静默按常规排序）`);
    assert(on.every((i) => i.card.lrtPromoted !== true), `lrtState=${st} ⇒ 不标 lrtPromoted`);
  }
}

// ③ 混合：仅 running 者被置顶
{
  const items = [mk(10, null, 1), mk(40, "before_first", 2), mk(45, "running", 3)];
  const on = applyLrtPriority(items, 3, true); // baseline=max(10,40,45)=45；命中=running(45)
  assert(ids(on) === "3,1,2", "混合：仅 running(3) 置顶；before_first(2) 原位不置顶");
  assert(on[0].card.lrtPromoted === true && on[1].card.lrtPromoted === false && on[2].card.lrtPromoted === false, "混合：角标只落 running 者");
}

// ④ enabled=false → 同引用原样
{
  const items = [mk(10, null, 1), mk(40, "running", 2)];
  assert(applyLrtPriority(items, 2, false) === items, "enabled=false ⇒ 原样返回（同引用）");
}

// ⑤ 无命中（running 但超阈值）→ 原样
{
  const items = [mk(10, null, 1), mk(12, null, 2), mk(99, "running", 3)]; // baseline=12；99>27
  assert(applyLrtPriority(items, 2, true) === items, "running 但超 baseline+15 ⇒ 静默原样（同引用）");
}

// ⑥ 无轻轨 → 原样
{
  const items = [mk(10, null, 1), mk(12, null, 2)];
  assert(applyLrtPriority(items, 2, true) === items, "无轻轨 ⇒ 静默原样（同引用）");
}

console.log("\n" + (fail === 0 ? "✅ 全部通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
process.exit(fail === 0 ? 0 : 1);
