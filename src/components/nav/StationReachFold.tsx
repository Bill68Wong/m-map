"use client";

/**
 * 详情页折叠栏 · 「本站台其他线路」（src/components/nav/StationReachFold.tsx）
 *
 * ── v1.3.0 · T05 起源；2026-09-24 **重构（用户口径）** ────────────────────
 *   场景：用户在**第一程上车站**等车 / 没赶上本班 ⇒ 想就地看看**同一站台**还有什么
 *   线路能到目的地。于是：
 *   · 站台 = **第一程上车站**（原实现取「末程下车站」——已修正，见 `detail-fold.ts`）；
 *   · **可切换方案置顶**：「坐这条线（或再换乘一次）也能到目的地」的线路，
 *     显示 线路标签（换乘 = `色标签 → 色标签`）· 总用时 · 快/慢多少分 · 右侧「切过去」；
 *     排序 = **快在前（快得多 → 快得少），慢在后（慢得少 → 慢得多）**（= `deltaMin` 升序）；
 *   · **其余线路在下**：一行一条，按数字字母顺序（沿用全站 `sortRouteOptions` 口径）；
 *   · 数据：`POST /api/nav/switch-plans`（懒加载：**展开时才查**；失败静默降级为纯列表）。
 *
 * ★ §11.6：线路名一律 `.route-stack`（主题色标签）。
 * ★ 实时报站（巴士）由服务端算好传入（`foldLive`）；轻轨不在本表（时刻表制）。
 * ★ 站名/线路名用**繁体**，界面文案用**简体**。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import RouteStack from "@/components/RouteStack";
import Icon from "@/components/ui/Icon";
import { sortRouteOptions } from "@/lib/route-label";
import { fmtDelta } from "@/lib/nav/track";
import type { RecommendCard } from "@/lib/recommend/types";

export interface ReachFoldItem {
  /** 线路码 */
  route: string;
  /** 实时报站文案（空串 = 无数据） */
  live: string;
}

/** `POST /api/nav/switch-plans` 的 `plans[]` 子集（客户端消费） */
interface SwitchPlanLite {
  route: string;
  chainRoutes: string[];
  totalMin: number;
  deltaMin: number;
  card: RecommendCard;
}

export default function StationReachFold({
  stationLabel,
  items,
  colors,
  switchCtx = null,
  onOpenCard,
}: {
  /** 站台显示名（如「C653 金峰南岸」） */
  stationLabel: string;
  /** 该站台其他可达线路（含各自实时报站） */
  items: ReachFoldItem[];
  colors: Record<string, string>;
  /**
   * ★ 可切换方案查询上下文（主页详情链传入；收藏薄壳不传 ⇒ 只出纯列表）：
   * `card` = 当前方案（取首程上车站/线路/totalMin/walkOut），`dest` = 目的地坐标（GCJ-02）。
   */
  switchCtx?: { card: RecommendCard; dest: { lng: number; lat: number; name?: string } } | null;
  /** 点「切过去」→ 打开该方案导航（缺失则隐藏按钮） */
  onOpenCard?: (card: RecommendCard) => void;
}) {
  const [open, setOpen] = useState(false);
  const [plans, setPlans] = useState<SwitchPlanLite[]>([]);
  const [planPhase, setPlanPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const keyRef = useRef("");
  const seqRef = useRef(0);

  /** 展开时才查可切换方案（懒加载；换卡片/换目的地自动重查） */
  useEffect(() => {
    if (!open || !switchCtx) return;
    const first = switchCtx.card.rides[0];
    const key = `${first?.board ?? ""}|${first?.route ?? ""}|${switchCtx.card.totalMin}|${switchCtx.dest.lng.toFixed(5)},${switchCtx.dest.lat.toFixed(5)}`;
    if (keyRef.current === key) return;
    keyRef.current = key;
    const id = ++seqRef.current;
    setPlanPhase("loading");
    setPlans([]);
    fetch("/api/nav/switch-plans", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ card: switchCtx.card, dest: switchCtx.dest }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; plans?: SwitchPlanLite[] }) => {
        if (id !== seqRef.current) return;
        if (j?.ok) {
          setPlans(Array.isArray(j.plans) ? j.plans : []);
          setPlanPhase("ready");
        } else {
          setPlanPhase("failed");
        }
      })
      .catch(() => {
        if (id === seqRef.current) setPlanPhase("failed");
      });
  }, [open, switchCtx]);

  /** 可切换方案：快在前（快得多 → 快得少），慢在后（慢得少 → 慢得多） */
  const sortedPlans = useMemo(
    () => [...plans].sort((a, b) => a.deltaMin - b.deltaMin || a.route.localeCompare(b.route)),
    [plans],
  );
  const planRoutes = useMemo(() => new Set(sortedPlans.map((p) => p.route)), [sortedPlans]);

  /** 其余线路：一行一条，按数字字母顺序（沿用全站自然序口径） */
  const restItems = useMemo(() => {
    const byRoute = new Map(items.map((it) => [it.route, it]));
    const order = sortRouteOptions(items.map((it) => it.route).filter((r) => !planRoutes.has(r)));
    return order.map((r) => byRoute.get(r)!).filter(Boolean);
  }, [items, planRoutes]);

  if (!items.length) return null;

  return (
    <div className="rc-fold">
      <button className="rc-fold__head" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        本站台其他线路 · <b>{items.length}</b> 条
        {sortedPlans.length > 0 && <span className="rc-fold__badge">{sortedPlans.length} 个可换乘</span>}
        <span className="rc-strip__caret">
          <Icon name={open ? "caretUp" : "caretDown"} size={16} />
        </span>
      </button>
      {open && (
        <div className="rc-fold__body">
          <span className="t-label t-muted" style={{ display: "block", marginBottom: 6 }}>
            {stationLabel}
          </span>

          {/* ★ 可切换方案（置顶）：线路标签（换乘双色）· 总用时 · 快/慢 · 切过去 */}
          {switchCtx && planPhase === "loading" && (
            <p className="t-label t-muted" style={{ margin: "2px 0 8px" }}>
              正在查询可换乘方案…
            </p>
          )}
          {sortedPlans.length > 0 && (
            <div className="rc-fold__plans">
              {sortedPlans.map((p) => (
                <div className="fold-plan" key={`${p.route}-${p.chainRoutes.join("+")}`}>
                  <span className="fold-plan__main">
                    <RouteStack
                      segments={p.chainRoutes.map((r) => ({ codes: [r] }))}
                      colorOf={(c) => colors[c] ?? null}
                      size="sm"
                    />
                    <span className="fold-plan__time">
                      <b>{Math.round(p.totalMin)}</b> 分
                    </span>
                    <span
                      className={`fold-plan__delta${p.deltaMin < 0 ? " is-fast" : p.deltaMin > 0 ? " is-slow" : ""}`}
                    >
                      {fmtDelta(p.deltaMin)}
                    </span>
                  </span>
                  {onOpenCard && (
                    <button
                      type="button"
                      className="fold-plan__go"
                      onClick={() => onOpenCard(p.card)}
                      aria-label={`切换到 ${p.chainRoutes.join(" 换乘 ")} 方案并开始导航`}
                    >
                      切过去
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* 其余线路（纯列表：线路标签 + 实时报站） */}
          {restItems.map((it) => (
            <div className="nav-fold-row" key={it.route}>
              <RouteStack codes={[it.route]} colorOf={(c) => colors[c] ?? null} size="sm" />
              <span className="nav-fold-row__live t-label">{it.live || "暂无报站"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
