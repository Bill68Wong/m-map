"use client";

/**
 * 路线总览绘制（src/components/nav/nav-map-overview.ts，2026-09-25 从 NavMap 拆出 · 07 §5.3 / §4.4）
 *
 * 双层 polyline（同宽 6px，只靠颜色 / 线型区分）：
 *   · 灰底线 = 所选方向整条线（区间外），`--map-line-dim`，**虚线**（strokeStyle:dashed，z68）；
 *   · 彩段   = board→alight 乘车区间，线路色（`routes.color`）/ 缺省 `--accent`，**实线**（z72）。
 * `degraded`（整线着色）时 `colored === gray` ⇒ 只画彩段。
 *
 * ⚠️ 拆分**零行为变更**：仅把原 `NavMap` 的绘制 effect 主体抽为纯函数（返回创建的 polyline 列表，
 *    由调用方负责 `map.remove()` 清理与观测钩子 `data-overview-legs`）。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { DECIMATE_STEP_M, decimate, type ColoredLeg } from "@/lib/nav/route-overview";
import { readToken } from "./nav-map-fit";

export interface OverviewDrawResult {
  /** 已加入地图的 polyline（调用方负责清理） */
  polylines: unknown[];
  /** 实际绘制的**彩段折线**数（= 真正上屏的乘车段，非 leg 数） */
  drawn: number;
}

export function drawOverview(map: any, AMap: any, overview: ColoredLeg[]): OverviewDrawResult {
  const dim = readToken("--map-line-dim") ?? readToken("--border-2") ?? readToken("--muted");
  const accent = readToken("--accent");
  const polylines: unknown[] = [];
  let drawn = 0;

  for (const leg of overview) {
    try {
      // 灰底线（非乘车区间，虚线）：整线着色（colored===gray）时跳过（只留彩段）
      const grayIsWhole = leg.colored === leg.gray;
      if (dim && !grayIsWhole && leg.gray.length >= 2) {
        const grayPath = decimate(leg.gray, DECIMATE_STEP_M);
        const gpl = new AMap.Polyline({
          path: grayPath,
          strokeColor: dim,
          strokeWeight: 6,
          strokeOpacity: 0.85,
          strokeStyle: "dashed",
          strokeDasharray: [2, 14],
          lineJoin: "round",
          lineCap: "round",
          showDir: true,
          zIndex: 68,
        });
        map.add(gpl);
        polylines.push(gpl);
      }
      // 彩段：乘车区间（整线着色时即为整条）；色源优先线路色（数据）→ --accent Token
      if (leg.colored.length >= 2) {
        const stroke = leg.color ?? accent;
        if (stroke) {
          const cpl = new AMap.Polyline({
            path: leg.colored,
            strokeColor: stroke,
            strokeWeight: 6,
            strokeOpacity: 0.92,
            lineJoin: "round",
            lineCap: "round",
            showDir: true,
            zIndex: 72,
          });
          map.add(cpl);
          polylines.push(cpl);
          drawn++;
        }
      }
    } catch {
      /* 单段绘制失败不影响其余段 */
    }
  }
  return { polylines, drawn };
}
