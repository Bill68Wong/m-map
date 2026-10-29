"use client";

/**
 * 推荐列表数据 hook（src/components/nav/useRecommend.ts，2026-09-23 新增）
 *
 * 从 `RouteResultSheet` 抽出：`GET /api/nav?<query>` + 并发保护 + 同一 query 只自动拉一次。
 * 由 `RouteSheet`（宿主）持有，`RouteResultPane` 只负责渲染 ⇒ 宿主可据同一份数据渲染 peek 摘要。
 *
 * ── ★ v3.6.0 S4（需求 R3）：刷新 = 「只刷数字，不换路线」────────────────
 *   · `load(q, { nocache })` —— `reload({nocache:true})` 透传 `nocache=1`
 *     旁路服务端 `transit_cache`（`api/nav/route.ts` 已支持），保证拿到真·最新；
 *   · 结果经 `mergeCardsStable`（`merge-cards.ts`）合入：**保留旧顺序与结构**，
 *     只覆盖会变的数字；旧有新无的卡保留原位并标 `stale: true`（不删）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecommendCard } from "@/lib/recommend/types";
import type { PrefMode } from "@/lib/recommend/score";
import { errorTextOf } from "@/lib/ui/error-text";
import { mergeCardsStable } from "./merge-cards";

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
  /**
   * ★ v3.6.0 S4：刷新推荐。
   * @param opts.nocache `true` ⇒ 附 `nocache=1` 旁路服务端缓存（用户主动刷新时用）
   */
  reload: (opts?: { nocache?: boolean }) => void;
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

  const load = useCallback(async (q: string, opts?: { nocache?: boolean }) => {
    const id = ++reqIdRef.current;
    loadedQueryRef.current = q;
    setPhase("loading");
    setErr("");
    try {
      // ★ v3.6.0 S4：`nocache=1` 旁路服务端 transit_cache（用户主动刷新才带）
      const url = opts?.nocache ? `/api/nav?${q}&nocache=1` : `/api/nav?${q}`;
      const res = await fetch(url, { cache: "no-store" });
      const j = (await res.json()) as NavResp;
      if (id !== reqIdRef.current) return;
      // ★ v3.6.0：`j.error` 是服务端枚举 ⇒ 先过 `errorTextOf`，`err` 会被 `RouteResultPane` 直接渲染
      if (!j.ok) throw new Error(j.error ? errorTextOf(j.error) : "加载失败");
      const nextCards = j.cards ?? [];
      /**
       * ★ v3.6.0 S4（只刷数字不换路线）：合入而非替换 ——
       *   首次加载（`prev` 为空）等价于直接用新列表；之后一律以**旧顺序**为主轴。
       */
      setData((prev) => ({
        cards: prev ? mergeCardsStable(prev.cards, nextCards) : nextCards,
        colors: j.colors ?? prev?.colors ?? {},
        degraded: !!j.degraded,
        emptyReason: j.emptyReason ?? null,
        nearbyWalkMin: j.nearbyWalkMin ?? null,
        excluded: j.excluded ?? [],
        missed: j.missed ?? [],
        fromSlug: j.fromSlug ?? "",
        toSlug: j.toSlug ?? "",
      }));
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

  return { phase, data, err, reload: (opts?: { nocache?: boolean }) => void load(fullQuery, opts) };
}
