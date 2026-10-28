#!/usr/bin/env node
/**
 * 发版命名生成器（规范发版流程 · v3 · 2026-10-28 主人定）
 *
 * 目标：**主人只需点两下确认，不需要手改任何名字。**
 * 原理：Vercel 部署名 = 被部署提交的标题。所以让「最后一个 commit」的标题就是
 *       规范名，再用 Rebase and merge 合并（不产生 Merge pull request 那样的默认标题）。
 *
 * 用法：
 *   node scripts/release-plan.mjs "新增风控脚本与发版流程"
 *   node scripts/release-plan.mjs "新增风控脚本与发版流程" --ascii   # 分支退化 ASCII（编码异常备选）
 *
 * 命名规范（四处同名，全部自动）：
 *   分支        vX.Y.Z-<概述>     v3.5.6-新增风控脚本与发版流程
 *   PR 标题     同分支名          （GitHub 自动带入，不用打）
 *   最后 commit vX.Y.Z <概述>     v3.5.6 新增风控脚本与发版流程   ← 决定 Vercel 显示名
 *   tag         vX.Y.Z            v3.5.6                        ← 合并后再打（可选）
 *
 * <概述> 写法：简洁概述「改了什么」，动宾短语，8~20 字。不要极简标签（风控/优化/修复），
 *              也不要超过 25 字（GitHub 列表与 Vercel 面板会截断）。
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ascii = process.argv.includes("--ascii");
const summary = args[0];

if (!summary) {
  console.error('用法：node scripts/release-plan.mjs "新增风控脚本与发版流程" [--ascii]');
  process.exit(2);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
const tag = `v${version}`;
const text = summary.trim();

/** 去掉会破坏 ref 名的字符（空格、斜杠、~^:?*[\ 等） */
function safeSlug(s) {
  return s
    .trim()
    .replace(/[\s~^:?*[\\/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** ASCII 退化：非 ASCII 一律换连字符（分支名编码出问题时的备选） */
function asciiSlug(s) {
  return safeSlug(s.replace(/[^\x20-\x7E]+/g, "-"));
}

const slug = ascii ? asciiSlug(text) || "release" : safeSlug(text);
const branch = `${tag}-${slug}`;
const commitTitle = `${tag} ${text}`;

let lastTag = "(无)";
try {
  lastTag = execFileSync("git", ["describe", "--tags", "--abbrev=0"], { encoding: "utf8" }).trim();
} catch {}

const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("??"))
  .join("\n");

console.log(`\n=== 发版计划 · ${commitTitle} ===\n`);
console.log(`  版本号        ${version}${lastTag === tag ? "   ⚠️ 与最近 tag 相同，确认是否忘了 bump" : `   （上一版 ${lastTag}）`}`);
console.log(`  分支名        ${branch}`);
console.log(`  最后 commit   ${commitTitle}      ← Vercel 会显示这个名字`);
console.log(`  PR 标题       ${branch}      ← 网页自动带入，不用打`);
console.log(`  tag           ${tag}      ← 合并后再打，可选`);

// 概述长度/质量检查
const len = [...text].length;
if (len < 4) {
  console.log(`\n⚠️ 概述只有 ${len} 字，信息量太低（至少 4 字，建议 8~20 字）`);
} else if (len > 25) {
  console.log(`\n⚠️ 概述 ${len} 字，超过 25 字会在 GitHub 列表与 Vercel 面板被截断`);
}
console.log("");

console.log("--- 主人要做的（只有两下）---");
console.log("  ① 打开 GitHub 弹出的 Compare & pull request → 点 Create pull request");
console.log("  ② 点 Rebase and merge → 再点一次确认\n");

console.log("--- 前提设置（一次性，仓库 Settings 里做）---");
console.log("  Settings → General → Pull Requests → 只勾 Allow rebase merging");
console.log("  （关掉 Allow merge commits / Allow squash merging，这样默认就只有 Rebase 一个按钮）\n");

console.log("--- 我这边执行 ---");
for (const s of [
  `1. bump package.json → ${version}`,
  "2. npx tsc --noEmit && npm run lint && npm run build（三条全绿）",
  "3. node scripts/check-commit-scope.mjs（提交范围门禁）",
  `4. commit（中间提交用语义式；**最后一个标题必须是 ${commitTitle}**）`,
  `5. git push origin HEAD:refs/heads/${branch}`,
  "6. 你点两下（见上）",
  "7. 我同步本地 main（fetch + update-ref，不用 reset --hard）",
  `8. 可选：打 tag ${tag} 并推送（算当日第 2 次 push，需你点头）`,
  "9. node scripts/check-release-allowance.mjs --record push|deploy 记账",
]) console.log("  " + s);

if (dirty) {
  console.log("\n⚠️ 工作区有未提交的已跟踪改动，先处理再发版：");
  console.log(dirty.split("\n").map((l) => "  " + l).join("\n"));
}
console.log("");
