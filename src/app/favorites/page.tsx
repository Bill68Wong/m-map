/**
 * 收藏页 `/favorites`（src/app/favorites/page.tsx，M Map 改版 S4 新增）
 *
 * Server 壳 + 客户端 `FavoritesClient`（`localStorage` 只能在客户端读，F1）。
 * 挂**页级底部导航**（ADR-003：不挂全局布局）。
 * ⚠️ 本页必须在 `src/middleware.ts` 的公开白名单里（fail-closed，否则路人打不开）。
 */
import type { Metadata } from "next";
import BottomNav from "@/components/BottomNav";
import ComplianceBar from "@/components/nav/ComplianceBar";
import FavoritesClient from "@/components/favorites/FavoritesClient";
import ComboSeeder from "@/components/favorites/ComboSeeder";
import { getPool } from "@/lib/db";
import { queryPlaceCoords } from "@/lib/place-coords";
import { HOME_SLUG, PAIR_ORDER } from "@/lib/home-plans-shared";
import type { SeedPlaceCoord } from "@/lib/favorites/presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";

export const metadata: Metadata = {
  title: "路线收藏",
  description: "保存常用的地点对与路线方案，点击即重新规划。",
};

/** 线路码 → 主题色（供方案卡左侧色轨与线路标签，颜色来自线路数据，不纳入 token） */
async function loadRouteColors(): Promise<Record<string, string>> {
  try {
    const res = await getPool().query(`SELECT code, color FROM routes WHERE color IS NOT NULL`);
    const m: Record<string, string> = {};
    for (const r of res.rows as { code: string; color: string }[]) m[r.code] = r.color;
    return m;
  } catch {
    return {};
  }
}

/**
 * 默认组合的端点坐标（★ v2.3.0 / 07 §1.4）：**只能服务端取**（pg + WGS84→GCJ-02）。
 * 取 `home` + `PAIR_ORDER` 三个地点（含澳科大各座区行 —— 座区**不写死**，由客户端选）。
 * 失败 → 空数组（前端 `ComboSeeder` 会跳过注入，不影响本页其余功能）。
 */
async function loadPlaceCoords(): Promise<SeedPlaceCoord[]> {
  try {
    const rows = await queryPlaceCoords({ slugs: [HOME_SLUG, ...PAIR_ORDER] });
    return rows.map((r) => ({ slug: r.slug, name: r.name, zone: r.zone, lng: r.lng, lat: r.lat, label: r.label }));
  } catch {
    return [];
  }
}

export default async function FavoritesPage() {
  const [colors, placeCoords] = await Promise.all([loadRouteColors(), loadPlaceCoords()]);
  return (
    <main className="page page--with-nav">
      {/* ★ 默认组合种子注入（幂等；纯副作用组件，无 UI） */}
      <ComboSeeder coords={placeCoords} />
      <FavoritesClient colors={colors} />
      <ComplianceBar />
      <BottomNav />
    </main>
  );
}
