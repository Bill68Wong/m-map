#!/usr/bin/env node
/**
 * 提交范围门禁（决策 D1 · 2026-10-28；判据重构 2026-11-16）
 *
 * 目的：仓库只承载「跑起来需要的东西」。数据调研/逆向分析/内部复盘/路演材料
 *       一律留在本地，不进公开仓库。
 *
 * 用法：
 *   node scripts/check-commit-scope.mjs              # 检查已 staged 的文件（pre-commit 钩子调用）
 *   node scripts/check-commit-scope.mjs --all        # 体检：工作区全部未忽略文件 + 存量基线比对
 *   SCOPE_ENFORCE=1 git commit ...                   # 非白名单目录也硬拦（默认只警告）
 *
 * 退出码：0 = 通过；1 = 命中硬拦截
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-11-16 判据重构：从「全文命中」改成「新增行命中 / 存量基线双向 ratchet」
 *
 * 旧实现为什么必须改：它对每个改动文件读**全文**再跑 SENSITIVE。于是
 * `src/lib/dsat/client.ts` 与 `scripts/probe-lang.ts` 永远无法提交 —— 它们命中的是历史
 * 内容，而且删不掉：命中的是**真实要调的接口路径**与**真实函数名**，不是笔误。
 * 唯一出路是 `--no-verify`，那会让门禁全线失效。
 *
 * 两种模式，两条判据，**不要互相代替**：
 *   · 默认（暂存区）= 判据 A：**只判本次新增的行**。
 *     新增文件（A）的 diff 本身就是全部 `+` 行 ⇒ 等价于全文扫描，无需特判。
 *     删除（D）的文件根本不在 `--diff-filter=ACMR` 里 ⇒ 天然不扫。
 *   · `--all`（体检）= 判据 B：**存量不涨**。全文比对 `LEGACY_BASELINE`：
 *     等于基线 ⇒ 存量债免报；大于 ⇒ 新增违规（拦）；小于 ⇒ 基线过期（也拦，须下调）。
 *     扫描对象**只算已跟踪文件**（`git ls-files`，不含 `--others`）—— 未入库文件不属于
 *     「仓库现有存量」，它的防守点在 pre-commit（那时它是状态 A，全文照扫）。详见 trackedFiles()。
 *
 * 规则（允许路径 / 禁止类型 / 敏感特征 / 存量基线）集中在
 * `scripts/lib/push-guard-rules.mjs`，与 `scripts/review-push.mjs` 共用同一份，
 * 禁止各写一套（会漂移成两个都不可信的门）。`SELF_EXEMPT` 亦由该文件导出。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import {
  ALLOW_PREFIX,
  ALLOW_DOCS,
  ALLOW_FILES,
  BLOCK_EXT,
  BLOCK_EXT_ALLOW,
  SELF_EXEMPT,
  MAX_DIFF_BYTES,
  scanSizeVerdict,
  parseAddedLines,
  findSensitiveInAddedLines,
  judgeLegacy,
} from "./lib/push-guard-rules.mjs";

function isAllowed(file) {
  if (ALLOW_FILES.has(file)) return true;
  if (ALLOW_DOCS.some((p) => file.startsWith(p))) return true;
  return ALLOW_PREFIX.some((p) => file.startsWith(p));
}

function git(args, opts = {}) {
  // core.quotepath=false：中文路径保持 UTF-8 原文，否则会被加引号转义成 \xxx，
  // 导致白名单匹配与敏感词扫描对中文文件双双失效（2026-11-05 变异自证发现）。
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
}

function stagedFiles() {
  try {
    const out = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `--all` 的扫描对象：**只算已跟踪文件**（`git ls-files`，**不带 `--others`**）。
 *
 * 为什么不含未入库文件（2026-11-16 定）：
 *   `--all` 回答的问题是「**仓库里现在有什么存量**」。未入库文件不属于仓库，算进来会让
 *   三件事同时说不清：基线该写多少、它将来真提交时算新增还是算存量、体检红了是真是假。
 *   典型例子：`scripts/sync-route-loop-flags.ts` 当前是 `??`，若计入，它的 4 处命中会逼着
 *   基线虚高；可它一提交，这 4 行又是「新增行」。
 *   未入库文件的防守点在 **pre-commit**：`git add` 那一刻它是状态 `A`，全文照扫，一处不漏。
 *   **两个模式职责不重叠，合起来无缺口。**
 *   反面理由同样成立：若 `--all` 也扫未跟踪文件，任何人在本地新建一个探针脚本都会让体检变红，
 *   人就会开始忽略红灯 —— 恒红的门等于没有门。
 */
function trackedFiles() {
  try {
    const out = git(["ls-files"]);
    return [...new Set(out.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    if (!existsSync(file)) return { text: "", missing: true, reason: "工作树中已不存在" };
    if (!statSync(file).isFile()) return { text: "", missing: false, reason: "不是普通文件" };
    const size = statSync(file).size;
    const verdict = scanSizeVerdict(size);
    if (!verdict.ok) {
      /*
       * ⚠️ 这里必须**返回 reason**（调用方据此硬拦），绝不能 `return ""` 静默跳过。
       * 改造前的正是后者：`globals.css`（425 KB）因此多年没被体检过，而门禁一直显示绿。
       */
      return { text: "", missing: false, reason: verdict.reason };
    }
    return { text: readFileSync(file, "utf8"), missing: false, reason: null };
  } catch (e) {
    return { text: "", missing: false, reason: `读取失败：${e.message}` };
  }
}

/**
 * 取某文件在暂存区里的**新增行**。
 * 注意取的是 `--cached`（索引）而不是工作树 —— 提交时要拦的是「即将进库的内容」，
 * 工作树里可能有没 staged 的改动，读工作树会判错对象。
 * @returns {{lines: Array<{line:number,text:string}>} | {error: string}}
 */
function stagedAddedLines(file) {
  let diffText = "";
  try {
    diffText = git(["diff", "--cached", "-U0", "--", file]);
  } catch (e) {
    return { error: `无法取到暂存区 diff：${e.message}` };
  }
  if (Buffer.byteLength(diffText, "utf8") > MAX_DIFF_BYTES) {
    return { error: `diff 超过 ${Math.round(MAX_DIFF_BYTES / 1024)} KB，拒绝静默跳过` };
  }
  return { lines: parseAddedLines(diffText) };
}

const allMode = process.argv.includes("--all");
const enforceScope = process.env.SCOPE_ENFORCE === "1";
const files = allMode ? trackedFiles() : stagedFiles();

if (files.length === 0) {
  console.log(allMode ? "[scope] 无待体检文件，通过。" : "[scope] 无待检查文件，通过。");
  process.exit(0);
}

const hardBlocks = [];
const softWarns = [];
/** 存量债汇总：文件 → 已登记条数（只在 --all 出现，暂存区模式仅在拦截时作为旁注） */
const legacyNotes = new Map();

for (const f of files) {
  const lower = f.toLowerCase();

  // ── ① 禁止入库类型（与判据重构无关，原样保留）────────────────────────
  const ext = BLOCK_EXT_ALLOW.has(f) ? null : BLOCK_EXT.find((e) => lower.endsWith(e));
  if (ext) hardBlocks.push(`${f} —— 禁止入库的二进制/备份类型（${ext}）`);
  if (lower.includes("/.env") || lower === ".env" || lower.startsWith(".env.")) {
    if (!lower.endsWith(".env.example")) hardBlocks.push(`${f} —— 环境文件（凭据）不得入库`);
  }

  // ── ② 提交白名单（默认软警告，SCOPE_ENFORCE=1 时转硬拦）───────────────
  if (!isAllowed(f)) softWarns.push(`${f} —— 不在白名单（src/ public/ scripts/ db/ + 构建配置 + README）`);

  // ── ③ 敏感内容 ────────────────────────────────────────────────────────
  if (SELF_EXEMPT.has(f)) continue;

  if (allMode) {
    /*
     * 判据 B：全文 vs 存量基线（双向 ratchet）。
     *
     * ⚠️ 为什么「基线过期」**只在 `--all` 检查，提交时不查**（2026-11-16 裁决，别当漏项）：
     *   删掉存量行是**正当清理**（`git rm`、精简注释、把数值挪进本地文档）。在 pre-commit 拦它
     *   等于惩罚做对的事，人会立刻学会 `--no-verify` —— 那比漏检更坏。
     *   这项保障由谁承担：`--all`。它已经挂进 `npm run verify`（通过
     *   `scripts/test-guard-scope.ts` 的 E1 对真实仓库逐条对账），每次 verify 都会提醒。
     *   也就是说「减债」不会被漏掉，只是提醒点从提交时前移到了 verify 时。
     *   ⇒ 半年后若有人问「提交时为什么不检测基线过期」，答案在这里，不是忘了写。
     */
    // 判据 B：全文 vs 存量基线（双向 ratchet）
    const { text, missing, reason } = readText(f);
    if (missing) {
      /*
       * 工作树里已不存在（正准备删除）。**删除是清理动作，不是夹带**，
       * 不该因为「读不到」而拦住 —— 与 review-push 里「删除永不构成禁止入库」同一条道理。
       * 但也不能装作扫过了，所以记一条软提示。
       */
      softWarns.push(`${f} —— 工作树中已不存在，本次未做存量扫描（若为删除请忽略）`);
      continue;
    }
    if (reason !== null) {
      // 「没看」不等于「没问题」⇒ 默认方向为失败
      hardBlocks.push(`${f} —— 无法完成存量扫描（${reason}）`);
      continue;
    }
    const { blocks, legacy } = judgeLegacy(f, text);
    for (const b of blocks) {
      if (b.kind === "新增违规") {
        hardBlocks.push(
          `${f} —— ${b.why}：实际 ${b.actual} 处 > 基线 ${b.base} 处（**新增违规**，不是存量债）`,
        );
      } else {
        hardBlocks.push(
          `${f} —— ${b.why}：实际 ${b.actual} 处 < 基线 ${b.base} 处（**基线过期**，请在 scripts/lib/push-guard-rules.mjs 的 LEGACY_BASELINE 里下调到 ${b.actual}；还清了就删掉该条）`,
        );
      }
    }
    if (legacy.length > 0) legacyNotes.set(f, legacy.reduce((n, x) => n + x.actual, 0));
  } else {
    // 判据 A：只判本次新增的行
    // （「删除导致基线过期」不在这里查 —— 由 `--all` 承担，理由见上面判据 B 的注释块。）
    const got = stagedAddedLines(f);
    if ("error" in got) {
      hardBlocks.push(`${f} —— ${got.error}（默认方向为失败，不放行）`);
      continue;
    }
    const hits = findSensitiveInAddedLines(got.lines);
    for (const h of hits) {
      hardBlocks.push(`${f}:${h.line} —— ${h.why}（**本次新增行**）`);
    }
  }
}

if (softWarns.length) {
  console.log("\n[scope] ⚠️ 以下文件不在提交白名单内（决策 D1）：");
  for (const w of softWarns) console.log("  · " + w);
  if (enforceScope) hardBlocks.push(...softWarns.map((w) => w + " [SCOPE_ENFORCE=1]"));
}

if (hardBlocks.length) {
  console.log(`\n[scope] ❌ ${allMode ? "体检" : "提交"}被拦截（${hardBlocks.length} 条）：`);
  for (const b of hardBlocks) console.log("  · " + b);

  if (allMode) {
    console.log("");
    console.log("判据说明（区分「老的」和「新写的」）：");
    if (legacyNotes.size > 0) {
      console.log("  · 存量债（已登记，不计入拦截）：");
      for (const [f, n] of legacyNotes) console.log(`      ${f} —— ${n} 处`);
    }
    console.log("  · 「新增违规」= 有人在老文件里新写了风险内容 ⇒ 删掉新写的那几行。");
    console.log("  · 「基线过期」= 债被还掉了一部分 ⇒ 下调 LEGACY_BASELINE 里的数字（这是好事，但要记账）。");
  } else {
    console.log("");
    console.log("判据说明：只拦**本次新增的行**。文件里历史遗留的命中已登记在");
    console.log("`scripts/lib/push-guard-rules.mjs` 的 LEGACY_BASELINE 里，不阻断正常修改。");
    console.log("处理：删掉你新写的那一行；若确属必要，请与负责人确认后再决定，");
    console.log("**不要把文件加进 SELF_EXEMPT / ALLOW_FILES 了事**（那是把门关掉，不是修门，铁律 46）。");
  }
  console.log("");
  process.exit(1);
}

if (allMode) {
  console.log(
    `[scope] ✅ 体检通过（检查 ${files.length} 个文件；存量债 ${legacyNotes.size} 个文件已登记、与基线一致）`,
  );
  for (const [f, n] of legacyNotes) console.log(`  · 存量债 ${f} —— ${n} 处（已登记，非本次引入）`);
} else {
  console.log(`[scope] ✅ 提交检查通过（检查 ${files.length} 个文件；无本次新增的敏感内容）`);
}
