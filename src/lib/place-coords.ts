/**
 * 默认组合端点坐标（src/lib/place-coords.ts，v2.3.0 · 07 §1.4）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   旧计时 4 预设（`PLACE_SHORT`）内置为「默认组合」时，需要 **GCJ-02 端点坐标**。
 *   真源 = **`place_coords` JOIN `places`**（坐标为 **WGS84**，带 `zone` 粒度）；
 *   本模块在**服务端**取数 → `wgs84ToGcj02()` 转 GCJ-02（构建 `FavoriteEndpoint` 用）。
 *
 * ── ★ 澳門科技大學座区不写死（裁定 2026-09-20）────────────────────────────────
 *   `school` 有多档 `zone`（B/C · N/O · R）⇒ **原样返回全部 zone 行**，
 *   由消费方按全局 `must.zone` 现有逻辑选择；此处**不固化**某一档。
 *
 * ⚠️ **仅服务端**（含 pg）—— 严禁被客户端组件 import；客户端由服务端组件/接口下发结果。
 * 🚫 不新增端点（07 纪律）：本模块是**既有服务端函数**，由上层复用。
 */
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { PLACE_SHORT } from "@/lib/home-plans-shared";

/** 一个「地点 × 座区」端点（坐标 **GCJ-02**，可直接给高德地图/导航使用） */
export interface PlaceCoordEndpoint {
  /** place slug（`home` / `school` / `hengqin` / `gate`） */
  slug: string;
  /** 库内地点名（如 `擎天汇 T8`） */
  name: string;
  /** 澳門科技大學座区（`B/C` | `N/O` | `R`）；非澳門科技大學 place 为 `null` */
  zone: string | null;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
  /** 展示短名（`PLACE_SHORT[slug] ?? name`）—— 端点 label 用 */
  label: string;
  /** 坐标来源（`place_coords.source`：`manual` | `amap`） */
  source: string;
}

/**
 * 读取地点端点坐标并把 **WGS84 → GCJ-02**。
 * @param opts.slugs 限定 slug（缺省 = 全部 `is_active` 地点，含各区）
 * @param opts.pool  复用调用方连接池（缺省用 `getPool()`）
 */
export async function queryPlaceCoords(
  opts: { slugs?: string[]; pool?: Pool } = {},
): Promise<PlaceCoordEndpoint[]> {
  const pool = opts.pool ?? getPool();
  const params: unknown[] = [];
  let where = "p.is_active";
  if (opts.slugs?.length) {
    params.push(opts.slugs);
    where += ` AND p.slug = ANY($${params.length}::text[])`;
  }
  const res = await pool.query(
    `SELECT p.slug, p.name, pc.zone, pc.lat, pc.lng, pc.source
       FROM place_coords pc
       JOIN places p ON p.id = pc.place_id
      WHERE ${where}
      ORDER BY p.slug, pc.zone NULLS FIRST`,
    params,
  );

  const out: PlaceCoordEndpoint[] = [];
  for (const r of res.rows as Record<string, unknown>[]) {
    const slug = String(r.slug ?? "");
    const lat = Number(r.lat);
    const lng = Number(r.lng);
    if (!slug || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // ★ WGS84 → GCJ-02（与 `/api/stations` 同一口径；澳门适用 GCJ-02，已实测）
    const gcj = wgs84ToGcj02({ lat, lng });
    const name = String(r.name ?? "");
    out.push({
      slug,
      name,
      zone: r.zone === null || r.zone === undefined ? null : String(r.zone),
      lng: gcj.lng,
      lat: gcj.lat,
      label: PLACE_SHORT[slug] ?? name,
      source: String(r.source ?? "manual"),
    });
  }
  return out;
}
