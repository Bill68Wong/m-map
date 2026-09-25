"use client";

/**
 * 进度纵条（src/components/nav/NavStrip.tsx，2026-09-25 · v2.14 · 06 §2.2 / 07 §4.2）
 *
 * ── 与卡片页旧 `StationStrip` 的边界 ────────────────────────────────────
 *   卡片页继续用 `@/components/card/StationStrip`（保持不动）；**导航侧**改用本组件：
 *   · 导航中**强制展开**（逐站可见，无收起键）；静态（`nav=null`）保留折叠键；
 *   · **四态新口径**（AC-07，不只靠颜色）：
 *       已过 = 灰 + 行末对勾；当前停靠 = 蓝加粗 + 「停靠中」；
 *       下一站 = 蓝加粗 + 「下一站」胶囊；下车站 = **站名品牌绿**（圆点仍线路色）+「下车」；
 *       到站 = 砖红加粗 + 脉动；
 *   · **「您在这里」 = 骑线节点**（纵条不断线）：锚点 `atIdx` 优先 → `passedIdx` → 首站前。
 *
 * ── 排版纪律（06 §4.5）────────────────────────────────────────────────
 *   同一信息不折行（nowrap）、禁省略号截断。
 */
import { Fragment, useState } from "react";
import RouteStack from "@/components/RouteStack";
import Icon from "@/components/ui/Icon";
import type { SegmentStrip } from "@/lib/recommend/types";

/** 导航追踪态（null = 静态展示） */
export interface StripNav {
  /** 已**完全驶过**的最后一站下标（-1 = 一站未过） */
  passedIdx: number;
  /** 下一站下标（null = 未知） */
  nextIdx: number | null;
  /** 当前停靠站下标（null = 行驶中或未知） */
  atIdx: number | null;
  /** 下车提醒级别：none / soon（下一站是下车站）/ now（已到下车站） */
  alarm: "none" | "soon" | "now";
}

export default function NavStrip({
  strip,
  color,
  last,
  nav = null,
  frozen = false,
}: {
  strip: SegmentStrip;
  /** 该线路主题色 */
  color?: string | null;
  /** 是否为行程最后一段（决定换乘行是否渲染） */
  last?: boolean;
  /** 导航追踪态（仅当前乘车段传入） */
  nav?: StripNav | null;
  /** 冻结态（丢信号：「位置停在上一站」；标签转 muted、停止脉动） */
  frozen?: boolean;
}) {
  const [openManual, setOpenManual] = useState(false);
  const open = openManual || !!nav;
  const rail = color ?? "var(--accent)";
  const stops = strip.stops;
  const lastK = stops.length - 1;
  const mids = stops.filter((s) => s.role === "mid").length;
  const board = stops[0];
  const alight = stops[stops.length - 1];
  const est = stops.some((s) => s.role === "mid" && s.level >= 3);

  /** 追踪态 class（附在各站节点上） */
  const stateCls = (k: number): string => {
    if (!nav) return "";
    if (k === lastK) return nav.alarm === "now" ? " is-alight-now" : " is-alight";
    if (nav.atIdx !== null && k === nav.atIdx) return " is-at";
    if (k <= nav.passedIdx) return " is-passed";
    if (nav.nextIdx !== null && k === nav.nextIdx) return " is-next";
    return "";
  };

  /** 「您在这里」锚点：atIdx 优先 → passedIdx → 首站前（-1） */
  const youAnchor = nav ? (nav.atIdx !== null ? nav.atIdx : nav.passedIdx >= 0 ? nav.passedIdx : -1) : -2;

  const row = (k: number, end: boolean) => {
    const s = stops[k];
    const cls = `navstrip__row${end ? " is-end" : ""}${stateCls(k)}`;
    const segPassed = !!nav && k <= nav.passedIdx;
    const isAt = !!nav && nav.atIdx !== null && k === nav.atIdx;
    const isAlightNow = !!nav && k === lastK && nav.alarm === "now";
    const isAlight = !!nav && k === lastK && nav.alarm !== "now";
    const isNext = !!nav && nav.nextIdx !== null && k === nav.nextIdx && k !== lastK;
    const passed = !!nav && k <= nav.passedIdx && !isAt && !isAlight && !isAlightNow;
    return (
      <div className={cls} key={`s-${k}`}>
        <span className={`navstrip__seg${segPassed ? " is-passed" : ""}`} />
        <span className="navstrip__dot" />
        <span className="navstrip__label">
          {k === 0 && <RouteStack codes={[strip.route]} colorOf={() => rail} />}
          {isNext && <span className="navstrip__badge">下一站</span>}
          {k === lastK ? <b>{s.label}</b> : s.label}
          {isAt && <span className="navstrip__sub">停靠中</span>}
          {k === lastK && isAlightNow && <span className="navstrip__sub">到站</span>}
          {k === lastK && isAlight && <span className="navstrip__sub">下车</span>}
          {!end && s.minToNext > 0 && !nav && (
            <span className={`navstrip__hop${s.level >= 3 ? " rc-val--est" : ""}`}>
              {Math.round(s.minToNext)} 分
            </span>
          )}
        </span>
        {passed && (
          <span className="navstrip__check" aria-hidden="true">
            <Icon name="check" size={16} />
          </span>
        )}
      </div>
    );
  };

  const youNode = (
    <div className="navstrip__row is-you" key="you">
      <span className="navstrip__seg is-passed" />
      <span className="navstrip__dot" />
      <span className="navstrip__label">
        您在这里
        {frozen && <span className="navstrip__pause"> · 位置停在上一站</span>}
      </span>
    </div>
  );

  return (
    <div className="navstrip" style={{ ["--strip-color" as string]: rail }}>
      {/* 上车站之前挂「您在这里」（车尚未到上车站） */}
      {nav && youAnchor === -1 && youNode}
      {board && row(0, true)}
      {nav && youAnchor === 0 && youNode}

      {/* 中间站：静态时默认收起；导航中强制展开 */}
      {mids > 0 && !open && (
        <button className="rc-strip__toggle" onClick={() => setOpenManual(true)} aria-expanded={false}>
          途经 <b>{mids}</b> 站 · 车上约{" "}
          <b className={est ? "rc-val--est" : undefined}>
            {strip.kind === "lrt" && strip.rideSecText ? strip.rideSecText : `${Math.round(strip.rideMin)} 分`}
          </b>
          <span className="rc-strip__caret">
            <Icon name="caretDown" size={16} />
          </span>
        </button>
      )}

      {mids > 0 &&
        open &&
        stops.map((s, k) =>
          s.role !== "mid" ? null : (
            <Fragment key={`m-${s.code}-${k}`}>
              {row(k, false)}
              {nav && youAnchor === k && youNode}
            </Fragment>
          ),
        )}

      {mids > 0 && open && !nav && (
        <button className="rc-strip__toggle rc-strip__toggle--collapse" onClick={() => setOpenManual(false)}>
          收起中间站{" "}
          <span className="rc-strip__caret">
            <Icon name="caretUp" size={16} />
          </span>
        </button>
      )}

      {alight && row(lastK, true)}
      {nav && youAnchor === lastK && youNode}

      {!last && strip.transferAfter && (
        <div className="rc-strip__transfer">
          <Icon name="expandVertical" size={16} />
          {strip.transferAfter.sameField ? (
            <>同站台换乘 · 无需步行</>
          ) : (
            <>
              换乘步行{" "}
              <b className={strip.transferAfter.estimated ? "rc-val--est" : undefined}>
                {strip.transferAfter.minutes}
              </b>{" "}
              分
            </>
          )}
          <span className="rc-sub">（{strip.transferAfter.atLabel}）</span>
        </div>
      )}
    </div>
  );
}
