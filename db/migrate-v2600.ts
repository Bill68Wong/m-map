/**
 * v2.6.0 增量迁移：**收藏路线表**（db/migrate-v2600.ts）
 * 用法：npm run db:migrate-v2600 -- [local|cloud]
 *
 * ── 这张表解决什么（2026-09-22 产品口径）──────────────────────────────
 *   旧版「路线收藏 → 组合」里点进某条路线时，方案是**拿模型 + 高德现算**的
 *   （见 `ComboPlans.tsx` 的「可点重新规划」文案）⇒ 不稳定、且与用户当初定的方案可能不一致 ✗
 *   产品拍板：**组合下的路线必须固定在数据库里** ⇒ 本表就是那份「定好的方案」的落库。
 *
 * ── 粒度（关键）───────────────────────────────────────────────────────
 *   **一行 = 一条路线**（不合并）。例如「擎天汇 → 横琴口岸」：
 *     · 旧「通勤计时」里是一条 `26/50 → 50/25B/25BS/102/701X/N6` 的**合并方案**；
 *     · 展开后 = `26→50`、`26→25B`…`50→N6` 共 12 条 **+** 轻轨线 1 条 = **13 行** ✓
 *   ⇒ 前端「查看路线」页每行渲染一张卡，**不做斜杠合并**。
 *
 * ── 字段说明 ──────────────────────────────────────────────────────────
 *   · `route_key` 稳定唯一键（`<from>-<to>-<线路串>`）—— 幂等 upsert 的锚
 *   · `from_slug`/`to_slug` = `home` / `school` / `gate` / `hengqin`
 *   · `zones` = 适用座区（`home→school` 用；其余为空数组 = 不区分）
 *   · `route_labels` = 线路标签序列（前端只渲染这些标签，**不在本页合并**）
 *   · `segs` = 分段结构（`walk`/`ride`/`transfer`/`cross_border`，与 `PresetSeg` 同构）
 *   · `source` = `preset`（系统预置）/ `user`（用户自建/编辑过）
 *   · `is_active` = 软停用（**不删行**，保留历史）
 *
 * ⚠️ 只新增表 + 从既有 `commute_plans` 导入，**绝不触碰**任何现有表与计时数据。
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
  // ★ 生产库会被**间歇性**置为只读（平台侧成因待查）⇒ 会话级显式 off 覆盖
  //   ⚠️ handler 必须**返回** query 的 promise（pg-pool 只在返回 promise 时才等待）
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS favorite_routes (
        id            SERIAL PRIMARY KEY,
        route_key     TEXT        NOT NULL,
        from_slug     TEXT        NOT NULL,
        to_slug       TEXT        NOT NULL,
        zones         TEXT[]      NOT NULL DEFAULT '{}',
        name          TEXT        NOT NULL,
        route_labels  TEXT[]      NOT NULL,
        segs          JSONB       NOT NULL,
        source        TEXT        NOT NULL DEFAULT 'preset',
        is_active     BOOLEAN     NOT NULL DEFAULT true,
        sort_order    INTEGER     NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT favorite_routes_key_uniq UNIQUE (route_key)
      )`);
    console.log("✅ favorite_routes 已就绪");

    await pool.query(`CREATE INDEX IF NOT EXISTS favorite_routes_od
                        ON favorite_routes (from_slug, to_slug)`);
    console.log("✅ 索引 favorite_routes_od 已就绪");

    await pool.query(`
      COMMENT ON TABLE favorite_routes IS
      '收藏组合下的**逐条路线**（2026-09-22 起固定入库，取代原先「点进现算」）。
       一行 = 一条不合并的路线；来源 = 旧 commute_plans 方案按 route_options 笛卡尔积展开。
       前端「路线收藏 → 查看路线」页直接读本表，每行一张卡（不做斜杠合并）。'`);
    await pool.query(`
      COMMENT ON COLUMN favorite_routes.segs IS
      '分段结构：[{kind:"walk"|"ride"|"transfer"|"cross_border", ...}]，与 route-presets.ts 的 PresetSeg 同构'`);
    await pool.query(`
      COMMENT ON COLUMN favorite_routes.route_key IS
      '稳定唯一键（幂等 upsert 锚）：<fromSlug>-<toSlug>-<线路串>，如 home-hengqin-26-50'`);
    await pool.query(`
      COMMENT ON COLUMN favorite_routes.source IS
      'preset = 系统预置；user = 用户自建或编辑过（重跑导入脚本时**不覆盖** user 行）'`);
    console.log("✅ 表与字段注释已写入");

    const r = (await pool.query(`SELECT count(*)::int AS n FROM favorite_routes`)).rows[0] as { n: number };
    const cols = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'favorite_routes' ORDER BY ordinal_position`,
      )
    ).rows as { column_name: string }[];
    console.log(`\n复核：现有 ${r.n} 行`);
    console.log(`列：${cols.map((x) => x.column_name).join(" · ")}`);
    console.log(`\n下一步：npm run db:import-favorite-routes -- cloud   （展开并导入预设）`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
