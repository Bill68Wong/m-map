"use client";

/**
 * 站序报站懒加载（src/components/line/useLazyEta.ts，v3.6.0 · S6）
 *
 * ── 这是本页**唯一**碰 DSAT 的地方，六条硬约束（AC-42a / AC-42b）──────────
 *   ① **视口 ±1 屏懒加载** —— `IntersectionObserver` + `rootMargin: 100% 0px`，
 *      **绝不整线预取**（最长线路 78 站，一次预取会把 DSAT 打穿）。
 *   ② **并发 ≤3** —— 同时最多 3 个 `fetch` 在飞。
 *   ③ **滚动静默 250ms 才取** —— 快速拖动滚动条时不该沿途触发几十个请求。
 *   ④ **待取队列 ≤8** —— 超出时**丢「离视口中心最远」的**（用户最可能马上看到的留在队列里）。
 *   ⑤ **单页自动请求硬闸 ≤30** —— 到顶后剩余站**永久停在 idle**（不重试）。
 *      60s 内已取过的走本地缓存，**不计入硬闸**。
 *   ⑥ **轻轨零请求** —— `kind === "lrt"` 直接 return，**一个请求都不发**。
 *      （`/api/station/eta` 对轻轨是支持的、返回 200，所以这条**只能**由前端守；
 *        AC-42a 的断言就是「轻轨页的报站请求数 = 0」，看网络记录。）
 *
 * ── 熔断口径（铁律 19）──────────────────────────────────────────────────
 *   本 hook 不直接调 DSAT；`/api/station/eta` 内部走 `fetchStationLive`，
 *   其 DSAT 调用 `purpose='recommend'` —— 与 `live_pos` 同款「**只记账、不参与熔断判定**」
 *   （`src/lib/dsat/client.ts:93` 的 `skipBreaker`）。⇒ 本页开页不会把全局熔断打穿。
 *   ⚠️ 前端**没有** `purpose` 参数可传（该接口不收），别在 URL 上加无用参数。
 *
 * ── 失败口径 ────────────────────────────────────────────────────────────
 *   单站失败 / 超时 / 硬闸到顶 ⇒ 该站 `idle`（**留空**，不显示错误图标、不重试）。
 *   设计明确：单站报站失败不值得占用视觉注意力。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ETA_LIMITS, mergeQueue, slotsFor } from "@/lib/line/eta-policy";
import type { LineKind, LineStop, StationEtaItem, StationEtaResp } from "@/lib/line/line-shared";

/** 报站三态（对应 `data-eta`） */
export type EtaPhase = "idle" | "on" | "none";

export interface EtaState {
  phase: EtaPhase;
  /** `phase === "on"` 时的文案；其余为 null */
  text: string | null;
}

/** 六条硬约束的数值与「队列/并发」策略都住在 `lib/line/eta-policy.ts`（可被单测直接断言） */
export { ETA_LIMITS } from "@/lib/line/eta-policy";

const IDLE: EtaState = { phase: "idle", text: null };
const NONE: EtaState = { phase: "none", text: null };

/**
 * 从 `/api/station/eta` 的 `items[]` 里挑出**本站台**的那条。
 *
 * ★★ 坑②：必须 `route + platform` **双条件**。
 *   `code=M95/3` 的响应里是**主站 M95 下全部（线路 × 方向 × 站台）**，
 *   实测 7 条横跨 `M95/2` 与 `M95/3` 两个站台。只按 `route` 匹配会取到**隔壁站台**的车，
 *   表现为「报站少/多几站」——而且只在多站台的站上出现，极难发现。
 */
function pickItem(items: StationEtaItem[] | undefined, lineCode: string, platform: string): EtaState {
  const hit = items?.find((i) => i.route === lineCode && i.platform === platform);
  if (!hit || !hit.ok || hit.stopsAway == null) return NONE;
  // 0 站 = 车已到站；写「即将到站」而不是「还有 0 站」
  if (hit.stopsAway <= 0) return { phase: "on", text: "即将到站" };
  const min = hit.etaMin != null ? Math.max(1, Math.round(hit.etaMin)) : null;
  return { phase: "on", text: `还有 ${hit.stopsAway} 站${min != null ? ` · 约 ${min} 分钟` : ""}` };
}

/**
 * @param stops    当前方向的站序（**身份变化 = 换方向**，会重置全部状态）
 * @param lineCode 线路码（`26` / `LRT-氹仔线`），用于 `route` 匹配
 * @param kind     线路种类；`lrt` ⇒ **零请求**
 */
export function useLazyEta(stops: LineStop[], lineCode: string, kind: LineKind) {
  /** 仅用于强制重渲染（真实数据都在 ref 里，避免每次 setState 复制大 Map） */
  const [, setTick] = useState(0);
  const results = useRef(new Map<string, EtaState>());
  const cache = useRef(new Map<string, { ts: number; state: EtaState }>());
  const els = useRef(new Map<string, HTMLElement>());
  const visible = useRef(new Set<string>());
  const pending = useRef<string[]>([]);
  const inflight = useRef(0);
  /** 已发出的自动请求数（硬闸计数，缓存命中不计） */
  const sent = useRef(0);
  const hits = useRef(0);
  const capped = useRef(false);
  const timer = useRef<number | null>(null);
  const io = useRef<IntersectionObserver | null>(null);
  /** 供 async 任务回调里复用（避免 flush 自引用未初始化） */
  const flushRef = useRef<() => void>(() => {});

  const bump = useCallback(() => setTick((t) => t + 1), []);

  /** 离视口中心的距离（用于队列超限时「丢最远的」） */
  const distToCenter = useCallback((code: string): number => {
    const el = els.current.get(code);
    if (!el) return Number.MAX_SAFE_INTEGER;
    const r = el.getBoundingClientRect();
    return Math.abs(r.top + r.height / 2 - window.innerHeight / 2);
  }, []);

  /** 灌队列：先吃缓存，再按并发额度发请求 */
  const flush = useCallback(() => {
    // ⑥ 轻轨：一个请求都不发（后端支持 ≠ 前端该发）
    if (kind === "lrt") return;

    // 1) 缓存命中的直接落结果（不计入硬闸）
    const cands: string[] = [];
    for (const code of visible.current) {
      if (results.current.has(code) || pending.current.includes(code)) continue;
      const c = cache.current.get(code);
      if (c && Date.now() - c.ts < ETA_LIMITS.CACHE_TTL_MS) {
        results.current.set(code, c.state);
        hits.current++;
        continue;
      }
      cands.push(code);
    }
    if (cands.length) {
      // ④ 队列超限 ⇒ 丢「离视口中心最远」的（策略在 lib，已被单测钉死）
      pending.current = mergeQueue(pending.current, cands, distToCenter);
      bump();
    }

    // 2) 按并发额度发（②）与硬闸（⑤）
    const plan = slotsFor(inflight.current, sent.current);
    const slots = plan.slots;
    if (plan.capped && !capped.current) {
      capped.current = true;
      console.warn(
        `[line] 报站硬闸已达 ${ETA_LIMITS.MAX_REQUESTS} 次，剩余 ${pending.current.length} 站停在 idle（不重试）`,
      );
      pending.current = [];
    }
    for (let n = 0; n < slots && pending.current.length; n++) {
      const code = pending.current.shift()!;
      if (results.current.has(code)) continue;
      sent.current++;
      inflight.current++;
      void (async () => {
        try {
          const res = await fetch(`/api/station/eta?code=${encodeURIComponent(code)}`, {
            cache: "no-store",
          });
          const j = res.ok ? ((await res.json()) as StationEtaResp) : null;
          const st = j?.items ? pickItem(j.items, lineCode, code) : NONE;
          results.current.set(code, st);
          cache.current.set(code, { ts: Date.now(), state: st });
        } catch {
          // 单站失败 ⇒ idle（留空、不重试、不显示错误）
          results.current.set(code, IDLE);
        } finally {
          inflight.current--;
          bump();
          if (inflight.current === 0 && !pending.current.length) {
            // ⑤ 计数打日志（上线首周观察用）
            console.log(
              `[line] ${lineCode} 报站：已发 ${sent.current}/${ETA_LIMITS.MAX_REQUESTS} 次 · 缓存命中 ${hits.current} 次`,
            );
          }
          flushRef.current();
        }
      })();
    }
  }, [kind, lineCode, distToCenter, bump]);
  flushRef.current = flush;

  /** ③ 去抖 250ms 后再灌队列 */
  const schedule = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      flushRef.current();
    }, ETA_LIMITS.DEBOUNCE_MS);
  }, []);

  /**
   * 换方向 / 换线路 ⇒ 全部重置（**缓存保留**：同站台切回来不该再打一次 DSAT）
   *
   * ⚠️⚠️ `sent.current = 0`（硬闸计数随方向归零）是**有意的**，不要"修"成页面生命周期累计：
   *   · `cache` 是 `useRef` ⇒ **跨方向保留**，flush 里**先查 60s 缓存**（`Date.now() - c.ts < CACHE_TTL_MS`），
   *     命中即落结果、**不消耗 `sent` 额度**；
   *   · ⇒ 60 秒内来回切方向 = 全是缓存命中，额度一分不花；只有超 60s 才会重新计入，
   *     而那时数据本来已过期，重新请求是**必要**的；
   *   · 若改成"一页生命周期累计"，用户来回切方向对比两条路线会**被自己的浏览行为锁死额度**
   *     （切两三次就 30 次到顶、后半页永久无报站）—— 那是更差的体验。
   *   评审判定：保持现状（见 S6 评审裁决 ②）。
   */
  useEffect(() => {
    results.current.clear();
    visible.current.clear();
    pending.current = [];
    inflight.current = 0;
    sent.current = 0;
    hits.current = 0;
    capped.current = false;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    bump();
  }, [stops, lineCode, bump]);

  /** 单例 IntersectionObserver（① 视口 ±1 屏） */
  useEffect(() => {
    if (kind === "lrt" || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const e of entries) {
          const code = (e.target as HTMLElement).dataset.stopCode;
          if (!code) continue;
          if (e.isIntersecting) {
            if (!visible.current.has(code)) {
              visible.current.add(code);
              changed = true;
            }
          } else if (visible.current.delete(code)) {
            changed = true;
          }
        }
        if (changed) schedule();
      },
      // ±1 屏：上下各留一整屏预热，滚到就该有数
      { rootMargin: "100% 0px 100% 0px", threshold: 0 },
    );
    io.current = obs;
    for (const el of els.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      io.current = null;
    };
  }, [kind, schedule]);

  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  /** 行挂载时登记元素（`LineStopRow` 的 ref 回调） */
  const registerEl = useCallback((code: string, el: HTMLElement | null) => {
    if (el) {
      els.current.set(code, el);
      io.current?.observe(el);
    } else {
      els.current.delete(code);
    }
  }, []);

  /**
   * 取某站的三态。
   *
   * ⚠️ 轻轨**恒为 `none`**（不是 `idle`）：AC-46 要求轻轨每站 `data-eta="none"` +
   *    不显示「还有 N 站」。若这里返回 `idle`，DOM 上就没有 `none` 属性，
   *    渲染层断言会失败 —— 而「不请求」和「显示无数据」是**两件都要做**的事。
   */
  const etaOf = useCallback(
    (code: string): EtaState => (kind === "lrt" ? NONE : (results.current.get(code) ?? IDLE)),
    [kind],
  );

  return { etaOf, registerEl };
}
