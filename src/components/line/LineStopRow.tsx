"use client";

/**
 * 站序单行（src/components/line/LineStopRow.tsx，v3.6.0 · S6）
 *
 * ── 结构（设计 §2.8）────────────────────────────────────────────────────
 *   .lp-stop
 *     ├ .lp-stop__rail  线路色竖线 3px（首站从圆点起、末站到圆点止）
 *     ├ .lp-stop__dot   9px 空心圆（线路色描边）／首末站 11px 实心
 *     ├ .lp-stop__body
 *     │   ├ .lp-stop__name  站名（繁体原文，**不做简繁转换**）
 *     │   └ .lp-stop__xfer  「换乘 3 路、25 路」（可选，最多 3 条）
 *     └ .lp-stop__eta   报站三态，固定 16px 高（**不画骨架**，列表零跳动）
 *
 * ── `data-eta` 是本行的断言抓手（AC-42a / AC-46）────────────────────────
 *   `idle` = 还没加载（空白但占位）· `on` = 有车 · `none` = 无车 / 轻轨。
 *   ⚠️ 即使 CSS 把报站列隐藏（轻轨场景），**属性也必须照常输出到 DOM** ——
 *      渲染层断言抓属性，不抓可见性。禁止用「不渲染这个 span」来实现隐藏。
 *
 * ── `data-kind` 挂在 `.lp-page`（容器上），本行不重复 ──────────────────────
 */
import type { EtaState } from "./useLazyEta";
import type { LineStop } from "@/lib/line/line-shared";

export interface LineStopRowProps {
  stop: LineStop;
  /** 站序下标（0 基）—— 用于判首末站 */
  index: number;
  total: number;
  /** 线路主题色（竖线 / 圆点描边） */
  color: string;
  /** 报站三态 */
  eta: EtaState;
  /** 换乘线路（已去掉本线，最多 3 条） */
  xfer: string[];
  /** 登记 DOM（IntersectionObserver 需要） */
  registerEl: (code: string, el: HTMLElement | null) => void;
}

export default function LineStopRow({
  stop,
  index,
  total,
  color,
  eta,
  xfer,
  registerEl,
}: LineStopRowProps) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const isEnd = isFirst || isLast;

  return (
    <li
      ref={(el) => registerEl(stop.code, el)}
      data-stop-code={stop.code}
      data-eta={eta.phase}
      data-stop-end={isEnd ? "1" : undefined}
      className="lp-stop"
      style={{ ["--lp-color" as string]: color }}
    >
      <span className="lp-stop__rail" data-edge={isFirst ? "start" : isLast ? "end" : undefined} aria-hidden="true" />
      <span className="lp-stop__dot" data-end={isEnd ? "1" : undefined} aria-hidden="true" />
      <span className="lp-stop__body">
        <span className="lp-stop__name">{stop.name}</span>
        {xfer.length > 0 && (
          <span className="lp-stop__xfer">换乘 {xfer.join("、")}</span>
        )}
      </span>
      {/* 三态同高 16px：idle 留空（不放骨架/省略号），出现与替换时列表不跳动 */}
      <span className="lp-stop__eta">
        {eta.phase === "on" ? eta.text : eta.phase === "none" ? "—" : null}
      </span>
    </li>
  );
}
