/**
 * 首页 = 全屏地图 + 分步搜索（src/app/page.tsx，M Map 改版 S2 重构）
 *
 * ── 本次改造（Spec R1/R2/R4）───────────────────────────────────────────
 *   · **全屏地图**（`fixed`；底部让出「底部导航」带，保证高德 Logo/审图号可见）；
 *   · 顶部浮层 = 品牌字标 `M Map` + 定位按钮 + 目的地搜索条（点开分步弹层）；
 *   · **移除**旧大标题「澳门出行」与「通勤计时（旧版）」首页入口（旧计时改由 `/about` 进入）；
 *   · 底导两 tab（首页 / 路线收藏）。
 *
 * ── 地点对收藏回放（PRD §7.5 / 02 §2.3）───────────────────────────────
 *   `/favorites` 点「地点对」→ `/?<query>` → 本页解析出起终点**预填**，进入「可出发」态
 *   （**不自动跳结果页**，由用户确认后点「出发」）。
 *
 * ── 保留的能力 ────────────────────────────────────────────────────────
 *   · 地图懒加载、失败不阻塞（§Q7）；站点图层、实时报站信息卡；「起点不记忆」（R5）。
 */
import BottomNav from "@/components/BottomNav";
import NavShell from "@/components/nav/NavShell";
import { getPool } from "@/lib/db";
import { parseNavParams } from "@/lib/nav/nav-params";
import type { NavPoint } from "@/lib/nav/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";

/** 线路码 → 主题色（供搜索结果/收藏的线路标签渲染，§11.6） */
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

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // ★ JS Key 由服务端以 prop 传入（JS Key 本身可公开；安全密钥只在 /_AMapService 代理里）
  const jsKey = (process.env.AMAP_JS_KEY ?? "").trim();
  const colors = await loadRouteColors();

  // 地点对收藏回放：URL 带 `fromLng…&toLng…` → 预填起终点（进「可出发」态）
  const sp = await searchParams;
  const parsed = parseNavParams(sp);
  const initialFrom: NavPoint | null = parsed?.origin ?? null;
  const initialTo: NavPoint | null = parsed?.dest ?? null;

  return (
    <>
      <NavShell jsKey={jsKey} colors={colors} initialFrom={initialFrom} initialTo={initialTo} />
      {/* ★ v2.10.0：底部合规条**已从地图页移除**（内容迁至 `/help`），
          既解决「选线路弹窗被底部遮挡」，也避免与底导重复。
          `/nav`、`/nav/detail`、`/favorites` 仍各自保留合规条（未受影响）。 */}
      <div className="home-chrome">
        <BottomNav />
      </div>
    </>
  );
}
