/**
 * GET/POST /api/cron/rebuild —— 派生数据定时重算（v0.25.0，v1.0.0 加第三步）
 *
 * 背景：segment_stats（站间时长）、walk_times（步行时长）、transfer_walks（换乘步行）是从原始样本
 * 算出的**派生表**，此前只能手动跑 `npm run db:segments` / `db:walktimes` / `db:transferwalks`
 * 才会更新 —— 新样本进来后派生值会停留在上次运行命令的时刻。本路由把重算自动化，由 Vercel Cron
 * 每日触发（见 vercel.json），保证派生数据跟着样本走。
 *
 * ⚠️ 「原始样本」**逐表不同**（v4.2.0 起）：
 *   · `segment_stats` ← **只** `segment_samples.source='track'`（DSAT 报站帧自动采集）；
 *     **不读** timer_sessions / timer_events / free_rides / free_ride_events 四张旧表。
 *   · `walk_times` / `transfer_walks` ← **仍读** `timer_events` 等旧表（它们没有 track 版样本）。
 *   ⇒ 不要一刀切成「本路由不读事件表」—— 只有站间时长这一项换了口径。
 *
 * 实现要点：直接 import 共享函数，**不** execFile 调 .ts 脚本。
 *   原因：① tsx 在 devDependencies，Vercel 生产构建不装；
 *        ② Serverless 只打包被 import 的模块，.ts 脚本文件不会进函数产物。
 *   连库用 src/lib/db 的 getPool()（生产自动指向 DATABASE_URL = Supabase）。
 *   ★ P7 起**步骤清单搬到 `src/lib/rebuild/run-all.ts`**：本路由与 `npm run db:rebuild`
 *     共用同一份，避免两处口径漂移（历史上 `sampleFrom` 就漂过一次）。
 *
 * 鉴权：Vercel Cron 请求带 `Authorization: Bearer $CRON_SECRET`。
 *   ★ P7（2026-11-14）改口径：**未配置 `CRON_SECRET` 一律 401**，本地不再放行。
 *     旧行为是「未配 ⇒ `NODE_ENV !== "production"` 就放行」，后果是一条
 *     `curl localhost:3000/api/cron/rebuild` 就真跑 8.1s 全量重算、**写生产派生表**，
 *     且返回 200 让人以为只是"查了一下"。判定逻辑见 `src/lib/security/cron-auth.ts`。
 *     本地手动重算请用 `npm run db:rebuild -- cloud --allow-prod`（走 db-guard 双确认）。
 *   （middleware 已把本路径加入白名单，不走口令门，见 src/proxy.ts）
 *
 * 安全：重算本身幂等（清表后全量重算）；仍加内存锁避免重叠执行，
 *   并按顺序串行各步骤（都读 segment_samples / 事件表，串行避免连接竞争）。
 *
 * ★ v4.2.0（2026-11-09 负责人裁定）：segment_stats 口径改为 **`sampleFrom: "track"`**
 *   —— 只吃 `segment_samples.source='track'` 的自动采集样本。旧手工记录（timer / free）
 *   只留档、不参与计算。**不要再改回 `both`**：`both` 会把四张旧事件表重新混进来
 *   （历史上它就是"新旧合并"口径，v1.3.0~v4.1.x 的生产值）。
 *   ⇒ 改口径只需改这一处；生效时点为「下次 18:00 cron」或「手动 CLI 重建」。
 * ★ 2026-09-27：滚动窗口清理**已关闭**（`trimSegmentSampleWindow(pool, 0)` ⇒ 只回报不删除）。
 *   原行为为「只保留最近 30 轮 track」（timer 永不删）；关闭原因 = 用户要求「保留所有轮」。
 *   如需恢复窗口，把下面的 0 改回具体轮数（如 100），并同步 `import-segment-samples.ts` 的默认值。
 *
 * 幂等：可重复调用。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { runRebuildSteps } from "@/lib/rebuild/run-all";
import { checkCronAuth } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Vercel Hobby 计划函数上限 60s；三个重算当前合计数秒，数据长大后仍有余量 */
export const maxDuration = 60;

/** 进程内互斥：同实例并发请求直接拒绝，不排队（避免雪崩）。
 *  ⚠️ 用「时间戳 + 过期」而非布尔：若某次执行被 maxDuration 掐断或进程被回收，
 *  finally 不会执行 —— 布尔锁会永久卡在 true 让端点彻底失联（v0.25.0 实测踩到）。
 *  超过 STALE_MS 视为陈旧锁，自动放行。 */
let runningSince = 0;
const STALE_MS = 5 * 60_000;
const isLocked = () => runningSince !== 0 && Date.now() - runningSince < STALE_MS;

/**
 * 「漏配密钥」告警只打一次（每进程）。
 *
 * 为什么去重：这个端点会被扫描器/探活反复命中，每次都打 warn 会把真正的告警刷没；
 * 只打一次又足够让「生产漏配 CRON_SECRET」在日志里留下痕迹 —— 否则 cron 每天
 * 静默 401、派生数据停在旧值，几周后才发现。
 */
let warnedNoSecret = false;

async function handle(req: NextRequest) {
  const auth = checkCronAuth({
    authorization: req.headers.get("authorization"),
    key: req.nextUrl.searchParams.get("key"),
  });
  if (!auth.ok) {
    if (auth.reason === "no_secret" && !warnedNoSecret) {
      warnedNoSecret = true;
      console.warn(
        "[cron/rebuild] CRON_SECRET 未配置 ⇒ 本端点一律拒绝（401）。" +
          "生产请在 Vercel 环境变量里配置，否则每日 cron 会静默失效、派生数据停止更新；" +
          "本地手动重算请用 `npm run db:rebuild -- cloud --allow-prod`。",
      );
    }
    // 失败原因只进服务端日志：不向调用方透露「没配密钥」还是「密钥不对」。
    return NextResponse.json({ error: "未授权" }, { status: 401 });
  }
  if (isLocked()) {
    return NextResponse.json({ error: "上一次重算仍在进行", running: true }, { status: 409 });
  }

  runningSince = Date.now();
  const t0 = Date.now();
  try {
    const results = await runRebuildSteps(getPool());
    const allOk = results.every((r) => r.ok);
    return NextResponse.json(
      {
        ok: allOk,
        totalMs: Date.now() - t0,
        results,
      },
      { status: allOk ? 200 : 500 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 1000) },
      { status: 500 },
    );
  } finally {
    runningSince = 0;
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
