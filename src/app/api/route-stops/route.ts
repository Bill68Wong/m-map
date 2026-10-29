/**
 * GET /api/route-stops —— 线路站点全景页的**站序**数据源（v3.6.0 · S6）
 *
 * 用途（架构 §4.1.2 / AC-42a）：`/line/[code]` 全线站序 = 站名 + GCJ-02 坐标 + 沿线里程
 * + 首末站。**报站不进本接口** —— 实时到站由前端逐站懒加载 `/api/station/eta`（单页
 * ≤30 请求、并发 ≤3、轻轨零请求）。分开的理由很实在：站序几小时不变（能长缓存），
 * 报站 20 秒就旧（不能缓存）；混在一起等于两个都只能短缓存。
 *
 * 数据源全是**既有表**（不建表不加列）：`route_stations` / `stations` / `routes` /
 * `route_station_mileage`（里程**可选**：表缺失或无行 ⇒ `mileM: null`，绝不 500）。
 *
 * 三个不能省的处理：
 *   ① **坐标必须转 GCJ-02**（`stations` 是 WGS84）。漏转是「整体偏移几百米」，
 *      且**只在真地图上看得出来**（单测看不出来）。
 *   ② **里程按站序贪心**：`route_station_mileage` 是**多行制** —— 环线（26 路等）首尾
 *      同站出现两次（里程 0 与全线长）。直接 `Map` 覆盖会让里程"越走越小"，故每步取
 *      「> 上一站里程」的最小候选（与 `build-station-mileage.ts` 同口径）。
 *   ③ **`mileM` 是附加字段**（§4.1.2 的 `stops[]` 没有它，主理人派工要求有）：可空，
 *      不改既有字段语义 ⇒ 按旧契约写的消费方不受影响。
 *
 * 缓存 `public, s-maxage=3600`（静态数据，同 `/api/stations`）。**公开只读**；
 * `/api/route-stops` 是新前缀但口令门已于 S2 拆除 ⇒ 无需登记；若将来恢复上锁，
 * **必须**把它加进白名单，否则线上 401。
 */
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { API_ERROR, errorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 15;

const CACHE_HEADER = { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600" };

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

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const code = (sp.get("code") ?? "").trim();
  const dirParam = (sp.get("dir") ?? "").trim();
  if (!code || code.length > 40) return errorResponse(API_ERROR.bad_request);

  try {
    const pool = getPool();

    // ① 线路本体（轻轨与巴士同表，靠 kind 区分）
    const route = (
      await pool.query(
        `SELECT code, kind, color, company FROM routes WHERE code = $1 AND is_active LIMIT 1`,
        [code],
      )
    ).rows[0] as RouteRow | undefined;
    if (!route) {
      return NextResponse.json(
        { ok: false, error: "route_not_found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    // ② 可用方向（回给前端做方向切换器；缺省取第一个 —— 不猜"去程/回程"语义，只保证稳定）
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

    // ④ 里程（可选数据源；迁移未跑 / 无行 ⇒ 全 null，绝不因此 500）
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

    const items = stops.map((s, i) => {
      const lat = Number(s.lat);
      const lng = Number(s.lng);
      // ★ 出口一律 GCJ-02（库里是 WGS84）
      const gcj = Number.isFinite(lat) && Number.isFinite(lng) ? wgs84ToGcj02({ lat, lng }) : null;
      return {
        seq: s.seq,
        code: s.code,
        name: s.name ?? s.code,
        kind: s.kind === "lrt" ? "lrt" : "bus",
        lat: gcj ? Number(gcj.lat.toFixed(6)) : null,
        lng: gcj ? Number(gcj.lng.toFixed(6)) : null,
        mileM: mileArr[i],
      };
    });

    const firstName = items[0]?.name ?? null;
    const lastName = items.length ? items[items.length - 1].name : null;

    return NextResponse.json(
      {
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
      { headers: CACHE_HEADER },
    );
  } catch (e) {
    console.error("[api/route-stops] 失败：", (e as Error).message);
    // 保留空数组形状（消费方按 stops 取值），只把 error 换成固定枚举
    return NextResponse.json({ stops: [], error: API_ERROR.upstream_error }, { status: 500 });
  }
}
