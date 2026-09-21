"use client";

/**
 * 组合内「路线列表」（src/components/favorites/RouteListSheet.tsx，v2.4.0）
 *
 * ── 位置（2026-09-21 拍板）────────────────────────────────────────────
 *   点开组合 = **直接算此时此刻最快方案**（保持现状，不改）；
 *   路线清单收在**右上角工具按钮**里 —— 点一下从右侧滑出/就地展开。
 *
 * ── 层级 ──────────────────────────────────────────────────────────────
 *   组合（父）= 一对起终点；**路线（子）= 同起点终点下的一条具体走法**。
 *   ⇒ 本列表 = 该组合下已保存的路线（`combo.plans`）；点某条 → 看它的流程图。
 */
import Icon from "@/components/ui/Icon";
import RouteStack from "@/components/RouteStack";
import { savedAtText, type Combo, type ComboPlan } from "@/lib/favorites/types";

export interface RouteListSheetProps {
  combo: Combo;
  colors: Record<string, string>;
  /** 当前选中的路线 id（高亮） */
  activePlanId: string | null;
  onPick: (plan: ComboPlan) => void;
  onClose: () => void;
}

/** 取一条路线的线路标签（优先结构里的 routes，退化用快照 legs 首词） */
function routeLabelsOf(plan: ComboPlan): string[] {
  const fromSeg = (plan.route ?? [])
    .filter((s) => s.kind === "ride")
    .flatMap((s) => (s.routes?.length ? s.routes : s.route ? [s.route] : []));
  if (fromSeg.length) return fromSeg;
  return plan.snapshot.legs.map((l) => l.split(" ")[0]).filter(Boolean);
}

export default function RouteListSheet({ combo, colors, activePlanId, onPick, onClose }: RouteListSheetProps) {
  const plans = combo.plans;

  return (
    <div className="rl-sheet" role="dialog" aria-label="组合内的路线">
      <div className="rl-sheet__head">
        <span className="rl-sheet__title">已存路线</span>
        <span className="rl-sheet__count t-label t-muted">{plans.length} 条</span>
        <button type="button" className="btn btn--text btn--sm" style={{ marginLeft: "auto" }} onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>

      {plans.length === 0 ? (
        <p className="rl-sheet__empty t-body t-muted">
          这个组合下还没存过路线。可在上方算出的方案里点书签收藏一条。
        </p>
      ) : (
        <ul className="rl-sheet__list">
          {plans.map((p) => {
            const labels = routeLabelsOf(p);
            const active = p.id === activePlanId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  className={`rl-item${active ? " rl-item--on" : ""}`}
                  onClick={() => onPick(p)}
                  aria-current={active ? "true" : undefined}
                >
                  <span className="rl-item__routes">
                    <RouteStack codes={labels} colors={colors} size="sm" />
                  </span>
                  <span className="rl-item__meta t-label t-muted">
                    {p.snapshot.totalMin > 0 ? `约 ${Math.round(p.snapshot.totalMin)} 分 · ` : ""}
                    {p.snapshot.transfers > 0 ? `换乘 ${p.snapshot.transfers} 次 · ` : "直达 · "}
                    {savedAtText(p.snapshot.capturedAt)}
                  </span>
                  <Icon name="forward" size={16} className="rl-item__go" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
