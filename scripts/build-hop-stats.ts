/**
 * 邻接站对主码级中位时长生成（scripts/build-hop-stats.ts）
 * 用法：npm run db:hop-stats -- cloud --allow-prod
 *
 * 从 segment_samples（全量追踪样本）聚合出 `route_hop_stats`：
 *   主码级（from_main→to_main）× 全周口径的 p50/avg 秒数 —— 进度模型的「md」。
 *   ⚠️ 全周不分时段（实测：进度模型里时段分层反而 +0.012 分——调研报告 §8 负结果）。
 *
 * 幂等：TRUNCATE 后全量重写。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL)
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);

async function main() {
  if (!connStr) { console.error("❌ 未找到连接串"); process.exit(1); }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));
  try {
    const before = (await pool.query(`SELECT count(*)::int AS n FROM route_hop_stats`)).rows[0] as { n: number };
    await pool.query(`TRUNCATE route_hop_stats`);
    const res = await pool.query(`
      INSERT INTO route_hop_stats (route_code, from_main, to_main, p50_sec, avg_sec, samples)
      SELECT route_code, from_main, to_main,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY minutes * 60) AS p50_sec,
             avg(minutes * 60) AS avg_sec,
             count(*)::int AS samples
        FROM segment_samples
       WHERE source = 'track'
         AND from_main <> to_main
         AND minutes BETWEEN 0.1 AND 20
       GROUP BY route_code, from_main, to_main
      ON CONFLICT (route_code, from_main, to_main) DO UPDATE
        SET p50_sec = EXCLUDED.p50_sec, avg_sec = EXCLUDED.avg_sec,
            samples = EXCLUDED.samples, updated_at = now()
    `);
    console.log(`✅ 写入 ${res.rowCount} 行（此前 ${before.n} 行）`);
    const stat = (await pool.query(
      `SELECT count(*)::int AS n, count(DISTINCT route_code)::int AS routes, sum(samples)::int AS total FROM route_hop_stats`,
    )).rows[0] as { n: number; routes: number; total: number };
    console.log(`  行 ${stat.n} · 线路 ${stat.routes} · 样本合计 ${stat.total}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
