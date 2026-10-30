/**
 * v3.6.0 增量迁移：`segment_samples` 增加**终点站停站**两列（db/migrate-v3600.ts）
 * 用法：npm run db:migrate-v3600 -- cloud --allow-prod
 *
 * ── 解决什么（2026-10 长时间停站调研）──────────────────────────────────
 *   离开口径  minutes = t(离B) − t(离A) = run(A→B) + **dwell_B**
 *   ⇒ 差里含的是**终点站**的停站。总站/司机休息点的 dwell 可达数分钟
 *     （实测 26 路 C654 聯生圓形地總站 dwell 最大 7.75 分），
 *     使 C656→C654 这类段的均值被系统性抬高（实测 +0.97 分 / +58%）。
 *
 *   原实现只有 `minutes BETWEEN 0.1 AND 20` 一道门（track-derive / build-hop-stats），
 *   3~8 分钟的长停站完全拦不住 ⇒ 现在把 dwell **单独成列**，由聚合层按阈值排除：
 *     · dwell_b_min  NUMERIC  —— 终点站停站时长（分）；旧样本 / timer 样本为 NULL
 *     · long_stop    BOOLEAN  —— 是否 ≥ 长停站阈值（默认 3 分），便于直接过滤与统计
 *
 * ⚠️ 只新增列，**不修改**任何既有列、不重写数据；可重复执行（IF NOT EXISTS）。
 * ⚠️ 本迁移**不**回填历史行：历史样本没有 dwell 数据（原始帧才有），回填需重跑派生+导入。
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
      ? process.env.DATABASE_URL_LOCAL
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);

async function main() {
  const pool = new Pool({ connectionString: connStr });
  // 生产库会被间歇性置为只读 ⇒ 会话级显式 off 覆盖（与 migrate-v3400 一致）
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    await pool.query(`ALTER TABLE segment_samples ADD COLUMN IF NOT EXISTS dwell_b_min NUMERIC`);
    await pool.query(
      `ALTER TABLE segment_samples ADD COLUMN IF NOT EXISTS long_stop BOOLEAN NOT NULL DEFAULT false`,
    );
    console.log("✅ segment_samples.dwell_b_min / long_stop 已就绪");

    // ★ 诊断列：纯行驶均值（扣 dwell_B）。**仅供人工对照，任何消费方不得用它算 md**
    //   —— progress 的 md 是「离开口径」（含正常停站），换成纯行驶会让 ETA 系统性偏低。
    //   旧口径（含全部停站）不需要额外列：segment_samples 一行不删，随时
    //   `SELECT avg(minutes*60) FROM segment_samples WHERE source='track' AND ...` 即可复现 before。
    await pool.query(`ALTER TABLE route_hop_stats ADD COLUMN IF NOT EXISTS run_sec DOUBLE PRECISION`);
    console.log("✅ route_hop_stats.run_sec（诊断列）已就绪");

    // 聚合层的主要过滤形态：按 (route, to_main) 或全表长停站计数
    await pool.query(
      `CREATE INDEX IF NOT EXISTS segment_samples_long_stop
         ON segment_samples (route_code, to_main) WHERE long_stop`,
    );
    console.log("✅ 部分索引 segment_samples_long_stop 已就绪");

    await pool.query(
      `COMMENT ON COLUMN segment_samples.dwell_b_min IS
       '终点站停站时长（分）。离开口径下 minutes = run(A→B) + dwell_b_min。
        由 scripts/track-derive.mjs (v1.2.0+) 从 status=1 的到站→离站帧直接量出；旧样本/timer 为 NULL。'`,
    );
    await pool.query(
      `COMMENT ON COLUMN segment_samples.long_stop IS
       'dwell_b_min >= 3 分（LONG_STOP_MIN）时为 true：该行 minutes 含司机休息/长时间上落客，
        不参与 segment_stats / route_hop_stats 的时长聚合。'`,
    );
    await pool.query(
      `COMMENT ON COLUMN route_hop_stats.run_sec IS
       '【诊断列，禁止用于 ETA】纯行驶均值（秒）= avg((minutes - dwell_b_min)*60)，即扣除终点站停站后的下限。
        md 必须用 p50_sec / avg_sec（离开口径，含正常停站）；改用本列会让剩余时间系统性偏低。
        旧口径（含全部停站）可由 segment_samples 直接复现：avg(minutes*60)，本表不另存。'`,
    );

    const n = (
      (await pool.query(
        `SELECT count(*)::int AS n, count(dwell_b_min)::int AS with_dwell, count(*) FILTER (WHERE long_stop)::int AS long_stop
           FROM segment_samples`,
      )).rows[0] as { n: number; with_dwell: number; long_stop: number } | undefined
    ) ?? { n: 0, with_dwell: 0, long_stop: 0 };
    console.log(
      `\n复核：segment_samples ${n.n} 行 · 有 dwell 数据 ${n.with_dwell} 行 · 长停站标记 ${n.long_stop} 行`,
    );
    if (n.with_dwell === 0)
      console.log(
        `\n⚠️ **本迁移只是加列，ETA 不会发生任何变化**：历史行没有 dwell 数据（NULL）→ 排除逻辑自动降级为旧行为。\n` +
          `   必须重跑 track-derive 并重新导入后，dwell_b_min 才有值，再由 db:segments / db:hop-stats 生效。\n` +
          `   顺序：派生(60 轮) → db:segsamples --apply → db:segments --from=both → db:hop-stats → train-progress-model`,
      );
    console.log(`\n下一步：重新派生 + 导入（历史行没有 dwell，必须重跑才有值）`);
    console.log(`  node scripts/track-derive.mjs --label=<stamp>          （新产物带 dwellMin / longStop）`);
    console.log(`  npm run db:segsamples -- --apply                        （写入 dwell_b_min）`);
    console.log(`  npm run db:segments -- cloud --allow-prod --from=samples （重算 segment_stats）`);
    console.log(`  npm run db:hop-stats -- cloud --allow-prod               （重算 route_hop_stats）`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
