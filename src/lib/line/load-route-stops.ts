/**
 * 线路站序数据加载（src/lib/line/load-route-stops.ts，v3.6.0 · S6）
 *
 * ── 为什么抽成 lib 而不是留在 route.ts ──────────────────────────────────
 *   `GET /api/route-stops`（客户端切方向时用）与 `/line/[code]` 的**服务端组件**
 *   （首屏直出，避免自我 HTTP 往返）需要**同一份**取数逻辑。若留在 route.ts：
 *     · 服务端组件要么复制一遍 SQL（改一处忘一处），要么 fetch 自己（冷启动多一次往返）；
 *     · 而 **route.ts 不允许 export 辅助函数**（Next 的 `.next/types` 导出白名单检查
 *       会让 build 直接失败，`tsc --noEmit` 抓不到 —— 本项目已踩过一次）。
 *   ⇒ 抽到 lib，两处各自 import。这也是本项目对「route 里想复用」的**唯一**正确解法。
 *
 * ── 三个不能省的处理（与评审通过的 route.ts 完全一致）────────────────────
 *   ① **坐标必须转 GCJ-02**（`stations` 是 WGS84）。漏转 = 整体偏移几百米，
 *      且**只在真地图上看得出来**（单测看不出来）。
 *   ② **里程按站序贪心**：`route_station_mileage` 是**多行制** —— 环线（26 路等）
 *      首尾同站出现两次（里程 0 与全线长）。直接 `Map` 覆盖会让里程"越走越小"，
 *      故每步取「> 上一站里程」的最小候选（与 `build-station-mileage.ts` 同口径）。
 *   ③ **里程是可选数据源**：表缺失 / 无行 ⇒ `mileM: null`，绝不因此让整页失败。
 *
 * server-only（含 `pg`）—— **客户端组件禁止 import 本文件**。
 */
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import type { LineKind, LineStop, RouteStopsOk } from "./line-shared";

/** 加载结果：`not_found` 与 `upstream` 由调用方映射成 404 / 500 */
export type LoadRouteStopsResult =
  | { ok: true; data: RouteStopsOk }
  | { ok: false; reason: "not_found" | "upstream" };

interface RouteRow {
  code: string;
  kind: string;
  color: string | null;
  company: string | null;
}
interface StopRow {
  seq: number;
  code: string;
  name: string | null;
  kind: string | null;
  lat: number | null;
  lng: number | null;
}
interface MileRow {
  station_code: string;
  main_code: string;
  mile_m: number;
}

/** 主码（`T373/1` → `T373`）—— 与 `segment-lookup.ts#mainCodeOf` 同口径 */
const mainCodeOf = (code: string): string => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;

/**
 * 沿站序贪心取里程（多行制消歧，见文件头 ②）。
 * @returns 与 `stops` 等长的数组；无数据的站为 `null`（不猜、不插值）
 */
function mileageAlong(stops: StopRow[], miles: MileRow[]): (number | null)[] {
  const byMain = new Map<string, number[]>();
  for (const m of miles) {
    const k = m.main_code || mainCodeOf(m.station_code);
    const arr = byMain.get(k);
    if (arr) arr.push(m.mile_m);
    else byMain.set(k, [m.mile_m]);
  }
  for (const arr of byMain.values()) arr.sort((a, b) => a - b);

  const out: (number | null)[] = [];
  let prev = -1;
  for (const s of stops) {
    const next = byMain.get(mainCodeOf(s.code))?.find((m) => m > prev);
    if (next === undefined) {
      out.push(null); // 表未覆盖该方向尾部 ⇒ 留空
      continue;
    }
    prev = next;
    out.push(Math.round(next));
  }
  return out;
}

/**
 * 取某线路某方向的站序。
 *
 * @param code     线路码（`26` / `LRT-氹仔线`）
 * @param dirParam 请求方向；**非法或缺失时回落到第一个可用方向**（不猜去程/回程语义）
 */
export async function loadRouteStops(
  code: string,
  dirParam: string,
  poolIn?: Pool,
): Promise<LoadRouteStopsResult> {
  const pool = poolIn ?? getPool();

  // ① 线路本体（轻轨与巴士同表，靠 kind 区分）
  const route = (
    await pool.query(
      `SELECT code, kind, color, company FROM routes WHERE code = $1 AND is_active LIMIT 1`,
      [code],
    )
  ).rows[0] as RouteRow | undefined;
  if (!route) return { ok: false, reason: "not_found" };

  // ② 可用方向（回给前端做方向切换器；缺省取第一个 —— 只保证稳定，不解释语义）
  const dirs = (
    (
      await pool.query(
        `SELECT DISTINCT rs.dsat_dir FROM route_stations rs JOIN routes r ON r.id = rs.route_id
          WHERE r.code = $1 ORDER BY rs.dsat_dir`,
        [code],
      )
    ).rows as { dsat_dir: string }[]
  ).map((r) => r.dsat_dir);
  const dir = dirParam && dirs.includes(dirParam) ? dirParam : (dirs[0] ?? "0");

  // ③ 站序（seq 1 基）+ 站名/坐标（LEFT JOIN：缺站名不能让整行消失）
  const stops = (
    await pool.query(
      `SELECT rs.seq, rs.station_code AS code, s.name_tc AS name, s.kind, s.lat, s.lng
         FROM route_stations rs
         JOIN routes r ON r.id = rs.route_id
         LEFT JOIN stations s ON s.code = rs.station_code
        WHERE r.code = $1 AND rs.dsat_dir = $2
        ORDER BY rs.seq`,
      [code, dir],
    )
  ).rows as StopRow[];

  // ④ 里程（可选数据源；迁移未跑 / 无行 ⇒ 全 null，绝不因此整页 500）
  let miles: MileRow[] = [];
  try {
    miles = (
      await pool.query(
        `SELECT station_code, main_code, mile_m FROM route_station_mileage
          WHERE route_code = $1 AND dsat_dir = $2`,
        [code, dir],
      )
    ).rows as MileRow[];
  } catch {
    /* 表不存在 ⇒ 里程留空，站序照常返回 */
  }
  const mileArr = mileageAlong(stops, miles);

  const items: LineStop[] = stops.map((s, i) => {
    const lat = Number(s.lat);
    const lng = Number(s.lng);
    // ★ 出口一律 GCJ-02（库里是 WGS84）
    const gcj = Number.isFinite(lat) && Number.isFinite(lng) ? wgs84ToGcj02({ lat, lng }) : null;
    return {
      seq: s.seq,
      code: s.code,
      name: s.name ?? s.code,
      kind: (s.kind === "lrt" ? "lrt" : "bus") as LineKind,
      lat: gcj ? Number(gcj.lat.toFixed(6)) : null,
      lng: gcj ? Number(gcj.lng.toFixed(6)) : null,
      mileM: mileArr[i],
    };
  });

  const firstName = items[0]?.name ?? null;
  const lastName = items.length ? items[items.length - 1].name : null;

  return {
    ok: true,
    data: {
      ok: true,
      code: route.code,
      kind: route.kind === "lrt" ? "lrt" : "bus",
      color: route.color ?? "#276299",
      company: route.company ?? null,
      dirs,
      dir,
      label: firstName && lastName ? { from: firstName, to: lastName } : null,
      stops: items,
    },
  };
}
