"use client";

/**
 * 车辆图标（src/components/nav/VehicleMarker.tsx，v2.10.0）
 *
 * ── 图形（设计规格锁定：**车头正视图**，用户反馈上一版像车顶）─────────
 *   · 画布 32×32、命中区 44×44、**车头恒朝上**（接口无航向角，不旋转）；
 *   · 全部由纯 rect / circle 组成，**零依赖、零 emoji**；
 *   · 状态由 `data-state` 驱动（**只切 display / fill，不改 SVG 结构**）；
 *   · 涂装色由行内 `--vbus-livery` 注入（**运营商色是数据**，不写进 CSS）。
 *   ⚠️ 车辆图标**不经 Tabler**（它是自绘插画）；卡内功能图标才用 Tabler。
 *
 * ── 状态的两个正交维度 ────────────────────────────────────────────────
 *   · `data-state` ∈ moving | stopping | terminal | lost | unknown
 *   · `data-last="1"` = 末班车（**独立属性** —— 末班车同时也在行驶，不能挤进 data-state）
 *
 * ── 多车合并 ──────────────────────────────────────────────────────────
 *   屏距 ≤ `VEHICLE_MERGE_DIST`（28px）合并为一枚图标；角标 ≤9 显数字、>9 显 `9+`。
 */
import type { CSSProperties } from "react";
import type { VehicleProgress } from "@/lib/nav/progress";

/** `/api/route-vehicles` 单车（前端视图模型；`company` 由调用方从响应顶层注入） */
export interface VehicleLite {
  plate: string;
  /** GCJ-02 */
  lat: number;
  lng: number;
  /** km/h（接口缺省为 null） */
  speed?: number | null;
  status: "moving" | "stopping" | "terminal" | "unknown" | "lost";
  isLast?: boolean;
  /** 精确行驶区间（报站接口给；失败为 null） */
  interval?: { from: { code: string; name: string }; to: { code: string; name: string } } | null;
  /** 停靠中所在站 */
  atStation?: { code: string; name: string } | null;
  /** ★ v3.4.0：区间进度（服务端 `?progress=1` 填充；缺省 = 该车不可算，调用方降级） */
  progress?: VehicleProgress | null;
  /** 运营商：`澳巴` / `新福利`（决定涂装色） */
  company?: string;
}

/** 合并阈值（屏距，px）—— Spec AC-07 */
export const VEHICLE_MERGE_DIST = 28;

/** 状态文案（界面一律简体） */
export const VEHICLE_STATE_LABEL: Record<string, string> = {
  moving: "行驶中",
  stopping: "停靠中",
  terminal: "总站待发",
  lost: "信号丢失",
  unknown: "状态未知",
};

/** 运营商 → 涂装色（Spec §8：澳巴橙 / 新福利蓝） */
export const VEHICLE_LIVERY = {
  transmac: "#E26A0E",
  nfb: "#1466B8",
} as const;

/** 把后端可能的多种运营商写法归一为 `transmac` | `nfb` */
export function normalizeCompany(raw?: string | null): "transmac" | "nfb" {
  const s = (raw ?? "").trim();
  if (s === "新福利" || s.toLowerCase() === "nfb" || s.toLowerCase() === "transmac_nfb") return "nfb";
  return "transmac";
}

/** 运营商中文名（aria-label 用） */
export function companyLabel(c: "transmac" | "nfb"): string {
  return c === "nfb" ? "新福利" : "澳巴";
}

export interface ScreenPoint {
  v: VehicleLite;
  x: number;
  y: number;
}

export interface VehicleCluster {
  /** 稳定 key（车牌拼接） */
  key: string;
  /** 合并后中心（屏幕像素） */
  x: number;
  y: number;
  items: VehicleLite[];
}

/**
 * 按**屏幕距离**合并车辆（贪心：以首个未分组点为锚，吸收 `dist` 内的其余点，取质心）。
 * 纯函数、无副作用 —— 便于单测与复用。
 */
export function clusterByScreenDistance(
  pts: ScreenPoint[],
  dist: number = VEHICLE_MERGE_DIST,
): VehicleCluster[] {
  const used = new Array<boolean>(pts.length).fill(false);
  const out: VehicleCluster[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const group = [pts[i]];
    for (let j = i + 1; j < pts.length; j++) {
      if (used[j]) continue;
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) <= dist) {
        used[j] = true;
        group.push(pts[j]);
      }
    }
    const x = group.reduce((s, g) => s + g.x, 0) / group.length;
    const y = group.reduce((s, g) => s + g.y, 0) / group.length;
    out.push({ key: group.map((g) => g.v.plate).join("|"), x, y, items: group.map((g) => g.v) });
  }
  return out;
}

export interface VehicleMarkerProps {
  /** 合并组内的车辆（≥1；`items[0]` 代表该组） */
  items: VehicleLite[];
  /**
   * @deprecated ★ 2026-09-23：车辆已**原生化**（`VehicleLayer` 的 AMap.Marker 驱动位置）
   *   ⇒ 屏幕坐标不再使用（调用方传 0）；保留字段仅为兼容签名，**不影响渲染**。
   */
  x?: number;
  /** @deprecated 同上（屏幕坐标不再使用） */
  y?: number;
  onClick?: () => void;
}

/**
 * 单枚车辆图标。**位置由外层决定**：
 *   · 原生化后由 `AMap.Marker`（`anchor:'center'`）定位 ⇒ 本组件只画 44×44 命中盒 + 32px svg。
 */
export default function VehicleMarker({ items, onClick }: VehicleMarkerProps) {
  const v = items[0];
  const count = items.length;
  const company = normalizeCompany(v.company);
  const state = v.status;
  const label = `${companyLabel(company)}${v.isLast ? " 末班" : ""} ${VEHICLE_STATE_LABEL[state] ?? "状态未知"}${
    count > 1 ? `，共 ${count} 辆` : ""
  }`;

  return (
    <button
      type="button"
      className="vbus-wrap"
      data-state={state}
      data-last={v.isLast ? "1" : undefined}
      style={{ "--vbus-livery": VEHICLE_LIVERY[company] } as CSSProperties}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg className="vbus" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        {/* ① 硬投影：车身剪影 translate(3 3)、零模糊（后视镜不投影，避免出画布） */}
        <g className="vbus__shadow" transform="translate(3 3)">
          <rect x="5" y="4" width="22" height="24" rx="5" />
        </g>
        {/* ② 白描边层 */}
        <rect className="vbus__white" x="5" y="4" width="22" height="24" rx="5" />
        {/* ③ 墨色描边层（1.5px）—— 用同心矩形而非 stroke：stroke 居中会吃掉 3px 硬投影 */}
        <rect className="vbus__ink" x="6.5" y="5.5" width="19" height="21" rx="3.6" />
        {/* ④ 涂装车身（运营商色，由 --vbus-livery 注入） */}
        <rect className="vbus__body" x="8" y="7" width="16" height="18" rx="2.2" />
        {/* ⑤ 后视镜（顶部两侧 ⇒ 「车头在上」的强线索） */}
        <rect className="vbus__mirror" x="2.2" y="10.2" width="3" height="2.6" rx="1.2" />
        <rect className="vbus__mirror" x="26.8" y="10.2" width="3" height="2.6" rx="1.2" />
        {/* ⑥ 极简扁平细节：线路牌 / 挡风玻璃 / 左右大灯 / 前保险杠 */}
        <rect className="vbus__sign" x="11.5" y="7" width="9" height="1.2" rx="0.6" />
        <rect className="vbus__glass" x="9.2" y="8.4" width="13.6" height="7.2" rx="1.8" />
        <circle className="vbus__lamp" cx="11.4" cy="19.4" r="1.9" />
        <circle className="vbus__lamp" cx="20.6" cy="19.4" r="1.9" />
        <rect className="vbus__bumper" x="8" y="22.4" width="16" height="2.2" rx="1.1" />
        {/* ⑦ 状态修饰 A：虚线白圈（总站待发 / 信号丢失） */}
        <rect className="vbus__dash" x="5.75" y="4.75" width="20.5" height="22.5" rx="4.25" />
        {/* ⑦ 状态修饰 B：停靠中 ‖（右下） */}
        <g className="vbus__stop">
          <circle className="vbus__badge-bg" cx="26" cy="26" r="4.8" />
          <rect className="vbus__badge-mark" x="23.7" y="23.4" width="1.6" height="5.2" rx="0.8" />
          <rect className="vbus__badge-mark" x="26.7" y="23.4" width="1.6" height="5.2" rx="0.8" />
        </g>
        {/* ⑦ 状态修饰 C：信号丢失 !（左下） */}
        <g className="vbus__lost">
          <circle className="vbus__badge-bg" cx="6" cy="26" r="4.8" />
          <rect className="vbus__badge-mark" x="5.35" y="23.2" width="1.3" height="3.3" rx="0.65" />
          <circle className="vbus__badge-mark" cx="6" cy="28" r="0.8" />
        </g>
      </svg>
      {count > 1 && (
        <span className="vbus__count" aria-hidden="true">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </button>
  );
}
