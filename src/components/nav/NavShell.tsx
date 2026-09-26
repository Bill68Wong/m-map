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
import NavMap from "./NavMap";
import NavBrandBar from "./NavBrandBar";
import NavSearchBarSlot from "./NavSearchBarSlot";
import RouteLinesSheet from "./RouteLinesSheet";
import RoutePanel from "./RoutePanel";
import RouteSheet from "./RouteSheet";
import SearchSheet, { type QuickPair } from "./SearchSheet";
import StationCard, { type StationCardStation } from "./StationCard";
import VehicleCard from "./VehicleCard";
import { queryOf } from "./StepSheet";
import { useRouteVehicles } from "./useRouteVehicles";
import { useRouteOverview } from "./useRouteOverview";
import { useRideTracking, type RidePhase } from "./useRideTracking";
import { useUserFix } from "./useUserFix";
import { useNavFrame } from "./useNavFrame";
import { detentIndex, detentTopsPx, readSafeTopPx, type Detent } from "./sheet-detents";
import { unionBox } from "@/lib/nav/route-overview";
import { mainOf } from "@/lib/nav/track";
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
   * 路线查看模式（选线路看实时车辆）；`picked` 非空 ⇒ 地图画该线 + 底部主题色标签。
   */
  const [lineSheet, setLineSheet] = useState(false);
  const rv = useRouteVehicles();
  const favs = useCombos();

  /* ── ★ 2026-09-23：单一 RouteSheet 宿主状态 ── */
  const [rsOpen, setRsOpen] = useState(false);
  const [pane, setPane] = useState<"recommend" | "detail">("recommend");
  const [snap, setSnap] = useState<Detent>("full");
  /** ★ 2026-09-25：导航阶段镜像（决定 GPS 节流 15s/30s 与全屏化） */
  const [ridePhase, setRidePhase] = useState<RidePhase>("off");
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

  /**
   * ★ 本批（需求① / 坑：dest/origin 行内字面量 → 取景 effect 每次重渲染重跑）：
   *   把传给 `NavMap` 的 `dest`/`origin` 换成 **useMemo 稳定引用**，
   *   避免每次 NavShell 重渲染都产生新对象、触发下游 OD 标记 effect 抖动。
   */
  const destArg = useMemo(
    () => (to ? { lng: to.lng, lat: to.lat, label: to.label } : null),
    [to],
  );
  const originArg = useMemo(
    () => (from ? { lng: from.lng, lat: from.lat, label: from.label } : null),
    [from],
  );

  /** ★ 路线总览数据流（仅 detail pane 打开时启用） */
  const ov = useRouteOverview(
    pane === "detail" ? detailCard?.card ?? null : null,
    rsOpen && pane === "detail",
    ovExtra,
  );

  /** ★ 2026-09-25：导航态（detail pane 打开） */
  const navActive = rsOpen && pane === "detail";
  /** 导航态镜像（供稳定回调读取最新值，避免闭包过期 —— 点击不中断，AC-47/48） */
  const navActiveRef = useRef(navActive);
  navActiveRef.current = navActive;

  /**
   * ★ 本批（需求② / AC-29~31）：**站点白名单**（主码）。
   *   导航/路线查看模式 ⇒ 本程各腿站点**并集**（`ov.body.strips`，`mainOf` 归一）；
   *   空集保护：`size > 0` 才过滤（否则折成 `null` ⇒ 不过滤）。
   */
  const lineStops = useMemo<ReadonlySet<string> | null>(() => {
    if (!(rsOpen && pane === "detail")) return null;
    const set = new Set<string>();
    for (const strip of ov.body?.strips ?? []) for (const s of strip.stops) set.add(mainOf(s.code));
    return set.size > 0 ? set : null;
  }, [rsOpen, pane, ov.body]);

  /** ★ 2026-09-25：GPS 通道（候车 15s / 乘车 30s 节流；权限由手势申请） */
  const userFixR = useUserFix({
    enabled: navActive,
    intervalMs: ridePhase === "riding" ? 30_000 : 15_000,
  });

  /** ★ 2026-09-24：乘车追踪（自动上车 + 安全网 + 轻轨 GPS 推进） */
  const ride = useRideTracking({
    card: pane === "detail" ? detailCard?.card ?? null : null,
    legs: ov.legs,
    anchors: ov.body?.legs ?? null,
    strips: ov.body?.strips ?? null,
    active: navActive,
    userFix: userFixR.fix,
    onRequestGps: userFixR.start,
  });

  /** 阶段镜像（GPS 节流用；避免 userFix↔ride 循环依赖） */
  useEffect(() => {
    setRidePhase(ride.phase);
  }, [ride.phase]);

  /** ★ 2026-09-25：取景指令化（AC-17） */
  const { view, frame, reframeOnSettle } = useNavFrame();
  /** 当前档位镜像（取景指令读取用；避免 snap 进入 effect 依赖） */
  const snapRef = useRef<Detent>(snap);
  snapRef.current = snap;

  /**
   * 取景意图：仅在 **显式状态变化**（打开面板 / 切 pane / 换 OD / 换舞台）时下令。
   * ⚠️ **不依赖 `snap`** ⇒ 拖面板 / 换档不重取景（AC-17）；落定后仅被遮挡时经
   *    `reframeOnSettle` 微调一次。
   */
  useEffect(() => {
    const slot = topsPx[Math.min(topsPx.length - 1, Math.max(0, detentIndex(snapRef.current)))];
    if (rsOpen) {
      const box =
        pane === "detail"
          ? ov.box ?? (ovExtra.length >= 2 ? unionBox([], ovExtra) : null)
          : ovExtra.length >= 2
            ? unionBox([], ovExtra)
            : null;
      if (box) frame({ mode: "fit-box", box, slotTopPx: slot });
      else frame({ mode: "none" });
      return;
    }
    if (stage === "panel") frame({ mode: from ? "fit-two" : to ? "dest-center-top" : "none" });
    else frame({ mode: "none" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rsOpen, pane, ov.box, ovExtra, stage, from, to]);

  /** 全屏化：导航中隐藏底导（body[data-nav="riding"]） */
  useEffect(() => {
    if (navActive && ride.phase === "riding") document.body.setAttribute("data-nav", "riding");
    else document.body.removeAttribute("data-nav");
    return () => document.body.removeAttribute("data-nav");
  }, [navActive, ride.phase]);

  /* ── 舞台操作 ── */
  function openSearch(which: "dest" | "from") {
    setEditing(which);
    setStage("search");
  }
  function backFromSearch() {
    setStage(to ? "panel" : "map");
  }
  function pickPoint(p: NavPoint, which: "dest" | "from") {
    if (which === "dest") setTo(p);
    else setFrom(p);
    setStage("panel");
  }

  /** ★ 出发 → 打开推荐面板（full 档；不整页跳转） */
  function go() {
    if (!fromPoint || !to) return;
    setDetailCard(null);
    setPane("recommend");
    setSnap("full");
    setRsOpen(true);
  }

  /** ★ 点卡片：**当帧**切 detail pane + 降档动画（不等待接口，先骨架） */
  function openDetail(card: RecommendCard, degraded: boolean) {
    setDetailCard({ card, degraded });
    setPane("detail");
    setSnap("half");
  }

  /** ★ contextual 关闭：推荐→关面板（回可出发态）；详情→回推荐列表 */
  function contextClose() {
    if (pane === "detail") {
      setPane("recommend");
      setSnap("full");
    } else {
      setRsOpen(false);
      setStage(to ? "panel" : "map");
    }
  }

  /** ★ 面板换档落定：更新档位；仅「被遮挡」时微调取景一次（AC-17） */
  function onDetent(d: Detent) {
    setSnap(d);
    reframeOnSettle(topsPx[Math.min(topsPx.length - 1, Math.max(0, detentIndex(d)))]);
  }

  /**
   * 点地图上的站/车 → 打开卡片。
   * ★ 本批（需求⑥ / AC-47/48）：**导航态点击不中断** —— 导航中（`navActive`）只开卡片浮层，
   *   **不清空面板**；非导航态保持原行为（同 Google Maps，卡片 z90 > 面板 z70）。
   */
  const onStationClick = useCallback((s: StationCardStation) => {
    setStation(s);
    if (rsOpenRef.current && !navActiveRef.current) {
      setRsOpen(false);
      setStage("map");
    }
  }, []);
  const onMapClick = useCallback(() => setStation(null), []);

  /** 车辆点击：打开车辆卡 + 收起面板（导航态不清面板） */
  const onVehicleClick = useCallback(
    (v: Parameters<typeof rv.selectVehicle>[0], count: number) => {
      rv.selectVehicle(v, count);
      if (rsOpenRef.current && !navActiveRef.current) {
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

  /** detail pane 打开时，总览取代「路线查看线」与其车辆 */
  const detailActive = rsOpen && pane === "detail";

  return (
    <section className="nav-shell nav-shell--full">
      <div className="nav-map-wrap">
        <NavMap
          jsKey={jsKey}
          mapStyleId={mapStyleId}
          className="nav-map--full"
          dest={destArg}
          origin={originArg}
          view={view}
          locateTick={locateTick}
          onLocate={onLocate}
          onStationClick={onStationClick}
          onMapClick={onMapClick}
          /* ★ v2.10.0：路线查看模式 + 实时车辆；★ 2026-09-23：detail pane 打开时让位给总览 */
          routeLine={detailActive ? null : rv.picked}
          onRouteDirs={rv.reportDirs}
          /* ★ 本批（需求⑥ / AC-45/46）：riding 只显示当前班车（12s 轮询驱动）；否则沿用路线查看车辆 */
          vehicles={detailActive ? (ride.phase === "riding" ? ride.mapVehicles : ov.vehicles) : rv.vehicles}
          onVehicleClick={onVehicleClick}
          /* ★ 2026-09-23：路线总览（灰底线 + 彩段） */
          overview={detailActive ? ov.legs : null}
          /* ★ 本批（需求⑤ / AC-40~42）：单蓝点 —— riding 用 GPS 投影点（`youDot`），
             否则回落原始 GPS；**取消原 riding 隐藏三元**（乘车中蓝点不再隐藏）。 */
          userFix={detailActive ? (ride.youDot ?? userFixR.fix) : null}
          traveled={detailActive && ride.phase === "riding" ? ride.traveled : null}
          /* ★ 本批（需求②）：站点白名单（导航模式仅显示本线路站点） */
          lineStops={detailActive ? lineStops : null}
        />

        {/* 品牌栏（三栏网格）：左=空 · 中=换向键+线路标签 · 右=竖排按钮组 */}
        <NavBrandBar
          picked={rv.picked ? { label: rv.picked.label, color: rv.picked.color, kind: rv.picked.kind } : null}
          canReverse={rv.canReverse}
          cooldownSec={rv.cooldownSec}
          onReverse={rv.reverse}
          onExitLine={rv.exitLine}
          onRefresh={rv.refresh}
          onOpenLines={() => setLineSheet(true)}
          onLocate={() => setLocateTick((t) => t + 1)}
        />

        {/* 顶置搜索条 + 提示条槽 */}
        <NavSearchBarSlot
          stage={stage}
          to={to}
          from={from}
          initialTo={initialTo}
          initialFrom={initialFrom}
          error={!!rv.error}
          myLocationLabel={MY_LOCATION}
          onOpenSearch={() => openSearch("dest")}
        />
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
              }}
              onSetTo={() => {
                setTo(stationToNavPoint(station));
                setStation(null);
                setStage("panel");
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
        onDetentChange={onDetent}
        onContextClose={contextClose}
        odLabel={odLabel}
        query={resultQuery}
        colors={colors}
        fav={fromPoint && to ? { from: endpointOf(fromPoint), to: endpointOf(to) } : null}
        immersive={ride.phase === "riding"}
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
                /* ★ 2026-09-24：导航追踪态 + 可切换方案上下文 */
                track: ride,
                destCoord: { lng: to.lng, lat: to.lat },
                onSwitchCard: openDetail,
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
          }}
          onBack={backFromSearch}
        />
      )}

      {/* ── 半屏起终点面板 ──
          ★ 2026-09-24：面板（RouteSheet）打开期间**整体隐藏**——否则它在 z55 持续渲染，
          推荐面板被拖到 peek 档（只占底部）时，会从面板后方露出（用户实测反馈）。 */}
      {stage === "panel" && !rsOpen && (
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
