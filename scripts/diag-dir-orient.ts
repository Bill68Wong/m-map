/**
 * 只读探查：2 / 21A / 59（及全库双向线路）的 route_shapes 几何方向 vs route_stations 站序方向。
 * 用法：npx tsx scripts/diag-dir-orient.ts
 *
 * 判定：按该 dsat_dir 的**首末站坐标**（stations.lng/lat，WGS84）与 polyline 首末顶点（GCJ-02）比较：
 *   forwardDist = d(head, first) + d(tail, last)
 *   reverseDist = d(head, last)  + d(tail, first)
 *   forwardDist <= reverseDist ⇒ forward（几何方向 = 行驶方向）；否则 reversed（需反转）。
 * ⚠️ stations 为 WGS84、polyline 为 GCJ-02，存在数十米系统性偏移；仅用于**长线**首末站定向消歧。
 */
import { Pool } from "pg";
import { distM, parsePolyline, type LL } from "../src/lib/nav/route-overview";

try {
  process.loadEnvFile();
} catch {
  /* noop */
}

const TARGETS = (process.env.DIAG_CODES ?? "2,21A,59").split(",").map((s) => s.trim());

async function main() {
  const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
  if (!url) throw new Error("无 DATABASE_URL");
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  pool.on("error", () => {});

  const rows = (
    await pool.query(
      `SELECT route_code, dsat_dir, points, start_stop, end_stop, md5(polyline) AS md5, polyline
         FROM route_shapes WHERE route_code = ANY($1) ORDER BY route_code, dsat_dir`,
      [TARGETS],
    )
  ).rows as {
    route_code: string;
    dsat_dir: string;
    points: number;
    start_stop: string | null;
    end_stop: string | null;
    md5: string;
    polyline: string;
  }[];

  for (const r of rows) {
    const ends = (
      await pool.query(
        `SELECT
           (array_agg(rs.station_code ORDER BY rs.seq))[1]  AS first_code,
           (array_agg(rs.station_code ORDER BY rs.seq DESC))[1] AS last_code,
           (array_agg(s.lng ORDER BY rs.seq))[1]  AS first_lng,
           (array_agg(s.lat ORDER BY rs.seq))[1]  AS first_lat,
           (array_agg(s.lng ORDER BY rs.seq DESC))[1] AS last_lng,
           (array_agg(s.lat ORDER BY rs.seq DESC))[1] AS last_lat,
           count(*)::int AS n
         FROM route_stations rs
         JOIN routes rr ON rr.id = rs.route_id
         JOIN stations s ON s.code = rs.station_code
         WHERE rr.code = $1 AND rs.dsat_dir = $2`,
        [r.route_code, r.dsat_dir],
      )
    ).rows[0] as {
      first_code: string;
      last_code: string;
      first_lng: number;
      first_lat: number;
      last_lng: number;
      last_lat: number;
      n: number;
    };

    const pts = parsePolyline(r.polyline);
    const head = pts[0] as LL;
    const tail = pts[pts.length - 1] as LL;
    const first: LL = [Number(ends.first_lng), Number(ends.first_lat)];
    const last: LL = [Number(ends.last_lng), Number(ends.last_lat)];
    const fwd = distM(head, first) + distM(tail, last);
    const rev = distM(head, last) + distM(tail, first);
    const orient = fwd <= rev ? "forward" : "reversed";

    console.log(
      `\n${r.route_code} dir=${r.dsat_dir} n=${r.points} md5=${r.md5.slice(0, 8)} ` +
        `stored「${r.start_stop}→${r.end_stop}」`,
    );
    console.log(
      `  站序首尾：${ends.first_code}(${first[0].toFixed(4)},${first[1].toFixed(4)}) → ` +
        `${ends.last_code}(${last[0].toFixed(4)},${last[1].toFixed(4)})  [${ends.n} 站]`,
    );
    console.log(
      `  几何首尾：(${head[0].toFixed(4)},${head[1].toFixed(4)}) → (${tail[0].toFixed(4)},${tail[1].toFixed(4)})`,
    );
    console.log(
      `  forwardDist=${fwd.toFixed(0)}m  reverseDist=${rev.toFixed(0)}m  ⇒ ${orient}` +
        (orient === "reversed" ? "  ⚑ 需反转" : ""),
    );
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
