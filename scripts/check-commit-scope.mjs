#!/usr/bin/env node
/**
 * 提交范围门禁（决策 D1 · 2026-10-28）
 *
 * 目的：仓库只承载「跑起来需要的东西」。数据调研/逆向分析/内部复盘/路演材料
 *       一律留在本地，不进公开仓库。
 *
 * 用法：
 *   node scripts/check-commit-scope.mjs              # 检查已 staged 的文件（pre-commit 钩子调用）
 *   node scripts/check-commit-scope.mjs --all        # 检查工作区全部未忽略文件（体检）
 *   SCOPE_ENFORCE=1 git commit ...                   # 非白名单目录也硬拦（默认只警告）
 *
 * 退出码：0 = 通过；1 = 命中硬拦截（敏感内容）
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";

/** 允许进入仓库的路径前缀 */
const ALLOW_PREFIX = ["src/", "public/", "scripts/", "db/"];

/** 允许进入仓库的单文件 */
const ALLOW_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "eslint.config.mjs",
  "vercel.json",
  ".gitignore",
  ".env.example",
  "README.md",
  "next-env.d.ts",
]);

/** 扩展名硬拦截：二进制大件 / 备份 / 环境文件 */
const BLOCK_EXT = [".pptx", ".mp4", ".mov", ".dump", ".sql", ".gz", ".zip"];

/** 敏感内容特征：命中即硬拦（这些是「绕过访问控制」的说明书特征） */
const SENSITIVE = [
  { re: /macauweb/i, why: "DSAT 内部接口路径" },
  { re: /getRouteAndCompanyList|getRouteData\.html/i, why: "DSAT 未公开接口名" },
  { re: /genToken|token\s*=\s*md5|md5\(qs\)/i, why: "DSAT 鉴权签名实现" },
  { re: /签名算法|已破解|已逆向|逆向非公开接口|抓包破解/i, why: "逆向分析描述" },
  { re: /次\s*\/\s*秒|次\/秒|req\/s/i, why: "采集强度指标（易被判异常使用）" },
  { re: /DATABASE_URL\s*=\s*postgres/i, why: "疑似真实数据库连接串" },
  { re: /\beyJ[A-Za-z0-9_-]{20,}\b/, why: "疑似 JWT / Token 明文" },
  { re: /sbp_[A-Za-z0-9]{20,}/, why: "疑似 Supabase 密钥" },
];

/** 自身豁免：本脚本的敏感词表里就含这些字面量，扫自己必然误报 */
const SELF_EXEMPT = new Set(["scripts/check-commit-scope.mjs"]);

function isAllowed(file) {
  if (ALLOW_FILES.has(file)) return true;
  return ALLOW_PREFIX.some((p) => file.startsWith(p));
}

function stagedFiles() {
  try {
    const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      encoding: "utf8",
    });
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function workingFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    });
    return [...new Set(out.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function readText(file) {
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return "";
    if (statSync(file).size > 400 * 1024) return ""; // 大文件不读全文
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const enforceScope = process.env.SCOPE_ENFORCE === "1";
const files = process.argv.includes("--all") ? workingFiles() : stagedFiles();

if (files.length === 0) {
  console.log("[scope] 无待检查文件，通过。");
  process.exit(0);
}

const hardBlocks = [];
const softWarns = [];

for (const f of files) {
  const lower = f.toLowerCase();
  const ext = BLOCK_EXT.find((e) => lower.endsWith(e));
  if (ext) hardBlocks.push(`${f} —— 禁止入库的二进制/备份类型（${ext}）`);
  if (lower.includes("/.env") || lower === ".env" || lower.startsWith(".env.")) {
    if (!lower.endsWith(".env.example")) hardBlocks.push(`${f} —— 环境文件（凭据）不得入库`);
  }

  if (!isAllowed(f)) softWarns.push(`${f} —— 不在白名单（src/ public/ scripts/ db/ + 构建配置 + README）`);

  if (SELF_EXEMPT.has(f)) continue;

  const text = readText(f);
  if (!text) continue;
  for (const { re, why } of SENSITIVE) {
    if (re.test(text)) hardBlocks.push(`${f} —— ${why}（命中 ${re.source}）`);
  }
}

if (softWarns.length) {
  console.log("\n[scope] ⚠️ 以下文件不在提交白名单内（决策 D1）：");
  for (const w of softWarns) console.log("  · " + w);
  if (enforceScope) hardBlocks.push(...softWarns.map((w) => w + " [SCOPE_ENFORCE=1]"));
}

if (hardBlocks.length) {
  console.log("\n[scope] ❌ 提交被拦截：");
  for (const b of hardBlocks) console.log("  · " + b);
  console.log("\n处理方式：把这些内容移到本地目录（docs/ .verify/ .workbuddy/ 均已被 .gitignore 覆盖），");
  console.log("或确属必要文件时把它们加入 scripts/check-commit-scope.mjs 的白名单。");
  console.log("临时绕过：git commit --no-verify（不建议）。\n");
  process.exit(1);
}

console.log(`[scope] ✅ 通过（检查 ${files.length} 个文件）`);
