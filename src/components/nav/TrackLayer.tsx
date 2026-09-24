"use client";

/**
 * 导航追踪图层（src/components/nav/TrackLayer.tsx，2026-09-24 新增）
 *
 * ── 为什么独立成层（沿用 `VehicleLayer` 的论证）───────────────────────────
 *   位置由**地图引擎驱动**（原生 `AMap.Marker` / `AMap.Polyline`）；
 *   拖拽期**零 JS、零 React 更新** ⇒ 与地图变换同循环，不「飘」。
 *
 * ── 元素（导航追踪态）────────────────────────────────────────────────────
 *   · **「您」标记**：原生 marker（DOM content，`anchor:'center'`，zIndex **140** > 车辆 130）
 *     —— 位置 = 用户所乘班车的实时坐标（12s 轮询节奏，直接 setPosition，无需动画）；
 *   · **已驶过路段**：绿色覆层 polyline（`--brand-green` 读 Token 真值；zIndex **74** >
 *     乘车彩段 72）—— 每次数据刷新 `setPath`。
 *
 * ── 生命周期 ──────────────────────────────────────────────────────────────
 *   追踪开始（props 变为非空）→ 创建 / 原地更新；追踪结束（null）→ `map.remove()`；
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
  /** 「您」的位置（锁定车辆的实时坐标；null = 不显示） */
  you: { lng: number; lat: number; label?: string } | null;
  /** 已驶过路段（GCJ-02 点列；null / <2 点 = 不画） */
  traveled: LL[] | null;
}

/**
 * 读 CSS Token 的 resolved 真值（与 `NavMap.readToken` 同款；此处本地重复 8 行换零耦合）。
 * 画布绘制拿不到 `var()`；值里含 `(`（未解析的 color-mix 等）⇒ 视为读不到。
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

/** 「您」标记的 DOM content（原生元素；文字只在 label 变化时更新） */
function buildContent(label: string): { el: HTMLElement; tag: HTMLElement } {
  const wrap = document.createElement("div");
  wrap.className = "nav-you";
  wrap.title = label ? `您（${label}）` : "您";
  const dot = document.createElement("span");
  dot.className = "nav-you__dot";
  const tag = document.createElement("span");
  tag.className = "nav-you__tag";
  tag.textContent = label || "您";
  wrap.appendChild(dot);
  wrap.appendChild(tag);
  return { el: wrap, tag };
}

export default function TrackLayer({ map, amap, enabled, you, traveled }: TrackLayerProps) {
  const markerRef = useRef<any>(null);
  const tagRef = useRef<HTMLElement | null>(null);
  const plRef = useRef<any>(null);

  useEffect(() => {
    const removeMarker = () => {
      if (!markerRef.current) return;
      try {
        map?.remove?.(markerRef.current);
      } catch {
        /* ignore */
      }
      markerRef.current = null;
      tagRef.current = null;
    };
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
      removeMarker();
      removeLine();
      return;
    }

    // ① 「您」标记（创建一次，之后原地 setPosition）
    if (!you) {
      removeMarker();
    } else {
      if (!markerRef.current) {
        const { el, tag } = buildContent(you.label ?? "您");
        tagRef.current = tag;
        markerRef.current = new amap.Marker({
          position: [you.lng, you.lat],
          content: el,
          anchor: "center",
          zIndex: 140,
          bubble: false,
        });
        map.add(markerRef.current);
      } else {
        markerRef.current.setPosition([you.lng, you.lat]);
        if (tagRef.current && you.label && tagRef.current.textContent !== you.label) {
          tagRef.current.textContent = you.label;
        }
      }
    }

    // ② 已驶过路段（绿色覆层）
    if (!traveled || traveled.length < 2) {
      removeLine();
    } else if (!plRef.current) {
      const green = readToken("--brand-green") ?? "#0b6e4f";
      plRef.current = new amap.Polyline({
        path: traveled,
        strokeColor: green,
        strokeWeight: 6,
        strokeOpacity: 0.95,
        lineJoin: "round",
        lineCap: "round",
        zIndex: 74,
      });
      map.add(plRef.current);
    } else {
      plRef.current.setPath(traveled);
    }
    // 无 per-run cleanup：更新均为原地操作；卸载由下方兜底清理
  }, [enabled, map, amap, you, traveled]);

  // 卸载兜底
  useEffect(() => {
    return () => {
      try {
        if (markerRef.current) map?.remove?.(markerRef.current);
      } catch {
        /* ignore */
      }
      try {
        if (plRef.current) map?.remove?.(plRef.current);
      } catch {
        /* ignore */
      }
      markerRef.current = null;
      plRef.current = null;
      tagRef.current = null;
    };
  }, [map]);

  return null;
}
