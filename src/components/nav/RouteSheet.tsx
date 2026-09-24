"use client";

/**
 * 单宿主三档面板（src/components/nav/RouteSheet.tsx，2026-09-23 新增）
 *
 * ── 架构决策（技术方案 §2.1）────────────────────────────────────────────
 *   **单一 Bottom Sheet 宿主 + 内容切换（列表 ⇄ 详情）**，而非两个独立全屏弹窗叠加
 *   （叠加会出现「推荐层露在详情层之上」的怪异层叠 + 手势冲突）。收益：
 *     · 高度联动是一条 `transform`，最平滑；
 *     · **列表 pane 常驻不卸载** ⇒ 保滚动位置、秒回；
 *     · 消除双层高度打架。
 *
 * ── 三档（§2.2）────────────────────────────────────────────────────────
 *   `full`（近全屏，推荐默认）/ `half`（下半屏，详情默认）/ `peek`（20% 收起档）。
 *   吸附与关闭链路见 `useSnapSheet`（逐对阈值、flick 跨档、peek 越界关闭）。
 *
 * ── 关闭链路（§2.3.1）──────────────────────────────────────────────────
 *   · 推荐 pane：X / peek 下拉 → **关闭面板**（回半屏可出发 / 无 OD 回全屏地图）；
 *   · 详情 pane：X / 返回箭头 / peek 下拉 → **回推荐列表**（`full`，保滚动）。
 *   语义由 `onContextClose` 统一承担（调用方按 pane 决定）。
 *
 * ── 内容切换（先动后填，PM §2.3）────────────────────────────────────────
 *   点卡片**当帧**切 pane + 启动 `full→half` 动画 + 骨架；详情数据并行拉取（动画不被网络阻塞）。
 *
 * ⚠️ 挂载位置：必须挂在 `.nav-map-wrap` **之外**（层叠上下文，Spec AC-13 教训）。
 */
import Icon from "@/components/ui/Icon";
import ComplianceBar from "@/components/nav/ComplianceBar";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import RouteStack from "@/components/RouteStack";
import { macauClock } from "@/components/RoutePieces";
import BottomSheet from "./BottomSheet";
import RouteDetailPane from "./RouteDetailPane";
import RouteResultPane from "./RouteResultPane";
import { useRecommend } from "./useRecommend";
import { useSnapSheet } from "./useSnapSheet";
import type { DetailBody } from "./useDetailBody";
import { DETENTS, detentIndex, type Detent } from "./sheet-detents";
import type { FavoriteEndpoint } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";

export interface RouteSheetDetail {
  card: RecommendCard;
  degraded: boolean;
  destLabel: string;
  phase: "idle" | "loading" | "ready" | "failed";
  body: DetailBody | null;
  /** 该详情当前在途车辆数（观测钩子 `data-live` 用） */
  vehicles: number;
  reload: () => void;
}

export interface RouteSheetProps {
  open: boolean;
  pane: "recommend" | "detail";
  detent: Detent;
  /** 各档顶边像素（升序，与 DETENTS 对齐） */
  topsPx: number[];
  onDetentChange: (d: Detent) => void;
  /** contextual 关闭：推荐→关面板；详情→回推荐（调用方按 pane 决定） */
  onContextClose: () => void;
  odLabel: string;
  query: string;
  colors: Record<string, string>;
  fav?: { from: FavoriteEndpoint; to: FavoriteEndpoint } | null;
  detail?: RouteSheetDetail | null;
  onOpenDetail: (card: RecommendCard, degraded: boolean) => void;
}

export default function RouteSheet({
  open,
  pane,
  detent,
  topsPx,
  onDetentChange,
  onContextClose,
  odLabel,
  query,
  colors,
  fav = null,
  detail = null,
  onOpenDetail,
}: RouteSheetProps) {
  // 推荐列表数据（列表 pane 常驻；同一 query 只自动拉一次）
  const rec = useRecommend(query, open && pane === "recommend");

  const snap = useSnapSheet({
    open,
    detent,
    topsPx,
    onDetentChange,
    onDismiss: onContextClose,
    /**
     * ★ 2026-09-24（用户实测反馈·二轮）：**两个 pane 统一禁用**「最低档继续下拉关闭」——
     *   拉到底一律硬停/回弹，不再"整体拖没"（详情层此前下拉会退回推荐页，用户要求一致硬停）。
     *   关闭途径：推荐层 = bar 的 X / peek 关闭键；详情层 = bar 返回箭头 / peek 关闭键（= 回推荐）。
     */
    dismissible: false,
  });

  /** peek 点整区 → 回该 pane 的默认档（推荐→full / 详情→half） */
  const defaultDetent: Detent = pane === "detail" ? "half" : "full";

  /** ★ 观测钩子 `data-phase`：当前 pane 的数据阶段（loading|ready|empty|failed） */
  const phase: "loading" | "ready" | "empty" | "failed" =
    pane === "detail"
      ? !detail
        ? "loading"
        : detail.phase === "failed"
          ? "failed"
          : detail.phase === "ready"
            ? "ready"
            : "loading"
      : rec.phase === "failed"
        ? "failed"
        : rec.phase === "ready"
          ? rec.data && rec.data.cards.length === 0
            ? "empty"
            : "ready"
          : "loading";

  /**
   * ★ 观测钩子 `data-live`：实时班次状态（on|none|ended）——供 AC-14 自动化断言。
   * 口径：在途车 > 0 ⇒ `on`；否则按**澳门时间**（UTC+8）近似服务时段（06:00–23:59）
   * 判定 `none`（未发车）或 `ended`（已收班）。⚠️ 无「收班」显式字段，此为近似口径。
   */
  const macauHour = new Date(Date.now() + 8 * 3_600_000).getUTCHours();
  const inService = macauHour >= 6 && macauHour <= 23;
  const live: "on" | "none" | "ended" =
    (detail?.vehicles ?? 0) > 0 ? "on" : detail?.phase === "ready" && !inService ? "ended" : "none";

  /** 推荐 peek 摘要（最快方案的时长 + 线路 chips + 共 N 條） */
  const recSummary =
    rec.data && rec.data.cards.length
      ? (() => {
          const fastest = [...rec.data.cards].sort((a, b) => a.totalMin - b.totalMin)[0];
          return {
            min: Math.round(fastest.totalMin),
            routes: fastest.rides.map((r) => r.route),
            count: rec.data.cards.length,
          };
        })()
      : null;

  return (
    <BottomSheet
      open={open}
      pane={pane}
      detent={detent}
      phase={phase}
      live={live}
      dragging={snap.dragging}
      translateY={snap.translateY}
      layoutY={snap.layoutY}
      ariaLabel={`路线面板 ${odLabel}`}
      onPointerDown={snap.onPointerDown}
      onPointerMove={snap.onPointerMove}
      onPointerUp={snap.onPointerUp}
      onPeekTap={() => onDetentChange(defaultDetent)}
      peekTapGuard={snap.tapOk}
      onDismiss={onContextClose}
      bar={
        <>
          {pane === "detail" && detail && (
            <button
              type="button"
              className="route-sheet__iconbtn"
              onClick={onContextClose}
              aria-label="返回推荐列表"
            >
              <Icon name="back" size={20} />
            </button>
          )}
          <span className="route-sheet__od t-label">{odLabel}</span>
          {pane === "recommend" && (
            <>
              {fav && (
                <FavoriteButton kind="place" entry="odbar" from={fav.from} to={fav.to} query={query} />
              )}
              <button
                type="button"
                className="btn btn--text btn--sm"
                onClick={rec.reload}
                disabled={rec.phase === "loading"}
                aria-label="刷新路线结果"
              >
                {rec.phase === "loading" ? "刷新中…" : "刷新"}
              </button>
            </>
          )}
          <button
            type="button"
            className="route-sheet__iconbtn"
            onClick={onContextClose}
            aria-label={pane === "detail" ? "返回推荐列表" : "关闭面板"}
          >
            <Icon name="close" size={20} />
          </button>
        </>
      }
      peek={
        pane === "detail" && detail ? (
          <div className="sheet-peek-summary" data-variant="detail">
            <p className="sheet-peek__od">{odLabel}</p>
            <div className="sheet-peek__metric">
              <span className="sheet-peek__big">
                {Math.round(detail.card.totalMin)}
                <span className="sheet-peek__unit">分</span>
              </span>
              {detail.card.rides.length > 1 && (
                <span className="sheet-peek__meta">换乘 {detail.card.rides.length - 1} 次</span>
              )}
              <RouteStack codes={detail.card.rides.map((r) => r.route)} colors={colors} size="sm" />
              <span className="sheet-peek__meta">{macauClock(detail.card.arriveAt)} 抵达</span>
              <Icon name="caretUp" size={20} className="sheet-peek__chev" />
            </div>
          </div>
        ) : (
          <div className="sheet-peek-summary" data-variant="recommend">
            <p className="sheet-peek__od">{odLabel}</p>
            <div className="sheet-peek__metric">
              {recSummary ? (
                <>
                  <span className="sheet-peek__big">
                    {recSummary.min}
                    <span className="sheet-peek__unit">分</span>
                  </span>
                  <RouteStack codes={recSummary.routes} colors={colors} size="sm" />
                  <span className="sheet-peek__meta">共 {recSummary.count} 條</span>
                </>
              ) : (
                <span className="sheet-peek__meta">
                  {rec.phase === "loading" ? "正在规划…" : "暂无可用路线"}
                </span>
              )}
              <Icon name="caretUp" size={20} className="sheet-peek__chev" />
            </div>
          </div>
        )
      }
    >
      {/* 推荐列表 pane：常驻不卸载（opacity 切换 ⇒ 保滚动位置） */}
      <div className="route-sheet__pane" data-pane="recommend" aria-hidden={pane !== "recommend"}>
        <div className="route-sheet__scroll">
          <RouteResultPane
            phase={rec.phase}
            data={rec.data}
            err={rec.err}
            onRetry={rec.reload}
            onCardOpen={onOpenDetail}
          />
          <ComplianceBar />
        </div>
      </div>

      {/* 详情 pane（总览段数观测钩子的归属是**地图 canvas**（NavMap），此处不重复挂 ⇒ 免 QA 选择器歧义） */}
      <div className="route-sheet__pane" data-pane="detail" aria-hidden={pane !== "detail"}>
        <div className="route-sheet__scroll">
          {detail && (
            <RouteDetailPane
              card={detail.card}
              colors={colors}
              destLabel={detail.destLabel}
              odLabel={odLabel}
              fav={fav ? { from: fav.from, to: fav.to, query } : null}
              degraded={detail.degraded}
              phase={detail.phase === "idle" ? "loading" : detail.phase}
              body={detail.body}
              reload={detail.reload}
            />
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

/** 档位列表（供调用方循环/校验；值即 DETENTS） */
export { DETENTS, detentIndex };
