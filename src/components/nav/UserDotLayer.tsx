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
 *
 * ── ★ F2（2026-11-14）朝向箭头：只画，不含"从哪来"───────────────────────
 *   `heading` 有值 ⇒ 在蓝点上叠一层**光锥**（尖端钉在蓝点中心，向前发散、越远越淡），
 *   指向用户面朝的方向；`null` ⇒ 那一层 `display:none`（不是透明，是真不渲染）。
 *   三个必须守住的点（都有门禁钉着）：
 *     ① **独立层 + 独立 effect**：绝不与 `wrap` 的 transform（AMap 锚点偏移）或位置插值共用，
 *        否则"转头"会带动"蓝点位移"，且每帧朝向都会打断 rAF 平滑；
 *     ② **连续角度**：喂给 CSS 的是 `nextArrowDeg()` 的不回绕值（359 → 361，不是 359 → 1），
 *        否则跨正北时箭头会反向绕一整圈；
 *     ③ **死区不写 DOM**：变化 < `ARROW_EPS_DEG` 时一个字节都不写 ——
 *        「静止 10s 箭头位移 0」只能靠"不写"保证，靠"写得足够小"保证不了。
 */
import { useEffect, useRef } from "react";
import { nextArrowDeg } from "@/lib/compass/heading";
import type { UserFix } from "./useUserFix";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** ★ 平滑实现档（可切）：`raf` = 逐帧插值（本 AMap 版本唯一有效路径）；`css` = 给定位节点加 transition */
const SMOOTH_MODE: "raf" | "css" = "raf";
/** 单帧位移超过该值（米）⇒ 视为跳变（换段 / GPS 漂移），不做插值（直接贴） */
const JUMP_MAX_M = 150;
/** 采样间隔超过该值（ms）⇒ 不插值（避免把低频 GPS 抖动放大成缓慢漂移，AC-80） */
const GAP_MAX_MS = 5000;

/** ★ F2：朝向箭头层的类名（CSS 与门禁共用这一个字面量，不要各写一份） */
export const ARROW_CLASS = "user-dot__arrow";

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
  /**
   * ★ F2：用户朝向（0 = 正北，顺时针增大，度）。`null` / 缺省 ⇒ **不显示箭头**，
   * 屏幕与旧版逐像素一致。
   *
   * ⚠️ 这里只负责"画"，不负责"从哪来"：来源（罗盘 / GPS 行进方向 / 正北兜底）与
   *    降级提示是 F3 的事（`pickHeadingMode`）。F2 只把入口留好，由 `NavMap` 透传。
   */
  heading?: number | null;
}

/**
 * 蓝点 DOM content（原生元素；**无「您」字标签** —— 单一蓝点，AC-40/41）。
 * ★ v3.1.1 #4（12 文档 §B.3）：**双层 + ping** ——
 *   `ring`（静态 4px 光圈）+ `ping`（扩散层，只动 transform/opacity）+ `core`（静态核心点）；
 *   旧的「动 box-shadow」呼吸（非合成层、与到站 1.2s 同频）已移除。
 *
 * ── ★ F2（2026-11-14）：新增第 4 个子节点 `arrow`（朝向箭头，默认隐藏）──────
 *   层级顺序固定为 **ring → ping → arrow → core**：
 *     · 光锥画在 core 之下（core 是"我在哪"，不能被挡）；CSS 里 arrow/ping 的 z-index 0、
 *       ring 1、core 2，DOM 顺序只决定同为 0 时的先后（箭头盖住 ping 的正中，无妨）；
 *     · `data-on="0"` ⇒ CSS `display:none`。**没有朝向时它不是"透明"，而是不渲染** ——
 *       这样「userHeading 为 null 时视觉与旧版逐像素一致」是由结构保证的，
 *       不靠"颜色/透明度恰好看不出来"。
 *   ⚠️ 箭头**不得**复用 `wrap` 的 transform：那个 transform 是 AMap 的锚点偏移
 *      （`translate(-8px,-8px)`），且 v3.2.0 的位置平滑就长在这套坐标上；
 *      两者共用一个 transform 会出现「转头带动蓝点位移」。箭头必须独立一层、只写 rotate。
 */
export function buildContent(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "user-dot";
  wrap.title = "您当前的位置";
  const ring = document.createElement("span");
  ring.className = "user-dot__ring";
  const ping = document.createElement("span");
  ping.className = "user-dot__ping";
  const arrow = document.createElement("span");
  arrow.className = ARROW_CLASS;
  /* 默认关闭：调用方没给朝向（`heading` 缺省/null）时，屏幕上与旧版一模一样 */
  arrow.setAttribute("data-on", "0");
  const core = document.createElement("span");
  core.className = "user-dot__core";
  wrap.appendChild(ring);
  wrap.appendChild(ping);
  wrap.appendChild(arrow);
  wrap.appendChild(core);
  return wrap;
}

/** 从蓝点 DOM 里取出箭头层（取不到 ⇒ null；老版本 DOM 兼容） */
export function arrowOf(wrap: HTMLElement | null | undefined): HTMLElement | null {
  if (!wrap) return null;
  return (wrap.querySelector?.(`.${ARROW_CLASS}`) as HTMLElement | null) ?? null;
}

/**
 * 写一帧箭头朝向（**只碰箭头层**）。
 * @param continuousDeg `nextArrowDeg()` 的连续角度（可能 >360，不要先归一化）
 */
export function writeArrowDeg(arrow: HTMLElement, continuousDeg: number): void {
  arrow.setAttribute("data-on", "1");
  /* 保留一位小数：50Hz 传感器下全精度会写一长串无意义小数，且不利于 diff 断言 */
  arrow.style.transform = `rotate(${continuousDeg.toFixed(1)}deg)`;
}

/** 关闭箭头（无朝向 / 降级到"没有罗盘也没有行进方向"时） */
export function writeArrowOff(arrow: HTMLElement): void {
  arrow.setAttribute("data-on", "0");
}

/**
 * 静止死区（度）：连续角度变化小于它就不写 DOM。
 * 为什么要它：传感器 50~60Hz，即使人站着不动，平滑后的值尾数也会动 0.0x°；
 * 每帧写一次 `style.transform` 会让浏览器每帧重排这一层（虽然很便宜），
 * 更要紧的是**验收要求"静止 10s 箭头位移 0"** —— 那必须靠"不写"来保证，而不是"写得足够小"。
 */
export const ARROW_EPS_DEG = 0.1;

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

export default function UserDotLayer({ map, amap, enabled, fix, smoothMs = 0, heading = null }: UserDotLayerProps) {
  const ref = useRef<any>(null);
  /** ★ v3.2.0：当前渲染坐标（rAF 插值起点 / 中断续接用） */
  const curRef = useRef<{ lng: number; lat: number } | null>(null);
  const prevRef = useRef<{ lng: number; lat: number; ts: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  /** ★ F2：箭头层元素（marker 创建时取一次） */
  const arrowRef = useRef<HTMLElement | null>(null);
  /** ★ F2：连续角度（跨 0° 不回绕；`null` = 尚未有朝向） */
  const contRef = useRef<number | null>(null);
  /** ★ F2：上一次真正写进 DOM 的角度（死区判定用） */
  const appliedRef = useRef<number | null>(null);

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
      arrowRef.current = null;
      contRef.current = null;
      appliedRef.current = null;
    };

    if (!enabled || !map || !amap || !fix) {
      remove();
      return;
    }

    const target = [fix.lng, fix.lat] as [number, number];
    const prev = prevRef.current;

    if (!ref.current) {
      // 首次出现：直接落位（不做过渡，避免「从角落滑进来」）
      const content = buildContent();
      ref.current = new amap.Marker({
        position: target,
        content,
        anchor: "center",
        zIndex: 128,
        bubble: false,
      });
      map.add(ref.current);
      curRef.current = { lng: fix.lng, lat: fix.lat };
      /* ★ F2：箭头层一创建就存下来；重建 marker 后角度从头算（旧 DOM 已不存在） */
      arrowRef.current = arrowOf(content);
      contRef.current = null;
      appliedRef.current = null;
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

  /**
   * ★ F2：只更新箭头朝向。
   *
   * ⚠️ 刻意**独立成第二个 effect**，依赖只有 `[heading]`：
   *   ① 若并进上面的定位 effect，每来一帧朝向就会重跑一遍插值逻辑
   *      （`prevRef` 被刷新、rAF 被 `cancelAnimationFrame`），蓝点会走走停停；
   *   ② 朝向与位置是两个独立的数据流，采样频率也不同（位置 ~1Hz，罗盘 50Hz），
   *      合在一起必然互相拖累。
   *   本 effect **只写箭头层的 `style.transform`**，绝不碰 `wrap`（见 buildContent 注释）。
   */
  useEffect(() => {
    const arrow = arrowRef.current;
    if (!arrow) return;

    if (heading == null || !Number.isFinite(heading)) {
      /* 没有可用朝向 ⇒ 彻底关掉（显示"正北"是 F3 的降级选择，不是这里的默认行为：
         这里连"北"都不假定，否则用户会以为箭头指向他面朝的方向） */
      writeArrowOff(arrow);
      contRef.current = null;
      appliedRef.current = null;
      return;
    }

    const next = nextArrowDeg(contRef.current, heading);
    const prev = appliedRef.current;
    // 死区：几乎没变 ⇒ 一个字节都不写（"静止 10s 箭头位移 0"靠它保证）
    if (prev != null && Math.abs(next - prev) < ARROW_EPS_DEG) return;

    writeArrowDeg(arrow, next);
    contRef.current = next;
    appliedRef.current = next;
  }, [heading]);

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
