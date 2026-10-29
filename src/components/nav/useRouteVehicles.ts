"use client";

/**
 * 路线查看模式 · 车辆数据流（src/components/nav/useRouteVehicles.ts，v2.10.0）
 *
 * 把「选线路 → 自动刷新 → 冷却 → 换向 → 手动刷新 → 选车出卡」的逻辑收在一个 hook 里，
 * 让 `NavShell` 保持精简（单文件 ≤300 行）。
 *
 * ── 关键口径 ──────────────────────────────────────────────────────────
 *   · 仅**巴士**线路有车辆（轻轨无实时数据 ⇒ 直接空数组，不报错）；
 *   · 方向 `dir` = 线路 `shapes` 的 `dsat_dir`（由 `NavMap` 读 `/api/route-shapes` 后
 *     通过 `onRouteDirs` 回报）；单向线路 `dirs.length === 1` ⇒ 无换向按钮；
 *   · **自动刷新（进入线路 / 换向）与手动刷新共用同一冷却计时**：任一刷新都会**重置**
 *     同一个 10 秒窗口；手动刷新在冷却中禁用，自动刷新始终放行（否则换向会看不到车）。
 *   · 信号丢失：车牌命中响应 `badCar` ⇒ `status = "lost"`（与后端 `status` 值正交合并）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { REFRESH_COOLDOWN_SEC } from "./RefreshButton";
import { errorTextOf } from "@/lib/ui/error-text";
import type { VehicleLite } from "./VehicleMarker";
import type { RouteLineItem } from "./RouteLinesSheet";

/** 当前正在查看的线路（`dir` 由站姿 shape 回报后补齐） */
export type PickedLine = RouteLineItem & { dir?: string };

interface RawVehicle {
  plate: string;
  lat: number;
  lng: number;
  status?: string;
  isLast?: boolean;
  interval?: VehicleLite["interval"];
  atStation?: VehicleLite["atStation"];
}

interface VehiclesResponse {
  error?: string;
  company?: string;
  fetchedAt?: string;
  badCar?: string[];
  vehicles?: RawVehicle[];
}

const VALID_STATES = new Set(["moving", "stopping", "terminal", "unknown"]);

export interface UseRouteVehicles {
  /** 当前查看的线路（null = 不在路线查看模式） */
  picked: PickedLine | null;
  /** 可选方向（来自 shapes；`[]` = 尚未加载） */
  dirs: string[];
  /** 是否为双向线路（决定是否显示换向按钮） */
  canReverse: boolean;
  vehicles: VehicleLite[];
  fetchedAt: string | null;
  /** 剩余冷却秒数（0 = 可刷新） */
  cooldownSec: number;
  fetching: boolean;
  error: string;
  /** 选中的车辆（点击图标后出卡）+ 合并组内车辆数 */
  selected: { vehicle: VehicleLite; count: number } | null;
  pickLine: (line: RouteLineItem) => void;
  exitLine: () => void;
  reverse: () => void;
  refresh: () => void;
  /** 由 `NavMap` 回调：回报该线路可用方向 */
  reportDirs: (dirs: string[]) => void;
  selectVehicle: (vehicle: VehicleLite, count: number) => void;
  closeVehicle: () => void;
}

export function useRouteVehicles(): UseRouteVehicles {
  const [picked, setPicked] = useState<PickedLine | null>(null);
  const [dirs, setDirs] = useState<string[]>([]);
  const [vehicles, setVehicles] = useState<VehicleLite[]>([]);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [cooldownSec, setCooldownSec] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<{ vehicle: VehicleLite; count: number } | null>(null);

  const cdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 请求序号：忽略过期响应（快速换向时旧响应可能后到） */
  const seqRef = useRef(0);
  /** `picked` 的实时镜像：供事件回调读取最新值，避免在 setState 更新函数里塞副作用 */
  const pickedRef = useRef<PickedLine | null>(null);
  pickedRef.current = picked;

  const stopCd = useCallback(() => {
    if (cdTimer.current) {
      clearInterval(cdTimer.current);
      cdTimer.current = null;
    }
  }, []);

  /** 重置并启动 10 秒冷却窗口（手动 / 自动刷新共用） */
  const startCooldown = useCallback(() => {
    stopCd();
    setCooldownSec(REFRESH_COOLDOWN_SEC);
    cdTimer.current = setInterval(() => {
      setCooldownSec((s) => {
        if (s <= 1) {
          stopCd();
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, [stopCd]);

  useEffect(() => stopCd, [stopCd]);

  /** 拉取某线路某方向的在途车辆 */
  const fetchVehicles = useCallback(async (code: string, dir: string, kind: string) => {
    const seq = ++seqRef.current;
    if (kind !== "bus") {
      // 轻轨无实时车辆数据 ⇒ 清空、不请求、不报错（Spec AC-02）
      setVehicles([]);
      setFetchedAt(null);
      setError("");
      return;
    }
    setFetching(true);
    try {
      const r = await fetch(
        `/api/route-vehicles?code=${encodeURIComponent(code)}&dir=${encodeURIComponent(dir)}&kind=bus`,
        { cache: "no-store" },
      );
      const j = (await r.json()) as VehiclesResponse;
      if (seq !== seqRef.current) return; // 过期响应，丢弃
      if (j.error) {
        // ★ v3.6.0：`j.error` 是服务端枚举 ⇒ 存用户文案（当前只当布尔用，但不留英文枚举在这个字段里）
        setError(errorTextOf(j.error));
        setVehicles([]);
        setFetchedAt(null);
        return;
      }
      const bad = new Set(j.badCar ?? []);
      const list: VehicleLite[] = (j.vehicles ?? []).map((v) => {
        const raw = String(v.status ?? "");
        const status: VehicleLite["status"] = bad.has(v.plate)
          ? "lost"
          : ((VALID_STATES.has(raw) ? raw : "unknown") as VehicleLite["status"]);
        return {
          plate: v.plate,
          lat: v.lat,
          lng: v.lng,
          status,
          isLast: !!v.isLast,
          interval: v.interval ?? null,
          atStation: v.atStation ?? null,
          company: j.company,
        };
      });
      setVehicles(list);
      setFetchedAt(j.fetchedAt ?? new Date().toISOString());
      setError("");
    } catch {
      if (seq !== seqRef.current) return;
      setError("车辆位置获取失败");
      setVehicles([]);
      setFetchedAt(null);
    } finally {
      if (seq === seqRef.current) setFetching(false);
    }
  }, []);

  /** 进入线路 */
  const pickLine = useCallback((line: RouteLineItem) => {
    setPicked({ ...line, dir: undefined });
    setDirs([]);
    setVehicles([]);
    setFetchedAt(null);
    setSelected(null);
    setError("");
    stopCd();
    setCooldownSec(0);
  }, [stopCd]);

  const exitLine = useCallback(() => {
    setPicked(null);
    setDirs([]);
    setVehicles([]);
    setFetchedAt(null);
    setSelected(null);
    setError("");
    stopCd();
    setCooldownSec(0);
  }, [stopCd]);

  /** `NavMap` 回报方向：首次补齐 `dir` 并自动刷新（副作用在 updater **之外**，避免 StrictMode 双执行） */
  const reportDirs = useCallback(
    (next: string[]) => {
      setDirs(next);
      const cur = pickedRef.current;
      if (!cur || cur.dir || !next.length) return;
      const dir = next[0];
      setPicked({ ...cur, dir });
      void fetchVehicles(cur.code, dir, cur.kind);
      startCooldown();
    },
    [fetchVehicles, startCooldown],
  );

  /** 换向：切到另一方向 + 重算视野（视野由 NavMap 依 dir 自动处理）+ 自动刷新 */
  const reverse = useCallback(() => {
    const cur = pickedRef.current;
    if (!cur || dirs.length < 2) return;
    const other = dirs.find((d) => d !== cur.dir) ?? dirs[0];
    void fetchVehicles(cur.code, other, cur.kind);
    startCooldown();
    setSelected(null);
    setPicked({ ...cur, dir: other });
  }, [dirs, fetchVehicles, startCooldown]);

  /** 手动刷新（冷却中由 UI 拦截；此处再兜底一次） */
  const refresh = useCallback(() => {
    if (!picked || picked.kind !== "bus") return;
    if (cooldownSec > 0) return;
    const dir = picked.dir ?? dirs[0];
    if (!dir) return;
    void fetchVehicles(picked.code, dir, picked.kind);
    startCooldown();
  }, [picked, dirs, cooldownSec, fetchVehicles, startCooldown]);

  const selectVehicle = useCallback((vehicle: VehicleLite, count: number) => {
    setSelected({ vehicle, count });
  }, []);
  const closeVehicle = useCallback(() => setSelected(null), []);

  return {
    picked,
    dirs,
    canReverse: dirs.length > 1,
    vehicles,
    fetchedAt,
    cooldownSec,
    fetching,
    error,
    selected,
    pickLine,
    exitLine,
    reverse,
    refresh,
    reportDirs,
    selectVehicle,
    closeVehicle,
  };
}
