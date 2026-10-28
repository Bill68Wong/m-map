/**
 * v2.10.0 增量迁移：**轻轨线路级实测参数表**（db/migrate-v2100.ts）
 * 用法：npm run db:migrate-v2100 -- [local|cloud]
 *
 * ── 这张表解决什么（2026-09-23 产品需求）────────────────────────────────
 *   轻轨报站显示「下一班 HH:MM」时，需计入**线路级的实测偏差**：
 *     · 石排湾线 发车偏差 **-5s**、单区间乘车 **100s**（1'40"）
 *     · 横琴线   发车偏差 **+40s**、单区间乘车 **135s**（2'15"）
 *   两条线都**只行驶一站**（stops=1）。
 *
 *   ⚠️ **为什么不塞进 `lrt_timetables`**：
 *     该表粒度是「站 × 线路 × 方向 × 班别」，而偏差是**线路级**——粒度错配，
 *     且同线多站要重复写同一份偏差，改一次得改 N 行。用户已拍板**单建一张表**。
 *
 * ── 字段说明 ──────────────────────────────────────────────────────────
 *   · `route_code`   线路码（与 `routes.code` 同口径：`LRT-石排湾线` / `LRT-横琴线`）= 主键
 *   · `dep_bias_sec` **发车偏差（秒）**：计划发车时刻 + 此值 = 实发预测（可为负）
 *   · `ride_sec`     **单区间乘车用时（秒）**：本站发车 → 下一站到站
 *   · `stops`        区间数（两条线均为 1，都只行驶一站）
 *   · `measured_on`  实测日期（★ 合规：派生值必须能说清来源与取得时间）
 *   · `note`         备注（实测方向，如「协和医院→石排湾」）
 *   · `updated_at`   行更新时间，默认 now()
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
      CREATE TABLE IF NOT EXISTS lrt_route_params (
        route_code    TEXT        PRIMARY KEY,
        dep_bias_sec  INTEGER     NOT NULL,
        ride_sec      INTEGER     NOT NULL,
        stops         INTEGER     NOT NULL DEFAULT 1,
        measured_on   DATE        NOT NULL,
        note          TEXT,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    console.log("✅ lrt_route_params 已就绪");

    await pool.query(`
      COMMENT ON TABLE lrt_route_params IS
      '轻轨线路级实测参数（报站偏差 / 单区间乘车用时）。粒度=线路，
       刻意与 lrt_timetables（站×线×方向×班别）分开，避免线路级常量在站级表里重复 N 份。
       ⚠️ 派生值（dep_bias_sec / ride_sec）必须能溯源：见 measured_on + note 列说明。'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_route_params.dep_bias_sec IS
      '发车偏差（秒，可为负）：计划发车时刻 + 此值 = 实发预测。石排湾线 -5 / 横琴线 +40（2026-09-22 实测）'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_route_params.ride_sec IS
      '单区间乘车用时（秒）：本站发车 → 下一站到站。石排湾线 100 / 横琴线 135（2026-09-22 实测）'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_route_params.stops IS
      '区间数（两条线均为 1，都只行驶一站）'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_route_params.measured_on IS
      '实测日期（合规要求：派生值须说明取得时间）。全部为 2026-09-22。'`);
    await pool.query(`
      COMMENT ON COLUMN lrt_route_params.note IS
      '备注：实测方向 / 口径，如「协和医院→石排湾（实测）」'`);
    console.log("✅ 表与字段注释已写入");

    // ── 种子数据（幂等：重复执行只更新，不重复插入）──
    await pool.query(
      `INSERT INTO lrt_route_params (route_code, dep_bias_sec, ride_sec, stops, measured_on, note)
       VALUES
         ('LRT-石排湾线', -5, 100, 1, DATE '2026-09-22', '协和医院→石排湾（实测）'),
         ('LRT-横琴线',    40, 135, 1, DATE '2026-09-22', '莲花→横琴（实测）')
       ON CONFLICT (route_code) DO UPDATE SET
         dep_bias_sec = EXCLUDED.dep_bias_sec,
         ride_sec     = EXCLUDED.ride_sec,
         stops        = EXCLUDED.stops,
         measured_on  = EXCLUDED.measured_on,
         note         = EXCLUDED.note,
         updated_at   = now()`,
    );

    const rows = (
      await pool.query(
        `SELECT route_code, dep_bias_sec, ride_sec, stops, measured_on, note
           FROM lrt_route_params ORDER BY route_code`,
      )
    ).rows as { route_code: string; dep_bias_sec: number; ride_sec: number; stops: number; measured_on: string; note: string | null }[];

    console.log(`\n复核：lrt_route_params 现有 ${rows.length} 行`);
    for (const r of rows) {
      console.log(
        `  · ${r.route_code}  bias=${r.dep_bias_sec}s  ride=${r.ride_sec}s  stops=${r.stops}  measured_on=${String(r.measured_on).slice(0, 10)}  ${r.note ?? ""}`,
      );
    }
    console.log(`\n✅ v2.10.0 迁移完成（${target ?? "default"}）`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
