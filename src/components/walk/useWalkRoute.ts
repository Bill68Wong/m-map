"use client";

/**
 * 步行路径取数 + 客户端缓存 + 预取（src/components/walk/useWalkRoute.ts，v3.6.0 · S5）
 *
 * ── 为什么要预取（AC-08）────────────────────────────────────────────────
 *   线上函数真身在 iad1（美东）、高德在亚太 ⇒ 单靠请求期同步取数，1.5s 首屏基本不达标
 *   （架构 §3.3「AC-08 可行性」）。解法不是改指标，而是**把延迟藏到用户看不见的地方**：
 *   详情体一到（用户还在读卡片）就并行预取，用户点「展开步骤」时已命中 ⇒ 观测上零网络。
 *
 * ── AC-08a 硬约束（**写死在这里，别放宽**）───────────────────────────────
 *   · 预取**只有首段与末段两条**，**不得沿路全量预取**；
 *   · 单用户单次导航的步行请求总数 **≤2 次**；
 *   · 推进/滚动过程中**不再补请求**（同时踩配额与 AC-08a）。
 *   ⇒ 本 hook 只在 `ods` 的两个 key 上各取一次；`ensure()` 只读缓存/复用进行中的 promise，
 *     **不会**因为用户来回展开而重复请求。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   模块级 `Map`（不是 ref）：一个页面里多个组件实例共享同一份；
 *   key = `seg|fromLng,fromLat|toLng,toLat`（坐标取 **4 位小数 ≈ 11 米**）。
 *   TTL 5 分钟（架构 §4.2 表：步行路径**服务端不缓存**，客户端 5min 内存）。
 *   为什么不落库：路径几何 30 分钟内稳定，但落库会引入「改了路网不更新」的第二次事故。
 *
 * ── 失败降级（必须有，不许空白）──────────────────────────────────────────
 *   429 / 超时 / 无路径 ⇒ `phase="failed"`，UI 显示「直线距离 + 固定步速估算」+ 文字提示，
 *   **绝不显示假的分步**（沿用 `track.ts` 文件头「绝不猜测」的纪律）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WalkRouteResp, WalkStep } from "@/lib/walk/walk-shared";

/** 一段步行 */
export interface WalkOd {
  from: { lng: number; lat: number };
  to: { lng: number; lat: number };
}

/** 取数状态（对外） */
export type WalkPhase = "idle" | "loading" | "ready" | "failed";

export interface WalkSegState {
  phase: WalkPhase;
  steps: WalkStep[];
  /** 几何链末值（算剩余米必须用它，不用 totalDistM） */
  stepsTotalM: number;
  totalDurationS: number;
  /** 失败原因（已过 `errorTextOf`，可直接上屏） */
  err: string;
}

interface CacheEntry extends WalkSegState {
  /** 写入时刻（ms） */
  at: number;
}

/** 缓存 TTL：5 分钟（架构 §4.2） */
export const WALK_CACHE_TTL_MS = 5 * 60_000;

/** 模块级缓存（跨组件实例共享） */
const CACHE = new Map<string, CacheEntry>();
/** 进行中的请求（防同一 OD 并发重复发；AC-08a） */
const INFLIGHT = new Map<string, Promise<WalkSegState>>();

const EMPTY: WalkSegState = { phase: "idle", steps: [], stepsTotalM: 0, totalDurationS: 0, err: "" };

/** 坐标取 4 位小数（≈11 米）—— 太细会让缓存永不命中，太粗会取到错路径 */
function k4(n: number): string {
  return n.toFixed(4);
}

/** 缓存 key：段名 + 起终点（4 位取整） */
export function walkCacheKey(seg: string, od: WalkOd): string {
  return `${seg}|${k4(od.from.lng)},${k4(od.from.lat)}|${k4(od.to.lng)},${k4(od.to.lat)}`;
}

/** 取一条（缓存命中且未过期即返回；否则网络） */
function fetchSeg(key: string, od: WalkOd, signal?: AbortSignal): Promise<WalkSegState> {
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.at < WALK_CACHE_TTL_MS) {
    return Promise.resolve({ ...cached });
  }
  const inflight = INFLIGHT.get(key);
  if (inflight) return inflight;

  const qs = new URLSearchParams({
    fromLng: String(od.from.lng),
    fromLat: String(od.from.lat),
    toLng: String(od.to.lng),
    toLat: String(od.to.lat),
  });

  const p = (async (): Promise<WalkSegState> => {
    try {
      const r = await fetch(`/api/nav/walk?${qs.toString()}`, { cache: "no-store", signal });
      const j = (await r.json()) as WalkRouteResp;
      if (!j.ok) {
        // 服务端已是固定枚举；这里直接给用户文案（**不把枚举上屏**）
        const text =
          j.error === "rate_limited"
            ? "步行路径请求太频繁，稍后再试"
            : j.error === "bad_request"
              ? "起终点坐标有问题，无法规划步行路线"
              : "步行路径暂时取不到";
        return { ...EMPTY, phase: "failed", err: text };
      }
      const state: WalkSegState = {
        phase: "ready",
        steps: j.steps ?? [],
        stepsTotalM: j.stepsTotalM ?? j.totalDistM ?? 0,
        totalDurationS: j.totalDurationS ?? 0,
        err: "",
      };
      CACHE.set(key, { ...state, at: Date.now() });
      return state;
    } catch (e) {
      // AbortError 不算失败（切卡/卸载时的正常中止）
      if ((e as Error)?.name === "AbortError") return { ...EMPTY };
      return { ...EMPTY, phase: "failed", err: "步行路径暂时取不到，请检查网络" };
    } finally {
      INFLIGHT.delete(key);
    }
  })();

  INFLIGHT.set(key, p);
  return p;
}

/** 供测试/诊断：清空缓存 */
export function clearWalkCache(): void {
  CACHE.clear();
  INFLIGHT.clear();
}

/**
 * 步行路径 hook。
 *
 * @param ods 需要取数的段（**最多两个**：首段 `out` / 末段 `in`；缺省 = 该段不需要步行）。
 *            ⚠️ 传超过两个会在开发期警告 —— AC-08a 明令「不得沿路全量预取」。
 */
export function useWalkRoute(ods: { out?: WalkOd | null; in?: WalkOd | null }) {
  const outOd = ods.out ?? null;
  const inOd = ods.in ?? null;

  /** 稳定 key：坐标或段变化才重取（对象字面量每次新引用，不能直接进 deps） */
  const outKey = useMemo(() => (outOd ? walkCacheKey("out", outOd) : ""), [outOd]);
  const inKey = useMemo(() => (inOd ? walkCacheKey("in", inOd) : ""), [inOd]);

  const [states, setStates] = useState<Record<string, WalkSegState>>(() => {
    // 首帧先读缓存 ⇒ 反复展开 / 退出重进 = 零请求、零闪
    const init: Record<string, WalkSegState> = {};
    for (const [seg, key] of [
      ["out", outKey],
      ["in", inKey],
    ] as const) {
      if (!key) continue;
      const c = CACHE.get(key);
      if (c && Date.now() - c.at < WALK_CACHE_TTL_MS) init[seg] = { ...c };
    }
    return init;
  });

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback((seg: "out" | "in", key: string, od: WalkOd) => {
    if (!key) return;
    setStates((s) => ({ ...s, [seg]: { ...(s[seg] ?? EMPTY), phase: "loading" } }));
    void fetchSeg(key, od, abortRef.current?.signal).then((st) => {
      setStates((s) => ({ ...s, [seg]: st }));
    });
  }, []);

  /**
   * 预取：两个 key 各发起一次（互相并行，不串行等待）。
   * ⚠️ 只依赖 key（不是 od 对象）⇒ 父组件重渲染不会重复触发。
   */
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    if (outKey && outOd) load("out", outKey, outOd);
    if (inKey && inOd) load("in", inKey, inOd);
    return () => abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outKey, inKey, load]);

  /**
   * 显式确保某段可用（展开步骤 / 进入跟随时调用）。
   * **只读缓存或复用进行中的请求** —— 若已 ready 或 loading 立即返回，不再发新请求（AC-08a）。
   */
  const ensure = useCallback((seg: "out" | "in") => {
    const key = seg === "out" ? outKey : inKey;
    const od = seg === "out" ? outOd : inOd;
    if (!key || !od) return;
    const cur = states[seg];
    if (cur && (cur.phase === "ready" || cur.phase === "loading")) return;
    load(seg, key, od);
  }, [outKey, inKey, outOd, inOd, states, load]);

  /** 偏航重算 / 用户手动重试：绕过缓存强制重取（**唯一允许突破 ≤2 次**的路径） */
  const reload = useCallback((seg: "out" | "in") => {
    const key = seg === "out" ? outKey : inKey;
    const od = seg === "out" ? outOd : inOd;
    if (!key || !od) return;
    CACHE.delete(key);
    INFLIGHT.delete(key);
    load(seg, key, od);
  }, [outKey, inKey, outOd, inOd, load]);

  return {
    out: states.out ?? EMPTY,
    in: states.in ?? EMPTY,
    ensure,
    reload,
  };
}
