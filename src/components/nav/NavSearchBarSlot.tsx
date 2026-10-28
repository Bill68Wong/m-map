"use client";

/**
 * 顶置搜索条 + 提示条槽（src/components/nav/NavSearchBarSlot.tsx，2026-09-25 从 NavShell 拆出 · 07 §5.3）
 *
 * · 搜索条：只在「非全屏搜索」时出现；面板打开期间 200ms 淡出（`body[data-sheet=open]`）；
 * · ★ v3.3.0（AC-114）：右上角原「已选」位改**「收藏地点」入口**（确认选点后出现；44 热区；已/未收藏双态）；
 * · 收藏带入提示条：可出发态且未选出发地时显示；
 * · 车辆位置获取失败提示：不阻塞地图与线路走向。
 *
 * ⚠️ DOM 结构（v3.3.0）：搜索条由 `<button>` 改 **`<div>` + 内部主按钮 `<button.nav-searchbar__main>`**
 *   —— 因为「收藏地点」必须是**独立可点按钮**，而 `<button>` 不能嵌套 `<button>`（无效 HTML）。
 *   视觉不变（`.nav-searchbar` 仍是那条白底蓝框；主按钮透明铺满左侧）。
 */
import { useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import {
  makePlaceV3,
  placeV3Key,
  useCombos,
} from "@/lib/favorites/useCombos";
import { endpointOf } from "@/lib/favorites/types";
import type { NavPoint } from "@/lib/nav/types";

export interface NavSearchBarSlotProps {
  stage: "map" | "search" | "panel";
  to: NavPoint | null;
  from: NavPoint | null;
  initialTo: NavPoint | null;
  initialFrom: NavPoint | null;
  /** 车辆位置获取失败 */
  error?: boolean;
  myLocationLabel: string;
  onOpenSearch: () => void;
}

export default function NavSearchBarSlot({
  stage,
  to,
  from,
  initialTo,
  initialFrom,
  error = false,
  myLocationLabel,
  onOpenSearch,
}: NavSearchBarSlotProps) {
  const fav = useCombos();
  const [msg, setMsg] = useState("");
  const timer = useRef<number | null>(null);

  const ep = to ? endpointOf(to) : null;
  const saved = ep ? (fav.places.find((p) => placeV3Key(p) === placeV3Key({ endpoint: ep })) ?? null) : null;
  const showFav = stage === "panel" && !!ep && fav.mounted;

  const flash = (t: string) => {
    setMsg(t);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(""), 2000);
  };

  /** 点「收藏地点」：**阻止冒泡**（不打开搜索）；行内轻提示，不弹模态、不跳页 */
  function toggleFav(e: React.MouseEvent) {
    e.stopPropagation();
    if (!ep || fav.readOnly) return;
    if (saved) {
      const r = fav.removePlace(saved.id);
      flash(r.ok ? "已取消收藏" : "操作失败，请稍后再试");
      return;
    }
    const r = fav.addPlace(makePlaceV3(ep));
    if (r.ok) flash("已收藏地点");
    else if (r.reason === "duplicate") flash("已在收藏中");
    else if (r.reason === "unavailable") flash("当前浏览器不支持本地收藏");
    else flash("收藏失败，请稍后再试");
  }

  return (
    <>
      {stage !== "search" && (
        <div className="nav-searchbar">
          <button
            type="button"
            className="nav-searchbar__main"
            onClick={onOpenSearch}
            aria-label={to ? `已选目的地 ${to.label}，点击修改` : "选择目的地"}
          >
            <Icon name="search" size={20} />
            <span className={`nav-searchbar__text${to ? "" : " nav-searchbar__text--ph"}`}>
              {to ? to.label : "去哪儿？"}
            </span>
          </button>
          {/* ★ v3.3.0（AC-114）：「收藏地点」（搜索框右上角原「已选」位；双态；44 热区） */}
          {showFav && (
            <button
              type="button"
              className="nav-searchbar__fav"
              onClick={toggleFav}
              aria-pressed={!!saved}
              aria-label={saved ? "取消收藏该地点" : "收藏该地点"}
              title={
                fav.readOnly
                  ? "当前浏览器不支持本地收藏"
                  : saved
                    ? "取消收藏该地点"
                    : "收藏该地点"
              }
            >
              <Icon name={saved ? "bookmarkFilled" : "bookmark"} size={16} />
              {saved ? "已收藏" : "收藏地点"}
            </button>
          )}
        </div>
      )}
      {msg && (
        <div className="nav-banner t-label" role="status">
          {msg}
        </div>
      )}

      {/* 带入收藏提示条（可出发态才显示） */}
      {initialTo && stage === "panel" && !from && (
        <div className="nav-banner t-label" role="status">
          已带入收藏：{initialFrom?.label ?? myLocationLabel} → {initialTo.label}
        </div>
      )}

      {/* 车辆位置获取失败提示（不阻塞地图与线路走向） */}
      {error && (
        <div className="nav-banner t-label" role="status">
          车辆位置暂时不可用
        </div>
      )}
    </>
  );
}
