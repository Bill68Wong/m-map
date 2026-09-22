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

/** 端点 label → slug（与 `useCombos.endpointSlug` / `RouteViewer` 同口径） */
function slugOf(label: string): string {
  if (label.includes("澳門科技大學") || label.includes("澳门科技大学") || label.includes("澳科大")) return "school";
  if (label.includes("橫琴") || label.includes("横琴")) return "hengqin";
  if (label.includes("關閘") || label.includes("关闸")) return "gate";
  return "home";
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
  /** ★ 2026-09-22：本组合的预设路线总数（用于文案「已按 N 条预设路线排序」） */
  const [presetTotal, setPresetTotal] = useState(0);
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
      // ★ 2026-09-22 口径变更：**参与排序的只有本组合内已预设好的路线**。
      //   做法：把库里的预设路线交给服务端，逐条转成 `chain`（自定义站链）算实时耗时。
      //   `chain` 非空 ⇒ 引擎按链约束枚举、**完全不调高德** ⇒ 候选集恰好 = 预设路线，
      //   从源头消除「高德方案 + 本地模型方案」（旧版就是它们混进来导致结果不稳定）。
      //   ⚠️ 逐条算而非合并：产品要求 13 条**分开排序、分开显示**，合并会变成一张卡。
      const res = await fetch("/api/fav-routes/plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          fromSlug: slugOf(liveCombo.from.label),
          toSlug: slugOf(liveCombo.to.label),
          origin: {
            lng: liveCombo.from.lng,
            lat: liveCombo.from.lat,
            label: liveCombo.from.label,
            kind: liveCombo.from.kind,
            code: liveCombo.from.code,
          },
          dest: {
            lng: liveCombo.to.lng,
            lat: liveCombo.to.lat,
            label: liveCombo.to.label,
            kind: liveCombo.to.kind,
            code: liveCombo.to.code,
          },
        }),
      });
      const j = (await res.json()) as NavResp & { presetTotal?: number; failed?: unknown[] };
      setCards(Array.isArray(j.cards) ? j.cards : []);
      setPresetTotal(j.presetTotal ?? 0);
      setDegraded(false);
      setEmptyReason(j.ok === false ? (j.error ?? "no_candidate") : null);
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
            {/* ★ 2026-09-22：明确告知数据来源 —— 只有本组合的预设路线参与排序 */}
            只按本组合的 {presetTotal || "…"} 条预设路线排序（不掺高德 / 本地模型方案）
            {liveCombo.plans.length > 0 ? ` · 另有 ${liveCombo.plans.length} 条历史保存` : ""}
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
