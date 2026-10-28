/**
 * GET/POST /api/fav-routes —— 收藏「查看路线」页的数据源（2026-09-22 新增）
 *
 * ── 它取代了什么 ──────────────────────────────────────────────────────
 *   旧版「路线收藏 → 组合 → 某条路线」是**拿模型 + 高德现算**的（`ComboPlans` 的「重新规划」），
 *   不稳定且与用户当初定的方案可能不一致。产品拍板：**路线固定入库** ⇒ 本接口读写
 *   `favorite_routes` 表（一行 = 一条**不合并**的路线）。
 *
 * ── GET ───────────────────────────────────────────────────────────────
 *   `?from=<slug>&to=<slug>` —— `home` / `school` / `gate` / `hengqin`
 *   返回 `{ routes: [{ id, routeKey, name, routeLabels, segs, source, sortOrder }] }`
 *   · 只返回 `is_active = true`，按 `sort_order` 升序
 *   · 无参数 ⇒ 返回全部（按 OD 分组，供调试）
 *
 * ── POST ──────────────────────────────────────────────────────────────
 *   body = `{ route }`（`routeKey` 存在 ⇒ upsert；`source` 强制写 `user`）
 *   用于「流程图编辑页」保存 —— 用户改过步行/速度/档位、或新增线路后落库。
 *   ⚠️ `source` 一律写 `user`（保护用户编辑，重跑导入脚本不覆盖）。
 *
 * 幂等：GET 只读；POST 按 `route_key` upsert。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 15;

/** 允许的 OD slug（与前端 `endpointSlug` 口径一致） */
const SLUGS = new Set(["home", "school", "gate", "hengqin"]);

interface Row {
  id: number;
  route_key: string;
  from_slug: string;
  to_slug: string;
  name: string;
  route_labels: string[];
  segs: unknown;
  source: string;
  sort_order: number;
}

function toView(r: Row) {
  return {
    id: r.id,
    routeKey: r.route_key,
    fromSlug: r.from_slug,
    toSlug: r.to_slug,
    name: r.name,
    routeLabels: r.route_labels,
    segs: r.segs,
    source: r.source,
    sortOrder: r.sort_order,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    const where: string[] = ["is_active = true"];
    const params: unknown[] = [];
    if (from) {
      if (!SLUGS.has(from)) return NextResponse.json({ routes: [], error: "bad_from" }, { status: 400 });
      params.push(from);
      where.push(`from_slug = $${params.length}`);
    }
    if (to) {
      if (!SLUGS.has(to)) return NextResponse.json({ routes: [], error: "bad_to" }, { status: 400 });
      params.push(to);
      where.push(`to_slug = $${params.length}`);
    }

    const res = await getPool().query(
      `SELECT id, route_key, from_slug, to_slug, name, route_labels, segs, source, sort_order
         FROM favorite_routes
        WHERE ${where.join(" AND ")}
        ORDER BY from_slug, to_slug, sort_order, id`,
      params,
    );
    return NextResponse.json({ routes: (res.rows as Row[]).map(toView) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/fav-routes] GET 失败：", msg);
    return NextResponse.json({ routes: [], error: msg.slice(0, 300) }, { status: 500 });
  }
}

interface PostBody {
  route?: {
    routeKey?: string;
    fromSlug?: string;
    toSlug?: string;
    name?: string;
    routeLabels?: string[];
    segs?: unknown;
    sortOrder?: number;
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as PostBody;
    const r = body.route;
    if (!r?.routeKey || !r.fromSlug || !r.toSlug || !r.name || !Array.isArray(r.routeLabels) || !r.segs) {
      return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
    }
    if (!SLUGS.has(r.fromSlug) || !SLUGS.has(r.toSlug)) {
      return NextResponse.json({ ok: false, error: "bad_slug" }, { status: 400 });
    }

    const res = await getPool().query(
      `INSERT INTO favorite_routes
         (route_key, from_slug, to_slug, zones, name, route_labels, segs, source, is_active, sort_order)
       VALUES ($1,$2,$3,'{}',$4,$5,$6::jsonb,'user',true,$7)
       ON CONFLICT (route_key) DO UPDATE SET
         name         = EXCLUDED.name,
         route_labels = EXCLUDED.route_labels,
         segs         = EXCLUDED.segs,
         sort_order   = EXCLUDED.sort_order,
         source       = 'user',
         updated_at   = now()
       RETURNING id`,
      [
        r.routeKey,
        r.fromSlug,
        r.toSlug,
        r.name.slice(0, 120),
        r.routeLabels,
        JSON.stringify(r.segs),
        Number.isFinite(r.sortOrder) ? r.sortOrder : 999,
      ],
    );
    return NextResponse.json({ ok: true, id: (res.rows[0] as { id: number }).id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/fav-routes] POST 失败：", msg);
    return NextResponse.json({ ok: false, error: msg.slice(0, 300) }, { status: 500 });
  }
}
