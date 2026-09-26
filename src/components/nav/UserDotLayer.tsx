"use client";

/**
 * 地图蓝点图层（src/components/nav/UserDotLayer.tsx，2026-09-25 · v2.14 · 07 §4.5）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   在地图上按用户 GPS（GCJ-02）画**蓝点（人）**；与既有车辆 marker（车）分离，
 *   组成「双标记」（AC-08）。原生 `AMap.Marker`（DOM content）⇒ 拖拽期零 JS、不飘。
 *
 * ── zIndex ────────────────────────────────────────────────────────────
 *   蓝点 **128**（低于车辆 130 ⇒ 重叠时车压人＝「我在车上」）。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────────
 *   `fix` 非空且 `enabled` → 创建 / 原地 `setPosition`；`fix` 为 null / 未就绪 → `map.remove()`；
 *   卸载 → 兜底全清（防泄漏）。
 */
import { useEffect, useRef } from "react";
import type { UserFix } from "./useUserFix";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface UserDotLayerProps {
  map: any;
  amap: any;
  /** 地图就绪（phase === 'ready'） */
  enabled: boolean;
  /** 用户定位（null ⇒ 移除标记） */
  fix: UserFix | null;
}

/**
 * 蓝点 DOM content（原生元素；**无「您」字标签** —— 单一蓝点，AC-40/41）。
 * ★ v3.1.1 #4（12 文档 §B.3）：**双层 + ping** ——
 *   `ring`（静态 4px 光圈）+ `ping`（扩散层，只动 transform/opacity）+ `core`（静态核心点）；
 *   旧的「动 box-shadow」呼吸（非合成层、与到站 1.2s 同频）已移除。
 */
function buildContent(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "user-dot";
  wrap.title = "您当前的位置";
  const ring = document.createElement("span");
  ring.className = "user-dot__ring";
  const ping = document.createElement("span");
  ping.className = "user-dot__ping";
  const core = document.createElement("span");
  core.className = "user-dot__core";
  wrap.appendChild(ring);
  wrap.appendChild(ping);
  wrap.appendChild(core);
  return wrap;
}

export default function UserDotLayer({ map, amap, enabled, fix }: UserDotLayerProps) {
  const ref = useRef<any>(null);

  useEffect(() => {
    const remove = () => {
      if (!ref.current) return;
      try {
        map?.remove?.(ref.current);
      } catch {
        /* ignore */
      }
      ref.current = null;
    };

    if (!enabled || !map || !amap || !fix) {
      remove();
      return;
    }
    if (!ref.current) {
      ref.current = new amap.Marker({
        position: [fix.lng, fix.lat],
        content: buildContent(),
        anchor: "center",
        zIndex: 128,
        bubble: false,
      });
      map.add(ref.current);
    } else {
      ref.current.setPosition([fix.lng, fix.lat]);
    }
  }, [enabled, map, amap, fix]);

  // 卸载兜底
  useEffect(() => {
    return () => {
      try {
        if (ref.current) map?.remove?.(ref.current);
      } catch {
        /* ignore */
      }
      ref.current = null;
    };
  }, [map]);

  return null;
}
