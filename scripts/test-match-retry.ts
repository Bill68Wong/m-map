/**
 * 未锁车牌定期重试 · 状态机回归（scripts/test-match-retry.ts，R11 · 2026-11-21）
 *
 * ── 这个文件守什么 ──────────────────────────────────────────────────────
 *   `src/components/nav/match-retry.ts` 是 R11 的**全部判据**：节奏（预热帧/降频）、
 *   双帧确认（high 才写库、medium 只给按钮）、6 条放弃条件。`useRideTracking` 只执行动作。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────────
 *   这一族错误**全部静默**、且后果不可逆（误锁 ⇒ 报站错位 ⇒ 坐过站）：
 *     · 双帧确认退化成单帧 ⇒ 一次巧合就锁牌，任何界面都不报错；
 *     · 车牌从 A 变 B 时不重置计数 ⇒ 两辆车的证据被当成一辆（**最隐蔽**的一条）；
 *     · 降频闸写成 `>` 而不是 `<` ⇒ 永远不跑，或永远全速跑（两条都"看起来在工作"）；
 *     · 放弃条件把「不知道」当成「满足」⇒ 一上车就因为 `null` 放弃，永不重试。
 *
 * ── 铁律 ────────────────────────────────────────────────────────────────
 *   ① 直接 import 线上同一函数；② 全正向断言；③ 末尾对账条数；④ 不碰 DOM。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────
 *   npm run test:match-retry
 */
import {
  abandonOf,
  begin,
  createRetryState,
  note,
  retryTag,
  RETRY_AMBIG_GAP_M,
  RETRY_AMBIG_STREAK,
  RETRY_BAD_ACC_STREAK,
  RETRY_CONFIRM,
  RETRY_EMPTY_STREAK,
  RETRY_EXCLUDED_MAX,
  RETRY_LATE_AFTER_MS,
  RETRY_LATE_MS,
  RETRY_NEAR_M,
  RETRY_NO_HIGH_TO_SLOW,
  RETRY_SLOW_MS,
  RETRY_START_FRAME,
  RETRY_STILL_STREAK,
  type FrameCtx,
} from "../src/components/nav/match-retry";
import type { MatchResult } from "../src/lib/nav/match-params";

let failed = 0;
let compared = 0;
const EXPECTED = 34;

const ok = (cond: boolean, name: string, detail = ""): void => {
  compared += 1;
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failed += 1;
    console.error(`  FAIL  ${name}  ${detail}`);
  }
};

const T0 = 1_760_000_000_000;

/** 一帧外部事实；默认全 `null`（= 全"不知道"） */
const ctx = (o: Partial<FrameCtx> = {}): FrameCtx => ({
  nowMs: T0,
  ridingMs: 0,
  userSpeedKmh: null,
  nearestStopM: null,
  remainM: null,
  remainStops: null,
  accuracyM: null,
  excludedCount: 0,
  poolSize: null,
  topGapM: null,
  ...o,
});

/** 一条匹配结果；默认 low / 无牌 */
const res = (o: Partial<MatchResult> = {}): MatchResult => ({
  plate: null,
  confidence: "low",
  score: 0,
  margin: 0,
  poolSize: 0,
  logL: 0,
  frames: 0,
  reasons: [],
  evidence: [],
  ranking: [],
  ...o,
});

const high = (plate: string): MatchResult => res({ plate, confidence: "high", score: 0.9, margin: 0.3, frames: 5 });
const medium = (plate: string, frames = 3): MatchResult => res({ plate, confidence: "medium", score: 0.65, frames });

/** 把状态推到"第 2 帧、可跑" */
function armed() {
  const st = createRetryState();
  begin(st, ctx()); // frame 1 → warmup
  return st;
}

console.log("\n═══ 未锁车牌定期重试（R11）· 状态机 ═══\n");

/* ── 一、节奏：预热帧 ─────────────────────────────────────────────────── */
console.log("── 节奏 ──");
{
  const st = createRetryState();
  const g1 = begin(st, ctx());
  ok(g1.run === false && g1.why === "warmup", "第 1 个车辆帧是预热帧（历史为空，跑了也是白跑）");
  ok(st.frameSeq === 1, "★ 预热帧也计帧序号（否则永远到不了第 2 帧）");
  const g2 = begin(st, ctx());
  ok(g2.run === true, `第 ${RETRY_START_FRAME} 帧起才跑算法`);
}
{
  const st = armed();
  begin(st, ctx());
  let r = res();
  r = high("AA1234");
  note(st, r, ctx());
  ok(st.nextDueAt === 0, "出 high ⇒ 不降频（nextDueAt 归 0，下一帧就跑）");
}

/* ── 二、降频 ─────────────────────────────────────────────────────────── */
console.log("── 降频 ──");
{
  const st = armed();
  for (let i = 0; i < RETRY_NO_HIGH_TO_SLOW; i += 1) {
    const now = T0 + i * 12_000;
    begin(st, ctx({ nowMs: now }));
    note(st, res(), ctx({ nowMs: now }));
  }
  ok(st.nextDueAt === T0 + (RETRY_NO_HIGH_TO_SLOW - 1) * 12_000 + RETRY_SLOW_MS, "连续 6 帧无 high ⇒ 降频 60s");
  ok(
    begin(st, ctx({ nowMs: st.nextDueAt - 1 })).run === false,
    "★ 降频期内（差 1ms）不跑（`>=` 边界写反会变成永远跑）",
  );
  ok(begin(st, ctx({ nowMs: st.nextDueAt })).run === true, "到点即跑（边界含等号）");
}
{
  const st = armed();
  const late = T0 + RETRY_LATE_AFTER_MS + 1;
  begin(st, ctx({ nowMs: late, ridingMs: RETRY_LATE_AFTER_MS + 1 }));
  note(st, res(), ctx({ nowMs: late, ridingMs: RETRY_LATE_AFTER_MS + 1 }));
  ok(st.nextDueAt === late + RETRY_LATE_MS, "★ 累计 ≥15 分钟 ⇒ 每 2 分钟一次（**不是停止**）");
}

/* ── 三、双帧确认 ─────────────────────────────────────────────────────── */
console.log("── 双帧确认 ──");
{
  const st = armed();
  const c = ctx({ nowMs: T0 + 12_000 });
  begin(st, c);
  const n1 = note(st, high("AA1234"), c);
  ok(n1.lockPlate === null, "high **第 1 帧不锁牌**（双帧确认的核心）");
  ok(n1.pendingPlate === "AA1234", "但第 1 帧就把车牌显示出来（否则用户觉得没反应）");

  const c2 = ctx({ nowMs: T0 + 24_000 });
  begin(st, c2);
  const n2 = note(st, high("AA1234"), c2);
  ok(n2.lockPlate === "AA1234", `连续 ${RETRY_CONFIRM} 帧 high **同车牌** ⇒ 可以写库`);

  const st2 = armed();
  begin(st2, c);
  note(st2, high("AA1234"), c);
  const c3 = ctx({ nowMs: T0 + 24_000 });
  begin(st2, c3);
  const n3 = note(st2, high("BB5678"), c3);
  ok(n3.lockPlate === null, "★ 车牌从 A 变 B ⇒ **不锁**（不重置计数就会把两辆车当一辆：本条就是防线）");
  ok(st2.highTimes === 1, "变车牌后计数从 1 重新数起");
}
{
  const st = armed();
  const c = ctx({ nowMs: T0 + 12_000 });
  begin(st, c);
  note(st, medium("CC0001"), c, { mediumOk: true });
  const c2 = ctx({ nowMs: T0 + 24_000 });
  begin(st, c2);
  const n = note(st, medium("CC0001"), c2, { mediumOk: true });
  ok(n.lockPlate === null, "★ medium 双帧**永不写库**（medium 的全部权限到此为止）");
  ok(n.confirmPlate === "CC0001", "连续 2 帧 medium 同车牌 ⇒ 给「一键确认」");
}
{
  const st = armed();
  const c = ctx({ nowMs: T0 + 12_000 });
  begin(st, c);
  const n = note(st, medium("CC0001"), c, { mediumOk: false });
  ok(n.pendingPlate === null && n.confirmPlate === null, "★ `mediumOk=false`（帧数门没过）⇒ 当 low 处理，不展示不确认");
  ok(st.noHigh === 1, "被降级的那帧计入 noHigh（它确实属于「没出 high」的那一帧）");
}

/* ── 四、6 条放弃条件 ─────────────────────────────────────────────────── */
console.log("── 放弃条件（6 条）──");
{
  const st = createRetryState();
  ok(abandonOf(st, ctx({ remainStops: 1 })) === "near-end", "② 剩余 ≤1 站 ⇒ 放弃");
  ok(abandonOf(st, ctx({ remainM: RETRY_NEAR_M - 1 })) === "near-end", "② 剩余 <300m ⇒ 放弃");
  ok(abandonOf(st, ctx({ remainM: RETRY_NEAR_M })) === null, "② 剩余正好 300m ⇒ 不放弃（严格小于）");
  ok(abandonOf(st, ctx({ excludedCount: RETRY_EXCLUDED_MAX })) === "excluded", "⑤ 本段累积排除 ≥3 辆 ⇒ 放弃");
}
{
  const st = createRetryState();
  const c = () => ctx({ poolSize: 4, topGapM: RETRY_AMBIG_GAP_M - 1 });
  for (let i = 1; i < RETRY_AMBIG_STREAK; i += 1) {
    ok(abandonOf(st, c()) === null, `① 多车分不清：第 ${i} 次还不放弃（需连续 ${RETRY_AMBIG_STREAK} 次）`);
  }
  ok(abandonOf(st, c()) === "ambiguous", "① 连续 3 次「候选>3 且前二差 <12m」⇒ 放弃");
}
{
  const st = createRetryState();
  const c = () => ctx({ userSpeedKmh: 2, nearestStopM: 250 });
  for (let i = 1; i < RETRY_STILL_STREAK; i += 1) abandonOf(st, c());
  ok(abandonOf(st, c()) === "standing", "③ 连续 3 帧速度 <3km/h 且距站 >200m ⇒ 放弃");
  const st2 = createRetryState();
  ok(abandonOf(st2, ctx({ userSpeedKmh: null, nearestStopM: 900 })) === null, "★ 速度未知 ⇒ ③ 不计数（不凭猜想放弃）");
  ok(abandonOf(st2, ctx({ userSpeedKmh: 1, nearestStopM: null })) === null, "★ 最近站距未知 ⇒ ③ 不计数");
}
{
  const st = createRetryState();
  const c = () => ctx({ accuracyM: 151 });
  for (let i = 1; i < RETRY_BAD_ACC_STREAK; i += 1) abandonOf(st, c());
  ok(abandonOf(st, c()) === "accuracy", "④ 连续 5 帧精度 >150m ⇒ 放弃");
  const st2 = createRetryState();
  abandonOf(st2, ctx({ accuracyM: 999 }));
  ok(abandonOf(st2, ctx({ accuracyM: 10 })) === null, "④ 中间一帧好定位 ⇒ 计数归零（要求「连续」）");
}
{
  const st = createRetryState();
  const c = () => ctx({ poolSize: 0 });
  for (let i = 1; i < RETRY_EMPTY_STREAK; i += 1) abandonOf(st, c());
  ok(abandonOf(st, c()) === "empty-pool", "⑥ 候选池空连续 5 帧 ⇒ 放弃");
}

/* ── 五、放弃是粘性的 ─────────────────────────────────────────────────── */
console.log("── 放弃后不再重试 ──");
{
  const st = armed();
  const c = ctx({ nowMs: T0 + 12_000, remainStops: 1 });
  const g = begin(st, c);
  ok(g.run === false && g.why === "given-up" && g.reason === "near-end", "命中放弃条件当帧即不跑");
  ok(st.givenUp === "near-end", "放弃原因记在状态里");
  const again = begin(st, ctx({ nowMs: T0 + 600_000 }));
  ok(
    again.run === false && again.why === "given-up" && again.reason === "near-end",
    "★ 之后任何一帧都不再跑（本段彻底停止，不靠调用方记）",
  );
  ok(retryTag(st).endsWith("/near-end"), "观测值带放弃原因（`<帧>/<fast|slow>/<reason>`）");
}

console.log(`\n═══ 实际比对 ${compared} 条 / 预期 ${EXPECTED} 条 ═══`);
if (compared !== EXPECTED) {
  console.error(`  FAIL  断言条数不符：实际 ${compared} ≠ 预期 ${EXPECTED}`);
  failed += 1;
}
console.log(failed === 0 ? "\n✅ 全通过\n" : `\n❌ FAIL ${failed} 条\n`);
process.exit(failed === 0 ? 0 : 1);
