"use client";

/**
 * 下车提醒横幅（src/components/nav/AlightBanner.tsx，2026-09-25 · v2.14；★ 2026-09-26 修订）
 *
 * ── 口径（用户 2026-09-25 二轮拍板 + 2026-09-26 单行式定稿）──────────────
 *   · **单行式**：`准备下车 · {站号} {站名}` / `请下车 · {站号} {站名}`（站号+站名原样保留，不截断）；
 *   · 横幅本体 = **警告色系**（soon=`--warn-soft`/`--warn`；now=`--danger-soft`/`--danger` + 脉动）；
 *   · **绿只标记「下车站名」**（`--track-alight`）；
 *   · **删除**「横幅 + 震动」开发期说明（`.nav-alarm__hint`，不得出现在用户界面）；
 *   · 浮层化由父层 `NavAlarmOverlay` 承担（本组件只管内容）；`role="alert"` + 完整句 `aria-label`。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   全 Token 上色；无 emoji；`white-space: nowrap`（长度受控 + 站名 ellipsis 兜底）。
 */
import Icon from "@/components/ui/Icon";

export default function AlightBanner({
  alarm,
  destLabel,
}: {
  /** soon = 下一站就是下车站；now = 已到站 */
  alarm: "soon" | "now";
  /** 下车站显示名（站号 + 站名） */
  destLabel: string;
}) {
  const now = alarm === "now";
  return (
    <div
      className={`nav-alarm${now ? " is-now" : ""}`}
      role="alert"
      aria-label={now ? `已到下车站 ${destLabel}，请下车` : `下一站是下车站 ${destLabel}，请准备下车`}
    >
      <span className="nav-alarm__icon" aria-hidden="true">
        <Icon name="info-circle" size={20} />
      </span>
      <span className="nav-alarm__lead">{now ? "请下车 ·" : "准备下车 ·"}</span>
      <span className="nav-alarm__dest">{destLabel}</span>
    </div>
  );
}
