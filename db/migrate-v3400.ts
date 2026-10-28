/**
 * v3.4.0 增量迁移：**进度模型两张表**（db/migrate-v3400.ts）
 * 用法：npm run db:migrate-v3400 -- [local|cloud] [--allow-prod]
 *
 * ── 这两张表解决什么（2026-09-27 区间进度模型）────────────────────────
 *   导航中「距下车站还有 N 站 · 约 X 分钟」要升级为**位置感知**：
 *   车辆实时坐标 → 投影到线路几何（route_shapes）→ 相对进度 p → 剩余时间。
 *   需要两类预计算数据：
 *     ① `route_station_mileage`：每个「站」在「线路几何」上的**沿线里程**（米）
 *        —— 由 scripts/build-station-mileage.ts 生成（站坐标投影 + 站序单调消歧）
 *     ② `route_hop_stats`：每条线每个**邻接站对**的**主码级中位时长**（秒）
 *        —— 由 scripts/build-hop-stats.ts 从 segment_samples 聚合（全周口径）
 *
 * ⚠️ 只新增表，**绝不触碰**任何现有表。
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

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);

async function main() {
  const pool = new Pool({ connectionString: connStr });
  // 生产库会被**间歇性**置为只读（平台侧成因待查）⇒ 会话级显式 off 覆盖
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_station_mileage (
        id           SERIAL PRIMARY KEY,
        route_code   TEXT             NOT NULL,
        dsat_dir     TEXT             NOT NULL,
        station_code TEXT             NOT NULL,
        main_code    TEXT             NOT NULL,
        mile_m       DOUBLE PRECISION NOT NULL,
        updated_at   TIMESTAMPTZ      NOT NULL DEFAULT now()
      )`);
    // ⚠️ 多行制：环线（如 25 路）首尾同站会在几何上出现两次（里程 0 与 L）——
    //    同一 station_code 允许多个 mile_m（运行时用车辆当前里程消歧）。
    //    历史版本曾加 UNIQUE(route,dir,station) —— 如已存在则移除（幂等）。
    await pool.query(`ALTER TABLE route_station_mileage DROP CONSTRAINT IF EXISTS route_station_mileage_uniq`);
    console.log("✅ route_station_mileage 已就绪（多行制）");
    await pool.query(`CREATE INDEX IF NOT EXISTS rsm_lookup ON route_station_mileage (route_code, dsat_dir, main_code)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_hop_stats (
        route_code TEXT             NOT NULL,
        from_main  TEXT             NOT NULL,
        to_main    TEXT             NOT NULL,
        p50_sec    DOUBLE PRECISION NOT NULL,
        avg_sec    DOUBLE PRECISION NOT NULL,
        samples    INTEGER          NOT NULL,
        updated_at TIMESTAMPTZ      NOT NULL DEFAULT now(),
        CONSTRAINT route_hop_stats_uniq UNIQUE (route_code, from_main, to_main)
      )`);
    console.log("✅ route_hop_stats 已就绪");
    await pool.query(`CREATE INDEX IF NOT EXISTS rhs_lookup ON route_hop_stats (route_code, from_main, to_main)`);

    await pool.query(`
      COMMENT ON TABLE route_station_mileage IS
      '站点沿线里程（进度模型用；站坐标投影到 route_shapes 折线的弧长，米）。
       由 scripts/build-station-mileage.ts 生成（npm run db:station-mileage）。'`);
    await pool.query(`
      COMMENT ON TABLE route_hop_stats IS
      '邻接站对主码级中位时长（进度模型用；秒）。从 segment_samples 全周聚合。
       ⚠️ 不随时间分层（进度模型实测：全周 md 比时段分层更稳，见调研报告 §8）。
       由 scripts/build-hop-stats.ts 生成（npm run db:hop-stats）。'`);

    const a = (await pool.query(`SELECT count(*)::int AS n FROM route_station_mileage`)).rows[0] as { n: number };
    const b = (await pool.query(`SELECT count(*)::int AS n FROM route_hop_stats`)).rows[0] as { n: number };
    console.log(`\n复核：route_station_mileage ${a.n} 行 · route_hop_stats ${b.n} 行`);
    console.log(`\n下一步：npm run db:station-mileage -- cloud --allow-prod  （生成里程表）`);
    console.log(`        npm run db:hop-stats -- cloud --allow-prod        （生成时长表）`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
