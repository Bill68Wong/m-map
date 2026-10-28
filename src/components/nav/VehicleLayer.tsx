"use client";

/**
 * 车辆图标原生化层（src/components/nav/VehicleLayer.tsx，2026-09-23 新增）
 *
 * ── 为什么（技术方案 §4）────────────────────────────────────────────────
 *   旧实现用 **React 覆盖层 + `lngLatToContainer` 投影 + 每帧 `setState`**：
 *   拖拽时地图由高德自身渲染循环重绘，而我们的图标要**等 React commit** 才更新
 *   ⇒ 至少落后一帧、每帧一次协调 ⇒ 视觉「飘/滞后」。
 *   站点/定位/目的地同为 `AMap.Marker`（原生字符串 content）**从不飘** ⇒ 问题在「覆盖层 + setState」。
 *
 * ── 方案：原生 `AMap.Marker` + `content` 传 **DOM 元素**（每簇一个 React root）
 *   位置由**地图引擎驱动**（与地图变换同循环）；**拖拽期零 JS、零 React 更新**。
 *   合并（28px 屏距）**只在数据刷新 + `moveend`/`zoomend`（节流 120ms）**重算，
 *   拖拽进行中**不重算**（图标只随地图平移，不弹跳 —— 同 Google Maps 手感）。
 *
 * ── 铁律 ────────────────────────────────────────────────────────────────
 *   · `createRoot` 与 `root.unmount()` **必须成对**（`Map<key,{marker,root}>` 严格配对）；
 *   · `anchor:'center'` + `zIndex:130`（> pin 120 > 站点 95 ⇒ 「车压地图元素」视觉不变）；
 *   · `bubble:true` 允许冒泡到地图；样式零改动（`VehicleMarker` 的 SVG/`data-state` 保留）。
 */
import { useCallback, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import VehicleMarker, { clusterByScreenDistance, type VehicleLite } from "./VehicleMarker";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 合并阈值（屏距 px）—— Spec AC-07 */
const MERGE_DIST = 28;
/** `moveend`/`zoomend` 重算节流（ms）—— 拖拽期不重算 */
const RECOMPUTE_THROTTLE_MS = 120;

interface Rec {
  marker: any;
  root: Root;
  el: HTMLElement;
  items: VehicleLite[];
}

export interface VehicleLayerProps {
  /** 地图实例（phase==='ready' 后非空） */
  map: any;
  /** 高德命名空间 */
  amap: any;
  /** 是否启用（phase==='ready'） */
  enabled: boolean;
  vehicles: VehicleLite[];
  onVehicleClick?: (v: VehicleLite, count: number) => void;
}

/** 经纬度 → 容器像素（大小写两版方法名都试，避免版本差异导致静默不显示） */
function project(map: any, lng: number, lat: number): { x: number; y: number } | null {
  const tryFn = (fn: unknown): { x: number; y: number } | null => {
    try {
      if (typeof fn !== "function") return null;
      const p = (fn as (ll: [number, number]) => any).call(map, [lng, lat]);
      const x = typeof p?.getX === "function" ? p.getX() : p?.x;
      const y = typeof p?.getY === "function" ? p.getY() : p?.y;
      if (typeof x === "number" && typeof y === "number") return { x, y };
    } catch {
      /* ignore */
    }
    return null;
  };
  return tryFn(map?.lngLatToContainer) ?? tryFn(map?.lnglatToContainer);
}

/** 清空全部簇：逐个 `map.remove(marker)` + `root.unmount()`（严格配对，防泄漏） */
function clearAll(map: any, live: Map<string, Rec>) {
  for (const [, rec] of live) {
    try {
      map?.remove?.(rec.marker);
    } catch {
      /* ignore */
    }
    try {
      rec.root.unmount();
    } catch {
      /* ignore */
    }
  }
  live.clear();
}

export default function VehicleLayer({ map, amap, enabled, vehicles, onVehicleClick }: VehicleLayerProps) {
  const liveRef = useRef<Map<string, Rec>>(new Map());
  const cbRef = useRef(onVehicleClick);
  cbRef.current = onVehicleClick;
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;

  /** 把当前簇同步到地图（新增/更新 + 清理消失的） */
  const sync = useCallback(
    (clusters: ReturnType<typeof clusterByScreenDistance>) => {
      const live = liveRef.current;
      const next = new Set<string>();
      for (const c of clusters) {
        next.add(c.key);
        const pos: [number, number] = [c.items[0].lng, c.items[0].lat];
        let rec = live.get(c.key);
        if (!rec) {
          const el = document.createElement("div");
          const root = createRoot(el);
          const marker = new amap.Marker({
            position: pos,
            content: el, // ★ DOM 元素（非字符串）
            anchor: "center", // 44px 命中盒居中
            zIndex: 130, // ★ > pin 120 > 站点 95
            bubble: true,
          });
          rec = { marker, root, el, items: c.items };
          marker.on("click", () => {
            const items = rec?.items ?? [];
            if (items.length) cbRef.current?.(items[0], items.length);
          });
          map.add(marker);
          live.set(c.key, rec);
        }
        rec.items = c.items;
        rec.marker.setPosition(pos);
        rec.root.render(<VehicleMarker items={c.items} x={0} y={0} />);
      }
      for (const [key, rec] of live) {
        if (next.has(key)) continue;
        try {
          map.remove(rec.marker);
        } catch {
          /* ignore */
        }
        try {
          rec.root.unmount();
        } catch {
          /* ignore */
        }
        live.delete(key);
      }
    },
    [amap, map],
  );

  /** 按当前车辆/视野算簇并同步 */
  const recompute = useCallback(() => {
    if (!enabled || !map || !amap) return;
    const live = liveRef.current;
    const vs = vehiclesRef.current;
    if (!vs.length) {
      clearAll(map, live);
      return;
    }
    const pts: { v: VehicleLite; x: number; y: number }[] = [];
    for (const v of vs) {
      const p = project(map, v.lng, v.lat);
      if (p) pts.push({ v, x: p.x, y: p.y });
    }
    sync(clusterByScreenDistance(pts, MERGE_DIST));
  }, [enabled, map, amap, sync]);

  // ① 地图生命周期：初次算 + moveend/zoomend 节流重算（**拖拽期无 move(=dragging) 监听 ⇒ 零 JS**）
  useEffect(() => {
    if (!enabled || !map || !amap) return;
    const live = liveRef.current;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        recompute();
      }, RECOMPUTE_THROTTLE_MS);
    };
    recompute();
    try {
      map.on("moveend", schedule);
      map.on("zoomend", schedule);
    } catch {
      /* ignore */
    }
    return () => {
      if (timer) clearTimeout(timer);
      try {
        map.off("moveend", schedule);
        map.off("zoomend", schedule);
      } catch {
        /* ignore */
      }
      clearAll(map, live);
    };
  }, [enabled, map, amap, recompute]);

  // ② 数据刷新：立即重算（不进节流）
  useEffect(() => {
    recompute();
  }, [vehicles, recompute]);

  // ③ 卸载兜底清理
  useEffect(() => {
    const live = liveRef.current;
    return () => clearAll(map, live);
  }, [map]);

  return null;
}
