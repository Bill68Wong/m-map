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
import { getPool } from "@/lib/db";

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

export default async function FavoritesPage() {
  const colors = await loadRouteColors();
  return (
    <main className="page page--with-nav">
      <FavoritesClient colors={colors} />
      <ComplianceBar />
      <BottomNav />
    </main>
  );
}
