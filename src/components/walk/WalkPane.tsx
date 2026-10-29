"use client";

/**
 * 步行跟随面板（src/components/walk/WalkPane.tsx，v3.6.0 · S5）
 *
 * ── 落位 ──────────────────────────────────────────────────────────────
 *   `nav-phase === "walk"` 时插在 detail pane 顶部（不是新开全屏层 —— 避免与
 *   bottom-sheet 手势打架，`RouteSheet.tsx` 头部记过"两独立弹窗叠加"的教训）。
 *   顶部横幅 `.walkturn` **不在这里**（它是页面级 fixed，必须挂 `.nav-map-wrap` 之外，
 *   见 `WalkTurnBanner` 文件头 ①）—— 本组件只管**面板内**内容。
 *
 * ── 内容（设计 §2.2 ②）─────────────────────────────────────────────────
 *   · `.walkseg__done`「已完成 N 步」（44px 命中区，点开看全量）；
 *   · `.walkseg` 当前步 + 后续 2 步（≤3 行）；
 *   · `.walkoff` 偏航提示（连续 2 帧才出，由 `useWalkFollow.offRoute` 给）；
 *   · `.walklist__manual` 手动兜底（manual 态）。
 */
import Icon from "@/components/ui/Icon";
import type { WalkStep } from "@/lib/walk/walk-shared";
import WalkStepList from "./WalkStepList";
import type { WalkFollowPhase } from "./useWalkFollow";

export interface WalkPaneProps {
  phase: WalkFollowPhase;
  steps: WalkStep[];
  currentIdx: number;
  /** 剩余米（面板底部一行「还有 N 米」） */
  remainM: number;
  /** 已确认偏航 */
  offRoute: boolean;
  offM: number;
  /** 定位不可用 ⇒ 出「上一步/下一步」手动兜底 */
  lowAccuracy: boolean;
  /** 点「已完成 N 步」展开全量 */
  showAll: boolean;
  onToggleAll: () => void;
  /** 手动步进 */
  onPrev: () => void;
  onNext: () => void;
  /** 超长步行提示（AC-09） */
  longWalk?: boolean;
}

/** 面板里只显示「当前步 + 后续 2 步」（设计：≤3 行，避免面板被步骤撑满） */
const VISIBLE_AHEAD = 2;

export default function WalkPane({
  phase,
  steps,
  currentIdx,
  remainM,
  offRoute,
  offM,
  lowAccuracy,
  showAll,
  onToggleAll,
  onPrev,
  onNext,
  longWalk = false,
}: WalkPaneProps) {
  if (!steps.length) return null;

  const doneCount = Math.max(0, currentIdx);
  /** 切片：全量 or 当前步起 3 行 */
  const from = showAll ? 0 : Math.max(0, currentIdx);
  const to = showAll ? steps.length : Math.min(steps.length, currentIdx + 1 + VISIBLE_AHEAD);
  const visible = steps.slice(from, to);

  /** 到达后列表整体淡出，只留横幅（设计：距终点 <30 米） */
  const fading = phase === "arrived";

  return (
    <div className={`walkpane${fading ? " is-fading" : ""}`}>
      {offRoute && (
        <p className="walkpane__off t-label" role="status">
          已偏离路线 {offM} 米，正在重新规划
        </p>
      )}

      {!showAll && doneCount > 0 && (
        <button type="button" className="walkseg__done" onClick={onToggleAll}>
          <Icon name="check" size={16} />
          已完成 {doneCount} 步
        </button>
      )}
      {showAll && (
        <button type="button" className="walkseg__done" onClick={onToggleAll}>
          <Icon name="caretUp" size={16} />
          收起已完成步骤
        </button>
      )}

      <WalkStepList
        steps={visible}
        /* 全量视图用真实索引；切片视图里第一行就是当前步 ⇒ 传 0 */
        currentIdx={showAll ? currentIdx : currentIdx - from}
        idPrefix="pane"
        longWalk={longWalk && !showAll}
        manual={lowAccuracy ? { onPrev, onNext } : null}
      />

      <p className="walkpane__remain t-label t-muted">
        还剩 <b>{Math.round(remainM)}</b> 米
      </p>
    </div>
  );
}
