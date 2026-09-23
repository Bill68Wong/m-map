"use client";

/**
 * 全屏路线详情弹窗（src/components/nav/RouteDetailSheet.tsx，2026-09-23 新增）
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *   主页「出发」推荐层、收藏组合页点卡片 —— **不再整页跳 `/nav/detail`**，
 *   改为在本页弹出全屏详情层。好处：
 *     · 不整页加载（消除卡顿）；关闭即回上一层（推荐层 / 收藏列表）；
 *     · **用哪张卡就显示哪张** —— 卡片数据由调用方直传，不经过「planId 重算匹配」
 *       ⇒ 从根上消除「点 51 显示 56」（跨链路 planId 失配 + 静默兜底）。
 *
 * ── 数据 ──────────────────────────────────────────────────────────────
 *   · `card`：列表里已算好的卡（含步行 / 换乘 / 到达时刻）；
 *   · 站条 + 「本站台其他线路」：`POST /api/nav/detail-body`
 *     （只解算站序 + 实时报站，**不重算 planNav** ⇒ 打开明显更快）；
 *   · 渲染复用 `RouteDetailBody`（与 `/nav/detail` 页面同一份，防两处漂移）。
 *
 * ⚠️ 挂载位置：必须在 `.nav-map-wrap` **之外**（wrap 是层叠上下文，弹窗挂进去
 *   会永远低于底部 chrome —— Spec AC-13 的教训）。
 */
import { useEffect, useMemo, useState } from "react";
import ComplianceBar from "@/components/nav/ComplianceBar";
import Icon from "@/components/ui/Icon";
import RouteDetailBody from "./RouteDetailBody";
import { snapshotOfCard, routeSegsOfCard } from "@/lib/favorites/snapshot";
import type { FavoriteEndpoint } from "@/lib/favorites/types";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";

export interface RouteDetailSheetProps {
  card: RecommendCard;
  colors: Record<string, string>;
  /** 目的地展示名（末段步行终点文案） */
  destLabel: string;
  /** 顶部 OD 文案（如「擎天匯 → 澳門科技大學」） */
  odLabel: string;
  /** 收藏入口数据（不传则不渲染收藏按钮） */
  fav?: { from: FavoriteEndpoint; to: FavoriteEndpoint; query: string } | null;
  /** 「本地推算」徽标（推荐列表 degraded 时透传） */
  degraded?: boolean;
  onClose: () => void;
}

interface DetailBody {
  strips: SegmentStrip[];
  otherRoutes: string[];
  foldLive: Record<string, string>;
  stationLabel: string | null;
}

export default function RouteDetailSheet({
  card,
  colors,
  destLabel,
  odLabel,
  fav = null,
  degraded = false,
  onClose,
}: RouteDetailSheetProps) {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [body, setBody] = useState<DetailBody | null>(null);
  /** 失败重试触发计数 */
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    fetch("/api/nav/detail-body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ card }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; error?: string } & Partial<DetailBody>) => {
        if (!alive) return;
        if (!j?.ok) throw new Error(j?.error ?? "detail_failed");
        setBody({
          strips: Array.isArray(j.strips) ? j.strips : [],
          otherRoutes: Array.isArray(j.otherRoutes) ? j.otherRoutes : [],
          foldLive: j.foldLive ?? {},
          stationLabel: j.stationLabel ?? null,
        });
        setPhase("ready");
      })
      .catch(() => {
        if (alive) setPhase("failed");
      });
    return () => {
      alive = false;
    };
  }, [card, reloadTick]);

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
    <div className="detail-sheet" role="dialog" aria-modal="true" aria-label={`路线详情 ${odLabel}`}>
      <div className="detail-sheet__bar">
        <button type="button" className="btn btn--text btn--sm" onClick={onClose} aria-label="返回">
          <Icon name="back" size={20} />
          返回
        </button>
        <span className="detail-sheet__od t-label">{odLabel}</span>
      </div>

      <div className="detail-sheet__body">
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
            <button
              type="button"
              className="btn btn--text btn--sm"
              onClick={() => setReloadTick((t) => t + 1)}
            >
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

      <ComplianceBar />
    </div>
  );
}
