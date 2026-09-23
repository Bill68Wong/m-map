/**
 * 导航详情页 `/nav/detail`（src/app/nav/detail/page.tsx，v1.3.0 · T04）
 *
 * 与旧 `/card` **同构**：纵向站条（一趟一条、中间站默认收起、线路主题色轨、逐跳分钟）
 * + 步行/换乘 + 到达时刻。**不做开发者模式**（设计 §2.E）。
 * 数据来源：服务端 `planNav` 找 `plan` 指定的那张卡 → `buildStrips` 由我们的逐跳解出站序。
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.E / §C.9
 *
 * ★ 2026-09-23 重构（全屏弹窗配套）：
 *   · 详情体渲染抽到 `RouteDetailBody`（本页与全屏详情弹窗**共用**，防两处漂移）；
 *   · `otherRoutesAt` / `foldLiveAt` 抽到 `@/lib/nav/detail-fold`（同一原因）；
 *   · **指定 `plan` 未命中时不再静默换成第一张卡** —— 顶部明示「原方案已变化」。
 *     （背景：收藏链路跳本页时 planId 属另一条链路，静默兜底曾造成「点 51 显示 56」。）
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import ComplianceBar from "@/components/nav/ComplianceBar";
import RouteDetailBody from "@/components/nav/RouteDetailBody";
import Icon from "@/components/ui/Icon";
import { getPool } from "@/lib/db";
import { parseNavParams } from "@/lib/nav/nav-params";
import { planNav } from "@/lib/nav/nav-service";
import { buildStrips } from "@/lib/nav/strips";
import { foldDataOfCard } from "@/lib/nav/detail-fold";
import { endpointOf } from "@/lib/favorites/types";
import { snapshotOfCard, routeSegsOfCard } from "@/lib/favorites/snapshot";
import { loadStatics } from "@/lib/recommend/query";
import type { NavPoint } from "@/lib/nav/types";
import type { SchoolZone } from "@/lib/recommend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 30;

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = parseNavParams(sp);
  if (!p) redirect("/");
  const backHref = `/nav?${p.query}`;

  return (
    <main className="page rc-detail">
      <div className="rc-top">
        <Link href={backHref} className="btn btn--text btn--sm">
          <Icon name="back" size={20} />
          返回路线
        </Link>
        <span className="nav-page__od t-label">
          {p.origin.label} <span className="t-muted">→</span> {p.dest.label}
        </span>
      </div>

      <Suspense fallback={<DetailSkeleton />}>
        <DetailSection
          origin={p.origin}
          dest={p.dest}
          zone={p.zone}
          limit={Math.max(p.limit, 10)}
          planId={p.planId}
          backHref={backHref}
          query={p.query}
        />
      </Suspense>

      <ComplianceBar />
    </main>
  );
}

async function DetailSection({
  origin,
  dest,
  zone,
  limit,
  planId,
  backHref,
  query,
}: {
  origin: NavPoint;
  dest: NavPoint;
  zone: SchoolZone | null;
  limit: number;
  planId?: number;
  backHref: string;
  /** 规范化查询串（收藏用；不含 plan） */
  query: string;
}) {
  const pool = getPool();
  const result = await planNav(pool, { origin, dest, zone, limit });
  /**
   * ★ 2026-09-23：指定 `plan` 时**只接受命中**，miss 不再静默换卡。
   *   此前 `?? result.cards[0]` 会把「另一条链路的 planId」静默显示成第一张卡
   *   （用户实测「点 51 路却显示 56 路」）。现在：
   *   · 未指定 plan → 显示第一张（正常）；
   *   · 指定 plan 命中 → 显示该张（正常）；
   *   · 指定 plan 未命中 → 显示第一张 + **顶部明示「原方案已变化」**（不静默）。
   */
  const wanted = planId !== undefined ? result.cards.find((c) => c.planId === planId) : undefined;
  const card = wanted ?? result.cards[0];
  if (!card) redirect(backHref);
  const planMissed = planId !== undefined && !wanted;

  const st = await loadStatics(pool);
  const weekday = new Date(result.generatedAt + 8 * 3_600_000).getUTCDay();
  const strips = buildStrips(card, {
    routeIdx: st.routeIdx,
    segIdx: st.segIdx,
    nameOf: st.routeIdx.nameOf,
    weekday,
  });
  // ★ 【5】折叠栏「本站台其他线路」的实时报站（巴士）；失败不阻塞（收敛为空）
  const fold = await foldDataOfCard(pool, st, card, result.generatedAt);
  // ★ S5：本方案可用于收藏（存 query + fingerprint，不落 planId）
  const favSnap = snapshotOfCard(card);
  // ★ v2.4.0：连流程图结构一起存（收藏页可画纵向流程图）
  const favRoute = routeSegsOfCard(card);

  return (
    <>
      {planMissed && (
        <div className="nav-degraded t-label" role="status">
          原方案已随实时车况变化，以下为当前最快方案
        </div>
      )}
      <RouteDetailBody
        card={card}
        strips={strips}
        otherRoutes={fold.otherRoutes}
        foldLive={fold.foldLive}
        stationLabel={fold.stationLabel}
        colors={result.colors}
        destLabel={dest.label}
        fav={{
          from: endpointOf(origin),
          to: endpointOf(dest),
          query,
          fingerprint: favSnap.fingerprint,
          snapshot: favSnap,
          route: favRoute,
        }}
        degraded={result.degraded}
      />
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="cd-sk">
      <span className="rc-sk rc-sk--big" />
      <span className="rc-sk rc-sk--line" />
      <span className="rc-sk rc-sk--line rc-sk--short" />
      <span className="rc-sk rc-sk--line" />
    </div>
  );
}
