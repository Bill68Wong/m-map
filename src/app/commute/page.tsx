/**
 * 旧首页（原 `/` 的 `HomeClient` 原样迁此）（src/app/commute/page.tsx，v1.3.0 · T04）
 *
 * 产品口径（§2.E）：新首页 `/` 改为全澳导航搜索页后，**旧首页功能完整保留**于 `/commute`
 * —— 方向卡 / 座区选择，**行为一字不改**（开发者模式入口已于 v3.6.0 随口令门一并移除）。
 * ⚠️ 旧功能的座区仍走 `useZone` 的 localStorage（起点≠座区，不受「起点不记忆」影响）。
 */
import HomeClient from "@/components/HomeClient";
import { queryActiveSession, queryPlans } from "@/lib/home-plans";

export const dynamic = "force-dynamic";

export default async function Commute() {
  let plans: Awaited<ReturnType<typeof queryPlans>> = [];
  let active: Awaited<ReturnType<typeof queryActiveSession>> = null;
  let dbError: string | null = null;

  try {
    [plans, active] = await Promise.all([queryPlans(), queryActiveSession()]);
  } catch (err) {
    // ★ v3.1.1 #5：原始错误**只进服务端日志**（界面走用户语言，见 HomeClient）
    console.error("[commute] 方案数据加载失败：", err);
    dbError = (err as Error).message;
  }

  return <HomeClient plans={plans} active={active} dbError={dbError} />;
}
