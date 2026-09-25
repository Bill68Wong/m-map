/**
 * 验证：cutColored 支持「反向切片」后，21A 段能否正常出「彩段 + 灰底线」。
 * 用法：npx tsx scripts/diag-verify-fix.ts
 *
 * 分两段：
 *   A. 本地 cutNow/cutFixed 对比（旧 vs 新语义，纯函数，不依赖代码改动）；
 *   B. **真实代码路径**：导入 buildColoredLegs，跑修复后的实现，打印 degraded / gray / colored。
 */
import { Pool } from "pg";
import {
  buildColoredLegs,
  chooseShape,
  distM,
  type LL,
  type RouteShapeLite,
} from "../src/lib/nav/route-overview";

try {
  process.loadEnvFile();
} catch {
  /* noop */
}

/** 旧实现 */
function cutNow(pts: LL[], ib: number, ia: number): LL[] | null {
  if (ib > ia) return null;
  return pts.slice(ib, ia + 1);
}
/** 修复实现：非环线反向切片 + 反转，使 colored[0]=board、colored[-1]=alight */
function cutFixed(pts: LL[], ib: number, ia: number): LL[] {
  if (ib <= ia) return pts.slice(ib, ia + 1);
  return pts.slice(ia, ib + 1).reverse();
}

async function main() {
  const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
  if (!url) throw new Error("无 DATABASE_URL");
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  pool.on("error", () => {});

  // 21A 的两方向 shape
  const rows = (
    await pool.query(`SELECT dsat_dir, polyline, start_stop, end_stop FROM route_shapes WHERE route_code='21A' ORDER BY dsat_dir`)
  ).rows as { dsat_dir: string; polyline: string; start_stop: string | null; end_stop: string | null }[];
  const shapes: RouteShapeLite[] = rows.map((r) => ({
    dir: r.dsat_dir,
    polyline: r.polyline,
    startStop: r.start_stop,
    endStop: r.end_stop,
  }));

  // 线上 detail-body 给的锚点（GCJ-02）：T306 → M142
  const board = { lng: 113.56805084703434, lat: 22.150470051743113 };
  const alight = { lng: 113.54245182846634, lat: 22.19272742512328 };

  console.log("── A. 纯函数对比（旧 cutNow vs 新 cutFixed）──");
  const picked = chooseShape(shapes, board, alight)!;
  console.log(`chooseShape 选中 dir=${picked.dir} iBoard=${picked.iBoard} iAlight=${picked.iAlight}`);

  const now = cutNow(picked.pts, picked.iBoard, picked.iAlight);
  console.log(`旧 cutColored：${now === null ? "null ⇒ 降级（整线着色，无灰虚线）" : `${now.length} 点`}`);

  const fixed = cutFixed(picked.pts, picked.iBoard, picked.iAlight);
  const head = fixed[0];
  const tail = fixed[fixed.length - 1];
  console.log(
    `新 cutColored：${fixed.length} 点 · 起点距 board=${distM(head, [board.lng, board.lat]).toFixed(1)}m ` +
      `· 终点距 alight=${distM(tail, [alight.lng, alight.lat]).toFixed(1)}m`,
  );

  console.log("\n── B. 真实代码路径（buildColoredLegs，修复后实现）──");
  const built = buildColoredLegs(
    [
      {
        index: 0,
        route: "21A",
        kind: "bus",
        color: "#E60012",
        board: { code: "T306", lng: board.lng, lat: board.lat },
        alight: { code: "M142", lng: alight.lng, lat: alight.lat },
      },
    ],
    { "21A": shapes },
  )[0];
  const cHead = built.colored[0];
  const cTail = built.colored[built.colored.length - 1];
  console.log(
    `21A：dir=${built.dir} degraded=${built.degraded} ` +
      `gray.pts=${built.gray.length} colored.pts=${built.colored.length} sameRef=${built.colored === built.gray}`,
  );
  console.log(
    `  colored[0] 距 board=${distM(cHead, [board.lng, board.lat]).toFixed(1)}m（应≈0） · ` +
      `colored.at(-1) 距 alight=${distM(cTail, [alight.lng, alight.lat]).toFixed(1)}m（应≈0）`,
  );
  const expectOk =
    built.degraded === false &&
    built.colored !== built.gray &&
    built.colored.length >= 2 &&
    distM(cHead, [board.lng, board.lat]) < 60 &&
    distM(cTail, [alight.lng, alight.lat]) < 60;
  console.log(`  ⇒ ${expectOk ? "✅ 彩段+灰底线成立、degraded=false" : "❌ 未达预期"}`);

  // 顺带：确认 T306/M142 在 dir=0/1 站序里的先后（哪边是正确方向）
  const rs = (
    await pool.query(
      `SELECT rs.dsat_dir, rs.seq, s.code FROM route_stations rs
         JOIN routes r ON r.id=rs.route_id JOIN stations s ON s.code=rs.station_code
        WHERE r.code='21A' AND s.code IN ('T306','M142') ORDER BY rs.dsat_dir, rs.seq`,
    )
  ).rows as { dsat_dir: string; seq: number; code: string }[];
  console.log("\n站序（DB）：", rs.map((r) => `dir${r.dsat_dir}:${r.code}@${r.seq}`).join("  "));

  await pool.end();
  process.exit(expectOk ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
