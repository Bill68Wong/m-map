"use client";

/**
 * 下车提醒横幅（src/components/nav/AlightBanner.tsx，2026-09-25 · v2.14 · 06 §2.4 / AC-11）
 *
 * ── 口径（用户 2026-09-25 二轮拍板）────────────────────────────────────
 *   · 横幅本体 = **警告色系**（soon=--warn-soft/warn；now=--danger-soft/danger + 脉动）；
 *   · **绿只标记「下车站名（编号+站名）」**（--track-alight）；
 *   · 提醒通道 = 横幅 + 震动（**禁声音**；震动由 `useRideTracking` 触发）；
 *   · `role="alert"`（无障碍）。
 */
import Icon from "@/components/ui/Icon";

export default function AlightBanner({
  alarm,
  destLabel,
}: {
  /** soon = 下一站就是下车站；now = 已到站 */
  alarm: "soon" | "now";
  /** 下车站显示名 */
  destLabel: string;
}) {
  const now = alarm === "now";
  return (
    <div className={`nav-alarm${now ? " is-now" : ""}`} role="alert">
      <span className="nav-alarm__icon" aria-hidden="true">
        <Icon name="info-circle" size={20} />
      </span>
      {now ? "到站了：" : "下一站就是下车站："}
      <span className="nav-alarm__dest">{destLabel}</span>
      {now ? " · 请下车" : " · 准备下车"}
      <span className="nav-alarm__hint">横幅 + 震动</span>
    </div>
  );
}
