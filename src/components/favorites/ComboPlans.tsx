"use client";

/**
 * 收藏 · 组合的**现场计算方案列表**（src/components/favorites/ComboPlans.tsx，v2.3.0 S4）
 *
 * ── 职责（07 §2 / 06 §3.4）────────────────────────────────────────────
 *   点组合卡 → **现场算多方案**：`GET /api/nav?${combo.query}`（+ 可选 `chain/walk/tiers`）
 *   → 复用现有 `.rc` 卡片渲染；「已保存」角标按 `planFingerprint` 与 `combo.plans` 比对。
 *
 * ── ★ 契约（ADR-005）─────────────────────────────────────────────────
 *   `chain` / `walk` / `tiers` **只在有自定义编排/覆盖时传参**（编码 = `encodeComboParam`
 *   = `encodeURIComponent(JSON.stringify(...))`）；**不传 ⇒ 与 v2.2.0 行为逐字节一致**。
 *
 * ── ★ 「当下最快」（08 §C.4 / F9）────────────────────────────────────
 *   口径 = **总用时（含步行）升序**（与 `/nav` 卡片排序同口径）⇒ **第 1 张就是当下最快**；
 *   高亮**只给第 1 张**（`.combo-plans .rc:first-of-type`，见 globals.css）。
 *
 * ── 降级（06 §3.4 表）────────────────────────────────────────────────
 *   · 有实时降级 → 沿用「本地推算结果」细提示条（`.nav-degraded`）；
 *   · 整链算不出 → 展示**已保存方案快照**并标「**历史记录，可能已变化**」+「重新规划」；
 *   · 网络/接口失败 → 行内错误 +「重试」，**不崩不清空**。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@/components/ui/Icon";
import RecommendCards from "@/components/RecommendCards";
import { planFingerprint, savedAtText, type Combo } from "@/lib/favorites/types";
import type { RecommendCard as CardData } from "@/lib/recommend/types";

interface NavResp {
  ok?: boolean;
  cards?: CardData[];
  degraded?: boolean;
  emptyReason?: string | null;
  error?: string;
}

export interface ComboPlansProps {
  combo: Combo;
  colors: Record<string, string>;
  /** 返回收藏列表 */
  onExit: () => void;
}

export default function ComboPlans({ combo, colors, onExit }: ComboPlansProps) {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [cards, setCards] = useState<CardData[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);

  /** 已保存指纹集合（角标比对用） */
  const savedFps = useMemo(() => new Set(combo.plans.map((p) => p.fingerprint)), [combo.plans]);

  const load = useCallback(async () => {
    setPhase("loading");
    setEmptyReason(null);
    try {
      const sp = new URLSearchParams(combo.query);
      // ★ 只在有自定义编排/覆盖时传参（缺省 = v2.2.0 行为，逐字节不变）
      // ★ 编码口径：URLSearchParams 会对值再编码一次 ⇒ 此处传 JSON 串即可，
      //   最终 URL 即为契约要求的 `encodeURIComponent(JSON.stringify(...))` 单编码（防 URL 长度翻倍）。
      if (combo.chain?.length) sp.set("chain", JSON.stringify(combo.chain));
      if (combo.walk && (combo.walk.seg1 || combo.walk.seg2)) sp.set("walk", JSON.stringify(combo.walk));
      if (combo.tiers && (combo.tiers.speedMps || combo.tiers.minutes)) {
        sp.set("tiers", JSON.stringify(combo.tiers));
      }
      const res = await fetch(`/api/nav?${sp.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as NavResp;
      setCards(Array.isArray(j.cards) ? j.cards : []);
      setDegraded(!!j.degraded);
      setEmptyReason(j.emptyReason ?? (j.ok === false ? (j.error ?? "no_candidate") : null));
      setPhase("ready");
    } catch {
      setPhase("failed");
    }
  }, [combo]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 无候选时的兜底：最近一条已保存方案的快照（**只作离线/降级展示，不作真值**） */
  const fallbackPlan = useMemo(
    () => [...combo.plans].sort((a, b) => (b.snapshot.capturedAt ?? 0) - (a.snapshot.capturedAt ?? 0))[0] ?? null,
    [combo.plans],
  );

  return (
    <div className="fav-page">
      {/* 顶栏：返回 + 标题 */}
      <div className="editor-bar">
        <button type="button" className="btn btn--text btn--sm" onClick={onExit}>
          <Icon name="back" size={20} />
          收藏
        </button>
        <span className="editor-bar__name" style={{ display: "flex", alignItems: "center" }}>
          {combo.name}
        </span>
        <button type="button" className="btn btn--text btn--sm" onClick={() => void load()} disabled={phase === "loading"}>
          <Icon name="refresh" size={20} />
          重新规划
        </button>
      </div>

      <p className="fav-note t-label t-muted">
        {combo.chain?.length ? `已按你的编排（${combo.chain.length} 段）计算` : "按系统自动选线计算"}
        {combo.plans.length > 0 ? ` · 已保存 ${combo.plans.length} 条` : ""}
      </p>

      {degraded && (
        <p className="nav-degraded t-label" role="status">
          路网数据暂时不可用，以下为本地推算结果
        </p>
      )}

      {phase === "loading" && (
        <div className="fav-sk" aria-hidden="true">
          <span className="rc-sk rc-sk--line" />
          <span className="rc-sk rc-sk--line rc-sk--short" />
          <span className="rc-sk rc-sk--line" />
        </div>
      )}

      {phase === "failed" && (
        <p className="fav-note fav-note--warn t-label" role="status">
          计算暂时失败，请稍后再试。
          <button type="button" className="btn btn--text btn--sm" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}

      {phase === "ready" && cards.length > 0 && (
        <div className="combo-plans">
          <RecommendCards
            cards={cards}
            colors={colors}
            zone={null}
            fromSlug={combo.from.code ?? ""}
            toSlug={combo.to.code ?? ""}
            hrefBuilder={(c) => `/nav/detail?${combo.query}&plan=${c.planId}`}
            /* ★ 动作槽：第 1 张标「当下最快」；命中已保存指纹的卡标「已保存」 */
            cardAction={(c, rank) => {
              const saved = savedFps.has(planFingerprint(c.rides));
              if (!saved && rank !== 1) return null;
              return (
                <>
                  {rank === 1 && <span className="rc-best-tag t-label">当下最快</span>}
                  {saved && <span className="fav-saved-badge t-label">已保存</span>}
                </>
              );
            }}
          />
        </div>
      )}

      {/* ── 整链算不出 → 已保存快照（历史记录）+ 重新规划 ── */}
      {phase === "ready" && cards.length === 0 && (
        <>
          {fallbackPlan ? (
            <div className="combo-snap">
              <p className="combo-snap__title t-label">历史记录，可能已变化</p>
              <div className="combo-snap__body">
                <span className="combo-snap__min">约 {Math.round(fallbackPlan.snapshot.totalMin)} 分</span>
                <span className="t-label t-muted">
                  {fallbackPlan.snapshot.transfers > 0 ? `换乘 ${fallbackPlan.snapshot.transfers} 次 · ` : "直达 · "}
                  {savedAtText(fallbackPlan.snapshot.capturedAt)}
                </span>
              </div>
              {fallbackPlan.snapshot.legs.length > 0 && (
                <p className="t-label t-muted">{fallbackPlan.snapshot.legs.join(" → ")}</p>
              )}
              <button type="button" className="btn btn--outline btn--sm" onClick={() => void load()}>
                重新规划
              </button>
            </div>
          ) : (
            <div className="fav-empty">
              <Icon name="search" size={24} className="fav-empty__icon" />
              <p className="fav-empty__title">这个时段算不出方案</p>
              <p className="fav-empty__body t-body t-muted">
                {emptyReason === "no_live"
                  ? "首段可能已收班或暂无在途车。换个时段、或改用「自动选线」试试。"
                  : "暂时没有可用的候选组合。可点「重新规划」，或到「编辑编排」改站点。"}
              </p>
              <button type="button" className="btn btn--primary" onClick={() => void load()}>
                重新规划
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
