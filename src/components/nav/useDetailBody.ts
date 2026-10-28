"use client";

/**
 * 详情「弹窗体」数据 hook（src/components/nav/useDetailBody.ts，2026-09-23 新增）
 *
 * ── 为什么单独成 hook ──────────────────────────────────────────────────
 *   `POST /api/nav/detail-body` 有**两个消费方**：
 *     · `RouteSheet` 的详情 pane（主页「出发 → 推荐 → 详情」）；
 *     · 收藏页 `RouteDetailSheet` 薄壳（无地图上下文）。
 *   抽成 hook ⇒ 两处共用同一份取数/降级口径，防漂移。
 *
 * ── 契约 ──────────────────────────────────────────────────────────────
 *   入参：`card`（列表已算好的卡，含步行 / 换乘 / 到达时刻），`open`（仅 open 时拉取）。
 *   出参：`phase` / `body`（strips + 其他线路 + 折叠栏 + ★legs 几何锚点）/ `reload`。
 *   降级：接口失败 ⇒ `phase="failed"`（详情体显示「加载失败 + 重试」），**不阻塞地图/总览**。
 *
 * ⚠️ `card` 直传（不经过 planId 重算）⇒ 「点哪张显示哪张」，从根上消除「点 51 显示 56」。
 */
import { useEffect, useRef, useState } from "react";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { OverviewLegInput } from "@/lib/nav/route-overview";

/** `detail-body` 响应体（客户端消费子集） */
export interface DetailBody {
  strips: SegmentStrip[];
  otherRoutes: string[];
  foldLive: Record<string, string>;
  stationLabel: string | null;
  /** ★ 新增：逐段几何锚点（与 `card.rides` 一一对应、同序；GCJ-02） */
  legs: OverviewLegInput[];
}

export interface UseDetailBody {
  phase: "loading" | "ready" | "failed";
  body: DetailBody | null;
  /** 失败重试：+1 触发重新拉取 */
  reload: () => void;
}

const EMPTY: DetailBody = { strips: [], otherRoutes: [], foldLive: {}, stationLabel: null, legs: [] };

export function useDetailBody(card: RecommendCard | null, open: boolean): UseDetailBody {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [body, setBody] = useState<DetailBody | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!open || !card) return;
    const id = ++seqRef.current;
    setPhase("loading");
    fetch("/api/nav/detail-body", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ card }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; error?: string } & Partial<DetailBody>) => {
        if (id !== seqRef.current) return;
        if (!j?.ok) throw new Error(j?.error ?? "detail_failed");
        setBody({
          strips: Array.isArray(j.strips) ? j.strips : [],
          otherRoutes: Array.isArray(j.otherRoutes) ? j.otherRoutes : [],
          foldLive: j.foldLive ?? {},
          stationLabel: j.stationLabel ?? null,
          legs: Array.isArray(j.legs) ? j.legs : [],
        });
        setPhase("ready");
      })
      .catch(() => {
        if (id !== seqRef.current) return;
        setBody(EMPTY);
        setPhase("failed");
      });
  }, [card, open, reloadTick]);

  return { phase, body, reload: () => setReloadTick((t) => t + 1) };
}
