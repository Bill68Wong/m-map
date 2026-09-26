import { NextRequest, NextResponse } from "next/server";

/**
 * 口令门中间件 · ★ v1.1.10：改为**分级保护**（用户 2026-09-17 口径）
 *
 * ── 为什么要改 ────────────────────────────────────────────────────────
 * 用户的需求拆成两句：
 *   · 「网站是做给别人用的，当然要公开」→ 推荐功能（首页 / 推荐 / 详情 / 合规）**任何人都能用**
 *   · 「开发者模式只有我能开，数据只有我能看」→ 记录 / 统计 / 自由记站 / 计时 / 开发者页**要口令**
 * 旧实现是一刀切（配了口令就全站锁、没配就全站开），两头都不对 ——
 * 实测线上 `ACCESS_PASSWORD` 未配置 ⇒ 守卫整体失效 ⇒ **全站连数据页都敞开**。
 *
 * ── 新策略 ───────────────────────────────────────────────────────────
 * **默认拒绝（fail-closed）**：只有明确列在白名单里的路径才公开，其余一律要口令。
 *   这样以后新增页面/接口**不会因为忘记加名单而意外裸露**（比「默认公开」安全得多）。
 *
 * ⚠️ `ACCESS_PASSWORD` 未配置时：**生产环境同样拒绝受保护区**（安全失败方向），
 *    开发环境放行（本地调试方便）。这样即使忘了配环境变量，也不会把数据敞开。
 *
 * ⚠️ cookie 值即口令本身（HttpOnly 防 JS 读取、HTTPS 传输、仅发往本站）。
 */

/** ① 完全公开的**页面**（精确匹配，不含子路径）—— 别人用的推荐功能 + 合规说明 + 登录页 */
const PUBLIC_PAGES = new Set([
  "/",
  "/recommend",
  "/card",
  "/about",
  "/login",
  // ⚠️ 2026-09-23 改版：`/nav`、`/nav/detail` 独立页**已删除**（功能并入首页全屏弹窗）。
  //    旧链接由下方 middleware 顶部 **308 重定向**兜底 → 首页。故从白名单移除（fail-closed）。
  "/commute", // 旧首页（原 `/` 的 HomeClient 原样迁此）
  // ★ M Map 改版 S4：路线收藏页（新增公开页；fail-closed 必须显式加入）
  "/favorites", // 路线收藏
]);

/** ② 完全公开的**接口 / 静态资源**（前缀匹配） */
const PUBLIC_PREFIXES = [
  "/api/auth", // 登录接口本身
  "/api/recommend", // 推荐卡片数据（公开浏览的核心）
  "/api/card", // 详情页数据（公开浏览的核心）
  "/api/poi/suggest", // ★ 全澳导航·POI 搜索建议（公众可搜；设计 §2.E / R-10）
  "/api/nav", // ★ 全澳导航·路线结果（公众可用；设计 §2.E）
  "/api/stations", // ★ v2.1.0 首页地图·全量巴士站点（公众图层数据）
  "/api/station/eta", // ★ v2.1.0 首页地图·站点实时报站（信息卡）
  // ★ 2026-09-22 路线收藏·「查看路线」页：读库路线（GET）+ 保存前校验（POST）
  //   ⚠️ 该前缀同时覆盖 POST 保存接口 —— 与公开页 `/favorites` 同一信任级别
  //   （用户在自己浏览器里编辑并落库；非商业个人项目，接受此放宽）。
  "/api/fav-routes",
  // ★ 2026-09-22 公共交通路线：线路清单 + 线路走向（地图画线用）
  //   ⚠️⚠️ **fail-closed 下每新增一个 API 都必须显式加白名单** —— 忘加 = 线上 401。
  //     本项目已因此踩过**两次**（`/api/fav-routes` 与本次 `/api/route-*`）⇒ 记牢。
  "/api/route-lines",
  "/api/route-shapes",
  // ★ v2.10.0 路线查看模式·在途车辆实时位置（GET）—— 与 route-lines/shapes 同一信任级别
  //   ⚠️ 第三次记牢：fail-closed 下**每新增一个 API 都必须显式加白名单**，忘加 = 线上 401。
  "/api/route-vehicles",
  "/_AMapService", // ★ 高德 JS API 安全代理（浏览器直连；密钥不下发前端，见 §2.D）
  "/api/amap-service", // ↑ 同一处理器的真实路由（`/_AMapService` 经 rewrite 指向它）
  "/_next", // 构建产物
  // ★ v2.15.0 品牌资产目录（标志 / 横排字标 / 深色版）。纯静态图形，无任何敏感信息；
  //   用**前缀**而非逐个列文件 —— 该目录以后新增资产（分享卡 / 关于页）不必再改本文件。
  "/brand",
];

/** ③ 完全公开的**精确路径**（静态文件）
 *  ⚠️⚠️ fail-closed：根级静态资源必须**逐个登记**，漏登 = 线上被 307 到 /login
 *     （表现为「图标 / 地图钉不显示」，且**只在配了 ACCESS_PASSWORD 的生产环境复现**）。
 *     本轮教训：`/pin-destination.svg` 由 v2.15「终点钉 SVQ 化」引入时漏登 —— 一并补齐。 */
const PUBLIC_FILES = new Set([
  "/favicon.ico",
  "/manifest.webmanifest",
  // ── 品牌 favicon / PWA 图标（v2.15.0 定稿六件套）──
  "/icon.svg",
  "/icon-16.png",
  "/icon-32.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
  "/apple-touch-icon.png",
  // ── 地图静态图形（CSS url() 引用）──
  "/pin-destination.svg",
  "/pin-destination-mono.svg",
  /* ★ v3.1.1（#4 起点钉新增）：根级 `public/` 新文件必须显式登记 —— 漏登 = 线上被 307 到 /login，
     起点钉在配口令的生产环境直接 404（本地无口令不复现；见铁律「fail-closed 每新增一文件都要登记」）。 */
  "/pin-origin.svg",
]);

/** ④ 由自身 Bearer 鉴权、不受口令门约束（Vercel Cron 重算派生数据） */
const SELF_AUTHED = new Set(["/api/cron/rebuild"]);

/** 该路径是否公开？ */
function isPublic(pathname: string): boolean {
  if (PUBLIC_FILES.has(pathname) || SELF_AUTHED.has(pathname)) return true;
  if (PUBLIC_PAGES.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // ★ 2026-09-23 改版：`/nav`、`/nav/detail` 两个独立页**已删除**（功能并入首页全屏弹窗）。
  //   旧链接（书签 / 分享 / 收藏夹里的 `/nav/detail?...`）→ **308 永久重定向到首页**。
  //   ⚠️ 必须放在**鉴权之前**：旧链接对「已登录」和「未登录」用户都应回到首页，
  //      不能先被口令门拦去 `/login`（那样就把一个已删除的页面当成受保护页重定向了）。
  //   ⚠️ query 保留（首页要从 fromLng…&toLng… 预填起终点进入「半屏可出发」态），
  //      仅删除已废弃的 `plan`（旧版按 planId 定位方案卡，新首页不再使用）。
  if (pathname === "/nav" || pathname === "/nav/detail") {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.searchParams.delete("plan");
    return NextResponse.redirect(url, 308);
  }

  // 公开区直接放行
  if (isPublic(pathname)) return NextResponse.next();

  const password = process.env.ACCESS_PASSWORD;
  const cookie = req.cookies.get("mx_auth")?.value;
  const authed = !!password && cookie === password;

  if (authed) return NextResponse.next();

  // ── 未授权 ──────────────────────────────────────────────────────
  // ⚠️ fail-closed：口令未配置时，生产环境**也拒绝**受保护区（而不是放行）。
  //    开发环境（NODE_ENV!=='production'）放行，方便本地调试。
  const devOpen = !password && process.env.NODE_ENV !== "production";
  if (devOpen) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: password ? "未登录" : "服务未配置访问口令（ACCESS_PASSWORD）" },
      { status: 401 },
    );
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("from", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
