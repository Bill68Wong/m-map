"use client";

/**
 * 导航界面主体（src/components/nav/NavDetailBody.tsx，2026-09-25 · v2.14）
 *
 * 取代 `RouteDetailBody`（Spec §7）；由 `RouteDetailPane` 渲染，两个消费方共用：
 *   · 主页链（`RouteSheet` → detail pane，注入 `track`）；
 *   · 收藏薄壳（`RouteDetailSheet`，`track=null` ⇒ 静态详情，行为同 v2.13）。
 *
 * 结构（自上而下）：下车横幅 → 自动上车 toast → 头部 → 步行/等车行 → 进度纵条（NavStrip）
 *   → 下车步行行 → 折叠区（StationReachFold）→ 来源脚注 → 吸底操作条（NavTrackBar）。
 */
import { useEffect, useState } from "react";
import NavStrip from "./NavStrip";
import AlightBanner from "./AlightBanner";
import NavTrackBar from "./NavTrackBar";
import StationReachFold from "./StationReachFold";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import RouteStack from "@/components/RouteStack";
import { LrtEtaInline } from "@/components/LrtEta";
import { EtaText, Row, TierBadge, macauClock } from "@/components/RoutePieces";
import Icon from "@/components/ui/Icon";
import type { FavoriteEndpoint, PlanSnapshot, RouteSeg } from "@/lib/favorites/types";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { RideTrackView } from "./useRideTracking";

export interface NavDetailBodyProps {
  card: RecommendCard;
  /** 逐段站条（服务端 `buildStrips` 产物） */
  strips: SegmentStrip[];
  /** 第一程上车站台「其他线路」 */
  otherRoutes: string[];
  /** 其他线路实时报站文案（route → 文案） */
  foldLive: Record<string, string>;
  /** 折叠栏站台显示名（null 时不渲染折叠栏） */
  stationLabel: string | null;
  /** 线路码 → 主题色 */
  colors: Record<string, string>;
  /** 目的地展示名 */
  destLabel: string;
  /** 收藏入口数据 */
  fav?: {
    from: FavoriteEndpoint;
    to: FavoriteEndpoint;
    query: string;
    fingerprint: string;
    snapshot: PlanSnapshot;
    route: RouteSeg[];
  } | null;
  /** 「本地推算」徽标 */
  degraded?: boolean;
  /** 导航追踪态（收藏薄壳传 null ⇒ 静态详情） */
  track?: RideTrackView | null;
  /** 目的地坐标（GCJ-02；可切换方案查询用） */
  destCoord?: { lng: number; lat: number } | null;
  /** 点「切换路线」→ 打开新方案导航 */
  onSwitchCard?: (card: RecommendCard, degraded: boolean) => void;
  /** ★ 全屏化（导航中收敛间距） */
  immersive?: boolean;
}

export default function NavDetailBody({
  card,
  strips,
  otherRoutes,
  foldLive,
  stationLabel,
  colors,
  destLabel,
  fav = null,
  degraded = false,
  track = null,
  destCoord = null,
  onSwitchCard,
  immersive = false,
}: NavDetailBodyProps) {
  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];
  const legIdx = track ? track.legIndex : 0;
  const legRide = card.rides[legIdx];
  const trackStops = track && track.phase !== "off" ? (strips[legIdx]?.stops ?? []) : [];
  const stopLabel = (k: number | null): string =>
    k !== null && k >= 0 && k < trackStops.length ? trackStops[k].label : "";
  const alightLabel =
    stopLabel(trackStops.length - 1) || legRide?.alightLabel || first?.alightLabel || "";

  /** 自动上车瞬态反馈（2.5s 自动消失；可关闭） */
  const [toastDismissed, setToastDismissed] = useState(false);
  useEffect(() => {
    if (track?.phase === "riding" && track.autoSwitched && track.autoNote) {
      setToastDismissed(false);
      const t = window.setTimeout(() => setToastDismissed(true), 2500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [track?.phase, track?.autoSwitched, track?.autoNote]);
  const showToast = !!track && track.phase === "riding" && track.autoSwitched && !!track.autoNote && !toastDismissed;

  /** 新鲜度（AC-24）：每秒重算「上次更新：N 秒前」 */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (track?.phase !== "riding") return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [track?.phase]);
  const freshSec =
    track && track.lastUpdateTs > 0 ? Math.max(0, Math.floor((nowMs - track.lastUpdateTs) / 1000)) : null;

  const lrt = legRide?.kind === "lrt";
  const routeLabel = legRide ? (lrt ? `轻轨 ${legRide.route.replace(/^LRT-/, "")}` : `${legRide.route} 路`) : "";

  return (
    <>
      {/* 下车提醒横幅（警告色；绿只标记站名） */}
      {track && track.phase === "riding" && track.alarm !== "none" && (
        <AlightBanner alarm={track.alarm} destLabel={alightLabel} />
      )}

      {/* 自动上车瞬态反馈（非模态，role=status） */}
      {showToast && track && (
        <div className="nav-toast" role="status" style={{ marginTop: "var(--space-3)" }}>
          <span className="nav-toast__icon" aria-hidden="true">
            <Icon name="locate" size={20} />
          </span>
          <span className="nav-toast__text">{track.autoNote}</span>
          <button type="button" className="nav-toast__fix" onClick={track.onNotThisBus}>
            不是这辆
          </button>
          <button
            type="button"
            className="nav-toast__close"
            aria-label="关闭提示"
            onClick={() => setToastDismissed(true)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {/* 头部：总用时 / 到达 / 线路标签 / 收藏 */}
      <div className="card rc-detail__head">
        <div className="rc-head__main">
          <span className="rc-total">{Math.round(card.totalMin)}</span>
          <span className="rc-total__unit">分</span>
        </div>
        <span className="rc-arrive">
          预计 <b>{macauClock(card.arriveAt)}</b> 到达
          {card.crossBorder && <span className="rc-warn"> · 不含通关</span>}
        </span>
        <RouteStack codes={card.rides.map((r) => r.route)} colors={colors} size="sm" />
        {degraded && <span className="nav-degraded nav-degraded--inline t-label">估算</span>}
        {fav && (
          <FavoriteButton
            kind="plan"
            entry="detail"
            from={fav.from}
            to={fav.to}
            query={fav.query}
            fingerprint={fav.fingerprint}
            snapshot={fav.snapshot}
            route={fav.route}
            withLabel
          />
        )}
      </div>

      {/* 步行 → 上车站；首段等车 */}
      <div className="rc-line">
        <Row
          dot="walk"
          main={
            <>
              步行{" "}
              <b className={card.walkOut.estimated ? "rc-val--est" : undefined}>{card.walkOut.minutes}</b> 分
              {" → "}
              {card.walkOut.toLabel}
            </>
          }
        />
        {first && (
          <Row
            dot="wait"
            main={
              first.kind === "lrt" && first.liveDepartures?.length ? (
                <LrtEtaInline
                  lineCode={first.route}
                  departuresMs={first.liveDepartures}
                  clocks={first.liveClocks}
                  state="running"
                  directionName={null}
                />
              ) : (
                <EtaText text={first.liveText || `等 ${first.waitMin} 分`} />
              )
            }
            aside={first.tierText ? <TierBadge tier={first.tier} tierText={first.tierText} /> : null}
          />
        )}
      </div>

      {/* 距下车站还有 N 站（导航中；AC-02 站数刻度） */}
      {track && track.phase === "riding" && track.prog && trackStops.length >= 2 && (
        <div className="nav-note-neutral">
          <span className="navstrip__badge">距离</span>
          距下车站还有 <b>{Math.max(0, trackStops.length - 1 - track.prog.passedIdx)}</b> 站
          {track.prog.nextIdx !== null && <> · 下一站 {stopLabel(track.prog.nextIdx)}</>}
        </div>
      )}

      {/* 进度纵条（一趟一条；导航中仅当前乘车段显示实时进度） */}
      <div className={`rc-strips${immersive ? " rc-strips--immersive" : ""}`}>
        {strips.map((strip, i) => (
          <NavStrip
            key={`${strip.route}-${strip.board}-${i}`}
            strip={strip}
            color={colorOf(strip.route)}
            last={i === strips.length - 1}
            nav={
              track && track.phase === "riding" && track.prog && i === track.legIndex
                ? {
                    passedIdx: track.prog.passedIdx,
                    nextIdx: track.prog.nextIdx,
                    atIdx: track.prog.atIdx,
                    alarm: track.alarm,
                  }
                : null
            }
            frozen={!!track && track.phase === "riding" && !!track.note}
          />
        ))}
      </div>

      {/* 下车步行 → 目的地 */}
      <div className="rc-line">
        <Row
          dot="walk"
          last
          main={
            <>
              步行{" "}
              <b className={card.walkIn.estimated ? "rc-val--est" : undefined}>{card.walkIn.minutes}</b> 分
              {" → "}
              <b>{card.walkIn.toLabel}</b>
              {" → "}
              {destLabel}
            </>
          }
        />
      </div>

      {/* 本站台其他线路（线路为父、方案为子） */}
      {stationLabel && (
        <StationReachFold
          stationLabel={stationLabel}
          items={otherRoutes.map((r) => ({ route: r, live: foldLive[r] ?? "" }))}
          colors={colors}
          switchCtx={
            destCoord ? { card, dest: { lng: destCoord.lng, lat: destCoord.lat, name: destLabel } } : null
          }
          onOpenCard={onSwitchCard ? (c) => onSwitchCard(c, degraded) : undefined}
        />
      )}

      <div className="rc-foot">
        <span className="rc-hint t-muted">数据来源：澳门交通事务局（DSAT）· 高德地图</span>
      </div>

      {/* 吸底操作条（全屏化：导航中隐藏底导由宿主承担） */}
      {track && (
        <NavTrackBar
          phase={track.phase}
          routeLabel={routeLabel}
          boardLabel={legRide?.boardLabel ?? first?.boardLabel ?? ""}
          nextLabel={track.prog?.nextIdx != null ? stopLabel(track.prog.nextIdx) : ""}
          alightLabel={alightLabel}
          plate={track.plate}
          source={track.progressSource === "gps" ? "gps" : track.plate ? "vehicle" : "manual"}
          alarm={track.alarm}
          lrt={lrt}
          traveling={track.traveling}
          anomaly={track.anomaly}
          freshSec={freshSec}
          onStart={track.onStart}
          onBoard={track.onBoard}
          onAlight={track.onAlight}
          onRepick={track.onNotThisBus}
          onRefresh={track.onRefresh}
          onStop={track.onStop}
          onNotBoard={track.onNotBoard}
          onNotArrive={track.onNotArrive}
        />
      )}
    </>
  );
}
