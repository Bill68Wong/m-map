/**
 * 导航结果页 `/nav`（src/app/nav/page.tsx，v1.3.0 · T04）
 *
 * SSR：服务端直接 `planNav`（高德 transit → 二次计算 → 重排 → 补漏）→ 首屏即 5 张卡。
 * ★ 卡片/详情呈现与旧版**完全一致**（复用 `RecommendCards`/`RecommendCard`，仅换 `hrefBuilder`）。
 * ★ `degraded` → 卡片区顶部细提示条（本地推算）；`emptyReason` → 空状态（简体）。
 * 设计：docs/设计-全澳导航-v1-20260918.md §2.E / §C.9 / §11
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import ComplianceBar from "@/components/nav/ComplianceBar";
import NavResultClient from "@/components/nav/NavResultClient";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import Icon from "@/components/ui/Icon";
import { getPool } from "@/lib/db";
import { parseNavParams } from "@/lib/nav/nav-params";
import { planNav } from "@/lib/nav/nav-service";
import { endpointOf } from "@/lib/favorites/types";

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

  return (
    <main className="page nav-page">
      <header className="nav-page__top">
        <Link href="/" className="btn btn--text btn--sm">
          <Icon name="back" size={20} />
          返回
        </Link>
        <span className="nav-page__od t-label">
          {p.origin.label} <span className="t-muted">→</span> {p.dest.label}
        </span>
        {/* ★ 收藏入口 ④（地点对）：顶部 OD 栏 */}
        <FavoriteButton
          kind="place"
          entry="odbar"
          from={endpointOf(p.origin)}
          to={endpointOf(p.dest)}
          query={p.query}
        />
      </header>

      <Suspense fallback={<ResultSkeleton />}>
        {/* ★ S5：把**整份已解析参数**传给结果区 —— 使 `chain/walk/tiers`（自定义站链 / 步行覆盖 /
            五档覆盖）能透传到 `planNav`；**不传时缺省行为与 v2.2.0 逐字节一致**（ADR-005）。
            用「传整个 p」而不是逐个透传，避免以后新增参数再漏一处。 */}
        <ResultSection p={p} />
      </Suspense>

      <ComplianceBar />
    </main>
  );
}

/**
 * ★ S5：接收**整份已解析参数**（`parseNavParams` 的返回类型）—— 站链/步行/五档覆盖随之自动透传。
 * ⚠️ `planNav` 的三个参数均为**可选**：未提供时行为与 v2.2.0 完全一致。
 */
async function ResultSection({ p }: { p: NonNullable<ReturnType<typeof parseNavParams>> }) {
  const { query, origin, dest, zone, limit, chain, walk, tiers } = p;
  const result = await planNav(getPool(), { origin, dest, zone, limit, chain, walk, tiers });
  return <NavResultClient query={query} initial={result} origin={origin} dest={dest} />;
}

/** 结果区骨架（形状与卡片一致 → 零布局跳动，§11.1） */
function ResultSkeleton() {
  return (
    <div className="rc-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div className="card rc rc--skeleton" key={i}>
          <span className="rc-sk rc-sk--big" />
          <span className="rc-sk rc-sk--chip" />
          <span className="rc-sk rc-sk--line" />
          <span className="rc-sk rc-sk--line rc-sk--short" />
        </div>
      ))}
    </div>
  );
}
