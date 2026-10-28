"use client";

/**
 * 「收藏组合」按钮（src/components/favorites/FavoriteButton.tsx，v3.3.0 · ADR-104 / AC-115）
 *
 * ── 口径（v3 起）───────────────────────────────────────────────────────
 *   收藏对象 = **组合**（一对起点终点）；**方案层已退役** ⇒ 本组件不再收 `fingerprint`/`snapshot`/`route`。
 *   · 两处入口（起终点页 / 推荐弹窗顶部）**共用同一文案常量** `FAV_COMBO_LABEL` ⇒ 防文案再次分叉；
 *   · 形态：`withLabel`（起终点页）= 整块按钮 `fav-btn--block`；否则（推荐弹窗顶栏）= chip `.route-sheet__fav`；
 *   · 点击 → 图标切实心 + 行内轻提示（**不弹模态**）；再点 = 取消收藏；
 *   · 只读（`localStorage` 不可用）→ 置灰 + `title` 提示。
 *   ⚠️ **导航弹窗内不设收藏入口**（AC-115）—— 本组件不再被 `NavDetailBody` 引用。
 */
import { useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import { comboV3Key, makeComboV3 } from "@/lib/favorites/useCombos";
import { useCombos } from "@/lib/favorites/useCombos";
import type { FavoriteEndpoint } from "@/lib/favorites/types";

/** ★ v3.3.0（AC-115）：两处「收藏组合」按钮**同一常量** */
export const FAV_COMBO_LABEL = "收藏组合";
export const FAV_COMBO_LABEL_ON = "已收藏组合";

export interface FavoriteButtonProps {
  from: FavoriteEndpoint;
  to: FavoriteEndpoint;
  /** 起终点页（整块按钮 + 文案）；缺省 = 推荐弹窗顶部（chip） */
  withLabel?: boolean;
  /** 外层附加类名（起终点页传 `fav-btn--block`） */
  className?: string;
}

export default function FavoriteButton({ from, to, withLabel = false, className = "" }: FavoriteButtonProps) {
  const { mounted, combos, readOnly, addCombo, removeCombo } = useCombos();
  const [msg, setMsg] = useState("");
  const timer = useRef<number | null>(null);

  const key = comboV3Key({ from, to });
  const saved = combos.find((c) => comboV3Key(c) === key) ?? null;

  const flash = (t: string) => {
    setMsg(t);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(""), 2000);
  };

  function onClick() {
    if (readOnly) return;
    if (saved) {
      const r = removeCombo(saved.id);
      flash(r.ok ? "已取消收藏" : r.reason === "unavailable" ? "当前浏览器不支持本地收藏" : "操作失败，请稍后再试");
      return;
    }
    const r = addCombo(makeComboV3({ from, to }));
    if (r.ok) flash("已收藏组合");
    else if (r.reason === "duplicate") flash("已在收藏中");
    else if (r.reason === "unavailable") flash("当前浏览器不支持本地收藏");
    else flash("收藏失败，请稍后再试");
  }

  const label = !mounted
    ? FAV_COMBO_LABEL
    : readOnly
      ? "当前浏览器不支持本地收藏"
      : saved
        ? FAV_COMBO_LABEL_ON
        : FAV_COMBO_LABEL;

  if (!withLabel) {
    /* 推荐弹窗顶部 chip（03 §3.5 ②） */
    return (
      <button
        type="button"
        className={`route-sheet__fav${saved ? " is-on" : ""}`}
        onClick={onClick}
        disabled={!mounted || readOnly}
        aria-pressed={!!saved}
        aria-label={saved ? "取消收藏该组合" : "收藏该组合"}
        title={label}
      >
        <Icon name={saved ? "bookmarkFilled" : "bookmark"} size={16} />
        <span>{mounted ? (saved ? FAV_COMBO_LABEL_ON : FAV_COMBO_LABEL) : FAV_COMBO_LABEL}</span>
      </button>
    );
  }

  return (
    <div className={`fav-btn ${className}`}>
      <button
        type="button"
        className={`fav-btn__btn${saved ? " is-on" : ""}`}
        onClick={onClick}
        disabled={!mounted || readOnly}
        aria-pressed={!!saved}
        aria-label={saved ? "取消收藏该组合" : "收藏该组合"}
        title={label}
      >
        <Icon name={saved ? "bookmarkFilled" : "bookmark"} size={20} />
        <span className="fav-btn__text">{mounted ? (saved ? FAV_COMBO_LABEL_ON : FAV_COMBO_LABEL) : FAV_COMBO_LABEL}</span>
      </button>
      {msg && (
        <span className="fav-btn__msg" role="status">
          {msg}
        </span>
      )}
    </div>
  );
}
