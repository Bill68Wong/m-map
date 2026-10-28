"use client";

/**
 * 推荐列表数据 hook（src/components/nav/useRecommend.ts，2026-09-23 新增）
 *
 * 从 `RouteResultSheet` 抽出：`GET /api/nav?<query>` + 并发保护 + 同一 query 只自动拉一次。
 * 由 `RouteSheet`（宿主）持有，`RouteResultPane` 只负责渲染 ⇒ 宿主可据同一份数据渲染 peek 摘要。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecommendCard } from "@/lib/recommend/types";
import type { PrefMode } from "@/lib/recommend/score";

/** ★ 本批（需求⑧ / AC-52/53）：偏好档类型沿用后端 `score.ts`（唯一真源；避免跨层重复定义）。 */
export type { PrefMode };

export interface RecommendData {
  cards: RecommendCard[];
  colors: Record<string, string>;
  degraded: boolean;
  emptyReason: string | null;
  nearbyWalkMin: number | null;
  excluded: string[];
  missed: string[];
  fromSlug: string;
  toSlug: string;
}

interface NavResp {
  ok?: boolean;
  error?: string;
  cards?: RecommendCard[];
  colors?: Record<string, string>;
  degraded?: boolean;
  emptyReason?: string | null;
  nearbyWalkMin?: number | null;
  excluded?: string[];
  missed?: string[];
  fromSlug?: string;
  toSlug?: string;
}

export interface UseRecommend {
  phase: "idle" | "loading" | "ready" | "failed";
  data: RecommendData | null;
  err: string;
  reload: () => void;
}

export function useRecommend(
  query: string,
  open: boolean,
  prefs: PrefMode = "balanced",
  /**
   * ★ v3.3.0（AC-105）：**轻轨优先**开关 —— 透传 `/api/nav?lrtFirst=1`（后端在 `rankItems` 之后、
   * `slice(limit)` 之前重排；未触发时静默、只重排不增删）。
   */
  lrtFirst = false,
): UseRecommend {
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [data, setData] = useState<RecommendData | null>(null);
  const [err, setErr] = useState("");
  /** 已发起过加载的 query+prefs（防同一组合反复自动重拉；失败由「重试」手动触发） */
  const loadedQueryRef = useRef<string | null>(null);
  /** 并发保护：只认最后一次请求的结果 */
  const reqIdRef = useRef(0);

  /** ★ 本批：query + `prefs` 组合键（偏好切换 ⇒ 重新拉取并重排）；
   *  ★ v3.3.0：并入 `lrtFirst`（开关切换 ⇒ 同样重拉重排）。 */
  const fullQuery = query ? `${query}&prefs=${prefs}&lrtFirst=${lrtFirst ? 1 : 0}` : query;

  const load = useCallback(async (q: string) => {
    const id = ++reqIdRef.current;
    loadedQueryRef.current = q;
    setPhase("loading");
    setErr("");
    try {
      const res = await fetch(`/api/nav?${q}`, { cache: "no-store" });
      const j = (await res.json()) as NavResp;
      if (id !== reqIdRef.current) return;
      if (!j.ok) throw new Error(j.error ?? "加载失败");
      setData({
        cards: j.cards ?? [],
        colors: j.colors ?? {},
        degraded: !!j.degraded,
        emptyReason: j.emptyReason ?? null,
        nearbyWalkMin: j.nearbyWalkMin ?? null,
        excluded: j.excluded ?? [],
        missed: j.missed ?? [],
        fromSlug: j.fromSlug ?? "",
        toSlug: j.toSlug ?? "",
      });
      setPhase("ready");
    } catch (e) {
      if (id !== reqIdRef.current) return;
      setErr((e as Error).message || "加载失败，请稍后再试");
      setPhase("failed");
    }
  }, []);

  // 打开时（含首次）拉取；同一 query+prefs 只自动拉一次（关闭再开 = 秒显上次结果）
  useEffect(() => {
    if (!open || !fullQuery) return;
    if (loadedQueryRef.current === fullQuery) return;
    void load(fullQuery);
  }, [open, fullQuery, load]);

  return { phase, data, err, reload: () => void load(fullQuery) };
}
