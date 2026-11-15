/**
 * 「无车文案」唯一映射门禁（scripts/test-service-text.ts，2026-11-12 · 问题 4 收口）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────
 *   负责人裁定：无车文案统一成五个字，且「仅有这五个字，不加时间等」。
 *   本脚本把三件事钉死，防止下一轮有人「顺手把时刻拼回去」或「在某个组件里再写一份」：
 *     A 段  七种输入的**精确**返回（`===` 全等，不用 includes —— 带尾巴的也能过就不是门禁）
 *     B 段  五字短语的长度与逐字相等（长度用码点数，防止「非营运时间 」（带空格）混进来）
 *     C 段  三个字面量在 `src/` 的**代码**里只允许出现在 `src/lib/ui/service-text.ts`
 *
 * ── 防假绿口径（沿用 scripts/test-layer-view-guards.ts 的写法）───────────
 *   · 只读磁盘上的真实源码；不 import 生产模块以外的任何东西、不连库。
 *   · 文件 / 目录读不到 ⇒ 相关判据**默认失败**，不跳过、不 exit(0)。
 *   · 正则没匹配到 ⇒ 同样判失败（不是「没命中就算干净」）。
 *   · 扫描器自带**正控**：用同一套遍历去找一个必然存在的标识符，命中数为 0 即判「扫描器失效」。
 *
 * ── 为什么按「去注释后的代码」扫描 ────────────────────────────────────
 *   门禁要防的是「第二份映射」（代码里再写一遍字面量）。注释里提到这句话是**说明**，不是映射；
 *   且仓库里已有一处**他人文件**的历史注释提到过其中一个词（`src/lib/dsat/eta.ts` 的
 *   「等车站」说明），那属另一个语义、且不在本批可改范围。⇒ 统一口径：**注释不计**，
 *   与 `test-layer-view-guards.ts` 的「去注释后源码 0 命中」同款做法。
 *
 * 跑法：npm run test:service-text（在 verify 链末尾）
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NO_VEHICLE_TEXT, noVehicleText, type NoVehicleState } from "../src/lib/ui/service-text";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
/** 这三个字面量的唯一合法宿主 */
const OWNER = "src/lib/ui/service-text.ts";

let pass = 0;
let fail = 0;
const registered: string[] = [];

function check(id: string, label: string, cond: boolean, detail: string): void {
  registered.push(id);
  if (cond) {
    pass++;
    console.log(`  PASS  ${id}  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${id}  ${label}\n        ↳ ${detail}`);
  }
}

/** 去掉块注释与整行 `//` 注释（尾随 `//` 不处理：本仓这三个字面量不在尾随注释里） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
}

/** 递归收集 src/ 下的源码文件；读目录失败 ⇒ 返回空并让调用方的判据失败 */
function walk(dir: string, out: string[] = []): string[] {
  let ents: { name: string; isDirectory(): boolean; isFile(): boolean }[] = [];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    console.error(`  NOTE  ${path.relative(ROOT, dir)} 读取失败（${e instanceof Error ? e.message : String(e)}）`);
    return out;
  }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(ent.name)) out.push(p);
  }
  return out;
}

console.log("无车文案唯一映射门禁（test-service-text）\n");

/* ─────────────── A 段：七种输入 → 精确字符串（===） ─────────────── */
console.log("[A] 七种输入的精确返回（=== 全等，不用 includes）");

/** 只在 B 段用（A 段故意写死字面量，不引用常量） */
const OFF = NO_VEHICLE_TEXT.offHours;

const CASES: { id: string; input: NoVehicleState | null | undefined; expect: string }[] = [
  // ⚠️ 这里**故意写死字面量**（不引用 `NO_VEHICLE_TEXT`）：否则「常量与函数一起改错」时
  //   A 段会跟着一起变绿 —— 门禁必须能独立判红，见下方 B 段同理。
  { id: "A1", input: "before_first", expect: "非营运时间" },
  { id: "A2", input: "closed", expect: "非营运时间" },
  { id: "A3", input: "after_last", expect: "非营运时间" },
  { id: "A4", input: "open", expect: "暂未发车" },
  { id: "A5", input: "closing", expect: "暂未发车" },
  { id: "A6", input: "no_data", expect: "暂无班次信息" },
  { id: "A7", input: null, expect: "暂无班次信息" },
];
for (const c of CASES) {
  const got = noVehicleText(c.input);
  check(
    c.id,
    `${String(c.input)} ⇒ 精确等于期望串`,
    got === c.expect,
    `实际 ${JSON.stringify(got)} / 期望 ${JSON.stringify(c.expect)}（必须逐字相等，带任何尾巴都判红）`,
  );
}

/* ─────────────── B 段：五字短语长度与逐字相等 ─────────────── */
console.log("[B] 五字短语的长度与逐字相等");

check("B1", "offHours 逐字等于五字短语", OFF === "非营运时间", `实际 ${JSON.stringify(OFF)}`);
check(
  "B2",
  "offHours 码点数 = 5（防「带空格 / 带尾巴」）",
  [...OFF].length === 5,
  `实际长度 ${[...OFF].length}（${JSON.stringify(OFF)}）`,
);
check(
  "B3",
  "offHours 不含任何附加内容（空格 / 点 / 括号 / 分钟数）",
  !/[\s·•（）()：:0-9]/.test(OFF),
  `实际 ${JSON.stringify(OFF)} —— 负责人裁定「仅有这五个字，不加时间等」`,
);

/* ─────────────── B 段续：无车文案不得拼接任何时刻信息 ─────────────── */
console.log("[B4] 无车文案不得含时刻信息（防「非营运时间 · 末班 23:30」复活）");

/**
 * ★ 2026-11-12（负责人裁定）：首末班时刻改由**独立元素**展示（`LrtEta.tsx#clockTextOf`），
 *   无车文案一个字都不许带。本判据把「拼回去」这条路彻底堵死：
 *   只要 `noVehicleText()` 的任何返回值里出现「首班」「末班」或冒号，立刻判红。
 *   ⚠️ 用 `includes` 而不是全等：这里守的是「有没有掺时刻」，全等守不到「五个字 + 尾巴」的变体。
 */
const ALL_STATES: (NoVehicleState | null | undefined)[] = [
  "before_first",
  "closed",
  "after_last",
  "open",
  "closing",
  "no_data",
  null,
  undefined,
];
const FORBIDDEN = ["首班", "末班", ":"];
const offenders: string[] = [];
for (const st of ALL_STATES) {
  const out = noVehicleText(st);
  for (const tok of FORBIDDEN) {
    if (out.includes(tok)) offenders.push(`${String(st)} ⇒ ${JSON.stringify(out)} 含 ${JSON.stringify(tok)}`);
  }
}
check(
  "B4",
  "任意状态的无车文案都不含「首班」「末班」「:」（时刻必须走独立元素）",
  offenders.length === 0,
  offenders.join("；") || "(无)",
);

/* ─────────────── C 段：字面量唯一性（去注释后扫描 src/） ─────────────── */
console.log("[C] 三个字面量在 src/ 的代码里只允许出现在 service-text.ts");

const files = walk(SRC);
check("C0", "src/ 扫描集非空（遍历本身有效）", files.length > 0, `实际扫描到 ${files.length} 个文件`);

/** 正控：同一套遍历找一个必然存在的标识符 —— 0 命中就说明是扫描器失效而不是「真的干净」 */
const positive = files.filter((f) => {
  try {
    return stripComments(readFileSync(f, "utf8")).includes("noVehicleText");
  } catch {
    return false;
  }
});
check(
  "C1",
  "扫描器正控：`noVehicleText` 必须被扫到（为 0 则证明是扫描失效）",
  positive.length > 0,
  `实际命中 ${positive.length} 个文件 —— 为 0 时 C2~C4 的「干净」不可信`,
);

for (const [idx, literal] of ["非营运时间", "暂未发车", "暂无班次信息"].entries()) {
  const hits: string[] = [];
  let unreadable = 0;
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      unreadable++;
      continue;
    }
    if (stripComments(text).includes(literal)) hits.push(path.relative(ROOT, f).split(path.sep).join("/"));
  }
  const onlyOwner = hits.length === 1 && hits[0] === OWNER && unreadable === 0;
  check(
    `C${idx + 2}`,
    `字面量 ${JSON.stringify(literal)} 的命中文件数 = 1 且恰为 ${OWNER}`,
    onlyOwner,
    `命中 ${hits.length} 个：${hits.join(", ") || "(无)"}；读失败 ${unreadable} 个` +
      (unreadable ? "（有文件读不到 ⇒ 默认判失败，不静默通过）" : ""),
  );
}

/* ─────────────── 附注：仅出现在注释里的命中（不判红，但绝不静默） ─────────────── */
{
  const noteHits: string[] = [];
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue; // 读不到已由 C2~C4 的 unreadable 计数判红
    }
    const raw = ["非营运时间", "暂未发车", "暂无班次信息"].filter((l) => text.includes(l));
    const code = ["非营运时间", "暂未发车", "暂无班次信息"].filter((l) => stripComments(text).includes(l));
    if (raw.length && !code.length) {
      noteHits.push(`${path.relative(ROOT, f).split(path.sep).join("/")}（仅注释：${raw.join(" / ")}）`);
    }
  }
  for (const h of noteHits) {
    console.log(`  NOTE  字面量出现在注释里（非映射、不计入 C 段）：${h}`);
  }
}

/* ─────────────── 分母自证 ─────────────── */
const EXPECTED = 17; // A1~A7(7) + B1~B4(4) + C0/C1(2) + C2~C4(3) + D1(1) = 17
check(
  "D1",
  `分母守恒：注册判据数 = ${EXPECTED}`,
  registered.length + 1 === EXPECTED, // +1 = D1 自己（它在 check() 内才入册）
  `实际注册 ${registered.length + 1} 条（加判据却没跑会在这里显形）`,
);

console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
if (fail > 0) process.exit(1);
