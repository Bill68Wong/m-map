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
import Icon from "@/components/ui/Icon";
import NavMap from "./NavMap";
import NavBrandBar from "./NavBrandBar";
import AlightBanner from "./AlightBanner";
import PinDiag from "./PinDiag";
import NavSearchBarSlot from "./NavSearchBarSlot";
/* ★ v3.6.0 S5：步行导航（预取 + 跟随状态机 + 顶部横幅） */
import { useWalkRoute } from "@/components/walk/useWalkRoute";
import { useWalkFollow } from "@/components/walk/useWalkFollow";
import WalkTurnBanner from "@/components/walk/WalkTurnBanner";
import type { WalkStep } from "@/lib/walk/walk-shared";

/** 稳定的空 steps 引用（避免每次渲染新建数组 ⇒ 触发 hook 内部 effect 重跑） */
const EMPTY_WALK_STEPS: WalkStep[] = [];
/** 顶部跟随横幅高度（px）—— 与 `--walkturn-h` 同值，取景中带计算用（改多行须同步上调） */
const WALKTURN_H = 64;
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
  /** ★ v3.3.0（AC-93）：`?diag=pin` 钉诊断浮层开关（仅带参为真；客户端读 URL） */
  const [diagPin, setDiagPin] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setDiagPin(new URLSearchParams(window.location.search).get("diag") === "pin");
  }, []);

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
  /**
   * ★ v3.2.0（需求 5 / AC-76 · P4 裁定）：起点钉以 **`fromPoint`（= `from ?? 我的位置`）** 为准 ——
   *   改前 `from = null`（起点为「我的位置」）时 `originArg = null` ⇒ `NavMap` **从不创建红钉**
   *   （严格复现用户「全程没见过红钉」）。改为 `fromPoint` ⇒ 起点=我的位置时也画红钉（与蓝点组合）。
   *   依赖用 `fromPoint?.lng/lat` ⇒ 坐标不变则不产生新对象，避免下游 OD 标记 effect 抖动。
   */
  const originArg = useMemo(
    () => (fromPoint ? { lng: fromPoint.lng, lat: fromPoint.lat, label: fromPoint.label } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fromPoint?.lng, fromPoint?.lat],
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

  /**
   * ★ v3.2.0（需求 4/7 / AC-74/79）：GPS 通道 —— **`enabled` 扩到「地图页常开」**（浏览/选点/选路线/导航
   *   全程只要有定位就显示蓝点）；采纳间隔按档位：riding **1.5s** / 候车（detail 非 riding）**3s** / 浏览 **10s**；
   *   `maximumAge: 0` ⇒ 只用新鲜坐标（避免陈旧点导致蓝点/读数跳变）。
   */
  const gpsIntervalMs = ridePhase === "riding" ? 1_500 : navActive ? 3_000 : 10_000;
  const userFixR = useUserFix({ enabled: true, intervalMs: gpsIntervalMs, maximumAge: 0 });

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

  /* ══════════════════════════════════════════════════════════════════════
     ★ v3.6.0 S5 · 步行导航（详情可预览 / 进入后跟随）
     ─────────────────────────────────────────────────────────────────────
     · **互斥铁律**：`walkFollowing !== null` 与 `riding` 互斥（架构 §3.3）；
     · **进入跟随的唯一入口 = 用户显式点击**（不自动进入）：点击处由 `WalkSegToggle`
       的 `onExpand`（预览）与「开始步行」（跟随）触发，见 `RouteSheet` 的 walk 行；
     · **AC-08a**：预取只有首/末两段（`useWalkRoute` 内已写死 ≤2 次），
       推进过程中不再补请求。
     ══════════════════════════════════════════════════════════════════════ */
  /** 正在跟随的步行段（null = 未跟随） */
  const [walkSeg, setWalkSeg] = useState<"out" | "in" | null>(null);

  /**
   * 两段步行的 OD：
   *   · `out`（走到上车站）：起点 = 用户起点（`fromPoint`，无则用当前定位）→ 首段 `board`；
   *   · `in`（下车站走到目的地）：末段 `alight` → 终点 `to`。
   * 只有在 **detail pane 且几何就绪** 时才成立（否则没有站点锚点可去）。
   */
  const walkOds = useMemo(() => {
    const legs = ov.body?.legs ?? [];
    if (!legs.length || !to) return { out: null, in: null };
    const startPt = fromPoint ?? (userFixR.fix ? { lng: userFixR.fix.lng, lat: userFixR.fix.lat } : null);
    const firstBoard = legs[0]?.board;
    const lastAlight = legs[legs.length - 1]?.alight;
    return {
      out: startPt && firstBoard ? { from: { lng: startPt.lng, lat: startPt.lat }, to: { lng: firstBoard.lng, lat: firstBoard.lat } } : null,
      in: lastAlight && to ? { from: { lng: lastAlight.lng, lat: lastAlight.lat }, to: { lng: to.lng, lat: to.lat } } : null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ov.body?.legs, to?.lng, to?.lat, fromPoint?.lng, fromPoint?.lat, userFixR.fix?.lng, userFixR.fix?.lat]);

  /** 预取首/末两段（AC-08a：仅此两次） */
  const walkRoute = useWalkRoute(walkOds);
  const activeWalk = walkSeg === "out" ? walkRoute.out : walkSeg === "in" ? walkRoute.in : null;

  /** 跟随状态机（GPS 帧驱动；`following=false` 时为预览/空态，不判定位） */
  const walkFollow = useWalkFollow({
    steps: activeWalk?.steps ?? EMPTY_WALK_STEPS,
    stepsTotalM: activeWalk?.stepsTotalM ?? 0,
    fix: userFixR.fix ? { lng: userFixR.fix.lng, lat: userFixR.fix.lat, accuracy: userFixR.fix.accuracy } : null,
    following: walkSeg !== null && (activeWalk?.phase === "ready"),
  });

  /**
   * `donePath`：用户**真实走过的累积轨迹**。
   * 每帧把当前定位追加到末尾，**偏航重算后不清空、不重置**（设计 §2.3 切分规则）。
   * 与 `now/ahead` 可能几何不同源 —— "灰线与新绿线接续但不完全共线"是正确行为。
   */
  const donePathRef = useRef<[number, number][]>([]);
  const [walkVersion, setWalkVersion] = useState(0);
  const walkStepsKey = `${walkSeg ?? ""}|${activeWalk?.steps.length ?? 0}`;
  useEffect(() => {
    // 换段 ⇒ 轨迹重新累积（同一段内不重置）
    donePathRef.current = [];
    setWalkVersion((v) => v + 1);
  }, [walkStepsKey]);
  useEffect(() => {
    if (!walkSeg || !userFixR.fix) return;
    const p: [number, number] = [userFixR.fix.lng, userFixR.fix.lat];
    const last = donePathRef.current[donePathRef.current.length - 1];
    // 去抖：与上一点重合（<1 米）就不追加，避免轨迹里塞满重复顶点
    if (last && Math.abs(last[0] - p[0]) < 1e-5 && Math.abs(last[1] - p[1]) < 1e-5) return;
    donePathRef.current = [...donePathRef.current, p];
    setWalkVersion((v) => v + 1);
  }, [userFixR.fix, walkSeg]);

  /** 步行跟随中禁止 ride 自动上车（互斥）：两者同时激活时以 walk 为准 */
  const walkActive = walkSeg !== null;

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
      /**
       * ★ v3.6.0 S5：步行跟随时**顶部有横幅、底部有面板 ⇒ 两侧都占**，
       *   必须用新的 `insetTopPx` / `insetBottomPx`（中带算法）；
       *   非步行态**不传这两个新参** ⇒ 走旧路径，取景行为一字不改。
       */
      if (box) {
        if (walkActive) {
          frame({
            mode: "fit-box",
            box,
            slotTopPx: slot,
            insetTopPx: safeTop + WALKTURN_H,
            insetBottomPx: slot,
          });
        } else {
          frame({ mode: "fit-box", box, slotTopPx: slot });
        }
      } else frame({ mode: "none" });
      return;
    }
    if (stage === "panel") frame({ mode: from ? "fit-two" : to ? "dest-center-top" : "none" });
    else frame({ mode: "none" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rsOpen, pane, ov.box, ovExtra, stage, from, to, walkActive, safeTop]);

  /**
   * ★ v3.2.0（Spec §2/§3 · AC-84）：`body[data-nav-phase]` **五值**（页面级导航阶段钩子）——
   *   `off` / `recommend` / `detail` / **`walk`（★ v3.6.0 S5 新增第四态）** / `riding`。
   *   ⚠️ 与 `.nav-actions[data-nav-phase]`（NavTrackBar，值为**乘车 phase**）语义不同，勿混用；
   *      旧布尔 `body[data-nav="riding"]` **废弃**（底导隐藏规则已改选择器，见 globals.css）。
   *   ⚠️ `walk` 与 `riding` **互斥**：步行跟随优先（用户已显式进入），且两者入口互相隐藏。
   */
  const navPhase: "off" | "recommend" | "detail" | "walk" | "riding" = !rsOpen
    ? "off"
    : pane === "recommend"
      ? "recommend"
      : walkActive
        ? "walk"
        : ride.phase === "riding"
          ? "riding"
          : "detail";
  useEffect(() => {
    document.body.setAttribute("data-nav-phase", navPhase);
    return () => document.body.removeAttribute("data-nav-phase");
  }, [navPhase]);

  /**
   * ★ v3.2.0（需求 4 / AC-74）：**打开地图页即申请一次定位**（触发权限弹窗）。
   *   拒权 / 失败 ⇒ `denied` 置位但不抛错：页面**不空白**、默认视野与搜索照常、仅不显示蓝点（AC-75）。
   *   `startFix` 经 `useCallback([doWatch])` 恒稳定 ⇒ 该 effect 只在 mount 跑一次。
   */
  const startFix = userFixR.start;
  useEffect(() => {
    startFix();
  }, [startFix]);

  /**
   * ★ v3.2.0（需求 8 / AC-81）：页面级下车横幅的下车站名（与面板内 `NavAlarmOverlay` 同口径：
   *   本腿纵条末站 → 该腿 `alightLabel` → 首腿 `alightLabel`）。
   */
  const alarmLabel = useMemo(() => {
    const card = detailCard?.card;
    if (!card) return "";
    const li = ride.legIndex ?? 0;
    const stops = ov.body?.strips?.[li]?.stops ?? [];
    return (
      (stops.length ? stops[stops.length - 1].label : "") ||
      card.rides[li]?.alightLabel ||
      card.rides[0]?.alightLabel ||
      ""
    );
  }, [detailCard?.card, ride.legIndex, ov.body]);

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
          /**
           * ★ v3.6.0 S4（需求 R3 · 候车态地图车辆实时化）：
           *   detail pane 一律用 `ride.mapVehicles` —— 它由 12s 车辆帧驱动，
           *   候车态返回**本帧全部候选车**（riding 时只返回当前这辆）。
           *   旧版候车态用 `ov.vehicles`（进 detail 时**一次性**拉取）⇒ 地图上的车永远不动，
           *   「刷新」只更新下方列表，用户会当成"刷新没反应"。
           *   ⚠️ 因此 `useRouteOverview` 不再拉车（车辆只有一个来源 = `useRideTracking`）。
           */
          vehicles={detailActive ? ride.mapVehicles : rv.vehicles}
          onVehicleClick={onVehicleClick}
          /* ★ 2026-09-23：路线总览（灰底线 + 彩段） */
          overview={detailActive ? ov.legs : null}
          /* ★ v3.6.0 S5：步行三线（done/now/ahead）—— `walkSeg` 为空 ⇒ 传 null ⇒ 地图 0ms 移除 */
          walk={
            walkActive && activeWalk?.phase === "ready"
              ? {
                  steps: activeWalk.steps,
                  currentIdx: Math.max(0, walkFollow.currentIdx),
                  ratio: walkFollow.progress.ratio,
                  donePath: donePathRef.current,
                }
              : null
          }
          walkVersion={walkVersion}
          /* ★ v3.2.0（需求 4 / AC-74）：**蓝点任何时候显示** —— 导航态用 GPS 投影点（`youDot`）回落原始
             GPS；**浏览/选点/选路线态也回落原始 GPS**（原先非 detail 态传 `null` ⇒ 浏览时不显示蓝点，
             违反 AC-74）。拒权/未获定位 ⇒ `userFixR.fix = null` ⇒ 蓝点不显示、页面照常（AC-75）。 */
          userFix={detailActive ? (ride.youDot ?? userFixR.fix) : userFixR.fix}
          traveled={detailActive && ride.phase === "riding" ? ride.traveled : null}
          /* ★ 本批（需求②）：站点白名单（导航模式仅显示本线路站点） */
          lineStops={detailActive ? lineStops : null}
          /* ★ v3.2.0（需求 7 / AC-80）：蓝点移动插值时长 = 采样间隔；仅 ≤5s 才插值（浏览 10s ⇒ 0） */
          userDotSmoothMs={gpsIntervalMs <= 5_000 ? gpsIntervalMs : 0}
        />

        {/* 品牌栏（三栏网格）：左=空 · 中=换向键+线路标签 · 右=竖排按钮组（导航态右列隐藏，AC-84） */}
        <NavBrandBar
          picked={rv.picked ? { label: rv.picked.label, color: rv.picked.color, kind: rv.picked.kind } : null}
          canReverse={rv.canReverse}
          cooldownSec={rv.cooldownSec}
          onReverse={rv.reverse}
          onExitLine={rv.exitLine}
          onRefresh={rv.refresh}
          onOpenLines={() => setLineSheet(true)}
          /* ★ v3.3.0（AC-100）：首页定位按钮（右列原位）；导航态整列隐藏 ⇒ 由浮动 FAB 承担 */
          onLocate={() => setLocateTick((t) => t + 1)}
          /* ★ v3.2.0（需求 10 / AC-84）：导航语境（data-nav-phase ≠ off）⇒ 隐藏「查看路线」与「M Map logo」 */
          navMode={navPhase !== "off"}
        />

        {/* 顶置搜索条 + 提示条槽（★ v3.6.0 AC-54：收藏带入横幅及其专用 props 已删除） */}
        <NavSearchBarSlot
          stage={stage}
          to={to}
          error={!!rv.error}
          onOpenSearch={() => openSearch("dest")}
        />
      </div>

      {/* ★ v3.2.0（需求 11 / AC-85）+ v3.3.0（AC-100）：**定位两模式**（`data-locate-pos` 冻结钩子）
          · `off`（首页默认地图）⇒ **不渲染浮动层**，定位按钮在品牌栏右列原位（`bar`）；
          · `!=off`（recommend/detail/riding）⇒ 浮动层（`float`）随面板档位上下避让
            （`--sheet-y-anim` bottom 公式），品牌栏整列隐藏 ⇒ **两模式互斥、不重叠**。 */}
      {navPhase !== "off" && (
        <button
          type="button"
          className="nav-locate-fab"
          data-locate-fab="on"
          data-locate-pos="float"
          aria-label="定位到我的位置"
          title="定位到我的位置"
          onClick={() => setLocateTick((t) => t + 1)}
        >
          <Icon name="locate" size={20} />
        </button>
      )}

      {/* ★ v3.2.0（需求 8 / AC-81/82）：**页面级顶部下车横幅** —— 独立于面板，fixed + 安全区，
          z94（> 面板 70 / > 车卡浮层 90），落位公式见 globals.css `.nav-alarm--top`（07 §3.4）。 */}
      {ride.phase === "riding" && ride.alarm !== "none" && (
        <div className="nav-alarm--top" data-alarm-pos="top" data-alarm={ride.alarm}>
          <AlightBanner alarm={ride.alarm} destLabel={alarmLabel} />
        </div>
      )}

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

      {/*
        ★ v3.6.0 S5：**顶部步行跟随横幅** —— 页面级 `fixed`，**必须挂在 `.nav-map-wrap` 之外**。
        wrap 是层叠上下文，挂进去会永远低于底部 chrome（项目为这个先后踩过两次，
        见本文件 `:34-36` 的注释）。四态一条横幅，绝不叠两条。
      */}
      {walkActive && activeWalk?.phase === "ready" && (
        <WalkTurnBanner
          state={
            walkFollow.phase === "arrived"
              ? "arrive"
              : walkFollow.offRoute
                ? "off"
                : walkFollow.lowAccuracy
                  ? "manual"
                  : "turn"
          }
          text={activeWalk.steps[walkFollow.currentIdx]?.text}
          sub={activeWalk.steps[walkFollow.currentIdx]?.sub}
          turn={activeWalk.steps[walkFollow.currentIdx]?.turn ?? "straight"}
          /* 横幅显示**本步剩余米**（不是全程 → 否则"右转"配"还剩 800 米"会让人以为走错） */
          distM={(() => {
            const s = activeWalk.steps[walkFollow.currentIdx];
            if (!s) return 0;
            const geom = s.cumM.length ? s.cumM[s.cumM.length - 1] - s.cumM[0] : s.distM;
            return Math.max(0, geom - walkFollow.progress.doneInStepM);
          })()}
          offM={walkFollow.offM}
          destLabel={to?.label}
          onRecover={() => {
            walkFollow.recover();
            if (walkSeg) walkRoute.reload(walkSeg);
          }}
          onRetry={() => userFixR.start?.()}
        />
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
        /**
         * ★ v3.6.0 S5：步行入口 + 首段预览。
         * `onStart` = **唯一**进入跟随的入口（用户显式点击「开始步行」）；
         * `preview` 只取首段（末段跟随由 `walkSeg === "in"` 承载，入口同理）。
         */
        walk={{
          onStart: (seg, steps) => {
            void steps; // steps 已由 useWalkRoute 缓存，跟随状态机会拿到同一份
            walkRoute.ensure(seg);
            setWalkSeg(seg);
          },
          onExpand: () => walkRoute.ensure("out"),
          preview: {
            phase: walkRoute.out.phase,
            steps: walkRoute.out.steps,
            serverSteps: walkRoute.out.steps,
            totalDistM: walkRoute.out.stepsTotalM,
          },
        }}
        detail={
          detailCard && to
            ? {
                card: detailCard.card,
                degraded: detailCard.degraded,
                destLabel: to.label,
                phase: ov.phase,
                body: ov.body,
                /* ★ v3.6.0 S4：观测钩子改用唯一车辆来源（`ov.vehicles` 已删除） */
                vehicles: ride.mapVehicles.length,
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

      {/* ★ v3.3.0（AC-93 · ADR-102）：`?diag=pin` 起终点钉诊断浮层 —— **生产默认不渲染** */}
      {diagPin && <PinDiag />}
    </section>
  );
}

/** 站点 → NavPoint（`kind='station'`，label 带站码，与 POI 搜索口径一致） */
function stationToNavPoint(s: StationCardStation): NavPoint {
  return { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code };
}
