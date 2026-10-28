/**
 * 只读诊断：21A（及任意线路）route_shapes 两方向是否同线 + route_stations 站序。
 * 用法：npx tsx scripts/diag-21a-db.ts [code]
 */
import { Pool } from "pg";
try {
  process.loadEnvFile();
} catch {
  /* noop */
}

const code = (process.argv[2] ?? "21A").trim();

async function main() {
  const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
  if (!url) throw new Error("无 DATABASE_URL");
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  pool.on("error", () => {});

  // 1) route_shapes 两方向
  const shapes = (
    await pool.query(
      `SELECT dsat_dir, amap_line_id, amap_name, amap_dir, points, start_stop, end_stop,
              md5(polyline) AS hash, left(polyline, 60) AS head, right(polyline, 60) AS tail
         FROM route_shapes WHERE route_code=$1 ORDER BY dsat_dir`,
      [code],
    )
  ).rows as {
    dsat_dir: string;
    amap_line_id: string | null;
    amap_name: string | null;
    amap_dir: string | null;
    points: number;
    start_stop: string | null;
    end_stop: string | null;
    hash: string;
    head: string;
    tail: string;
  }[];
  console.log(`\n=== route_shapes ${code} ===`);
  for (const s of shapes) {
    console.log(
      `  dir=${s.dsat_dir} amap_line_id=${s.amap_line_id} amap_dir=${s.amap_dir} pts=${s.points}\n` +
        `         start=${s.start_stop} end=${s.end_stop}\n` +
        `         md5=${s.hash}\n` +
        `         head=${s.head}\n         tail=${s.tail}`,
    );
  }
  if (shapes.length >= 2) {
    const samePoly = shapes[0].hash === shapes[1].hash;
    console.log(`  ⚑ 两方向 polyline 完全一致 = ${samePoly}`);
  }

  // 2) route_stations 站序（每方向首/末站 + 站数）
  const rs = (
    await pool.query(
      `SELECT rs.dsat_dir, rs.seq, s.code, s.name_tc, s.lat, s.lng
         FROM route_stations rs
         JOIN routes r ON r.id = rs.route_id
         JOIN stations s ON s.code = rs.station_code
        WHERE r.code=$1 ORDER BY rs.dsat_dir, rs.seq`,
      [code],
    )
  ).rows as { dsat_dir: string; seq: number; code: string; name_tc: string; lat: number | null; lng: number | null }[];
  console.log(`\n=== route_stations ${code} ===`);
  const byDir = new Map<string, { dsat_dir: string; seq: number; code: string; name_tc: string }[]>();
  for (const r of rs) byDir.set(r.dsat_dir, [...(byDir.get(r.dsat_dir) ?? []), r]);
  for (const [d, list] of byDir) {
    console.log(
      `  dir=${d}: n=${list.length} 首站=${list[0]?.code}(${list[0]?.name_tc}) 末站=${list[list.length - 1]?.code}(${list[list.length - 1]?.name_tc})`,
    );
  }

  // 3) 关键站（T306 / M142）在各方向的 seq
  for (const tgt of ["T306", "M142"]) {
    const row = (
      await pool.query(
        `SELECT rs.dsat_dir, rs.seq FROM route_stations rs
           JOIN routes r ON r.id=rs.route_id
           JOIN stations s ON s.code=rs.station_code
          WHERE r.code=$1 AND s.code=$2 ORDER BY rs.dsat_dir, rs.seq`,
        [code, tgt],
      )
    ).rows as { dsat_dir: string; seq: number }[];
    console.log(`  站 ${tgt} 的 seq：${row.map((x) => `dir${x.dsat_dir}=${x.seq}`).join(", ") || "（不在本线）"}`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
