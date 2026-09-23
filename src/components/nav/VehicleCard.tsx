"use client";

/**
 * 车辆信息卡（src/components/nav/VehicleCard.tsx，v2.10.0）
 *
 * ── 内容（Spec AC-06）─────────────────────────────────────────────────
 *   状态 / 车速 / 行驶区间（站号+站名 → 站号+站名）/ 车牌 / 数据时间。
 *
 * ── 设计裁定（设计师已论证，务必遵守）────────────────────────────────
 *   「行驶区间」**只表方向**：实心点 →（虚线）→ 空心点。
 *   **不做「已行进进度」填充** —— 接口只给 from→to，画进度是**伪造精度**。
 *
 * ── 落位 ──────────────────────────────────────────────────────────────
 *   复用站点信息卡 `.nav-station-card` 的绝对定位/层级（z-index 30），
 *   只补行与状态徽标样式（见 globals.css `.nav-vehicle-card__*`）。
 */
import Icon from "@/components/ui/Icon";
import { VEHICLE_STATE_LABEL, type VehicleLite } from "./VehicleMarker";

export interface VehicleCardProps {
  vehicle: VehicleLite;
  /** 合并组内车辆数（>1 时提示） */
  count?: number;
  /** 数据取得时间（ISO 字符串，来自响应 `fetchedAt`） */
  fetchedAt?: string | null;
  /**
   * ★ v2.10.1（用户口径）：车牌前的**线路主题色标签**用。
   *   `lineLabel` = 线路名（如「26」/「氹仔线」）；`lineColor` = 该线主题色。
   */
  lineLabel?: string;
  lineColor?: string;
  onClose: () => void;
}

/** ISO → 澳门时间 HH:MM（UTC+8；卡片是交互后才挂载的客户端组件，无 SSR 水合问题） */
function macauHm(iso?: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const d = new Date(t + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export default function VehicleCard({
  vehicle,
  count = 1,
  fetchedAt = null,
  lineLabel,
  lineColor,
  onClose,
}: VehicleCardProps) {
  const state = vehicle.status;
  const stateLabel = VEHICLE_STATE_LABEL[state] ?? "状态未知";
  const speed = typeof vehicle.speed === "number" ? `${vehicle.speed} km/h` : "—";
  const interval = vehicle.interval;
  const at = vehicle.atStation;

  return (
    <section className="nav-station-card nav-vehicle-card" role="dialog" aria-label={`车辆 ${vehicle.plate}`}>
      <div className="nav-station-card__head">
        <span className="nav-station-card__name nav-vehicle-card__title">
          {/* ★ v2.10.1：车牌**前**加线路名主题色标签（用户口径）；运营商不再显示 */}
          {lineLabel && (
            <span
              className="nav-vehicle-card__line"
              style={{ background: lineColor ?? "var(--primary)" }}
            >
              {lineLabel}
            </span>
          )}
          <span className="nav-vehicle-card__plate">{vehicle.plate}</span>
          {vehicle.isLast ? <span className="nav-vehicle-card__last">末班</span> : null}
        </span>
        <button
          type="button"
          className="nav-station-card__close"
          aria-label="关闭车辆信息"
          title="关闭"
          onClick={onClose}
        >
          <Icon name="close" size={20} />
        </button>
      </div>

      <div className="nav-vehicle-card__rows">
        {/* 状态 */}
        <div className="nav-vehicle-card__row">
          <span className="nav-vehicle-card__k t-label">状态</span>
          <span className="nav-vehicle-card__state" data-state={state}>
            {stateLabel}
          </span>
        </div>

        {/* 车速（运营商行已按用户口径移除） */}
        <div className="nav-vehicle-card__row">
          <span className="nav-vehicle-card__k t-label">
            <Icon name="gauge" size={16} /> 车速
          </span>
          <span className="nav-vehicle-card__v">{speed}</span>
        </div>

        {/*
          ★ v2.10.1（用户口径）：**区间改为两行**（站号+站名 ‖ 站号+站名）
          —— 原先横向排一行，长站名会把后半段挤成省略号（如「T354 氹仔…」）✗
          两行后每段独占一行、可完整显示；中间用竖线分隔，方向感仍保留。
          ⚠️ 仍**不做「已行进进度」填充**（接口只给 from→to，画进度是伪造精度）。
        */}
        <div className="nav-vehicle-card__row nav-vehicle-card__row--stack">
          <span className="nav-vehicle-card__k t-label">
            <Icon name="route-2" size={16} /> 区间
          </span>
          <span className="nav-vehicle-card__interval2">
            {interval ? (
              <>
                <span className="nav-vehicle-card__seg">{`${interval.from.code} ${interval.from.name}`}</span>
                <span className="nav-vehicle-card__pipe" aria-hidden="true" />
                <span className="nav-vehicle-card__seg">{`${interval.to.code} ${interval.to.name}`}</span>
              </>
            ) : at ? (
              <span className="nav-vehicle-card__seg">{`停靠 ${at.code} ${at.name}`}</span>
            ) : (
              <span className="nav-vehicle-card__seg">—</span>
            )}
          </span>
        </div>

        {/* 数据时间（★ 标签强制不换行 —— 原先窄屏下「数据时间」四字会拆行） */}
        <div className="nav-vehicle-card__row">
          <span className="nav-vehicle-card__k nav-vehicle-card__k--nowrap t-label">
            <Icon name="timer" size={16} /> 数据时间
          </span>
          <span className="nav-vehicle-card__v">{macauHm(fetchedAt)}</span>
        </div>
      </div>

      {(count > 1 || !interval) && (
        <p className="nav-vehicle-card__note t-label">
          {count > 1 && `此处合并显示 ${count} 辆车。`}
          {!interval && " 报站接口未返回行驶区间，仅显示位置与车牌。"}
        </p>
      )}
    </section>
  );
}
