/**
 * 高德调用 · 跨实例令牌桶（src/lib/amap/rate-limit.ts，v1.3.0）
 *
 * ── 为什么必须「跨实例」────────────────────────────────────────────────
 *   高德个人认证开发者的**基础 LBS 服务并发上限 = 3 QPS【官方+实测】**，且该上限是
 *   **按 Key 全局**的 —— 不是按进程。Vercel 上每个 Serverless 实例都是独立进程，
 *   **单进程变量（如 `client.ts` 里的 `lastCallAt`）在多实例下完全失效** ✗
 *   ⇒ 必须把令牌桶放到**共享存储**（Postgres），用 `pg_advisory_xact_lock`
 *   把所有实例的扣减**串行化**，才能保证「全实例合计 ≤ QPS」。
 *   （这是 QA 批判性审查 **P0-1** 的教训：本地限速看起来对、一上多实例就崩。）
 *
 * ── 算法（延迟最小化）─────────────────────────────────────────────────
 *   每桶一行 `amap_rate_bucket(bucket, tokens, updated_at)`：
 *     ① 事务内 `pg_advisory_xact_lock(hashtext('amap_rate:'||bucket))` 串行化；
 *     ② 原子补充：`tokens = LEAST(capacity, tokens + elapsed* qps)`（按经过时间线性回填）；
 *     ③ 条件扣减：`tokens >= 1` 才 `-1`（否则视为本次未取到）。
 *   —— 桶的行锁只在这一条事务内持有（毫秒级），不会成为热点瓶颈。
 *
 * ── 使用约定 ──────────────────────────────────────────────────────────
 *   · 主路径用 `acquireToken(bucket)`（**不等待**）：取不到 → 调用方退避/降级（§B.6）；
 *   · 离线预热用 `acquireWithWait(bucket, timeoutMs)`：可短等，避免抖失败。
 *   · 分桶：`transit`（公交路径）/ `walking`（步行路径）/ `search`（POI 搜索）。
 *
 * 设计：docs/设计-全澳导航-v1-20260918.md §B.4 / §6.2；审查 P0-1。
 */
import { getPool } from "@/lib/db";

/** 默认 QPS（全 Key 共用）—— 官方 3/s，这里取 3 并留由 `capacity` 吸收突发 */
export const AMAP_QPS = 3;
/** 桶容量（允许的短突发量）。默认 6 = 2 秒的量，够抵消「请求批次」抖动 */
export const AMAP_BUCKET_CAPACITY = 6;

/**
 * ★ v3.6.0（S2）：DSAT 只读接口的出口限流参数。
 *
 * 取值与高德同档（3/s、容量 6）的理由：DSAT 是政府部门公开接口，本项目对它长期按
 * 「别刷」自律（铁律 19/36）；单用户正常使用（点站点卡、导航详情轮询）远低于此；
 * 容量 6 可吸收「一次进导航并发取多条线」的突发，不会误伤。
 */
export const DSAT_QPS = 3;
export const DSAT_BUCKET_CAPACITY = 6;

/**
 * ★ v3.6.0（S2）：收藏写接口的滥用护栏参数。
 * 写请求本就低频（保存一条收藏 / 校验 / 批量算预设），3/s 足够；容量 6 容忍编辑页连点保存。
 */
export const FAV_QPS = 3;
export const FAV_BUCKET_CAPACITY = 6;

/** 分桶名（与设计 §6.2 「transit/walking/search 分桶」一致）
 *
 *  ★ v3.6.0（S2）：新增两个**非高德**用途的桶 —— 存储复用同一张
 *    `amap_rate_bucket(bucket, tokens, updated_at)`，靠 `bucket` 值区分，
 *    **无需 DDL**（行由 `acquireToken` 首次使用时幂等插入）。
 *    · `dsat`：`/api/dsat/eta`、`/api/station/eta` —— 拆口令门后这两个只读接口公开，
 *      不设出口限流等于把 DSAT（澳门交通事务局）配额送给任何爬虫；
 *    · `fav`：`/api/fav-routes*` 的**写**请求 —— 公开可写接口的滥用护栏（AC-50c）。
 */
export const RATE_BUCKET = {
  transit: "transit",
  walking: "walking",
  search: "search",
  /** ★ v3.6.0：DSAT 只读报站接口（`/api/dsat/eta`、`/api/station/eta`） */
  dsat: "dsat",
  /** ★ v3.6.0：收藏写接口（`/api/fav-routes` / `plan` / `validate`） */
  fav: "fav",
} as const;
export type RateBucketName = (typeof RATE_BUCKET)[keyof typeof RATE_BUCKET];

export interface RateDecision {
  /** true = 已扣到令牌，可以发起高德调用 */
  ok: boolean;
  /** 扣减后剩余令牌（近似，供日志/看板）；取不到时为当前余量 */
  tokensLeft: number | null;
}

/**
 * ★ 搜索优化（2026-09-21）：限速组件「自愈熔断」窗口。
 *
 * 一旦发现桶表写不了（典型：生产库被平台置为只读），在 `BROKEN_TTL_MS` 内**直接放行**，
 * 不再让每个请求都去撞一次注定失败的 DB 往返（既慢又刷错误日志）。
 * ⚠️ 只影响「限速」，**不影响业务正确性** —— 见 `acquireToken()` catch 分支的长注释。
 */
const BROKEN_TTL_MS = 60_000;
let brokenUntil = 0;

function markRateLimiterBroken(): void {
  brokenUntil = Date.now() + BROKEN_TTL_MS;
}

/** 桶表当前是否已知不可写（窗口内） */
function rateLimiterBroken(): boolean {
  return Date.now() < brokenUntil;
}

/** 纯函数：按经过时间回填令牌（可单测；与 SQL 里的 LEAST 表达式同一口径） */
export function refillTokens(
  tokens: number,
  elapsedSec: number,
  qps: number = AMAP_QPS,
  capacity: number = AMAP_BUCKET_CAPACITY,
): number {
  const refilled = tokens + Math.max(0, elapsedSec) * qps;
  return Math.min(capacity, refilled);
}

/**
 * 尝试取一个令牌（**单次、不等待**）。
 *
 * @param bucket 分桶名（见 `RATE_BUCKET`）
 * @param qps    该桶速率（默认 3/s）
 * @param capacity 桶容量（默认 6）
 * @returns `{ ok:false }` 表示此刻应退避/降级（**不抛错**，调用方决定行为）
 */
export async function acquireToken(
  bucket: string,
  qps: number = AMAP_QPS,
  capacity: number = AMAP_BUCKET_CAPACITY,
): Promise<RateDecision> {
  // ★ 已知桶表不可写（如库被置只读）⇒ 直接放行，省掉一次注定失败的 DB 往返
  if (rateLimiterBroken()) return { ok: true, tokensLeft: null };

  const pool = getPool();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // 首次使用建行（幂等；tokens 初始 = capacity，等价于「启动即满桶」）
    await c.query(
      `INSERT INTO amap_rate_bucket (bucket, tokens, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (bucket) DO NOTHING`,
      [bucket, capacity],
    );
    // ★ 跨实例串行化：advisory 事务锁（键 = 'amap_rate:'||bucket 的 hash）
    await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`amap_rate:${bucket}`]);
    // ① 原子补充
    await c.query(
      `UPDATE amap_rate_bucket
          SET tokens = LEAST($2::numeric, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * $3::numeric),
              updated_at = now()
        WHERE bucket = $1`,
      [bucket, capacity, qps],
    );
    // ② 条件扣减（tokens>=1 才扣）
    const r = await c.query(
      `UPDATE amap_rate_bucket
          SET tokens = tokens - 1
        WHERE bucket = $1 AND tokens >= 1
        RETURNING tokens`,
      [bucket],
    );
    const now = await c.query(`SELECT tokens FROM amap_rate_bucket WHERE bucket = $1`, [bucket]);
    await c.query("COMMIT");
    const left = now.rows[0]?.tokens !== undefined ? Number(now.rows[0].tokens) : null;
    return { ok: (r.rowCount ?? 0) > 0, tokensLeft: left };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    // ★ 搜索优化（2026-09-21）：限速组件故障 ⇒ **保守放行（fail-open）**，绝不拖垮业务功能。
    //
    //   为什么必须这样（实测事故）：2026-09-21 生产库被平台置为只读
    //   （`default_transaction_read_only = on`）⇒ 上面那条 `INSERT INTO amap_rate_bucket`
    //   必然失败 ⇒ 修改前这里 `throw e`，异常一路冒泡：
    //     acquireToken → placeText()/inputtips() → searchAmap() → suggest()
    //   ⇒ **整个 POI 搜索不可用** —— 用户点「搜索」什么也拿不到（正是产品反馈的现象）。
    //
    //   原则：令牌桶是**限速优化**，不是**安全边界**。即使真的超速，高德也只会返回限流错误
    //   （我们本来就有兜底），为「限速读不到」而让搜索整体挂掉，得不偿失。
    //   先例：`src/lib/nav/quota.ts#circuitState()` 读不到用量时同样「保守放行」。
    markRateLimiterBroken();
    console.warn("[rate-limit] acquireToken 失败，本次放行（fail-open）：", (e as Error).message);
    return { ok: true, tokensLeft: null };
  } finally {
    c.release();
  }
}

/**
 * 取令牌，取不到则**短等重试**（离线/可等待场景用；主路径请用 `acquireToken`）。
 *
 * @param bucket    分桶名
 * @param timeoutMs 最长等待（毫秒）；超时返回 `{ ok:false }`
 */
export async function acquireWithWait(
  bucket: string,
  timeoutMs = 2_000,
  qps: number = AMAP_QPS,
  capacity: number = AMAP_BUCKET_CAPACITY,
): Promise<RateDecision> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  // 一个令牌最坏等 1/qps 秒；轮询间隔取略大于该值的 1/2，兼顾及时与礼让
  const stepMs = Math.max(50, Math.round(1000 / qps / 2));
  let last: RateDecision = { ok: false, tokensLeft: null };
  for (;;) {
    last = await acquireToken(bucket, qps, capacity);
    if (last.ok) return last;
    if (Date.now() >= deadline) return last;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
