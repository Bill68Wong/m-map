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
import { useEffect, useRef, useState, type ReactNode } from "react";
import Icon from "@/components/ui/Icon";
import ComplianceBar from "@/components/nav/ComplianceBar";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import RouteStack from "@/components/RouteStack";
import { macauClock } from "@/components/RoutePieces";
import BottomSheet from "./BottomSheet";
import NavAlarmOverlay from "./NavAlarmOverlay";
import NavTrackBar from "./NavTrackBar";
import RouteDetailPane from "./RouteDetailPane";
import RouteResultPane from "./RouteResultPane";
import { useRecommend, type PrefMode } from "./useRecommend";
import { useSnapSheet } from "./useSnapSheet";
import type { DetailBody } from "./useDetailBody";
import type { RideTrackView } from "./useRideTracking";
import type { WalkNavRequest } from "./walk-nav";
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
  /** ★ 2026-09-24：导航追踪态（宿主注入；缺省 = 静态详情） */
  track?: RideTrackView | null;
  /** ★ 目的地坐标（可切换方案查询用） */
  destCoord?: { lng: number; lat: number } | null;
  /** ★ 点「切过去」→ 打开新方案导航 */
  onSwitchCard?: (card: RecommendCard, degraded: boolean) => void;
  /** ★ 2026-10-29：出发地坐标/名称（首段步行导航用；GCJ-02） */
  originCoord?: { lng: number; lat: number } | null;
  originLabel?: string;
  /** ★ 2026-10-29：点「步行导航」→ 宿主查询 + 地图画线 */
  onWalkNav?: (req: Omit<WalkNavRequest, "id">) => void;
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
  /** ★ 2026-09-25：全屏化（导航中隐藏底导、收敛间距） */
  immersive?: boolean;
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
  immersive = false,
}: RouteSheetProps) {
  // 推荐列表数据（列表 pane 常驻；同一 query + prefs 只自动拉一次）
  /** ★ 本批（需求⑧ / AC-52/53）：三档偏好（默认综合） */
  const [pref, setPref] = useState<PrefMode>("balanced");
  /** ★ v3.3.0（AC-105）：轻轨优先开关（与三档**正交**的独立布尔；同一行右侧） */
  const [lrtFirst, setLrtFirst] = useState(false);
  const rec = useRecommend(query, open && pane === "recommend", pref, lrtFirst);

  /* ── ★ 本批：详情吸底操作条（`.nav-actions` 移出滚动容器 → 挂面板根）所需派生值 ── */
  const dTrack = detail?.track ?? null;
  const dStrips = detail?.body?.strips ?? null;
  const dLegIdx = dTrack?.legIndex ?? 0;
  const dLegRide = detail?.card.rides[dLegIdx] ?? null;
  const dFirst = detail?.card.rides[0] ?? null;
  const dTrackStops = dStrips?.[dLegIdx]?.stops ?? [];
  const dRouteLabel = dLegRide
    ? dLegRide.kind === "lrt"
      ? `轻轨 ${dLegRide.route.replace(/^LRT-/, "")}`
      : `${dLegRide.route} 路`
    : "";
  const dLrt = dLegRide?.kind === "lrt";
  /** 新鲜度（AC-24）：每秒重算「上次更新：N 秒前」 */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (dTrack?.phase !== "riding") return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [dTrack?.phase]);
  const dFreshSec =
    dTrack && dTrack.lastUpdateTs > 0 ? Math.max(0, Math.floor((nowMs - dTrack.lastUpdateTs) / 1000)) : null;

  /** 详情吸底操作条（挂面板根 `.route-sheet__actions-slot`） */
  const detailActions: ReactNode =
    pane === "detail" && detail && dTrack ? (
      <NavTrackBar
        phase={dTrack.phase}
        routeLabel={dRouteLabel}
        boardLabel={dLegRide?.boardLabel ?? dFirst?.boardLabel ?? ""}
        alightLabel={
          (dTrackStops.length ? dTrackStops[dTrackStops.length - 1].label : "") ||
          dLegRide?.alightLabel ||
          dFirst?.alightLabel ||
          ""
        }
        plate={dTrack.plate}
        source={dTrack.progressSource === "gps" ? "gps" : dTrack.plate ? "vehicle" : "manual"}
        alarm={dTrack.alarm}
        lrt={dLrt}
        traveling={dTrack.traveling}
        anomaly={dTrack.anomaly}
        note={dTrack.note}
        freshSec={dFreshSec}
        justAlighted={dTrack.justAlighted}
        onStart={dTrack.onStart}
        onBoard={dTrack.onBoard}
        onAlight={dTrack.onAlight}
        onRepick={dTrack.onNotThisBus}
        onRefresh={dTrack.onRefresh}
        onStop={dTrack.onStop}
        onNotBoard={dTrack.onNotBoard}
        onNotArrive={dTrack.onNotArrive}
      />
    ) : null;

  /**
   * ★ v3.2.0（需求 12 / AC-86/87/88）：头部按钮重构 —— **左上双态 + 右上情境化刷新**。
   *   · 左上（两 pane 均渲染）：`recommend` ⇒ 关闭面板；`detail`/`riding` ⇒ 返回推荐列表；同调 `onContextClose()`。
   *   · 右上：`recommend` ⇒ 重查推荐；`detail`/`riding` ⇒ 刷新巴士数据；busy 自旋 + `aria-disabled`。
   *   ⚠️ 用 `aria-disabled`（非原生 disabled）：本栏是**拖动把手**，原生 disabled 按钮会**吞掉 pointerdown**
   *      ⇒ 在把手区形成死区、破坏拖拽；`aria-disabled` + 点击守卫即可防重复点击且保留无障碍语义。
   */
  const refreshBusy = pane === "recommend" ? rec.phase === "loading" : detail?.phase === "loading";
  const onRefreshClick = () => {
    if (refreshBusy) return;
    if (pane === "recommend") rec.reload();
    else if (detail?.track?.onRefresh) detail.track.onRefresh();
    else detail?.reload?.();
  };

  /**
   * ★ 2026-09-25：`.route-sheet` 根 ref —— 供 `useSnapSheet` 拖动期**命令式**写 `--sheet-y-anim`
   *   （不逐帧 `setState` ⇒ 不再占满主线程 ⇒ 地图渲染循环不被饿死，「拖动时地图抖动」落定）。
   */
  const sheetRef = useRef<HTMLElement | null>(null);

  const snap = useSnapSheet({
    open,
    detent,
    topsPx,
    sheetRef,
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
      sectionRef={sheetRef}
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
      pref={pref}
      actions={detailActions}
      bar={
        <>
          {/* 左上（双态 · 两 pane 均渲染）：recommend ⇒ 关闭面板；detail/riding ⇒ 返回推荐列表。
              aria-label / title 随 pane 切换（读屏正确性；AC-86）。 */}
          <button
            type="button"
            className="route-sheet__iconbtn"
            onClick={onContextClose}
            aria-label={pane === "recommend" ? "关闭面板" : "返回推荐列表"}
            title={pane === "recommend" ? "关闭面板" : "返回推荐列表"}
          >
            <Icon name="back" size={20} />
          </button>
          <span className="route-sheet__od t-label">{odLabel}</span>
          {/* 收藏（仅 recommend 栏；位于刷新按钮左侧） */}
          {/* ★ v3.3.0（AC-115）：推荐弹窗顶部「收藏组合」chip（图标 + 文字，与起终点页**同一常量**） */}
          {pane === "recommend" && fav && <FavoriteButton from={fav.from} to={fav.to} />}
          {/* 右上：情境化刷新（AC-87）——recommend 重查推荐 / detail·riding 刷新巴士数据；busy 自旋 */}
          <button
            type="button"
            className={`route-sheet__iconbtn${refreshBusy ? " is-spin" : ""}`}
            data-refresh-scope={pane === "recommend" ? "recommend" : "detail"}
            onClick={onRefreshClick}
            aria-disabled={refreshBusy || undefined}
            aria-busy={refreshBusy || undefined}
            aria-label={
              refreshBusy ? "刷新中" : pane === "recommend" ? "刷新路线推荐" : "刷新巴士数据"
            }
            title={refreshBusy ? "刷新中" : pane === "recommend" ? "刷新路线推荐" : "刷新巴士数据"}
          >
            <Icon name="refresh" size={20} />
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
          {/* ★ 本批（需求⑧ / AC-52/53）：三档偏好（唯一入口 = 推荐列表顶部）
              ★ v3.3.0（AC-105）：轻轨优先开关与三档**同一行右侧**（独立布尔，与排序正交） */}
          <PrefSwitch
            value={pref}
            onChange={setPref}
            lrtFirst={lrtFirst}
            onLrtFirst={setLrtFirst}
          />
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
        {/* ★ 本批（需求③）：自动上车 toast / 自动下车瞬态 —— 浮层（滚动容器之外）；
            ★ v3.2.0（需求 8）：**下车横幅已迁出**（页面级 `.nav-alarm--top`，由 NavShell 承载）。 */}
        {detail && <NavAlarmOverlay track={detail.track ?? null} />}
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
              track={detail.track ?? null}
              destCoord={detail.destCoord ?? null}
              onSwitchCard={detail.onSwitchCard}
              immersive={immersive}
              originCoord={detail.originCoord ?? null}
              originLabel={detail.originLabel ?? "我的位置"}
              onWalkNav={detail.onWalkNav}
            />
          )}
        </div>
      </div>
    </BottomSheet>
  );
}

/** 档位列表（供调用方循环/校验；值即 DETENTS） */
export { DETENTS, detentIndex };

/* ── ★ 本批（需求⑧ / AC-52/53）：三档偏好 segment（唯一入口 = 推荐列表顶部）──
   图标 = **内联线性 SVG**（16px / stroke 2 / currentColor，与 Tabler 同描边风格；无 emoji）。
   ⚠️ v3.1.1 #5：解释行**禁用开发术语**（不得出现 cost / 权重 / 系数 / 参数名等代码语）。 */
const PREF_OPTS: { value: PrefMode; label: string; icon: ReactNode }[] = [
  {
    value: "balanced",
    label: "推荐",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3.5l2.6 5.27 5.9.86-4.25 4.14 1 5.86L12 16.9l-5.25 2.73 1-5.86L3.5 9.63l5.9-.86z" />
      </svg>
    ),
  },
  {
    value: "fewer_transfers",
    label: "少换乘",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 8h13l-3-3" />
        <path d="M20 16H7l3 3" />
      </svg>
    ),
  },
  {
    value: "less_walk",
    label: "少步行",
    icon: (
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M13 4.5a1 1 0 1 0 1.4 1.4A1 1 0 0 0 13 4.5z" />
        <path d="M8 21l2.6-3.6" />
        <path d="M17 21l-2.3-3.6-2.7-1.9.6-3.5" />
        <path d="M11 11.6L13 9l2.6.7 2.1 2" />
        <path d="M13 9l-2.4-2.3H8" />
      </svg>
    ),
  },
];

const PREF_HINT: Record<PrefMode, ReactNode> = {
  balanced: (
    <>
      排序依据：<b>用时</b> · 换乘 · 步行
    </>
  ),
  fewer_transfers: (
    <>
      排序依据：优先看 <b>换乘次数</b>，再看用时
    </>
  ),
  less_walk: (
    <>
      排序依据：优先看 <b>步行总量</b>，再看用时
    </>
  ),
};

/**
 * 路线偏好三档 + ★ v3.3.0（AC-105）轻轨优先开关。
 * 布局（03 §5 修订 4）：**三档与开关同一行横排** —— 三档 `flex:1 1 0`（`nowrap` 不折行），
 * 开关 `flex:none` 固定在右侧；说明行（既有）不动。
 * 开关语义 = `role="switch"` + `aria-checked`（独立布尔，非第四档）；点标签文字也可切换。
 */
function PrefSwitch({
  value,
  onChange,
  lrtFirst,
  onLrtFirst,
}: {
  value: PrefMode;
  onChange: (v: PrefMode) => void;
  lrtFirst: boolean;
  onLrtFirst: (v: boolean) => void;
}) {
  return (
    <div className="pref-switch">
      <div className="pref-switch__row">
        <div className="pref-switch__seg" role="group" aria-label="路线偏好">
          {PREF_OPTS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`pref-switch__opt${value === o.value ? " is-on" : ""}`}
              aria-pressed={value === o.value}
              onClick={() => onChange(o.value)}
            >
              {o.icon}
              <span>{o.label}</span>
            </button>
          ))}
        </div>
        {/* 轻轨优先（开关）—— 开：轨道 `--accent` + 旋钮左移；双通道（非仅靠颜色） */}
        <button
          type="button"
          className="lrt-switch"
          role="switch"
          aria-checked={lrtFirst}
          aria-label="轻轨优先"
          onClick={() => onLrtFirst(!lrtFirst)}
        >
          <span className="lrt-switch__label">轻轨优先</span>
          <span className="lrt-switch__track" aria-hidden="true">
            <span className="lrt-switch__knob" />
          </span>
        </button>
      </div>
      <p className="pref-switch__hint">{PREF_HINT[value]}</p>
    </div>
  );
}
