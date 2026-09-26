"use client";

/**
 * 地图蓝点图层（src/components/nav/UserDotLayer.tsx，2026-09-25 · v2.14 · 07 §4.5；★ v3.2.0 增平滑）
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
 *
 * ── ★ v3.2.0（需求 7 / AC-80）蓝点平滑：实现档 = **rAF 逐帧插值** ────────────────
 *   **线上 DOM 探针实测结论**（`.verify/probe-v320-dotdom.mjs` · 06 §4）：
 *     AMap 4.x `Marker({content})` 的**坐标定位写在外层 `.amap-marker` 容器的 `top` / `left`**
 *     （绝对定位），**不是 `transform`** —— 容器上的 `transform: translate(-8px,-8px)` 只是
 *     **锚点偏移（静态、不随位置变）**。⇒ 规格假设的「给定位节点加 `transition: transform`」
 *     **对本 AMap 版本是 no-op**；而在容器上加 `transition: top/left` 会让 marker 在地图
 *     拖动/缩放时**整体滞后**（AMap 每帧改 top/left）。
 *   ⇒ 采用架构师 **方案 3（回退路径）**：`UserDotLayer` 自持 `from→to` 的 **rAF 匀速插值**，
 *     逐帧 `setPosition(lerp)`。不依赖 DOM 层级、稳定性最高，观感目标不变（匀速直线）。
 *   · `SMOOTH_MODE` 可一句话切回 `"css"`（把过渡施加在被 AMap 定位的节点）—— **可切**，
 *     供未来 AMap 版本改用 `transform` 定位时复用；两种实现并存、互斥。
 *   · 抑制插值：冻结（无新帧）· 首次出现 · 单帧位移超阈值（换段/大跳变）· 采样间隔 >5s · 减动效。
 *   · 与 ping 呼吸（`.user-dot__ping` 只动自身 transform/opacity）**互不干扰**：本层只调 `setPosition`。
 */
import { useEffect, useRef } from "react";
import type { UserFix } from "./useUserFix";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** ★ 平滑实现档（可切）：`raf` = 逐帧插值（本 AMap 版本唯一有效路径）；`css` = 给定位节点加 transition */
const SMOOTH_MODE: "raf" | "css" = "raf";
/** 单帧位移超过该值（米）⇒ 视为跳变（换段 / GPS 漂移），不做插值（直接贴） */
const JUMP_MAX_M = 150;
/** 采样间隔超过该值（ms）⇒ 不插值（避免把低频 GPS 抖动放大成缓慢漂移，AC-80） */
const GAP_MAX_MS = 5000;

export interface UserDotLayerProps {
  map: any;
  amap: any;
  /** 地图就绪（phase === 'ready'） */
  enabled: boolean;
  /** 用户定位（null ⇒ 移除标记） */
  fix: UserFix | null;
  /**
   * ★ v3.2.0（AC-80）：移动插值时长（ms，= 采样间隔）；`0`（缺省）= 瞬移不插值。
   *   调用方按档位下发：riding 1500 / 候车 3000 / 浏览 0（>5s 采样必为 0）。
   */
  smoothMs?: number;
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

/** 距离（米，粗略）；仅用于「跳变」判定，无需精确 */
function distM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * 110_540);
}

/** 是否允许本次过渡（有上一帧 + 间隔 ≤5s + 位移不超阈值 + 有时长 + 未开减动效） */
function tweenAllowed(prev: { lng: number; lat: number; ts: number } | null, fix: UserFix, smoothMs: number): boolean {
  if (!prev || smoothMs <= 0) return false;
  const gap = fix.ts - prev.ts;
  if (gap <= 0 || gap > GAP_MAX_MS) return false;
  if (distM(prev, fix) > JUMP_MAX_M) return false;
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return false;
  return true;
}

export default function UserDotLayer({ map, amap, enabled, fix, smoothMs = 0 }: UserDotLayerProps) {
  const ref = useRef<any>(null);
  /** ★ v3.2.0：当前渲染坐标（rAF 插值起点 / 中断续接用） */
  const curRef = useRef<{ lng: number; lat: number } | null>(null);
  const prevRef = useRef<{ lng: number; lat: number; ts: number } | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const stopRaf = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    const remove = () => {
      stopRaf();
      if (!ref.current) return;
      try {
        map?.remove?.(ref.current);
      } catch {
        /* ignore */
      }
      ref.current = null;
      curRef.current = null;
      prevRef.current = null;
    };

    if (!enabled || !map || !amap || !fix) {
      remove();
      return;
    }

    const target = [fix.lng, fix.lat] as [number, number];
    const prev = prevRef.current;

    if (!ref.current) {
      // 首次出现：直接落位（不做过渡，避免「从角落滑进来」）
      ref.current = new amap.Marker({
        position: target,
        content: buildContent(),
        anchor: "center",
        zIndex: 128,
        bubble: false,
      });
      map.add(ref.current);
      curRef.current = { lng: fix.lng, lat: fix.lat };
    } else {
      const allow = tweenAllowed(prev, fix, smoothMs);
      if (!allow) {
        stopRaf();
        ref.current.setPosition(target);
        curRef.current = { lng: fix.lng, lat: fix.lat };
      } else if (SMOOTH_MODE === "raf") {
        // ── 方案 3：自持 from→to 逐帧插值（不依赖 AMap DOM 层级）──
        stopRaf();
        const from = curRef.current ?? { lng: prev!.lng, lat: prev!.lat };
        const dur = Math.min(smoothMs, fix.ts - prev!.ts);
        const t0 = performance.now();
        const step = () => {
          const k = Math.min(1, (performance.now() - t0) / dur);
          const lng = from.lng + (fix.lng - from.lng) * k;
          const lat = from.lat + (fix.lat - from.lat) * k;
          try {
            ref.current?.setPosition([lng, lat]);
          } catch {
            /* ignore */
          }
          curRef.current = { lng, lat };
          if (k < 1) rafRef.current = requestAnimationFrame(step);
          else {
            rafRef.current = null;
            // 收尾精确贴靶（防浮点残差）
            try {
              ref.current?.setPosition(target);
            } catch {
              /* ignore */
            }
            curRef.current = { lng: fix.lng, lat: fix.lat };
          }
        };
        rafRef.current = requestAnimationFrame(step);
      } else {
        // ── 方案 2（备用 · 可切）：给「被 AMap 定位的节点」施 transition，再 setPosition ──
        stopRaf();
        const node =
          (ref.current?.getContentDom?.() as HTMLElement | null) ??
          (ref.current?.getContentDom?.()?.parentElement as HTMLElement | null) ??
          null;
        if (node) {
          node.style.transition = `transform ${Math.min(smoothMs, fix.ts - prev!.ts)}ms linear`;
          node.style.willChange = "transform";
        }
        ref.current.setPosition(target);
        curRef.current = { lng: fix.lng, lat: fix.lat };
      }
    }
    prevRef.current = { lng: fix.lng, lat: fix.lat, ts: fix.ts };
  }, [enabled, map, amap, fix, smoothMs]);

  // 卸载兜底
  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
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
