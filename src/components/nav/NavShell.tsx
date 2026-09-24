"use client";

/**
 * 首页导航壳（src/components/nav/NavShell.tsx）
 *
 * ── 2026-09-23 交互改版（Spec v2.12.0「谷歌地图式弹窗」）──────────────────
 *   状态机（单一 `RouteSheet` 宿主）：
 *
 *   ```
 *   map（全屏地图）
 *      │ 点搜索框
 *      ▼
 *   search（SearchSheet）
 *      │ 选点
 *      ▼
 *   panel（RoutePanel，半屏可出发）
 *      │ 点「出发」
 *      ▼
 *   sheet{ open, pane:'recommend', detent:'full' }   // 推荐默认 full
 *      │ 点卡片（当帧切 pane + full→half 动画 + 骨架）
 *      ▼
 *   sheet{ open, pane:'detail', detent:'half' }      // 上半屏 = 路线总览
 *      │ 上拖 → full ／ 下拖 → peek
 *      └ 关闭/返回/peek 下拉越过 → pane:'recommend', detent:'full'
 *                                   │ peek 下拉越过 / X
 *                                   ▼
 *                              panel（回可出发态；无 OD → map）
 *   ```
 *
 * ── 铁律（沿用 + 本轮）────────────────────────────────────────────────
 *   · ★ **不记忆**出发点（产品 R5）；收藏是**用户显式意图**，故允许；
 *   · 「出发」→ 面板内规划（★ 坐标 **GCJ-02**），**不整页跳转**；
 *   · 地图失败**不阻塞**：搜索/列表/详情照常；
 *   · ★ **面板与卡片一律挂在 `.nav-map-wrap` 之外** —— wrap 是 `position:fixed; z-index:0`
 *     的**层叠上下文**，挂进去会被底部 chrome 压住（Spec AC-13 的历史教训）；
 *   · ★ **非模态**：无 scrim，露出的地图带可拖/可点；点地图空白**不关闭**面板；
 *   · ★ 取景**全部自算**（`fit-box`），**禁用** `setBounds`/`setFitView`（会撑到珠海）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Icon from "@/components/ui/Icon";
import NavMap from "./NavMap";
import RefreshButton from "./RefreshButton";
import RouteLinesSheet from "./RouteLinesSheet";
import RoutePanel from "./RoutePanel";
import RouteSheet from "./RouteSheet";
import SearchSheet, { type QuickPair } from "./SearchSheet";
import StationCard, { type StationCardStation } from "./StationCard";
import VehicleCard from "./VehicleCard";
import { queryOf } from "./StepSheet";
import { useRouteVehicles } from "./useRouteVehicles";
import { useRouteOverview } from "./useRouteOverview";
import { DETENTS, detentTopsPx, readSafeTopPx, type Detent } from "./sheet-detents";
import { unionBox } from "@/lib/nav/route-overview";
import { useCombos } from "@/lib/favorites/useCombos";
import { endpointOf } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";
import type { NavPoint } from "@/lib/nav/types";

const MY_LOCATION = "我的位置";
/** 底层舞台：全屏地图 / 全屏搜索 / 半屏可出发 */
type Stage = "map" | "search" | "panel";

export interface NavShellProps {
  jsKey: string;
  /** ★ AC-16：自定义地图样式 ID（隐藏底图自带公交站点）；缺省 = 用高德默认样式 */
  mapStyleId?: string;
  colors?: Record<string, string>;
  /** 由「地点对收藏」带入的起点（收藏页回放用） */
  initialFrom?: NavPoint | null;
  /** 由「地点对收藏」带入的目的地 */
  initialTo?: NavPoint | null;
}

export default function NavShell({
  jsKey,
  mapStyleId = "",
  colors = {},
  initialFrom = null,
  initialTo = null,
}: NavShellProps) {
  /** 定位点（GCJ-02）；null = 尚未定位/定位失败 */
  const [userPos, setUserPos] = useState<{ lng: number; lat: number } | null>(null);
  const [from, setFrom] = useState<NavPoint | null>(initialFrom);
  const [to, setTo] = useState<NavPoint | null>(initialTo);
  const [station, setStation] = useState<StationCardStation | null>(null);

  /** 底层舞台（带 initialTo 时直接进「半屏可出发」= 与旧版一致） */
  const [stage, setStage] = useState<Stage>(initialTo ? "panel" : "map");
  /** 全屏搜索态正在编辑哪个端点 */
  const [editing, setEditing] = useState<"dest" | "from">("dest");
  /** 重新定位触发计数（右上定位按钮） */
  const [locateTick, setLocateTick] = useState(0);
  /**
   * 取景触发计数：状态变化时 +1，使 `NavMap` 重新取景。
   * ⚠️ 用计数而不是依赖对象本身 —— 同一模式连续触发也要生效。
   */
  const [viewTick, setViewTick] = useState(0);

  /**
   * 路线查看模式（选线路看实时车辆）；`picked` 非空 ⇒ 地图画该线 + 底部主题色标签。
   */
  const [lineSheet, setLineSheet] = useState(false);
  const rv = useRouteVehicles();
  const favs = useCombos();

  /* ── ★ 2026-09-23：单一 RouteSheet 宿主状态 ── */
  const [rsOpen, setRsOpen] = useState(false);
  const [pane, setPane] = useState<"recommend" | "detail">("recommend");
  const [snap, setSnap] = useState<Detent>("full");
  const [detailCard, setDetailCard] = useState<{ card: RecommendCard; degraded: boolean } | null>(null);
  /** 面板状态镜像（供稳定回调读取最新值，避免闭包过期） */
  const rsOpenRef = useRef(rsOpen);
  rsOpenRef.current = rsOpen;

  /** 视口尺寸 + 安全区（档位 px 现算） */
  const [winH, setWinH] = useState(0);
  const [safeTop] = useState(() => readSafeTopPx());
  useEffect(() => {
    const onResize = () => setWinH(window.innerHeight);
    onResize();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);
  const topsPx = useMemo(() => detentTopsPx(winH || 844, safeTop), [winH, safeTop]);

  /** 面板打开期间隐藏搜索框（200ms 淡出，`prefers-reduced-motion` 瞬切） */
  useEffect(() => {
    if (rsOpen) document.body.setAttribute("data-sheet", "open");
    else document.body.removeAttribute("data-sheet");
    return () => document.body.removeAttribute("data-sheet");
  }, [rsOpen]);

  const onLocate = useCallback((pos: { lng: number; lat: number } | null) => setUserPos(pos), []);

  const myLocation: NavPoint | null = userPos
    ? { kind: "gps", label: MY_LOCATION, lng: userPos.lng, lat: userPos.lat }
    : null;
  const fromPoint = from ?? myLocation;
  const canGo = !!fromPoint && !!to;
  /** 推荐/详情共用查询串（与 `/nav` URL 同口径） */
  const resultQuery = fromPoint && to ? queryOf(fromPoint, to) : "";
  const odLabel = fromPoint && to ? `${fromPoint.label} → ${to.label}` : "";

  /** 取景额外纳入的点（起点/终点）—— useMemo 稳定引用 */
  const ovExtra = useMemo(() => {
    const pts: { lng: number; lat: number }[] = [];
    if (fromPoint) pts.push({ lng: fromPoint.lng, lat: fromPoint.lat });
    if (to) pts.push({ lng: to.lng, lat: to.lat });
    return pts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromPoint?.lng, fromPoint?.lat, to?.lng, to?.lat]);

  /** ★ 路线总览数据流（仅 detail pane 打开时启用） */
  const ov = useRouteOverview(
    pane === "detail" ? detailCard?.card ?? null : null,
    rsOpen && pane === "detail",
    ovExtra,
  );

  /* ── 舞台操作 ── */
  function openSearch(which: "dest" | "from") {
    setEditing(which);
    setStage("search");
  }
  function backFromSearch() {
    setStage(to ? "panel" : "map");
    setViewTick((t) => t + 1);
  }
  function pickPoint(p: NavPoint, which: "dest" | "from") {
    if (which === "dest") setTo(p);
    else setFrom(p);
    setStage("panel");
    setViewTick((t) => t + 1);
  }

  /** ★ 出发 → 打开推荐面板（full 档；不整页跳转） */
  function go() {
    if (!fromPoint || !to) return;
    setDetailCard(null);
    setPane("recommend");
    setSnap("full");
    setRsOpen(true);
    setViewTick((t) => t + 1);
  }

  /** ★ 点卡片：**当帧**切 detail pane + 降档动画（不等待接口，先骨架） */
  function openDetail(card: RecommendCard, degraded: boolean) {
    setDetailCard({ card, degraded });
    setPane("detail");
    setSnap("half");
    setViewTick((t) => t + 1);
  }

  /** ★ contextual 关闭：推荐→关面板（回可出发态）；详情→回推荐列表 */
  function contextClose() {
    if (pane === "detail") {
      setPane("recommend");
      setSnap("full");
      setViewTick((t) => t + 1);
    } else {
      setRsOpen(false);
      setStage(to ? "panel" : "map");
      setViewTick((t) => t + 1);
    }
  }

  /** 点地图上的站/车 → 打开卡片；**打开卡片即收起面板**（同 Google Maps，z90 > z70） */
  const onStationClick = useCallback((s: StationCardStation) => {
    setStation(s);
    if (rsOpenRef.current) {
      setRsOpen(false);
      setStage("map");
    }
  }, []);
  const onMapClick = useCallback(() => setStation(null), []);

  /** 车辆点击：打开车辆卡 + 收起面板 */
  const onVehicleClick = useCallback(
    (v: Parameters<typeof rv.selectVehicle>[0], count: number) => {
      rv.selectVehicle(v, count);
      if (rsOpenRef.current) {
        setRsOpen(false);
        setStage("map");
      }
    },
    [rv],
  );

  /** 常用 = **收藏组合**（排除已停用），按最近使用取前 3 */
  const quickPairs: QuickPair[] = favs.mounted
    ? [...favs.combos]
        .filter((c) => !c.disabled)
        .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
        .slice(0, 3)
        .map((c) => ({ id: c.id, from: c.from, to: c.to }))
    : [];

  /**
   * 视口指令（交给 `NavMap`）：
   *   · 面板打开 + detail → `fit-box`（路线总览外包框 → 顶部槽）；
   *   · 面板打开 + recommend → `fit-box`（OD 两点 → 顶部槽）；
   *   · 半屏可出发 → `fit-two` / `dest-center-top`；
   *   · 其余 → `none`。
   * ⚠️ 拖动面板期间 NavShell **不重渲染**（拖拽 state 在 RouteSheet 内）⇒ 不触发取景（AC-03）。
   */
  const view = useMemo(() => {
    if (rsOpen) {
      const slot = topsPx[Math.min(topsPx.length - 1, Math.max(0, DETENTS.indexOf(snap)))];
      const box =
        pane === "detail"
          ? ov.box ?? (ovExtra.length >= 2 ? unionBox([], ovExtra) : null)
          : ovExtra.length >= 2
            ? unionBox([], ovExtra)
            : null;
      return box
        ? ({ mode: "fit-box", tick: viewTick, box, slotTopPx: slot } as const)
        : ({ mode: "none", tick: viewTick } as const);
    }
    if (stage === "panel") {
      return { mode: from ? "fit-two" : to ? "dest-center-top" : "none", tick: viewTick } as const;
    }
    return { mode: "none", tick: viewTick } as const;
  }, [rsOpen, pane, snap, topsPx, ov.box, ovExtra, stage, from, to, viewTick]);

  /** detail pane 打开时，总览取代「路线查看线」与其车辆 */
  const detailActive = rsOpen && pane === "detail";

  return (
    <section className="nav-shell nav-shell--full">
      <div className="nav-map-wrap">
        <NavMap
          jsKey={jsKey}
          mapStyleId={mapStyleId}
          className="nav-map--full"
          dest={to ? { lng: to.lng, lat: to.lat, label: to.label } : null}
          origin={from ? { lng: from.lng, lat: from.lat, label: from.label } : null}
          view={view}
          locateTick={locateTick}
          onLocate={onLocate}
          onStationClick={onStationClick}
          onMapClick={onMapClick}
          /* ★ v2.10.0：路线查看模式 + 实时车辆；★ 2026-09-23：detail pane 打开时让位给总览 */
          routeLine={detailActive ? null : rv.picked}
          onRouteDirs={rv.reportDirs}
          vehicles={detailActive ? ov.vehicles : rv.vehicles}
          onVehicleClick={onVehicleClick}
          /* ★ 2026-09-23：路线总览（灰底线 + 彩段） */
          overview={detailActive ? ov.legs : null}
        />

        {/* 品牌栏（三栏网格）：左=空 · 中=换向键+线路标签 · 右=竖排按钮组 */}
        <div className="nav-brandbar">
          <span className="nav-brandbar__left" aria-hidden="true" />

          <div className="nav-brandbar__mid">
            {rv.picked && rv.canReverse && (
              <button
                type="button"
                className="nav-rev"
                aria-label="切换行驶方向"
                title="切换行驶方向"
                onClick={rv.reverse}
              >
                <Icon name="exchange" size={20} />
              </button>
            )}
            {rv.picked && (
              <span className="nav-linechip" style={{ background: rv.picked.color }}>
                <span className="nav-linechip__text">{rv.picked.label}</span>
                <button
                  type="button"
                  className="nav-linechip__x"
                  aria-label={`退出路线查看（${rv.picked.label}）`}
                  title="退出路线查看"
                  onClick={rv.exitLine}
                >
                  <Icon name="close" size={16} />
                </button>
              </span>
            )}
          </div>

          {/* 右栏：竖排按钮组（刷新 → 公共交通路线 → 定位 → M Map） */}
          <div className="nav-brandbar__acts">
            {rv.picked?.kind === "bus" && (
              <RefreshButton cooling={rv.cooldownSec > 0} seconds={rv.cooldownSec} onRefresh={rv.refresh} />
            )}
            <button
              type="button"
              className="nav-locate"
              aria-label="公共交通路线"
              title="公共交通路线"
              onClick={() => setLineSheet(true)}
            >
              <Icon name="records" size={20} />
            </button>
            <button
              type="button"
              className="nav-locate"
              aria-label="定位到我的位置"
              title="定位到我的位置"
              onClick={() => setLocateTick((t) => t + 1)}
            >
              <Icon name="locate" size={20} />
            </button>
            <Link href="/help" className="nav-brand" aria-label="M Map · 帮助与合规说明">
              M Map
            </Link>
          </div>
        </div>

        {/* 顶置搜索条 —— 只在「非全屏搜索」时出现；面板打开期间 200ms 淡出（body[data-sheet=open]） */}
        {stage !== "search" && (
          <button
            type="button"
            className="nav-searchbar"
            onClick={() => openSearch("dest")}
            aria-label={to ? `已选目的地 ${to.label}，点击修改` : "选择目的地"}
          >
            <Icon name="search" size={20} />
            <span className={`nav-searchbar__text${to ? "" : " nav-searchbar__text--ph"}`}>
              {to ? to.label : "去哪儿？"}
            </span>
            {stage === "panel" && to && (
              <span className="nav-searchbar__tag t-label">
                <Icon name="destination" size={16} />
                已选
              </span>
            )}
          </button>
        )}

        {/* 带入收藏提示条（可出发态才显示） */}
        {initialTo && stage === "panel" && !from && (
          <div className="nav-banner t-label" role="status">
            已带入收藏：{initialFrom?.label ?? MY_LOCATION} → {initialTo.label}
          </div>
        )}

        {/* 车辆位置获取失败提示（不阻塞地图与线路走向） */}
        {rv.error && (
          <div className="nav-banner t-label" role="status">
            车辆位置：{rv.error}
          </div>
        )}
      </div>

      {/* ★ 卡片浮层（车卡/站卡）—— 挂在 wrap **之外**，`.nav-card-overlay`（fixed z90）
          ⇒ 面板打开时点地图带上的车/站，卡片不被面板（z70）压住。 */}
      {(station || rv.selected) && (
        <div className="nav-card-overlay">
          {station && (
            <StationCard
              station={station}
              colors={colors}
              onClose={() => setStation(null)}
              onSetFrom={() => {
                setFrom(stationToNavPoint(station));
                setStation(null);
                setStage("panel");
                setViewTick((t) => t + 1);
              }}
              onSetTo={() => {
                setTo(stationToNavPoint(station));
                setStation(null);
                setStage("panel");
                setViewTick((t) => t + 1);
              }}
            />
          )}
          {rv.selected && (
            <VehicleCard
              vehicle={rv.selected.vehicle}
              count={rv.selected.count}
              fetchedAt={rv.fetchedAt}
              lineLabel={rv.picked?.label}
              lineColor={rv.picked?.color}
              onClose={rv.closeVehicle}
            />
          )}
        </div>
      )}

      {/* 公共交通路线全屏选择弹窗（必须在 wrap 之外） */}
      {lineSheet && (
        <RouteLinesSheet
          onPick={(l) => {
            rv.pickLine(l);
            setLineSheet(false);
          }}
          onClose={() => setLineSheet(false)}
        />
      )}

      {/* ★ 单一三档面板宿主（推荐 ⇄ 详情；必须在 wrap 之外） */}
      <RouteSheet
        open={rsOpen}
        pane={pane}
        detent={snap}
        topsPx={topsPx}
        onDetentChange={setSnap}
        onContextClose={contextClose}
        odLabel={odLabel}
        query={resultQuery}
        colors={colors}
        fav={fromPoint && to ? { from: endpointOf(fromPoint), to: endpointOf(to) } : null}
        detail={
          detailCard && to
            ? {
                card: detailCard.card,
                degraded: detailCard.degraded,
                destLabel: to.label,
                phase: ov.phase,
                body: ov.body,
                vehicles: ov.vehicles.length,
                reload: ov.reload,
              }
            : null
        }
        onOpenDetail={openDetail}
      />

      {/* ── 全屏搜索层 ── */}
      {stage === "search" && (
        <SearchSheet
          editing={editing}
          dest={to}
          from={from}
          userPos={userPos}
          colors={colors}
          quickPairs={quickPairs}
          onPick={pickPoint}
          onPickQuick={(f, t) => {
            setFrom(f);
            setTo(t);
            setStage("panel");
            setViewTick((n) => n + 1);
          }}
          onBack={backFromSearch}
        />
      )}

      {/* ── 半屏起终点面板 ── */}
      {stage === "panel" && (
        <RoutePanel
          dest={to}
          from={from}
          userPos={userPos}
          canGo={canGo}
          going={false}
          query={resultQuery}
          onGo={go}
          onTapFrom={() => openSearch("from")}
          onTapDest={() => openSearch("dest")}
        />
      )}
    </section>
  );
}

/** 站点 → NavPoint（`kind='station'`，label 带站码，与 POI 搜索口径一致） */
function stationToNavPoint(s: StationCardStation): NavPoint {
  return { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code };
}
