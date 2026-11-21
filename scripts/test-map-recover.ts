/**
 * 地图长断线自愈 · 判定/预算纯函数回归（scripts/test-map-recover.ts，R8 · 2026-11-21）
 *
 * ── 这个文件守什么 ──────────────────────────────────────────────────────
 *   `src/components/nav/map-recover.ts` 是 R8 全部判据的唯一住所：
 *     探针（canvas 在不在 / 有没有尺寸 / 上下文丢没丢）、预算（≤2 次 / ≥10 分钟 / 30s 冷却）、
 *     以及「轻修之后到底做什么」的裁决。
 *   `NavMap.tsx` 只负责执行动作 —— 也就是说**这里的断言就是 R8 的全部防线**。
 *
 * ── 为什么必须有，而不是"跑一遍看看" ────────────────────────────────────
 *   这一族缺陷**全都是静默的**：
 *     · 把 `zero-size` 排在 `gl-lost` 之后 ⇒ 0 尺寸容器也去重建 ⇒ 白烧一次瓦片配额，无报错；
 *     · 把「重建后 60s 内复发」判反 ⇒ 环境性故障会一路重建到预算用尽，用户从"能修"变成"彻底没图"；
 *     · 把 `hiddenMs === null` 判成"不足 60s" ⇒ 恰好在那批 `visibilitychange` 迟到 14s 的机型上
 *       **永久不自愈**（需求 R8-A③ 点名的场景）；
 *     · 预算读写漏了「滑窗过期但保留 lastAt」 ⇒ 跨窗口瞬间连坐重建两次。
 *   这些都是"编译通过、类型通过、肉眼也看不出"，只能靠断言钉住。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   ① 直接 import **线上同一个函数**（不在脚本里复刻逻辑，`.verify/` 有前科）；
 *   ② 全部正向断言（断言"应该等于什么"），禁 `x || !!x`；
 *   ③ 末尾写「实际比对 N / 预期 M」，少跑即红；
 *   ④ 不碰 DOM / 不连库 / 不需要浏览器（探针的容器用最小 stub 喂进去）。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────
 *   npm run test:map-recover   （= `tsx scripts/test-map-recover.ts`，cwd = 仓库根）
 */
import {
  afterSoftAction,
  bumpBudget,
  BUDGET_WINDOW_MS,
  canAutoRebuild,
  emptyBudget,
  GL_LOST_GRACE_MS,
  HIDDEN_MIN_MS,
  inCooldown,
  isHardEvidence,
  isZeroSize,
  normalizeBudget,
  POST_REBUILD_RELOST_MS,
  probeMap,
  REBUILD_COOLDOWN_MS,
  REBUILD_MAX,
  REBUILD_MIN_GAP_MS,
  shouldProbe,
  SOFT_PROBE_MS,
  type Budget,
} from "../src/components/nav/map-recover";
import { readFileSync } from "node:fs";

let failed = 0;
let compared = 0;
/** 预期断言条数（末尾对账；少跑/漏跑即红） */
const EXPECTED = 39;

const ok = (cond: boolean, name: string, detail = ""): void => {
  compared += 1;
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}  ${detail}`);
  }
};

/* ── 最小 DOM stub（只实现探针真正用到的那一个方法）──────────────────── */
const canvasOf = (w: number, h: number): HTMLCanvasElement => ({ width: w, height: h }) as unknown as HTMLCanvasElement;
const containerOf = (list: HTMLCanvasElement[]): HTMLElement =>
  ({ querySelectorAll: () => list }) as unknown as HTMLElement;

const NOW = 1_760_000_000_000;

console.log("\n═══ 地图长断线自愈（R8）· 判定与预算 ═══\n");

/* ── 一、探针：顺序即优先级 ───────────────────────────────────────────── */
console.log("── 探针 probeMap ──");
ok(probeMap(null, false) === "no-container", "无容器 → no-container（不是失效，是无处可探）");
ok(probeMap(containerOf([]), false) === "no-canvas", "容器内零 canvas → no-canvas（硬事实）");
ok(
  probeMap(containerOf([canvasOf(300, 150)]), false) === "ok",
  "canvas 有尺寸且上下文未丢 → ok",
);
ok(
  probeMap(containerOf([canvasOf(300, 150)]), true) === "gl-lost",
  "canvas 有尺寸但上下文丢失 → gl-lost",
);
ok(
  probeMap(containerOf([canvasOf(0, 150)]), true) === "zero-size",
  "★ 0 尺寸**优先于** gl-lost ⇒ 返回 zero-size（否则会违反 R8-C①「0 尺寸不许重建」）",
  `实际 ${probeMap(containerOf([canvasOf(0, 150)]), true)}`,
);
ok(
  probeMap(containerOf([canvasOf(300, 150), canvasOf(300, 0)]), false) === "zero-size",
  "★ 多 canvas 时**任一张**为 0 即 zero-size（只查第一张会漏）",
);
ok(isHardEvidence("no-canvas") && isHardEvidence("gl-lost"), "硬证据集合 = {no-canvas, gl-lost}");
ok(
  !isHardEvidence("zero-size") && isZeroSize("zero-size"),
  "★ zero-size **不在**硬证据集合内（它属「禁止重建」档，不属「该重建」档）",
);

/* ── 二、触发准入：时长只决定"何时探" ─────────────────────────────────── */
console.log("\n── 触发准入 shouldProbe ──");
ok(shouldProbe("visible", HIDDEN_MIN_MS) === true, "驻留正好 60s → 放行（>= 边界含等号）");
ok(shouldProbe("visible", HIDDEN_MIN_MS - 1) === false, "驻留 59.999s → 不探");
ok(
  shouldProbe("visible", null) === true,
  "★ hiddenAt 缺失（这类机型 hidden 事件根本没来）→ **放行**；判成「不足 60s」会让它们永久不自愈",
);
ok(shouldProbe("pageshow", 2 * HIDDEN_MIN_MS) === true, "pageshow + 长驻留 → 放行");
ok(
  shouldProbe("online" as unknown as "visible", 10 * HIDDEN_MIN_MS) === false,
  "★ online 不是合法入口（R8-B：只说明网络，且隐藏时也会触发）",
);

/* ── 三、预算：滑窗 / 三条闸门 / 冷却 ─────────────────────────────────── */
console.log("\n── 预算 Budget ──");
const zero = emptyBudget(NOW);
ok(zero.count === 0 && zero.lastAt === null, "空预算 = count 0 / lastAt null");
ok(
  normalizeBudget({ count: 2, windowStart: NOW - BUDGET_WINDOW_MS - 1, lastAt: NOW - 5000 }, NOW).count === 0,
  "滑窗过期 → count 归零（开新窗口）",
);
ok(
  normalizeBudget({ count: 2, windowStart: NOW - BUDGET_WINDOW_MS - 1, lastAt: NOW - 5000 }, NOW).lastAt === NOW - 5000,
  "★ 滑窗过期时 **lastAt 必须保留**（否则跨窗口那一瞬冷却失效、可能连坐重建两次）",
);
ok(normalizeBudget("不是对象", NOW).count === 0, "脏数据（非对象）→ 当 0 次，不抛错");

ok(canAutoRebuild({ count: REBUILD_MAX, windowStart: NOW, lastAt: null }, NOW).ok === false, "已用满 2 次 → 不再自动重建");
ok(
  canAutoRebuild({ count: 1, windowStart: NOW, lastAt: NOW - REBUILD_MIN_GAP_MS + 1 }, NOW).ok === false,
  "距上次重建 9:59.999 → 不足 10 分钟，不动手",
);
ok(
  canAutoRebuild({ count: 1, windowStart: NOW, lastAt: NOW - REBUILD_MIN_GAP_MS }, NOW).ok === true,
  "距上次重建正好 10 分钟 → 放行（>= 边界含等号）",
);
ok(
  inCooldown({ count: 1, windowStart: NOW, lastAt: NOW - REBUILD_COOLDOWN_MS + 1 }, NOW) === true &&
    inCooldown({ count: 1, windowStart: NOW, lastAt: NOW - REBUILD_COOLDOWN_MS }, NOW) === false,
  "冷却 30s：29.999s 内静默，满 30s 解除",
);

/* ── 四、裁决：轻修之后到底做什么 ─────────────────────────────────────── */
console.log("\n── 裁决 afterSoftAction ──");
const fresh: Budget = emptyBudget(NOW);
ok(afterSoftAction("ok", fresh, NOW).action === "none", "两次探针都干净 → none（只记 soft，不动实例）");
ok(
  afterSoftAction("zero-size", { count: REBUILD_MAX, windowStart: NOW, lastAt: null }, NOW).action === "layout",
  "★ 0 尺寸在**预算耗尽**时仍是 layout（禁止重建这条与预算无关）",
);
ok(
  afterSoftAction("gl-lost", { count: 1, windowStart: NOW, lastAt: NOW - POST_REBUILD_RELOST_MS }, NOW).action ===
    "degrade",
  "★ 重建后 60s 内又丢上下文 → degrade（停自动，不再试）",
);
ok(
  afterSoftAction("gl-lost", { count: 1, windowStart: NOW, lastAt: NOW - POST_REBUILD_RELOST_MS - 1 }, NOW).reason ===
    "gap",
  "★ 重建后 61s 再丢 → 被**10 分钟间隔**挡住（reason 必须是 gap，不是 relost —— 排障要能分清这两条）",
  `实际 ${afterSoftAction("gl-lost", { count: 1, windowStart: NOW, lastAt: NOW - POST_REBUILD_RELOST_MS - 1 }, NOW).reason}`,
);
ok(
  afterSoftAction("gl-lost", { count: 1, windowStart: NOW, lastAt: NOW - REBUILD_MIN_GAP_MS }, NOW).action === "rebuild",
  "隔满 10 分钟后再丢 → 允许 rebuild（硬证据 + 闸门全过）",
);
ok(
  afterSoftAction("no-canvas", { count: REBUILD_MAX, windowStart: NOW, lastAt: null }, NOW).action === "degrade",
  "预算用尽 + 硬证据 → degrade（给占位 + 人工按钮）",
);
ok(
  afterSoftAction("no-container", fresh, NOW).action === "none",
  "no-container（组件正在卸载）→ none，不得当成失效去重建",
);
const bumped = bumpBudget({ count: 0, windowStart: NOW, lastAt: null }, NOW);
ok(bumped.count === 1 && bumped.lastAt === NOW, "bumpBudget：count+1 且写入 lastAt（同帧可读）");

/* ── 末尾对账 ─────────────────────────────────────────────────────────── */
const probeSum = SOFT_PROBE_MS[0] < SOFT_PROBE_MS[1] && SOFT_PROBE_MS[0] > 0;
ok(probeSum, "轻修探点序 = [0, 300, 600]ms（首探 300 早于复探 600）");
ok(GL_LOST_GRACE_MS === 30_000, "上下文宽限期 = 30s（R8-A① 的原文数值，改它等于改需求）");

/* ── 五、接线断言（源码文本锁 + 变异对照）─────────────────────────────────
   纯函数覆盖不到"effect 依赖 / 状态粘住 / 定时器排程"这三类接线缺陷 —— 它们
   **编译通过、类型通过、单测全绿**，只是行为不对（本项目把这类叫"沉默逻辑错误"）。
   ⇒ 用源码文本锁 + **反向变异对照**（把信号删掉，断言必须变假）。
   ⚠️ 文本锁故意写得宽松（只锁"有这个东西"），不锁格式 —— 否则改个换行就红。 */
console.log("\n── 接线断言（源码文本锁）──");
const readSrc = (rel: string): string => {
  try {
    return readFileSync(rel, "utf8");
  } catch {
    return "";
  }
};
const NAVMAP = readSrc("src/components/nav/NavMap.tsx");
const RIDE = readSrc("src/components/nav/useRideTracking.ts");

/** ① 路线取景 effect 的依赖数组里必须含实例代际 `mapGen` */
const routeDeps = (src: string): string => /\}, \[routeLine, applyCamera([^\]]*)\]\);/.exec(src)?.[1] ?? "";
ok(
  routeDeps(NAVMAP).includes("mapGen"),
  "[接线①] 路线取景 effect 依赖含 `mapGen`（缺了它：地图重建后彩色路线不回来）",
  `实际依赖尾段 "${routeDeps(NAVMAP).trim()}"`,
);
ok(
  routeDeps(NAVMAP.replace("}, [routeLine, applyCamera, mapGen]);", "}, [routeLine, applyCamera]);")).includes("mapGen") ===
    false,
  "[变异①] 把 `mapGen` 从依赖里删掉时，上一条必须为假（防「写了断言但永远绿」）",
);

/** ② 「一键确认」必须粘住：`?? prev` 不能少 */
const STICKY = /setMatchConfirmPlate\(\(prev\) => out\.confirmPlate \?\? prev\)/;
ok(STICKY.test(RIDE), "[接线②] `matchConfirmPlate` 用 `?? prev` 粘住（低置信帧不得抹掉按钮）");
ok(
  STICKY.test(RIDE.replace("out.confirmPlate ?? prev", "out.confirmPlate")) === false,
  "[变异②] 把 `?? prev` 去掉（退回每帧覆盖）时，上一条必须为假",
);
/** 清零点守恒：只允许 7 处显式清空，且**不含**低置信分支 */
const clears = (RIDE.match(/setMatchConfirmPlate\(null\)/g) ?? []).length;
ok(
  clears === 7,
  "[接线②] `setMatchConfirmPlate(null)` 恰好 7 处（分段重置/锁牌/自动上车/手动选车/换车/用户确认/回等车）",
  `实际 ${clears} 处`,
);

/** ③ 宽限期到点必须补一次复探，且只排一次 */
const GRACE_RETRY = /if \(!graceRetryPlanned\) \{[\s\S]{0,240}?graceRetryPlanned = true;[\s\S]{0,600}?softThenProbe\(\);/;
ok(
  GRACE_RETRY.test(NAVMAP),
  "[接线③] gl-grace 分支排一次到点复探（`graceRetryPlanned` 守 + 调同一条 `softThenProbe()`）",
);
ok(
  NAVMAP.includes('markProbe("gl-lost", "gl-grace-retry", { counts: false })'),
  "[接线③] 复探留新 reason `gl-grace-retry`（与「宽限期内不下判」的 `gl-grace` 分开）",
);
ok(
  GRACE_RETRY.test(NAVMAP.replace("if (!graceRetryPlanned) {", "if (true) {")) === false,
  "[变异③] 去掉「只排一次」的守（改成 `if (true)`）时，接线③必须为假",
);

console.log(`\n═══ 实际比对 ${compared} 条 / 预期 ${EXPECTED} 条 ═══`);
if (compared !== EXPECTED) {
  console.error(`  FAIL  断言条数不符：实际 ${compared} ≠ 预期 ${EXPECTED}（有断言被删/漏跑）`);
  failed += 1;
}
console.log(failed === 0 ? "\n✅ 全通过\n" : `\n❌ FAIL ${failed} 条\n`);
process.exit(failed === 0 ? 0 : 1);
