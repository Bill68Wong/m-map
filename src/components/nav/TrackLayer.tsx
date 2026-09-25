"use client";

/**
 * 导航追踪图层（src/components/nav/TrackLayer.tsx，2026-09-25 · v2.14 修订）
 *
 * ── 本轮变更（07 §4.3）────────────────────────────────────────────────
 *   · **已驶过路段 = 灰实线**（原绿覆层作废）：`--map-line-passed`、线宽 6、
 *     opacity 0.88、zIndex 74（压在乘车彩段 72 之上，表示「走过了」）；
 *   · **「您」标记移除**：语义拆分 —— 车＝`VehicleLayer`（z130）、人＝`UserDotLayer`（蓝点 z128）。
 *     本层只负责「已驶过灰实线」。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────────
 *   `traveled` 非空（≥2 点）→ 创建 / 原地 `setPath`；null → `map.remove()`；
 *   组件卸载 → 兜底全清（防泄漏）。
 */
import { useEffect, useRef } from "react";
import type { LL } from "@/lib/nav/route-overview";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TrackLayerProps {
  /** 地图实例（phase==='ready' 后非空） */
  map: any;
  /** 高德命名空间 */
  amap: any;
  /** 是否启用（phase==='ready'） */
  enabled: boolean;
  /** 已驶过路段（GCJ-02 点列；null / <2 点 = 不画） */
  traveled: LL[] | null;
}

/** 读 CSS Token 的 resolved 真值（同 `NavMap.readToken`；含 `(` 视为读不到） */
function readToken(name: string): string | null {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (!v || v.includes("(")) return null;
    return v;
  } catch {
    return null;
  }
}

export default function TrackLayer({ map, amap, enabled, traveled }: TrackLayerProps) {
  const plRef = useRef<any>(null);

  useEffect(() => {
    const removeLine = () => {
      if (!plRef.current) return;
      try {
        map?.remove?.(plRef.current);
      } catch {
        /* ignore */
      }
      plRef.current = null;
    };

    if (!enabled || !map || !amap) {
      removeLine();
      return;
    }

    // 已驶过路段（灰实线，zIndex 74 > 乘车彩段 72）
    if (!traveled || traveled.length < 2) {
      removeLine();
    } else if (!plRef.current) {
      const gray = readToken("--map-line-passed") ?? readToken("--muted");
      if (!gray) return;
      plRef.current = new amap.Polyline({
        path: traveled,
        strokeColor: gray,
        strokeWeight: 6,
        strokeOpacity: 0.88,
        lineJoin: "round",
        lineCap: "round",
        zIndex: 74,
      });
      map.add(plRef.current);
    } else {
      plRef.current.setPath(traveled);
    }
    // 无 per-run cleanup：更新均为原地操作；卸载由下方兜底清理
  }, [enabled, map, amap, traveled]);

  // 卸载兜底
  useEffect(() => {
    return () => {
      try {
        if (plRef.current) map?.remove?.(plRef.current);
      } catch {
        /* ignore */
      }
      plRef.current = null;
    };
  }, [map]);

  return null;
}
