"use client";

/**
 * 乘车追踪数据流（src/components/nav/useRideTracking.ts，v2.14 · 2026-09-25 重修）
 *
 * ── 状态机（全自动上车 + 安全网）─────────────────────────────────────
 *   ```
 *   off ──「开始导航」──▶ boarding ──〔自动：R1/R2/轻轨R2〕──▶ riding ──〔自动/手动 下车〕──▶
 *         （车人分离）        （锁定车辆+12s 轮询 | GPS 驱动）   ├─ 还有下一程 ⇒ 回 boarding
 *                                                               └─ 最后一程 ⇒ done
 *   纠错入口（riding 常驻）：我没上车（回 boarding）· 不是这辆（换车）· 我已下车（推进）
 *   ```
 *   · 车辆通道（权威）：12s 轮询 `/api/route-vehicles` → 进度 / 已驶过切割 / 提醒（有车牌）；
 *   · GPS 通道（新增 `userFix`）：上车判定 R2、地图蓝点、轻轨段 GPS 推算推进；
 *   · **对不上就冻结**（丢信号 / 站序对不上 ⇒ 冻结上次进度 + 提示，绝不乱跳）。
 *
 * 判据与安全网抽到 `lib/nav/boarding-detect.ts`；轻轨推进抽到 `lib/nav/lrt-progress.ts`（纯函数、可单测）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CUT_TOLERANCE_M,
  cutAt,
  mainOf,
  progressOf,
  rankBoardingVehicles,
  type TrackProgress,
  type TrackVehicle,
} from "@/lib/nav/track";
import { advanceLrt, buildLrtLadder, type LrtLadder } from "@/lib/nav/lrt-progress";
import {
  ANOMALY_CONFIRM,
  ANOMALY_MIN_GAP_MS,
  autoBoardOf,
  anomalyOf,
  type Anomaly,
  type AutoBoardResult,
  type FixLite,
} from "@/lib/nav/boarding-detect";
import type { LL, ColoredLeg, OverviewLegInput } from "@/lib/nav/route-overview";
import type { RecommendCard, SegmentStrip } from "@/lib/recommend/types";
import type { VehicleLite } from "./VehicleMarker";
import type { UserFix } from "./useUserFix";

/** 轮询间隔（毫秒）——与官网地图 15s 刷新同量级 */
const POLL_MS = 12_000;
/** 连续丢信号判定（次）——达到即提示（进度保持冻结） */
const MISS_LIMIT = 3;
/** GPS 采样窗口保留时长（ms） */
const FIX_KEEP_MS = 90_000;

/* ── 文案（去 AI 化；06 §4 最终文案表）── */
const NOTE_NO_PROGRESS = "这段暂时看不到实时进度，请对照站名，快到了自己下车";
const NOTE_FROZEN_BUS = "暂时收不到这辆车的信号 · 位置停在上一站，恢复后会自动跟上";
const NOTE_NO_VEHICLES = "这条线现在查不到车 · 稍后再试，或直接点「我已上车」";
const NOTE_NO_VEHICLES_BOARD = "这条线现在查不到车 · 稍后再试，或直接点「我已上车」自己开始";
const NOTE_LRT_WEAK = "暂时收不到信号 · 位置停在上一站";
const NOTE_FETCH_FAIL = "车辆数据获取失败，稍后自动重试";

export type RidePhase = "off" | "boarding" | "riding" | "done";

export interface RideTrackView {
  phase: RidePhase;
  legIndex: number;
  plate: string | null;
  prog: TrackProgress | null;
  alarm: "none" | "soon" | "now";
  traveled: LL[] | null;
  traveling: boolean;
  note: string;
  candidates: { plate: string; hint: string }[];
  /** 本次 riding 是否由自动判定进入 */
  autoSwitched: boolean;
  /** 轻反馈文案（「已开始跟踪 51 路 · 车牌」/ 轻轨「已开始跟踪行程（线名）」） */
  autoNote: string;
  /** 进度来源（车辆 / GPS 驱动）——供来源标注与站条 */
  progressSource: "vehicle" | "gps";
  /** 安全网检出 */
  anomaly: "none" | "not_boarded" | "alighted";
  /** 上次数据帧时刻（ms）——新鲜度用 */
  lastUpdateTs: number;
  onStart: () => void;
  onStop: () => void;
  onBoard: () => void;
  onRepick: (plate: string) => void;
  onAlight: () => void;
  onRefresh: () => void;
  onNotBoard: () => void;
  onNotArrive: () => void;
  onNotThisBus: () => void;
  onDismissAnomaly: () => void;
}

export interface UseRideTrackingOpts {
  card: RecommendCard | null;
  legs: ColoredLeg[];
  anchors: OverviewLegInput[] | null;
  strips: SegmentStrip[] | null;
  active: boolean;
  /** ★ 新增：用户定位（GCJ-02；由 useUserFix 提供，只读） */
  userFix?: UserFix | null;
  /** ★ 新增：在用户手势内申请 GPS（useUserFix.start；开始导航 / 手动上车时调用） */
  onRequestGps?: () => void;
}

function hintOf(v: TrackVehicle): string {
  if (v.atStation?.code) return `${v.atStation.code} 停靠中`;
  if (v.interval?.from?.code) return `${v.interval.from.code} → ${v.interval.to?.code ?? "?"}`;
  return "";
}

export function useRideTracking(opts: UseRideTrackingOpts): RideTrackView {
  const { card, legs, anchors, strips, active, userFix = null, onRequestGps } = opts;

  const [phase, setPhase] = useState<RidePhase>("off");
  const [legIndex, setLegIndex] = useState(0);
  const [plate, setPlate] = useState<string | null>(null);
  const [prog, setProg] = useState<TrackProgress | null>(null);
  const [alarm, setAlarm] = useState<"none" | "soon" | "now">("none");
  const [traveled, setTraveled] = useState<LL[] | null>(null);
  const [traveling, setTraveling] = useState(false);
  const [note, setNote] = useState("");
  const [candidates, setCandidates] = useState<{ plate: string; hint: string }[]>([]);
  const [autoSwitched, setAutoSwitched] = useState(false);
  const [autoNote, setAutoNote] = useState("");
  const [progressSource, setProgressSource] = useState<"vehicle" | "gps">("vehicle");
  const [anomaly, setAnomaly] = useState<Anomaly>("none");
  const [lastUpdateTs, setLastUpdateTs] = useState(0);

  const vehicleRef = useRef<TrackVehicle | null>(null);
  const missRef = useRef(0);
  const alarmRef = useRef<"none" | "soon" | "now">("none");
  const lockRef = useRef<{ release: () => Promise<void> } | null>(null);
  /** 本帧原始车辆（R1 判定 + 换车用） */
  const listRef = useRef<TrackVehicle[]>([]);
  /** 最近 GPS 采样（R2 / 安全网用） */
  const fixesRef = useRef<FixLite[]>([]);
  /** 自动判定状态（冷却 / 单次） */
  const lastSwitchTsRef = useRef(0);
  const autoUsedRef = useRef(false);
  /** 轻轨 / GPS 推进状态 */
  const ladderRef = useRef<LrtLadder | null>(null);
  const lrtStateRef = useRef({ passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 });
  const stationMapRef = useRef<Map<string, { lng: number; lat: number }> | null>(null);
  /** 安全网确认累计 */
  const anomalyStreakRef = useRef(0);
  const lastAnomalyTsRef = useRef(0);
  /** 进入 riding 时的起点（判定「已推进 ≥1 站」） */
  const ridingStartIdxRef = useRef(-1);

  const stopMains = useMemo(() => {
    const s = strips?.[legIndex];
    return s ? s.stops.map((k) => mainOf(k.code)) : [];
  }, [strips, legIndex]);

  const boardAnchor = anchors?.[legIndex]?.board ?? null;
  const boardPos = useMemo(
    () => (boardAnchor ? { lng: boardAnchor.lng, lat: boardAnchor.lat } : null),
    [boardAnchor],
  );

  /** 更新 GPS 采样缓冲 */
  useEffect(() => {
    if (!userFix) return;
    const arr = fixesRef.current.filter((f) => userFix.ts - f.ts <= FIX_KEEP_MS);
    arr.push({ lng: userFix.lng, lat: userFix.lat, accuracy: userFix.accuracy, ts: userFix.ts });
    fixesRef.current = arr;
  }, [userFix]);

  const reset = useCallback(() => {
    setPhase("off");
    setLegIndex(0);
    setPlate(null);
    setProg(null);
    setAlarm("none");
    setTraveled(null);
    setNote("");
    setCandidates([]);
    setAutoSwitched(false);
    setAutoNote("");
    setProgressSource("vehicle");
    setAnomaly("none");
    setLastUpdateTs(0);
    vehicleRef.current = null;
    missRef.current = 0;
    alarmRef.current = "none";
    listRef.current = [];
    ladderRef.current = null;
    lrtStateRef.current = { passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 };
    autoUsedRef.current = false;
    lastSwitchTsRef.current = 0;
    anomalyStreakRef.current = 0;
    ridingStartIdxRef.current = -1;
  }, []);

  useEffect(() => {
    if (!active) reset();
  }, [active, reset]);
  useEffect(() => {
    reset();
  }, [card, reset]);

  /** 震动（不支持则静默） */
  const buzz = useCallback((pattern: number | number[]) => {
    try {
      if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
    } catch {
      /* ignore */
    }
  }, []);

  /* ── Wake Lock（手势内申请；切前台重申请；失败静默）── */
  const acquireWake = useCallback(async () => {
    try {
      const nav = navigator as Navigator & {
        wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> };
      };
      if (!nav.wakeLock) return;
      lockRef.current = await nav.wakeLock.request("screen");
    } catch {
      /* ignore */
    }
  }, []);
  const releaseWake = useCallback(() => {
    try {
      void lockRef.current?.release();
    } catch {
      /* ignore */
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

  /** 轻轨 / 巴士 GPS 驱动的站坐标映射（一次性拉取并缓存） */
  const ensureStationMap = useCallback(async (): Promise<Map<string, { lng: number; lat: number }>> => {
    if (stationMapRef.current) return stationMapRef.current;
    const m = new Map<string, { lng: number; lat: number }>();
    try {
      const r = await fetch("/api/stations?include=lrt&v=2", { cache: "force-cache" });
      const j = (await r.json()) as { stations?: { code: string; lng: number; lat: number }[] };
      for (const s of j.stations ?? []) m.set(mainOf(s.code), { lng: s.lng, lat: s.lat });
    } catch {
      /* 失败 → 空表（推进降级为不推进） */
    }
    stationMapRef.current = m;
    return m;
  }, []);

  /** 建立本段站点里程阶梯（GPS 驱动推进用） */
  const ensureLadder = useCallback(async () => {
    const leg = legs[legIndex];
    if (!leg || leg.colored.length < 2) return;
    const map = await ensureStationMap();
    const stops = (strips?.[legIndex]?.stops ?? []).map((s) => map.get(mainOf(s.code)) ?? null);
    ladderRef.current = buildLrtLadder(leg.colored, stops);
    lrtStateRef.current = { passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 };
  }, [legs, legIndex, strips, ensureStationMap]);

  /** 拉一帧车辆数据 */
  const fetchFrame = useCallback(
    async (lockPlate: string | null): Promise<void> => {
      const leg = legs[legIndex];
      const dir = leg?.dir;
      if (!leg || !dir || leg.kind !== "bus") {
        if (leg?.kind !== "lrt") setNote(NOTE_NO_PROGRESS);
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
        listRef.current = list;
        setLastUpdateTs(Date.now());

        const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
        if (!lockPlate) {
          const ranked = rankBoardingVehicles(list, boardMain, boardPos);
          setCandidates(ranked.slice(0, 6).map((v) => ({ plate: v.plate, hint: hintOf(v) })));
          if (phase === "boarding") setNote(ranked.length ? "" : NOTE_NO_VEHICLES);
          return;
        }

        const v = list.find((x) => x.plate === lockPlate) ?? null;
        if (!v) {
          missRef.current += 1;
          if (missRef.current >= MISS_LIMIT) setNote(NOTE_FROZEN_BUS);
          return;
        }
        missRef.current = 0;
        setNote("");
        vehicleRef.current = v;

        const p = progressOf(stopMains, v);
        if (p.kind === "at" || p.kind === "between") setProg(p);

        if (leg.colored.length >= 2 && !leg.degraded) {
          const cut = cutAt(leg.colored, { lng: v.lng, lat: v.lat });
          if (cut.dist <= CUT_TOLERANCE_M && cut.idx >= 1) {
            setTraveled([...leg.colored.slice(0, cut.idx + 1), [v.lng, v.lat] as LL]);
          }
        }
      } catch {
        setNote(NOTE_FETCH_FAIL);
      } finally {
        setTraveling(false);
      }
    },
    [legs, legIndex, strips, boardPos, stopMains, anchors, phase],
  );

  /* ── 自动上车判定 ── */
  const switchToRiding = useCallback(
    (nextPlate: string | null, source: "vehicle" | "gps", reason: AutoBoardResult["reason"]) => {
      const leg = legs[legIndex];
      const route = leg?.route.replace(/^LRT-/, "") ?? "";
      const lrt = leg?.kind === "lrt";
      setPhase("riding");
      setPlate(nextPlate);
      setProgressSource(source);
      setAutoSwitched(true);
      setNote(source === "gps" ? "" : "");
      setAutoNote(
        lrt
          ? `已开始跟踪行程（${route}）`
          : nextPlate
            ? `已开始跟踪 ${route} 路 · ${nextPlate}`
            : `已开始跟踪 ${route} 路`,
      );
      lastSwitchTsRef.current = Date.now();
      autoUsedRef.current = true;
      ridingStartIdxRef.current = -1;
      missRef.current = 0;
      alarmRef.current = "none";
      setAlarm("none");
      setAnomaly("none");
      anomalyStreakRef.current = 0;
      void reason;
      if (source === "gps" || lrt) {
        ladderRef.current = null;
        void ensureLadder();
      }
    },
    [legs, legIndex, ensureLadder],
  );

  const tryAuto = useCallback(() => {
    if (phase !== "boarding" || !active) return;
    const leg = legs[legIndex];
    if (!leg) return;
    const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
    const res = autoBoardOf({
      legKind: leg.kind,
      legDegraded: leg.degraded,
      colored: leg.colored,
      boardMain,
      boardPos,
      vehicles: listRef.current,
      fixes: fixesRef.current,
      lastSwitchTs: lastSwitchTsRef.current,
      nowMs: Date.now(),
      autoUsed: autoUsedRef.current,
    });
    if (res.hit) switchToRiding(res.plate, res.source, res.reason);
  }, [phase, active, legs, legIndex, strips, anchors, boardPos, switchToRiding]);

  /* 候车态：拉候选；并在车辆帧到位时尝试自动切换 */
  useEffect(() => {
    if (phase !== "boarding" || !active || !legs[legIndex]) return;
    void (async () => {
      await fetchFrame(null);
      tryAuto();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, active, legIndex]);

  /* GPS 帧到位（节流）也尝试自动切换 */
  useEffect(() => {
    if (phase !== "boarding") return;
    tryAuto();
  }, [userFix, phase, tryAuto]);

  /* 轮询（riding 且有车牌） */
  useEffect(() => {
    if (phase !== "riding" || !plate || !active) return;
    void fetchFrame(plate);
    const t = window.setInterval(() => void fetchFrame(plate), POLL_MS);
    return () => window.clearInterval(t);
  }, [phase, plate, active, fetchFrame]);

  /* GPS 驱动推进（无车牌 / 轻轨）：用 userFix 推站序进度 + 已驶过切割 */
  useEffect(() => {
    if (phase !== "riding" || !active || !userFix) return;
    const leg = legs[legIndex];
    if (!leg) return;
    const gpsDriven = progressSource === "gps" || !plate;
    if (gpsDriven) {
      if (!ladderRef.current) {
        void ensureLadder();
        return;
      }
      const res = advanceLrt({
        prevPassedIdx: lrtStateRef.current.passedIdx,
        prevComputed: lrtStateRef.current.computed,
        prevDist: lrtStateRef.current.dist,
        prevTs: lrtStateRef.current.ts,
        badStreak: lrtStateRef.current.badStreak,
        ladder: ladderRef.current,
        fix: { lng: userFix.lng, lat: userFix.lat, accuracy: userFix.accuracy, ts: userFix.ts },
      });
      lrtStateRef.current = {
        passedIdx: res.passedIdx,
        computed: res.computed,
        dist: res.distNow,
        ts: res.ts,
        badStreak: res.badStreak,
      };
      if (res.progress.kind !== "lost") setProg(res.progress);
      if (res.frozen && res.badStreak >= 2) setNote(NOTE_LRT_WEAK);
      else if (!res.frozen && note === NOTE_LRT_WEAK) setNote("");
      // 已驶过切割（GPS 投影）——仅 GPS 驱动时更新，避免与车辆切割抖动
      if (leg.colored.length >= 2 && !leg.degraded) {
        const cut = cutAt(leg.colored, { lng: userFix.lng, lat: userFix.lat });
        if (cut.dist <= CUT_TOLERANCE_M && cut.idx >= 1) {
          setTraveled([...leg.colored.slice(0, cut.idx + 1), [userFix.lng, userFix.lat] as LL]);
        }
      }
    }
    setLastUpdateTs(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userFix, phase, active, progressSource, plate, legs, legIndex]);

  /* 下车提醒（下一站 = 下车站 ⇒ soon；到站 ⇒ now；级别跃升时震一次） */
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
      buzz(next === "now" ? [220, 80, 220] : [180, 80, 180]);
    }
    alarmRef.current = next;
  }, [phase, prog, stopMains, buzz]);

  /* 安全网：异常检出（连续 2 次 + 间隔 ≥45s 才显示） */
  useEffect(() => {
    if (phase !== "riding" || !legs[legIndex]) {
      setAnomaly("none");
      anomalyStreakRef.current = 0;
      return;
    }
    const leg = legs[legIndex];
    const latest = fixesRef.current[fixesRef.current.length - 1] ?? null;
    const projDistM =
      latest && leg.colored.length >= 2 ? cutAt(leg.colored, latest).dist : null;
    const advanced =
      progressSource === "gps"
        ? lrtStateRef.current.dist > 0
        : (prog?.passedIdx ?? -1) > 0;
    const a = anomalyOf({
      autoSwitched,
      progressSource,
      fixes: fixesRef.current,
      projDistM,
      advanced,
    });
    const now = Date.now();
    if (a === "none") {
      anomalyStreakRef.current = 0;
      if (anomaly !== "none") setAnomaly("none");
      return;
    }
    if (now - lastAnomalyTsRef.current >= ANOMALY_MIN_GAP_MS) {
      anomalyStreakRef.current += 1;
      lastAnomalyTsRef.current = now;
    }
    if (anomalyStreakRef.current >= ANOMALY_CONFIRM) setAnomaly(a);
  }, [phase, prog, userFix, anomaly, autoSwitched, progressSource, legs, legIndex]);

  /* ── 操作 ── */
  const start = useCallback(() => {
    setPhase("boarding");
    setLegIndex((i) => (card && i < card.rides.length ? i : 0));
    setNote("");
    setAutoSwitched(false);
    setAutoNote("");
    setAnomaly("none");
    // 冷却与自动状态在 leg 变化时复位（此处保持）
    autoUsedRef.current = false;
    lastSwitchTsRef.current = 0;
    onRequestGps?.(); // ★ 必须在用户手势内申请 GPS（开始导航）
    void acquireWake();
  }, [card, acquireWake, onRequestGps]);

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

  /** 手动上车（弱样式兜底）：锁定候选第 1 / 无候选 → 换车；轻轨 → GPS 驱动 */
  const board = useCallback(() => {
    void (async () => {
      const leg = legs[legIndex];
      if (!leg) return;
      if (leg.kind !== "bus" || !leg.dir) {
        switchToRiding(null, "gps", "r2");
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
        listRef.current = list;
        const boardMain = stopsBoard(strips, legIndex) || mainOf(anchors?.[legIndex]?.board?.code ?? "");
        const ranked = rankBoardingVehicles(list, boardMain, boardPos);
        setCandidates(ranked.slice(0, 6).map((v) => ({ plate: v.plate, hint: hintOf(v) })));
        if (!ranked.length) {
          setNote(NOTE_NO_VEHICLES_BOARD);
          return;
        }
        setAutoSwitched(false);
        setAutoNote("");
        setPhase("riding");
        setPlate(ranked[0].plate);
        setProgressSource("vehicle");
        ridingStartIdxRef.current = -1;
      } catch {
        setNote("车辆数据获取失败，请稍后重试");
      } finally {
        setTraveling(false);
      }
    })();
  }, [legs, legIndex, strips, boardPos, anchors, switchToRiding]);

  const repick = useCallback((p: string) => {
    setPlate(p);
    setProgressSource("vehicle");
    missRef.current = 0;
    setNote("");
    setProg(null);
    setTraveled(null);
    lastSwitchTsRef.current = Date.now();
  }, []);

  const alight = useCallback(() => {
    const total = card?.rides.length ?? 1;
    setProg(null);
    setTraveled(null);
    setAlarm("none");
    alarmRef.current = "none";
    setPlate(null);
    setAnomaly("none");
    setAutoSwitched(false);
    setAutoNote("");
    anomalyStreakRef.current = 0;
    vehicleRef.current = null;
    missRef.current = 0;
    ladderRef.current = null;
    lrtStateRef.current = { passedIdx: -1, computed: -1, dist: 0, ts: 0, badStreak: 0 };
    buzz([120, 60, 120]);
    if (legIndex + 1 < total) {
      setLegIndex((i) => i + 1);
      setPhase("boarding");
      autoUsedRef.current = false;
      lastSwitchTsRef.current = 0;
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

  /** 安全网纠错：「我没上车」→ 回等车（保留方案） */
  const onNotBoard = useCallback(() => {
    setPhase("boarding");
    setPlate(null);
    setProg(null);
    setTraveled(null);
    setAlarm("none");
    setAnomaly("none");
    setAutoSwitched(false);
    setAutoNote("");
    alarmRef.current = "none";
    anomalyStreakRef.current = 0;
    ladderRef.current = null;
    lastSwitchTsRef.current = Date.now();
    autoUsedRef.current = true; // 冷却后再允许自动
  }, []);

  /** 「还没到」→ 清除到站提醒，回乘车中 */
  const onNotArrive = useCallback(() => {
    setAlarm("none");
    alarmRef.current = "none";
    anomalyStreakRef.current = 0;
    setAnomaly("none");
  }, []);

  /** 「不是这辆」→ 换候选第 1（无候选 → 回等车） */
  const onNotThisBus = useCallback(() => {
    const cand = candidates.find((c) => c.plate !== plate) ?? null;
    if (cand) repick(cand.plate);
    else onNotBoard();
  }, [candidates, plate, repick, onNotBoard]);

  const onDismissAnomaly = useCallback(() => {
    setAnomaly("none");
    anomalyStreakRef.current = 0;
  }, []);

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
    autoSwitched,
    autoNote,
    progressSource,
    anomaly,
    lastUpdateTs,
    onStart: start,
    onStop: stop,
    onBoard: board,
    onRepick: repick,
    onAlight: alight,
    onRefresh,
    onNotBoard,
    onNotArrive,
    onNotThisBus,
    onDismissAnomaly,
  };
}

/** 兜底：从 strips 里取本段上车站主码 */
function stopsBoard(strips: SegmentStrip[] | null, legIndex: number): string {
  const s = strips?.[legIndex];
  return s?.stops?.[0]?.code ? mainOf(s.stops[0].code) : "";
}
