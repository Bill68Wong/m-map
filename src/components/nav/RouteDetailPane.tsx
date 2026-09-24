"use client";

/**
 * 详情 pane（src/components/nav/RouteDetailPane.tsx，2026-09-23 新增）
 *
 * 从 `RouteDetailSheet` 抽出「取数 + 渲染 `RouteDetailBody`」——现**两个消费方**共用：
 *   · `RouteSheet` 宿主的 detail pane（主页「出发 → 推荐 → 详情」）；
 *   · 收藏页 `RouteDetailSheet` 薄壳。
 * 数据由调用方下发（宿主用 `useRouteOverview`，收藏壳用 `useDetailBody`）⇒ 防两处漂移。
 */
import { useMemo } from "react";
import RouteDetailBody from "./RouteDetailBody";
import { snapshotOfCard, routeSegsOfCard } from "@/lib/favorites/snapshot";
import type { FavoriteEndpoint } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";
import type { DetailBody } from "./useDetailBody";

export interface RouteDetailPaneProps {
  card: RecommendCard;
  colors: Record<string, string>;
  /** 目的地展示名（末段步行终点文案） */
  destLabel: string;
  /** 顶部 OD 文案 */
  odLabel: string;
  /** 收藏入口数据（不传则不渲染收藏按钮） */
  fav?: { from: FavoriteEndpoint; to: FavoriteEndpoint; query: string } | null;
  /** 「本地推算」徽标 */
  degraded?: boolean;
  phase: "loading" | "ready" | "failed";
  body: DetailBody | null;
  reload: () => void;
}

export default function RouteDetailPane({
  card,
  colors,
  destLabel,
  odLabel,
  fav = null,
  degraded = false,
  phase,
  body,
  reload,
}: RouteDetailPaneProps) {
  /** 收藏数据（纯函数在客户端现算：指纹 / 快照 / 流程图结构） */
  const favData = useMemo(() => {
    if (!fav) return null;
    const snap = snapshotOfCard(card);
    return {
      from: fav.from,
      to: fav.to,
      query: fav.query,
      fingerprint: snap.fingerprint,
      snapshot: snap,
      route: routeSegsOfCard(card),
    };
  }, [fav, card]);

  return (
    <div className="route-pane route-pane--detail" aria-label={`路线详情 ${odLabel}`}>
      {phase === "loading" && (
        <div className="cd-sk" aria-hidden="true">
          <span className="rc-sk rc-sk--big" />
          <span className="rc-sk rc-sk--line" />
          <span className="rc-sk rc-sk--line rc-sk--short" />
          <span className="rc-sk rc-sk--line" />
        </div>
      )}
      {phase === "failed" && (
        <p className="fav-note fav-note--warn t-label" role="status">
          详情加载失败（路线本身不受影响）。
          <button type="button" className="btn btn--text btn--sm" onClick={reload}>
            重试
          </button>
        </p>
      )}
      {phase === "ready" && body && (
        <RouteDetailBody
          card={card}
          strips={body.strips}
          otherRoutes={body.otherRoutes}
          foldLive={body.foldLive}
          stationLabel={body.stationLabel}
          colors={colors}
          destLabel={destLabel}
          fav={favData}
          degraded={degraded}
        />
      )}
    </div>
  );
}
