"use client";

/**
 * 吸底操作条（src/components/nav/NavTrackBar.tsx，2026-09-25 · v2.14 · 06 §2.1 / AC-16/23/24）
 *
 * ── 结构（吸底，含安全区）────────────────────────────────────────────
 *   状态行：`● 状态 · 车牌/线路` + **来源标签**（AC-23）+ 右侧「即将到达 / 新鲜度」
 *   （★ 本批 AC-33：**去掉重复的「下一站」** —— 下一站唯一来源 = 纵条 `.navstrip__badge`）；
 *   按钮行：主按钮（我已下车）+ 文字纠错（不是这辆 / 还没到）+ 图标刷新。
 *
 * ── 挂载位置（★ 本批）────────────────────────────────────────────────
 *   由 `RouteSheet` 渲染在 **`.route-sheet__actions-slot`**（面板根，`transform` 同上下文，AC-58）；
 *   本组件只负责内容，不再自持 `position: sticky` 定位。
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
  /** 下车站显示名 */
  alightLabel: string;
  plate: string | null;
  /** 进度来源（AC-23；轻轨段恒 gps） */
  source: "vehicle" | "gps" | "manual";
  alarm: "none" | "soon" | "now";
  /** 是否轻轨段（决定纠错入口与来源文案） */
  lrt: boolean;
  traveling: boolean;
  /**
   * ★ v3.6.0 S4：车辆刷新冷却剩余秒数（0 = 可刷新）。
   *   与 `traveling` 一起构成刷新键的禁用条件 —— 冷却来自 `useCooldown` 的时间戳，
   *   不是请求状态（旧版只挡 `traveling`，等于「一次 HTTP 往返」就成了冷却）。
   */
  coolingSec?: number;
  /**
   * ★ v3.6.0（AC-25a）：自动上车判定的实际状态。
   *   `paused`（拒权/超时/连续低精度）⇒ 文案必须说"已暂停"，**不得**再说"正在检测"。
   */
  boardDetect?: "on" | "paused";
  /** 安全网检出 */
  anomaly: "none" | "not_boarded" | "alighted";
  /** 状态提示（无车 / 丢信号 / 获取失败等；boarding/riding 可见） */
  note: string;
  /** 新鲜度（秒）；null = 不显示 */
  freshSec: number | null;
  /** ★ 本批：自动下车瞬态（用于 `data-track-state='alighted'`，AC-55/56） */
  justAlighted?: boolean;
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
    alightLabel,
    plate,
    source,
    alarm,
    lrt,
    traveling,
    coolingSec = 0,
    boardDetect = "on",
    anomaly,
    note,
    freshSec,
    justAlighted = false,
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
    /**
     * ★ v3.6.0（AC-25a）：判定已停止时**不得**再写「正在检测车辆」——
     *   那会把"我不再看"渲染成"车还没来"。完整原因由下方 `note` 承担，
     *   这里只给最短状态词，避免同一句话在状态行/提示行/按钮行说三遍。
     */
    right = boardDetect === "paused" ? "已暂停" : "正在检测车辆";
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
    right = alarm === "soon" ? `即将到达 ${alightLabel}` : null;
  } else {
    left = <>已到达目的地</>;
  }

  // 新鲜度让位（仅 riding 且无更紧急信息时）
  if (isRiding && !right && freshSec != null) right = `上次更新：${freshSec} 秒前`;

  // 安全网提示（状态行内）
  const anomalyHint =
    anomaly === "not_boarded" ? "疑似还没上车" : anomaly === "alighted" ? "疑似已下车" : null;

  return (
    <div
      className="nav-actions"
      data-nav-phase={phase}
      data-track-state={justAlighted ? "alighted" : phase}
      data-board-detect={phase === "boarding" || phase === "off" ? boardDetect : undefined}
    >
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
            <span className="nav-actions__spacer nav-actions__hint">
              {boardDetect === "paused" ? "定位不可用，上车后请手动点左侧按钮" : "上车后自动开始跟踪"}
            </span>
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
              onClick={() => {
                if (traveling || coolingSec > 0) return;
                onRefresh();
              }}
              /**
               * ★ v3.6.0 S4：用 `aria-disabled`（**不用原生 `disabled`**）——
               *   本栏是面板拖动把手附近区域，原生 `disabled` 会**吞掉 pointerdown**
               *   （`RouteSheet.tsx` 头部同样记过这个坑）⇒ 形成拖拽死区。
               *   同时把「冷却」纳入禁用条件：旧版只挡 `traveling`（= 一次 HTTP 往返 ≈1s），
               *   用户看到的就是「一秒冷却一次」。
               */
              aria-disabled={traveling || coolingSec > 0 || undefined}
              aria-label={coolingSec > 0 ? `刷新，${coolingSec} 秒后可再次刷新` : "刷新"}
              title={coolingSec > 0 ? `${coolingSec} 秒后可再次刷新` : "刷新"}
            >
              <Icon name="refresh" size={20} />
              {coolingSec > 0 && (
                <span className="nav-actions__cd" aria-hidden="true">
                  {coolingSec}
                </span>
              )}
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
