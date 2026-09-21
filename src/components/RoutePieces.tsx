/**
 * 共享展示原语（src/components/RoutePieces.tsx，v1.1.8）
 *
 * 从 `RecommendCard.tsx` 抽出的三件套 —— 详情页要用同一套东西，
 * 不抽就只能复制粘贴（两份会漂移）。
 *
 * ⚠️ 本文件**不写 `"use client"`**：三个都是纯展示（无 hooks、无事件），
 *    server component 与 client component 都能直接 import。
 */
import Icon from "@/components/ui/Icon";
import type { CatchTier } from "@/lib/recommend/types";

/** 澳门时刻 HH:MM（与服务端 hhmm 同口径：+8h 后取当日余秒） */
export function macauClock(ms: number): string {
  const d = new Date(ms + 8 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 赶车分档徽章：5 档配色。
 * ★ v1.0.6：**不再有「本班赶不上，等下一班」这一档** —— 首段赶不上的路线已被整条剔除
 *   （见 `model.ts#modelOption`）。这里只可能在 5 档之间取值，兜底返回 null。
 *
 * ★ v1.1.8：签名由「收整个 card」改为「收 tier/tierText」——
 *   详情页的「后续班车」也要画徽章，收 card 无法复用。
 */
export function TierBadge({ tier, tierText }: { tier: CatchTier | null; tierText: string }) {
  if (tier === null || !tierText) return null;
  return <span className={`rc-tier rc-tier--${tier}`}>{tierText}</span>;
}

/**
 * 报站文案高亮（修复包 v2.2.1 · 第 4 条）
 *
 * 把「还有 **N** 站」里的站数 N、以及「**即将到站**」用 `<b>` + 青花蓝（`.t-accent`）突出 ——
 * 「还有几站」是通勤决策的关键数字，扫描时应第一眼可见。
 * 其余文案原样透传（轻轨「HH:MM 開出」、巴士第 2 段起「按班次间隔推算」等）。
 *
 * ⚠️ 只高亮「数字 + 站」这一处（不误伤「约 4~6 分」里的数字）。
 */
export function EtaText({ text }: { text: string }) {
  const parts = text.split(/(\d+(?=\s*站)|即将到站)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\d+$/.test(p) || p === "即将到站" ? (
          <b className="t-accent" key={i}>
            {p}
          </b>
        ) : (
          p
        ),
      )}
    </>
  );
}

/** 时间线一行：圆点 + 竖线 + 内容
 *
 * ★ v2.4.1：新增 `"sub"` 形态 —— **附属行**（无图标、内容缩进到与主行文字左对齐）。
 *   用途：用户新卡片规范里「还有 N 站 · 约多少时间」是**上一行（上车站）的附属信息**，
 *   不是独立节点 ⇒ 不该再给一个巴士站图标（那会看起来像"又到了一次站"）。
 */
export function Row({
  dot,
  main,
  aside,
  last,
}: {
  dot: "walk" | "wait" | "ride" | "transfer" | "sub";
  main: React.ReactNode;
  aside?: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div className={`rc-row rc-row--${dot}${last ? " rc-row--last" : ""}`}>
      <span className={`rc-dot rc-dot--${dot}`} aria-hidden="true">
        {dot === "walk" ? (
          <Icon name="walk" size={16} />
        ) : dot === "wait" ? (
          <Icon name="busStop" size={16} />
        ) : dot === "transfer" ? (
          <Icon name="expandVertical" size={16} />
        ) : null /* ride / sub：无图标 */}
      </span>
      <span className="rc-text">{main}</span>
      {aside}
    </div>
  );
}
