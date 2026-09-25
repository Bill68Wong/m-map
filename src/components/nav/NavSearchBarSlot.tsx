"use client";

/**
 * 顶置搜索条 + 提示条槽（src/components/nav/NavSearchBarSlot.tsx，2026-09-25 从 NavShell 拆出 · 07 §5.3）
 *
 * · 搜索条：只在「非全屏搜索」时出现；面板打开期间 200ms 淡出（`body[data-sheet=open]`）；
 * · 收藏带入提示条：可出发态且未选出发地时显示；
 * · 车辆位置获取失败提示：不阻塞地图与线路走向。
 */
import Icon from "@/components/ui/Icon";
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
  return (
    <>
      {stage !== "search" && (
        <button
          type="button"
          className="nav-searchbar"
          onClick={onOpenSearch}
          aria-label={to ? `已选目的地 ${to.label}，点击修改` : "选择目的地"}
        >
          <Icon name="search" size={20} />
          <span className={`nav-searchbar__text${to ? "" : " nav-searchbar__text--ph"}`}>
            {to ? to.label : "去哪儿？"}
          </span>
          {stage === "panel" && to && (
            <span className="nav-searchbar__tag t-label">
              <Icon name="destination" size={16} />
              已选
            </span>
          )}
        </button>
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
