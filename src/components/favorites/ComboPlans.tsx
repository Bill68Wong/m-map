"use client";

/**
 * 收藏列表（src/components/favorites/ComboPlans.tsx，v3.3.0 · 03 §3.1 / AC-112）
 *
 * ── 为什么沿用本文件名 ──────────────────────────────────────────────────
 *   v2 时它是「组合 → 方案子列表（现场算多方案）」；v3 **方案层退役** ⇒ 本文件降为**纯列表**：
 *   **组合（上） / 地点（下）** 两区，两区**标题常显**（含空态引导句），卡 = 56px 扁卡。
 *   （06 §3.3 对它的判定即「降为组合列表（OD 卡，扁 56px）；删方案子列表部分」。）
 *   ⇒ v2 的「点组合现场算多方案 + 路线清单 + 流程图编辑」整体下线（并入 §3.7 首页式回放）。
 */
import FavoriteCard, { type FavoriteMenuItem } from "./FavoriteCard";
import type { ComboV3, PlaceV3 } from "@/lib/favorites/useCombos";

export type ComboAction = "rename" | "pin" | "disable" | "delete";
export type PlaceAction = "rename" | "delete";

export interface FavoritesListProps {
  combos: ComboV3[];
  places: PlaceV3[];
  readOnly?: boolean;
  onOpenCombo: (c: ComboV3) => void;
  onOpenPlace: (p: PlaceV3) => void;
  onEditCombo: (c: ComboV3) => void;
  onComboAction: (c: ComboV3, action: ComboAction) => void;
  onPlaceAction: (p: PlaceV3, action: PlaceAction) => void;
}

export default function FavoritesList({
  combos,
  places,
  readOnly = false,
  onOpenCombo,
  onOpenPlace,
  onEditCombo,
  onComboAction,
  onPlaceAction,
}: FavoritesListProps) {
  /** ⋯ 菜单（组合）：重命名 / 置顶 / 停用 / 删除 —— **无「查看路线」**（方案体系退役） */
  const comboMenu = (c: ComboV3): FavoriteMenuItem[] => [
    { label: "重命名", onSelect: () => onComboAction(c, "rename") },
    { label: c.pinned ? "取消置顶" : "置顶", onSelect: () => onComboAction(c, "pin") },
    { label: c.disabled ? "启用" : "停用", onSelect: () => onComboAction(c, "disable") },
    { label: "删除", onSelect: () => onComboAction(c, "delete") },
  ];
  /** ⋯ 菜单（地点）：重命名 / 删除（地点无置顶/停用） */
  const placeMenu = (p: PlaceV3): FavoriteMenuItem[] => [
    { label: "重命名", onSelect: () => onPlaceAction(p, "rename") },
    { label: "删除", onSelect: () => onPlaceAction(p, "delete") },
  ];

  /** 置顶优先，其次最近使用 */
  const sortBy = <T extends { pinned?: boolean; lastUsedAt?: number; createdAt: number }>(a: T, b: T) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt);
  const comboRows = [...combos].sort(sortBy);
  const placeRows = [...places].sort(sortBy);

  return (
    <>
      {/* ── ① 收藏组合（上）── */}
      <section className="fav-sec" aria-labelledby="fav-sec-combo">
        <h2 className="fav-sec__title" id="fav-sec-combo">
          收藏组合
        </h2>
        {comboRows.length === 0 ? (
          <p className="fav-sec__empty t-label t-muted">在起点终点页点「收藏组合」，即可保存常用的一对起终点。</p>
        ) : (
          <div className="fav-list">
            {comboRows.map((c) => (
              <FavoriteCard
                key={c.id}
                kind="combo"
                title={c.name}
                disabled={c.disabled}
                pinned={c.pinned}
                readOnly={readOnly}
                onOpen={() => onOpenCombo(c)}
                onEdit={() => onEditCombo(c)}
                menu={comboMenu(c)}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── ② 收藏地点（下）── */}
      <section className="fav-sec" aria-labelledby="fav-sec-place">
        <h2 className="fav-sec__title" id="fav-sec-place">
          收藏地点
        </h2>
        {placeRows.length === 0 ? (
          <p className="fav-sec__empty t-label t-muted">选定目的地后，点搜索框右上角「收藏地点」即可保存单个地点。</p>
        ) : (
          <div className="fav-list">
            {placeRows.map((p) => (
              <FavoriteCard
                key={p.id}
                kind="place"
                title={p.name ?? p.endpoint.label}
                pinned={p.pinned}
                readOnly={readOnly}
                onOpen={() => onOpenPlace(p)}
                menu={placeMenu(p)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}
