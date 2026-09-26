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
  fracBetween,
  mainOf,
  progressOf,
  rankBoardingVehicles,
  type TrackProgress,
  type TrackVehicle,
} from "@/lib/nav/track";
import { advanceLrt, buildLrtLadder, type LrtLadder } from "@/lib/nav/lrt-progress";
import { cumDistM, nearestOnPath } from "@/lib/nav/route-overview";
import { autoAlightOf } from "@/lib/nav/alight-detect";
import {
  ANOMALY_CONFIRM,
  ANOMALY_MIN_GAP_MS,
  autoBoardOf,
  anomalyOf,
  R2_STREAK,
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
/** ★ 本批：蓝点吸附到线路投影的最大距离（米）——对不上就冻结（Token `--you-snap-max`） */
const YOU_SNAP_MAX_M = 60;
/** ★ 本批：蓝点精度门（米）——超过视为不可信 ⇒ 冻结 */
const YOU_ACC_MAX_M = 150;
/** ★ 本批：自动下车瞬态反馈停留时长（ms） */
const JUST_ALIGHTED_MS = 5_000;

/* ── 文案（去 AI 化；06 §4 最终文案表）── */
const NOTE_NO_PROGRESS = "这段暂时看不到实时进度，请对照站名，快到了自己下车";
const NOTE_FROZEN_BUS = "暂时收不到这辆车的信号 · 位置停在上一站，恢复后会自动跟上";
const NOTE_NO_VEHICLES = "这条线现在查不到车 · 稍后再试，或直接点「我已上车」";
const NOTE_NO_VEHICLES_BOARD = "这条线现在查不到车 · 稍后再试，或直接点「我已上车」自己开始";
const NOTE_LRT_WEAK = "暂时收不到信号 · 位置停在上一站";
const NOTE_FETCH_FAIL = "车辆数据获取失败，稍后自动重试";

export type RidePhase = "off" | "boarding" | "riding" | "done";

/** ★ 本批（需求⑤）：地图蓝点（视觉层 = GPS 投影；`frozen` = 冻结不跳） */
export interface RideYouDot {
  lng: number;
  lat: number;
  src: "gps";
  /** 冻结（投影失败 / 精度差 / 无信号）——保留上次好点，不跳 */
  frozen: boolean;
  ts: number;
  /** 水平精度（米；投影点沿用最近一帧 GPS，供 `UserDotLayer` 复用 `UserFix` 形状） */
  accuracy: number;
}
/** ★ 本批（需求⑤）：纵条用户点（段内插值：`frac=0` 贴 `afterIdx` 站，`∈(0,1)` 位于区间内） */
export interface RideYouAt {
  afterIdx: number;
  frac: number;
}

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
  /** ★ 本批：地图蓝点（riding 用投影点；非 riding = null ⇒ 宿主回落原始 GPS） */
  youDot: RideYouDot | null;
  /** ★ 本批：纵条段内插值用户点 */
  youAt: RideYouAt | null;
  /** ★ 本批：当前在显车辆（riding 按 plate 过滤 → 0/1 辆；AC-45/46） */
  mapVehicles: VehicleLite[];
  /** ★ 本批：自动下车瞬态（`data-track-state='alighted'` 窗口） */
  justAlighted: boolean;
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
  /** ★ 本批：撤销自动下车（仅最后一次自动下车可撤销；AC-56） */
  onUndoAlight: () => void;
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
  /** ★ 本批：车辆帧序号（`mapVehicles` 随 12s 帧重算，AC-46） */
  const [listTick, setListTick] = useState(0);
  /** ★ 本批：站点里程阶梯版本（ladder 就绪后触发 `youAt` 重算） */
  const [ladderTick, setLadderTick] = useState(0);
  /** ★ 本批：自动下车瞬态（≤5s；`data-track-state='alighted'`） */
  const [justAlighted, setJustAlighted] = useState(false);
  /** ★ 本批：蓝点 / 纵条用户点 */
  const [youDot, setYouDot] = useState<RideYouDot | null>(null);
  const [youAt, setYouAt] = useState<RideYouAt | null>(null);

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
  /** ★ 本批：最近一次「好蓝点」（投影失败 / 无信号 ⇒ 冻结不跳） */
  const lastGoodDotRef = useRef<RideYouDot | null>(null);
  /** ★ 本批：自动下车连续命中帧数 */
  const alightStreakRef = useRef(0);
  /** ★ 本批：自动上车连续命中帧数（多帧确认 R2_STREAK） */
  const boardStreakRef = useRef(0);
  /** ★ 本批：自动下车瞬态计时器 */
  const justAlightedTimerRef = useRef<number | null>(null);
  /** ★ 本批：自动下车撤销快照（仅最后一次自动下车可撤销） */
  const undoRef = useRef<{
    legIndex: number;
    phase: RidePhase;
    plate: string | null;
    prog: TrackProgress | null;
    traveled: LL[] | null;
    candidates: { plate: string; hint: string }[];
    progressSource: "vehicle" | "gps";
    ladder: LrtLadder | null;
    lrtState: { passedIdx: number; computed: number; dist: number; ts: number; badStreak: number };
  } | null>(null);
  /** ★ 本批：车辆帧顶层运营商（供 mapVehicles 涂装色） */
  const lastCompanyRef = useRef<string | null>(null);

  const stopMains = useMemo(() => {
    const s = strips?.[legIndex];
    return s ? s.stops.map((k) => mainOf(k.code)) : [];
  }, [strips, legIndex]);

  const boardAnchor = anchors?.[legIndex]?.board ?? null;
  const boardPos = useMemo(
    () => (boardAnchor ? { lng: boardAnchor.lng, lat: boardAnchor.lat } : null),
    [boardAnchor],
  );

  /**
   * ★ 本批（需求⑥ / AC-45/46）：**在显车辆** —— riding 时按 `plate` 过滤 ⇒ 0/1 辆；
   *   随 12s 帧（`listTick`）重算 ⇒ `VehicleLayer` 重定位（不再只拉一次）。
   *   非 riding（boarding/off/done）⇒ `[]`。
   */
  const mapVehicles = useMemo<VehicleLite[]>(() => {
    if (phase !== "riding" || !plate) return [];
    const v = listRef.current.find((x) => x.plate === plate);
    if (!v) return [];
    return [
      {
        plate: v.plate,
        lat: v.lat,
        lng: v.lng,
        status: (v.status as VehicleLite["status"]) ?? "unknown",
        interval: v.interval
          ? { from: { code: v.interval.from.code, name: "" }, to: { code: v.interval.to?.code ?? "", name: "" } }
          : null,
        atStation: v.atStation ? { code: v.atStation.code, name: "" } : null,
        company: lastCompanyRef.current ?? undefined,
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, plate, listTick]);

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
    // ★ 本批
    lastGoodDotRef.current = null;
    alightStreakRef.current = 0;
    boardStreakRef.current = 0;
    undoRef.current = null;
    if (justAlightedTimerRef.current) {
      window.clearTimeout(justAlightedTimerRef.current);
      justAlightedTimerRef.current = null;
    }
    setJustAlighted(false);
    setYouDot(null);
    setYouAt(null);
    setListTick(0);
    setLadderTick(0);
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
    setLadderTick((t) => t + 1); // 阶梯就绪 → 触发 youAt 重算
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
        const j = (await r.json()) as { vehicles?: VehicleLite[]; company?: string | null };
        const list: TrackVehicle[] = (j.vehicles ?? []).map((v) => ({
          plate: v.plate,
          lat: v.lat,
          lng: v.lng,
          status: String(v.status ?? "unknown"),
          interval: v.interval ?? null,
          atStation: v.atStation ?? null,
        }));
        listRef.current = list;
        lastCompanyRef.current = j.company ?? null; // ★ 本批：帧顶层运营商（mapVehicles 涂装色）
        setLastUpdateTs(Date.now());
        setListTick((t) => t + 1); // ★ 本批：触发 mapVehicles 重算（AC-46）

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

        // ★ 本批（07 §c.4 裁定）：**视觉层（已驶过灰线 + 蓝点）一律用 GPS 切割**
        //   —— 车辆帧**不再**更新 `traveled`（逻辑层进度仍以车辆为权威）。
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
      boardStreakRef.current = 0; // ★ 本批：切换后清零多帧确认计数
      alightStreakRef.current = 0;
      void reason;
      // ★ 本批：**任何来源**都建一次站点里程阶梯（供纵条 youAt / 自动下车判定）
      ladderRef.current = null;
      void ensureLadder();
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
      streak: boardStreakRef.current,
    });
    // ★ 本批（AC-56）：R1 strong 立即切换；R2 / R1weak+R2 需连续 ≥R2_STREAK 帧确认
    boardStreakRef.current = res.streak;
    if (!res.hit) return;
    if (res.reason === "r1" || res.streak >= R2_STREAK) {
      switchToRiding(res.plate, res.source, res.reason);
    }
  }, [phase, active, legs, legIndex, strips, anchors, boardPos, switchToRiding]);

  /* 候车态：拉候选（★ 本批：**12s 持续轮询**，非只拉一帧 —— 上车灵敏度，AC-56）；
     并在车辆帧到位时尝试自动切换。purpose 复用 `live_pos`（服务端只记账、不参与熔断）。 */
  useEffect(() => {
    if (phase !== "boarding" || !active || !legs[legIndex]) return;
    void (async () => {
      await fetchFrame(null);
      tryAuto();
    })();
    const t = window.setInterval(() => {
      void (async () => {
        await fetchFrame(null);
        tryAuto();
      })();
    }, POLL_MS);
    return () => window.clearInterval(t);
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

  /* GPS 驱动推进（无车牌 / 轻轨）：用 userFix 推站序进度；★ 视觉层（已驶过灰线）**一律 GPS 切割** */
  useEffect(() => {
    if (phase !== "riding" || !active || !userFix) return;
    const leg = legs[legIndex];
    if (!leg) return;
    const gpsDriven = progressSource === "gps" || !plate;
    if (gpsDriven) {
      if (ladderRef.current) {
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
      } else {
        void ensureLadder();
      }
    }
    // ★ 本批（07 §c.4 裁定）：视觉层（灰线）**与蓝点同源 = GPS 切割**（不再用车辆切割）。
    if (leg.colored.length >= 2 && !leg.degraded) {
      const cut = cutAt(leg.colored, { lng: userFix.lng, lat: userFix.lat });
      if (cut.dist <= CUT_TOLERANCE_M && cut.idx >= 1) {
        setTraveled([...leg.colored.slice(0, cut.idx + 1), [userFix.lng, userFix.lat] as LL]);
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

  /**
   * ★ 本批（需求⑤ / AC-40~44）：**蓝点 + 纵条用户点**（视觉层 = GPS 投影；逻辑层不动）。
   *   · 蓝点：`nearestOnPath` 吸附（≤60m）；投影失败 / accuracy>150 / 无信号 ⇒ **冻结不跳**；
   *   · 纵条：`youAt`（段内插值 `frac`）—— 停靠中贴在节点、行驶中骑线插值。
   *   ⚠️ 两者**只作视觉**，不参与 `passedIdx/atIdx/nextIdx` 判定（避免两套口径打架）。
   */
  useEffect(() => {
    if (phase !== "riding" || !active) {
      lastGoodDotRef.current = null;
      setYouDot(null);
      setYouAt(null);
      return;
    }
    const leg = legs[legIndex];
    if (!leg || leg.colored.length < 2 || leg.degraded) {
      setYouDot(null);
      setYouAt(null);
      return;
    }

    // ── 蓝点（GPS 投影 + 冻结）──
    let dot: RideYouDot | null = null;
    if (userFix) {
      const accOk = !(Number.isFinite(userFix.accuracy) && userFix.accuracy > YOU_ACC_MAX_M);
      if (accOk) {
        const proj = nearestOnPath(leg.colored, { lng: userFix.lng, lat: userFix.lat });
        if (proj.distM <= YOU_SNAP_MAX_M) {
          const p = leg.colored[proj.idx];
          dot = { lng: p[0], lat: p[1], src: "gps", frozen: false, ts: userFix.ts, accuracy: userFix.accuracy };
          lastGoodDotRef.current = dot;
        }
      }
    }
    if (!dot && lastGoodDotRef.current) dot = { ...lastGoodDotRef.current, frozen: true };
    setYouDot(dot);

    // ── 纵条 youAt（段内插值）──
    const lastIdx = stopMains.length - 1;
    if (!prog || lastIdx < 1) {
      setYouAt(null);
      return;
    }
    if (prog.atIdx !== null) {
      setYouAt({ afterIdx: prog.atIdx, frac: 0 }); // 停靠中：点贴节点
      return;
    }
    const i0 = prog.passedIdx;
    if (i0 < 0) {
      setYouAt({ afterIdx: -1, frac: 0 }); // 尚未到上车站
      return;
    }
    const cum = ladderRef.current && ladderRef.current.ladder.length ? ladderRef.current.ladder : null;
    let dNow: number | null = null;
    if (progressSource === "gps") {
      dNow = lrtStateRef.current.dist > 0 ? lrtStateRef.current.dist : null;
    } else {
      const v = vehicleRef.current;
      if (v) {
        const c = cumDistM(leg.colored);
        dNow = c[nearestOnPath(leg.colored, { lng: v.lng, lat: v.lat }).idx];
      }
    }
    const frac = cum && dNow != null ? fracBetween(cum, i0, i0 + 1, dNow) : 0;
    setYouAt({ afterIdx: i0, frac });
  }, [phase, active, userFix, legs, legIndex, prog, progressSource, stopMains, listTick, ladderTick]);

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
        setListTick((t) => t + 1);
        ladderRef.current = null;
        void ensureLadder(); // ★ 本批：手动上车也建阶梯（youAt / 自动下车）
      } catch {
        setNote("车辆数据获取失败，请稍后重试");
      } finally {
        setTraveling(false);
      }
    })();
  }, [legs, legIndex, strips, boardPos, anchors, switchToRiding, ensureLadder]);

  const repick = useCallback((p: string) => {
    setPlate(p);
    setProgressSource("vehicle");
    missRef.current = 0;
    setNote("");
    setProg(null);
    setTraveled(null);
    boardStreakRef.current = 0;
    lastSwitchTsRef.current = Date.now();
  }, []);

  /**
   * 下车推进（手动 / 自动共用）。
   * @param auto 自动判定触发 —— `true` 时保存撤销快照 + 置瞬态 `justAlighted`（≤5s）
   */
  const doAlight = useCallback(
    (auto: boolean) => {
      const total = card?.rides.length ?? 1;
      if (auto) {
        // ★ 撤销快照（在推进**前**保存）
        undoRef.current = {
          legIndex,
          phase,
          plate,
          prog,
          traveled,
          candidates,
          progressSource,
          ladder: ladderRef.current,
          lrtState: { ...lrtStateRef.current },
        };
        setJustAlighted(true);
        if (justAlightedTimerRef.current) window.clearTimeout(justAlightedTimerRef.current);
        justAlightedTimerRef.current = window.setTimeout(() => {
          setJustAlighted(false);
          justAlightedTimerRef.current = null;
        }, JUST_ALIGHTED_MS);
      }
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
      alightStreakRef.current = 0;
      boardStreakRef.current = 0;
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
    },
    [card, legIndex, phase, plate, prog, traveled, candidates, progressSource, buzz, releaseWake],
  );

  /** 手动「我已下车」 */
  const alight = useCallback(() => doAlight(false), [doAlight]);

  /** ★ 本批：撤销自动下车（仅最后一次自动下车可撤销；撤销后清空快照） */
  const onUndoAlight = useCallback(() => {
    const u = undoRef.current;
    if (!u) return;
    undoRef.current = null;
    if (justAlightedTimerRef.current) {
      window.clearTimeout(justAlightedTimerRef.current);
      justAlightedTimerRef.current = null;
    }
    setJustAlighted(false);
    setLegIndex(u.legIndex);
    setPhase(u.phase);
    setPlate(u.plate);
    setProg(u.prog);
    setTraveled(u.traveled);
    setCandidates(u.candidates);
    setProgressSource(u.progressSource);
    setAlarm("none");
    alarmRef.current = "none";
    setAnomaly("none");
    anomalyStreakRef.current = 0;
    alightStreakRef.current = 0;
    boardStreakRef.current = 0;
    ladderRef.current = u.ladder;
    lrtStateRef.current = { ...u.lrtState };
    autoUsedRef.current = true; // 撤销后不再自动（防抖）
  }, []);

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

  /**
   * ★ 本批（需求⑨ / AC-55）：**全自动下车** effect。
   *   · 车辆源：车停靠本段下车站（多帧确认）；GPS 源：沿线里程越过下车站 ≥30m；
   *   · 环线（首尾同站）恒不判；冻结（丢信号 / 车辆丢失 3 帧 / 轻轨 badStreak≥2）不判；
   *   · 命中 ⇒ `doAlight(true)`（保存撤销快照 + 瞬态反馈）。
   */
  useEffect(() => {
    if (phase !== "riding" || !active) return;
    const leg = legs[legIndex];
    if (!leg) return;
    const stopMainsLocal = strips?.[legIndex]?.stops.map((s) => mainOf(s.code)) ?? [];
    const lastIdx = stopMainsLocal.length - 1;
    const loop = stopMainsLocal.length > 1 && stopMainsLocal[0] === stopMainsLocal[lastIdx];
    const frozen =
      progressSource === "vehicle" ? missRef.current >= MISS_LIMIT : lrtStateRef.current.badStreak >= 2;
    const dNow = progressSource === "gps" ? (lrtStateRef.current.dist > 0 ? lrtStateRef.current.dist : null) : null;
    const dAlightRaw = ladderRef.current ? ladderRef.current.ladder[lastIdx] : undefined;
    const dAlight = typeof dAlightRaw === "number" && Number.isFinite(dAlightRaw) ? dAlightRaw : null;
    const r = autoAlightOf({
      source: progressSource,
      lastIdx,
      atIdx: prog?.atIdx ?? null,
      passedIdx: prog?.passedIdx ?? -1,
      dNow,
      dAlight,
      loop,
      frozen,
      streak: alightStreakRef.current,
    });
    alightStreakRef.current = r.streak;
    if (r.hit) doAlight(true);
  }, [phase, active, prog, userFix, legIndex, progressSource, strips, legs, doAlight]);

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
    youDot,
    youAt,
    mapVehicles,
    justAlighted,
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
    onUndoAlight,
  };
}

/** 兜底：从 strips 里取本段上车站主码 */
function stopsBoard(strips: SegmentStrip[] | null, legIndex: number): string {
  const s = strips?.[legIndex];
  return s?.stops?.[0]?.code ? mainOf(s.stops[0].code) : "";
}
