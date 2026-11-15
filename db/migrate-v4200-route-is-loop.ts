/**
 * 迁移 v4.2.0：把「循环线」标记落成库字段 `routes.is_loop`（db/migrate-v4200-route-is-loop.ts）
 *
 * 用法：
 *   node db/migrate-v4200-route-is-loop.ts                       # dry-run（只探测，不写库）
 *   node db/migrate-v4200-route-is-loop.ts -- --apply --allow-prod
 *
 * ── 为什么要有这一列（口径统一）────────────────────────────────────────
 *   同一件事今天有 **三套口径**，且互相打架：
 *     ① `src/lib/dsat/eta.ts:229-238`：`该线在 route_stations 里有几个 dsat_dir <= 1 ⇒ 循环线`
 *        （隐式推导，改不了、看不见、无法审计）
 *     ② `src/lib/nav/route-overview.ts:357` `isLoop(pts, startStop, endStop)`：
 *        首末站名相同 或 首尾顶点距 ≤ `LOOP_EPS_M(25)`
 *     ③ DSAT 官方线路清单（未公开接口，调用封装在 src/lib/dsat/client.ts）的 `routeList[].direction`：`2` = 循环线
 *
 *   实测（2026-11-15，`.verify/qa-b7-dsat-list.log`）：
 *     · DSAT 90 条线路中 `direction=2` 共 69 条、`direction=0` 共 21 条；
 *     · 与库内「只有 1 个方向 shape」的 69 条、以及「有 2 个方向 shape」的 21 条**逐条吻合**；
 *     · 但口径②在 8 条线上与官方相反（12/19/26/28A/30X/60/6A/N1B：站序首末同码=环线，
 *       折线首末顶点距 26~229m ⇒ 口径②判成非循环）。
 *   ⇒ 负责人裁定：以 DSAT 标记为**唯一口径**，落成库字段，其余口径降级为「画线用途」。
 *
 * ── 本迁移加什么（一列 + 两段回填，全部幂等）────────────────────────────
 *   ① `routes.is_loop boolean NOT NULL DEFAULT false`
 *      默认 `false` 是 fail-safe 方向：新线默认当「非循环」去要两个方向，最坏多抓一次，
 *      不会把「本来该有反方向」的线静默当成环线。
 *   ② 回填 · 第一段（90 条）：按 DSAT 快照 `direction=2`（69 条 true）/ `direction=0`（21 条 false）。
 *      快照已固化在本文件常量里（不依赖 `.verify/` 文件，迁移可独立重放）。
 *   ③ 回填 · 第二段（10 条 DSAT 未收录）：继承现有口径①（站序方向数 <= 1 ⇒ true）。
 *      覆盖：15T / 17S1 / 17T / 26S / 36 / 3AS / 52S（true）+ LRT 三线（false）。
 *
 * ── 零行为变化证明（回填后必须成立）────────────────────────────────────
 *   口径①今天把 **76 条**判为循环（实测 `count(*) FILTER (WHERE seq_dirs<=1) = 76`）。
 *   回填结果 = 69(DSAT) + 7(口径①) = **76**，两种口径在 90 条 DSAT 覆盖面上**完全等价**
 *   （`仅在①` 的 7 条全部是 DSAT 未收录的库内特班码，`仅在③` 为空）。
 *   ⇒ 消费端把 `eta.ts` 的推导换成读列，**行为逐条不变**；本迁移的 probe 会现场比对这两个集合。
 *
 * ── 回滚 ──────────────────────────────────────────────────────────────
 *   ```sql
 *   ALTER TABLE routes DROP COLUMN is_loop;
 *   ```
 *   纯新增列 + 有默认值 ⇒ 向前兼容：不删数据、不改既有列、旧代码不看这一列照样跑。
 *   回滚点（回填前快照）：`backups/2026-11-15-pre-isloop-routes.json`（100 行全列）。
 *
 * ── 为什么必须会话模式 5432 ────────────────────────────────────────────
 *   `.env` 的 `DATABASE_URL` 指向 Supabase pooler 的 6543（事务模式）：同一批
 *   「ALTER TABLE → 紧接着查 information_schema / 统计」会落到不同后端，
 *   看到不一致快照 ⇒ 假红。本文件用 `new pg.Client`（单连接）+ 端口改写。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────
 *   · 只加一列 + 回填这一列，**不改任何既有列、不删数据、不动 route_shapes / route_stations**；
 *   · 默认 dry-run；
 *   · 幂等：`ADD COLUMN IF NOT EXISTS` + 回填只更新「值不一致」的行 ⇒ 可重复执行。
 *   · 本迁移**不改** `src/lib/dsat/eta.ts`（消费端切换由 backend 负责）；
 *     也**不改** `route-overview.ts:357` 的几何版 `isLoop`（画线用途，本批不动）。
 */
import { Client } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示 */
}

const APPLY = process.argv.includes("--apply");
const ALLOW_PROD = process.argv.includes("--allow-prod");
const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);

/** 连接串 → **会话模式**（仅端口确实是 6543 时改写；本地/直连原样返回） */
function sessionUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.port === "6543") u.port = "5432";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * ★ DSAT 快照（2026-11-15T13:04:04Z，`.verify/qa-b7-dsat-routelist.json`）
 *   DSAT 线路清单（未公开接口，见 src/lib/dsat/client.ts）→ `routeList[].direction`：`2` = 循环线。
 *   合计 90 条 = 69 + 21。**不要手改**；要更新请重取快照并整体替换这两个数组。
 */
export const DSAT_LOOP_CODES = [
  "2A", "2AS", "3A", "3AX", "3X", "4", "5", "5X", "6A", "6B",
  "8A", "9", "9A", "10B", "11", "12", "15", "16", "16S", "17",
  "18A", "19", "22", "23", "25", "25AX", "25BS", "26", "27", "28A",
  "28B", "28C", "29", "30", "30X", "32", "33", "35", "37", "39",
  "50", "50B", "51", "51B", "52", "55", "56", "60", "65", "71",
  "72", "73", "101", "103", "701X", "701XS", "AP1", "H1", "H2", "H3",
  "MT1", "MT2", "MT3", "MT5", "N1A", "N1B", "N3", "N5", "N6",
] as const;

export const DSAT_NON_LOOP_CODES = [
  "1", "10", "102", "17S", "18", "18B", "1A", "2", "21A", "25B", "26A",
  "3", "34", "51A", "59", "61", "7", "71S", "8", "MT4", "N2",
] as const;

/**
 * DSAT 清单未收录的 10 条（实跑 `.verify/qa-b8-10gap.log`）：
 *   · 6 条库内特班/区间码：15T / 17S1 / 17T / 26S / 3AS / 52S（`is_active=true`，各有自己的站序）
 *   · 1 条停运线：36（`is_active=false`，0 站序、1 条 shape）
 *   · 3 条轻轨：DSAT 巴士 routeList 本来只列巴士，不收录属预期
 * 这 10 条按**现有口径①**（站序方向数 <= 1）回填，保证行为不变。
 */
export const INHERIT_BY_SEQ_DIRS = [
  "15T", "17S1", "17T", "26S", "36", "3AS", "52S",
  "LRT-氹仔线", "LRT-横琴线", "LRT-石排湾线",
] as const;

/** 第一段：列 + 注释 */
export const DDL: { label: string; sql: string }[] = [
  {
    label: "routes.is_loop（循环线标记，非空，默认 false）",
    sql: `ALTER TABLE routes ADD COLUMN IF NOT EXISTS is_loop boolean NOT NULL DEFAULT false`,
  },
  {
    label: "列注释 · routes.is_loop",
    sql: `COMMENT ON COLUMN routes.is_loop IS
      '循环线标记（唯一口径）。来源：DSAT 线路清单（未公开接口，见 src/lib/dsat/client.ts）的 routeList[].direction=2；
        DSAT 未收录的 10 条按「站序方向数<=1」继承。false 是 fail-safe 默认值（新线默认当非循环，最坏多抓一次方向）。
        注意：src/lib/nav/route-overview.ts 的 isLoop() 是「首尾是否闭合」的几何判断，仅用于 cutColored 环绕切片，
        与本列不是同一口径，勿混用。'`,
  },
];

/** 第二段：回填（幂等；只更新的确不一致的行） */
export const BACKFILL: { label: string; sql: string; params: unknown[] }[] = [
  {
    label: `回填 · DSAT direction=2 ⇒ is_loop=true（${DSAT_LOOP_CODES.length} 条）`,
    sql: `UPDATE routes SET is_loop = true
           WHERE code = ANY($1::text[]) AND is_loop IS DISTINCT FROM true`,
    params: [[...DSAT_LOOP_CODES]],
  },
  {
    label: `回填 · DSAT direction=0 ⇒ is_loop=false（${DSAT_NON_LOOP_CODES.length} 条）`,
    sql: `UPDATE routes SET is_loop = false
           WHERE code = ANY($1::text[]) AND is_loop IS DISTINCT FROM false`,
    params: [[...DSAT_NON_LOOP_CODES]],
  },
  {
    label: `回填 · DSAT 未收录的 ${INHERIT_BY_SEQ_DIRS.length} 条 ⇒ 继承「站序方向数 <= 1」`,
    sql: `UPDATE routes r SET is_loop = (
            (SELECT count(DISTINCT rs.dsat_dir) FROM route_stations rs WHERE rs.route_id = r.id) <= 1
          )
           WHERE r.code = ANY($1::text[])
             AND r.is_loop IS DISTINCT FROM (
            (SELECT count(DISTINCT rs.dsat_dir) FROM route_stations rs WHERE rs.route_id = r.id) <= 1
          )`,
    params: [[...INHERIT_BY_SEQ_DIRS]],
  },
];

/** 现状探针（只读）：列是否存在、is_loop 分布、覆盖面、与老口径① 的集合差异 */
async function probe(client: Client) {
  const hasCol =
    Number(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema='public' AND table_name='routes' AND column_name='is_loop'`,
        )
      ).rows[0]?.n ?? 0,
    ) > 0;
  console.log(`\n── 探针 ──`);
  console.log(`  routes.is_loop 存在? ${hasCol ? "是" : "否"}`);

  const total = (await client.query(`SELECT count(*)::int AS n FROM routes`)).rows[0].n as number;
  console.log(`  routes 行数 = ${total}`);

  if (hasCol) {
    const dist = (
      await client.query(`SELECT is_loop, count(*)::int AS n FROM routes GROUP BY is_loop ORDER BY is_loop`)
    ).rows as { is_loop: boolean; n: number }[];
    console.log(`  is_loop 分布：${dist.map((d) => `${d.is_loop}=${d.n}`).join("  ")}`);
  }

  // 老口径①（eta.ts:229-238 的等价 SQL）—— 用于证明「零行为变化」
  const oldLoop = (
    await client.query(`
      SELECT r.code FROM routes r
       WHERE (SELECT count(DISTINCT rs.dsat_dir) FROM route_stations rs WHERE rs.route_id = r.id) <= 1
       ORDER BY r.code`)
  ).rows.map((x: { code: string }) => x.code) as string[];
  console.log(`  老口径①（seq_dirs<=1）判为循环 = ${oldLoop.length} 条`);

  const covered = new Set<string>([...DSAT_LOOP_CODES, ...DSAT_NON_LOOP_CODES, ...INHERIT_BY_SEQ_DIRS]);
  const missingInDb = (
    await client.query(`SELECT code FROM routes WHERE NOT (code = ANY($1::text[])) ORDER BY code`, [
      [...covered],
    ])
  ).rows.map((x: { code: string }) => x.code) as string[];
  console.log(`  未被三段回填覆盖的库内线路 = ${missingInDb.length} 条${missingInDb.length ? "：" + missingInDb.join(",") : "（应为 0）"}`);

  const dbCodes = new Set(
    (await client.query(`SELECT code FROM routes`)).rows.map((x: { code: string }) => x.code) as string[],
  );
  const absent = [...covered].filter((c) => !dbCodes.has(c));
  console.log(`  回填清单里但库里没有的 code = ${absent.length} 条${absent.length ? "：" + absent.join(",") : "（应为 0）"}`);

  if (hasCol) {
    const newLoop = (
      await client.query(`SELECT code FROM routes WHERE is_loop ORDER BY code`)
    ).rows.map((x: { code: string }) => x.code) as string[];
    const onlyNew = newLoop.filter((c) => !oldLoop.includes(c));
    const onlyOld = oldLoop.filter((c) => !newLoop.includes(c));
    console.log(`  is_loop=true = ${newLoop.length} 条｜与老口径① 的差异：仅在列=${onlyNew.length}${onlyNew.length ? "(" + onlyNew.join(",") + ")" : ""}  仅在①=${onlyOld.length}${onlyOld.length ? "(" + onlyOld.join(",") + ")" : ""}`);
    console.log(
      `  ⇒ ${newLoop.length === oldLoop.length && onlyNew.length === 0 && onlyOld.length === 0 ? "两者**完全等价** ⇒ 消费端换列零行为变化 ✅" : "⚠️ 不等价，需人工核对"}`,
    );
  }
}

/** SQL 里直接跑一段（探针用） */
async function countOf(client: Client, sql: string): Promise<number> {
  return Number((await client.query(sql)).rows[0]?.n ?? 0);
}

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串（DATABASE_URL / DATABASE_URL_LOCAL）");
    process.exit(1);
  }
  const url = sessionUrl(connStr);
  const isProd = !process.env.DATABASE_URL_LOCAL || connStr === process.env.DATABASE_URL;
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(`连接模式：${url === connStr ? "原样" : "改写为 5432 会话模式"}`);
  console.log(`执行模式：${APPLY ? "APPLY（会写库）" : "DRY-RUN（不写库）"}`);

  if (APPLY && isProd && !ALLOW_PROD) {
    console.error("❌ 目标是生产库，必须显式加 `--allow-prod` 才允许写。");
    process.exit(1);
  }

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 60_000,
    ssl: url.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    console.log("\n" + "=".repeat(72));
    console.log("BEFORE");
    await probe(client);
    console.log("  计数交叉：routes=" + (await countOf(client, `SELECT count(*)::int AS n FROM routes`)));

    console.log("\n" + "=".repeat(72));
    console.log(`DDL（${DDL.length} 条，全部 IF NOT EXISTS）`);
    for (const d of DDL) console.log(`  · ${d.label}`);

    console.log(`\nBACKFILL（${BACKFILL.length} 段，幂等）`);
    for (const b of BACKFILL) console.log(`  · ${b.label}`);

    if (!APPLY) {
      console.log("\nDRY-RUN 结束：**未写库**。确认无误后加 `--apply --allow-prod` 重跑。");
      return;
    }

    // ① DDL（autocommit，便于中断后重放）
    for (const d of DDL) {
      await client.query(d.sql);
      console.log(`  ✅ ${d.label}`);
    }

    // ② 回填（单事务，失败整体回滚）
    await client.query("BEGIN");
    try {
      for (const b of BACKFILL) {
        const r = await client.query(b.sql, b.params as never[]);
        console.log(`  ✅ ${b.label} → rowCount=${r.rowCount}`);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }

    console.log("\n" + "=".repeat(72));
    console.log("AFTER");
    await probe(client);
    await client.query(`ANALYZE routes`);
    console.log("\n✅ APPLY 结束。回滚：`ALTER TABLE routes DROP COLUMN is_loop;`");
    console.log("   回滚点：backups/2026-11-15-pre-isloop-routes.json");
    console.log("   下一步（不在本迁移内）：backend 把 src/lib/dsat/eta.ts:229-238 改成读 routes.is_loop。");
  } finally {
    await client.end();
  }
}

// 仅直接执行时跑；被测试 import 时只导出 DDL / 常量
const invokedDirectly = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("migrate-v4200-route-is-loop.ts");
if (invokedDirectly) {
  main().catch((e) => {
    console.error("❌ 迁移失败：", e);
    process.exit(1);
  });
}
