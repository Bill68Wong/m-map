"use client";

/**
 * 路线总览数据流 hook（src/components/nav/useRouteOverview.ts，2026-09-23 新增）
 *
 * ── 职责（技术方案 §3.4）────────────────────────────────────────────────
 *   进入 detail pane 时并行取数并组装几何，供 `NavMap` 的 `overview` prop 绘制：
 *     (a) `POST /api/nav/detail-body`（含 `legs` 几何锚点）；
 *     (b) 各 distinct route 的 `GET /api/route-shapes`（polyline，GCJ-02）；
 *     (c) 各 **巴士** 乘车段的 `GET /api/route-vehicles`（按所选方向 `dir`）。
 *   完成后：`buildColoredLegs(legs, shapesByRoute)` → `ColoredLeg[]` + 取景外包框 `box`。
 *
 * ── 降级铁律（永不阻塞地图）────────────────────────────────────────────
 *   · 单段 shapes 缺失 / 超容差 / 切割失败 ⇒ 该段 `degraded`（整线着色），其余照常；
 *   · 车辆请求失败 ⇒ 该段无车（不报错、不影响总览）；
 *   · detail-body 整体失败 ⇒ `legs=[]`（地图退回 OD 取景），详情 pane 自行显示失败 + 重试。
 *
 * ⚠️ 轻轨段无实时车辆（`route-vehicles` 对 `LRT-*` 返回空）⇒ 仅对 `kind==='bus'` 拉车。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildColoredLegs,
  unionBox,
  type ColoredLeg,
  type RouteShapeLite,
} from "@/lib/nav/route-overview";
import type { RecommendCard } from "@/lib/recommend/types";
import { useDetailBody, type DetailBody } from "./useDetailBody";
import type { VehicleLite } from "./VehicleMarker";

export interface OverviewBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

const VALID_STATES = new Set(["moving", "stopping", "terminal", "unknown"]);

export interface UseRouteOverview {
  phase: "idle" | "loading" | "ready" | "failed";
  /** detail-body（strips / 折叠栏 / legs）；失败时非空但 strips 为空 */
  body: DetailBody | null;
  /** 切割后的乘车段（供 NavMap 绘制） */
  legs: ColoredLeg[];
  /** 取景外包框（彩段 + 起终点）；无几何时为 null */
  box: OverviewBox | null;
  /** 各巴士乘车段的在途车辆（已归一 status / company） */
  vehicles: VehicleLite[];
  reload: () => void;
}

/**
 * @param card   当前详情的卡（null = 无）
 * @param open   是否处于 detail pane（false = 清空几何）
 * @param extra  取景额外纳入的点（起点 / 终点）；**调用方需 useMemo 稳定引用**
 */
export function useRouteOverview(
  card: RecommendCard | null,
  open: boolean,
  extra?: { lng: number; lat: number }[],
): UseRouteOverview {
  const detail = useDetailBody(card, open);
  const [legs, setLegs] = useState<ColoredLeg[]>([]);
  const [box, setBox] = useState<OverviewBox | null>(null);
  const [vehicles, setVehicles] = useState<VehicleLite[]>([]);
  const [geomReady, setGeomReady] = useState(false);
  const seqRef = useRef(0);

  const legsInput = detail.body?.legs ?? null;
  /** 稳定 key：distinct route 列表（legs 顺序稳定） */
  const routeKey = useMemo(
    () => (legsInput ? [...new Set(legsInput.map((l) => l.route))].join("|") : ""),
    [legsInput],
  );

  useEffect(() => {
    // 关闭 / 未就绪 → 清空几何（退出 detail 时 NavMap 逐个 remove）
    if (!open || !card || detail.phase !== "ready" || !legsInput) {
      seqRef.current++;
      setLegs([]);
      setBox(null);
      setVehicles([]);
      setGeomReady(false);
      return;
    }
    const id = ++seqRef.current;
    const routes = routeKey ? routeKey.split("|") : [];

    void (async () => {
      // (b) 各 route 的 shapes（并行；force-cache）
      const entries = await Promise.all(
        routes.map(async (code): Promise<[string, RouteShapeLite[]]> => {
          try {
            const r = await fetch(`/api/route-shapes?code=${encodeURIComponent(code)}`, {
              cache: "force-cache",
            });
            const j = (await r.json()) as {
              shapes?: { dir?: string; polyline: string; startStop?: string | null; endStop?: string | null }[];
            };
            const shapes: RouteShapeLite[] = (j.shapes ?? []).map((s) => ({
              dir: s.dir,
              polyline: s.polyline,
              startStop: s.startStop ?? null,
              endStop: s.endStop ?? null,
            }));
            return [code, shapes];
          } catch {
            return [code, []];
          }
        }),
      );
      if (id !== seqRef.current) return;
      const shapesByRoute: Record<string, RouteShapeLite[]> = Object.fromEntries(entries);

      // 组装几何 + 取景框
      const built = buildColoredLegs(legsInput, shapesByRoute);
      const paths = built.map((l) => l.colored).filter((a) => a.length >= 2);
      setLegs(built);
      setBox(unionBox(paths, extra));
      setGeomReady(true);

      // (c) 各巴士段的车辆（并行；no-store）
      const busLegs = built.filter((l) => l.kind === "bus" && l.dir);
      if (!busLegs.length) {
        setVehicles([]);
        return;
      }
      const lists = await Promise.all(
        busLegs.map(async (leg): Promise<VehicleLite[]> => {
          try {
            const r = await fetch(
              `/api/route-vehicles?code=${encodeURIComponent(leg.route)}&dir=${encodeURIComponent(leg.dir as string)}&kind=bus`,
              { cache: "no-store" },
            );
            const j = (await r.json()) as {
              company?: string;
              badCar?: string[];
              vehicles?: {
                plate: string;
                lat: number;
                lng: number;
                speed?: number | null;
                status?: string;
                isLast?: boolean;
                interval?: VehicleLite["interval"];
                atStation?: VehicleLite["atStation"];
              }[];
            };
            const bad = new Set(j.badCar ?? []);
            return (j.vehicles ?? []).map((v) => ({
              plate: v.plate,
              lat: v.lat,
              lng: v.lng,
              speed: v.speed ?? null,
              status: bad.has(v.plate)
                ? "lost"
                : ((VALID_STATES.has(String(v.status)) ? String(v.status) : "unknown") as VehicleLite["status"]),
              isLast: !!v.isLast,
              interval: v.interval ?? null,
              atStation: v.atStation ?? null,
              company: j.company,
            }));
          } catch {
            return [];
          }
        }),
      );
      if (id !== seqRef.current) return;
      setVehicles(lists.flat());
    })();
    // extra 由调用方 useMemo 稳定
  }, [open, card, detail.phase, legsInput, routeKey, extra]);

  return {
    phase: !open
      ? "idle"
      : detail.phase === "failed"
        ? "failed"
        : geomReady
          ? "ready"
          : "loading",
    body: detail.body,
    legs,
    box,
    vehicles,
    reload: detail.reload,
  };
}
