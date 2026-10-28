#!/usr/bin/env node
/**
 * 发布额度闸（L1 每日硬上限 · 2026-10-28 主人定）
 *
 * 规则：GitHub push 与 Vercel 生产部署合并计算，**澳门时间每个自然日最多 1 次「发布窗口」**。
 *       窗口内 push + deploy 成对执行算同一次；分两次做即超限。
 *
 * 用法：
 *   node scripts/check-release-allowance.mjs              # 查今日额度过没过（未过 exit 0 / 已用 exit 1）
 *   node scripts/check-release-allowance.mjs --record push    # 执行完 push 后记账
 *   node scripts/check-release-allowance.mjs --record deploy  # 执行完部署后记账
 *   node scripts/check-release-allowance.mjs --status     # 看最近 7 天
 *   OWNER_APPROVED=1 node scripts/check-release-allowance.mjs --record push   # 主人特别允许的追加
 *
 * 退出码：0 = 允许；1 = 今日额度已用尽（除非 OWNER_APPROVED=1）
 *
 * 账本：.workbuddy/risk/release-ledger.json（在 .gitignore 覆盖范围内，不入仓库）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const LEDGER = join(process.cwd(), ".workbuddy", "risk", "release-ledger.json");
const TZ_OFFSET_MS = 8 * 3600 * 1000; // 澳门 GMT+8

/** 澳门自然日 key：YYYY-MM-DD */
function macauDay(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

/** 澳门时间可读串 */
function macauTime(d = new Date()) {
  return new Date(d.getTime() + TZ_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19);
}

function load() {
  try {
    if (!existsSync(LEDGER)) return { events: [] };
    const j = JSON.parse(readFileSync(LEDGER, "utf8"));
    return Array.isArray(j.events) ? j : { events: [] };
  } catch {
    return { events: [] };
  }
}

function save(data) {
  mkdirSync(dirname(LEDGER), { recursive: true });
  writeFileSync(LEDGER, JSON.stringify(data, null, 2) + "\n", "utf8");
}

const args = process.argv.slice(2);
const recordIdx = args.indexOf("--record");
const isStatus = args.includes("--status");
const ownerApproved = process.env.OWNER_APPROVED === "1";
const today = macauDay();

const data = load();
const todayEvents = data.events.filter((e) => (e.macauDay ?? "") === today);

/** 今日已占用的窗口数：同日多条记录仍算 1 个窗口（push+deploy 成对） */
function windowsUsed(events) {
  const days = new Set(events.map((e) => e.macauDay));
  return days.size; // 只用于 status 展示
}

if (isStatus) {
  console.log(`澳门今日：${today} ${macauTime()}\n`);
  const byDay = {};
  for (const e of data.events) {
    byDay[e.macauDay] = byDay[e.macauDay] || [];
    byDay[e.macauDay].push(`${e.kind}${e.extra ? "(主人追加)" : ""} @${e.macauAt}`);
  }
  const days = Object.keys(byDay).sort().slice(-7);
  if (!days.length) console.log("账本为空 —— 尚无发布记录。");
  for (const d of days) console.log(`${d}  ${d === today ? "←今日" : ""}\n    ${byDay[d].join("\n    ")}`);
  console.log(`\n最近 7 天使用窗口数：${windowsUsed(data.events.filter((e) => days.includes(e.macauDay)))}`);
  process.exit(0);
}

if (recordIdx >= 0) {
  const kind = args[recordIdx + 1];
  if (!["push", "deploy", "release"].includes(kind)) {
    console.error("用法：--record push|deploy|release");
    process.exit(2);
  }
  const extra = todayEvents.length > 0;
  if (extra && !ownerApproved) {
    console.error(`\n[额度闸] ❌ 今日（${today}）已有发布记录，L1 规定每天最多 1 次。`);
    for (const e of todayEvents) console.error(`  · ${e.kind} @ ${e.macauAt}`);
    console.error("\n若主人已明确允许追加，请带环境变量重试：");
    console.error("  OWNER_APPROVED=1 node scripts/check-release-allowance.mjs --record " + kind + "\n");
    process.exit(1);
  }
  data.events.push({
    kind,
    macauAt: macauTime(),
    macauDay: today,
    extra: extra || undefined,
  });
  save(data);
  console.log(`[额度闸] 已记账：${kind} @ ${macauTime()}（今日${extra ? "追加，主人已批准" : "首个窗口"}）`);
  process.exit(0);
}

// 默认：查询今日是否还有额度
if (todayEvents.length === 0) {
  console.log(`[额度闸] ✅ 今日（${today}）额度可用 —— 可执行 1 次发布窗口。`);
  console.log("  发布前请先跑 §3.0 六问自检，并确认已获主人许可。");
  process.exit(0);
}

console.log(`[额度闸] ⛔ 今日（${today}）额度已用尽：`);
for (const e of todayEvents) console.log(`  · ${e.kind} @ ${e.macauAt}${e.extra ? "（主人追加）" : ""}`);
console.log("\nL1 规定：每天最多 1 次「发布窗口」。剩余 commit 请留到次日窗口。");
console.log("如主人当次明确允许追加：OWNER_APPROVED=1 后再执行并 --record。\n");
process.exit(1);
