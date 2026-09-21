"use client";

/**
 * 收藏 · 组合的**现场计算方案列表**（src/components/favorites/ComboPlans.tsx，v2.3.0 S4；v2.4.0 增路线列表与流程图）
 *
 * ── 职责（07 §2 / 06 §3.4）────────────────────────────────────────────
 *   点组合卡 → **现场算多方案**：`GET /api/nav?${combo.query}`（+ 可选 `chain/walk/tiers`）
 *   → 复用现有 `.rc` 卡片渲染；「已保存」角标按 `planFingerprint` 与 `combo.plans` 比对。
 *
 * ── ★ v2.4.0：两级结构（2026-09-21 拍板）───────────────────────────────
 *   · **点开组合 = 直接算「此时此刻最快方案」**（保持原行为，不改）；
 *   · **路线清单收在右上角工具按钮里**（`RouteListSheet`）——点一下展开；
 *   · 从清单里点某条路线 → 展示**该路线的纵向流程图**（`RouteFlow`，含步行段就地编辑）。
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
import RouteFlow from "./RouteFlow";
import RouteListSheet from "./RouteListSheet";
import { useCombos } from "@/lib/favorites/useCombos";
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
  const c = useCombos();
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [cards, setCards] = useState<CardData[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  /** ★ v2.4.0：右上角路线清单是否展开 */
  const [listOpen, setListOpen] = useState(false);
  /** ★ v2.4.0：当前查看流程图的路线（非空 → 用流程图取代卡片列表） */
  const [pickedPlanId, setPickedPlanId] = useState<string | null>(null);

  /** 组合的最新快照（写步行覆盖后要立刻反映） */
  const liveCombo = useMemo(() => c.combos.find((x) => x.id === combo.id) ?? combo, [c.combos, combo]);

  /** 已保存指纹集合（角标比对用） */
  const savedFps = useMemo(() => new Set(liveCombo.plans.map((p) => p.fingerprint)), [liveCombo.plans]);

  /** 当前查看的路线对象 */
  const pickedPlan = useMemo(
    () => liveCombo.plans.find((p) => p.id === pickedPlanId) ?? null,
    [liveCombo.plans, pickedPlanId],
  );

  const load = useCallback(async () => {
    setPhase("loading");
    setEmptyReason(null);
    try {
      const sp = new URLSearchParams(liveCombo.query);
      // ★ 只在有自定义编排/覆盖时传参（缺省 = v2.2.0 行为，逐字节不变）
      // ★ 编码口径：URLSearchParams 会对值再编码一次 ⇒ 此处传 JSON 串即可，
      //   最终 URL 即为契约要求的 `encodeURIComponent(JSON.stringify(...))` 单编码（防 URL 长度翻倍）。
      if (liveCombo.chain?.length) sp.set("chain", JSON.stringify(liveCombo.chain));
      if (liveCombo.walk && (liveCombo.walk.seg1 || liveCombo.walk.seg2)) {
        sp.set("walk", JSON.stringify(liveCombo.walk));
      }
      if (liveCombo.tiers && (liveCombo.tiers.speedMps || liveCombo.tiers.minutes)) {
        sp.set("tiers", JSON.stringify(liveCombo.tiers));
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
  }, [liveCombo]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 无候选时的兜底：最近一条已保存方案的快照（**只作离线/降级展示，不作真值**） */
  const fallbackPlan = useMemo(
    () => [...liveCombo.plans].sort((a, b) => (b.snapshot.capturedAt ?? 0) - (a.snapshot.capturedAt ?? 0))[0] ?? null,
    [liveCombo.plans],
  );

  return (
    <div className="fav-page">
      {/* 顶栏：返回 + 标题 + 路线按钮 + 重新规划 */}
      <div className="editor-bar">
        <button type="button" className="btn btn--text btn--sm" onClick={onExit}>
          <Icon name="back" size={20} />
          收藏
        </button>
        <span className="editor-bar__name" style={{ display: "flex", alignItems: "center" }}>
          {liveCombo.name}
        </span>
        {/* ★ v2.4.0：右上角工具按钮 —— 展开「已存路线」清单 */}
        <button
          type="button"
          className={`btn btn--text btn--sm${listOpen ? " is-on" : ""}`}
          aria-expanded={listOpen}
          aria-label="查看已存路线清单"
          onClick={() => setListOpen((v) => !v)}
        >
          <Icon name="more" size={20} />
          <span className="t-label">{liveCombo.plans.length}</span>
        </button>
        <button type="button" className="btn btn--text btn--sm" onClick={() => void load()} disabled={phase === "loading"}>
          <Icon name="refresh" size={20} />
          重新规划
        </button>
      </div>

      {/* ★ 路线清单（右上角展开；点某条 → 看流程图） */}
      {listOpen && (
        <RouteListSheet
          combo={liveCombo}
          colors={colors}
          activePlanId={pickedPlanId}
          onPick={(p) => {
            setPickedPlanId(p.id);
            setListOpen(false);
          }}
          onClose={() => setListOpen(false)}
        />
      )}

      {/* ★ 已选路线的流程图（取代卡片列表；可返回实时方案） */}
      {pickedPlan ? (
        <>
          <div className="rl-back">
            <button type="button" className="btn btn--text btn--sm" onClick={() => setPickedPlanId(null)}>
              <Icon name="back" size={16} />
              回到实时方案
            </button>
            <span className="t-label t-muted">{savedAtText(pickedPlan.snapshot.capturedAt)}</span>
          </div>
          <RouteFlow
            combo={liveCombo}
            plan={pickedPlan}
            colors={colors}
            readOnly={c.readOnly}
            onSetWalk={(key, ov) => c.setWalkOv(liveCombo.id, key, ov)}
          />
        </>
      ) : (
        <>
          <p className="fav-note t-label t-muted">
            {liveCombo.chain?.length ? `已按你的编排（${liveCombo.chain.length} 段）计算` : "按系统自动选线计算"}
            {liveCombo.plans.length > 0 ? ` · 已存 ${liveCombo.plans.length} 条路线` : ""}
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
                fromSlug={liveCombo.from.code ?? ""}
                toSlug={liveCombo.to.code ?? ""}
                hrefBuilder={(c) => `/nav/detail?${liveCombo.query}&plan=${c.planId}`}
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
                  <div className="combo-snap__acts">
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      onClick={() => setPickedPlanId(fallbackPlan.id)}
                    >
                      看这条的流程图
                    </button>
                    <button type="button" className="btn btn--outline btn--sm" onClick={() => void load()}>
                      重新规划
                    </button>
                  </div>
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
        </>
      )}
    </div>
  );
}
