/**
 * 验证：路径 B 数据修复（route_shapes 方向定向）**已生效**。
 * 用法：npx tsx scripts/diag-verify-dirfix.ts [routeCode]
 *
 * 判定（对当前库内数据，不再在内存里改数据）：
 *   ① 该线路两方向 polyline 的 md5 **不再相同**（曾因抓取错配完全相同）；
 *   ② chooseShape 对「该方向站序首→末」的锚点，选中**正确的 dsat_dir**，且 iBoard ≤ iAlight（正向）；
 *   ③ 该方向 polyline 首尾顶点分别贴近其首/末站（forwardDist 量级正常）。
 */
import { Pool } from "pg";
import { chooseShape, parsePolyline, type RouteShapeLite } from "../src/lib/nav/route-overview";

try {
  process.loadEnvFile();
} catch {
  /* noop */
}

const ROUTE = (process.argv[2] ?? "21A").trim();
/** 该线路「正确方向」的期望：由 route_stations 站序确定的 dsat_dir */
const EXPECT_DIR: Record<string, string> = { "21A": "1", "2": "1", "59": "0" };
/** 期望方向下的 board/alight 锚点（route_stations 站序取中段两站，GCJ-02 由 /api/stations 提供） */
const ANCHOR: Record<string, { board: { lng: number; lat: number }; alight: { lng: number; lat: number } }> = {
  "21A": { board: { lng: 113.56805084703434, lat: 22.150470051743113 }, alight: { lng: 113.54245182846634, lat: 22.19272742512328 } },
};

async function main() {
  const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
  if (!url) throw new Error("无 DATABASE_URL");
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  pool.on("error", () => {});

  const rows = (
    await pool.query(
      `SELECT dsat_dir, polyline, start_stop, end_stop, md5(polyline) AS md5
         FROM route_shapes WHERE route_code=$1 ORDER BY dsat_dir`,
      [ROUTE],
    )
  ).rows as { dsat_dir: string; polyline: string; start_stop: string | null; end_stop: string | null; md5: string }[];

  let pass = 0;
  let fail = 0;
  const ok = (c: boolean, label: string) => {
    if (c) {
      pass++;
      console.log(`  ✅ ${label}`);
    } else {
      fail++;
      console.error(`  ❌ ${label}`);
    }
  };

  console.log(`\n=== ${ROUTE} route_shapes ===`);
  for (const r of rows) {
    console.log(`  dir=${r.dsat_dir} md5=${r.md5.slice(0, 8)} pts=${parsePolyline(r.polyline).length} 「${r.start_stop}→${r.end_stop}」`);
  }
  const md5s = new Set(rows.map((r) => r.md5));
  ok(rows.length === 2 && md5s.size === 2, "① 两方向 polyline md5 不再相同");

  const shapes: RouteShapeLite[] = rows.map((r) => ({
    dir: r.dsat_dir,
    polyline: r.polyline,
    startStop: r.start_stop,
    endStop: r.end_stop,
  }));

  const an = ANCHOR[ROUTE];
  if (!an) {
    console.log(`  （无 ${ROUTE} 的锚点，仅做 md5 检查）`);
  } else {
    const picked = chooseShape(shapes, an.board, an.alight);
    console.log(
      `\n  chooseShape：选中 dir=${picked?.dir} iBoard=${picked?.iBoard} iAlight=${picked?.iAlight} ` +
        `(${picked && picked.iBoard <= picked.iAlight ? "正向" : "反向"})`,
    );
    const expDir = EXPECT_DIR[ROUTE];
    ok(picked?.dir === expDir, `② chooseShape 选中正确方向 dir=${expDir}`);
    ok(!!picked && picked.iBoard <= picked.iAlight, "② 方向为正向（iBoard ≤ iAlight）");

    console.log(
      `  dir=${expDir} board 最近顶点距=${picked?.dBoard.toFixed(1)}m · alight 最近顶点距=${picked?.dAlight.toFixed(1)}m`,
    );
    ok(!!picked && picked.dBoard < 60 && picked.dAlight < 60, "③ 锚点 board/alight 落在所选折线上（≤60m）");
  }

  console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 存在失败"}：pass=${pass} fail=${fail}`);
  await pool.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
