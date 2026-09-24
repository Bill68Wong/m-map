"use client";
/**
 * 纵向站条（src/components/card/StationStrip.tsx，v1.1.8；★ 2026-09-24 导航追踪态）
 *
 * 用户口径：**一趟一条**（每段载具各一条）· 中间站**默认收起** ·
 * 左侧是线路主题色的纵条 · 中间站之间给出模型预测的行驶时间 ·
 * 转车时：巴士标上一趟终点 + 写换乘站台，然后接下一条；轻轨写明换乘步行时长。
 *
 * ★ 2026-09-24：新增**导航追踪态**（`nav` 非空，由 RouteDetailBody 注入）：
 *   · 导航中**强制展开**逐站（用户要随时看到到哪了；不再给收起键）；
 *   · 已完全驶过的站 → 文字变**辅主题绿**（`--brand-green`，与地图「已驶过路段」同色）；
 *   · 下一站 → 青花蓝加粗；当前停靠站 → 蓝点强调；
 *   · 下车站 → **橙色警示**（提醒级别跃升为「下一站是下车站」时加深 + 轻微脉动）；
 *   · 「最后一个已过站」之后插入 **「您在这里」** 指示行（实时位置）。
 *
 * ★ 修复包 v2.2.1（B1 / 合规收口）：**推算值的「独立标示」= 弱化样式**（`.rc-val--est`，灰字），
 *   不出现任何文字标记（已按最终口径去掉「估算」字样，但保留"可区分"这一合规要求）。
 * ★ B1 同时把乘车分钟统一 `Math.round` 取整。
 */
import { useState } from "react";
import RouteStack from "@/components/RouteStack";
import Icon from "@/components/ui/Icon";
import type { SegmentStrip } from "@/lib/recommend/types";

/** ★ 2026-09-24：导航追踪态（null = 静态展示） */
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

export default function StationStrip({
  strip,
  color,
  last,
  nav = null,
}: {
  strip: SegmentStrip;
  /** 该线路主题色 */
  color?: string | null;
  /** 是否为行程最后一段（决定换乘行是否渲染） */
  last?: boolean;
  /** ★ 导航追踪态（仅当前乘车段传入） */
  nav?: StripNav | null;
}) {
  const [openManual, setOpenManual] = useState(false);
  /** 导航中强制展开（逐站可见）；静态时沿用「手动展开」状态 */
  const open = openManual || !!nav;
  const rail = color ?? "var(--primary)";
  const lastK = strip.stops.length - 1;
  const mids = strip.stops.filter((s) => s.role === "mid").length;
  const board = strip.stops[0];
  const alight = strip.stops[strip.stops.length - 1];
  /** 本段是否含「无实测样本」的推算跳 → 乘车时长整体走弱化样式（独立标示，无文字） */
  const est = strip.stops.some((s) => s.role === "mid" && s.level >= 3);

  /** 追踪态 class（附在各个站节点上）——下车站**全程**有专属色（提醒前=橙、到站=红脉动） */
  const stateCls = (k: number): string => {
    if (!nav) return "";
    if (k === lastK) return nav.alarm === "now" ? " rc-strip__node--alight-now" : " rc-strip__node--alight";
    if (nav.atIdx !== null && k === nav.atIdx) return " rc-strip__node--at";
    if (k <= nav.passedIdx) return " rc-strip__node--passed";
    if (nav.nextIdx !== null && k === nav.nextIdx) return " rc-strip__node--next";
    return "";
  };
  /** 「您在这里」锚点 = 最后一个已过站（一站未过时挂在首站之后） */
  const youAnchor = nav ? (nav.passedIdx >= 0 ? nav.passedIdx : 0) : -1;
  const youNode = (
    <div className="rc-strip__you" aria-label="您当前所在位置">
      <span className="rc-strip__you-dot" aria-hidden="true" />
      <span className="rc-strip__you-text">您在这里</span>
    </div>
  );

  return (
    <div className="rc-strip" style={{ ["--strip-color" as string]: rail }}>
      <span className="rc-strip__rail" aria-hidden="true" />

      {/* 上车站（默认显示） */}
      {board && (
        <>
          <div className={`rc-strip__node rc-strip__node--end${stateCls(0)}`}>
            <span className="rc-strip__dot" aria-hidden="true" />
            <span className="rc-strip__label">
              {/* ★ 【4】全站统一：站条段头也改用 `.route-stack`（RouteStack 单块不斜切），
                  不再用 `.rc-route--inline` 胶囊。 */}
              <RouteStack codes={[strip.route]} colorOf={() => rail} />
              <b>{board.label}</b>
              <span className="rc-sub">上车</span>
            </span>
          </div>
          {nav && youAnchor === 0 && youNode}
        </>
      )}

      {/* 中间站：默认收起成一行可点的说明（导航中强制展开、无收起键） */}
      {mids > 0 && !open && (
        <button className="rc-strip__toggle" onClick={() => setOpenManual(true)} aria-expanded={false}>
          途经 <b>{mids}</b> 站 · 车上约{" "}
          {/* ★ B5.2：规约见 `types.ts:416` —— LRT 段豁免取整（有 rideSecText 用「1分40秒」） */}
          <b className={est ? "rc-val--est" : undefined}>
            {strip.kind === "lrt" && strip.rideSecText ? strip.rideSecText : `${Math.round(strip.rideMin)} 分`}
          </b>
          <span className="rc-strip__caret">
            <Icon name="caretDown" size={16} />
          </span>
        </button>
      )}

      {/* 中间站：展开后逐站 + 逐跳分钟 */}
      {mids > 0 &&
        open &&
        strip.stops.map((s, k) =>
          s.role !== "mid" ? null : (
            <div key={`${s.code}-${k}`}>
              <div className={`rc-strip__node${stateCls(k)}`}>
                <span className="rc-strip__dot" aria-hidden="true" />
                <span className="rc-strip__label">{s.label}</span>
                <span className={`rc-strip__hop${s.level >= 3 ? " rc-val--est" : ""}`}>
                  {Math.round(s.minToNext)} 分
                </span>
              </div>
              {nav && youAnchor === k && youNode}
            </div>
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

      {/* 下车站（默认显示） */}
      {alight && (
        <>
          <div className={`rc-strip__node rc-strip__node--end${stateCls(lastK)}`}>
            <span className="rc-strip__dot rc-strip__dot--end" aria-hidden="true" />
            <span className="rc-strip__label">
              <b>{alight.label}</b>
              <span className="rc-sub">
                下车 · 车上约{" "}
                <span className={est ? "rc-val--est" : undefined}>
                  {strip.kind === "lrt" && strip.rideSecText ? strip.rideSecText : `${Math.round(strip.rideMin)} 分`}
                </span>
              </span>
            </span>
          </div>
          {nav && youAnchor === lastK && youNode}
        </>
      )}

      {/* 转车：巴士标上一趟终点 + 换乘站台；轻轨写明换乘步行时长 */}
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
