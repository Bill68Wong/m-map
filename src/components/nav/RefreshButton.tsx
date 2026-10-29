"use client";

/**
 * 刷新键（src/components/nav/RefreshButton.tsx，v2.10.0 · ★ v3.6.0 S4 改纯展示）
 *
 * ── 形态（Spec §8）────────────────────────────────────────────────────
 *   44×44 圆 + 1.5px 青花蓝描边 + 3px 硬投影；
 *   **冷却中**：图标淡出到 0.25、中心改显**纯数字秒数**（等宽 13px/500、tabular-nums、
 *   不带单位），外圈 `conic-gradient` 进度环 100%→0，整键降 `--muted` 且撤投影。
 *
 * ── 无障碍 ────────────────────────────────────────────────────────────
 *   · 用 `aria-disabled`（**不用 `disabled`**）—— 保持可聚焦，读屏用户能听到剩余秒数；
 *   · 倒计时**只在冷却开始时播报一次**（`role="status"`），**不逐秒播报**；
 *   · 按钮 `aria-label` 实时反映剩余秒数（聚焦时可见）；
 *   · `prefers-reduced-motion`：进度环按秒跳变、不做补间。
 *
 * ── ★ v3.6.0 S4：本组件**只负责画** ────────────────────────────────────
 *   冷却时长与倒计时一律由 `useCooldown` 提供，经 `cooling` / `seconds` / `total` 传入。
 *   原先在此硬编码 `REFRESH_COOLDOWN_SEC = 10` 会让「组件」与「调度」耦合 ——
 *   不同场景冷却不同（车辆 5s / 推荐 5s / 步行 3s），常量留在这里必然出现两个真相。
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import Icon from "@/components/ui/Icon";

export interface RefreshButtonProps {
  /** 是否处于冷却中 */
  cooling: boolean;
  /** 剩余秒数（整数，冷却中才有意义） */
  seconds: number;
  /** ★ v3.6.0：本轮冷却总时长（秒）—— 用于进度环比例与播报文案；由调用方传（`COOLDOWN_*`） */
  total: number;
  onRefresh: () => void;
}

export default function RefreshButton({ cooling, seconds, total, onRefresh }: RefreshButtonProps) {
  const [announce, setAnnounce] = useState("");
  const prev = useRef(false);

  // 冷却**开始时**播报一次（不逐秒播报）
  useEffect(() => {
    if (cooling && !prev.current) setAnnounce(`${total} 秒后可再次刷新`);
    else if (!cooling) setAnnounce("");
    prev.current = cooling;
  }, [cooling, total]);

  const ringPct = cooling && total > 0 ? Math.max(0, Math.min(100, (seconds / total) * 100)) : 100;

  return (
    <button
      type="button"
      className={`nav-refresh${cooling ? " is-cooling" : ""}`}
      aria-disabled={cooling || undefined}
      aria-label={cooling ? `刷新，${seconds} 秒后可再次刷新` : "刷新车辆位置"}
      title={cooling ? `${seconds} 秒后可再次刷新` : "刷新车辆位置"}
      onClick={() => {
        if (cooling) return;
        onRefresh();
      }}
    >
      <Icon name="refresh" size={20} className="nav-refresh__icon" />
      {cooling && (
        <>
          <span
            className="nav-refresh__ring"
            style={{ "--cd-p": String(ringPct) } as CSSProperties}
            aria-hidden="true"
          />
          <span className="nav-refresh__sec" aria-hidden="true">
            {seconds}
          </span>
        </>
      )}
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </button>
  );
}
