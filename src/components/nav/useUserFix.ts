"use client";

/**
 * 用户实时定位通道（src/components/nav/useUserFix.ts，2026-09-25 · v2.14 · 07 §2）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   `navigator.geolocation.watchPosition` → **WGS84 → GCJ-02** → 节流为 `userFix` 序列；
 *   驱动地图蓝点、走向车站距离、上车判定 R2、安全网佐证（**不参与站序进度**）。
 *
 * ── 关键实现要点 ──────────────────────────────────────────────────────
 *   · **节流**：回调到达时若 `ts - lastAccept < intervalMs` 则暂存 `pending`；
 *     到达阈值时采纳（尾帧不丢、又不高频 setState）；
 *   · `intervalMs` 经 ref 读取 ⇒ **不重订阅** watchPosition（重订阅会丢监听 + 二次权限）；
 *   · ★ v3.2.0（AC-79）：`maximumAge`（默认 **0**）经 ref 读取 —— 导航态只用新鲜坐标，
 *     避免陈旧坐标导致蓝点/读数跳变；
 *   · **权限申请＝用户手势**：由调用方在「开始导航」onClick 内调用 `start()`；
 *   · **页面隐藏** → `clearWatch`；可见 → 重订阅并重置节流计时；
 *   · 卸载 → `clearWatch` 兜底。
 *
 * ⚠️ 坐标铁律：GPS 返回 WGS84 必须转 GCJ-02；**禁止**与 `AMap.Geolocation`（已 GCJ-02）混用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { wgs84ToGcj02 } from "@/lib/amap/coord";

/** 用户实时定位（GCJ-02；已由 wgs84ToGcj02 转换） */
export interface UserFix {
  lng: number;
  lat: number;
  /** 水平精度（米） */
  accuracy: number;
  /** 采样时刻（设备时钟 ms） */
  ts: number;
}

export interface UseUserFixResult {
  fix: UserFix | null;
  /** 定位不可用（拒权 / 超时 / 失败）—— 供降级链读取 */
  denied: boolean;
  /** 在用户手势内调用：申请权限并开始订阅 */
  start: () => void;
  stop: () => void;
}

export function useUserFix(opts: {
  enabled: boolean;
  intervalMs: number;
  /**
   * ★ v3.2.0（AC-79）：`watchPosition` 的 `maximumAge`（ms）。
   *   默认 **0** = 只用新鲜坐标（导航中避免陈旧坐标导致读数跳变）；浏览态可放宽。
   */
  maximumAge?: number;
}): UseUserFixResult {
  const { enabled, intervalMs, maximumAge = 0 } = opts;
  const [fix, setFix] = useState<UserFix | null>(null);
  const [denied, setDenied] = useState(false);

  const watchRef = useRef<number | null>(null);
  const lastAcceptRef = useRef(0);
  const pendingRef = useRef<UserFix | null>(null);
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const maxAgeRef = useRef(maximumAge);
  maxAgeRef.current = maximumAge;
  const startedRef = useRef(false);
  /** ★ 2026-10-30：是否曾成功拿到过一帧（成功即把 `denied` 复位） */
  const hasFixRef = useRef(false);
  /** ★ 2026-10-30：非「拒权」类失败的连续次数（超时/信号弱，2 次才降级为不可用） */
  const softFailRef = useRef(0);

  const stopWatch = useCallback(() => {
    if (watchRef.current != null) {
      try {
        navigator.geolocation.clearWatch(watchRef.current);
      } catch {
        /* ignore */
      }
      watchRef.current = null;
    }
  }, []);

  const doWatch = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setDenied(true);
      return;
    }
    if (watchRef.current != null) return;
    try {
      watchRef.current = navigator.geolocation.watchPosition(
        (pos) => {
          const c = pos.coords;
          const g = wgs84ToGcj02({ lat: c.latitude, lng: c.longitude });
          const f: UserFix = {
            lng: g.lng,
            lat: g.lat,
            accuracy: Number.isFinite(c.accuracy) ? c.accuracy : 100,
            ts: Date.now(),
          };
          pendingRef.current = f;
          hasFixRef.current = true;
          softFailRef.current = 0;
          setDenied(false);
          if (f.ts - lastAcceptRef.current >= intervalRef.current) {
            lastAcceptRef.current = f.ts;
            setFix(f);
            pendingRef.current = null;
          }
        },
        (err) => {
          /**
           * ★ 2026-10-30：**区分错误类别**（旧实现任何 error 都 `denied=true` 且成功后也不复位
           *   ⇒ 室内首帧超时就会被永久判定「定位不可用」，即使随后 GPS 已正常）。
           *   · PERMISSION_DENIED(1) ⇒ 硬拒权，直接不可用；
           *   · 其余（TIMEOUT=3 / POSITION_UNAVAILABLE=2）⇒ 信号弱/暂不可用，
           *     只有**从未成功过**且连续失败 ≥2 次才判不可用，且成功后自动复位。
           */
          if (err?.code === 1) {
            setDenied(true);
            return;
          }
          softFailRef.current += 1;
          if (!hasFixRef.current && softFailRef.current >= 2) setDenied(true);
        },
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: maxAgeRef.current },
      );
      setDenied(false);
    } catch {
      setDenied(true);
    }
  }, []);

  const start = useCallback(() => {
    startedRef.current = true;
    doWatch();
  }, [doWatch]);

  const stop = useCallback(() => {
    startedRef.current = false;
    stopWatch();
    pendingRef.current = null;
    setFix(null);
  }, [stopWatch]);

  /** enabled=false（离开导航态）⇒ 停订阅、清 fix */
  useEffect(() => {
    if (!enabled) {
      stopWatch();
      pendingRef.current = null;
      setFix(null);
    }
  }, [enabled, stopWatch]);

  /** 尾帧 flush（保证「到达阈值」的 pending 被采纳；节流下限由 lastAccept 守） */
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => {
      const p = pendingRef.current;
      if (p && p.ts - lastAcceptRef.current >= intervalRef.current) {
        lastAcceptRef.current = p.ts;
        setFix(p);
        pendingRef.current = null;
      }
    }, 2000);
    return () => window.clearInterval(t);
  }, [enabled]);

  /** 页面可见性：隐藏 → 停；可见 → 重订阅并重置节流计时 */
  useEffect(() => {
    if (!enabled) return;
    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (startedRef.current) {
          lastAcceptRef.current = 0;
          doWatch();
        }
      } else {
        stopWatch();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, doWatch, stopWatch]);

  /** 卸载兜底 */
  useEffect(() => () => stopWatch(), [stopWatch]);

  return { fix, denied, start, stop };
}
