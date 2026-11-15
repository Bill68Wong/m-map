/**
 * 站序判向传承门禁（`scripts/test-nav-direction.ts`，2026-11-15 新建）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   2026-11 现场：26 路 / 25B 等双向线路**画成反方向**。根因不是数据缺失，也不是容差：
 *   两个方向的折线**都在** `TOL_M=80` 内，只是「反向折线恰好更贴近两端站点」⇒
 *   `dBoard + dAlight` 更小 ⇒ 反向胜出（25B 实测 dir0 = 65.7m 被 dir1 = 19.9m 击败）。
 *   修法是**站序判向**：`route_stations(dsat_dir)` 的站序是权威方向口径，几何只用于
 *   同方向内定点。本门禁用**夹具**把这个判据钉住，防止将来有人「顺手简化」回纯几何。
 *
 * ── 为什么用夹具而不是连库 ────────────────────────────────────────────────
 *   `verify` 链不能依赖数据库（CI 无库 / 库在重建时会整链红）。夹具复刻 25B 的
 *   **真实失效形态**（反向几何更贴站点），足以锁住判据；数据正确性另有库内门禁。
 *
 * ── 四个夹具 ──────────────────────────────────────────────────────────────
 *   A（核心）两条 shape、站点集合相同；「正确方向」board/alight 距折线 **71m / 61m**，
 *     「反向」**12m / 17m**（= 25B 形态）。两条都带 `stations`（B→A 与 A→B）⇒
 *     必须选**正确方向**那条，`dir === "0"`。
 *   B（保护旧行为）同样两条 shape，但**都不带 `stations`** ⇒ 必须仍走几何打分、
 *     选中「反向」那条（`dir === "1"`）。这是**证明无站序时行为没变**，不是缺陷。
 *   C（唯一性护栏）board 主码在站序里出现两次 ⇒ 判不可判 ⇒ 整体回落几何路径，
 *     不许抛错（环线多次停靠走 `pickTripPairLoopMulti`，与此判据正交）。
 *   D（守恒式）一组构造输入上 `matched + mismatch + degraded === 总数`，防止将来
 *     只改一边导致漏算（「数字凑上但漏算」是典型假绿）。
 *
 * ── 防假绿 ────────────────────────────────────────────────────────────────
 *   · 夹具全部内联构造，**不连库、不读网络**；
 *   · 源码结构断言（E 组）：必须能读到 `seqVerdictOf` 定义、`seqSame.length === 1`
 *     直选分支，且**不得**重新出现旧闸门 `pickShapes`（轻轨不吃站序那版）；
 *   · 文件读不到 / 夹具缺字段 / 正则没匹配到 ⇒ 判红，不跳过；
 *   · 每条失败信息都带「缺了什么 + 期望值 / 实际值」。
 *
 * 跑法：`npm run test:nav-direction`（verify 链第 38 段）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildColoredLegs, chooseShape, distM } from "../src/lib/nav/route-overview";
import type { LL, RouteShapeLite } from "../src/lib/nav/route-overview";
import { buildRouteIndexFromRows, isLoopOf } from "../src/lib/dsat/route-index";
import type { RouteStopRow } from "../src/lib/dsat/route-index";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_OVERVIEW = "src/lib/nav/route-overview.ts";

/** `distM` 内部用 111320 m/度；夹具在赤道附近构造，cos(lat)≈1 ⇒ 1 度 = 111320m */
const M_PER_DEG = 111320;
/** 折算成 (东向米, 北向米) 的经纬度点 */
const at = (eastM: number, northM: number): LL => [eastM / M_PER_DEG, northM / M_PER_DEG];
const line = (pts: LL[]): string => pts.map(([lng, lat]) => `${lng.toFixed(7)},${lat.toFixed(7)}`).join(";");
/** 从 (e0, 0) 到 (e1, northM) 的 5 点折线 */
const strip = (e0: number, e1: number, northM: number): LL[] =>
  [0, 0.25, 0.5, 0.75, 1].map((t) => at(e0 + (e1 - e0) * t, northM * t));

const BOARD = { code: "B", lng: 0, lat: 0 };
const ALIGHT = { code: "A", lng: at(0, 1113)[0], lat: at(0, 1113)[1] };
const BOARD_PT: LL = [BOARD.lng, BOARD.lat];

let pass = 0;
let fail = 0;
const registered: string[] = [];
const STRUCTURAL_EXPECTED = 12;

function check(id: string, label: string, cond: boolean, detail: string): void {
  registered.push(id);
  if (cond) {
    pass++;
    console.log(`  PASS  ${id}  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${id}  ${label}  →  ${detail}`);
  }
}

/** 夹具 A/B/C 共用的两条 shape（几何固定：反向更贴站点） */
const SHAPE_CORRECT: RouteShapeLite = {
  dir: "0",
  polyline: line(strip(71, 61, 1113)),
  startStop: "B",
  endStop: "A",
  stations: [
    { code: "B", seq: 1 },
    { code: "A", seq: 2 },
  ],
};
const SHAPE_REVERSE: RouteShapeLite = {
  dir: "1",
  polyline: line(strip(12, 17, 1113)),
  startStop: "A",
  endStop: "B",
  stations: [
    { code: "A", seq: 1 },
    { code: "B", seq: 2 },
  ],
};

const legOf = (shapes: RouteShapeLite[]) =>
  buildColoredLegs([{ index: 0, route: "FIX", kind: "bus", color: null, board: BOARD, alight: ALIGHT }], {
    FIX: shapes,
  })[0];

function main(): void {
  console.log("\n═══ 站序判向传承门禁（夹具，不连库）═══\n");

  /* ── 夹具 A：站序判向必须压过几何分数 ─────────────────────────────── */
  const a = chooseShape([SHAPE_CORRECT, SHAPE_REVERSE], BOARD, ALIGHT);
  check(
    "A1",
    "夹具A：正确方向 board/alight 71m/61m、反向 12m/17m ⇒ 必须选正确方向（dir=0）",
    a?.dir === "0",
    `实际 dir=${a?.dir ?? "null"}（期望 "0"；若为 "1" 说明退化回纯几何打分）`,
  );
  const aBoardDist = a ? distM(a.pts[a.iBoard], BOARD_PT) : Number.NaN;
  check(
    "A3",
    "夹具A：锚点仍是正确方向折线的最近顶点（≈71m，不是反向的 12m）",
    Math.abs(aBoardDist - 71) <= 2,
    `实际 ${aBoardDist.toFixed(1)}m（期望 71±2m）`,
  );
  const legA = legOf([SHAPE_CORRECT, SHAPE_REVERSE]);
  check(
    "A4",
    "夹具A：生产路径 buildColoredLegs 同结论（dir=0 且不降级）",
    legA.dir === "0" && legA.degraded === false,
    `实际 dir=${legA.dir} degraded=${legA.degraded}`,
  );

  /* ── 夹具 B：无 station 时必须逐字节回落旧几何 ─────────────────────── */
  const noSeq = (s: RouteShapeLite): RouteShapeLite => ({ ...s, stations: null });
  const b = chooseShape([noSeq(SHAPE_CORRECT), noSeq(SHAPE_REVERSE)], BOARD, ALIGHT);
  check(
    "B1",
    "夹具B：两条都不带 stations ⇒ 必须回落几何打分、选反向那条（dir=1）",
    b?.dir === "1",
    `实际 dir=${b?.dir ?? "null"}（期望 "1"；若为 "0" 说明无站序时行为被改了）`,
  );
  const bBoard = b ? distM(b.pts[b.iBoard], BOARD_PT) : Number.NaN;
  check(
    "B2",
    "夹具B：几何解锚点应是反向折线的 12m（旧行为原样）",
    Math.abs(bBoard - 12) <= 2,
    `实际 ${bBoard.toFixed(1)}m（期望 12±2m）`,
  );

  /* ── 夹具 C：唯一性护栏（主码在站序里出现两次 ⇒ 不可判）────────────── */
  const dupStations = [
    { code: "B", seq: 1 },
    { code: "A", seq: 2 },
    { code: "B", seq: 3 },
  ];
  const cShapes: RouteShapeLite[] = [
    { ...SHAPE_CORRECT, stations: dupStations },
    { ...SHAPE_REVERSE, stations: [...dupStations].reverse() },
  ];
  let cThrew = false;
  let c: ReturnType<typeof chooseShape> = null;
  try {
    c = chooseShape(cShapes, BOARD, ALIGHT);
  } catch {
    cThrew = true;
  }
  check("C1", "夹具C：board 主码出现两次 ⇒ 不得抛错", !cThrew, "chooseShape 抛异常（唯一性护栏失效）");
  check(
    "C2",
    "夹具C：不可判 ⇒ 整体回落几何路径（dir=1，不猜）",
    !cThrew && c?.dir === "1",
    `实际 dir=${cThrew ? "抛错" : (c?.dir ?? "null")}（期望 "1"）`,
  );

  /* ── 夹具 D：守恒式（防「数字凑上但漏算」）─────────────────────────── */
  const mkLeg = (shapes: RouteShapeLite[], want: string) => {
    const leg = legOf(shapes);
    const ok = !leg.degraded && leg.dir === want;
    return { ok, degraded: leg.degraded };
  };
  const cases = [
    mkLeg([SHAPE_CORRECT, SHAPE_REVERSE], "0"), // matched
    mkLeg([noSeq(SHAPE_CORRECT), noSeq(SHAPE_REVERSE)], "0"), // mismatch（旧行为选 1）
    mkLeg(cShapes, "0"), // mismatch（回落几何选 1）
    mkLeg([], "0"), // degraded（无 shape）
    mkLeg(
      [
        { ...SHAPE_CORRECT, polyline: line(strip(400, 400, 1113)) },
        { ...SHAPE_REVERSE, polyline: line(strip(400, 400, 1113)) },
      ],
      "0",
    ), // degraded（两方向都超 80m）
    mkLeg(
      [{ ...SHAPE_CORRECT, startStop: "B", endStop: "B" }],
      "0",
    ), // matched（同站整线着色，dir=0）
  ];
  const matched = cases.filter((x) => x.ok).length;
  const degraded = cases.filter((x) => x.degraded).length;
  const mismatch = cases.length - matched - degraded;
  check(
    "D1",
    `夹具D：守恒式 matched+mismatch+degraded === ${cases.length}`,
    matched + mismatch + degraded === cases.length,
    `matched=${matched} mismatch=${mismatch} degraded=${degraded} 合计=${matched + mismatch + degraded}（期望 ${cases.length}）`,
  );

  /* ── E 组：源码结构（防止判据被删掉 / 旧闸门被改回）────────────────── */
  let src = "";
  try {
    src = readFileSync(path.join(ROOT, SRC_OVERVIEW), "utf8");
  } catch (e) {
    console.error(`  NOTE  ${SRC_OVERVIEW} 读取失败（${(e as Error).message}）⇒ E 组全部判红`);
  }
  check(
    "E1",
    `${SRC_OVERVIEW} 必须仍定义 seqVerdictOf()`,
    /function\s+seqVerdictOf\s*\(/.test(src),
    `未找到 "function seqVerdictOf("（判据可能被删）`,
  );
  check(
    "E2",
    "chooseShape 必须仍有「恰好一个同向 ⇒ 直选」分支（seqSame.length === 1）",
    /seqSame\.length\s*===\s*1/.test(src),
    `未找到 "seqSame.length === 1"（直选分支被删/被改）`,
  );
  check(
    "E3",
    "不得重新引入「轻轨不吃站序」的旧闸门（pickShapes）",
    !/pickShapes/.test(src),
    `源码里仍出现 pickShapes（旧闸门回退）`,
  );
  check(
    "E4",
    "TOL_M 必须仍为 80（本批未动容差）",
    /export const TOL_M = 80;/.test(src),
    `未找到 "export const TOL_M = 80;"`,
  );
  check(
    "E5",
    `分母自证：本条第 ${STRUCTURAL_EXPECTED + 1} 条注册前，注册数必须恰好 ${STRUCTURAL_EXPECTED}`,
    registered.length === STRUCTURAL_EXPECTED,
    `registered=${registered.length}（期望 ${STRUCTURAL_EXPECTED}；多/少一条说明判据被增删却没更新分母）`,
  );

  /* ── 夹具 F：缺 code ⇒ 允许回落，但不许「静默到看起来通过」────────────── */
  let fThrew = false;
  let f: ReturnType<typeof chooseShape> = null;
  try {
    f = chooseShape(
      [SHAPE_CORRECT, SHAPE_REVERSE],
      { lng: BOARD.lng, lat: BOARD.lat },
      { lng: ALIGHT.lng, lat: ALIGHT.lat },
    );
  } catch {
    fThrew = true;
  }
  check(
    "F1",
    "夹具F：有 stations 但缺 board/alight.code ⇒ 允许回落几何（dir=1），但不得抛错（本条守「不许静默」，回落本身是允许行为）",
    !fThrew && f?.dir === "1",
    `实际 ${fThrew ? "抛错" : `dir=${f?.dir ?? "null"}`}（期望 dir="1" 且不抛错；抛错说明缺 code 时没做防护）`,
  );

  /* ── G 组：is_loop 口径切换 + 旧缓存回落（v4.2.0）────────────────────── */
  /**
   * 这一组守的是「发版初期 Data Cache 还是旧结构 payload」那一小时：
   * `routeRows === undefined` ⇒ 必须回落老口径（方向数 ≤ 1），**不许**当成「全部 false」。
   * 生产后果：若当成 false，75 条 is_active 循环线会被按去/回程分两套站序。
   */
  const stopsRows: RouteStopRow[] = [
    { route: "LOOP", dsat_dir: "0", stops: ["A", "B", "C"] },
    { route: "TWO", dsat_dir: "0", stops: ["A", "B"] },
    { route: "TWO", dsat_dir: "1", stops: ["B", "A"] },
  ];
  const idxOld = buildRouteIndexFromRows(stopsRows, []);
  const idxNew = buildRouteIndexFromRows(stopsRows, [], [
    { code: "LOOP", is_loop: true },
    { code: "TWO", is_loop: false },
  ]);
  check(
    "G1",
    "旧缓存（routeRows=undefined）不得抛错，且 loopOf 为空 Map",
    idxOld.loopOf !== undefined && idxOld.loopOf.size === 0,
    `实际 ${idxOld.loopOf === undefined ? "loopOf 缺失（应为空 Map）" : `loopOf.size=${idxOld.loopOf.size}`}（期望 0；非 0 说明把 undefined 当成了真值）`,
  );
  check(
    "G2",
    "旧缓存 ⇒ isLoopOf 必须回落老口径（LOOP dirs=1→true / TWO dirs=2→false）",
    isLoopOf(idxOld, "LOOP") === true && isLoopOf(idxOld, "TWO") === false,
    `LOOP=${String(isLoopOf(idxOld, "LOOP"))} TWO=${String(isLoopOf(idxOld, "TWO"))}（期望 true / false）`,
  );
  check(
    "G3",
    "新口径 ⇒ isLoopOf 读 routes.is_loop（LOOP=true / TWO=false）",
    isLoopOf(idxNew, "LOOP") === true && isLoopOf(idxNew, "TWO") === false,
    `LOOP=${String(isLoopOf(idxNew, "LOOP"))} TWO=${String(isLoopOf(idxNew, "TWO"))}`,
  );
  check(
    "G4",
    "等价性：新旧两版索引对同一线路集合的判定必须完全相同",
    ["LOOP", "TWO"].every((r) => isLoopOf(idxOld, r) === isLoopOf(idxNew, r)),
    `旧=${["LOOP", "TWO"].map((r) => String(isLoopOf(idxOld, r))).join(",")} 新=${["LOOP", "TWO"]
      .map((r) => String(isLoopOf(idxNew, r)))
      .join(",")}`,
  );

  if (registered.length !== pass + fail) {
    console.error(`  FAIL  E5b 分母不符：registered=${registered.length} pass+fail=${pass + fail}`);
    process.exit(1);
  }

  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
