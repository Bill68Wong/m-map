"use client";

/**
 * 乘车追踪数据流（src/components/nav/useRideTracking.ts，2026-09-24 新增）
 *
 * ── 状态机（用户口径「官方班车跟踪为主 + 手动兜底」）──────────────────────
 *   ```
 *   off ──「开始导航」──▶ boarding ──「我已上车」──▶ riding ──「我已下车」──▶
 *         （等待上车）      （锁定车辆+12s 轮询）        ├─ 还有下一程 ⇒ 回 boarding
 *                                                        └─ 最后一程 ⇒ done（到达）
 *   ```
 *   · `boarding`：显示上车站与候选车；点「我已上车」= 从在途车中**锁定车牌**（可换车）；
 *   · `riding`  ：每 12s 轮询 `/api/route-vehicles`（与官网地图 15s 刷新同量级），
 *     以「挂靠站 / 行驶区间」推进进度；坐标投影切割「已驶过路段」（供地图变绿）；
 *   · 下一站 = 下车站 ⇒ **横幅 + 震动**提醒（`navigator.vibrate`；iOS 浏览器不支持震动，
 *     自动退化为仅横幅——如实告知，不假装）；到站 ⇒ 再提醒一次；
 *   · 任何异常（丢信号 / 对不上站序）⇒ **冻结上次进度 + 提示**，绝不乱跳；
 *   · 屏幕常亮（Wake Lock）：在用户手势（开始导航）里申请——浏览器硬性要求；
 *     页面切回前台自动重新申请；失败静默（不阻塞任何功能）。
 *
 * ⚠️ 轻轨段 / 几何降级段：官方无逐车数据 ⇒ 自动进度不可用，手动模式照常
 *   （「我已上车 / 我已下车」仍可用，站条不显示实时位置）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CUT_TOLERANCE_M, cutAt, mainOf, progressOf, rankBoardingVehicles, type TrackProgress, type TrackVehicle } from "@/lib/nav/track";
import type { LL, ColoredLeg, OverviewLegInput } from "@/lib/nav/route-overview";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { VehicleLite } from "./VehicleMarker";

/** 轮询间隔（毫秒）——与官网地图 15s 刷新同量级；快一点只为站级切换更跟手 */
const POLL_MS = 12_000;
/** 连续丢信号判定（次）——达到即提示（进度保持冻结） */
const MISS_LIMIT = 3;

export type RidePhase = "off" | "boarding" | "riding" | "done";

/** 交给 UI 的视图/操作集合（NavShell 组装；RouteSheet→pane→body 透传） */
export interface RideTrackView {
  phase: RidePhase;
  /** 当前乘车段下标（= card.rides 下标） */
  legIndex: number;
  /** 已锁定的车牌（null = 未锁定） */
  plate: string | null;
  /** 进度（null = 无自动进度：轻轨/降级/未锁定） */
  prog: TrackProgress | null;
  /** 下车提醒级别：none / soon（下一站是下车站）/ now（已到下车站） */
  alarm: "none" | "soon" | "now";
  /** 已驶过路段的绿色路径（地图用；null = 不画） */
  traveled: LL[] | null;
  /** 轮询进行中（刷新键转圈用） */
  traveling: boolean;
  /** 状态提示（丢信号 / 候车为空等） */
  note: string;
  /** 候选车辆（上车/换车用；已排序） */
  candidates: { plate: string; hint: string }[];
  onStart: () => void;
  onStop: () => void;
  onBoard: () => void;
  onRepick: (plate: string) => void;
  onAlight: () => void;
  onRefresh: () => void;
}

export interface UseRideTrackingOpts {
  card: RecommendCard | null;
  /** 总览几何（含 dir / colored polyline）——由 useRouteOverview 提供 */
  legs: ColoredLeg[];
  /** 段几何锚点（含上车站坐标）——由 detail-body legs 提供 */
  anchors: OverviewLegInput[] | null;
  /** 站条（含逐站码）——由 detail-body strips 提供 */
  strips: SegmentStrip[] | null;
  /** 是否处于详情 pane 打开态（关闭即停） */
  active: boolean;
}

/** 车辆 → 简短提示（候选列表用） */
function hintOf(v: TrackVehicle): string {
  if (v.atStation?.code) return `${v.atStation.code} 停靠中`;
  if (v.interval?.from?.code) return `${v.interval.from.code} → ${v.interval.to?.code ?? "?"}`;
  return "";
}

export function useRideTracking(opts: UseRideTrackingOpts): RideTrackView {
  const { card, legs, anchors, strips, active } = opts;

  const [phase, setPhase] = useState<RidePhase>("off");
  const [legIndex, setLegIndex] = useState(0);
  const [plate, setPlate] = useState<string | null>(null);
  const [prog, setProg] = useState<TrackProgress | null>(null);
  const [alarm, setAlarm] = useState<"none" | "soon" | "now">("none");
  const [traveled, setTraveled] = useState<LL[] | null>(null);
  const [traveling, setTraveling] = useState(false);
  const [note, setNote] = useState("");
  const [candidates, setCandidates] = useState<{ plate: string; hint: string }[]>([]);

  /** 上一帧车辆（换车/丢信号判定用） */
  const vehicleRef = useRef<TrackVehicle | null>(null);
  const missRef = useRef(0);
  const alarmRef = useRef<"none" | "soon" | "now">("none");
  const lockRef = useRef<{ release: () => Promise<void> } | null>(null);

  /** 本段站序（主码） */
  const stopMains = useMemo(() => {
    const s = strips?.[legIndex];
    return s ? s.stops.map((k) => mainOf(k.code)) : [];
  }, [strips, legIndex]);

  /** 上车站坐标（GCJ-02；从 detail-body legs 取）；useMemo 稳定引用供 useCallback 依赖 */
  const boardAnchor = anchors?.[legIndex]?.board ?? null;
  const boardPos = useMemo(
    () => (boardAnchor ? { lng: boardAnchor.lng, lat: boardAnchor.lat } : null),
    [boardAnchor],
  );

  /** 终点/重置：切换卡片或关闭详情 → 整机复位（拖到 done 则保留「已到达」视觉由调用方决定） */
  useEffect(() => {
    if (!active) {
      setPhase("off");
      setLegIndex(0);
      setPlate(null);
      setProg(null);
      setAlarm("none");
      setTraveled(null);
      setNote("");
      setCandidates([]);
      vehicleRef.current = null;
      missRef.current = 0;
      alarmRef.current = "none";
    }
  }, [active]);
  useEffect(() => {
    // 卡片更换（含切换方案）→ 复位
    setPhase("off");
    setLegIndex(0);
    setPlate(null);
    setProg(null);
    setAlarm("none");
    setTraveled(null);
    setNote("");
    setCandidates([]);
    vehicleRef.current = null;
    missRef.current = 0;
    alarmRef.current = "none";
  }, [card]);

  /** 震动（不支持则静默；iOS Safari 无此 API，仅横幅提醒） */
  const buzz = useCallback((pattern: number | number[]) => {
    try {
      if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
    } catch {
      /* 忽略 */
    }
  }, []);

  /** 屏幕常亮（手势内申请；切回前台重申请；失败静默） */
  const acquireWake = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (!nav.wakeLock) return;
      lockRef.current = await nav.wakeLock.request("screen");
    } catch {
      /* 低电量 / 策略拒绝 / 非手势 —— 静默 */
    }
  }, []);
  const releaseWake = useCallback(() => {
    try {
      void lockRef.current?.release();
    } catch {
      /* 忽略 */
    }
    lockRef.current = null;
  }, []);

  useEffect(() => {
    if (phase === "off") return;
    const onVis = () => {
      if (document.visibilityState === "visible") void acquireWake();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [phase, acquireWake]);
  useEffect(() => () => releaseWake(), [releaseWake]);

  /** 拉一帧车辆数据（board 与轮询共用；锁定时只认同一车牌） */
  const fetchFrame = useCallback(
    async (lockPlate: string | null): Promise<void> => {
      const leg = legs[legIndex];
      const dir = leg?.dir;
      if (!leg || !dir || leg.kind !== "bus") {
        setNote("该程暂无自动进度（轻轨或几何缺失），可对照站名手动确认");
        return;
      }
      setTraveling(true);
      try {
        const r = await fetch(
          `/api/route-vehicles?code=${encodeURIComponent(leg.route)}&dir=${encodeURIComponent(dir)}&kind=bus`,
          { cache: "no-store" },
        );
        const j = (await r.json()) as { vehicles?: VehicleLite[] };
        const list: TrackVehicle[] = (j.vehicles ?? []).map((v) => ({
          plate: v.plate,
          lat: v.lat,
          lng: v.lng,
          status: String(v.status ?? "unknown"),
          interval: v.interval ?? null,
          atStation: v.atStation ?? null,
        }));

        const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
        if (!lockPlate) {
          // 候车态：只更新候选列表（供「我已上车」）
          const ranked = rankBoardingVehicles(list, boardMain, boardPos);
          setCandidates(ranked.slice(0, 6).map((v) => ({ plate: v.plate, hint: hintOf(v) })));
          setNote(ranked.length ? "" : "这条线暂时查不到在途车辆，稍后重试或直接手动上车");
          return;
        }

        // 追踪态：找锁定车牌
        const v = list.find((x) => x.plate === lockPlate) ?? null;
        if (!v) {
          missRef.current += 1;
          if (missRef.current >= MISS_LIMIT) setNote("车辆信号暂时丢失（进度已冻结，恢复后自动续上）");
          return;
        }
        missRef.current = 0;
        setNote("");
        vehicleRef.current = v;

        // ① 站序进度（对不上 → 冻结上次，不覆盖）
        const p = progressOf(stopMains, v);
        if (p.kind === "at" || p.kind === "between") setProg(p);

        // ② 已驶过路段切割（投影超容差 → 冻结；只在几何可信时画）
        if (leg.colored.length >= 2 && !leg.degraded) {
          const cut = cutAt(leg.colored, { lng: v.lng, lat: v.lat });
          if (cut.dist <= CUT_TOLERANCE_M && cut.idx >= 1) {
            setTraveled([...leg.colored.slice(0, cut.idx + 1), [v.lng, v.lat] as LL]);
          }
        }
      } catch {
        setNote("车辆数据获取失败，稍后自动重试");
      } finally {
        setTraveling(false);
      }
    },
    [legs, legIndex, strips, boardPos, stopMains, anchors],
  );

  /** 轮询（riding 且已锁定） */
  useEffect(() => {
    if (phase !== "riding" || !plate || !active) return;
    void fetchFrame(plate);
    const t = window.setInterval(() => void fetchFrame(plate), POLL_MS);
    return () => window.clearInterval(t);
  }, [phase, plate, active, fetchFrame]);

  /** 下车提醒（下一站 = 下车站 ⇒ soon；到站 ⇒ now；级别跃升时震一次） */
  useEffect(() => {
    if (phase !== "riding" || !prog || stopMains.length < 2) {
      setAlarm("none");
      alarmRef.current = "none";
      return;
    }
    const alightIdx = stopMains.length - 1;
    const next: "none" | "soon" | "now" =
      prog.atIdx === alightIdx ? "now" : prog.nextIdx === alightIdx ? "soon" : "none";
    setAlarm(next);
    if (next !== "none" && next !== alarmRef.current) {
      buzz(next === "now" ? [220, 80, 220] : [180, 80, 180]); // 到站/临近 各一次
    }
    alarmRef.current = next;
  }, [phase, prog, stopMains, buzz]);

  /* ── 操作 ── */

  const start = useCallback(() => {
    setPhase("boarding");
    setLegIndex((i) => (card && i < card.rides.length ? i : 0));
    setNote("");
    void acquireWake(); // ★ 必须在用户手势内申请
  }, [card, acquireWake]);

  const stop = useCallback(() => {
    setPhase("off");
    setPlate(null);
    setProg(null);
    setAlarm("none");
    setTraveled(null);
    setNote("");
    setCandidates([]);
    alarmRef.current = "none";
    releaseWake();
  }, [releaseWake]);

  const board = useCallback(() => {
    void (async () => {
      const leg = legs[legIndex];
      if (!leg) return;
      if (leg.kind !== "bus" || !leg.dir) {
        // 轻轨 / 几何缺失：手动模式直接进入 riding（无自动进度）
        setPhase("riding");
        setPlate(null);
        setNote("该程暂无自动进度（轻轨或几何缺失），可对照站名手动确认");
        return;
      }
      setTraveling(true);
      try {
        const r = await fetch(
          `/api/route-vehicles?code=${encodeURIComponent(leg.route)}&dir=${encodeURIComponent(leg.dir)}&kind=bus`,
          { cache: "no-store" },
        );
        const j = (await r.json()) as { vehicles?: VehicleLite[] };
        const list: TrackVehicle[] = (j.vehicles ?? []).map((v) => ({
          plate: v.plate,
          lat: v.lat,
          lng: v.lng,
          status: String(v.status ?? "unknown"),
          interval: v.interval ?? null,
          atStation: v.atStation ?? null,
        }));
        const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
        const ranked = rankBoardingVehicles(list, boardMain, boardPos);
        setCandidates(ranked.slice(0, 6).map((v) => ({ plate: v.plate, hint: hintOf(v) })));
        if (!ranked.length) {
          setNote("这条线暂时查不到在途车辆，稍后重试，或直接改为手动模式");
          return;
        }
        setPlate(ranked[0].plate);
        setPhase("riding");
      } catch {
        setNote("车辆数据获取失败，请稍后重试");
      } finally {
        setTraveling(false);
      }
    })();
  }, [legs, legIndex, strips, boardPos, anchors]);

  const repick = useCallback((p: string) => {
    setPlate(p);
    missRef.current = 0;
    setNote("");
    setProg(null);
    setTraveled(null);
  }, []);

  const alight = useCallback(() => {
    const total = card?.rides.length ?? 1;
    setProg(null);
    setTraveled(null);
    setAlarm("none");
    alarmRef.current = "none";
    setPlate(null);
    vehicleRef.current = null;
    missRef.current = 0;
    buzz([120, 60, 120]);
    if (legIndex + 1 < total) {
      setLegIndex((i) => i + 1);
      setPhase("boarding");
      setNote("");
    } else {
      setPhase("done");
      releaseWake();
    }
  }, [card, legIndex, buzz, releaseWake]);

  const onRefresh = useCallback(() => {
    if (phase === "riding" && plate) void fetchFrame(plate);
    else if (phase === "boarding") void fetchFrame(null);
  }, [phase, plate, fetchFrame]);

  /** 候车态进入即拉一次候选（含从 riding 回到 boarding） */
  useEffect(() => {
    if (phase === "boarding" && active && legs[legIndex]) void fetchFrame(null);
    // fetchFrame 已按 legs/legIndex 稳定；此处只随 phase 跃迁触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, active, legIndex]);

  return {
    phase,
    legIndex,
    plate,
    prog,
    alarm,
    traveled,
    traveling,
    note,
    candidates,
    onStart: start,
    onStop: stop,
    onBoard: board,
    onRepick: repick,
    onAlight: alight,
    onRefresh,
  };
}

/** 兜底：从 strips 里取本段上车站主码（leg.board 缺失时） */
function stopsBoard(strips: SegmentStrip[] | null, legIndex: number): string {
  const s = strips?.[legIndex];
  return s?.stops?.[0]?.code ? mainOf(s.stops[0].code) : "";
}
