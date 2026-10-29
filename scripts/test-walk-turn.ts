/**
 * `turnOf()` 单测（scripts/test-walk-turn.ts · v3.6.0 S5）
 *
 * ── 为什么必须有这个文件 ────────────────────────────────────────────────
 *   S5 评审阻断 ① 是一个**确定性 bug**：`turnOf("向左")` 返回 `arrive`。它能一路走到
 *   评审而不是在开发时被发现，根因就是**全仓 0 个 `turnOf` 断言** —— 词表写了
 *   `向左|向右`，归类却用 `startsWith("左")`，两处不一致没有任何测试兜住。
 *   ⇒ 本文件把「词表 ↔ 归类」的一致性固化成断言。**改词表必须同时改这里**。
 *
 * 跑法：`node node_modules/tsx/dist/cli.mjs scripts/test-walk-turn.ts`
 *      （或 `npm run test:walk-turn`）
 * 退出码：0 = 全过；1 = 有失败（逐个打印期望/实际）
 */
import { turnOf, stepGeomM, type WalkStep } from "../src/lib/walk/walk-shared";

let fail = 0;
let pass = 0;

function eq(actual: string, expected: string, label: string): void {
  const ok = actual === expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "OK  " : "FAIL"} ${label}  ${JSON.stringify(expected)}${ok ? "" : ` ≠ 实际 ${JSON.stringify(actual)}`}`);
}

console.log("═══ turnOf 词表 ↔ 归类一致性 ═══\n");

/* ── ① 阻断 ① 的四个原样复现用例（改前全错，必须留在测试里防回归）──────── */
console.log("── ① 回归：向左/向右 曾误判 arrive ──");
eq(turnOf("向左"), "left", "「向左」");
eq(turnOf("向右"), "right", "「向右」");
eq(turnOf("向左前方步行50米"), "left", "「向左前方步行50米」");
eq(turnOf("向右前方步行50米"), "right", "「向右前方步行50米」");

/* ── ② 五种后缀 × 有无「向」前缀 全覆盖 ───────────────────────────────── */
console.log("\n── ② 后缀 × 前缀组合 ──");
eq(turnOf("左转"), "left", "「左转」");
eq(turnOf("右转"), "right", "「右转」");
eq(turnOf("左前方"), "left", "「左前方」（无「向」）");
eq(turnOf("右前方"), "right", "「右前方」（无「向」）");
eq(turnOf("左前"), "left", "「左前」");
eq(turnOf("右前"), "right", "「右前」");
eq(turnOf("左后"), "left", "「左后」");
eq(turnOf("右后"), "right", "「右后」");
eq(turnOf("沿XX路向西步行30米，向左"), "left", "句末「向左」");
eq(turnOf("沿XX路向东步行30米，向右"), "right", "句末「向右」");

/* ── ③ 掉头 / 到达 / 直行 ──────────────────────────────────────────────── */
console.log("\n── ③ 掉头 / 到达 / 直行 ──");
eq(turnOf("掉头"), "uturn", "「掉头」");
eq(turnOf("沿XX路向北步行50米，掉头"), "uturn", "句末「掉头」");
eq(turnOf("到达目的地"), "arrive", "「到达目的地」（末步，默认 isLast=true）");
eq(turnOf("抵达终点"), "arrive", "「抵达终点」");
eq(turnOf("沿XX路向东步行100米"), "straight", "纯直行");
eq(turnOf(""), "straight", "空串 ⇒ straight（不抛错）");
eq(turnOf("沿XX路直行"), "straight", "「直行」");

/* ── ④ 取「最后一次」转向词（动作在这一步末尾）──────────────────────────── */
console.log("\n── ④ 取最后一次匹配（不是第一个）──");
eq(turnOf("沿XX路左转后直行，再右转进入YY街"), "right", "左转…右转 ⇒ 取右转");
eq(turnOf("沿XX路右转后直行，再左转进入YY街"), "left", "右转…左转 ⇒ 取左转");
eq(
  turnOf("沿XX路向西北步行200米，右转进入ZZ街"),
  "right",
  "「向西北」不得被当成「向西」误判",
);
eq(turnOf("沿XX路步行100米，终点在右前方"), "right", "「终点…右前方」⇒ 取右前方（不是 arrive）");

/* ── ⑤ isLast：arrive 只在末步 ─────────────────────────────────────────── */
console.log("\n── ⑤ isLast=false 时 mid-step「到达」归 straight ──");
eq(turnOf("到达新馬路", false), "straight", "中途「到达新馬路」+ isLast=false ⇒ straight");
eq(turnOf("到达新馬路", true), "arrive", "末步「到达新馬路」+ isLast=true ⇒ arrive");
eq(turnOf("向左前方步行50米", false), "left", "isLast 不影响左右转");

/* ── ⑥ stepGeomM：几何长度口径（advisory 1 的分母）────────────────────── */
console.log("\n── ⑥ stepGeomM 用 cumM 末值减首值 ──");
const fake = { cumM: [100, 130.5, 170.2] } as Pick<WalkStep, "cumM">;
const g = stepGeomM(fake);
console.log(`${Math.abs(g - 70.2) < 0.001 ? "OK  " : "FAIL"} stepGeomM([100,130.5,170.2]) = ${g}（期望 70.2）`);
if (Math.abs(g - 70.2) < 0.001) pass++;
else fail++;
const empty = stepGeomM({ cumM: [] });
console.log(`${empty === 0 ? "OK  " : "FAIL"} stepGeomM([]) = ${empty}（期望 0，不 NaN）`);
if (empty === 0) pass++;
else fail++;

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
