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
import { loadAMap } from "./amap-loader";

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
 * 【实测代入】澳门纬度 φ≈22.15°（cos=0.9261）、手机宽 W=390px、D=5000m：
 *   z = log2(156543.03392 · 0.9261 · 390 / 5000) = log2(11309) ≈ 13.46
 * ⇒ 取 z≈13.46（随容器宽度实时计算，兼容手机/桌面）。
 */
const TARGET_METERS_ACROSS = 5000;

/** ★ S1：缩放收敛区间（minZoom=11：一屏≈27.6km，远小于遮罩外圈 ±1.6°≈178km ⇒ 永不露边） */
const MIN_ZOOM = 11;
const MAX_ZOOM = 18;

/**
 * 站点图层显示阈值：`zoom < STATION_MIN_ZOOM` 时不显示任何站点（拉远即清空）。
 * ★ 沿用 v2.1.0 现网验证值，本次改版**不改**（避免回归）。
 */
const STATION_MIN_ZOOM = 16;
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

/** `/api/stations` 一条站点（坐标 **GCJ-02**，服务端已转好） */
export interface StationPointLite {
  code: string;
  name: string;
  lng: number;
  lat: number;
}

/** 让「一屏宽」横向放下 `TARGET_METERS_ACROSS` 米的 zoom（按纬度与容器像素宽实时算） */
function zoomForAcross(lat: number, widthPx: number): number {
  const w = widthPx > 0 ? widthPx : 390;
  const mpp = TARGET_METERS_ACROSS / w;
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / mpp);
  // 高德 zoom 支持小数；夹到合法区间防止极端容器宽度算出离谱值
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));
}

export interface NavMapProps {
  /** Web 端（JS API）Key（服务端以 prop 传入） */
  jsKey: string;
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
   */
  view?: { mode: "dest-center-top" | "fit-two" | "none"; tick: number } | null;
  /** 定位回调：成功给 GCJ-02 坐标；失败给 null */
  onLocate?: (pos: { lng: number; lat: number } | null) => void;
  /** 点击巴士站点回调（信息卡）——坐标 GCJ-02 */
  onStationClick?: (s: StationPointLite) => void;
  /** 点击地图空白处（S2：用于收起站点信息卡） */
  onMapClick?: (pos: { lng: number; lat: number }) => void;
  /** 地图就绪后回传「读地图中心」的函数（S2 分步弹层第 2 步「用这个点」用） */
  onMapReady?: (probe: () => { lng: number; lat: number } | null) => void;
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
  dest,
  origin,
  view,
  onLocate,
  onStationClick,
  onMapClick,
  onMapReady,
  locateTick = 0,
  className = "",
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
  /** 点击回调放进 ref：避免 prop 变化导致图层重新绑定事件 */
  const onStationClickRef = useRef<NavMapProps["onStationClick"]>(undefined);
  const onMapClickRef = useRef<NavMapProps["onMapClick"]>(undefined);
  const onMapReadyRef = useRef<NavMapProps["onMapReady"]>(undefined);
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
      const map = new AMap.Map(canvasRef.current, {
        zoom: INIT_ZOOM,
        center: [MACAU_CENTER.lng, MACAU_CENTER.lat],
        viewMode: "2D",
        resizeEnable: true,
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
  }, [jsKey, runLocate, applyLocateView, onLocate]);

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
        const overlays = [destMarkerRef.current].filter(Boolean);
        if (typeof map.setFitView === "function" && overlays.length) {
          // ★ 用 `setFitView` + **底部大留白**把标记压进上半屏。
          //   为什么不用 `panBy`（上一版做法，实测失效）：`setZoomAndCenter` 是**带动画**的，
          //   紧接的 `panBy` 会被缩放动画中断/覆盖 ⇒ 标记仍留在下半屏。
          //   `setFitView` 的一次性取景（含 avoid）不受该问题影响。
          //   ⚠️ 留白以**地图容器高**（不是视口高）为基准 —— 容器已排除底部导航与合规条。
          //      实测标定（容器 ≈ 720px、底部面板 ≈ 260px）：
          //        45% 留白 ⇒ 标记落在 y≈480（偏下）· 70% ⇒ 约 y≈330 ⇒ 落在**上半屏中部** ✓
          //      故取 70%：让「上半屏正中央」这条产品口径真正成立，而不只是「没被遮住」。
          //   第 4 参 `maxZoom=16`：单点 fitView 否则会一路放大到 20 级（街景过近），需封顶。
          const ch: number = map.getSize?.()?.height ?? winH;
          map.setFitView(overlays, false, [70, 60, Math.round(ch * 0.7), 60], 16);
        } else {
          // 兜底：标记尚未就绪 ⇒ 退化为「居中 + 上移」
          map.setZoomAndCenter(16, [dest.lng, dest.lat]);
          const h: number = map.getSize?.()?.height ?? winH;
          map.panBy(0, Math.round(h / 4));
        }
      } catch {
        /* ignore */
      }
      return;
    }

    if (view.mode === "fit-two") {
      if (!origin || !dest) return;
      try {
        const overlays = [originMarkerRef.current, destMarkerRef.current].filter(Boolean);
        if (typeof map.setFitView === "function" && overlays.length) {
          // avoid = [上, 右, 下, 左]（像素）：底部避开「弹窗高度」⇒ 两点都被压进上半屏
          map.setFitView(overlays, false, [80, 80, Math.round(winH / 2) + 48, 80]);
        } else {
          map.setCenter([(origin.lng + dest.lng) / 2, (origin.lat + dest.lat) / 2]);
        }
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
        if (zoom < STATION_MIN_ZOOM) {
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
          const marker = new AMap.Marker({
            position: [s.lng, s.lat],
            content: `<div class="nav-map__station" data-code="${esc(s.code)}" title="${esc(s.name)}"></div>`,
            offset: new AMap.Pixel(-6, -6),
            zIndex: 90,
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
    if (!stationsRef.current) {
      fetch("/api/stations", { cache: "force-cache" })
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
  }, [phase]);

  return (
    <div className={`nav-map ${className}`}>
      <div ref={canvasRef} className="nav-map__canvas" />
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
