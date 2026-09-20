"use client";

/**
 * 通用收藏按钮（src/components/favorites/FavoriteButton.tsx，M Map 改版 S5）
 *
 * 供 **4 处入口**复用（Spec §5 / 02 §3.1）：
 *   ① `/nav` 每张方案卡（方案）  ② `/nav/detail` 详情头部（方案）
 *   ③ 首页选定目的地后（地点对）  ④ `/nav` 顶部 OD 栏（地点对）
 *
 * ── 交互（PRD §7.4）───────────────────────────────────────────────────
 *   · 点击收藏 → 图标切**实心书签**（选中态）+ 轻量行内「已收藏」（**不弹模态**）；
 *   · 再点取消 → 「已取消收藏」；
 *   · 重复收藏 → 去重，提示「已在收藏中」；
 *   · `localStorage` 不可用（隐私模式）→ 按钮置灰 + 行内提示「当前浏览器不支持本地收藏」，
 *     **不阻塞**导航主流程。
 *
 * ── 双体系（方案 / 地点对）────────────────────────────────────────────
 *   · `kind="plan"` → 存 `query + fingerprint`（**不落 planId**）；
 *   · `kind="place"` → 存 `query`。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Icon, { type IconSize } from "@/components/ui/Icon";
import { dedupeKey, makePlanFavorite, makePlaceFavorite } from "@/lib/favorites";
import { useFavorites } from "@/lib/favorites/useFavorites";
import type { FavoriteEndpoint, PlanSnapshot } from "@/lib/favorites/types";

export type FavoriteEntry = "card" | "detail" | "home" | "odbar";

export interface FavoriteButtonProps {
  /** 收藏对象类型 */
  kind: "plan" | "place";
  from: FavoriteEndpoint;
  to: FavoriteEndpoint;
  /** 规范化查询串（不含 plan） */
  query: string;
  /** 方案指纹（`kind="plan"` 时必填） */
  fingerprint?: string;
  /** 方案快照（`kind="plan"` 时必填） */
  snapshot?: PlanSnapshot;
  /** 入口标识（埋点 / 文案用） */
  entry: FavoriteEntry;
  /** 图标尺寸（默认 20 = 按钮内档） */
  size?: IconSize;
  /** 是否带文字（默认仅图标） */
  withLabel?: boolean;
  className?: string;
}

export default function FavoriteButton({
  kind,
  from,
  to,
  query,
  fingerprint,
  snapshot,
  entry,
  size = 20,
  withLabel = false,
  className = "",
}: FavoriteButtonProps) {
  const favs = useFavorites();
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const item = useMemo(() => {
    if (kind === "place") return makePlaceFavorite(from, to, query);
    if (!fingerprint || !snapshot) return null;
    return makePlanFavorite(from, to, query, fingerprint, snapshot);
  }, [kind, from, to, query, fingerprint, snapshot]);

  const key = item ? dedupeKey(item) : "";
  const saved = favs.mounted && !!item && favs.has(key);
  const disabled = !favs.mounted || favs.readOnly || !item;

  function flash(text: string) {
    setMsg(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(""), 2200);
  }

  function onToggle() {
    if (disabled || !item) return;
    if (saved) {
      const existing = favs.items.find((i) => dedupeKey(i) === key);
      if (existing) favs.remove(existing.id);
      flash("已取消收藏");
      return;
    }
    const res = favs.add(item);
    if (res.ok) flash("已收藏");
    else if (res.reason === "duplicate") flash("已在收藏中");
    else if (res.reason === "unavailable") flash("当前浏览器不支持本地收藏");
    else flash("收藏失败，请稍后再试");
  }

  const label = !favs.mounted
    ? "收藏"
    : !favs.available
      ? "当前浏览器不支持本地收藏"
      : saved
        ? "取消收藏"
        : "收藏此路线";

  return (
    <span className={`fav-btn${className ? ` ${className}` : ""}`} data-entry={entry} data-kind={kind}>
      <button
        type="button"
        className={`fav-btn__btn${saved ? " is-on" : ""}`}
        aria-pressed={saved}
        aria-label={label}
        title={label}
        disabled={disabled}
        onClick={onToggle}
      >
        <Icon name={saved ? "bookmarkFilled" : "bookmark"} size={size} />
        {withLabel && <span className="fav-btn__text">{saved ? "已收藏" : "收藏"}</span>}
      </button>
      {msg && (
        <span className="fav-btn__msg" role="status">
          {msg}
        </span>
      )}
    </span>
  );
}
