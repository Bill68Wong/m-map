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
import { DECIMATE_STEP_M, decimate, type ColoredLeg, type LL } from "@/lib/nav/route-overview";
import { loadAMap } from "./amap-loader";
import { lrtTransferVariantOf } from "./lrt-transfer";
import TrackLayer from "./TrackLayer";
import VehicleLayer from "./VehicleLayer";
import type { VehicleLite } from "./VehicleMarker";

/* eslint-disable @typescript-eslint/no-explicit-any */
const MACAU_CENTER = { lng: 113.558, lat: 22.155 }; // 全澳门视角中心（§D.1）
/** 初始 zoom（地图创建占位用；district 就绪后由 setBounds 接管） */
const INIT_ZOOM = 12;
/**
 * 手机屏幕上**横向显示 5km** 的默认视野（定位成功后使用，沿用既有口径）。
 *
 * 依据（标准 Web Mercator / 高德 256px 瓦片）：
 *   `米/像素(z, φ) = 156543.03392 · cos(φ) / 2^z`
 *   要在一屏宽 `W` 像素里横向放下 `D` 米 ⇒ `米/像素 = D / W`
 *   ⇒ 解出 `z = log2( 156543.03392 · cos(φ) · W / D )`
 *
 * 【实测代入】澳门纬度 φ≈22.15°（cos=0.9261）、手机宽 W=390px：
 *   z = log2(156543.03392 · 0.9261 · 390 / D)
 *   · D=5000（旧）  → z ≈ 13.46
 *   · D=2500（现行）→ z ≈ 14.46
 *
 * ★ 2026-09-22：**5000 → 2500**（用户反馈「点定位居中后比例尺太小」）。
 *   取 2500 而非更小的理由：一屏 2.5km ≈ 澳门半岛南北向的一半，
 *   既能看清所处街区、又能看到周边地标（用于「我在哪 / 往哪走」）；
 *   再缩到 1500 左右就只剩几条街，反而失去方位感。
 */
const TARGET_METERS_ACROSS = 2500;

/** ★ S1：缩放收敛区间（minZoom=11：一屏≈27.6km，远小于遮罩外圈 ±1.6°≈178km ⇒ 永不露边） */
const MIN_ZOOM = 11;
const MAX_ZOOM = 18;

/**
 * 站点图层显示阈值：`zoom < STATION_MIN_ZOOM` 时不显示任何站点（拉远即清空）。
 * · 2026-09-22：16 → 15（用户反馈「要放得很大站点才显示出来」）。
 * ★ 2026-09-23：15 → **14**（用户拍板）——要求「打开定位后的默认视野就要能看到站点」。
 *   实测定位完成后的视野 ≈ 14.47 级 ⇒ 阈值取 14 时定位完成即显示，不必手动放大；
 *   而全澳总览（≈12.4 级）仍不显示，避免整屏 470+ 站点糊在街区细节上。
 */
const STATION_MIN_ZOOM = 14;
/**
 * ★ 2026-09-22：**路线查看模式下的站点阈值**（比常规低一档）。
 *   为什么需要：进入路线模式会 `setBounds` 把视野缩到「装下整条线」，
 *   跨全澳的长线（如 26 号）实测落到 zoom ≈ 12~13，**低于常规阈值 15**
 *   ⇒ 站点图层整体不显示 ⇒ 看不到「本线站点高亮」的效果 ✗
 *   ⇒ 路线模式下放宽到 12（此时仍需显示本线站点，否则功能等于白做）。
 */
const STATION_MIN_ZOOM_ROUTE = 12;
/** 视图事件节流（毫秒）：`zoomend`/`moveend` 高频触发，节流后再裁剪/渲染 */
const STATION_REFRESH_THROTTLE_MS = 150;

/**
 * 遮罩填充色 —— ★ 从设计 Token **运行时读取**（`--fg`），代码里不硬编码色值。
 * AMap Polygon 的 `fillColor` 由画布绘制、拿不到 CSS 变量，故此处显式读一次 Token；
 * 读不到（极端环境）→ 返回 null，调用方**跳过遮罩**（走「仅范围限制」降级，不阻塞地图）。
 */
function maskFill(): string | null {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--fg").trim();
    return v || null;
  } catch {
    return null;
  }
}
const MASK_OPACITY = 0.42;

/**
 * ★ 2026-09-23：运行时读一个 CSS Token 的 **resolved 具体值**。
 * 为什么需要：AMap `Polyline.strokeColor` / `Polygon.fillColor` 由**画布**绘制，
 *   **拿不到 `var()`** ⇒ 必须在 JS 侧读一次真色值（与 `maskFill()` 同一做法）。
 * 防呆：值里若仍含 `(`（= `color-mix(...)` / `var(...)` 未被解析）⇒ 视为读不到 ⇒ 返回 null，
 *   调用方回落下一个 Token（避免把非法字符串喂给画布导致静默不绘制）。
 */
function readToken(name: string): string | null {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v || v.includes("(")) return null;
    return v;
  } catch {
    return null;
  }
}

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

/** 让「一屏宽」横向放下 `TARGET_METERS_ACROSS` 米的 zoom（按纬度与容器像素宽实时算） */
function zoomForAcross(lat: number, widthPx: number): number {
  const w = widthPx > 0 ? widthPx : 390;
  const mpp = TARGET_METERS_ACROSS / w;
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / mpp);
  // 高德 zoom 支持小数；夹到合法区间防止极端容器宽度算出离谱值
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));
}

/**
 * ★ 2026-09-24：读「半屏可出发」面板（`.rpanel`）的**真实顶边像素**（取景用）。
 * 为什么：`dest-center-top` / `fit-two` 此前把「下半屏被面板遮住」**写死成 50%**——
 *   而 RoutePanel 的高度随内容变化（且桌面端是右栏、非底部面板）⇒ 取景与实际遮挡不吻合。
 * 读不到 / 数值异常（桌面右栏 / 元素隐藏 / SSR）⇒ 返回 null，调用方回落旧口径。
 */
function panelTopPx(fallbackH: number): number | null {
  try {
    const el = document.querySelector<HTMLElement>(".rpanel");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.height <= 0) return null;
    const top = Math.round(r.top);
    if (top < 80 || top > fallbackH - 40) return null; // 异常值 ⇒ 回落
    return top;
  } catch {
    return null;
  }
}

/** ★ 2026-09-24：读设计 Token `--map-fit-gap`（px）——取景呼吸边距（此前悬空未接线）；回落 20 */
function fitGapPx(): number {
  const v = readToken("--map-fit-gap");
  const n = v ? Number.parseFloat(v) : Number.NaN;
  return Number.isFinite(n) && n > 0 && n < 200 ? n : 20;
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
   * ★ 2026-09-24：**导航追踪 · 「您」标记**（锁定车辆的实时位置）。
   *   非空 ⇒ 画一个「您」圆点（原生 marker z140 > 车辆 130）；`null` ⇒ 移除（退出追踪）。
   */
  navYou?: { lng: number; lat: number; label?: string } | null;
  /**
   * ★ 2026-09-24：**导航追踪 · 已驶过路段**（绿色覆层 polyline，z74 —— 压在乘车彩段 72 之上）。
   *   路径 = 乘车段 polyline 由车辆实时投影切割所得（`useRideTracking`）；`null` ⇒ 不画。
   */
  traveled?: LL[] | null;
  /**
   * 重新定位触发计数（右上定位按钮）—— 变化时重跑一次定位并（范围内）居中。
   * 初始为 0 时不触发（首屏定位由 `init()` 负责）。
   */
  locateTick?: number;
  /** 附加类名（承载全屏布局） */
  className?: string;
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
  navYou = null,
  traveled = null,
}: NavMapProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
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
  /** 定位早于边界就绪时的暂存坐标 */
  const pendingLocateRef = useRef<{ lng: number; lat: number } | null>(null);
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

  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [note, setNote] = useState<string>("");
  const [locating, setLocating] = useState(false);

  /**
   * 定位落在澳门范围内 → 居中到定位点（横向 5km）；范围外 → 不移动地图。
   * 蓝点无论如何都按真实坐标落位。
   */
  const applyLocateView = useCallback((pos: { lng: number; lat: number }) => {
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
      if (viewRef.current && viewRef.current.mode !== "none") {
        canvas?.setAttribute("data-locate-skip-view", "on");
        return;
      }
      const w: number = map.getSize?.()?.width ?? (typeof window !== "undefined" ? window.innerWidth : 390);
      const z = zoomForAcross(pos.lat, w);
      try {
        map.setZoomAndCenter(z, [pos.lng, pos.lat]);
        canvas?.setAttribute("data-nav-zoom", String(z));
      } catch {
        /* 视角设置失败不影响底图 */
      }
    } else {
      // ★ 范围外：不自动移出（保持澳门视野）；蓝点如实落位（可能落在视野之外）
      canvas?.setAttribute("data-locate-outside", "on");
    }
  }, []);

  /**
   * 跑一次定位（首屏 + 右上定位按钮共用）。
   * 范围内 → 居中到定位点；范围外 → 不移动地图（保持澳门视野）；蓝点如实落位。
   */
  const runLocate = useCallback(() => {
    const AMap = amapRef.current;
    const map = mapRef.current;
    if (!AMap || !map) return;
    const geo = new AMap.Geolocation({ enableHighAccuracy: true, timeout: 10_000, convert: true });
    setLocating(true);
    geo.getCurrentPosition((status: string, result: any) => {
      setLocating(false);
      if (status === "complete" && result?.position) {
        // ★ position 已是 GCJ-02（convert:true）→ 不再转换
        const pos = { lng: result.position.lng, lat: result.position.lat };
        locatedRef.current = true;
        canvasRef.current?.removeAttribute("data-locate-outside");
        if (userMarkerRef.current) userMarkerRef.current.setPosition([pos.lng, pos.lat]);
        else
          userMarkerRef.current = new AMap.Marker({
            position: [pos.lng, pos.lat],
            content: '<div class="nav-map__mepin" aria-label="我的位置"></div>',
            offset: new AMap.Pixel(-9, -9),
            zIndex: 110,
          });
        if (mapRef.current && userMarkerRef.current) mapRef.current.add(userMarkerRef.current);
        if (boundsAppliedRef.current) applyLocateView(pos);
        else pendingLocateRef.current = pos; // 边界未就绪 → 暂存，就绪后再决定
        onLocate?.(pos);
      } else {
        // ★ 定位失败 → 停在澳门视野（不重设视角）+ 提示（§D.1）
        setNote("无法定位 · 请手动选择出发点");
        onLocate?.(null);
      }
    });
  }, [applyLocateView, onLocate]);

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
          map.setBounds(bounds); // ③ 首屏 = 澳门全境
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
            applyLocateView(p);
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
  }, [jsKey, mapStyleId, runLocate, applyLocateView, onLocate]);

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
      maskRef.current = null;
      districtRef.current = null;
      boundsAppliedRef.current = false;
      pendingLocateRef.current = null;
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
          content: '<div class="nav-map__destpin" aria-hidden="true"></div>',
          offset: new AMap.Pixel(-10, -20),
          title: dest.label,
          zIndex: 120,
        });
        map.add(destMarkerRef.current);
      }
      // ★ S2「地图标定」：选完目的地 → 居中到该点（限制范围内自动收敛）
      // ★ 2026-09-22：若调用方给了 `view`（新版搜索弹窗），取景改由下面的 view effect 统一负责
      //   —— 因为那时需要「居上半屏」或「适配两点」，不能简单 setCenter。不传 `view` 时保持原行为。
      if (!view) {
        try {
          map.setCenter(pos);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* 标记失败不影响底图 */
    }
  }, [dest, phase, view]);

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
          content: '<div class="nav-map__originpin" aria-hidden="true"></div>',
          offset: new AMap.Pixel(-9, -9),
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
   *
   * 为什么需要单独的 effect：新版弹窗是**覆盖层**（下半屏遮住地图）。
   *   若沿用「容器中心居中」，标记会落进被遮住的下半屏 ⇒ 用户看不见 ✗
   *   ⇒ `dest-center-top` 把视口上移 1/4 屏；`fit-two` 用 `setFitView` + 底部 avoid 让两点都落在上半屏。
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || phase !== "ready" || !view || view.mode === "none") return;
    const winH = typeof window !== "undefined" ? window.innerHeight : 800;

    if (view.mode === "dest-center-top") {
      if (!dest) return;
      try {
        // ★ 关键点：`immediately=true`（第 3 参）**关掉缩放动画**。
        //   踩坑记录（三次尝试）：
        //     ① `setZoomAndCenter` 默认带动画，紧随的 `panBy` 被动画中断 ⇒ 标记停在下半屏；
        //     ② 改用 `setFitView` + 45% 底部留白 ⇒ 改善但仍偏下；
        //     ③ 留白提到 70% ⇒ **过度矫正，标记被推出视野**。
        //   ⇒ 正解：先**无动画**居中，再平移固定比例 —— 可控且可预期。
        map.setZoomAndCenter(16, [dest.lng, dest.lat], true);
        const size = map.getSize?.() ?? { width: 390, height: winH };
        const h: number = size.height ?? winH;
        /**
         * ★ 2026-09-24：改按**真实遮挡区**取景 —— 读 RoutePanel（`.rpanel`）真实顶边，
         *   把点从整屏中心抬到「面板上方可见区」的中心；读不到（桌面右栏 / 异常）⇒
         *   回落旧口径「上移 1/5 屏」。
         */
        const panelTop = panelTopPx(h);
        map.panBy(0, panelTop !== null ? Math.round(h / 2 - panelTop / 2) : Math.round(h * 0.2));
      } catch {
        /* ignore */
      }
      return;
    }

    if (view.mode === "fit-two") {
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
        map.setZoomAndCenter(z, [centerLng, centerLat], true);
        // 把「两点中点」从整屏中心抬到「可见槽中心」；回落口径 = 上移 1/4 屏
        map.panBy(0, panelTop !== null ? Math.round(size.height / 2 - panelTop / 2) : Math.round(size.height / 4));
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
    if (view.mode === "fit-box") {
      const box = view.box;
      if (!box) return;
      try {
        const size = map.getSize?.() ?? { width: 390, height: 700 };
        const slotTop = Math.max(80, Math.round(view.slotTopPx ?? size.height * 0.12));
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
        map.setZoomAndCenter(z, [centerLng, centerLat], true);
        // 框中心：从整屏中心（size.height/2）抬到「顶部槽中心」（slotTop/2）
        map.panBy(0, Math.round(size.height / 2 - slotTop / 2));
        canvasRef.current?.setAttribute("data-nav-zoom", String(z));
        canvasRef.current?.setAttribute("data-view-mode", "fit-box-selfcalc");
      } catch {
        /* ignore */
      }
    }
  }, [view, dest, origin, phase]);

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

  // ★ 右上定位按钮：locateTick 变化 → 重跑定位（首屏由 init 负责，tick=0 不触发）
  useEffect(() => {
    if (locateTick > 0) runLocate();
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
        // ★ 2026-09-22：路线模式下阈值放宽（否则长线缩到全澳后站点全消失，看不到高亮）
        const minZoom = routeStopsRef.current.size > 0 ? STATION_MIN_ZOOM_ROUTE : STATION_MIN_ZOOM;
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
        for (const s of data) {
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
     */
  }, [phase, stationRebuildTick]);

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
              map.setBounds(b, true, [40, 40, 40, 40]);
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
  }, [routeLine]);

  /**
   * ★ 2026-09-23：**路线总览绘制**（详情 pane）。
   *
   * 双层 polyline（同宽 6px，只靠颜色区分，避免上下车站处粗细台阶）：
   *   · 灰底线 = 所选方向整条线（区间外），`--map-line-dim`（读 Token 真色值），zIndex 68；
   *   · 彩段   = board→alight 乘车区间，线路色（`routes.color`）/ 缺省 `--accent`，zIndex 72；
   * `degraded`（整线着色）时 `colored === gray` ⇒ **只画彩段**（不画灰，PM 边界 #4）。
   *
   * 生命周期：进入 detail → 一次画完；退出 detail（`overview=null`）→ 逐个 `map.remove()` 清理
   *   （复用 routeLine 的清理模式，防泄漏）。灰底线长线先 `decimate` 抽稀（保彩段端点）。
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
    const dim = readToken("--map-line-dim") ?? readToken("--border-2") ?? readToken("--muted");
    const accent = readToken("--accent");

    /** 实际绘制的**彩段折线**数（语义 = 真正上屏的乘车段，非 leg 数） */
    let drawn = 0;
    for (const leg of overview) {
      try {
        // 灰底线：整线着色（colored===gray）时跳过（只留彩段）
        const grayIsWhole = leg.colored === leg.gray;
        if (dim && !grayIsWhole && leg.gray.length >= 2) {
          const grayPath = decimate(leg.gray, DECIMATE_STEP_M);
          const gpl = new AMap.Polyline({
            path: grayPath,
            strokeColor: dim,
            strokeWeight: 6,
            strokeOpacity: 0.85,
            lineJoin: "round",
            lineCap: "round",
            showDir: true,
            zIndex: 68,
          });
          map.add(gpl);
          overviewPolylinesRef.current.push(gpl);
        }
        // 彩段：乘车区间（整线着色时即为整条）；色源优先线路色（数据）→ --accent Token
        if (leg.colored.length >= 2) {
          const stroke = leg.color ?? accent;
          if (stroke) {
            const cpl = new AMap.Polyline({
              path: leg.colored,
              strokeColor: stroke,
              strokeWeight: 6,
              strokeOpacity: 0.92,
              lineJoin: "round",
              lineCap: "round",
              showDir: true,
              zIndex: 72,
            });
            map.add(cpl);
            overviewPolylinesRef.current.push(cpl);
            drawn++; // ★ 仅「实际添加彩段折线」时自增（colored<2 / 无色源不计数）
          }
        }
      } catch {
        /* 单段绘制失败不影响其余段 */
      }
    }
    canvasRef.current?.setAttribute("data-overview-legs", String(drawn));
    return () => clearOverview();
  }, [overview, phase]);

  /**
   * ★ 2026-09-23：**在途车辆**改由原生标记层承担（`VehicleLayer`，见其文件头说明）。
   * 旧的「React 覆盖层 + lngLatToContainer 每帧 setState」已删除 ——
   *   它在拖拽时落后地图一帧、且每帧触发一次 React 协调 ⇒ 视觉「飘」。
   * 原生化后位置由地图引擎驱动，**拖拽期零 JS**；合并仅在数据刷新 + `moveend`/`zoomend`
   *   （节流 120ms）重算。`zIndex:130` 保证「车压站点/pin」视觉不变。
   */

  return (
    <div
      className={`nav-map ${className}`}
      /* ★ 观测钩子（契约唯一名称）：data-map = ok|failed（地图可用性；区别于画布上的 data-map-mask） */
      data-map={phase === "failed" ? "failed" : phase === "ready" ? "ok" : undefined}
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
      {/* ★ 2026-09-24：导航追踪（「您」标记 z140 + 已驶过路段绿色覆层 z74） */}
      <TrackLayer
        map={phase === "ready" ? mapRef.current : null}
        amap={phase === "ready" ? amapRef.current : null}
        enabled={phase === "ready"}
        you={navYou}
        traveled={traveled}
      />
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
