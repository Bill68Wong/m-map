/**
 * 派生数据全量重算（src/lib/rebuild/run-all.ts，★ P7 / 2026-11-14 抽取）
 *
 * ── 为什么要抽出来 ────────────────────────────────────────────────────
 *   P7 把 `/api/cron/rebuild` 改成「无密钥一律 401」之后，本地就没有正规的重算入口了
 *   （旧版靠 `NODE_ENV !== "production"` 放行，等于用一条 GET 就能改写生产派生表）。
 *   补的入口是 `npm run db:rebuild`（`scripts/rebuild-derived.ts`）。
 *
 *   于是出现一个必须处理的问题：**路由与脚本各写一份步骤清单**，两处口径必然漂移 ——
 *   历史上 `sampleFrom` 就漂过一次（`route.ts` 写 `both`、脚本写 `track`，整表被洗回旧口径，
 *   见 `scripts/test-rebuild-scope.ts` 的故障指纹）。所以步骤清单只能有一份，
 *   放这里，路由与 CLI 都调它。
 *
 * ── 步骤顺序不能改 ─────────────────────────────────────────────────────
 *   ① 窗口清理（只回报不删）→ ② segment_stats → ③ walk_times → ④ transfer_walks。
 *   ②③④ 都读 `segment_samples` / 事件表，**必须串行**，否则并发抢连接。
 *
 * ── 失败语义 ──────────────────────────────────────────────────────────
 *   单步异常不中断后续步骤：把 `ok=false` + `err` 记进结果，让调用方看到「哪一步坏了」，
 *   而不是整轮抛掉、前面已写入的表也不知道算成功还是失败。
 */
import type { Pool } from "pg";
import { rebuildSegmentStats } from "./segment-stats";
import { trimSegmentSampleWindow } from "./segment-samples";
import { rebuildTransferWalks } from "./transfer-walks";
import { rebuildWalkTimes } from "./walk-times";

export interface RebuildStepResult {
  name: string;
  ok: boolean;
  ms: number;
  summary: Record<string, unknown>;
  err?: string;
}

/** 跑一个重算步骤，吞掉异常转为 `ok=false`（不中断另一步骤） */
async function step(name: string, fn: () => Promise<Record<string, unknown>>): Promise<RebuildStepResult> {
  const t0 = Date.now();
  try {
    const summary = await fn();
    return { name, ok: true, ms: Date.now() - t0, summary };
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - t0,
      summary: {},
      err: String(e instanceof Error ? e.message : e).slice(0, 1000),
    };
  }
}

/**
 * 顺序执行全部重算步骤。幂等（各步骤清表后全量重算），可重复调用。
 *
 * @param pool 由调用方负责（路由用 `getPool()`，CLI 自己按目标库建池）
 */
export async function runRebuildSteps(pool: Pool): Promise<RebuildStepResult[]> {
  const results: RebuildStepResult[] = [];

  // ⓪ 滚动窗口：**自动清理已关闭**（2026-09-27 用户要求「保留所有轮」）——
  //    keepRuns=0 ⇒ trim 只回报现状、**不删除任何行**（timer 本就不删）。
  //    ⚠️ 若未来需要重新启用窗口（如容量/性能考量），把 0 改回具体轮数即可（如 100）。
  //    保留此步骤是为了让返回体继续报告剩余轮数（监控用）。
  results.push(
    await step("segment_samples_window", async () => {
      const r = await trimSegmentSampleWindow(pool, 0);
      return { deleted: r.deleted, remaining: r.remaining, remainingRuns: r.remainingRuns };
    }),
  );

  // ① segment_stats：★ v4.2.0 口径 `sampleFrom="track"`（只吃自动采集，旧手工表不参与）。
  //    改回 `both` 会让四张旧事件表重新混进来 —— 见文件头 v4.2.0 段落，勿动。
  results.push(
    await step("segment_stats", async () => {
      const r = await rebuildSegmentStats(pool, { sampleFrom: "track" });
      return {
        sessions: r.sessions,
        rides: r.rides,
        samples: r.samples,
        written: r.inserted,
        pairs: r.pairs.length,
      };
    }),
  );

  results.push(
    await step("walk_times", async () => {
      const r = await rebuildWalkTimes(pool);
      return {
        scanned: r.scanned,
        collected: r.collected,
        valid: r.valid,
        inserted: r.inserted,
        totalSamples: r.totalSamples,
      };
    }),
  );

  // v1.0.0 第三步：换乘步行（alight → wait_start）—— 供自动选线的换乘方案计时
  results.push(
    await step("transfer_walks", async () => {
      const r = await rebuildTransferWalks(pool);
      return {
        scanned: r.scanned,
        collected: r.collected,
        valid: r.valid,
        inserted: r.inserted,
        totalSamples: r.totalSamples,
      };
    }),
  );

  return results;
}
