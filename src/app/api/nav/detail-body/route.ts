/**
 * POST /api/nav/detail-body —— 路线详情「弹窗体」数据（2026-09-23 新增）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   全屏详情弹窗（主页「出发」与收藏页点卡入口）不走页面、也**不重算整条 planNav**：
 *   卡片数据前端已持有 ⇒ 本接口只把卡片解出**纵向站条**（`buildStrips`）并附上
 *   「本站台其他线路」实时报站（折叠栏）—— 因此打开详情明显更快，
 *   且**用哪张卡就显示哪张**（planId 不参与定位，从根上消除「点 51 显示 56」）。
 *
 * ── 输入 / 输出 ────────────────────────────────────────────────────────
 *   输入：JSON `{ card: RecommendCard }`（结构同 `/api/nav` 响应的 cards[] 元素）
 *   输出：`{ ok, strips, otherRoutes, foldLive, stationLabel, legs }`
 *   · ★ 2026-09-23 改版：新增 `legs[]`（路线总览逐段几何锚点；契约见附录 A.1）——
 *     与 `card.rides` **一一对应、同序**，每段含线路主题色 + 上/下车站坐标（**GCJ-02**）。
 *     `card.rides` 不含坐标（`RideLegView` 仅站码）⇒ 必须服务端补。
 *     纯**新增字段**，老前端忽略即可 ⇒ 无破坏性变更。
 *
 * ⚠️ 只读接口（不写库）。公开白名单由 `/api/nav` 前缀覆盖（middleware fail-closed 规则）。
 * ⚠️ `card` 仅用于**只读解算**（站序查表 + 实时报站 + 段几何），逐段浅校验，无注入面。
 *
 * ── 降级铁律（对齐附录 A.1.4）───────────────────────────────────────────
 *   站坐标 / 线路色**两条批量查询并行**（`Promise.all`，**绝不进循环** —— 防 N+1），
 *   且各自 `try/catch`：**色查询失败 → 该段 color=null（客户端回落 var(--accent)）**；
 *   **站查询失败 → 所有 board/alight=null（整体降级，不 500）**。
 *   即：附加几何**永不阻塞**详情主体（失败也照常返回 strips/fold）。
 */
import { NextResponse } from "next/server";
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { nowBucketOf } from "@/lib/rebuild/buckets";
import { buildStrips } from "@/lib/nav/strips";
import { foldDataOfCard } from "@/lib/nav/detail-fold";
import { loadStatics } from "@/lib/recommend/query";
import { mainCodeOf } from "@/lib/recommend/segment-lookup";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import type { RecommendCard } from "@/lib/recommend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 30;

/** 路线总览的逐段几何锚点（与 card.rides 一一对应、同序；见附录 A.1.2） */
interface OverviewLeg {
  /** 段索引 = card.rides 下标（客户端据此与 card 对齐，勿依赖数组顺序） */
  index: number;
  route: string;
  kind: "bus" | "lrt";
  /** 线路主题色（routes.color）；缺省 null → 客户端回落 var(--accent) */
  color: string | null;
  /** 上车站（GCJ-02）；解析失败 = null（客户端降级，不阻塞） */
  board: { code: string; lng: number; lat: number } | null;
  /** 下车站（GCJ-02）；同上 */
  alight: { code: string; lng: number; lat: number } | null;
}

/** 主码 → 坐标（GCJ-02） */
type Coord = { lng: number; lat: number };

/**
 * 由「卡片载具段」组装路线总览所需的 `legs[]`。
 *
 * ① 收集去重：全部 `ride.route`（色）与 `board/alight` 主码（坐标）；
 * ② 两条批量查询**并行**（`Promise.all`）：站坐标（WGS84）+ 线路色（数据）；
 * ③ 主码 → 坐标内存索引（同站多台 → 保留首个非空，合成一个物理点）；
 * ④ 坐标 WGS84 → GCJ-02（与 /api/stations、/api/route-vehicles 同源）。
 * 任一查询失败**只降级该段字段**（color / board / alight → null），**绝不抛错**。
 */
async function buildOverviewLegs(pool: Pool, rides: RecommendCard["rides"]): Promise<OverviewLeg[]> {
  // ① 收集（去重）
  const routeCodes = [...new Set(rides.map((r) => r.route))];
  const mains = new Set<string>();
  for (const r of rides) {
    mains.add(mainCodeOf(r.board));
    mains.add(mainCodeOf(r.alight));
  }
  const mainCodes = [...mains];

  // ② 两条批量查询并行；各自 try/catch 降级
  const [coordMap, colorMap] = await Promise.all([
    // ── 站坐标（WGS84；取主码，容忍 `/<平台>` 后缀）──
    (async (): Promise<Map<string, Coord>> => {
      const m = new Map<string, Coord>();
      if (!mainCodes.length) return m;
      try {
        const res = await pool.query(
          `SELECT code, lat, lng FROM stations
            WHERE lat IS NOT NULL AND lng IS NOT NULL
              AND (code = ANY($1::text[]) OR regexp_replace(code, '/\\d+$', '') = ANY($1::text[]))`,
          [mainCodes],
        );
        for (const row of res.rows as { code: string; lat: number; lng: number }[]) {
          const main = mainCodeOf(String(row.code));
          if (m.has(main)) continue; // 同站多台 → 保留首个非空
          const lat = Number(row.lat);
          const lng = Number(row.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          const gcj = wgs84ToGcj02({ lat, lng }); // ★ 出口一律 GCJ-02
          m.set(main, { lng: gcj.lng, lat: gcj.lat });
        }
      } catch (e) {
        console.warn(
          "[api/nav/detail-body] 站坐标查询失败（board/alight 整体降级为 null）：",
          (e as Error).message,
        );
      }
      return m;
    })(),
    // ── 线路主题色（数据；勿硬编码）──
    (async (): Promise<Map<string, string>> => {
      const m = new Map<string, string>();
      if (!routeCodes.length) return m;
      try {
        const res = await pool.query(
          `SELECT code, color FROM routes WHERE code = ANY($1::text[])`,
          [routeCodes],
        );
        for (const row of res.rows as { code: string; color: string | null }[]) {
          const color = row.color != null ? String(row.color).trim() : "";
          if (color) m.set(String(row.code), color);
        }
      } catch (e) {
        console.warn(
          "[api/nav/detail-body] 线路色查询失败（color 置 null，客户端回落）：",
          (e as Error).message,
        );
      }
      return m;
    })(),
  ]);

  // ③ 组装：与 card.rides 一一对应、同序（index = 下标）
  const coordOf = (code: string): { code: string; lng: number; lat: number } | null => {
    const main = mainCodeOf(code);
    const c = coordMap.get(main);
    return c ? { code: main, lng: c.lng, lat: c.lat } : null;
  };
  return rides.map((r, i) => ({
    index: i,
    route: r.route,
    kind: r.kind,
    color: colorMap.get(r.route) ?? null,
    board: coordOf(r.board),
    alight: coordOf(r.alight),
  }));
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { card?: RecommendCard };
    const card = body?.card;
    // 浅校验：必须有非空 rides，且逐条含 route / board / alight 字符串
    if (!card || !Array.isArray(card.rides) || !card.rides.length) {
      return NextResponse.json({ ok: false, error: "missing_card" }, { status: 400 });
    }
    for (const r of card.rides) {
      if (
        !r ||
        typeof r.route !== "string" ||
        typeof r.board !== "string" ||
        typeof r.alight !== "string"
      ) {
        return NextResponse.json({ ok: false, error: "bad_rides" }, { status: 400 });
      }
    }

    const pool = getPool();
    // ★ 静态索引与 leg 几何互相独立 ⇒ 并行（缩短 p95）；leg 内部查询也各自降级
    const [st, legs] = await Promise.all([loadStatics(pool), buildOverviewLegs(pool, card.rides)]);
    const nowMs = Date.now();
    const nowBucket = nowBucketOf(nowMs);
    const strips = buildStrips(card, {
      routeIdx: st.routeIdx,
      segIdx: st.segIdx,
      nameOf: st.routeIdx.nameOf,
      nowBucket,
    });
    const fold = await foldDataOfCard(pool, st, card, nowMs);

    return NextResponse.json(
      {
        ok: true,
        strips,
        otherRoutes: fold.otherRoutes,
        foldLive: fold.foldLive,
        stationLabel: fold.stationLabel,
        legs,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/nav/detail-body] 失败：", msg);
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500 });
  }
}
