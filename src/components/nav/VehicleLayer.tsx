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

/**
 * ★ 真机自检钩子（`body[data-vehicle-layer]`，2026-10-31）：
 *   回答"真机上巴士图标到底是**数据没有**还是**建层失败**"—— 这两者修法完全不同。
 *
 * 取值格式：`enabled:1|clusters:3|markers:8`，失败时追加 `|lastErr:…`。
 *   · `enabled`  = 本层是否启用（`phase==='ready'`）
 *   · `clusters` = 按屏距合并后的簇数（= sync 收到的簇数）
 *   · `markers`  = 实际挂在地图上的 marker 数（`live.size`）
 *   · `lastErr`  = 最近一次建 marker / add / remove 的异常摘要
 * ⚠️ 只读观测；挂在 `body` 上（本组件 `return null`，没有自己的 DOM）。
 */
function reportVehicleLayer(
  enabled: boolean,
  clusters = 0,
  markers = 0,
  lastErr = "",
): void {
  if (typeof document === "undefined") return;
  try {
    document.body.setAttribute(
      "data-vehicle-layer",
      `enabled:${enabled ? 1 : 0}|clusters:${clusters}|markers:${markers}${lastErr ? `|lastErr:${lastErr}` : ""}`,
    );
  } catch {
    /* 观测失败不得影响功能 */
  }
}

/**
 * 把 root 的 `unmount()` 延到**微任务**执行。
 *
 * ── 为什么不能就地同步 unmount（P0 · 2026-10-31）─────────────────────────
 *   `clearAll` 由 `recompute` 触发，而 `recompute` 挂在 effect 里；effect 的
 *   **执行与 cleanup 都发生在 React 的 commit/flush 阶段内**。此时同步调
 *   `root.unmount()` ⇒ React 19 抛
 *   「Attempted to synchronously unmount a root while React was already rendering」
 *   并按契约记一条 `console.error`。实测「退出线路视图」一次刷出 **7 条**（= 当时 7 个车标）。
 *   更糟的是：`unmount()` 抛在 `live.clear()` 之前 ⇒ **root 实际没被卸载** ⇒ 真实泄漏
 *   （`try/catch` 把异常吞了，所以功能不崩，但泄漏与日志都是真的）。
 *
 * ── 为什么是微任务而不是 `setTimeout(0)` ────────────────────────────────
 *   微任务在同一次 commit 结束之后、下一次 paint 之前执行 —— 足够让 React 退出渲染态，
 *   又不会让已摘掉的 marker 的 DOM 多留一帧。
 *
 * ⚠️ **不要**改成「不 unmount、只 `render(null)`」：marker 已被移除，
 *    留一个活 root 继续持有组件树就是纯泄漏。
 */
function unmountLater(roots: Root[]) {
  if (!roots.length) return;
  queueMicrotask(() => {
    for (const r of roots) {
      try {
        r.unmount();
      } catch {
        /* ignore —— 已卸载 / 已被 GC，不得影响后续 */
      }
    }
  });
}

/**
 * 清空全部簇：先摘 marker，`root.unmount()` 延到微任务（React 不允许在渲染中同步 unmount）。
 * `live.clear()` 必须在调度**之前** —— 否则同一 batch 的 root 可能被重复计入下一轮。
 */
function clearAll(map: any, live: Map<string, Rec>) {
  const roots: Root[] = [];
  for (const [, rec] of live) {
    try {
      map?.remove?.(rec.marker);
    } catch {
      /* ignore */
    }
    roots.push(rec.root);
  }
  live.clear();
  unmountLater(roots);
}

export default function VehicleLayer({ map, amap, enabled, vehicles, onVehicleClick }: VehicleLayerProps) {
  const liveRef = useRef<Map<string, Rec>>(new Map());
  const cbRef = useRef(onVehicleClick);
  cbRef.current = onVehicleClick;
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;
  /**
   * ★ T6：**DOM 层点击兜底的去重闸**。
   *
   * 点击链路原本只挂在 `AMap.Marker` 的 `'click'` 上，而我们的 content 是 React 渲染的
   * `<button>` —— 高德对 DOM content 的事件转发在部分版本/嵌套结构下会被吞
   * （按钮自己的 click 冒泡到地图容器，marker 却不发 click）⇒ 点了没反应，且**零兜底**。
   * 现在同时挂 DOM `onClick`（同一回调），用「同一簇 + 400ms」去重，
   * 避免 marker 与 DOM 两条道都通时**双触发**（双触发会连开两次卡片、把刚打开的关掉）。
   */
  const lastFireRef = useRef<{ key: string; ts: number }>({ key: "", ts: 0 });
  const fire = useCallback((key: string, items: VehicleLite[]) => {
    if (!items.length) return;
    const now = Date.now();
    const last = lastFireRef.current;
    if (last.key === key && now - last.ts < 400) return;
    lastFireRef.current = { key, ts: now };
    cbRef.current?.(items[0], items.length);
  }, []);

  /** 把当前簇同步到地图（新增/更新 + 清理消失的）；返回异常摘要（供自检钩子） */
  const sync = useCallback(
    (clusters: ReturnType<typeof clusterByScreenDistance>) => {
      const live = liveRef.current;
      const next = new Set<string>();
      let lastErr = "";
      for (const c of clusters) {
        next.add(c.key);
        const pos: [number, number] = [c.items[0].lng, c.items[0].lat];
        let rec = live.get(c.key);
        if (!rec) {
          try {
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
              fire(c.key, rec?.items ?? []);
            });
            map.add(marker);
          } catch (e) {
            // ★ 自检：建 marker 失败必须可见（真机"没有巴士图标"的第一嫌疑）
            lastErr = String((e as Error)?.message ?? e).slice(0, 80);
            continue;
          }
          live.set(c.key, rec);
        }
        rec.items = c.items;
        rec.marker.setPosition(pos);
        /* DOM 层兜底：同一回调 + 去重闸（见 `fire` 注释） */
        rec.root.render(<VehicleMarker items={c.items} x={0} y={0} onClick={() => fire(c.key, rec?.items ?? [])} />);
      }
      /**
       * ★ P0：清理消失的簇 —— 同样**先把 root 收进数组、`live.delete` 之后再统一
       *   `queueMicrotask` unmount**，不要就地同步调（理由见 `unmountLater`）。
       *   就地同步 unmount 会在「换向 / 换线路 / 过滤后车变少」时各刷一批 React 报错。
       */
      const gone: Root[] = [];
      for (const [key, rec] of live) {
        if (next.has(key)) continue;
        try {
          map.remove(rec.marker);
        } catch (e) {
          lastErr = String((e as Error)?.message ?? e).slice(0, 80);
        }
        gone.push(rec.root);
        live.delete(key);
      }
      unmountLater(gone);
      return { clusters: clusters.length, markers: live.size, lastErr };
    },
    [amap, map, fire],
  );

  /** 按当前车辆/视野算簇并同步 */
  const recompute = useCallback(() => {
    if (!enabled || !map || !amap) {
      reportVehicleLayer(false);
      return;
    }
    const live = liveRef.current;
    const vs = vehiclesRef.current;
    if (!vs.length) {
      clearAll(map, live);
      reportVehicleLayer(true, 0, 0);
      return;
    }
    const pts: { v: VehicleLite; x: number; y: number }[] = [];
    for (const v of vs) {
      const p = project(map, v.lng, v.lat);
      if (p) pts.push({ v, x: p.x, y: p.y });
    }
    try {
      const r = sync(clusterByScreenDistance(pts, MERGE_DIST));
      reportVehicleLayer(true, r.clusters, r.markers, r.lastErr);
    } catch (e) {
      reportVehicleLayer(true, 0, live.size, String((e as Error)?.message ?? e).slice(0, 80));
    }
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
