/**
 * 报站懒加载策略单测（scripts/test-eta-policy.ts · v3.6.0 S6）
 *
 * ── 为什么存在 ──────────────────────────────────────────────────────────
 *   AC-42a/42b 的三条数量约束（并发 ≤3 / 队列 ≤8 / 单页 ≤30）是**防 DSAT 配额爆炸**的
 *   最后一道闸。它们出了问题不会报错，只会「悄悄把配额打穿」——而真浏览器里数请求
 *   既慢又难进 CI。⇒ 把策略抽成纯函数（`lib/line/eta-policy.ts`），在这里直接断言。
 *
 *   ⚠️ 测的是**实现本体**（hook 调的就是这两个函数），不是复刻的逻辑。
 *
 * 跑法：`node node_modules/tsx/dist/cli.mjs scripts/test-eta-policy.ts`
 *      （或 `npm run test:eta-policy`）
 */
import { ETA_LIMITS, mergeQueue, slotsFor } from "../src/lib/line/eta-policy";

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail = ""): void => {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${detail ? "  " + detail : ""}`);
};

console.log("═══ 报站懒加载策略（AC-42a / AC-42b 的数量约束）═══\n");

/* ── 常量本身（写死在测试里，改动会被看见）──────────────────────────────── */
console.log("── ① 三条数量约束的常量值 ──");
ok(ETA_LIMITS.MAX_CONCURRENT === 3, "并发上限 = 3", String(ETA_LIMITS.MAX_CONCURRENT));
ok(ETA_LIMITS.MAX_QUEUE === 8, "待取队列上限 = 8", String(ETA_LIMITS.MAX_QUEUE));
ok(ETA_LIMITS.MAX_REQUESTS === 30, "单页自动请求硬闸 = 30", String(ETA_LIMITS.MAX_REQUESTS));
ok(ETA_LIMITS.DEBOUNCE_MS === 250, "滚动静默期 = 250ms", String(ETA_LIMITS.DEBOUNCE_MS));
ok(ETA_LIMITS.CACHE_TTL_MS === 60_000, "本地缓存 TTL = 60s", String(ETA_LIMITS.CACHE_TTL_MS));

/* ── mergeQueue（④ 队列裁剪）──────────────────────────────────────────── */
console.log("\n── ② mergeQueue：超限丢「离视口中心最远」的 ──");
{
  // 距离：code 数字越小越近（模拟「上面的站更近」）
  const dist = (c: string) => Number(c.replace("s", ""));
  const q = ["s1", "s2", "s3"];
  const merged = mergeQueue(q, ["s4", "s5", "s6", "s7", "s8", "s9", "s10"], dist);
  ok(merged.length === ETA_LIMITS.MAX_QUEUE, `队列被裁到 ${ETA_LIMITS.MAX_QUEUE}`, `实际 ${merged.length}`);
  ok(
    merged.every((c) => dist(c) <= ETA_LIMITS.MAX_QUEUE),
    "保留的是距离最近的 8 个（s1~s8）",
    merged.join(","),
  );
  ok(!merged.includes("s9") && !merged.includes("s10"), "最远的 s9 / s10 被丢弃");
}
{
  const dist = () => 100;
  const merged = mergeQueue(["a"], ["b", "c"], dist);
  ok(merged.length === 3 && merged[0] === "a", "未超限时**保持原顺序**（不排序）", merged.join(","));
}
{
  const dist = () => 0;
  const merged = mergeQueue(["a", "b"], ["a", "b"], dist);
  ok(merged.length === 2, "候选已在队列里 ⇒ 不重复入队", merged.join(","));
}

/* ── slotsFor（② 并发 + ⑤ 硬闸）───────────────────────────────────────── */
console.log("\n── ③ slotsFor：并发与硬闸 ──");
{
  const p = slotsFor(0, 0);
  ok(p.slots === 3 && !p.capped, "空闲时一次可发 3 个", JSON.stringify(p));
}
{
  const p = slotsFor(2, 10);
  ok(p.slots === 1, "已有 2 个在飞 ⇒ 只剩 1 个额度", JSON.stringify(p));
}
{
  const p = slotsFor(3, 10);
  ok(p.slots === 0 && !p.capped, "已满 3 个在飞 ⇒ 不能再发（但未触顶）", JSON.stringify(p));
}
{
  const p = slotsFor(0, 30);
  ok(p.slots === 0 && p.capped, "已发 30 次 ⇒ 触顶，永久停止", JSON.stringify(p));
}
{
  const p = slotsFor(0, 29);
  ok(p.slots === 1, "已发 29 次 ⇒ 只允许再发 1 个（不越过硬闸）", JSON.stringify(p));
}
{
  const p = slotsFor(0, 40);
  ok(p.slots === 0 && p.capped, "已超发（>30）⇒ 仍返回 0，不会回绕", JSON.stringify(p));
}

/* ── 端到端模拟：78 站（最长线路 21A）快速滚到底 ────────────────────────── */
console.log("\n── ④ 模拟：78 站快速滚到底，累计发出量必须 ≤30 ──");
{
  const CODES = Array.from({ length: 78 }, (_, i) => `c${i}`);
  let sent = 0;
  let inflight = 0;
  let queue: string[] = [];
  const done = new Set<string>();
  const dist = (c: string) => Number(c.slice(1)); // 越靠后越远（模拟一直往下滚）

  // 每一轮：把「新进入视口的 10 个站」入队，然后尽量发
  for (let round = 0; round < 8; round++) {
    const cands = CODES.filter((c) => !done.has(c)).slice(0, 10);
    queue = mergeQueue(queue, cands, dist);
    for (;;) {
      const p = slotsFor(inflight, sent);
      if (p.slots === 0) break;
      const code = queue.shift();
      if (!code) break;
      done.add(code);
      sent++;
      inflight++;
      // 立即完成（最坏情况：并发额度一直可用）
      inflight--;
    }
  }
  ok(sent <= ETA_LIMITS.MAX_REQUESTS, `累计发出 ${sent} ≤ 30`, `实际 ${sent}`);
  ok(queue.length === 0 || sent >= ETA_LIMITS.MAX_REQUESTS, "队列被消化或被硬闸截断", `queue=${queue.length}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
