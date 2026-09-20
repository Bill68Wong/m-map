"use client";

/**
 * 通用收藏按钮（src/components/favorites/FavoriteButton.tsx；★ v2.3.0 S2：写入方切到组合模型）
 *
 * 供 **4 处入口**复用（保持不变）：
 *   ① `/nav` 每张方案卡（方案）  ② `/nav/detail` 详情头部（方案）
 *   ③ 首页选定目的地后（地点对）  ④ `/nav` 顶部 OD 栏（地点对）
 *
 * ── 交互（PRD §7.4）───────────────────────────────────────────────────
 *   · 点击收藏 → 图标切**实心书签** + 轻量行内提示（**不弹模态**）；
 *   · 再点取消 → 「已取消收藏」；重复收藏 → 「已在收藏中」；
 *   · `localStorage` 不可用 → 置灰 + 行内提示，**不阻塞**导航主流程。
 *
 * ── ★ S2 变更：写入不再落 v1，改走「组合 → 组合下方案」两级 ─────────────
 *   · `kind="plan"`  → `savePlanFavorite()`：同 `query` 组合已存在则追加 `ComboPlan`；
 *                     不存在则**新建组合并带上该 plan（一次写入）**；
 *   · `kind="place"` → `savePlaceCombo()`：新建「无方案」组合；
 *   · 取消：`plan` → `removePlanFromCombo()`（**组合保留**，FA-A.14）；
 *           `place` → `removeCombo()`，但**组合下还有已保存方案时拒绝并提示**（防误删）。
 *   ⇒ S1→S2 的「v1/v2 双写窗口」到此消除（本组件是唯一的写入方）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Icon, { type IconSize } from "@/components/ui/Icon";
import {
  savePlaceCombo,
  savePlanFavorite,
  useCombos,
} from "@/lib/favorites/useCombos";
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
  const c = useCombos();
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  /** 该 OD 对应的组合（两级模型的锚点） */
  const combo = useMemo(() => c.combos.find((x) => x.query === query), [c.combos, query]);
  const saved =
    c.mounted && (kind === "plan" ? !!fingerprint && !!combo?.plans.some((p) => p.fingerprint === fingerprint) : !!combo);
  const ready = kind === "place" || (!!fingerprint && !!snapshot);
  const disabled = !c.mounted || c.readOnly || !ready;

  function flash(text: string) {
    setMsg(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(""), 2400);
  }

  function onToggle() {
    if (disabled) return;
    if (saved) {
      if (kind === "place") {
        if (!combo) return;
        if (combo.plans.length > 0) {
          flash(`该组合下还有 ${combo.plans.length} 条已保存方案，请到收藏页处理`);
          return;
        }
        c.remove(combo.id);
        flash("已取消收藏");
        return;
      }
      if (combo && fingerprint) {
        const p = combo.plans.find((x) => x.fingerprint === fingerprint);
        if (p) c.removePlan(combo.id, p.id);
        flash("已取消收藏");
        return;
      }
      return;
    }
    const res =
      kind === "plan" && fingerprint && snapshot
        ? savePlanFavorite({ from, to, query, fingerprint, snapshot })
        : savePlaceCombo({ from, to, query });
    if (res.ok) flash("已收藏");
    else if (res.reason === "duplicate") flash("已在收藏中");
    else if (res.reason === "unavailable") flash("当前浏览器不支持本地收藏");
    else flash("收藏失败，请稍后再试");
  }

  const label = !c.mounted
    ? "收藏"
    : !c.available
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
