/**
 * 段内并行线「反查补漏」收口判据 · 纯函数回归（scripts/test-parallel-pick.ts，R2 · 2026-11-17）
 *
 * ── 这个文件守什么 ──────────────────────────────────────────────────────
 *   `src/lib/nav/parallel-pick.ts` 决定「哪些反查出来的线可以补进并行线名单」。
 *   它是**判据的唯一住所**（`map-stations.ts` 只做装配）⇒ 这里的断言就是全部防线：
 *     · 门槛放宽 ⇒ 把环线绕行（`d×=210`）塞进「后续班车」= 误导；
 *     · 门槛收紧 ⇒ 连高德自己列的 `d×=1.29` 都不认 = 两套口径打架；
 *     · 排序不确定 ⇒ 「同一 OD 重复请求名单一致」这条验收直接失效（它才是最要命的一条）。
 *
 * ── 为什么放在 `scripts/` 并直接 import 真实函数 ─────────────────────────
 *   `.verify/` 被 gitignore 且不在 tsc 覆盖内，复刻实现必然腐化（本项目有前科）。
 *   本文件断言对象与线上代码是同一个函数。
 *
 * ── 铁律 44c 四项 ──────────────────────────────────────────────────────
 *   ① 用例集合非空（`PAIRS` / 各 `picked` 断言都带非空自检）；
 *   ② 集合尺寸 == 枚举出的分支数（拒因 7 种，逐个有断言）；
 *   ③ 末尾写明「实际比对 N / 预期 M」；
 *   ④ 全部**正向**断言（断言「应该等于什么」），禁 `x || !!x`。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────
 *   npm run test:parallel-pick   （= `tsx scripts/test-parallel-pick.ts`，cwd = 仓库根）
 */
import { routesServing } from "../src/lib/nav/enumerate-nav";
import {
  PARALLEL_HOP_SLACK,
  PARALLEL_MAX_ADD,
  PARALLEL_MAX_RATIO,
  makeMeasure,
  mergeParallels,
  pickExtraParallels,
  type SegmentFacts,
} from "../src/lib/nav/parallel-pick";
import { mainCodeOf } from "../src/lib/recommend/segment-lookup";
import type { RouteIndex } from "../src/lib/recommend/types";

let failed = 0;
/** 实际执行的断言条数（末尾与 `EXPECTED` 对账：少跑/漏跑即红） */
let compared = 0;
const ok = (cond: boolean, name: string, detail = ""): void => {
  compared++;
  if (!cond) {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `  —— ${detail}` : ""}`);
  }
};
const eqStr = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const eq = (actual: unknown, expected: unknown, name: string): void => {
  ok(eqStr(actual, expected), name, `实际=${JSON.stringify(actual)} 预期=${JSON.stringify(expected)}`);
};

// ─────────────────── 夹具 1：纯函数判据（不碰 RouteIndex）───────────────────
/** 推荐线：3 跳 / 1000m。所有边界都以它为分母/基数 */
const MAIN = "MAIN";
const FACTS = new Map<string, SegmentFacts | null>([
  [MAIN, { hops: 3, meters: 1000 }],
  ["R130", { hops: 3, meters: 1300 }], // d× = 1.300 恰好 —— 必须「含」
  ["R131", { hops: 3, meters: 1310 }], // d× = 1.310 —— 必须「不含」
  ["H2", { hops: 5, meters: 1000 }], //  跳数 = main + 2 —— 必须「含」
  ["H3", { hops: 6, meters: 1000 }], //  跳数 = main + 3 —— 必须「不含」
  ["NM", { hops: 3, meters: null }], //  里程缺失
  ["NS", null], //                       解不出该段
  ["C1", { hops: 3, meters: 900 }],
  ["C2", { hops: 3, meters: 800 }],
  ["C3", { hops: 3, meters: 700 }],
  ["TIE_A", { hops: 3, meters: 950 }],
  ["TIE_Z", { hops: 3, meters: 950 }],
  ["DECL", { hops: 3, meters: 900 }],
]);
const measure = (route: string): SegmentFacts | null => FACTS.get(route) ?? null;
const pick = (candidates: string[], declared: string[] = [], opts = {}) =>
  pickExtraParallels({ mainRoute: MAIN, declared, candidates }, measure, opts);
const reasonOf = (res: { rejected: { route: string; reason: string }[] }, route: string) =>
  res.rejected.find((r) => r.route === route)?.reason ?? "(无)";

console.log("\n── 判据① d× 门槛（常量声明与实现一致）──");
eq(PARALLEL_MAX_RATIO, 1.3, "常量 PARALLEL_MAX_RATIO = 1.3");
{
  const res = pick(["R130"]);
  eq(res.picked, ["R130"], "d× 恰好 1.30 ⇒ **含**（放进 picked）");
}
{
  const res = pick(["R131"]);
  eq(res.picked, [], "d× = 1.31 ⇒ 不含");
  eq(reasonOf(res, "R131"), "detour", "d× = 1.31 的拒因是 detour");
}

console.log("\n── 判据② 跳数上限 ──");
eq(PARALLEL_HOP_SLACK, 2, "常量 PARALLEL_HOP_SLACK = 2");
{
  const res = pick(["H2"]);
  eq(res.picked, ["H2"], "跳数 = main+2 ⇒ **含**");
}
{
  const res = pick(["H3"]);
  eq(res.picked, [], "跳数 = main+3 ⇒ 不含");
  eq(reasonOf(res, "H3"), "too_many_hops", "跳数 main+3 的拒因是 too_many_hops");
}

console.log("\n── 判据③ 里程缺失不新增（不做替代估算）──");
{
  const res = pick(["NM"]);
  eq(res.picked, [], "候选线里程 null ⇒ 不新增");
  eq(reasonOf(res, "NM"), "no_mileage", "里程 null 的拒因是 no_mileage");
}
{
  const res = pick(["NS"]);
  eq(res.picked, [], "候选线解不出该段 ⇒ 不新增");
  eq(reasonOf(res, "NS"), "no_segment", "解不出段的拒因是 no_segment");
}
{
  const noMain = pickExtraParallels(
    { mainRoute: MAIN, declared: [], candidates: ["R130", "C1"] },
    (r) => (r === MAIN ? { hops: 3, meters: null } : measure(r)),
  );
  eq(noMain.picked, [], "推荐线自身里程 null ⇒ 一条都不新增（没有分母就没有 d×）");
  eq(
    noMain.rejected.map((x) => x.reason),
    ["main_unmeasurable", "main_unmeasurable"],
    "推荐线不可测时两条候选都记 main_unmeasurable",
  );
}

console.log("\n── 判据④ 上限与确定性排序 ──");
eq(PARALLEL_MAX_ADD, 2, "常量 PARALLEL_MAX_ADD = 2");
{
  // 三条都合格，d× = 0.9 / 0.8 / 0.7 ⇒ 升序后取前 2 = C3, C2
  const res = pick(["C1", "C2", "C3"]);
  eq(res.picked, ["C3", "C2"], "超上限时按 d× 升序取前 2 条");
  eq(res.picked.length, PARALLEL_MAX_ADD, "picked 条数 == PARALLEL_MAX_ADD");
  eq(reasonOf(res, "C1"), "overflow", "被截断的那条拒因是 overflow");
}
{
  // 同 d× ⇒ 按线码码位序（TIE_A < TIE_Z），与输入顺序无关
  const a = pick(["TIE_Z", "TIE_A"], [], { maxAdd: 1 });
  const b = pick(["TIE_A", "TIE_Z"], [], { maxAdd: 1 });
  eq(a.picked, ["TIE_A"], "d× 相等时取码位序较小者（输入逆序）");
  eq(b.picked, ["TIE_A"], "d× 相等时取码位序较小者（输入正序）");
  ok(
    eqStr(a.picked, b.picked),
    "同一集合、不同输入顺序 ⇒ 结果相同（可复现）",
    `${JSON.stringify(a.picked)} vs ${JSON.stringify(b.picked)}`,
  );
}

console.log("\n── 判据⑤ 只做加法：高德原名单逐字不动 ──");
{
  const declared = ["A", "A", "B"]; // 含重复项，模拟高德自己的重复
  const merged = mergeParallels(declared, ["B", "C", "C"]);
  eq(merged, ["A", "A", "B", "C"], "declared 原顺序与重复项**逐字保留**，extra 追加去重");
  eq(merged.slice(0, declared.length), declared, "前缀 == 原名单（顺序未被重排）");
}
{
  const merged = mergeParallels(["X"], []);
  eq(merged, ["X"], "无新增时原样返回");
}
{
  const res = pick(["DECL"], ["DECL"]);
  eq(res.picked, [], "高德已给的线不会被重复添加");
  eq(reasonOf(res, "DECL"), "already_declared", "已声明的拒因是 already_declared");
}
{
  const res = pick([MAIN, "C1", "C1"]);
  eq(res.picked, ["C1"], "候选含推荐线自身与重复项 ⇒ 只算一次");
}

console.log("\n── 确定性（验收口径「同 OD 重复请求名单一致」的函数级保证）──");
{
  const once = pick(["C1", "C2", "C3", "R130", "H2", "NM", "NS"]);
  const twice = pick(["C1", "C2", "C3", "R130", "H2", "NM", "NS"]);
  eq(once.picked, twice.picked, "同一输入连续两次 ⇒ picked 相同");
  eq(
    once.rejected.map((r) => `${r.route}:${r.reason}`),
    twice.rejected.map((r) => `${r.route}:${r.reason}`),
    "同一输入连续两次 ⇒ 拒因序列相同",
  );
}

// ─────────────────── 夹具 2：反查等价（倒排 vs 全库扫描）───────────────────
/**
 * ⚠️ `stopOwners` **手工逐条写死**，不复用生产构建循环 —— 否则「等价断言」等于自己证自己。
 * 夹具刻意含三种边界：循环线首尾同码（`L`）、带站台码（`P` 的 `C690/1`）、支路绕行（`C`）。
 */
const DIR_STOPS = new Map<string, string[]>([
  ["A|0", ["S1", "S2", "S3", "S4"]],
  ["B|0", ["S1", "S2", "S3", "S4"]],
  ["C|0", ["S1", "S9", "S3"]],
  ["D|0", ["S1", "S2", "S3", "S4", "S5"]],
  ["L|0", ["S1", "S2", "S3", "S1"]],
  ["P|0", ["C690/1", "C690/3", "S3"]],
]);
const idxBase = (withOwners: boolean): RouteIndex => ({
  dirStops: DIR_STOPS,
  seqIdx: new Map(),
  dirsOf: new Map([["A", ["0"]], ["B", ["0"]], ["C", ["0"]], ["D", ["0"]], ["L", ["0"]], ["P", ["0"]]]),
  nameOf: new Map(),
  adjOwners: new Map(),
  ...(withOwners
    ? {
        stopOwners: new Map<string, Set<string>>([
          ["S1", new Set(["A", "B", "C", "D", "L"])],
          ["S2", new Set(["A", "B", "D", "L"])],
          ["S3", new Set(["A", "B", "C", "D", "L", "P"])],
          ["S4", new Set(["A", "B", "D"])],
          ["S5", new Set(["D"])],
          ["S9", new Set(["C"])],
          ["C690", new Set(["P"])],
        ]),
      }
    : {}),
});

const PAIRS: [string, string][] = [
  ["S1", "S3"],
  ["S1", "S2"],
  ["S3", "S4"],
  ["C690/1", "C690/3"], // 带站台码：查倒排要用 mainCodeOf 归一
  ["S1", "S1"], //         同站：两边都必须为空
  ["S4", "S1"], //         反向：两边都必须为空
];
console.log("\n── 反查：倒排 vs 全库扫描 逐对等价（常驻断言，不是一次性探针）──");
{
  const withIdx = idxBase(true);
  const withoutIdx = idxBase(false);
  ok(PAIRS.length > 0, "用例集合非空（否则 every/全等断言恒真）");
  for (const [b, a] of PAIRS) {
    const fast = routesServing(withIdx, b, a);
    const slow = routesServing(withoutIdx, b, a);
    eq(fast, slow, `routesServing(${b}→${a}) 倒排结果 == 全库扫描结果`);
  }
  // 非空自检：证明确实解出了东西，不是「两边都空所以相等」
  eq(routesServing(withIdx, "S1", "S3"), ["A", "B", "C", "D", "L"], "S1→S3 解出 5 条（自检非空）");
  eq(routesServing(withIdx, "C690/1", "C690/3"), ["P"], "带站台码 C690/1→C690/3 只解出 P");
  eq(mainCodeOf("C690/1"), "C690", "站台码归一前提成立（C690/1 → C690）");
  /**
   * ⚠️ **环线语义（既有行为，别"修"）**：`L` 的站序是 `[S1,S2,S3,S1]`，首尾同码
   * ⇒ `idxsOf` 给出两个下标 `[0,3]`，`j>i` 取 `(0,3)` ⇒ `S1→S1` 解出「坐满一圈」。
   * 这对**反查并行线**无害：`map-stations#pickExtraForSegment` 只在
   * `mainCodeOf(board) !== mainCodeOf(alight)` 时才反查，同站永远进不来。
   * 此处把它写成断言，防止后人看到「同站也能解出线」就当 bug 改掉（会连带改掉循环线乘满一圈的能力）。
   */
  eq(routesServing(withIdx, "S1", "S1"), ["L"], "环线首尾同码 ⇒ S1→S1 解出完整一圈（既有语义，别改）");
  eq(routesServing(withIdx, "S4", "S1"), [], "反向解不出（该夹具无回程方向）");
}

console.log("\n── 生产降级：hopMeters 缺失 ⇒ 一条都不新增（不换口径硬算）──");
{
  const noMileage = idxBase(true); // 故意不设 hopMeters
  const m = makeMeasure(noMileage, "S1", "S3");
  eq(m("A"), null, "无 hopMeters 时 makeMeasure 恒返回 null");
  const res = pickExtraParallels({ mainRoute: "A", declared: [], candidates: ["B", "C"] }, m);
  eq(res.picked, [], "无里程 ⇒ picked 为空");
  eq(
    res.rejected.map((x) => x.reason),
    ["main_unmeasurable", "main_unmeasurable"],
    "无里程 ⇒ 全部记 main_unmeasurable（有意降级，不是沉默失败）",
  );
}

// ───────────────────────────── 条数对账 ─────────────────────────────
/** 预期断言条数（改断言必须同步；少跑/漏跑即红） */
const EXPECTED = 44;
console.log("");
if (compared !== EXPECTED) {
  failed++;
  console.log(`  FAIL  比对条数与预期不符：实际=${compared} / 预期=${EXPECTED}（有断言被删或漏跑）`);
}
console.log(
  failed === 0
    ? `\n✅ 全通过（比对 ${compared} 条 / 预期 ${EXPECTED} 条）：判据①~⑤ 边界 + 排序确定性 + 倒排等价 + 生产降级`
    : `\n❌ ${failed} 项失败（比对 ${compared} 条）`,
);
process.exit(failed === 0 ? 0 : 1);
