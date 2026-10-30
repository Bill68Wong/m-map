"use client";

/**
 * 导航地图（src/components/nav/NavMap.tsx，v1.3.0 · T04；★ M Map 改版 S1 增「澳门范围」）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   · 高德 JS API 2.0 底图（`amap-loader`，懒加载，`ssr:false` 由调用方保证）；
 *   · ★【S1 新增】**只显示澳门**：`setLimitBounds`（拖动限制）+ `setZooms([11,18])`（缩放收敛）
 *     + `setBounds`（初始视野 = 澳门全境）+ **域外遮罩**（大矩形镂空澳门，半透明压暗）。
 *     边界取自高德官方 `AMap.DistrictSearch`（见 `src/lib/amap/district.ts`，**不自绘**）。
 *     **降级原则**：边界/遮罩任一环节失败 → 回落到「仅范围限制 + 兜底矩形」，**绝不阻塞**底图/搜索/定位。
 *   · 标记：用户位置蓝点 + 目的地图标；
 *   · ★ 巴士站点图层：地图就绪后一次性拉 `/api/stations` 并缓存（ref），仅 `zoom >= STATION_MIN_ZOOM`
 *     时渲染**屏幕内**站点（`getBounds()` 裁剪），拉远即清空；`zoomend`/`moveend`（~150ms throttle）。
 *     点击站点 → `onStationClick`（信息卡）。移除点务必 `map.remove()` 清理，防泄漏。
 *   · ★ **地图失败不阻塞**：JS 加载失败/缺 Key/初始化异常 → 静态占位 + 「重试」，
 *     **搜索/出卡/详情完全不受影响**（产品已拍，§Q7）。
 *
 * ── 定位（★ 02 §1.4 ④ 裁定）──────────────────────────────────────────
 *   · 定位点在**澳门范围内** → `setZoomAndCenter(zoomForAcross(lat,w), [lng,lat])`（沿用「横向 5km」）；
 *   · 定位点在**澳门范围外** → **不移动地图**（保持澳门视野），蓝点按真实 GCJ-02 坐标如实落位；
 *   · 定位失败 → 停在澳门视野 + 现有提示（「无法定位 · 请手动选择出发点」）。
 *
 * ── 观测钩子（无副作用，供自动化验收）────────────────────────────────
 *   `data-nav-zoom` · `data-nav-z` · `data-station-count` · ★ `data-limit-bounds`(=on|off)
 *   · ★ `data-limit-bounds-src`(=district|fallback) · ★ `data-map-mask`(=on|off)
 *
 * ⚠️ 坐标：`Geolocation({ convert:true })` 的 `position` **已是 GCJ-02，不再转换**。
 * ⚠️ 文案：界面文案一律**简体**（站名/线路名才用繁体）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { isInsideRings, loadMacauDistrict, maskOuterRing, type MacauDistrict } from "@/lib/amap/district";
import { wgs84ToGcj02 } from "@/lib/amap/coord";
import { type ColoredLeg, type LL } from "@/lib/nav/route-overview";
import { loadAMap } from "./amap-loader";
/* ★ v3.3.0（AC-92 · ADR-102）：起终点钉内联 SVG 单一真源 */
import { PIN_SVG_DEST, PIN_SVG_ORIGIN } from "@/lib/nav/pin-svg";
import {
  fitGapPx,
  maskFill,
  MASK_OPACITY,
  MAX_ZOOM,
  MIN_ZOOM,
  panelTopPx,
  zoomForAcross,
} from "./nav-map-fit";
import { drawOverview } from "./nav-map-overview";
import { lrtTransferVariantOf } from "./lrt-transfer";
import TrackLayer from "./TrackLayer";
import UserDotLayer from "./UserDotLayer";
import type { WalkNavRequest, WalkNavResult } from "./walk-nav";
import { WALK_FOLLOW_ZOOM } from "./walk-nav";
import VehicleLayer from "./VehicleLayer";
import type { VehicleLite } from "./VehicleMarker";
import type { UserFix } from "./useUserFix";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MACAU_CENTER = { lng: 113.558, lat: 22.155 }; // 全澳门视角中心（§D.1）
/** 初始 zoom（地图创建占位用；district 就绪后由 setBounds 接管） */
const INIT_ZOOM = 12;

/**
 * 站点图层显示阈值：`zoom < STATION_MIN_ZOOM` 时不显示任何站点（拉远即清空）。
 * · 2026-09-22：16 → 15（用户反馈「要放得很大站点才显示出来」）。
 * ★ 2026-09-23：15 → **14**（用户拍板）——要求「打开定位后的默认视野就要能看到站点」。
 *   实测定位完成后的视野 ≈ 14.47 级 ⇒ 阈值取 14 时定位完成即显示，不必手动放大；
 *   而全澳总览（≈12.4 级）仍不显示，避免整屏 470+ 站点糊在街区细节上。
 * ★ v3.1.1（真机反馈 #3）：14 → **15**（用户反馈「站点太密集」）。
 *   定位完成后视野 ≈ 14.47 **< 15** ⇒ 打开时**不显示**站点、轻微放大一档才出现（正是本次诉求）；
 *   全澳总览（12.4）与首页默认视野都更干净。
 *   ⚠️ 这**推翻了 2026-09-23「打开定位就要看到站点」的旧拍板**（两者不可兼得），
 *     属 12 文档 §D 的既定取舍（用户已真机确认取 15）。
 */
const STATION_MIN_ZOOM = 15;
/**
 * ★ 2026-09-22：**路线查看模式下的站点阈值**（比常规低一档）。
 *   为什么需要：进入路线模式会 `setBounds` 把视野缩到「装下整条线」，
 *   跨全澳的长线（如 26 号）实测落到 zoom ≈ 12~13，**低于常规阈值** ⇒ 站点图层整体不显示
 *   ⇒ 看不到「本线站点高亮」的效果 ✗ ⇒ 路线模式下放宽到 12。
 * ★ v3.1.1：**保持 12 不动**（不可提高到 13 —— 长线 `setBounds` 后落在 **12.x**，
 *   `12.3 < 13` ⇒ 整层站点不显示，正是 2026-09-22 记录过的坑）；
 *   且本批需求②「非本线不渲染」后路线模式最多只剩十几~二十几个点，**不会密集**，无需提阈值。
 */
const STATION_MIN_ZOOM_ROUTE = 12;
/** 视图事件节流（毫秒）：`zoomend`/`moveend` 高频触发，节流后再裁剪/渲染 */
const STATION_REFRESH_THROTTLE_MS = 150;

/** 空车辆数组的**稳定引用** —— 用作 prop 默认值，避免每次渲染产生新引用触发 effect 抖动 */
const NO_VEHICLES: VehicleLite[] = [];

/** `/api/stations` 一条站点（坐标 **GCJ-02**，服务端已转好） */
export interface StationPointLite {
  code: string;
  name: string;
  lng: number;
  lat: number;
  /** ★ 2026-09-22：载具种类（仅带 `include=lrt` 时轻轨行才出现；缺省视为巴士） */
  kind?: "bus" | "lrt";
  /**
   * ★ v2.10.0：轻轨站**线路主题色**（`--c1`）—— 来自 `/api/stations`（源头 `routes.color`）。
   *   单线站 = 该线色；换乘站按 Spec §8 取 c1。**仅轻轨站下发**（巴士站恒为青花蓝，走 CSS）。
   *   颜色是**数据** ⇒ 只以行内 CSS 变量注入，绝不写进 CSS。
   */
  color?: string;
  /** ★ v2.10.0：换乘站**第二线路色**（`--c2`）—— 仅蓮花（`LRT-LOT`）/ 協和醫院（`LRT-UH`） */
  color2?: string;
  /** ★ v2.10.0：该站停靠的线路码（去重；`/api/stations` 旁路数据，当前前端未消费） */
  lines?: string[];
  /** ★ v2.10.0：与 `lines` 一一对应的线路色（`/api/stations` 旁路数据，当前前端未消费） */
  colors?: string[];
}

export interface NavMapProps {
  /** Web 端（JS API）Key（服务端以 prop 传入） */
  jsKey: string;
  /**
   * ★ AC-16：**自定义地图样式 ID**（高德控制台创建，用于隐藏底图**自带**的公交站点图标；
   *   我们自己的站点图层是独立 marker，不受影响）。
   *   缺省 / 空串 ⇒ **不传 `mapStyle`，用高德默认样式（与现状逐字节一致，降级安全）**。
   *   ⚠️ 样式须与 `jsKey` 同属一个开发者账号，否则不生效。
   */
  mapStyleId?: string;
  /** 目的地图标（用户选定 POI 后）；★ S2：设为该点后地图**居中**到目的地 */
  dest?: { lng: number; lat: number; label: string } | null;
  /**
   * ★ 2026-09-22 新增：**出发地标记**（选完出发地后与目的地同时显示）。
   *   与 `dest` 同构；两者都有时可配合 `view.mode='fit-two'` 自动适配两点。
   */
  origin?: { lng: number; lat: number; label: string } | null;
  /**
   * ★ 2026-09-22 新增：**视口指令**（搜索重构用）。
   *
   * 为什么要它：新版搜索弹窗**覆盖在地图上**（下半屏被遮住）。
   *   若仍按「容器中心」居中，标记会落进被遮住的下半屏 ⇒ 用户看不见 ✗
   *   所以需要两种特殊取景：
   *     · `dest-center-top`：目的地放在 **上半屏正中央**（弹窗半屏时用）
   *     · `fit-two`       ：出发地 + 目的地 **都在视野内**（自动缩放 + 居中）
   *   `tick` 变化即重新取景（同一模式重复触发也生效）。
   *
   * ★ 2026-09-23：扩展 `fit-box`（面板三档取景）——
   *   把外包框 `box` 适配进「面板顶边以上的可视槽」（`slotTopPx`）。
   *   ⚠️ **禁用 `setBounds` / `setFitView`**（本项目 `setLimitBounds(澳門)` 场景下会被撑到
   *   珠海斗门、zoom 掉到最小）⇒ 一律复用 `fit-two` 的自算逻辑（反推 zoom + panBy）。
   */
  view?:
    | {
        mode: "dest-center-top" | "fit-two" | "fit-box" | "none";
        tick: number;
        /** fit-box：待装下的经纬度外包框（面板顶边以上区域） */
        box?: { minLng: number; minLat: number; maxLng: number; maxLat: number };
        /** fit-box：可视槽底边像素（= 当前档面板顶边） */
        slotTopPx?: number;
      }
    | null;
  /** 定位回调：成功给 GCJ-02 坐标；失败给 null */
  onLocate?: (pos: { lng: number; lat: number } | null) => void;
  /** 点击巴士站点回调（信息卡）——坐标 GCJ-02 */
  onStationClick?: (s: StationPointLite) => void;
  /** 点击地图空白处（S2：用于收起站点信息卡） */
  onMapClick?: (pos: { lng: number; lat: number }) => void;
  /** 地图就绪后回传「读地图中心」的函数（S2 分步弹层第 2 步「用这个点」用） */
  onMapReady?: (probe: () => { lng: number; lat: number } | null) => void;
  /**
   * ★ 2026-09-22 新增：**路线查看模式**。
   *   非空 ⇒ 地图上画出该线路的走向（`route_shapes`，GCJ-02），并把该线站点放大高亮、
   *   其他站点变灰变小；视野**自动装下整条线**。传 `null` 即退出该模式（清线恢复原样）。
   */
  routeLine?: { code: string; kind: "bus" | "lrt"; label: string; color: string; dir?: string } | null;
  /**
   * ★ v2.10.0：`NavMap` 读到 `/api/route-shapes` 后**回报该线路可用方向**（`dsat_dir`）。
   *   上层据此判定单向（`length<=1` ⇒ 无换向按钮）并补齐 `routeLine.dir`。
   */
  onRouteDirs?: (dirs: string[]) => void;
  /** ★ v2.10.0：该线路当前方向的在途车辆（空数组 = 无车/非巴士） */
  vehicles?: VehicleLite[];
  /** ★ v2.10.0：点击车辆图标（含合并组内的其余车辆） */
  onVehicleClick?: (vehicle: VehicleLite, count: number) => void;
  /**
   * ★ 2026-09-23：**路线总览**（详情 pane 用）。
   *   非空 ⇒ 逐段画「灰底线（区间外 z68）+ 彩段（乘车区间 z72）」；起终点 pin 由 `origin/dest`
   *   另行绘制。`null` ⇒ 逐个 `map.remove()` 清理（复用 routeLine 清理模式）。
   *   几何由 `useRouteOverview` 算好（`buildColoredLegs`）；`color=null` 回落 `--accent`。
   */
  overview?: ColoredLeg[] | null;
  /**
   * ★ 2026-09-25：**导航追踪 · 用户定位蓝点（人）**。
   *   非空 ⇒ 画蓝点（原生 marker z128 < 车辆 130）；`null` ⇒ 移除（拒权/无信号/上车重合）。
   */
  userFix?: UserFix | null;
  /**
   * ★ 2026-09-24：**导航追踪 · 已驶过路段**（灰实线 polyline，z74 —— 压在乘车彩段 72 之上）。
   *   路径 = 乘车段 polyline 由车辆/GPS 实时投影切割所得（`useRideTracking`）；`null` ⇒ 不画。
   */
  traveled?: LL[] | null;
  /**
   * 重新定位触发计数（右上定位按钮）—— 变化时重跑一次定位并（范围内）居中。
   * 初始为 0 时不触发（首屏定位由 `init()` 负责）。
   */
  locateTick?: number;
  /**
   * ★ 本批新增（需求② 站点过滤 / AC-29~31）：**站点白名单（主码）**。
   *   非空 ⇒ 仅渲染集合内站点（路线查看 / 导航模式由宿主计算）；
   *   `null` / 空集 ⇒ 不过滤（回落到常规「本线高亮 / 其他变灰」逻辑）。
   */
  lineStops?: ReadonlySet<string> | null;
  /**
   * ★ v3.2.0（需求 7 / AC-80）：蓝点移动插值时长（ms，= 采样间隔）。
   *   `0`（缺省）= 瞬移；riding 1500 / 候车 3000（>5s 采样必为 0）。透传给 `UserDotLayer`。
   *   ⚠️ 语义变更（需求 9）：左下「回到我的位置」按钮已**彻底移除** ——
   *     让位锁（`followState`/`free`）、双击恢复 `restore()`、定位键重跑**全部保留**。
   */
  userDotSmoothMs?: number;
  /** 附加类名（承载全屏布局） */
  className?: string;
  /**
   * ★ 2026-10-29：**步行导航请求**（GCJ-02）。
   *   非空 ⇒ 用高德 `AMap.Walking` 查真实步行路径并画线、取景；`null` ⇒ 清理折线。
   *   查询结果经 `onWalkNavResult` 回传（面板由宿主渲染）。
   */
  walkNav?: WalkNavRequest | null;
  /** 步行查询结果回传（成功/失败都给，保证面板不空白） */
  onWalkNavResult?: (r: WalkNavResult) => void;
  /**
   * ★ 2026-10-29（第二期）：**跟随模式**。`true` ⇒ 相机钉子钉在当前 GPS 点上（`walkPos`），
   *   每来一帧定位就居中（缩放固定 `WALK_FOLLOW_ZOOM`）；`false` ⇒ 恢复步行路径总览取景。
   */
  walkFollow?: boolean;
  /** 跟随模式下的当前 GPS 点（GCJ-02）；null = 等定位 */
  walkPos?: { lng: number; lat: number } | null;
  /** 跟随中被用户拖动地图打断（宿主置 `walkFollow=false`） */
  onWalkFollowBreak?: () => void;
}

export default function NavMap({
  jsKey,
  mapStyleId = "",
  dest,
  origin,
  view,
  onLocate,
  onStationClick,
  onMapClick,
  onMapReady,
  locateTick = 0,
  className = "",
  routeLine = null,
  onRouteDirs,
  vehicles = NO_VEHICLES,
  onVehicleClick,
  overview = null,
  userFix = null,
  traveled = null,
  lineStops = null,
  userDotSmoothMs = 0,
  walkNav = null,
  onWalkNavResult,
  walkFollow = false,
  walkPos = null,
  onWalkFollowBreak,
}: NavMapProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** `.nav-map` 根元素（写观测钩子：data-map-follow / data-map-zoom / …） */
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  /** 高德命名空间（供右上定位按钮重跑定位） */
  const amapRef = useRef<any>(null);
  const userMarkerRef = useRef<any>(null);
  const destMarkerRef = useRef<any>(null);
  /** ★ 2026-09-22：出发地标记（与目的地图标同构） */
  const originMarkerRef = useRef<any>(null);
  const maskRef = useRef<any>(null);
  const locatedRef = useRef(false);
  /** 澳门边界结果（ref；供定位「是否在澳门内」判定） */
  const districtRef = useRef<MacauDistrict | null>(null);
  /** 是否已应用范围限制（setLimitBounds 成功） */
  const boundsAppliedRef = useRef(false);
  /** 定位早于边界就绪时的暂存坐标（+ 是否显式意图） */
  const pendingLocateRef = useRef<{ pos: { lng: number; lat: number }; focus: boolean } | null>(null);
  /** 最近一次成功定位坐标（mepin 重建用） */
  const lastLocatePosRef = useRef<{ lng: number; lat: number } | null>(null);
  /** 全量站点（一次拉取，ref 缓存）与已渲染标记（code → marker） */
  const stationsRef = useRef<StationPointLite[] | null>(null);
  const stationMarkersRef = useRef<Map<string, any>>(new Map());
  /**
   * ★ 2026-09-22 路线查看模式：
   *   · `routePolylinesRef` 当前画的线（退出时逐个 remove）；
   *   · `routeStopsRef` **本线站点主码集合**（站点图层据此切样式：本线高亮 / 其他变灰）。
   *   ⚠️ 集合为空表示**不在路线模式** —— 站点样式回落到常规。
   */
  const routePolylinesRef = useRef<unknown[]>([]);
  const routeStopsRef = useRef<Set<string>>(new Set());
  /** ★ 2026-09-23：路线总览的 polyline（灰底 z68 + 彩段 z72）；退出 detail 时逐个 remove */
  const overviewPolylinesRef = useRef<unknown[]>([]);
  /** ★ 2026-10-29：步行导航折线（退出/切换步行段时逐个 remove） */
  const walkPolylinesRef = useRef<unknown[]>([]);
  /**
   * ★ 2026-10-29（第二期）：步行路径的「总览取景」记忆（center/zoom）——
   *   跟随结束（`walkFollow: true → false`）时据此恢复；`null` = 当前无路径。
   */
  const walkViewRef = useRef<{ zoom: number; center: [number, number] } | null>(null);
  /** 被「用户拖动」打断跟随 ⇒ 退出时**不抢回总览镜头**（拖动期间跳相机会打断手势） */
  const walkSkipRestoreRef = useRef(false);
  /** 跟随状态镜像（供 dragstart / 查询回调读最新值，避免闭包过期） */
  const walkFollowRef = useRef(walkFollow);
  walkFollowRef.current = walkFollow;
  /** 跟随被打断回调（ref 化，避免事件绑定重跑） */
  const onWalkFollowBreakRef = useRef<NavMapProps["onWalkFollowBreak"]>(undefined);
  onWalkFollowBreakRef.current = onWalkFollowBreak;
  /** 步行结果回调放进 ref：避免 prop 变化导致查询 effect 重跑 */
  const onWalkNavResultRef = useRef<NavMapProps["onWalkNavResult"]>(undefined);
  onWalkNavResultRef.current = onWalkNavResult;
  /** 路线模式切换后触发站点图层重建（marker 的样式在创建时决定，必须重建才生效） */
  const [stationRebuildTick, setStationRebuildTick] = useState(0);
  /** 点击回调放进 ref：避免 prop 变化导致图层重新绑定事件 */
  const onStationClickRef = useRef<NavMapProps["onStationClick"]>(undefined);
  const onMapClickRef = useRef<NavMapProps["onMapClick"]>(undefined);
  const onMapReadyRef = useRef<NavMapProps["onMapReady"]>(undefined);
  /** ★ v2.10.0：方向回报回调（放进 ref，避免图层重建） */
  const onRouteDirsRef = useRef<NavMapProps["onRouteDirs"]>(undefined);
  /**
   * ★ 2026-09-22：`view` 的实时镜像。
   * 为什么需要：`applyLocateView` 是 `useCallback([])`（空依赖，避免定位回调重绑），
   *   拿不到最新的 `view`；而**定位是异步的**，它常在 view 取景之后完成 ⇒ 又把地图拉回
   *   「我的位置」居中 ⇒ 把目的地的取景覆盖掉（实测：标记掉进被弹窗遮住的下半屏）。
   *   ⇒ 用 ref 让定位逻辑知道「当前有外部取景意图」，有则**不再抢镜头**。
   */
  const viewRef = useRef<NavMapProps["view"]>(null);
  viewRef.current = view;
  /**
   * ★ 本批新增（需求① 取景稳定化 / AC-25~28 / 58 / 59）：
   *   · `destRef` / `originRef`：取景 effect **依赖收敛为 `[view.tick, phase]`** 后，
   *     程序化取景从 ref 读最新 OD（渲染期同步赋值，参照既有 `viewRef`）；
   *   · `followState` / `followRef`：让位锁状态机（`follow` ⇄ `free`）；
   *   · `programmaticRef`：程序化相机调用打标（区分手势 zoomstart 与程序 zoomstart）；
   *   · `lastCmdRef`：最后一次取景意图（恢复按钮/双击重放用）。
   */
  const destRef = useRef<NavMapProps["dest"]>(null);
  destRef.current = dest;
  const originRef = useRef<NavMapProps["origin"]>(null);
  originRef.current = origin;
  const [followState, setFollowState] = useState<"follow" | "free">("follow");
  const followRef = useRef(followState);
  followRef.current = followState;
  const programmaticRef = useRef(false);
  const lastCmdRef = useRef<NavMapProps["view"]>(null);

  /** 让位锁观测钩子（H1）：无副作用，仅 `setAttribute` */
  useEffect(() => {
    rootRef.current?.setAttribute("data-map-follow", followState);
  }, [followState]);

  /**
   * ★ 程序化相机调用**唯一打标入口**（§a.1）：`setZoomAndCenter` / `panBy` / `setBounds`
   *   一律包在本函数内 ⇒ `zoomstart` 中判 `programmaticRef.current` 即可区分
   *   「手势缩放」与「程序缩放」（350ms 覆盖动画时长）。
   */
  const applyCamera = useCallback((fn: () => void) => {
    programmaticRef.current = true;
    try {
      fn();
    } finally {
      window.setTimeout(() => {
        programmaticRef.current = false;
      }, 350);
    }
  }, []);

  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [note, setNote] = useState<string>("");
  const [locating, setLocating] = useState(false);

  /**
   * 定位落在澳门范围内 → 居中到定位点（横向 5km）；范围外 → 不移动地图。
   * 蓝点无论如何都按真实坐标落位。
   * @param focus 显式意图（点定位键）——`true` 时**跳过**「有 view 意图则不抢镜头」守卫，强制居中。
   */
  const applyLocateView = useCallback((pos: { lng: number; lat: number }, focus = false) => {
    const map = mapRef.current;
    const canvas = canvasRef.current;
    if (!map) return;
    const dist = districtRef.current;
    const inMacau = dist
      ? isInsideRings(pos.lng, pos.lat, [...dist.rings, ...dist.exclaveRings])
      : true; // 边界未知时按旧行为（居中）
    if (inMacau) {
      // ★ 2026-09-22：定位成功 ⇒ **清掉「无法定位」提示**（此前只设不清，定位恢复后提示仍挂着）
      setNote("");
      canvas?.setAttribute("data-locate-ok", "on");
      // ★ 2026-09-22：若调用方正在做**外部取景**（搜索弹窗要求「目的地居上半屏」或「两点适配」），
      //   定位**不再抢镜头** —— 否则异步定位完成后会把地图拉回「我的位置」居中，
      //   覆盖掉刚做好的取景（实测：标记因此掉进被弹窗遮住的下半屏）。蓝点照常落位。
      // ★ 本批：显式意图（focus=true，点定位键）⇒ 跳过该守卫，强制居中。
      if (!focus && viewRef.current && viewRef.current.mode !== "none") {
        canvas?.setAttribute("data-locate-skip-view", "on");
        return;
      }
      const w: number = map.getSize?.()?.width ?? (typeof window !== "undefined" ? window.innerWidth : 390);
      const z = zoomForAcross(pos.lat, w);
      try {
        applyCamera(() => map.setZoomAndCenter(z, [pos.lng, pos.lat]));
        canvas?.setAttribute("data-nav-zoom", String(z));
      } catch {
        /* 视角设置失败不影响底图 */
      }
    } else {
      // ★ 范围外：不自动移出（保持澳门视野）；蓝点如实落位（可能落在视野之外）
      canvas?.setAttribute("data-locate-outside", "on");
    }
  }, [applyCamera]);

  /**
   * ★ 2026-10-30（定位兜底）：**采纳一个已确认的定位点**（AMap 与浏览器定位共用）。
   *   · 画/更新 mepin（有 GPS 实时蓝点时不再画，避免双点）；
   *   · 边界就绪 → 取景判定；未就绪 → 暂存；
   *   · 回传宿主。
   */
  const acceptLocate = useCallback(
    (pos: { lng: number; lat: number }, focus: boolean) => {
      locatedRef.current = true;
      lastLocatePosRef.current = pos;
      canvasRef.current?.removeAttribute("data-locate-outside");
      canvasRef.current?.setAttribute("data-locate-ok", "on");
      setNote("");
      // ★ 本批：GPS 实时蓝点（UserDotLayer）存在时，**不再创建 mepin**（单一点，AC-40/41）。
      if (!userFix && mapRef.current) {
        const A = amapRef.current;
        if (userMarkerRef.current) userMarkerRef.current.setPosition([pos.lng, pos.lat]);
        else if (A) {
          userMarkerRef.current = new A.Marker({
            position: [pos.lng, pos.lat],
            content: '<div class="nav-map__mepin" aria-label="我的位置"></div>',
            offset: new A.Pixel(-9, -9),
            zIndex: 110,
          });
          mapRef.current.add(userMarkerRef.current);
        }
      }
      if (boundsAppliedRef.current) applyLocateView(pos, focus);
      else pendingLocateRef.current = { pos, focus }; // 边界未就绪 → 暂存，就绪后再决定
      onLocate?.(pos);
    },
    [applyLocateView, onLocate, userFix],
  );

  /**
   * 跑一次定位（首屏 + 右上定位按钮共用）。
   * 范围内 → 居中到定位点；范围外 → 不移动地图（保持澳门视野）；蓝点如实落位。
   *
   * ★ 2026-10-30：**两级定位** —— 先走高德 `AMap.Geolocation`（GCJ-02 直出）；
   *   失败（境外 IP / 服务不可用 / 权限被拒）再回落浏览器 `navigator.geolocation`
   *   （WGS84 → GCJ-02）。实测「无法定位」多因高德定位服务不可达，而浏览器定位可用。
   */
  const runLocate = useCallback(
    (opts?: { focus?: boolean }) => {
      const AMap = amapRef.current;
      const map = mapRef.current;
      if (!AMap || !map) return;
      const focus = opts?.focus === true;
      const geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10_000, convert: true });
      setLocating(true);
      geo.getCurrentPosition((status: string, result: any) => {
        if (status === "complete" && result?.position) {
          setLocating(false);
          // ★ position 已是 GCJ-02（convert:true）→ 不再转换
          acceptLocate({ lng: result.position.lng, lat: result.position.lat }, focus);
          return;
        }
        // 兜底：浏览器定位（WGS84 → GCJ-02）
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          setLocating(false);
          setNote("无法定位 · 请检查定位权限，或手动选择出发点");
          onLocate?.(null);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (p) => {
            setLocating(false);
            const g = wgs84ToGcj02({ lat: p.coords.latitude, lng: p.coords.longitude });
            acceptLocate({ lng: g.lng, lat: g.lat }, focus);
          },
          () => {
            setLocating(false);
            // ★ 定位失败 → 停在澳门视野（不重设视角）+ 提示（§D.1）
            setNote("无法定位 · 请检查定位权限，或手动选择出发点");
            onLocate?.(null);
          },
          { enableHighAccuracy: true, timeout: 8_000, maximumAge: 0 },
        );
      });
    },
    [acceptLocate, onLocate],
  );

  const init = useCallback(async () => {
    setPhase("loading");
    setNote("");
    try {
      if (!jsKey) throw new Error("缺少 AMAP_JS_KEY");
      const AMap = await loadAMap(jsKey, ["AMap.Geolocation", "AMap.DistrictSearch"]);
      amapRef.current = AMap;
      if (!canvasRef.current) return;
      // 先建图（放澳门中心，避免白屏）——边界就绪后再收敛视野。
      // ★ 2026-09-22 交互手感优化（用户反馈「操作要更丝滑舒适」）：
      //   · `rotateEnable:false` / `pitchEnable:false` —— 手机双指极易误触旋转与倾斜，
      //     转歪之后用户很难掰回来；这是公交导航，本就不需要 3D 视角 ⇒ 直接禁掉。
      //   · `keyboardEnable:false` —— 键盘方向键会平移地图，**与页面输入框抢按键**
      //     （在搜索框里按方向键会莫名挪地图）；移动端也用不到键盘操作 ⇒ 禁掉。
      //   · `animateEnable:true` / `jogEnable:true` —— 显式开启视图动画与惯性平移，
      //     拖拽后带惯性滑行，手感更顺。
      const map = new AMap.Map(canvasRef.current, {
        zoom: INIT_ZOOM,
        center: [MACAU_CENTER.lng, MACAU_CENTER.lat],
        viewMode: "2D",
        // ★ AC-16：隐藏底图自带的公交站点图标（走自定义样式）；未配置 ⇒ 用默认样式（降级安全）
        ...(mapStyleId ? { mapStyle: `amap://styles/${mapStyleId}` } : {}),
        resizeEnable: true,
        rotateEnable: false,
        pitchEnable: false,
        keyboardEnable: false,
        animateEnable: true,
        jogEnable: true,
      });
      mapRef.current = map;
      setPhase("ready");
      canvasRef.current?.setAttribute("data-nav-zoom", String(INIT_ZOOM));

      // ── ★ S1：澳门范围（限制 + 收敛 + 遮罩；异步，不阻塞）──
      const canvas = canvasRef.current;
      void (async () => {
        try {
          const dist = await loadMacauDistrict(AMap);
          if (mapRef.current !== map) return; // 已卸载/重建 → 丢弃结果
          districtRef.current = dist;
          const b = dist.bounds;
          const bounds = new AMap.Bounds([b.minLng, b.minLat], [b.maxLng, b.maxLat]);
          map.setLimitBounds(bounds); // ① 拖不出澳门
          map.setZooms([MIN_ZOOM, MAX_ZOOM]); // ② 拉不远
          applyCamera(() => map.setBounds(bounds)); // ③ 首屏 = 澳门全境（程序化，打标）
          boundsAppliedRef.current = true;
          canvas?.setAttribute("data-limit-bounds", "on");
          canvas?.setAttribute("data-limit-bounds-src", dist.source);
          canvas?.setAttribute("data-nav-zoom", String(map.getZoom?.() ?? ""));

          // ④ 域外遮罩（有大矩形 + 澳门官方环 + 能取到 Token 色才画；否则跳过）
          const fill = maskFill();
          if (dist.rings.length && fill) {
            try {
              const path = [maskOuterRing(b), ...dist.rings, ...dist.exclaveRings];
              maskRef.current = new AMap.Polygon({
                path,
                fillColor: fill,
                fillOpacity: MASK_OPACITY,
                strokeOpacity: 0,
                zIndex: 50, // 低于站点/定位/目的地标记（90+），避免压住可点元素
                bubble: false, // 不参与事件冒泡（镂空部分不触发事件）
              });
              map.add(maskRef.current);
              canvas?.setAttribute("data-map-mask", "on");
            } catch {
              canvas?.setAttribute("data-map-mask", "off");
            }
          } else {
            canvas?.setAttribute("data-map-mask", "off");
          }

          // 边界就绪前已拿到的定位 → 此刻再决定是否居中
          if (pendingLocateRef.current) {
            const p = pendingLocateRef.current;
            pendingLocateRef.current = null;
            applyLocateView(p.pos, p.focus);
          }
        } catch {
          // 连 setLimitBounds 都失败 → 完全降级（不阻塞任何功能）
          canvas?.setAttribute("data-limit-bounds", "off");
          canvas?.setAttribute("data-map-mask", "off");
        }
      })();

      // ── 地图中心读取器（供分步弹层第 2 步「用这个点」）──
      onMapReadyRef.current?.(() => {
        try {
          const c = mapRef.current?.getCenter?.();
          const lng = c?.getLng?.() ?? c?.lng;
          const lat = c?.getLat?.() ?? c?.lat;
          if (typeof lng === "number" && typeof lat === "number") return { lng, lat };
        } catch {
          /* ignore */
        }
        return null;
      });

      // ── 定位（★ S1：范围内才居中；范围外如实落位、不移动地图）──
      runLocate();
    } catch (e) {
      setPhase("failed");
      setNote((e as Error)?.message ?? "地图加载失败");
      onLocate?.(null);
    }
  }, [jsKey, mapStyleId, runLocate, applyLocateView, onLocate, applyCamera]);

  useEffect(() => {
    void init();
    return () => {
      try {
        mapRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      userMarkerRef.current = null;
      destMarkerRef.current = null;
      originMarkerRef.current = null;
      maskRef.current = null;
      districtRef.current = null;
      boundsAppliedRef.current = false;
      pendingLocateRef.current = null;
      lastLocatePosRef.current = null;
      // ★ 本批：卸载/重建（jsKey 变）→ 让位锁与程序化打标复位
      setFollowState("follow");
      programmaticRef.current = false;
      lastCmdRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsKey]);

  // ── 容器尺寸变化（全屏化 / 横竖屏）→ 地图 resize（防白屏/错位，风险 #2）──
  useEffect(() => {
    if (phase !== "ready") return;
    const onResize = () => {
      try {
        mapRef.current?.resize?.();
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // 布局稳定后再 resize 一次（全屏容器接管后尺寸才确定）
    const t = setTimeout(onResize, 200);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      clearTimeout(t);
    };
  }, [phase]);

  // ── 目的地标记 + ★ S2：居中到目的地（异步，不阻塞）──
  useEffect(() => {
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap || phase !== "ready") return;
    try {
      if (!dest) {
        if (destMarkerRef.current) {
          map.remove(destMarkerRef.current);
          destMarkerRef.current = null;
        }
        return;
      }
      const pos = [dest.lng, dest.lat];
      if (destMarkerRef.current) destMarkerRef.current.setPosition(pos);
      else {
        destMarkerRef.current = new AMap.Marker({
          position: pos,
          // ★ v3.3.0（AC-92 · ADR-102）：**内联 SVG**（不再经「外链文件 + CSS background + filter」）
          //   类名 `.nav-map__destpin` 保留（QA 选择器不失效）。
          content: '<div class="nav-map__destpin" aria-hidden="true">' + PIN_SVG_DEST + "</div>",
          // ★ v2.15：新终点钉 20×26，钉尖在底边中点 ⇒ offset y 取 -26（全高），
          //   令钉尖精确锚定坐标点（旧址 -20 是歪水滴的凑数值，会让尖浮在点上方）。
          offset: new AMap.Pixel(-10, -26),
          title: dest.label,
          zIndex: 120,
        });
        map.add(destMarkerRef.current);
      }
      // ★ S2「地图标定」：选完目的地 → 居中到该点（限制范围内自动收敛）
      // ★ 2026-09-22：若调用方给了 `view`（新版搜索弹窗），取景改由下面的 view effect 统一负责
      //   —— 因为那时需要「居上半屏」或「适配两点」，不能简单 setCenter。不传 `view` 时保持原行为。
      // ★ 本批：`free` 让位锁生效时**不抢镜头**（用户此后不再被打断，AC-27）。
      if (!view && followRef.current !== "free") {
        try {
          applyCamera(() => map.setCenter(pos));
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 标记失败不影响底图 */
    }
  }, [dest, phase, view, applyCamera]);

  // ── ★ 2026-09-22 新增：**出发地标记**（选完出发地后与目的地同时显示）──
  useEffect(() => {
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap || phase !== "ready") return;
    try {
      if (!origin) {
        if (originMarkerRef.current) {
          map.remove(originMarkerRef.current);
          originMarkerRef.current = null;
        }
        return;
      }
      const pos = [origin.lng, origin.lat];
      if (originMarkerRef.current) originMarkerRef.current.setPosition(pos);
      else {
        originMarkerRef.current = new AMap.Marker({
          position: pos,
          // ★ v3.3.0（AC-92 · ADR-102 · 硬口径）：**内联 SVG 红钉**（`#B4342A`）——
          //   起点语义恒由红钉承载（含「起点 = 我的位置」），**不得以蓝点替代**；类名保留。
          content: '<div class="nav-map__originpin" aria-hidden="true">' + PIN_SVG_ORIGIN + "</div>",
          // ★ v3.1.1 #4：由 18px 圆点改为钉形（20×26，钉尖在底边中点）⇒ offset 同终点钉
          //   （-10, -26 = -w/2, -h）令**钉尖**精确锚定坐标点。
          offset: new AMap.Pixel(-10, -26),
          title: origin.label,
          zIndex: 110,
        });
        map.add(originMarkerRef.current);
      }
    } catch {
      /* 标记失败不影响底图 */
    }
  }, [origin, phase]);

  /**
   * ★ 2026-09-22 新增：**视口取景**（新版搜索弹窗覆盖在地图上时用）。
   * 为什么需要独立的取景函数：新版弹窗是**覆盖层**（下半屏遮住地图）。
   *   若沿用「容器中心居中」，标记会落进被遮住的下半屏 ⇒ 用户看不见 ✗
   *   ⇒ `dest-center-top` 把视口上移 1/4 屏；`fit-two` 自算让两点都落在上半屏。
   *
   * ★ 本批（需求① / AC-59）：抽出 **`applyView(cmd)` —— 唯一相机入口**。
   *   只被两处调用：① 取景 effect（`view.tick` 变化）；② 恢复按钮 / 双击地图 `restore()`。
   *   **严禁**在任何数据 effect（总览绘制 / 站点图层 / 车辆 / OD 标记）中调用。
   *   所有 `setZoomAndCenter` / `panBy` 一律经 `applyCamera` 打标（区分手势/程序缩放）。
   */
  const applyView = useCallback(
    (cmd: NavMapProps["view"]) => {
      const map = mapRef.current;
      if (!map || !cmd || cmd.mode === "none") return;
      const dest = destRef.current;
      const origin = originRef.current;
      const winH = typeof window !== "undefined" ? window.innerHeight : 800;

      if (cmd.mode === "dest-center-top") {
        if (!dest) return;
        try {
          // ★ 关键点：`immediately=true`（第 3 参）**关掉缩放动画**。
          //   踩坑记录（三次尝试）：
          //     ① `setZoomAndCenter` 默认带动画，紧随的 `panBy` 被动画中断 ⇒ 标记停在下半屏；
          //     ② 改用 `setFitView` + 45% 底部留白 ⇒ 改善但仍偏下；
          //     ③ 留白提到 70% ⇒ **过度矫正，标记被推出视野**。
          //   ⇒ 正解：先**无动画**居中，再平移固定比例 —— 可控且可预期。
          const size = map.getSize?.() ?? { width: 390, height: winH };
          const h: number = size.height ?? winH;
          /**
           * ★ 2026-09-24：改按**真实遮挡区**取景 —— 读 RoutePanel（`.rpanel`）真实顶边，
           *   把点从整屏中心抬到「面板上方可见区」的中心；读不到（桌面右栏 / 异常）⇒
           *   回落旧口径「上移 1/5 屏」。
           */
          const panelTop = panelTopPx(h);
          applyCamera(() => {
            map.setZoomAndCenter(16, [dest.lng, dest.lat], true);
            map.panBy(0, panelTop !== null ? Math.round(h / 2 - panelTop / 2) : Math.round(h * 0.2));
          });
        } catch {
          /* ignore */
        }
        return;
      }

      if (cmd.mode === "fit-two") {
        if (!origin || !dest) return;
        /**
         * ★ 2026-09-22 二次修复「选完出发地后地图跑到珠海/西边」。
         *
         * 前一版用 `setFitView(overlays, …)` + 等 marker 就绪重试 —— **实测仍然失效**：
         *   取景后 zoom 掉到最小值 11（= 一屏 27.6km），中心跑到珠海斗门/黄杨山一带 ✗
         *   （`setFitView` 内部会参考 `setLimitBounds` 与遮罩范围，在这个「底图限制在澳门」
         *     的场景下把视野撑到了极限。）
         *
         * 现改为**完全自算**，不依赖任何 marker 或 fitView：
         *   ① 中心 = 两点中点；
         *   ② 由经纬跨度**反推 zoom**（留 1.25 倍余量），可用像素 = **未被面板遮挡的区域**；
         *   ③ `setZoomAndCenter(..., immediately=true)` 无动画落位，再 `panBy` 把中点抬到
         *      「可见槽中心」。
         * ★ 2026-09-24：可用高度由「写死半屏」改为 **RoutePanel 真实顶边**（读不到回落半屏）。
         */
        try {
          const centerLat = (origin.lat + dest.lat) / 2;
          const centerLng = (origin.lng + dest.lng) / 2;
          const size = map.getSize?.() ?? { width: 390, height: 700 };
          // 可用视野：宽留 50px/侧（marker 宽约 30px + 呼吸位）；高 = 面板顶边以上，留 20px 呼吸位
          const availW = Math.max(80, size.width - 100);
          const panelTop = panelTopPx(size.height);
          const slotTop = panelTop !== null ? panelTop : Math.round(size.height / 2);
          const availH = Math.max(80, slotTop - 20);
          // 两点跨度 × 1.25：让两点占据可用区的大部分（取 2.8 会太保守 ⇒ zoom 被压到 11）
          const lngSpan = Math.max(Math.abs(origin.lng - dest.lng) * 1.25, 1e-5);
          const latSpan = Math.max(Math.abs(origin.lat - dest.lat) * 1.25, 1e-5);
          const zx = Math.log2((360 * availW) / (256 * lngSpan));
          const zy = Math.log2(
            (360 * availH) / (256 * latSpan * Math.cos((centerLat * Math.PI) / 180)),
          );
          // 下限 12：跨全澳的远距离 OD 也至少能看清陆地方位；上限 16：两点很近时不要怼到街景级
          const z = Math.max(12, Math.min(16, Math.floor(Math.min(zx, zy))));
          applyCamera(() => {
            map.setZoomAndCenter(z, [centerLng, centerLat], true);
            // 把「两点中点」从整屏中心抬到「可见槽中心」；回落口径 = 上移 1/4 屏
            map.panBy(
              0,
              panelTop !== null ? Math.round(size.height / 2 - panelTop / 2) : Math.round(size.height / 4),
            );
          });
          canvasRef.current?.setAttribute("data-nav-zoom", String(z));
          canvasRef.current?.setAttribute("data-view-mode", "fit-two-selfcalc");
        } catch {
          /* ignore */
        }
        return;
      }

      /**
       * ★ 2026-09-23：`fit-box` —— 把外包框适配进「面板顶边以上的可视槽」（自算，禁 setBounds）。
       * `slotTopPx` = 当前档面板顶边像素（full≈12vh / half=50vh / peek=80vh）；
       * 复用 `fit-two` 的反推 zoom 逻辑（宽/高按可用区，留呼吸位），再把框中心抬到「顶部槽中心」。
       * ★ 2026-09-24：呼吸边距接上设计 Token `--map-fit-gap`（此前悬空未接线；回落 20）。
       */
      if (cmd.mode === "fit-box") {
        const box = cmd.box;
        if (!box) return;
        try {
          const size = map.getSize?.() ?? { width: 390, height: 700 };
          const slotTop = Math.max(80, Math.round(cmd.slotTopPx ?? size.height * 0.12));
          const centerLat = (box.minLat + box.maxLat) / 2;
          const centerLng = (box.minLng + box.maxLng) / 2;
          // 可用区：宽留 50px/侧；高只用「顶边以上区域」，上下各留 gap 呼吸位
          const gap = fitGapPx();
          const availW = Math.max(80, size.width - 100);
          const availH = Math.max(80, slotTop - gap * 2);
          const lngSpan = Math.max((box.maxLng - box.minLng) * 1.25, 1e-5);
          const latSpan = Math.max((box.maxLat - box.minLat) * 1.25, 1e-5);
          const zx = Math.log2((360 * availW) / (256 * lngSpan));
          const zy = Math.log2(
            (360 * availH) / (256 * latSpan * Math.cos((centerLat * Math.PI) / 180)),
          );
          const z = Math.max(12, Math.min(16, Math.floor(Math.min(zx, zy))));
          applyCamera(() => {
            map.setZoomAndCenter(z, [centerLng, centerLat], true);
            // 框中心：从整屏中心（size.height/2）抬到「顶部槽中心」（slotTop/2）
            map.panBy(0, Math.round(size.height / 2 - slotTop / 2));
          });
          canvasRef.current?.setAttribute("data-nav-zoom", String(z));
          canvasRef.current?.setAttribute("data-view-mode", "fit-box-selfcalc");
        } catch {
          /* ignore */
        }
      }
    },
    [applyCamera],
  );

  /** 恢复入口：回到跟随 + 重放最后一次取景意图（§a.4） */
  const restore = useCallback(() => {
    setFollowState("follow");
    const cmd = lastCmdRef.current ?? viewRef.current;
    if (cmd && cmd.mode !== "none") applyView(cmd);
  }, [applyView]);

  /**
   * 取景 effect（★ 依赖收敛为 `[view.tick, phase]`；`dest/origin` 改 ref 读）：
   *   · **让位锁**（AC-59 核心）：`free` 态**跳过一切自动取景**（含 `frame()` 指令）；
   *   · 记录最后一次意图（`lastCmdRef`）供 `restore()` 重放。
   */
  const viewTick = view?.tick ?? 0;
  useEffect(() => {
    const cmd = viewRef.current;
    if (!cmd || cmd.mode === "none") return;
    lastCmdRef.current = cmd;
    if (phase !== "ready") return;
    if (followRef.current === "free") return; // ★ 让位锁：free 态跳过一切自动取景
    applyView(cmd);
  }, [viewTick, phase, applyView]);

  /**
   * ★ 本批：让位锁事件注册（dragstart / zoomstart / dblclick）。
   *   · `dragstart` 恒为用户行为 ⇒ free；
   *   · `zoomstart` 仅当**非程序化**（`programmaticRef`）时 ⇒ free；
   *   · `dblclick` ⇒ `restore()`（辅助恢复入口）。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    if (!map) return;
    const onDragStart = () => {
      setFollowState("free");
      // ★ 第二期：步行跟随中用户拖动地图 = 明确「不想被钉住」⇒ 通知宿主退出跟随
      if (walkFollowRef.current) {
        walkSkipRestoreRef.current = true; // 拖动中不跳相机
        onWalkFollowBreakRef.current?.();
      }
    };
    const onZoomStart = () => {
      if (!programmaticRef.current) setFollowState("free");
    };
    const onDblClick = () => restore();
    map.on("dragstart", onDragStart);
    map.on("zoomstart", onZoomStart);
    map.on("dblclick", onDblClick);
    return () => {
      try {
        map.off("dragstart", onDragStart);
        map.off("zoomstart", onZoomStart);
        map.off("dblclick", onDblClick);
      } catch {
        /* ignore */
      }
    };
  }, [phase, restore]);

  /**
   * ★ 本批：观测钩子 H2 `data-map-zoom`（**实时**实测 zoom；AC-25/26/59 跨刷新比对）。
   *   ⚠️ 与既有 `data-nav-zoom`（程序设定值）语义不同，勿混用。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    if (!map) return;
    const write = () => {
      try {
        rootRef.current?.setAttribute("data-map-zoom", String(map.getZoom()));
      } catch {
        /* ignore */
      }
    };
    write();
    map.on("zoomend", write);
    return () => {
      try {
        map.off("zoomend", write);
      } catch {
        /* ignore */
      }
    };
  }, [phase]);

  /**
   * ★ 本批（需求⑤ / AC-40/41）：GPS 实时蓝点存在时**移除 mepin**（两者不并存）；
   *   蓝点消失（拒权/无信号）且已定位过 ⇒ 用最近坐标**重建 mepin**。
   */
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map) return;
    try {
      if (userFix) {
        if (userMarkerRef.current) {
          map.remove(userMarkerRef.current);
          userMarkerRef.current = null;
        }
        return;
      }
      const pos = lastLocatePosRef.current;
      if (locatedRef.current && pos && !userMarkerRef.current && AMap) {
        userMarkerRef.current = new AMap.Marker({
          position: [pos.lng, pos.lat],
          content: '<div class="nav-map__mepin" aria-label="我的位置"></div>',
          offset: new AMap.Pixel(-9, -9),
          zIndex: 110,
        });
        map.add(userMarkerRef.current);
      }
    } catch {
      /* ignore */
    }
  }, [userFix, phase]);

  // ★ 同步点击回调到 ref（避免回调变化导致图层重建）
  useEffect(() => {
    onStationClickRef.current = onStationClick;
  }, [onStationClick]);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  // ★ 同步「地图中心读取器」回调到 ref
  useEffect(() => {
    onMapReadyRef.current = onMapReady;
  }, [onMapReady]);

  // ★ 同步「方向回报」回调到 ref
  useEffect(() => {
    onRouteDirsRef.current = onRouteDirs;
  }, [onRouteDirs]);
  // ★ 车辆点击回调直接交给 `VehicleLayer`（原生化层自管 ref），此处不再缓存

  // ★ 定位按钮（品牌栏原位 / 导航态浮动）：locateTick 变化 → **立即聚焦 + 后台刷新**
  //   ★ 本批：点定位键 = **显式意图** ⇒ 先恢复跟随，再强制居中（`focus: true`，AC-27）
  //   ★ v3.3.0（AC-101）：**先**用「最近一次已知位置」立即居中（不等待新 fix）；
  //     无已知位置（冷启动 / 首次定位尚未返回）⇒ 只走 `runLocate`（其 `setLocating(true)` 即加载态）。
  useEffect(() => {
    if (locateTick > 0) {
      setFollowState("follow"); // 恢复跟随（让位锁解除）
      const known =
        lastLocatePosRef.current ?? (userFix ? { lng: userFix.lng, lat: userFix.lat } : null);
      if (known) applyLocateView(known, true); // 立即聚焦（不等新 fix）
      runLocate({ focus: true }); // 后台刷新（到达后用更准坐标再校正一次）
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateTick]);

  // ── 地图空白处点击（S2 分步搜索「地图标定」）──
  useEffect(() => {
    if (phase !== "ready") return;
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: any) => {
      const lng = e?.lnglat?.getLng?.() ?? e?.lnglat?.lng;
      const lat = e?.lnglat?.getLat?.() ?? e?.lnglat?.lat;
      if (typeof lng === "number" && typeof lat === "number") onMapClickRef.current?.({ lng, lat });
    };
    map.on("click", onClick);
    return () => {
      try {
        map.off("click", onClick);
      } catch {
        /* ignore */
      }
    };
  }, [phase]);

  // ── ★ 巴士站点图层（仅阈值内、仅视野内）──
  useEffect(() => {
    if (phase !== "ready") return;
    const AMap = typeof window !== "undefined" ? window.AMap : undefined;
    const map = mapRef.current;
    if (!map || !AMap) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

    const clearAll = () => {
      for (const [, mk] of stationMarkersRef.current) {
        try {
          map.remove(mk);
        } catch {
          /* ignore */
        }
      }
      stationMarkersRef.current.clear();
    };

    const render = () => {
      if (cancelled) return;
      try {
        const zoom = typeof map.getZoom === "function" ? map.getZoom() : 0;
        // ★ 无副作用观测钩子（同 `data-nav-zoom` 传统）：自动化验收读取实际生效的 zoom
        canvasRef.current?.setAttribute("data-nav-z", String(zoom));
        // ★ 本批（需求② / AC-29~31）：**站点白名单**
        //   · 宿主在路线查看 / 导航模式传入 `lineStops`（各腿站点并集）；
        //   · 空集保护：`lineStops` 空 ⇒ 折成 null（不过滤）；路线模式回落 `routeStopsRef`。
        const white =
          lineStops && lineStops.size > 0
            ? lineStops
            : routeStopsRef.current.size > 0
              ? routeStopsRef.current
              : null;
        // ★ 观测钩子 H3：站点图层过滤态（nav=白名单 / route=本线 / all=不过滤）
        //   ⚠️ 契约（07 §1.1/§1.2）：**唯一挂载点 = `.nav-map` 根**（选择器 `.nav-map[data-station-layer]`）
        rootRef.current?.setAttribute(
          "data-station-layer",
          lineStops && lineStops.size > 0 ? "nav" : routeStopsRef.current.size > 0 ? "route" : "all",
        );
        // ★ 2026-09-22：路线模式下阈值放宽（否则长线缩到全澳后站点全消失，看不到高亮）
        // ★ 本批：导航模式（白名单）同样放宽 —— 详情 fit-box 常在 zoom≈13 ⇒ 沿用路线档阈值
        const routeMode = routeStopsRef.current.size > 0 || (!!lineStops && lineStops.size > 0);
        const minZoom = routeMode ? STATION_MIN_ZOOM_ROUTE : STATION_MIN_ZOOM;
        if (zoom < minZoom) {
          clearAll(); // 拉远：清空（产品口径）
          return;
        }
        const data = stationsRef.current;
        if (!data) return;
        const bounds = typeof map.getBounds === "function" ? map.getBounds() : null;
        if (!bounds) return;
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const visible = new Set<string>();
        const stationMain = (c: string) => /^[A-Za-z]+\d+/.exec(String(c ?? ""))?.[0] ?? String(c ?? "");
        for (const s of data) {
          // ★ 白名单外 ⇒ **不创建 marker**（数据层过滤，非 opacity/display 隐藏；AC-29）
          if (white && !white.has(stationMain(s.code))) continue;
          if (s.lat < sw.lat || s.lat > ne.lat || s.lng < sw.lng || s.lng > ne.lng) continue;
          visible.add(s.code);
          if (stationMarkersRef.current.has(s.code)) continue;
          // ★ 2026-09-22：轻轨站与巴士站**样式区分**（产品要求）；
          // ★ v2.10.0：改为「**形状优先**」——
          //   巴士 = 实心青花蓝圆 Ø10；轻轨 = **线路主题色方** 13×13 r3；
          //   换乘站（蓮花 / 協和醫院）= 双色切分。
          //   颜色是**数据**：直接取 `/api/stations` 的 `color/color2`（源头 `routes.color`），
          //   一律以**行内 CSS 变量**注入 —— CSS 里只写渐变**结构**（禁止硬编码线路色）。
          //   切法（斜切/水平切）是**形状结构**、非数据 ⇒ 查 `lrt-transfer.ts`。
          const isLrt = s.kind === "lrt";
          let cutCls = "";
          let styleAttr = "";
          if (isLrt) {
            const c1 = s.color;
            const c2 = s.color2;
            if (c1) styleAttr = ` style="--c1:${esc(c1)}${c2 ? `;--c2:${esc(c2)}` : ""}"`;
            const variant = c2 ? lrtTransferVariantOf(s.code) : undefined;
            if (variant) cutCls = variant === "diag" ? " lrt-cut-diag" : " lrt-cut-half";
          }
          // ★ 2026-09-22 路线查看模式：本线站点高亮放大、其他站点变灰变小（「一眼分辨」）
          const inRoute = routeStopsRef.current.size > 0;
          const isOnRoute = inRoute && routeStopsRef.current.has(s.code);
          const routeCls = !inRoute ? "" : isOnRoute ? " nav-map__station--onroute" : " nav-map__station--dim";
          const cls = `nav-map__station${isLrt ? " nav-map__station--lrt" : ""}${cutCls}${routeCls}`;
          const marker = new AMap.Marker({
            position: [s.lng, s.lat],
            content: `<div class="${cls}" data-code="${esc(s.code)}"${styleAttr} title="${esc(s.name)}"></div>`,
            // ★ v2.10.1：站点盒尺寸**分类型**（巴士 11px / 轻轨 13px，见 globals.css）
            //   ⇒ 居中偏移各取一半（-5.5 / -6.5），否则小圆点会偏离真实坐标约 1px
            offset: new AMap.Pixel(isLrt ? -6.5 : -5.5, isLrt ? -6.5 : -5.5),
            zIndex: isLrt ? 95 : 90,
          });
          marker.on("click", () => onStationClickRef.current?.(s));
          map.add(marker);
          stationMarkersRef.current.set(s.code, marker);
        }
        // 移出视野的点：逐个 remove 清理（防泄漏）
        for (const [code, mk] of [...stationMarkersRef.current]) {
          if (visible.has(code)) continue;
          try {
            map.remove(mk);
          } catch {
            /* ignore */
          }
          stationMarkersRef.current.delete(code);
        }
      } catch {
        /* 图层失败不影响底图 */
      } finally {
        // ★ 无副作用观测钩子：无论走哪个分支，都回写当前已渲染站点数（拉远/清空后 = 0）
        canvasRef.current?.setAttribute("data-station-count", String(stationMarkersRef.current.size));
      }
    };

    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        render();
      }, STATION_REFRESH_THROTTLE_MS);
    };

    map.on("zoomend", schedule);
    map.on("moveend", schedule);

    // 一次性拉全量站点（ref 缓存；失败静默，不影响其他功能）
    // ★ 2026-09-22：带 `include=lrt` —— 导航页地图需要**巴士 + 轻轨**两种站点
    //   （首页那个图层仍是不带参数的「只巴士」，口径各自独立、互不影响）。
    if (!stationsRef.current) {
      /**
       * ★ v2.10.1：URL 加**版本参数** `v=2` —— 强制让此前的缓存失效。
       *
       * 为什么必须加：v2.10.0 起 `/api/stations` 才开始下发线路色（`color/color2`），
       * 但旧版响应已被**浏览器 HTTP 缓存 + CDN** 存下（`cache-control: public`），
       * 而本请求用的是 `cache: "force-cache"`（最激进：宁可用过期副本也不发请求）
       * ⇒ 实测出现「轻轨站显示成巴士同色」——因为 `--c1` 缺失，CSS 回落到 `var(--primary)` ✗
       *
       * 加 `v=2` 后 URL 变化 ⇒ 旧缓存自然失效；之后 `force-cache` 仍是快速路径。
       * ⚠️ 以后 `/api/stations` 的**响应结构再变**时，把这个版本号 +1 即可。
       */
      fetch("/api/stations?include=lrt&v=2", { cache: "force-cache" })
        .then((r) => r.json())
        .then((j: { stations?: StationPointLite[] }) => {
          if (cancelled) return;
          stationsRef.current = Array.isArray(j.stations) ? j.stations : [];
          render();
        })
        .catch(() => {
          console.warn("[NavMap] 站点列表加载失败（站点图层不可用，不影响其他功能）");
          stationsRef.current = [];
        });
    } else {
      render();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try {
        map.off("zoomend", schedule);
        map.off("moveend", schedule);
      } catch {
        /* ignore */
      }
      clearAll();
    };
    /**
     * ★ 2026-09-23 修复：依赖数组补上 `phase`。
     *
     * 回归史：v2.9.0 为「路线模式重建站点图层」把依赖从 `[phase]` 改成了 `[stationRebuildTick]`，
     *   而本 effect 开头有 `if (phase !== "ready") return;` —— 组件挂载时 phase 仍是 "loading"，
     *   执行即 return；等地图就绪（phase → "ready"）时 **effect 不会重跑**（依赖没变）
     *   ⇒ **普通地图模式下站点图层从未启动**（拉近拉远都不显示；线上实测 `data-station-count` 恒为 null）。
     *   之所以一直没暴露：进出「路线查看模式」会触发 `stationRebuildTick` 重建，站点侥幸显示过一次。
     * ⇒ 补回 `phase`：loading → ready 时重新执行，图层正常启动。
     *
     * ★ 本批：依赖补 `lineStops` —— 白名单变化（进入/退出导航）时重建站点图层
     *   （marker 的「建/不建」在创建时决定，必须重建才生效）。
     */
  }, [phase, stationRebuildTick, lineStops]);

  /**
   * ★ 2026-09-22：**路线查看模式** —— 画线 + 站点区分 + 自动装下整条线。
   *
   * 数据 `GET /api/route-shapes?code=`（读 `route_shapes`，离线抓取的高德真实走向）：
   *   · 坐标是 **GCJ-02**（高德原生）⇒ **直接**喂地图，**不做任何转换**
   *     （⚠️ 与库内 `stations` 的 WGS84 不同源，但 `/api/stations` 出口已转 GCJ-02，
   *       所以本页两组数据在同一坐标系里，可直接叠加）；
   *   · 双方向线路返回多条 `shapes`（带 `dir` = `dsat_dir`）⇒ **只画当前方向**
   *     （`shapes.filter(s => s.dir === routeLine.dir)`）；未指定 `dir` 时按第一个方向渲染，
   *     并通过 `onRouteDirs` 把可用方向回报给上层（判定单向/双向 + 补齐 `dir`）。
   *
   * 站点区分（产品口径「一眼分辨」）：本线站点 → `--onroute`（放大）；其他 → `--dim`（灰小）。
   * 视野：按**当前方向** line 的包围盒 `setBounds`（换向时重算，Spec AC-11）。
   */
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;

    const clearLines = () => {
      for (const p of routePolylinesRef.current) {
        try {
          map.remove(p as never);
        } catch {
          /* ignore */
        }
      }
      routePolylinesRef.current = [];
    };
    /** 清空站点 marker ⇒ 下一次 render 会用新样式重建 */
    const dropStationMarkers = () => {
      for (const [, mk] of stationMarkersRef.current) {
        try {
          map.remove(mk);
        } catch {
          /* ignore */
        }
      }
      stationMarkersRef.current.clear();
      setStationRebuildTick((t) => t + 1);
    };

    // 退出路线模式：清线 + 站点样式回落
    if (!routeLine) {
      clearLines();
      if (routeStopsRef.current.size > 0) {
        routeStopsRef.current = new Set();
        dropStationMarkers();
      }
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`/api/route-shapes?code=${encodeURIComponent(routeLine.code)}`, {
          cache: "force-cache",
        });
        const j = (await r.json()) as {
          color?: string;
          stops?: string[];
          shapes?: { dir?: string; polyline: string; bounds: [number, number, number, number] }[];
        };
        if (cancelled || mapRef.current !== map) return;

        clearLines();
        const color = j.color ?? routeLine.color ?? "#276299";
        const shapes = j.shapes ?? [];

        // ★ v2.10.0：回报该线路**可用方向**（上层判定单向/双向 + 补齐 `routeLine.dir`）
        const allDirs = [...new Set(shapes.map((s) => s.dir).filter((d): d is string => !!d))];
        onRouteDirsRef.current?.(allDirs);

        // ★ v2.10.0：**只画当前方向**（Spec §5.2）。
        //   根因：旧实现 `for (const s of shapes)` 把两个方向**全画**了。
        //   未指定 `dir` 时按第一个方向渲染（上层随后会补上，行为一致）。
        const dir = routeLine.dir ?? allDirs[0];
        const shown = dir ? shapes.filter((s) => s.dir === dir) : shapes;

        for (const s of shown) {
          const path = s.polyline
            .split(";")
            .map((p) => p.split(",").map(Number))
            .filter((a) => a.length === 2 && a.every(Number.isFinite)) as [number, number][];
          if (path.length < 2) continue;
          const pl = new AMap.Polyline({
            path,
            strokeColor: color,
            strokeWeight: 6,
            strokeOpacity: 0.92,
            lineJoin: "round",
            lineCap: "round",
            showDir: true,
            zIndex: 70,
          });
          map.add(pl);
          routePolylinesRef.current.push(pl);
        }

        routeStopsRef.current = new Set(j.stops ?? []);

        // 视野：装下**当前方向**的线（按已选方向的包围盒重算，Spec AC-11）
        if (shown.length) {
          const lngs: number[] = [];
          const lats: number[] = [];
          for (const s of shown) {
            if (!Array.isArray(s.bounds) || s.bounds.length !== 4) continue;
            lngs.push(s.bounds[0], s.bounds[2]);
            lats.push(s.bounds[1], s.bounds[3]);
          }
          if (lngs.length) {
            try {
              const b = new AMap.Bounds(
                [Math.min(...lngs), Math.min(...lats)],
                [Math.max(...lngs), Math.max(...lats)],
              );
              applyCamera(() => map.setBounds(b, true, [40, 40, 40, 40]));
            } catch {
              /* ignore */
            }
          }
        }

        dropStationMarkers();
      } catch {
        /* 静默：画不出线不影响底图 */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeLine, applyCamera]);

  /**
   * ★ 2026-09-23：**路线总览绘制**（详情 pane）。
   * 绘制主体已抽到 `nav-map-overview.ts#drawOverview`（§5.3 拆分）；本 effect 只管生命周期
   * （进入 detail 画一次；退出 detail / 非 ready → 逐个 `map.remove()` 清理 + 观测钩子归零）。
   */
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;
    if (!map || !AMap) return;

    const clearOverview = () => {
      for (const p of overviewPolylinesRef.current) {
        try {
          map.remove(p as never);
        } catch {
          /* ignore */
        }
      }
      overviewPolylinesRef.current = [];
    };

    // 非 ready / 无总览 → 清空；★ 显式置 0（契约语义：0 = 不可绘 / 未就绪 ⇒ QA 可稳定断言）
    if (phase !== "ready" || !overview || !overview.length) {
      clearOverview();
      canvasRef.current?.setAttribute("data-overview-legs", "0");
      return;
    }

    clearOverview();
    const { polylines, drawn } = drawOverview(map, AMap, overview);
    overviewPolylinesRef.current = polylines;
    canvasRef.current?.setAttribute("data-overview-legs", String(drawn));
    return () => clearOverview();
  }, [overview, phase]);

  /**
   * ★ 2026-10-29：**步行导航**（高德 JS API `AMap.Walking`，经 `/_AMapService` 代理）。
   *
   * · 只在 `phase=ready` 且有请求时查询；`null` / 切段 → 先清旧折线；
   * · 结果（距离/时长/转向步骤）经 `onWalkNavResult` 回传，面板由 `NavShell` 渲染；
   * · 失败也回传显式错误 ⇒ 面板显示「重试」，不留空白；
   * · `cancelled` 防 StrictMode 双跑 / 切段后旧结果覆盖新段；
   * · 取景按路径跨度选 14~17 级（不走 `setFitView` —— 本项目 `setLimitBounds` 下会跑偏）。
   */
  useEffect(() => {
    const map = mapRef.current;
    const AMap = amapRef.current;

    const clearWalk = () => {
      for (const p of walkPolylinesRef.current) {
        try {
          map?.remove(p as never);
        } catch {
          /* ignore */
        }
      }
      walkPolylinesRef.current = [];
    };

    if (phase !== "ready" || !map || !AMap || !walkNav) {
      clearWalk();
      walkViewRef.current = null;
      return;
    }
    clearWalk();

    let cancelled = false;
    const fail = (error: string) => {
      if (!cancelled) onWalkNavResultRef.current?.({ ok: false, error });
    };

    const run = () => {
      if (cancelled) return;
      let walking: any;
      try {
        walking = new AMap.Walking({ map: null, hideRouteList: true, isOutline: false, autoFitView: false });
      } catch {
        fail("步行插件初始化失败");
        return;
      }
      walking.search(
        [walkNav.from.lng, walkNav.from.lat],
        [walkNav.to.lng, walkNav.to.lat],
        (status: string, result: any) => {
          if (cancelled) return;
          if (status !== "complete" || !result?.routes?.length) {
            fail(status === "error" ? "步行路线查询失败，请稍后重试" : "未找到可行步行路线");
            return;
          }
          const route = result.routes[0];
          const steps = (route.steps ?? []).map((s: any) => ({
            instruction: String(s.instruction ?? "继续步行"),
            distanceM: Number(s.distance ?? 0) || 0,
          }));

          // 第二期：同时保留「对象数组（供宿主算进度）」与「元组数组（供 Polyline）」
          const pathPts: { lng: number; lat: number }[] = [];
          const path: [number, number][] = [];
          for (const s of route.steps ?? []) {
            for (const p of s.path ?? []) {
              const lng = typeof p?.getLng === "function" ? p.getLng() : p?.lng ?? p?.[0];
              const lat = typeof p?.getLat === "function" ? p.getLat() : p?.lat ?? p?.[1];
              if (Number.isFinite(lng) && Number.isFinite(lat)) {
                pathPts.push({ lng, lat });
                path.push([lng, lat]);
              }
            }
          }
          if (path.length < 2) {
            fail("未获取到步行路径");
            return;
          }

          let view: { zoom: number; center: [number, number] } | null = null;
          try {
            const accent =
              getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1b4d8f";
            const line = new AMap.Polyline({
              path,
              strokeColor: accent,
              strokeWeight: 6,
              borderWeight: 1,
              lineJoin: "round",
              lineCap: "round",
              showDir: true,
              zIndex: 76,
            });
            map.add(line);
            walkPolylinesRef.current.push(line);

            let minLng = Infinity;
            let minLat = Infinity;
            let maxLng = -Infinity;
            let maxLat = -Infinity;
            for (const [lng, lat] of path) {
              if (lng < minLng) minLng = lng;
              if (lat < minLat) minLat = lat;
              if (lng > maxLng) maxLng = lng;
              if (lat > maxLat) maxLat = lat;
            }
            const clng = (minLng + maxLng) / 2;
            const clat = (minLat + maxLat) / 2;
            const spanM = Math.max(
              (maxLng - minLng) * 111320 * Math.cos((clat * Math.PI) / 180),
              (maxLat - minLat) * 111320,
            );
            const zoom = spanM <= 450 ? 17 : spanM <= 900 ? 16 : spanM <= 1800 ? 15 : 14;
            view = { zoom, center: [clng, clat] };
            // 跟随中不抢镜头（相机由下面的跟随 effect 钉在 GPS 点上）
            if (!walkFollowRef.current) applyCamera(() => map.setZoomAndCenter(zoom, [clng, clat]));
          } catch {
            /* 画线失败不影响结果面板 */
          }
          walkViewRef.current = view;

          onWalkNavResultRef.current?.({
            ok: true,
            distanceM: Number(route.distance ?? 0) || 0,
            durationMin: (Number(route.time ?? 0) || 0) / 60,
            steps,
            path: pathPts,
          });
        },
      );
    };

    if (typeof AMap.plugin === "function") AMap.plugin("AMap.Walking", run);
    else fail("地图未加载步行插件");

    return () => {
      cancelled = true;
      clearWalk();
    };
  }, [walkNav, phase, applyCamera]);

  /**
   * ★ 2026-10-29（第二期）：**跟随相机** —— `walkFollow && walkPos` 时每帧把当前 GPS 点居中，
   *   缩放固定 `WALK_FOLLOW_ZOOM`（街道级）。程序化调用经 `applyCamera` 打标，
   *   不会触发让位锁误判；用户拖动由 `dragstart` 通知宿主退出跟随。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (phase !== "ready" || !walkFollow || !walkPos || !map) return;
    try {
      applyCamera(() => map.setZoomAndCenter(WALK_FOLLOW_ZOOM, [walkPos.lng, walkPos.lat]));
    } catch {
      /* 取景失败不影响导航 */
    }
  }, [walkFollow, walkPos, phase, applyCamera]);

  /** 退出跟随（`walkFollow: true → false`）⇒ 恢复该步行路径的总览取景（记住的 center/zoom） */
  const prevWalkFollowRef = useRef(false);
  useEffect(() => {
    if (prevWalkFollowRef.current && !walkFollow) {
      const skip = walkSkipRestoreRef.current;
      walkSkipRestoreRef.current = false;
      const v = walkViewRef.current;
      const map = mapRef.current;
      if (!skip && v && map) {
        try {
          applyCamera(() => map.setZoomAndCenter(v.zoom, v.center));
        } catch {
          /* ignore */
        }
      }
    }
    prevWalkFollowRef.current = walkFollow;
  }, [walkFollow, applyCamera]);

  /**
   * ★ 2026-09-23：**在途车辆**改由原生标记层承担（`VehicleLayer`，见其文件头说明）。
   * 旧的「React 覆盖层 + lngLatToContainer 每帧 setState」已删除 ——
   *   它在拖拽时落后地图一帧、且每帧触发一次 React 协调 ⇒ 视觉「飘」。
   * 原生化后位置由地图引擎驱动，**拖拽期零 JS**；合并仅在数据刷新 + `moveend`/`zoomend`
   *   （节流 120ms）重算。`zIndex:130` 保证「车压站点/pin」视觉不变。
   */

  return (
    <div
      ref={rootRef}
      className={`nav-map ${className}`}
      /* ★ 观测钩子（契约唯一名称）：data-map = ok|failed（地图可用性；区别于画布上的 data-map-mask） */
      data-map={phase === "failed" ? "failed" : phase === "ready" ? "ok" : undefined}
      /* ★ 本批观测钩子：H1 由 effect 写、H2/H3 由事件与 render() 写；此处直接派生
         H4 data-userdot（蓝点存在性）/ H9 data-vehicle-shown（在显车辆数）。 */
      data-userdot={userFix ? "blue" : "none"}
      data-vehicle-shown={String(vehicles.length)}
    >
      <div ref={canvasRef} className="nav-map__canvas" />
      {/* ★ 2026-09-23：在途巴士图标（**原生 AMap.Marker** + DOM content；拖拽期零 JS） */}
      <VehicleLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        vehicles={vehicles}
        onVehicleClick={onVehicleClick}
      />
      {/* ★ 2026-09-24：导航追踪（已驶过路段灰实线 z74）；★ 2026-09-25：「您」拆为蓝点 */}
      <TrackLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        traveled={traveled}
      />
      {/* ★ 2026-09-25：用户定位蓝点（人，z128 < 车辆 130）；★ v3.2.0：带移动插值时长（AC-80） */}
      <UserDotLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        fix={userFix}
        smoothMs={userDotSmoothMs}
      />
      {/* ★ v3.2.0（需求 9 / AC-83）：左下「回到我的位置」按钮**已删除** ——
          让位锁（followState=free 跳过自动取景，见上方 `if (followRef.current === "free")`）、
          双击恢复 `restore()`、定位键重跑**全部保留**（「定位」能力由页面级 `.nav-locate-fab` 承担）。 */}
      {phase === "loading" && (
        <div className="nav-map__cover">
          <span className="rc-sk rc-sk--big" />
          <span className="nav-map__cover-text">{locating ? "定位中…" : "地图加载中…"}</span>
        </div>
      )}
      {phase === "failed" && (
        <div className="nav-map__cover nav-map__cover--fail">
          <p className="h-title">地图暂不可用</p>
          <p className="t-label t-muted">搜索与路线结果不受影响</p>
          <button className="btn btn--outline btn--sm" type="button" onClick={() => void init()}>
            重试
          </button>
          {note && <p className="t-label t-muted">{note}</p>}
        </div>
      )}
      {phase === "ready" && note && <div className="nav-map__note t-label">{note}</div>}
    </div>
  );
}
