"use client";

/**
 * 收藏扁卡片（src/components/favorites/FavoriteCard.tsx，v3.3.0 · 03 §3.2/§3.3 / AC-112/113）
 *
 * ── 形态（组合卡 / 地点卡**同构**）──────────────────────────────────────
 *   `min-height: 56px`（旧卡 ~64~72px ⇒ 一屏多放 1~2 张）；`--radius-card` +
 *   `1.5px --border-strong` + `--shadow-hard-sm`（站牌风沿用）。
 *   · 组合卡：名称（`{起点} → {终点}` 或用户改名）+ 右「**编辑起点终点**」工具（44×44）+ ⋯ 菜单；
 *   · 地点卡：左 `destination` 图标 + 名称 + ⋯ 菜单（**无**「编辑起终点」）。
 *   · 已停用（组合）→ 名称转 `--meta` + 右侧小字「已停用」；置顶 → 名称前 `pinTop` 16px `--accent`。
 *   · **hover 只换边框色**（不叠投影 ⇒ 避「幽灵卡」反模式）。
 *   · ⋯ 菜单项由调用方给（设计：组合 = 重命名/置顶/停用/删除；地点 = 重命名/删除）—— **无「查看路线」**。
 */
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";

export interface FavoriteMenuItem {
  label: string;
  onSelect: () => void;
}

export interface FavoriteCardProps {
  kind: "combo" | "place";
  /** 显示名（组合 = `name`；地点 = `name ?? endpoint.label`） */
  title: string;
  /** 组合 · 已停用 */
  disabled?: boolean;
  /** 已置顶 */
  pinned?: boolean;
  /** 点卡身 = 回放（组合 = 首页式规划；地点 = 首页式选点） */
  onOpen: () => void;
  /** 「编辑起点终点」工具（仅组合给） */
  onEdit?: () => void;
  /** ⋯ 菜单项 */
  menu: FavoriteMenuItem[];
  /** 只读（`localStorage` 不可用）⇒ 置灰禁点 */
  readOnly?: boolean;
}

export default function FavoriteCard({
  kind,
  title,
  disabled = false,
  pinned = false,
  onOpen,
  onEdit,
  menu,
  readOnly = false,
}: FavoriteCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  /** 点外部 / Esc 关菜单 */
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div
      ref={wrapRef}
      className={`fav-flat${disabled ? " is-off" : ""}${pinned ? " is-pinned" : ""}${readOnly ? " is-ro" : ""}`}
      data-fav-kind={kind}
    >
      <button
        type="button"
        className="fav-flat__main"
        onClick={onOpen}
        disabled={readOnly}
        title={title}
        aria-label={`${kind === "combo" ? "按该组合规划" : "以该地点为目的地"}：${title}`}
      >
        {pinned && (
          <span className="fav-flat__pin" aria-hidden="true">
            <Icon name="pinTop" size={16} />
          </span>
        )}
        {kind === "place" && (
          <span className="fav-flat__lead" aria-hidden="true">
            <Icon name="destination" size={20} />
          </span>
        )}
        <span className="fav-flat__name">{title}</span>
        {disabled && <span className="fav-flat__off">已停用</span>}
      </button>

      {/* 「编辑起点终点」工具（组合专属；44×44 命中区） */}
      {kind === "combo" && onEdit && (
        <button
          type="button"
          className="fav-flat__tool"
          onClick={onEdit}
          disabled={readOnly}
          aria-label="编辑起点与终点"
          title="编辑起点与终点"
        >
          <Icon name="edit" size={20} />
        </button>
      )}

      {/* ⋯ 更多 */}
      <div className="fav-flat__mwrap">
        <button
          type="button"
          className="fav-flat__tool"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={readOnly}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="更多操作"
          title="更多操作"
        >
          <Icon name="more" size={20} />
        </button>
        {menuOpen && (
          <div className="fav-flat__menu" role="menu">
            {menu.map((m) => (
              <button
                key={m.label}
                type="button"
                role="menuitem"
                className="fav-flat__mitem"
                onClick={() => {
                  setMenuOpen(false);
                  m.onSelect();
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
