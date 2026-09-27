/**
 * 站点沿线里程生成（scripts/build-station-mileage.ts）
 * 用法：npm run db:station-mileage -- cloud --allow-prod
 *
 * 把每条线路每个方向的**站点**投影到其**线路几何**（route_shapes.polyline，GCJ-02），
 * 得到「沿线里程」（米）写入 route_station_mileage —— 进度模型（区间投影）的锚点数据。
 *
 * ── 算法 ─────────────────────────────────────────────────────────────
 *   ① 站坐标两源：station_amap_map（高德匹配，GCJ，主源）→ stations（WGS84→GCJ，兜底）
 *   ② 投影 = 点到折线的**多候选**（≤200m，按沿线里程聚簇去重）
 *   ③ **站序单调贪心**：沿 seq 顺序取「里程 > 上一站」的最近候选——
 *      消解「往返合一几何」上同一物理站出现两次的歧义（车不会倒着开）
 *   ④ 无法投影的站跳过（不写行）；输出对账统计 + 异常告警（相邻里程差异常）
 *
 * ⚠️ 幂等：先 TRUNCATE 再全量写入。
 */
import { Pool } from "pg";
import { wgs84ToGcj02 } from "../src/lib/amap/coord";

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

const rad = (d: number) => (d * Math.PI) / 180;
const R = 6371008.8;
function havM(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
const mainCode = (c: string) => /^[A-Za-z]+\d+/.exec(String(c ?? ""))?.[0] ?? String(c ?? "");

/** 点到折线的多候选（返回 [{m, d}]，按里程升序、40m 内聚簇取最优） */
function candidatesOf(p: [number, number], pts: [number, number][], cum: number[]): { m: number; d: number }[] {
  const kx = Math.cos(rad(p[1])) * 111320, ky = 110540;
  const px = p[0] * kx, py = p[1] * ky;
  const hits: { m: number; d: number }[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (d <= 200) hits.push({ m: cum[i] + t * (cum[i + 1] - cum[i]), d });
  }
  hits.sort((a, b) => a.m - b.m);
  const clusters: { m: number; d: number }[] = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && h.m - last.m <= 40) {
      if (h.d < last.d) { last.m = h.m; last.d = h.d; }
    } else clusters.push({ ...h });
  }
  return clusters;
}

async function main() {
  if (!connStr) { console.error("❌ 未找到连接串"); process.exit(1); }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));
  try {
    // ── 读三源 ──
    const stRows = (await pool.query(
      `SELECT r.code AS route, rs.dsat_dir AS dir, rs.seq, rs.station_code AS code
         FROM route_stations rs JOIN routes r ON r.id = rs.route_id
        WHERE r.kind = 'bus'
        ORDER BY r.code, rs.dsat_dir, rs.seq`,
    )).rows as { route: string; dir: string; seq: number; code: string }[];
    const shapeRows = (await pool.query(
      `SELECT route_code AS route, dsat_dir AS dir, polyline FROM route_shapes WHERE kind = 'bus'`,
    )).rows as { route: string; dir: string; polyline: string }[];
    const amapRows = (await pool.query(
      `SELECT dsat_station_main AS main, amap_lng AS lng, amap_lat AS lat FROM station_amap_map
        WHERE dsat_station_main IS NOT NULL AND amap_lng IS NOT NULL`,
    )).rows as { main: string; lng: number; lat: number }[];
    const stnRows = (await pool.query(
      `SELECT code, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL`,
    )).rows as { code: string; lat: number; lng: number }[];

    const coordOf = new Map<string, [number, number]>();
    for (const r of stnRows) {
      const g = wgs84ToGcj02({ lat: r.lat, lng: r.lng });
      coordOf.set(r.code, [g.lng, g.lat]); // 兜底先放，amap 主源覆盖
    }
    let amapOverride = 0;
    for (const r of amapRows) {
      coordOf.set(r.main, [r.lng, r.lat]);
      amapOverride++;
    }
    console.log(`坐标表：${coordOf.size} 个（高德匹配 ${amapOverride} 覆盖）`);

    const shapeOf = new Map<string, { pts: [number, number][]; cum: number[] }>();
    for (const s of shapeRows) {
      const pts = s.polyline.split(";").map((x) => x.split(",").map(Number) as [number, number]);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + havM(pts[i - 1], pts[i]));
      shapeOf.set(`${s.route}|${s.dir}`, { pts, cum });
    }

    // 分组站序
    const byRouteDir = new Map<string, { seq: number; code: string }[]>();
    for (const r of stRows) {
      const k = `${r.route}|${r.dir}`;
      if (!byRouteDir.has(k)) byRouteDir.set(k, []);
      byRouteDir.get(k)!.push({ seq: r.seq, code: r.code });
    }

    // ── 逐 (route, dir) 贪心生成 ──
    const out: { route: string; dir: string; code: string; main: string; mile: number }[] = [];
    let routesOk = 0, routesNoShape = 0, stationsSkipped = 0, weird = 0;
    for (const [k, list] of byRouteDir) {
      const [route, dir] = k.split("|") as [string, string];
      const sh = shapeOf.get(k);
      if (!sh) { routesNoShape++; continue; }
      list.sort((a, b) => a.seq - b.seq);
      const cands = list.map((st) => {
        const c = coordOf.get(mainCode(st.code));
        return c ? candidatesOf(c, sh.pts, sh.cum) : [];
      });
      let prevM = -Infinity, prevIdx = -1, wrote = 0;
      for (let i = 0; i < list.length; i++) {
        const st = list[i]!, c = cands[i]!;
        if (!c.length) { stationsSkipped++; continue; }
        let pick: number | null = null;
        if (prevIdx === -1) pick = c[0]!.m; // 起点：最小里程
        else pick = c.find((x) => x.m > prevM + 20)?.m ?? null;
        if (pick === null) { stationsSkipped++; continue; }
        // 异常检查：相邻里程差 vs 直线距离（>12 倍告警——可能投影到另一圈）
        if (prevIdx >= 0 && coordOf.has(mainCode(st.code))) {
          const a = coordOf.get(mainCode(list[prevIdx]!.code))!;
          const b = coordOf.get(mainCode(st.code))!;
          const straight = havM(a, b);
          if (straight > 50 && (pick - prevM) / straight > 12) { weird++; }
        }
        out.push({ route, dir, code: st.code, main: mainCode(st.code), mile: Math.round(pick) });
        prevM = pick; prevIdx = i; wrote++;
      }
      if (wrote) routesOk++;
    }

    // ── 写入（多行制：环线站存在两个里程候选，均保留；运行时用车辆里程消歧）──
    await pool.query(`TRUNCATE route_station_mileage`);
    {
      const CHUNK = 800;
      for (let i = 0; i < out.length; i += CHUNK) {
        const part = out.slice(i, i + CHUNK);
        await pool.query(
          `INSERT INTO route_station_mileage (route_code, dsat_dir, station_code, main_code, mile_m)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::float8[])`,
          [part.map((x) => x.route), part.map((x) => x.dir), part.map((x) => x.code), part.map((x) => x.main), part.map((x) => x.mile)],
        );
      }
    }
    console.log(`\n✅ 写入 ${out.length} 行（覆盖 ${routesOk} 个 线路×方向）`);
    console.log(`  无几何跳过的组合 ${routesNoShape} · 无法投影跳过的站 ${stationsSkipped} · 里程差异常告警 ${weird}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => { console.error("✗", e); process.exit(1); });
