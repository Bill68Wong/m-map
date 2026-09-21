"use client";

/**
 * 路线流程图（src/components/favorites/RouteFlow.tsx，v2.4.0）
 *
 * ── 形态 ──────────────────────────────────────────────────────────────
 *   **纵向流程图**（与 `ComboEditor` 的 `.combo-flow` 同一视觉语言）：
 *     出发地 → 步行① → 上车站 → 线路 → [换乘] → 线路 → 下车 → 步行② → 目的地
 *
 * ── 与编辑器流程图的区别 ──────────────────────────────────────────────
 *   · `ComboEditor` 画的是**组合的站链**（可编辑：加站/插换乘）；
 *   · 本组件画的是**某一条已保存路线**（只读，来自 `ComboPlan.route`）。
 *
 * ── 步行设置的位置（2026-09-21 拍板）──────────────────────────────────
 *   **自定义步行耗时挂在路线上、UI 位于流程图旁** ⇒ 每个 `walk` 节点右侧
 *   带一个「耗时」按钮，点开就近编辑（同组合内同段共享，见 `walkKey`）。
 *
 * ⚠️ 老数据（`plan.route` 缺省）→ 降级：只显示 `snapshot.legs` 的**文字摘要**。
 */
import { useState } from "react";
import Icon from "@/components/ui/Icon";
import RouteStack from "@/components/RouteStack";
import {
  walkKey,
  placeWalkEnd,
  type Combo,
  type ComboPlan,
  type RouteWalkOv,
} from "@/lib/favorites/types";

/** 端点 slug 判定（与 `presets.slugOfEndpoint` 同口径；此处独立实现避免循环依赖） */
function slugOf(label: string): string {
  if (label.includes("澳门科技大学") || label.includes("澳科大")) return "school";
  if (label.includes("橫琴") || label.includes("横琴")) return "hengqin";
  if (label.includes("關閘") || label.includes("关闸")) return "gate";
  return "home";
}

export interface RouteFlowProps {
  combo: Combo;
  plan: ComboPlan;
  colors: Record<string, string>;
  readOnly: boolean;
  /** 写入某段步行覆盖（`null` = 清除） */
  onSetWalk: (key: string, ov: RouteWalkOv | null) => void;
}

/** 步行耗时编辑器（就近展开；同段共享 → 多处同步生效） */
function WalkEditor({
  label,
  current,
  readOnly,
  onApply,
  onClear,
  onClose,
}: {
  label: string;
  current?: number;
  readOnly: boolean;
  onApply: (minutes: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState(current != null ? String(current) : "");
  const n = Number(val);
  const valid = Number.isFinite(n) && n >= 0 && n <= 180;

  return (
    <div className="rf-editor" role="dialog" aria-label={`修改${label}耗时`}>
      <p className="rf-editor__title t-label t-muted">{label} · 实际要走多久？</p>
      <div className="rf-editor__row">
        <input
          className="inp rf-editor__inp"
          type="number"
          inputMode="decimal"
          min={0}
          max={180}
          step={0.1}
          value={val}
          placeholder="分钟"
          disabled={readOnly}
          aria-label={`${label}耗时（分钟）`}
          onChange={(e) => setVal(e.target.value)}
        />
        <span className="t-label t-muted">分钟</span>
      </div>
      <p className="rf-editor__hint t-label t-muted">
        同一组合内「{label}」相同的路段会一起改。
      </p>
      <div className="rf-editor__acts">
        <button type="button" className="btn btn--text btn--sm" onClick={onClose}>
          取消
        </button>
        {current != null && (
          <button
            type="button"
            className="btn btn--outline btn--sm"
            disabled={readOnly}
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            还原自动
          </button>
        )}
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={readOnly || !valid}
          onClick={() => {
            if (valid) {
              onApply(n);
              onClose();
            }
          }}
        >
          确定
        </button>
      </div>
    </div>
  );
}

export default function RouteFlow({ combo, plan, colors, readOnly, onSetWalk }: RouteFlowProps) {
  /** 正在编辑的步行段钥匙（非空 → 展开编辑器） */
  const [editing, setEditing] = useState<string | null>(null);
  const segs = plan.route;

  // ── 降级：老数据无结构 → 只用快照文字摘要 ──
  if (!segs || !segs.length) {
    return (
      <div className="rf">
        <p className="rf__title t-label t-muted">这条路线没有存下详细走向</p>
        {plan.snapshot.legs.length > 0 && (
          <p className="t-body t-muted">{plan.snapshot.legs.join(" → ")}</p>
        )}
        <p className="t-label t-muted">点「重新规划」可按当前路况算一版最新的。</p>
      </div>
    );
  }

  const fromSlug = slugOf(combo.from.label);
  const toSlug = slugOf(combo.to.label);

  return (
    <div className="rf">
      <div className="combo-flow rf__flow">
        {/* 出发地（端点：组合的 from） */}
        <div className="combo-node combo-node--end">
          <span className="combo-flow__dot combo-flow__dot--end" aria-hidden="true" />
          <div className="combo-node__body">
            <span className="combo-node__role t-label t-muted">出发地</span>
            <span className="combo-node__label">{combo.from.label}</span>
          </div>
        </div>

        {segs.map((s, i) => {
          // ── 步行段 ──
          if (s.kind === "walk") {
            const phase = s.phase ?? "out";
            const station = s.code ?? "";
            const fromE = phase === "out" ? placeWalkEnd(fromSlug) : station;
            const toE = phase === "out" ? station : placeWalkEnd(toSlug);
            const key = walkKey(combo.id, fromE, toE);
            const ov = plan.walkOv?.[key];
            const minutes = ov?.minutes ?? s.minutes;
            const overridden = ov?.minutes != null;
            return (
              <div key={`w-${i}`} className="combo-seg combo-seg--walk">
                <div className="combo-seg__head">
                  <Icon name="walk" size={16} />
                  <span className="combo-seg__role">
                    步行 → {s.label ?? station}
                  </span>
                  <button
                    type="button"
                    className={`rf-walk-btn${overridden ? " rf-walk-btn--on" : ""}`}
                    aria-label="修改这段步行耗时"
                    onClick={() => setEditing((k) => (k === key ? null : key))}
                  >
                    {minutes != null ? `${minutes} 分` : "设置"}
                  </button>
                  {overridden && <span className="rf-tag t-label">手改</span>}
                </div>
                {editing === key && (
                  <WalkEditor
                    label={s.label ?? station}
                    current={minutes}
                    readOnly={readOnly}
                    onApply={(m) => onSetWalk(key, { minutes: m })}
                    onClear={() => onSetWalk(key, null)}
                    onClose={() => setEditing(null)}
                  />
                )}
              </div>
            );
          }

          // ── 换乘段 ──
          if (s.kind === "transfer") {
            return (
              <div key={`t-${i}`} className="combo-seg combo-seg--transfer">
                <div className="combo-seg__head">
                  <Icon name="swap" size={16} />
                  <span className="combo-seg__role">换乘 · {s.label ?? s.code}</span>
                </div>
              </div>
            );
          }

          // ── 乘车段 ──
          if (s.kind === "ride") {
            const codes = s.routes?.length ? s.routes : s.route ? [s.route] : [];
            return (
              <div key={`r-${i}`} className="combo-node combo-node--ride">
                <span
                  className="combo-flow__dot"
                  style={{ background: colors[codes[0] ?? ""] ?? "var(--primary)" }}
                  aria-hidden="true"
                />
                <div className="combo-node__body">
                  <span className="combo-node__role t-label t-muted">
                    {s.hops ? `乘 ${s.hops} 站` : "乘车"}
                  </span>
                  <RouteStack codes={codes} colors={colors} size="sm" />
                  <span className="combo-node__sub t-label t-muted">
                    {s.boardLabel ?? s.board} → {s.alightLabel ?? s.alight}
                  </span>
                </div>
              </div>
            );
          }

          return null;
        })}

        {/* 目的地（端点：组合的 to） */}
        <div className="combo-node combo-node--end">
          <span className="combo-flow__dot combo-flow__dot--end" aria-hidden="true" />
          <div className="combo-node__body">
            <span className="combo-node__role t-label t-muted">目的地</span>
            <span className="combo-node__label">{combo.to.label}</span>
          </div>
        </div>
      </div>

      <p className="rf__foot t-label t-muted">
        约 {plan.snapshot.transfers > 0 ? `换乘 ${plan.snapshot.transfers} 次 · ` : "直达 · "}
        {plan.snapshot.walkMin ? `步行合计约 ${plan.snapshot.walkMin} 分` : "步行耗时待补"}
      </p>
    </div>
  );
}
