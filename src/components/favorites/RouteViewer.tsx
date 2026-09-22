"use client";

/**
 * 查看路线页（src/components/favorites/RouteViewer.tsx，2026-09-22 新增）
 *
 * ── 它取代了什么 ──────────────────────────────────────────────────────
 *   旧版 ⋯ 菜单里的「编辑编排」→ `ComboEditor`（改站点/链）。产品口径改为
 *   **查看路线**：展示该组合下**库里固定的路线**（`favorite_routes` 表），
 *   一行一卡、**不做斜杠合并** —— 例如「擎天汇 → 横琴口岸」应显示 **13 张**：
 *     `26→50`、`26→25B`…`50→N6`（12 张）+ 轻轨线（1 张）。
 *
 * ── 与旧 `ComboPlans` 的区别（关键）────────────────────────────────────
 *   · `ComboPlans`：**现场拿模型 + 高德算**（文案「可点重新规划」），不稳定；
 *   · 本组件：**只读库**（`GET /api/fav-routes`），内容由用户在库里定稿 ✓
 *
 * ── 卡片形态（产品要求）───────────────────────────────────────────────
 *   · **只有线路名标签**（`26 → 50`），不显示白色斜杠、不合并同名上下车站；
 *   · ⚠️ 该「不合并」只作用于**本页**，站内其他页面（如方案卡）保持原样。
 *
 * ── 交互 ──────────────────────────────────────────────────────────────
 *   · 点某张路线卡 → 进入**流程图编辑页**（`RouteFlowEditor`），可改步行/速度/档位；
 *   · 「添加线路」→ 选上车站 + 下车站 → 进同一编辑页（新建）。
 */
import { useCallback, useEffect, useState } from "react";
import Icon from "@/components/ui/Icon";
import RouteFlowEditor, { type FavRoute } from "./RouteFlowEditor";
import type { Combo } from "@/lib/favorites/types";

/** 端点 label → slug（与 `useCombos.endpointSlug` 同口径） */
function slugOf(label: string): string {
  if (label.includes("澳門科技大學") || label.includes("澳门科技大学") || label.includes("澳科大")) return "school";
  if (label.includes("橫琴") || label.includes("横琴")) return "hengqin";
  if (label.includes("關閘") || label.includes("关闸")) return "gate";
  return "home";
}

export interface RouteViewerProps {
  combo: Combo;
  colors: Record<string, string>;
  onExit: () => void;
}

export default function RouteViewer({ combo, colors, onExit }: RouteViewerProps) {
  const fromSlug = slugOf(combo.from.label);
  const toSlug = slugOf(combo.to.label);

  const [routes, setRoutes] = useState<FavRoute[] | null>(null);
  const [err, setErr] = useState("");
  /** 正在编辑的路线（null = 不在编辑）；`__new__` 表示新建 */
  const [editing, setEditing] = useState<FavRoute | "new" | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/fav-routes?from=${fromSlug}&to=${toSlug}`, { cache: "no-store" });
      const j = (await r.json()) as { routes?: FavRoute[]; error?: string };
      if (j.error) setErr(j.error);
      setRoutes(j.routes ?? []);
    } catch {
      setErr("路线读取失败");
      setRoutes([]);
    }
  }, [fromSlug, toSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── 编辑态：交给流程图编辑器 ──
  if (editing) {
    return (
      <RouteFlowEditor
        combo={combo}
        route={editing === "new" ? null : editing}
        fromSlug={fromSlug}
        toSlug={toSlug}
        colors={colors}
        onClose={(saved) => {
          setEditing(null);
          setAdding(false);
          if (saved) void load();
        }}
      />
    );
  }

  return (
    <div className="rv-page">
      <header className="rv-head">
        <button type="button" className="rv-head__back" onClick={onExit} aria-label="返回收藏列表">
          <Icon name="back" size={20} />
        </button>
        <div className="rv-head__title">
          <span className="rv-head__name">{combo.name}</span>
          <span className="rv-head__od t-label t-muted">
            {combo.from.label} → {combo.to.label}
          </span>
        </div>
        <button
          type="button"
          className="rv-head__add"
          onClick={() => {
            setAdding(true);
            setEditing("new");
          }}
          aria-label="添加线路"
        >
          <Icon name="add" size={20} />
          添加线路
        </button>
      </header>

      <div className="rv-body">
        {err && <p className="rv-hint t-muted">{err}</p>}
        {!routes && <p className="rv-hint t-muted">正在读取路线…</p>}
        {routes && routes.length === 0 && (
          <p className="rv-hint t-muted">
            这个组合还没有固定路线。点右上角「添加线路」，选上车站与下车站即可新建。
          </p>
        )}

        {routes?.map((r) => (
          <button key={r.id} type="button" className="rv-card" onClick={() => setEditing(r)}>
            {/* ★ 只显示线路名标签，**不合并**（产品要求：本页无白色斜杠） */}
            <span className="rv-card__labels">
              {r.routeLabels.map((lb, i) => (
                <span key={`${lb}-${i}`} className="rv-card__label">
                  {lb}
                  {i < r.routeLabels.length - 1 && <Icon name="arrowRight" size={16} className="rv-card__arrow" />}
                </span>
              ))}
            </span>
            <span className="rv-card__foot t-label t-muted">
              {r.segs.filter((s) => s.kind === "ride").length} 段乘车
              {r.source === "user" && " · 已编辑"}
            </span>
          </button>
        ))}
      </div>

      {adding && <span className="sr-only" role="status">正在新建线路</span>}
    </div>
  );
}
