import { NextRequest, NextResponse } from "next/server";
import { queryEta, type EtaBus } from "@/lib/dsat/eta";
import { getPool } from "@/lib/db";
import { nowBucketOf } from "@/lib/rebuild/buckets";
import { loadStatics } from "@/lib/recommend/query";
import { collectMoving, fetchLocSegments, toBusArrival } from "@/lib/recommend/live";

/** 就近部署：Supabase 新加坡池化器 → sin1 */
export const preferredRegion = "sin1";

/**
 * GET /api/dsat/eta?station=T358&routes=26,51A&dir=0&dest=C688[&force=1]
 * 实时车距（薄封装，核心逻辑在 src/lib/dsat/eta.ts 与自动快照共用）
 * 5s 缓存已内置于 queryEta（按 站|线路|dir|dest 聚合；v0.8.1 10s → 5s）
 * force=1：系统打点（depart/wait_start/alight）绕过缓存直查并回写；手动刷新不带
 */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const station = sp.get("station")?.trim() ?? "";
  const routesParam = sp.get("routes")?.trim() ?? "";
  const dir = sp.get("dir")?.trim() || "0";
  const dest = sp.get("dest")?.trim() || "";
  const force = sp.get("force") === "1";

  if (!station || !routesParam) {
    return NextResponse.json({ error: "缺少 station 或 routes 参数" }, { status: 400 });
  }
  const routes = routesParam
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .slice(0, 6); // 最多 6 条（与 queryEta/fleet-snapshot 上限一致；横琴 6 线方案不再截断）
  if (routes.length === 0) {
    return NextResponse.json({ error: "routes 参数为空" }, { status: 400 });
  }

  // v0.20.9：可选「按线路指定站台」smap=26:M9/2,51:M9/4（合并卡各线站台不同）
  const smapParam = sp.get("smap")?.trim() ?? "";
  let stationByRoute: Record<string, string> | undefined;
  if (smapParam) {
    stationByRoute = {};
    for (const pair of smapParam.split(",")) {
      const [r, st] = pair.split(":");
      if (r && st) stationByRoute[r.trim()] = st.trim();
    }
  }
  const data = await queryEta(station, routes, dir, dest, force, stationByRoute);

  // ★ v3.5.0：「还有 N 站」全面量化——对在途/在站车补单值「约 X 分钟」（含区间进度位置修正）。
  //   整体 try/catch：任何一环失败 → 只返回原 data（旧行为，前端自动降级不显示分钟）。
  try {
    const pool = getPool();
    const st = await loadStatics(pool);
    const nowBucket = nowBucketOf(Date.now());
    const results = data.results as unknown as {
      route: string;
      ok: boolean;
      dir?: string;
      nearest?: EtaBus;
      second?: EtaBus;
      rest?: EtaBus[];
      eta?: unknown;
      eta2?: unknown;
    }[];
    const moving = collectMoving(results);
    const locOf = await fetchLocSegments(pool, moving);
    for (const r of results) {
      if (!r.ok || !r.nearest) continue;
      const plate = r.nearest.plate ?? null;
      r.eta = toBusArrival(
        st.routeIdx,
        st.segIdx,
        r.route,
        r.dir ?? dir,
        r.nearest,
        nowBucket,
        plate ? (locOf.get(`${r.route}|${plate}`) ?? null) : null,
      );
      if (r.second) {
        const p2 = r.second.plate ?? null;
        r.eta2 = toBusArrival(
          st.routeIdx,
          st.segIdx,
          r.route,
          r.dir ?? dir,
          r.second,
          nowBucket,
          p2 ? (locOf.get(`${r.route}|${p2}`) ?? null) : null,
        );
      }
    }
  } catch {
    /* 量化增强失败 → 保持原响应（前端不显示分钟） */
  }

  return NextResponse.json(data);
}
