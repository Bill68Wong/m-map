/**
 * README 版本号同步门禁（`scripts/test-readme-version.ts`，2026-11-17 新建）
 *
 * ── 这个文件守什么 ──────────────────────────────────────────────────────
 *   `scripts/sync-readme-version.ts` 的 `applyVersion()` 决定 README 里那句
 *   `当前版本 **v<!-- app-version -->4.2.1<!-- /app-version -->**。` 会被改成什么。
 *   它是**纯函数**，没有 I/O ⇒ 这里的断言就是它全部的防线。
 *
 *   三道口子，任何一道漏掉都会「上线后才发现」：
 *     · 命中 0 处却默默跳过 ⇒ 版本从此**永久冻结**，不报错、不更新、没人发现（最坏的失败形态）；
 *     · 命中 ≥2 处还去替换 ⇒ 改到了不该改的地方；
 *     · 正则把区间外的 `v` 和 `**` 一起吃掉 ⇒ README 渲染成 `v4.2.1**` 之类的残句。
 *
 * ── 为什么除了纯函数还要断言「真实文件」────────────────────────────────
 *   ①②⑤⑥ 全在自造样本上跑。自造样本永远同步、永远只有一对标记 ——
 *   而真实 README 可能**已经**和 `package.json` 不一致（那正是本门禁存在的理由）。
 *   ⑦⑧ 直接读仓库里的 `README.md` 与 `package.json`，断言的是**此刻这一份真文件**，
 *   这才是挂进 `npm run verify` 后真正能拦住过期版本的那两条。
 *
 * ── 铁律 44c 四项 ──────────────────────────────────────────────────────
 *   ① 用例集合非空（⑦ 带 `package.json version 非空` 自检）；
 *   ② 集合尺寸 == 枚举出的分支数（`applyVersion` 只有三种走向：命中 1 处替换、
 *      命中 0 处抛错、命中 ≥2 处抛错 —— 三条都有断言）；
 *   ③ 末尾写明「比对 N 条 / 预期 M 条」；
 *   ④ 全部**正向**断言（断言「应该等于什么」），禁 `x || !!x`。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────
 *   npm run test:readme-version   （= `tsx scripts/test-readme-version.ts`）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyVersion } from "./sync-readme-version";

/** 仓库根：按本文件位置推算，不依赖 cwd */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = path.join(ROOT, "README.md");
const PKG_PATH = path.join(ROOT, "package.json");

let failed = 0;
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

/** 把「起始标记 … 结束标记」整段抹成 `§`，用于比较区间外的字节是否被动过 */
const stripMarked = (s: string): string =>
  s.replace(/<!-- app-version -->[\s\S]*?<!-- \/app-version -->/g, "§");

/** 捕获 `applyVersion` 抛出的错误文案；没抛则返回 null（三元走不到，故用显式分支） */
const catchMsg = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

console.log("── ① 正常替换：标记区间的旧版本被换成新版本 ──");
{
  const src = "…**v<!-- app-version -->1.2.3<!-- /app-version -->**…";
  const got = applyVersion(src, "4.2.1");
  eq(got, "…**v<!-- app-version -->4.2.1<!-- /app-version -->**…", "① 1.2.3 被替换为 4.2.1");
}

console.log("\n── ② 幂等：同步过的内容再跑一次必须逐字节相同 ──");
{
  const src = "…**v<!-- app-version -->1.2.3<!-- /app-version -->**…";
  const once = applyVersion(src, "4.2.1");
  const twice = applyVersion(once, "4.2.1");
  eq(twice, once, "② 对结果再跑一次，逐字节相同（否则 verify 会因重复写入而抖动）");
}

console.log("\n── ③ 标记缺失：必须抛错，不许默默跳过 ──");
{
  const src = "当前版本 **v4.2.1**（这里原本有标记，被删了）";
  const msg = catchMsg(() => applyVersion(src, "4.2.1"));
  ok(msg !== null, "③ 标记命中 0 处 ⇒ 必须抛错（默默跳过 = 版本永久冻结）");
  ok((msg ?? "").includes("标记"), "③ 错误文案必须含「标记」二字", `实际=${JSON.stringify(msg)}`);
  ok((msg ?? "").includes("0 处"), "③ 错误文案必须写明实际命中 0 处", `实际=${JSON.stringify(msg)}`);
}

console.log("\n── ④ 标记重复：必须抛错，拒绝猜该改哪一处 ──");
{
  const src =
    "A **v<!-- app-version -->1.0.0<!-- /app-version -->** " +
    "B <!-- app-version -->2.0.0<!-- /app-version --> C";
  const msg = catchMsg(() => applyVersion(src, "4.2.1"));
  ok(msg !== null, "④ 标记命中 2 处 ⇒ 必须抛错（猜错就是改到别处）");
  ok((msg ?? "").includes("2 处"), "④ 错误文案必须写明实际命中 2 处", `实际=${JSON.stringify(msg)}`);
}

console.log("\n── ⑤ 只动中间：`v` 与 `**` 在标记外，不得被吞 ──");
{
  const src = "X **v<!-- app-version -->1.2.3<!-- /app-version -->** Y";
  const got = applyVersion(src, "9.9.9");
  ok(
    got.includes("**v<!-- app-version -->9.9.9<!-- /app-version -->**"),
    "⑤ 标记外的 `**v` 与 `**` 原样保留",
    `实际=${JSON.stringify(got)}`,
  );
  eq(got, "X **v<!-- app-version -->9.9.9<!-- /app-version -->** Y", "⑤ 整串精确相等（前后缀一并保留）");
}

console.log("\n── ⑥ 非标记部分逐字不变（含 CRLF 行尾）──");
{
  const src = [
    "# 标题",
    "第一行不动",
    "当前版本 **v<!-- app-version -->1.0.0<!-- /app-version -->**。说明。",
    "第三行不动",
    "末尾不动",
  ].join("\r\n");
  const got = applyVersion(src, "4.2.1");
  eq(got, src.replace("1.0.0", "4.2.1"), "⑥ 多行样本：除版本数字外逐字节一致（CRLF 未被改写）");
  eq(stripMarked(got), stripMarked(src), "⑥ 把标记区间整段抹掉后，两串完全相同（区间外零改动）");
}

console.log("\n── ⑦ 真实文件一致性：此刻仓库里的 README 已与 package.json 同步 ──");
{
  const readme = fs.readFileSync(README_PATH, "utf8");
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as { version?: string };
  const version = (pkg.version ?? "").trim();
  ok(version.length > 0, "⑦ package.json 的 version 非空（分母非空自检）");
  // 断言语义就是「applyVersion(README) === README」，但失败详情只吐两个版本号而不是整份
  // README（3.6KB × 2 的 dump 会把真正的原因埋掉，正是本仓反复抱怨的「极难分诊」）。
  const markedNow = (readme.match(/<!-- app-version -->([\s\S]*?)<!-- \/app-version -->/) ?? [])[1] ?? "(读不到)";
  ok(
    applyVersion(readme, version) === readme,
    `⑦ 真实 README 已是 v${version}（不同步则此处红，并让 verify 整链红）`,
    `README 标记区间=v${markedNow} / package.json=v${version}（修复：npm run docs:sync-version）`,
  );
}

console.log("\n── ⑧ 真实 README 的标记结构：起止各一，合计 2 次 ──");
{
  const readme = fs.readFileSync(README_PATH, "utf8");
  eq((readme.match(/app-version/g) ?? []).length, 2, "⑧ app-version 恰好出现 2 次（起/止各一）");
  eq((readme.match(/<!-- app-version -->/g) ?? []).length, 1, "⑧ 起始标记恰好 1 个");
  eq((readme.match(/<!-- \/app-version -->/g) ?? []).length, 1, "⑧ 结束标记恰好 1 个");
}

// ───────────────────────────── 条数对账 ─────────────────────────────
/** 预期断言条数（改断言必须同步；少跑/漏跑即红） */
const EXPECTED = 16;
console.log("");
if (compared !== EXPECTED) {
  failed++;
  console.log(`  FAIL  比对条数与预期不符：实际=${compared} / 预期=${EXPECTED}（有断言被删或漏跑）`);
}
console.log(
  failed === 0
    ? `\n✅ 全通过（比对 ${compared} 条 / 预期 ${EXPECTED} 条）：①~⑥ 纯函数边界 + ⑦⑧ 真实文件同步与标记结构`
    : `\n❌ ${failed} 项失败（比对 ${compared} 条）`,
);
process.exit(failed === 0 ? 0 : 1);
