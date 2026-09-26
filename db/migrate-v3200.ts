/**
 * v3.2.0 增量迁移：**轻轨逐站偏差表 + 站间模式表**（db/migrate-v3200.ts）
 * 用法：npm run db:migrate-v3200 -- [local|cloud] [--allow-prod]
 *
 * ── 这两张表解决什么（2026-09-26 · 用户需求 1 / ADR-101 方案 C）──────────────
 *   轻轨氹仔线要「读得了秒」：先把「某站某方向下一班属于哪种站间模式」判定出来，
 *   再取该模式下的**逐站偏差**叠到表定发车时刻。
 *
 *   · `lrt_station_biases`  = **读秒唯一真源**（逐站/逐模式偏差）：
 *       · 氹仔线 4 模式 × 13 站 = 52 行（四模式本就方向专属，**不再 × 方向**）；
 *       · 石排湾 / 横琴各 2 行（线路级，`pattern='default'`）⇒ 合计 **56 行**。
 *   · `lrt_station_patterns` = **离线模式权威表**（ADR-101 方案 C）：
 *       由 `scripts/build-lrt-patterns.ts` 调 `src/lib/lrt/pattern.ts` 的同一纯函数生成，
 *       与预载内存派生互为护栏（一致性测试守住「表派生 == 内存派生」）。
 *
 * ── 与既有表的关系 ──────────────────────────────────────────────────────
 *   · `lrt_route_params.dep_bias_sec` **保留**（只读迁移）：退役为历史，作石排湾/横琴**线路级兜底**；
 *     一致性断言（见 seed 脚本）：石排湾/横琴两线值与本表 `dep_bias_sec` 必须相等。
 *
 * ⚠️ 只新增表，**绝不触碰**任何现有表。`CREATE TABLE IF NOT EXISTS` 幂等，可重复执行。
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
  // ⚠️ handler 必须**返回** query 的 promise（pg-pool 只在返回 promise 时才等待）
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    // ── 表 1：逐站/逐模式偏差（读秒唯一真源）──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lrt_station_biases (
        id            SERIAL PRIMARY KEY,
        route_code    TEXT        NOT NULL,
        direction     TEXT        NOT NULL,
        pattern       TEXT        NOT NULL,
        api_station   TEXT        NOT NULL,
        arr_bias_sec  INTEGER,
        dep_bias_sec  INTEGER,
        source        TEXT,
        measured_on   DATE,
        note          TEXT,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT lrt_station_biases_uniq UNIQUE (route_code, direction, pattern, api_station)
      )`);
    console.log("✅ lrt_station_biases 已就绪");

    await pool.query(
      `CREATE INDEX IF NOT EXISTS lrt_station_biases_lookup
         ON lrt_station_biases (route_code, direction, pattern, api_station)`,
    );
    console.log("✅ 索引 lrt_station_biases_lookup 已就绪");

    // ── 表 2：离线模式权威表 ──
    await pool.query(`
      CREATE TABLE IF NOT EXISTS lrt_station_patterns (
        id           SERIAL PRIMARY KEY,
        api_station  TEXT        NOT NULL,
        route_no     TEXT        NOT NULL,
        direction    TEXT        NOT NULL,
        day_type     TEXT        NOT NULL,
        dep_min      INTEGER     NOT NULL,
        pattern      TEXT        NOT NULL,
        src          TEXT        NOT NULL DEFAULT 'pattern.ts#deriveStationPatterns',
        built_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT lrt_station_patterns_uniq UNIQUE (api_station, route_no, direction, day_type, dep_min)
      )`);
    console.log("✅ lrt_station_patterns 已就绪");

    await pool.query(
      `CREATE INDEX IF NOT EXISTS lrt_station_patterns_lookup
         ON lrt_station_patterns (api_station, route_no, direction, day_type, dep_min)`,
    );
    console.log("✅ 索引 lrt_station_patterns_lookup 已就绪");

    // ── 注释（合规：派生值可溯源）──
    await pool.query(`
      COMMENT ON TABLE lrt_station_biases IS
      '轻轨逐站/逐模式实测偏差（v3.2.0 · 读秒唯一真源）。
       粒度=线路 × 方向 × 模式 × 站；氹仔线 4 模式 × 13 站 = 52 行 + 石排湾/横琴各 2 行（线路级 pattern=default）= 56 行。
       ⚠️ 四模式本就方向专属，勿再 × 方向；api_station 用 motransportinfo **api 码**（BAR/OCE…），
          与 LRT_HOP_SEC（db_code 域）不可混用。
       ⚠️ 合规：派生值必须能溯源 —— 见 source + measured_on + note 列。'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_station_biases.pattern IS
      '站间模式串（氹仔线四主力：52222222222 / 42322213132 / 22222232222 / 13222222222）；石排湾/横琴 = default'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_station_biases.arr_bias_sec IS
      '到站偏差（秒，可为 null）。dep 为读秒取用列（发车口径）'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_station_biases.dep_bias_sec IS
      '发车偏差（秒，可为 null）：表定发车 + 此值 = 实发预测。null = 该语义不存在（起点无 arr / 终点无 dep）'`);
    await pool.query(`
      COMMENT ON TABLE lrt_station_patterns IS
      '轻轨站间模式权威表（v3.2.0 · ADR-101 方案 C）。
       由 scripts/build-lrt-patterns.ts 调 src/lib/lrt/pattern.ts 的同一纯函数生成；
       与 next-departures 预载的内存派生互为护栏（npm run test:lrt-pattern-consistency）。
       刷新链路：lrt:refresh = lrt:fetch → db:build-lrt-patterns（防派生漂移）。'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_station_patterns.dep_min IS
      '服务日 00:00 起分钟偏移（hour 可 >23），与 lrt_timetables.minutes 同轴'`);

    const b = (await pool.query(`SELECT count(*)::int AS n FROM lrt_station_biases`)).rows[0] as { n: number };
    const p = (await pool.query(`SELECT count(*)::int AS n FROM lrt_station_patterns`)).rows[0] as { n: number };
    console.log(`\n复核：lrt_station_biases ${b.n} 行 · lrt_station_patterns ${p.n} 行`);
    console.log(`\n下一步：npm run db:seed-lrt-biases -- cloud --allow-prod   （DRY-RUN 打印 56 行与校验）`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
