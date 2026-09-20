"use client";

/**
 * 收藏卡片（src/components/favorites/FavoriteCard.tsx，M Map 改版 S5）
 *
 * ── 两类收藏用**不同形态**表达（设计 E.2）─────────────────────────────
 *   · **地点对** = 发丝线列表行（只有「两点」，不套卡片盒，避开 AI 模板「一律套盒」）；
 *   · **路线方案** = **带左侧纵向路线色轨的卡**（是一段「行程」，信息量更大）。
 *
 * ── 时长口径（PRD §7.3，关键）─────────────────────────────────────────
 *   方案卡显示 **`约 totalMinAtSave 分`** 且**必须标注快照时间**（「约 30 分 · 保存于 09-20」），
 *   **不得**显示为当前实时时长 —— 避免误导。
 *
 * ── 线路标签 ──────────────────────────────────────────────────────────
 *   线路码取 `snapshot.legs` 首段前缀（`legSummary` 产出 `"<code> <board>→<alight>"`），
 *   颜色仍来自**线路数据**（`colors` 表），**不纳入 token**（Spec §7 / §9）。
 */
import { useState } from "react";
import Icon from "@/components/ui/Icon";
import RouteStack from "@/components/RouteStack";
import { savedAtText, type FavoriteItem, type PlaceFavorite, type PlanFavorite } from "@/lib/favorites/types";

/** 类型徽章文案（与搜索结果口径一致） */
const KIND_LABEL: Record<string, string> = {
  gps: "我的位置",
  poi: "地点",
  station: "公交站",
  place: "地点",
};

export interface FavoriteCardProps {
  item: FavoriteItem;
  colors: Record<string, string>;
  readOnly: boolean;
  onOpen: (item: FavoriteItem) => void;
  onRemove: (id: string) => void;
  onRename: (id: string, note: string) => void;
  onPin: (id: string, pinned: boolean) => void;
}

export default function FavoriteCard({ item, colors, readOnly, onOpen, onRemove, onRename, onPin }: FavoriteCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.note ?? "");

  const nameOf = (i: FavoriteItem) => i.note?.trim() || (i.type === "plan" ? planTitle(i) : `${i.from.label} → ${i.to.label}`);

  if (item.type === "place") return <PlaceRow />;

  return <PlanRow />;

  // ─────────────────────────── 地点对：发丝线行 ───────────────────────────
  function PlaceRow() {
    const it = item as PlaceFavorite;
    return (
      <div className={`fav-row${it.pinned ? " is-pinned" : ""}`} data-fav-id={it.id}>
        <button type="button" className="fav-row__main" onClick={() => onOpen(it)}>
          <span className="fav-row__od">
            <span className="fav-row__end">{it.from.label}</span>
            <Icon name="arrowRight" size={16} />
            <span className="fav-row__end">{it.to.label}</span>
          </span>
          <span className="fav-row__meta">
            <span className="fav-badge t-label">{KIND_LABEL[it.from.kind] ?? "地点"}</span>
            <Icon name="arrowRight" size={16} />
            <span className="fav-badge t-label">{KIND_LABEL[it.to.kind] ?? "地点"}</span>
            {it.pinned && <span className="fav-badge fav-badge--pin t-label">置顶</span>}
          </span>
        </button>
        {Menu()}
      </div>
    );
  }

  // ─────────────────────────── 方案：带色轨的卡 ───────────────────────────
  function PlanRow() {
    const it = item as PlanFavorite;
    const codes = it.snapshot.legs.map((l) => l.split(" ")[0]).filter(Boolean);
    const railColor = codes.length ? colors[codes[0]] ?? null : null;
    return (
      <div className={`fav-plan${it.pinned ? " is-pinned" : ""}`} data-fav-id={it.id}>
        <span
          className="fav-plan__rail"
          style={railColor ? { background: railColor } : undefined}
          aria-hidden="true"
        />
        <button type="button" className="fav-plan__main" onClick={() => onOpen(it)}>
          <span className="fav-plan__title">{nameOf(it)}</span>
          <span className="fav-plan__line">
            {codes.length ? (
              <RouteStack codes={codes} colors={colors} size="sm" />
            ) : (
              <span className="t-label t-muted">线路方案</span>
            )}
          </span>
          <span className="fav-plan__meta t-label t-muted">
            约 {Math.round(it.snapshot.totalMin)} 分 · {savedAtText(it.snapshot.capturedAt)}
            {it.snapshot.transfers > 0 ? ` · 换乘 ${it.snapshot.transfers} 次` : " · 直达"}
          </span>
        </button>
        {Menu()}
      </div>
    );
  }

  // ─────────────────────────── 「更多」菜单 ───────────────────────────
  function Menu() {
    return (
      <div className="fav-menu">
        <button
          type="button"
          className="fav-menu__btn"
          aria-label="更多操作"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((v) => !v);
            setConfirming(false);
          }}
        >
          <Icon name="expandVertical" size={20} />
        </button>

        {menuOpen && (
          <div className="fav-menu__pop" role="menu">
            {renaming ? (
              <form
                className="fav-menu__rename"
                onSubmit={(e) => {
                  e.preventDefault();
                  onRename(item.id, draft.trim().slice(0, 40));
                  setRenaming(false);
                  setMenuOpen(false);
                }}
              >
                <input
                  className="inp fav-menu__inp"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={40}
                  placeholder="给这条收藏起个名字"
                  aria-label="备注名称"
                  autoFocus
                />
                <button type="submit" className="btn btn--text btn--sm" disabled={readOnly}>
                  保存
                </button>
              </form>
            ) : confirming ? (
              <div className="fav-menu__confirm">
                <span className="fav-menu__confirm-text t-label">取消这条收藏？</span>
                <button
                  type="button"
                  className="btn btn--danger-text btn--sm"
                  onClick={() => {
                    onRemove(item.id);
                    setConfirming(false);
                    setMenuOpen(false);
                  }}
                >
                  取消收藏
                </button>
                <button type="button" className="btn btn--text btn--sm" onClick={() => setConfirming(false)}>
                  再想想
                </button>
              </div>
            ) : (
              <>
                <button
                  type="button"
                  className="fav-menu__item"
                  onClick={() => {
                    setDraft(item.note ?? "");
                    setRenaming(true);
                  }}
                  disabled={readOnly}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="fav-menu__item"
                  onClick={() => {
                    onPin(item.id, !item.pinned);
                    setMenuOpen(false);
                  }}
                  disabled={readOnly}
                >
                  {item.pinned ? "取消置顶" : "置顶"}
                </button>
                <button type="button" className="fav-menu__item fav-menu__item--danger" onClick={() => setConfirming(true)}>
                  取消收藏
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }
}

/** 方案默认标题：`<线路> · <起点> → <终点>` */
function planTitle(p: PlanFavorite): string {
  const first = p.snapshot.legs[0]?.split(" ")[0];
  const head = first ? `${first} · ` : "";
  return `${head}${p.from.label} → ${p.to.label}`;
}
