/**
 * v2.9.0 增量迁移：**线路走向表**（db/migrate-v2900.ts）
 * 用法：npm run db:migrate-v2900 -- [local|cloud]
 *
 * ── 这张表解决什么（2026-09-22 产品需求）──────────────────────────────
 *   「路线查看模式」要在地图上**画出整条线路的走向**。但我们库里**只有站序**
 *   （`route_stations`：route_id/dsat_dir/seq/station_code），**没有任何几何数据** ✗
 *
 *   探查结论（`probe-amap-polyline.ts` 实测）：
 *     · 巴士：`/v3/bus/linename` 返回 `buslines[].polyline`（26=1676 点 / 50=1033 点）✓
 *     · 轻轨：**同样可查**（keywords=氹仔线 ⇒ 两个方向各 310 点）✓
 *       ⚠️ 高德把轻轨标为「地铁站」，但**线路仍在公交库里**，故走同一接口。
 *     · ⚠️ 有 QPS 限流（`CUQPS_HAS_EXCEEDED_THE_LIMIT`）⇒ **不能实时查**，
 *       必须**一次性抓全量入库**，地图只读本表。
 *
 * ── 字段说明 ──────────────────────────────────────────────────────────
 *   · `route_code` + `dsat_dir` = **我们的口径**（与 `route_stations` 对齐）⇒ 唯一键
 *   · `polyline` = **GCJ-02** 坐标串（高德原生，直接喂高德地图，**不要再转**）
 *   · `points` = 点数（诊断/抽稀用）
 *   · `amap_*` = 高德侧溯源信息（同名线路时人工核对用）
 *   · 包围盒（min/max）用于「进入路线模式时自动装下整条线」
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
  // ⚠️ handler 必须**返回** query 的 promise（pg-pool 只在返回 promise 时才等待）
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS route_shapes (
        id            SERIAL PRIMARY KEY,
        route_code    TEXT        NOT NULL,
        kind          TEXT        NOT NULL DEFAULT 'bus',
        dsat_dir      TEXT        NOT NULL,
        amap_line_id  TEXT,
        amap_name     TEXT,
        amap_dir      TEXT,
        polyline      TEXT        NOT NULL,
        points        INTEGER     NOT NULL,
        start_stop    TEXT,
        end_stop      TEXT,
        min_lng       DOUBLE PRECISION,
        min_lat       DOUBLE PRECISION,
        max_lng       DOUBLE PRECISION,
        max_lat       DOUBLE PRECISION,
        src           TEXT        NOT NULL DEFAULT 'amap.v3.bus.linename',
        fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT route_shapes_uniq UNIQUE (route_code, dsat_dir)
      )`);
    console.log("✅ route_shapes 已就绪");

    await pool.query(`CREATE INDEX IF NOT EXISTS route_shapes_code ON route_shapes (route_code)`);
    console.log("✅ 索引 route_shapes_code 已就绪");

    await pool.query(`
      COMMENT ON TABLE route_shapes IS
      '线路走向（地图画线用；来源高德 /v3/bus/linename 的 buslines[].polyline，2026-09-22 起）。
       一行 = 线路 × 我们的方向(dsat_dir)。polyline 为 GCJ-02 坐标串，直接喂高德地图。
       ⚠️ 高德有 QPS 限流 ⇒ 只允许离线抓取入库，运行时禁实时查询。
       抓取脚本：scripts/fetch-route-shapes.ts（npm run fetch:route-shapes）。'`);
    await pool.query(`
      COMMENT ON COLUMN route_shapes.polyline IS
      '「lng,lat;lng,lat;...」坐标串（**GCJ-02**，高德原生坐标系；同库 stations 表是 WGS84，两者不可混用）'`);
    await pool.query(`
      COMMENT ON COLUMN route_shapes.dsat_dir IS
      '我们的方向口径（与 route_stations.dsat_dir 对齐）；双方向线路会有两行'`);
    console.log("✅ 表与字段注释已写入");

    const r = (await pool.query(`SELECT count(*)::int AS n FROM route_shapes`)).rows[0] as { n: number };
    console.log(`\n复核：现有 ${r.n} 行`);
    console.log(`\n下一步：npm run fetch:route-shapes -- cloud --allow-prod   （抓取全部线路走向）`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
