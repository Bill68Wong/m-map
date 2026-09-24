/**
 * 路线详情「主体」（src/components/nav/RouteDetailBody.tsx，2026-09-23 新增）
 *
 * 从 `/nav/detail` 页面抽出 —— 详情体现在有**两个消费方**：
 *   · `/nav/detail` 页面（SSR；直链 / 刷新场景）
 *   · `RouteDetailSheet`（全屏详情弹窗；主页「出发」与收藏页点卡入口）
 *   ⇒ 同一份渲染逻辑，避免两处漂移。
 *
 * ⚠️ 本文件**不写 "use client"**：纯展示（无 hooks / 无请求 / 无 pg）——
 *   server component（页面）与 client component（弹窗）都能直接 import；
 *   数据（card / strips / 折叠栏 / 收藏数据）一律由调用方算好传入。
 *
 * 口径（与 v1.3.0 详情页一致，勿改）：
 *   · 上车站取首段、下车站取**末段**；纵向站条一趟一条；
 *   · 轻轨首段倒计时由 `LrtEtaInline` 客户端每秒重算；巴士用服务端下发文案；
 *   · 「本站台其他线路」折叠栏含实时报站（服务端算好传入）；
 *   · 站名/线路名用**繁体**，界面文案用**简体**。
 */
import StationStrip from "@/components/card/StationStrip";
import StationReachFold from "@/components/nav/StationReachFold";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import RouteStack from "@/components/RouteStack";
import { LrtEtaInline } from "@/components/LrtEta";
import { EtaText, Row, TierBadge, macauClock } from "@/components/RoutePieces";
import type { FavoriteEndpoint, PlanSnapshot, RouteSeg } from "@/lib/favorites/types";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { RideTrackView } from "./useRideTracking";

export interface RouteDetailBodyProps {
  card: RecommendCard;
  /** 逐段站条（服务端 `buildStrips` 产物） */
  strips: SegmentStrip[];
  /** 第一程上车站台「其他线路」（可为空数组 → 不渲染折叠栏） */
  otherRoutes: string[];
  /** 其他线路实时报站文案（route → 文案；缺省空串） */
  foldLive: Record<string, string>;
  /** 折叠栏站台显示名（第一程上车站 `boardLabel`；为 null 时不渲染折叠栏） */
  stationLabel: string | null;
  /** 线路码 → 主题色 */
  colors: Record<string, string>;
  /** 目的地展示名（末段步行终点文案） */
  destLabel: string;
  /** 收藏入口数据（主页 / 收藏场景传入；缺省不渲染收藏按钮） */
  fav?: {
    from: FavoriteEndpoint;
    to: FavoriteEndpoint;
    query: string;
    fingerprint: string;
    snapshot: PlanSnapshot;
    route: RouteSeg[];
  } | null;
  /** 「本地推算」徽标（planNav 降级时为 true；缺省不显示） */
  degraded?: boolean;
  /** ★ 2026-09-24：导航追踪态（主页详情链注入；缺省 = 静态详情） */
  track?: RideTrackView | null;
  /** ★ 2026-09-24：目的地坐标（GCJ-02；可切换方案查询用） */
  destCoord?: { lng: number; lat: number } | null;
  /** ★ 2026-09-24：点「切过去」→ 打开新方案导航（主页链注入） */
  onSwitchCard?: (card: RecommendCard, degraded: boolean) => void;
}

export default function RouteDetailBody({
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
}: RouteDetailBodyProps) {
  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];
  /** ★ 2026-09-24：当前乘车段的站条（导航追踪文案用：站数 / 下一站名） */
  const trackStops = track && track.phase !== "off" ? (strips[track.legIndex]?.stops ?? []) : [];
  const trackStopLabel = (k: number | null): string =>
    k !== null && k >= 0 && k < trackStops.length ? trackStops[k].label : "";

  return (
    <>
      <div className="card rc-detail__head">
        <div className="rc-head__main">
          <span className="rc-total">{Math.round(card.totalMin)}</span>
          <span className="rc-total__unit">分</span>
        </div>
        <span className="rc-arrive">
          预计 <b>{macauClock(card.arriveAt)}</b> 到达
          {card.crossBorder && <span className="rc-warn"> · 不含通关</span>}
        </span>
        {/* ⚠️ Server Component：**只能传可序列化的 `colors`**，不能传 `colorOf` 函数（RSC 边界） */}
        <RouteStack codes={card.rides.map((r) => r.route)} colors={colors} size="sm" />
        {degraded && <span className="nav-degraded nav-degraded--inline t-label">估算</span>}
        {/* ★ 收藏入口 ②（方案）：详情头部 */}
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

      {/* ★ 2026-09-24：导航追踪条 —— 开始导航 / 等待上车 / 乘车进度 / 下车提醒（横幅+震动） */}
      {track && (
        <div className="nav-track" data-nav-phase={track.phase}>
          {track.alarm !== "none" && (
            <div className={`nav-track__alarm${track.alarm === "now" ? " is-now" : ""}`} role="alert">
              {track.alarm === "now"
                ? `到站了：${trackStopLabel(track.prog?.atIdx ?? null) || first?.alightLabel || ""}，请下车`
                : `下一站：${trackStopLabel(track.prog?.nextIdx ?? null) || first?.alightLabel || ""}，准备下车`}
            </div>
          )}

          {track.phase === "off" && (
            <div className="nav-track__row">
              <button type="button" className="btn btn--primary btn--sm" onClick={track.onStart}>
                开始导航
              </button>
              <span className="nav-track__hint t-label">上车后点「我已上车」，全程自动报站</span>
            </div>
          )}

          {track.phase === "boarding" && (
            <>
              <div className="nav-track__row">
                <span className="nav-track__state t-label">
                  等待上车 · <b>{first?.boardLabel ?? ""}</b>
                </span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  onClick={track.onBoard}
                  disabled={track.traveling}
                >
                  我已上车
                </button>
                <button type="button" className="btn btn--text btn--sm" onClick={track.onStop}>
                  结束
                </button>
              </div>
              {track.note && <p className="nav-track__note t-label">{track.note}</p>}
            </>
          )}

          {track.phase === "riding" && (
            <>
              <div className="nav-track__row">
                <span className="nav-track__state t-label">
                  乘车中
                  {track.plate && (
                    <>
                      {" "}
                      · <b>{track.plate}</b>
                    </>
                  )}
                </span>
                <button
                  type="button"
                  className="btn btn--text btn--sm"
                  onClick={track.onRefresh}
                  disabled={track.traveling}
                >
                  {track.traveling ? "刷新中…" : "刷新"}
                </button>
                <button type="button" className="btn btn--outline btn--sm" onClick={track.onAlight}>
                  我已下车
                </button>
              </div>
              <p className="nav-track__note t-label">
                {track.prog
                  ? `已过 ${Math.max(0, Math.min(Math.max(0, trackStops.length - 1), track.prog.passedIdx + 1))}/${Math.max(0, trackStops.length - 1)} 站${
                      track.prog.nextIdx !== null ? ` · 下一站 ${trackStopLabel(track.prog.nextIdx)}` : ""
                    }`
                  : "已上车（该程暂无自动进度，可对照站名）"}
                {track.note ? ` · ${track.note}` : ""}
              </p>
              {track.candidates.length > 1 && (
                <div className="nav-track__pick">
                  <span className="t-label t-muted">不是这辆？</span>
                  {track.candidates.slice(0, 4).map((c) => (
                    <button
                      key={c.plate}
                      type="button"
                      className="nav-track__chip"
                      onClick={() => track.onRepick(c.plate)}
                    >
                      {c.plate}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {track.phase === "done" && (
            <div className="nav-track__row">
              <span className="nav-track__state t-label">
                <b>已到达目的地</b>
              </span>
              <button type="button" className="btn btn--outline btn--sm" onClick={track.onStop}>
                结束导航
              </button>
            </div>
          )}
        </div>
      )}

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
              /* ★ 【5】与卡片口径一致：轻轨首段的倒计时由客户端每秒重算（`LrtEtaInline`）；
                 巴士用服务端下发的报站文案（「还有 N 站 · 约 X~Y 分」= 距站信息 + 时间）。 */
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

      {/* 纵向站条：一趟一条（★【2a】范围 = 上车站 → 下车站） */}
      <div className="rc-strips">
        {strips.map((strip, i) => (
          <StationStrip
            key={`${strip.route}-${strip.board}-${i}`}
            strip={strip}
            color={colorOf(strip.route)}
            last={i === strips.length - 1}
            /* ★ 2026-09-24：导航中仅当前乘车段显示实时进度标记（已过站/下一站/您在这里） */
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
          />
        ))}
      </div>

      <div className="rc-line">
        <Row
          dot="walk"
          last
          main={
            /* ★ 【3】下车步行引导：**下车站编号 站名 → 目的地**。
               `card.walkIn.toLabel` = 下车站带名标签；`destLabel` = 目的地名。 */
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

      {/* ★ T05：本站台其他线路（折叠栏：可切换方案置顶 + 实时报站；2026-09-24 重构） */}
      {stationLabel && (
        <StationReachFold
          stationLabel={stationLabel}
          items={otherRoutes.map((r) => ({ route: r, live: foldLive[r] ?? "" }))}
          colors={colors}
          switchCtx={
            destCoord
              ? { card, dest: { lng: destCoord.lng, lat: destCoord.lat, name: destLabel } }
              : null
          }
          onOpenCard={onSwitchCard ? (c) => onSwitchCard(c, degraded) : undefined}
        />
      )}

      <div className="rc-foot">
        <span className="rc-hint t-muted">数据来源：澳门交通事务局（DSAT）· 高德地图</span>
      </div>
    </>
  );
}
