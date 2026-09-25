"use client";

/**
 * 吸底操作条（src/components/nav/NavTrackBar.tsx，2026-09-25 · v2.14 · 06 §2.1 / AC-16/23/24）
 *
 * ── 结构（吸底，含安全区）────────────────────────────────────────────
 *   状态行：`● 状态 · 车牌/线路` + **来源标签**（AC-23）+ 右侧「下一站 / 新鲜度」（AC-24，紧急信息优先）；
 *   按钮行：主按钮（我已下车）+ 文字纠错（不是这辆 / 还没到）+ 图标刷新。
 *
 * ── 常驻纠错入口（07 §1.5）────────────────────────────────────────────
 *   安全网检出 `anomaly` 时**不静默**：状态行右侧给中性提示 + 对应纠错按钮高亮。
 *   手动通道始终可用（`手动标记上车` 弱样式，等车态）。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   全 Token 上色；单行 nowrap；决策点 ≤4；来源/新鲜度不占主按钮位。
 */
import type { ReactNode } from "react";
import Icon from "@/components/ui/Icon";
import type { RidePhase } from "./useRideTracking";

export interface NavTrackBarProps {
  phase: RidePhase;
  /** 当前段线路展示名（如「51 路」/「轻轨 石排灣線」） */
  routeLabel: string;
  /** 上车站显示名（等车态） */
  boardLabel: string;
  /** 下一站显示名 */
  nextLabel: string;
  /** 下车站显示名 */
  alightLabel: string;
  plate: string | null;
  /** 进度来源（AC-23；轻轨段恒 gps） */
  source: "vehicle" | "gps" | "manual";
  alarm: "none" | "soon" | "now";
  /** 是否轻轨段（决定纠错入口与来源文案） */
  lrt: boolean;
  traveling: boolean;
  /** 安全网检出 */
  anomaly: "none" | "not_boarded" | "alighted";
  /** 状态提示（无车 / 丢信号 / 获取失败等；boarding/riding 可见） */
  note: string;
  /** 新鲜度（秒）；null = 不显示 */
  freshSec: number | null;
  onStart: () => void;
  onBoard: () => void;
  onAlight: () => void;
  onRepick: () => void;
  onRefresh: () => void;
  onStop: () => void;
  /** 「我没上车」（A1 纠错 → 回等车） */
  onNotBoard: () => void;
  /** 「还没到」（误报到站 → 回乘车中） */
  onNotArrive: () => void;
}

const SOURCE_LABEL: Record<"vehicle" | "gps" | "manual", string> = {
  vehicle: "依据车辆位置",
  gps: "实时定位",
  manual: "手动",
};

export default function NavTrackBar(props: NavTrackBarProps) {
  const {
    phase,
    routeLabel,
    boardLabel,
    nextLabel,
    alightLabel,
    plate,
    source,
    alarm,
    lrt,
    traveling,
    anomaly,
    note,
    freshSec,
    onStart,
    onBoard,
    onAlight,
    onRepick,
    onRefresh,
    onStop,
    onNotBoard,
    onNotArrive,
  } = props;

  const isRiding = phase === "riding";
  /** AC-23：来源标注仅「乘车中」显示两态（实时定位 / 依据车辆位置）；手动纠正后含「手动」 */
  const sourceTag = isRiding ? SOURCE_LABEL[source] : null;

  // 左：状态文案
  let left: ReactNode = null;
  // 右：补充信息（紧急信息优先）
  let right: string | null = null;

  if (phase === "off") {
    left = <>准备出发</>;
    right = null;
  } else if (phase === "boarding") {
    left = (
      <>
        等待上车 · <b>{boardLabel}</b>
      </>
    );
    right = "正在检测车辆";
  } else if (phase === "riding") {
    if (alarm === "now") {
      left = (
        <>
          已到站 · <b>{alightLabel}</b>
        </>
      );
    } else {
      left = (
        <>
          乘车中 · <b>{plate ?? routeLabel}</b>
          {!plate && lrt && <span className="nav-actions__sub"> · {routeLabel}</span>}
        </>
      );
    }
    right = alarm === "soon" ? `即将到达 ${alightLabel}` : nextLabel ? `下一站 ${nextLabel}` : null;
  } else {
    left = <>已到达目的地</>;
  }

  // 新鲜度让位（仅 riding 且无更紧急信息时）
  if (isRiding && !right && freshSec != null) right = `上次更新：${freshSec} 秒前`;

  // 安全网提示（状态行内）
  const anomalyHint =
    anomaly === "not_boarded" ? "疑似还没上车" : anomaly === "alighted" ? "疑似已下车" : null;

  return (
    <div className="nav-actions" data-nav-phase={phase}>
      <div className="nav-actions__staterow">
        <span className="nav-actions__dot" aria-hidden="true" />
        {left}
        {sourceTag && <span className="nav-actions__src">{sourceTag}</span>}
        {anomalyHint && <span className="nav-actions__src">{anomalyHint}</span>}
        {right && <span className="nav-actions__spacer">{right}</span>}
      </div>

      <div className="nav-actions__btnrow">
        {phase === "off" && (
          <button type="button" className="btn btn--primary btn--sm" onClick={onStart}>
            开始导航
          </button>
        )}

        {phase === "boarding" && (
          <>
            <button
              type="button"
              className={`btn btn--text btn--sm${anomaly === "not_boarded" ? " is-emph" : ""}`}
              onClick={anomaly === "not_boarded" ? onNotBoard : onBoard}
            >
              {anomaly === "not_boarded" ? "我没上车" : "手动标记上车"}
            </button>
            <span className="nav-actions__spacer nav-actions__hint">上车后自动开始跟踪</span>
            <button type="button" className="btn btn--text btn--sm" onClick={onStop}>
              结束导航
            </button>
          </>
        )}

        {phase === "riding" && (
          <>
            <button type="button" className="btn btn--primary btn--sm" onClick={onAlight}>
              {alarm === "now" ? "已下车" : "我已下车"}
            </button>
            {alarm === "soon" || alarm === "now" ? (
              <button type="button" className="btn btn--text btn--sm" onClick={onNotArrive}>
                还没到
              </button>
            ) : (
              !lrt && (
                <button
                  type="button"
                  className={`btn btn--text btn--sm${anomaly !== "none" ? " is-emph" : ""}`}
                  onClick={anomaly !== "none" ? onNotBoard : onRepick}
                >
                  {anomaly === "not_boarded" ? "我没上车" : "不是这辆"}
                </button>
              )
            )}
            <button
              type="button"
              className="nav-actions__iconbtn"
              onClick={onRefresh}
              disabled={traveling}
              aria-label="刷新"
              title="刷新"
            >
              <Icon name="refresh" size={20} />
            </button>
          </>
        )}

        {phase === "done" && (
          <button type="button" className="btn btn--primary btn--sm" onClick={onStop}>
            结束导航
          </button>
        )}
      </div>

      {/* 状态提示（无车 / 丢信号 / 获取失败等；boarding/riding 可见，防「静默失败」） */}
      {(phase === "boarding" || phase === "riding") && note && (
        <p className="nav-track__note t-label" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
