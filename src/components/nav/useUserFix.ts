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

export function useUserFix(opts: { enabled: boolean; intervalMs: number }): UseUserFixResult {
  const { enabled, intervalMs } = opts;
  const [fix, setFix] = useState<UserFix | null>(null);
  const [denied, setDenied] = useState(false);

  const watchRef = useRef<number | null>(null);
  const lastAcceptRef = useRef(0);
  const pendingRef = useRef<UserFix | null>(null);
  const intervalRef = useRef(intervalMs);
  intervalRef.current = intervalMs;
  const startedRef = useRef(false);

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
          if (f.ts - lastAcceptRef.current >= intervalRef.current) {
            lastAcceptRef.current = f.ts;
            setFix(f);
            pendingRef.current = null;
          }
        },
        () => setDenied(true),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5000 },
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
