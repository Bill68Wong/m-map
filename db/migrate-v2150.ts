/**
 * v2.15 数据修复：route_shapes 方向错配 —— 定向修正（db/migrate-v2150.ts）
 * 用法：npm run db:migrate-v2150 -- [local|cloud] [--apply|--rollback] [--allow-prod]
 *
 * ── 问题（根因）────────────────────────────────────────────────────────
 *   `scripts/fetch-route-shapes.ts` 按「站名匹配」**逐方向**抓取。当高德对某线路
 *   只返回**一条** busline（或站名未匹配上、退化为「取第一条」）时，dir=0 / dir=1
 *   两行会拿到**同一份 polyline**（md5 相同）⇒ 其中必有一行的几何方向与我们
 *   `route_stations` 的站序**相反** ⇒ 地图画线方向错、且彩段切割失败（渲染降级）。
 *
 *   全库扫描：双向线路中「两方向 polyline 完全相同」者**仅 3 条**（2 / 21A / 59）；
 *   逐方向定向后确认各**恰有 1 行**反向：2 dir=0 · 21A dir=1 · 59 dir=0。
 *
 * ── 修复 ───────────────────────────────────────────────────────────────
 *   仅对这 3 条线路的 6 行，按该 `dsat_dir` 的**首末站坐标**（stations.lng/lat）
 *   与 polyline 首末顶点比较定向：
 *     forwardDist = d(head, 首站) + d(tail, 末站)
 *     reverseDist = d(head, 末站) + d(tail, 首站)
 *     反向者（forwardDist > reverseDist）⇒ **反转 polyline 写回**。
 *   ⚠️ 只改 `polyline`（反转）；`points` / 包围盒在反转下不变；start_stop/end_stop 不动。
 *   ⚠️ stations 为 WGS84、polyline 为 GCJ-02，存在系统性偏移；仅用于**长线**首末定向消歧，
 *      本次 3 线首末相距数公里，正/反向量级相差 5–15 倍，判别稳健。
 *
 * ── 三种模式 ───────────────────────────────────────────────────────────
 *   缺省（无 --apply/--rollback）：**DRY-RUN**，只读，打印计划。
 *   `--apply`：反转「当前反向」的目标行（2/0 · 21A/1 · 59/0），单事务写回。
 *   `--rollback`：反转「当前**正向**」的目标行 —— 即把已修复的行还原（反转是自身的逆）。
 *     · 未 apply 时目标行仍为反向 ⇒ rollback **自动跳过**（no-op），不会误伤。
 *
 * ── 安全 ───────────────────────────────────────────────────────────────
 *   会改数据 ⇒ 必须经 db-guard（非本地库需 --allow-prod）。
 */
import { Pool, type PoolClient } from "pg";
import { distM, parsePolyline, type LL } from "../src/lib/nav/route-overview";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const argv = process.argv.slice(2);
const target = argv.find((a) => a === "local" || a === "cloud") as "local" | "cloud" | undefined;
const APPLY = argv.includes("--apply");
const ROLLBACK = argv.includes("--rollback");

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
console.log(
  `模式：${APPLY ? "APPLY（将写库）" : ROLLBACK ? "ROLLBACK（将还原）" : "DRY-RUN（只读，不写库）"}`,
);

/** 修复范围：两方向 polyline 完全相同的 3 条线路（全库仅此 3 条） */
const SCOPE = ["2", "21A", "59"];
/** 经定向判定确认「几何方向与行驶方向相反」、需反转的 (线路, dsat_dir) */
const REVERSED_PAIRS: [string, string][] = [
  ["2", "0"],
  ["21A", "1"],
  ["59", "0"],
];
const LINE = "─".repeat(68);
const key = (r: string, d: string) => `${r}|${d}`;

interface Row {
  route: string;
  dir: string;
  pts: LL[];
  polyline: string;
  fwd: number;
  rev: number;
  reversed: boolean;
}

/** 反转 "lng,lat;lng,lat;..."（丢弃空段）；反转是自身的逆 */
function reversePolyline(pl: string): string {
  return pl
    .split(";")
    .filter((s) => s.trim() !== "")
    .reverse()
    .join(";");
}

async function loadRows(pool: Pool): Promise<Row[]> {
  const rows = (
    await pool.query(
      `SELECT route_code, dsat_dir, polyline
         FROM route_shapes WHERE route_code = ANY($1) ORDER BY route_code, dsat_dir`,
      [SCOPE],
    )
  ).rows as { route_code: string; dsat_dir: string; polyline: string }[];

  const out: Row[] = [];
  for (const r of rows) {
    const ends = (
      await pool.query(
        `SELECT
           (array_agg(s.lng ORDER BY rs.seq))[1]  AS first_lng,
           (array_agg(s.lat ORDER BY rs.seq))[1]  AS first_lat,
           (array_agg(s.lng ORDER BY rs.seq DESC))[1] AS last_lng,
           (array_agg(s.lat ORDER BY rs.seq DESC))[1] AS last_lat
         FROM route_stations rs
         JOIN routes rr ON rr.id = rs.route_id
         JOIN stations s ON s.code = rs.station_code
         WHERE rr.code = $1 AND rs.dsat_dir = $2`,
        [r.route_code, r.dsat_dir],
      )
    ).rows[0] as { first_lng: number | null; first_lat: number | null; last_lng: number | null; last_lat: number | null };

    const pts = parsePolyline(r.polyline);
    if (pts.length < 2 || ends.first_lng == null || ends.last_lng == null) {
      throw new Error(`无法定向：${r.route_code} dir=${r.dsat_dir}（pts=${pts.length}，首末站坐标缺失）`);
    }
    const head = pts[0];
    const tail = pts[pts.length - 1];
    const first: LL = [Number(ends.first_lng), Number(ends.first_lat)];
    const last: LL = [Number(ends.last_lng), Number(ends.last_lat)];
    const fwd = distM(head, first) + distM(tail, last);
    const rev = distM(head, last) + distM(tail, first);
    out.push({ route: r.route_code, dir: r.dsat_dir, pts, polyline: r.polyline, fwd, rev, reversed: fwd > rev });
  }
  return out;
}

async function applyReversals(pool: Pool, rows: Row[], label: string): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(`UPDATE route_shapes SET polyline = $1 WHERE route_code = $2 AND dsat_dir = $3`, [
        reversePolyline(r.polyline),
        r.route,
        r.dir,
      ]);
    }
    await client.query("COMMIT");
    console.log(`\n✅ 已提交事务（${label}）：${rows.length} 行。`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function report(pool: Pool): Promise<void> {
  const after = (
    await pool.query(
      `SELECT route_code, dsat_dir, md5(polyline) AS md5, points, left(polyline, 24) AS head
         FROM route_shapes WHERE route_code = ANY($1) ORDER BY route_code, dsat_dir`,
      [SCOPE],
    )
  ).rows as { route_code: string; dsat_dir: string; md5: string; points: number; head: string }[];
  console.log(`\n${LINE}\n写后复核：`);
  for (const r of after) {
    console.log(`  ${r.route_code.padEnd(4)} dir=${r.dsat_dir} md5=${r.md5.slice(0, 8)} pts=${r.points} head=${r.head}`);
  }
  console.log(`${LINE}`);
}

async function main() {
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    const rows = await loadRows(pool);
    if (!rows.length) {
      console.log("⚠️ 未找到目标线路的 route_shapes 行，结束。");
      return;
    }

    // ── 一致性校验：每线 2 行、且恰 1 行反向（修复前态）/ 恰 1 行正向（修复后态）──
    for (const route of SCOPE) {
      const rs = rows.filter((r) => r.route === route);
      if (rs.length !== 2) {
        console.error(`❌ 一致性校验失败：线路 ${route} 应有 2 行，实际 ${rs.length} ⇒ 中止。`);
        process.exit(1);
      }
    }

    // ── 打印定向表 ──
    console.log(`\n${LINE}\n定向分析（3 线 × 2 方向 = 6 行）：`);
    for (const p of rows) {
      const mark = p.reversed ? "反向⚑" : "正向 ";
      console.log(
        `  ${mark}  ${p.route.padEnd(4)} dir=${p.dir} pts=${p.pts.length} ` +
          `forwardDist=${p.fwd.toFixed(0)}m reverseDist=${p.rev.toFixed(0)}m`,
      );
    }
    console.log(`${LINE}`);

    const revSet = new Set(REVERSED_PAIRS.map(([r, d]) => key(r, d)));

    if (ROLLBACK) {
      // 还原：反转「当前正向」的目标行（已 apply 态）；未 apply 时目标行仍反向 ⇒ 跳过
      const targets = rows.filter((r) => revSet.has(key(r.route, r.dir)) && !r.reversed);
      const skipped = rows.filter((r) => revSet.has(key(r.route, r.dir)) && r.reversed);
      for (const s of skipped) console.log(`  · ${s.route} dir=${s.dir} 仍为反向（未修复）⇒ 跳过，无需回滚`);
      if (!targets.length) {
        console.log("\n无需回滚（目标行均未处于已修复态）。");
        return;
      }
      console.log(`\n将还原 ${targets.length} 行（反转 polyline 还原初始方向）：`);
      for (const t of targets) console.log(`  · ${t.route} dir=${t.dir} pts=${t.pts.length}`);
      await applyReversals(pool, targets, "ROLLBACK");
      await report(pool);
      return;
    }

    // APPLY / DRY-RUN：反转「当前反向」且属于目标集的行
    const toFix = rows.filter((r) => revSet.has(key(r.route, r.dir)) && r.reversed);
    console.log(`\n需反转 ${toFix.length} 行（当前反向）：`);
    for (const p of toFix) console.log(`  · ${p.route} dir=${p.dir} pts=${p.pts.length}`);
    console.log(`${LINE}`);

    if (toFix.length !== REVERSED_PAIRS.length) {
      console.error(
        `❌ 异常：预期反转 ${REVERSED_PAIRS.length} 行，实际 ${toFix.length} 行（目标行当前反向者）。` +
          `可能已被修复或数据变动 ⇒ 中止，不写库。`,
      );
      process.exit(1);
    }

    // 反转无损校验
    for (const p of toFix) {
      if (parsePolyline(reversePolyline(p.polyline)).length !== p.pts.length) {
        console.error(`❌ 反转校验失败：${p.route} dir=${p.dir} 点数变化 ⇒ 中止。`);
        process.exit(1);
      }
    }
    console.log("✅ 校验通过：恰 3 行待反转；反转前后点数一致。");

    if (!APPLY) {
      console.log("\nDRY-RUN 结束：**未写库**。核对无误后加 `--apply` 执行。");
      return;
    }

    await applyReversals(pool, toFix, "APPLY");
    await report(pool);
    console.log("回滚：npm run db:migrate-v2150 -- cloud --rollback --allow-prod（把上述 3 行反转还原）。");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
