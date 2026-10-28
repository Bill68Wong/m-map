#!/usr/bin/env node
/**
 * 发布额度闸（L1 每日硬上限 · 2026-10-28 主人定）
 *
 * 规则：每个澳门自然日 = 1 个「发布窗口」= 最多 1 次 push + 1 次 deploy（成对，合计算 1 次）。
 *       同日第 2 次 push 或第 2 次 deploy 即超限，须主人明示（OWNER_APPROVED=1）。
 *
 * 用法：
 *   node scripts/check-release-allowance.mjs                   # 查今日还能做什么
 *   node scripts/check-release-allowance.mjs --record push     # 执行完 push 后记账
 *   node scripts/check-release-allowance.mjs --record deploy   # 执行完部署后记账
 *   node scripts/check-release-allowance.mjs --status          # 看最近 7 天
 *   OWNER_APPROVED=1 node scripts/check-release-allowance.mjs --record push   # 主人特别允许的追加
 *
 * 退出码：0 = 允许；1 = 该动作今日已用过（除非 OWNER_APPROVED=1）
 *
 * 账本：.workbuddy/risk/release-ledger.json（在 .gitignore 覆盖范围内，不入仓库）
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const LEDGER = join(process.cwd(), ".workbuddy", "risk", "release-ledger.json");
const TZ_OFFSET_MS = 8 * 3600 * 1000; // 澳门 GMT+8
const KINDS = ["push", "deploy", "release"];

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
const doneKinds = new Set(todayEvents.map((e) => e.kind));

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
  console.log(`\n最近 7 天记录：${days.length} 天`);
  process.exit(0);
}

if (recordIdx >= 0) {
  const kind = args[recordIdx + 1];
  if (!KINDS.includes(kind)) {
    console.error(`用法：--record ${KINDS.join("|")}`);
    process.exit(2);
  }
  const already = todayEvents.some((e) => e.kind === kind);
  if (already && !ownerApproved) {
    console.error(`\n[额度闸] ❌ 今日（${today}）已执行过 ${kind}，L1 规定每天每类最多 1 次。`);
    for (const e of todayEvents) console.error(`  · ${e.kind} @ ${e.macauAt}`);
    console.error("\n若主人已明确允许追加，请带环境变量重试：");
    console.error(`  OWNER_APPROVED=1 node scripts/check-release-allowance.mjs --record ${kind}\n`);
    process.exit(1);
  }
  data.events.push({ kind, macauAt: macauTime(), macauDay: today, extra: already || undefined });
  save(data);
  const rest = KINDS.filter((k) => !doneKinds.has(k) && k !== kind);
  console.log(`[额度闸] 已记账：${kind} @ ${macauTime()}${already ? "（主人追加）" : ""}`);
  if (rest.length) console.log(`  本窗口还可执行：${rest.join(" / ")}（成对动作，合计仍算 1 次窗口）`);
  else console.log("  本窗口额度已满，后续动作需主人明示追加。");
  process.exit(0);
}

// 默认：查询今日还能做什么
const remaining = KINDS.filter((k) => !doneKinds.has(k));
if (remaining.length === KINDS.length) {
  console.log(`[额度闸] ✅ 今日（${today}）额度完整 —— 可执行 1 个发布窗口（push + deploy 成对）。`);
  console.log("  发布前请先跑 §3.0 六问自检，并确认已获主人许可。");
  process.exit(0);
}
if (remaining.length > 0) {
  console.log(`[额度闸] ◐ 今日（${today}）已有动作：${[...doneKinds].join(" / ")}`);
  console.log(`  本窗口还可执行：${remaining.join(" / ")}（成对动作，仍算同一次窗口）。`);
  process.exit(0);
}
console.log(`[额度闸] ⛔ 今日（${today}）额度已用尽：`);
for (const e of todayEvents) console.log(`  · ${e.kind} @ ${e.macauAt}${e.extra ? "（主人追加）" : ""}`);
console.log("\nL1 规定：每天 1 个发布窗口（push + deploy 各 1 次）。剩余改动请留到次日。");
console.log("如主人当次明确允许追加：OWNER_APPROVED=1 后再执行并 --record。\n");
process.exit(1);
