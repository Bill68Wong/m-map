"use client";
/**
 * 纵向站条（src/components/card/StationStrip.tsx，v1.1.8）
 *
 * 用户口径：**一趟一条**（每段载具各一条）· 中间站**默认收起** ·
 * 左侧是线路主题色的纵条 · 中间站之间给出模型预测的行驶时间 ·
 * 转车时：巴士标上一趟终点 + 写换乘站台，然后接下一条；轻轨写明换乘步行时长。
 *
 * ★ 修复包 v2.2.1（B1 / 合规收口）：**推算值的「独立标示」= 弱化样式**（`.rc-val--est`，灰字），
 *   不出现任何文字标记（已按最终口径去掉「估算」字样，但保留"可区分"这一合规要求）。
 * ★ B1 同时把乘车分钟统一 `Math.round` 取整。
 */
import { useState } from "react";
import RouteStack from "@/components/RouteStack";
import Icon from "@/components/ui/Icon";
import type { SegmentStrip } from "@/lib/recommend/types";

export default function StationStrip({
  strip,
  color,
  last,
}: {
  strip: SegmentStrip;
  /** 该线路主题色 */
  color?: string | null;
  /** 是否为行程最后一段（决定换乘行是否渲染） */
  last?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rail = color ?? "var(--primary)";
  const mids = strip.stops.filter((s) => s.role === "mid").length;
  const board = strip.stops[0];
  const alight = strip.stops[strip.stops.length - 1];
  /** 本段是否含「无实测样本」的推算跳 → 乘车时长整体走弱化样式（独立标示，无文字） */
  const est = strip.stops.some((s) => s.role === "mid" && s.level >= 3);

  return (
    <div className="rc-strip" style={{ ["--strip-color" as string]: rail }}>
      <span className="rc-strip__rail" aria-hidden="true" />

      {/* 上车站（默认显示） */}
      {board && (
        <div className="rc-strip__node rc-strip__node--end">
          <span className="rc-strip__dot" aria-hidden="true" />
          <span className="rc-strip__label">
            {/* ★ 【4】全站统一：站条段头也改用 `.route-stack`（RouteStack 单块不斜切），
                不再用 `.rc-route--inline` 胶囊。 */}
            <RouteStack codes={[strip.route]} colorOf={() => rail} />
            <b>{board.label}</b>
            <span className="rc-sub">上车</span>
          </span>
        </div>
      )}

      {/* 中间站：默认收起成一行可点的说明 */}
      {mids > 0 && !open && (
        <button className="rc-strip__toggle" onClick={() => setOpen(true)} aria-expanded={false}>
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
        strip.stops
          .filter((s) => s.role === "mid")
          .map((s) => (
            <div className="rc-strip__node" key={`${s.code}-${s.minToNext}`}>
              <span className="rc-strip__dot" aria-hidden="true" />
              <span className="rc-strip__label">{s.label}</span>
              <span className={`rc-strip__hop${s.level >= 3 ? " rc-val--est" : ""}`}>
                {Math.round(s.minToNext)} 分
              </span>
            </div>
          ))}

      {mids > 0 && open && (
        <button className="rc-strip__toggle rc-strip__toggle--collapse" onClick={() => setOpen(false)}>
          收起中间站{" "}
          <span className="rc-strip__caret">
            <Icon name="caretUp" size={16} />
          </span>
        </button>
      )}

      {/* 下车站（默认显示） */}
      {alight && (
        <div className="rc-strip__node rc-strip__node--end">
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
