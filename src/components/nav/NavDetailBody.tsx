"use client";

/**
 * 导航界面主体（src/components/nav/NavDetailBody.tsx，2026-09-25 · v2.14；★ 2026-09-26 修订）
 *
 * 取代 `RouteDetailBody`（Spec §7）；由 `RouteDetailPane` 渲染，两个消费方共用：
 *   · 主页链（`RouteSheet` → detail pane，注入 `track`）；
 *   · 收藏薄壳（`RouteDetailSheet`，`track=null` ⇒ 静态详情，行为同 v2.13）。
 *
 * ── ★ 2026-09-26 修订（需求③ / AC-32~36）────────────────────────────
 *   · 头部改 `.rc-dhead`（flex：左=总用时+到达，右=`RouteStack` **同行**；**去 `.card` 灰框**、
 *     仅保留下分割线）；**删除「估算」span**；
 *   · 下车横幅 / 自动上车 toast / 自动下车瞬态**迁至浮层**（`NavAlarmOverlay`，
 *     挂 `.route-sheet__pane` 内容层，滚动容器之外 ⇒ 不参与滚动、不推挤内容）；
 *   · 吸底操作条（`NavTrackBar`）**迁至面板根**（`.route-sheet__actions-slot`，见 `RouteSheet`）；
 *   · 换乘行「等车约 N 分」由 `NavStrip` 承担（数据缺 ⇒ 降级文案）。
 *
 * 结构（自上而下）：头部 → 步行/等车行 → 进度纵条（NavStrip）→ 下车步行行
 *   → 折叠区（StationReachFold）→ 来源脚注。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import NavStrip from "./NavStrip";
import StationReachFold from "./StationReachFold";
import RouteStack from "@/components/RouteStack";
import { LrtEtaInline } from "@/components/LrtEta";
import { catchHintOf, directionNameOf, EtaText, Row, TierBadge, macauClock } from "@/components/RoutePieces";
import type { FavoriteEndpoint, PlanSnapshot, RouteSeg } from "@/lib/favorites/types";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { OverviewLegInput } from "@/lib/nav/route-overview";
import { TRANSFER_WALK_MIN_M, walkGapM, type WalkNavRequest } from "./walk-nav";
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
  /**
   * ★ v3.3.0（AC-115）：导航弹窗内**不设任何收藏入口** —— 原「收藏键」数据（`fav`）已随按钮一并移除。
   *   保留为可选仅作**向后兼容**（调用方仍在传），`NavDetailBody` 不再消费。
   */
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
  /**
   * ★ 2026-10-29：逐段几何锚点（`body.legs`，与 `card.rides` 同序；GCJ-02）——
   *   首末步行段与换乘步行段的端点坐标都从这里取。
   */
  legs?: OverviewLegInput[];
  /** 出发地坐标（GCJ-02）；缺省 ⇒ 不渲染「起点 → 上车站」的步行导航入口 */
  originCoord?: { lng: number; lat: number } | null;
  /** 出发地展示名（默认「我的位置」） */
  originLabel?: string;
  /**
   * 点「步行导航」→ 交给宿主查询并绘制。
   * 不传（收藏页无地图上下文）⇒ 所有步行导航入口不渲染。
   */
  onWalkNav?: (req: Omit<WalkNavRequest, "id">) => void;
}

export default function NavDetailBody({
  card,
  strips,
  otherRoutes,
  foldLive,
  stationLabel,
  colors,
  destLabel,
  /* ★ v3.3.0（AC-115）：`fav` 不再消费（导航弹窗内无收藏入口）—— 保留 prop 以兼容调用方 */
  degraded = false,
  track = null,
  destCoord = null,
  onSwitchCard,
  immersive = false,
  legs = [],
  originCoord = null,
  originLabel = "我的位置",
  onWalkNav,
}: NavDetailBodyProps) {
  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];
  /** ★ v3.3.0（AC-107）：赶车提示（合并式）—— 后端 `catchHint` 优先、回落 `tierText` */
  const firstHint = first ? catchHintOf(first) : { text: "", isHint: false };
  /** ★ v3.3.0（AC-102）：总览栏线路标签 = 与推荐卡同构的分段结构（含段内并行线） */
  const routeSegments = card.rides.map((r) => ({ codes: [r.route, ...(r.parallelRoutes ?? [])] }));

  // ── ★ 2026-10-29：步行导航入口（首段 / 换乘 / 末段）──
  //  坐标全部来自 `body.legs`（GCJ-02；与 rides 同序）；收藏页无地图/无 legs ⇒ 不渲染入口。
  type WalkSeg = Omit<WalkNavRequest, "id">;

  const walkOutSeg = useMemo<WalkSeg | null>(() => {
    if (!onWalkNav || !originCoord) return null;
    const board = legs[0]?.board;
    if (!board) return null;
    return {
      from: { lng: originCoord.lng, lat: originCoord.lat, label: originLabel },
      to: { lng: board.lng, lat: board.lat, label: card.walkOut.toLabel },
      hintMinutes: card.walkOut.minutes,
      hintDistanceM: card.walkOut.distanceM ?? null,
    };
  }, [onWalkNav, originCoord, originLabel, legs, card.walkOut]);

  const walkInSeg = useMemo<WalkSeg | null>(() => {
    if (!onWalkNav || !destCoord) return null;
    const alight = legs[legs.length - 1]?.alight;
    if (!alight) return null;
    // ★ 修复：`walkIn.toLabel` 是**目的地**名（见 model.ts 的注释），不是下车站名；
    //   起点标签必须取本腿站条的 `alightLabel`，否则弹层 OD 会显示「新馬路 → 新馬路」。
    const alightLabel =
      strips[legs.length - 1]?.alightLabel ||
      card.rides[legs.length - 1]?.alightLabel ||
      "下车站";
    return {
      from: { lng: alight.lng, lat: alight.lat, label: alightLabel },
      to: { lng: destCoord.lng, lat: destCoord.lat, label: destLabel },
      hintMinutes: card.walkIn.minutes,
      hintDistanceM: card.walkIn.distanceM ?? null,
    };
  }, [onWalkNav, destCoord, destLabel, legs, card.walkIn, card.rides, strips]);

  /** 换乘步行：i = 第 i 段下车 → 第 i+1 段上车的步行（同站台 / 距离过近 ⇒ 不列入） */
  const transferSegs = useMemo<Record<number, WalkSeg>>(() => {
    const out: Record<number, WalkSeg> = {};
    if (!onWalkNav) return out;
    for (let i = 0; i < legs.length - 1; i++) {
      const from = legs[i]?.alight;
      const to = legs[i + 1]?.board;
      const tr = card.transfers[i];
      if (!from || !to || !tr || tr.sameField) continue;
      if (walkGapM(from, to) < TRANSFER_WALK_MIN_M) continue;
      out[i] = {
        from: { lng: from.lng, lat: from.lat, label: tr.atLabel },
        to: { lng: to.lng, lat: to.lat, label: strips[i + 1]?.boardLabel ?? tr.atLabel },
        hintMinutes: tr.minutes,
      };
    }
    return out;
  }, [onWalkNav, legs, card.transfers, strips]);
  const legIdx = track ? track.legIndex : 0;
  const trackStops = track && track.phase !== "off" ? (strips[legIdx]?.stops ?? []) : [];
  const stopLabel = (k: number | null): string =>
    k !== null && k >= 0 && k < trackStops.length ? trackStops[k].label : "";

  // ── ★ v3.4.0（量化 P1）：距下车站「约 X 分钟」──
  //  X = 沿站条从「下一站」到末站的逐跳值之和（服务端 lookupHop 产物，已随 P0 升级到时段口径）；
  //  帧与帧之间（12s 轮询）按真实流逝**本地递减**，数字不卡住；帧到达（key 变化）时重校准。
  const progKey = track && track.prog ? `${track.prog.passedIdx}|${track.prog.nextIdx}` : "";
  const etaBaseRef = useRef<{ key: string; min: number; ts: number } | null>(null);
  const [etaTick, setEtaTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setEtaTick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const etaBaseMin = useMemo(() => {
    // ★ v3.4.0（进度模型）：本段有「位置感知剩余」（服务端投影 + 客户端融合）→ 优先用它；
    //   否则回退为「沿站条逐跳求和」（纯静态口径）。
    const segSec = track?.segProgress?.segRemainSec;
    if (segSec != null && segSec >= 0) return segSec / 60;
    if (!track || !track.prog || trackStops.length < 2) return 0;
    const nextIdx = track.prog.nextIdx ?? Math.min(trackStops.length - 1, track.prog.passedIdx + 1);
    let sum = 0;
    for (let k = Math.max(0, nextIdx); k < trackStops.length - 1; k++) sum += trackStops[k]?.minToNext ?? 0;
    return sum;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progKey, trackStops, track?.segProgress?.segRemainSec, track?.segProgress?.segFrom, track?.segProgress?.segTo]);
  useEffect(() => {
    etaBaseRef.current = { key: `${progKey}|${Math.round(etaBaseMin * 10)}`, min: etaBaseMin, ts: Date.now() };
  }, [progKey, etaBaseMin]);
  const remainMin = useMemo(() => {
    const base = etaBaseRef.current;
    if (!base) return etaBaseMin;
    return Math.max(0, base.min - (Date.now() - base.ts) / 60_000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [etaTick, etaBaseMin, progKey]);
  const stopsAway = track && track.prog ? Math.max(0, trackStops.length - 1 - track.prog.passedIdx) : 0;

  return (
    <>
      {/* 头部：总用时 / 到达 + 线路标签**同行**（★ 去灰框、仅下分割线；删「估算」） */}
      <div className="rc-dhead">
        <div className="rc-dhead__l">
          <div className="rc-dhead__total">
            <span className="rc-total">{Math.round(card.totalMin)}</span>
            <span className="rc-total__unit">分</span>
          </div>
          <span className="rc-dhead__arrive">
            预计 <b>{macauClock(card.arriveAt)}</b> 到达
            {card.crossBorder && <span className="rc-warn"> · 不含通关</span>}
          </span>
        </div>
        <div className="rc-dhead__r">
          {/* ★ v3.3.0（AC-102）：与推荐卡**逐字同构** —— 每段 = 主干线 + 段内并行线（`parallelRoutes`）
              （改前只给主干线 ⇒ 推荐卡显示 `25/26`、进导航变 `25`，两处不一致）。 */}
          <RouteStack segments={routeSegments} colors={colors} size="sm" />
          {/* ★ v3.3.0（AC-115）：**导航弹窗内不设收藏入口**（用户明确）——
              原「收藏键」`<FavoriteButton kind="plan" entry="detail" …/>` 已删除。
              删除后 detail 头部右区仅剩线路标签（本总览栏）。收藏入口只在：
              ① 起终点页「收藏组合」；② 推荐弹窗顶部「收藏组合」；③ 搜索框右上角「收藏地点」。 */}
        </div>
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
          aside={
            walkOutSeg ? (
              <button
                type="button"
                className="btn btn--text btn--sm rc-walk-nav"
                data-walk-nav="out"
                onClick={() => onWalkNav?.(walkOutSeg)}
              >
                步行导航
              </button>
            ) : null
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
                  /* ★ v3.2.0（AC-68/69）：逐班 secPrecise（`RideLegView.livePrecise`） */
                  precise={first.livePrecise}
                  state="running"
                  /* ★ v3.3.0（AC-103）：接通轻轨方向（改前恒传 null） */
                  directionName={directionNameOf(first)}
                  /* ★ 2026-09-27（用户需求 4）：导航 = 邻班区默认折叠、点击展开 */
                  neighbors="collapsed"
                  mainMs={first.liveMainMs}
                  tierCtx={{ walkMin: card.walkOut.minutes, walkDistM: card.walkOut.distanceM }}
                />
              ) : (
                <EtaText text={first.liveText || `等 ${Math.round(first.waitMin)} 分`} />
              )
            }
            /* ★ v3.3.0（AC-107）：赶车提示（合并式 TierBadge，同推荐卡槽位） */
            aside={
              firstHint.text ? (
                <TierBadge tier={first.tier} tierText={firstHint.text} catchHint={firstHint.isHint} />
              ) : null
            }
          />
        )}
      </div>

      {/* 距下车站还有 N 站（导航中；AC-02 站数刻度）· ★ v3.4.0：下方小字「约 X 分钟」 */}
      {track && track.phase === "riding" && track.prog && trackStops.length >= 2 && (
        <div className="nav-note-neutral nav-note-neutral--eta">
          <div className="nav-note__main">
            <span className="navstrip__badge">距离</span>
            距下车站还有 <b>{stopsAway}</b> 站
            {track.prog.nextIdx !== null && <> · 下一站 {stopLabel(track.prog.nextIdx)}</>}
          </div>
          <div className="nav-note__sub" data-eta-remain={Math.max(1, Math.round(remainMin))}>
            {stopsAway <= 1 ? "即将到站" : `约 ${Math.max(1, Math.round(remainMin))} 分钟`}
          </div>
        </div>
      )}

      {/* 进度纵条（一趟一条；导航中仅当前乘车段显示实时进度） */}
      <div className={`rc-strips${immersive ? " rc-strips--immersive" : ""}`}>
        {strips.map((strip, i) => (
          <Fragment key={`${strip.route}-${strip.board}-${i}`}>
            <NavStrip
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
                      /* ★ 本批：段内插值用户点（AC-43/44）+ 观测钩子 data-nav-leg */
                      youAt: track.youAt,
                      legIndex: track.legIndex,
                    }
                  : null
              }
              nextKind={strips[i + 1]?.kind ?? null}
              frozen={!!track && track.phase === "riding" && !!track.note}
            />
            {/* ★ 2026-10-29：换乘步行行（非同站台且距离 ≥ 阈值才出现）*/}
            {transferSegs[i] && (
              <Row
                dot="walk"
                main={
                  <>
                    步行{" "}
                    <b>{card.transfers[i]?.minutes ?? 1}</b> 分 → 换乘 {strips[i + 1]?.boardLabel ?? ""}
                  </>
                }
                aside={
                  <button
                    type="button"
                    className="btn btn--text btn--sm rc-walk-nav"
                    data-walk-nav="transfer"
                    onClick={() => onWalkNav?.(transferSegs[i])}
                  >
                    步行导航
                  </button>
                }
              />
            )}
          </Fragment>
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
          aside={
            walkInSeg ? (
              <button
                type="button"
                className="btn btn--text btn--sm rc-walk-nav"
                data-walk-nav="in"
                onClick={() => onWalkNav?.(walkInSeg)}
              >
                步行导航
              </button>
            ) : null
          }
        />
      </div>

      {/* 上车站其他线路（线路为父、方案为子） */}
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
    </>
  );
}
