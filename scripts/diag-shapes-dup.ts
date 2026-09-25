/**
 * 只读统计：route_shapes 里「两方向 polyline 完全相同」的线路占比（方向匹配失败面）。
 * 用法：npx tsx scripts/diag-shapes-dup.ts
 */
import { Pool } from "pg";
try {
  process.loadEnvFile();
} catch {
  /* noop */
}

async function main() {
  const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
  if (!url) throw new Error("无 DATABASE_URL");
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  pool.on("error", () => {});

  const tot = (
    await pool.query(
      `SELECT count(DISTINCT route_code)::int AS routes,
              count(*)::int AS rows
         FROM route_shapes`,
    )
  ).rows[0] as { routes: number; rows: number };
  console.log(`route_shapes 总计：${tot.routes} 条线路 / ${tot.rows} 行`);

  const multi = (
    await pool.query(
      `SELECT route_code,
              count(*)::int AS dirs,
              count(DISTINCT md5(polyline))::int AS distinct_poly,
              bool_and(amap_line_id IS NOT NULL) AS all_have_id
         FROM route_shapes
        GROUP BY route_code
       HAVING count(*) >= 2`,
    )
  ).rows as { route_code: string; dirs: number; distinct_poly: number; all_have_id: boolean }[];
  const dup = multi.filter((m) => m.distinct_poly === 1);
  console.log(`\n多方向线路：${multi.length} 条`);
  console.log(`  其中「两方向 polyline 完全相同」：${dup.length} 条`);
  console.log(`  例如：${dup.slice(0, 40).map((d) => d.route_code).join(", ")}`);

  // 抽样看 amap_line_id 是否也相同（同一条高德线被塞给两个方向）
  if (dup.length) {
    const codes = dup.slice(0, 8).map((d) => d.route_code);
    const rows = (
      await pool.query(
        `SELECT route_code, dsat_dir, amap_line_id, start_stop, end_stop
           FROM route_shapes WHERE route_code = ANY($1) ORDER BY route_code, dsat_dir`,
        [codes],
      )
    ).rows as {
      route_code: string;
      dsat_dir: string;
      amap_line_id: string | null;
      start_stop: string | null;
      end_stop: string | null;
    }[];
    console.log("\n抽样明细：");
    for (const r of rows) {
      console.log(`  ${r.route_code} dir=${r.dsat_dir} id=${r.amap_line_id} ${r.start_stop}→${r.end_stop}`);
    }
  }

  // 单方向线路（无法判断对错）
  const single = (
    await pool.query(
      `SELECT route_code, count(*)::int AS n FROM route_shapes GROUP BY route_code HAVING count(*)=1`,
    )
  ).rows as { route_code: string; n: number }[];
  console.log(`\n单方向线路：${single.length} 条`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
