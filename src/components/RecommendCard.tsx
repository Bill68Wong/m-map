"use client";

/**
 * 实时路线推荐 · 路线大卡片（src/components/RecommendCard.tsx）
 *
 * ── ★★ v2.4.1 按用户逐字规范重构（2026-09-21）─────────────────────────
 * 卡面内容**只有**以下这些，不多不少：
 *
 *   ┌ 左上「XX 分」 预计 XX:XX 到达 ────────────────── 右上「线路标签」┐
 *   │  步行图标   步行 N 分（需較常速快 X 分）                        │
 *   │  巴士站图标 上车 · 站点编号名称                                │
 *   │     ↳ 附属行：还有 N 站 · 约 X~Y 分            [档位标签]      │
 *   │  线路标签 A/B → C            上车到下车总时长 X 分             │
 *   │  巴士站图标 下车 · 站点编号名称                                │
 *   │  步行图标   步行 N 分 → 目的地                                 │
 *   │  （其后小字）[线路标签] 后续班车还有 N 站      [档位]           │
 *   └────────────────────────────────────────────────────────────┘
 *
 * ── 本次删除的内容（用户明确要求，**勿加回**）──────────────────────────
 *   · 右上**来源标注**（`.rc-badge-local`「本地补充」）—— 「不再标注方案来源」；
 *   · 右上**绿色圆点**（`rc--dev` 开发者模式标记）—— 「删除右上角的绿色圆点」；
 *   · 底部**「点击看详情」+ 附加动作槽**（`.rc-foot`）—— 「移除底部按钮以缩短长度」；
 *   · 上车行里重复的**「（行车 X 分）」**—— 与下方「线路标签」行的总时长重复。
 *   ⇒ `origin` / `devMode` 两个 prop 随之**整体移除**（连带调用方 `RecommendCards`）。
 *
 * ── 关键口径（改动时务必保持）──────────────────────────────────────────
 *   · **上车站**取**首段**（`rides[0]`）；**下车站**取**末段**（`rides[last]`）——
 *     旧版两处都取首段 ⇒ 换乘路线会把「换乘站」当「下车站」显示；
 *   · **「上车到下车」总时长**含**换乘步行**与**中间段等车**（用户口径），
 *     不等于 `Σ rides[minutes]`；
 *   · 末段步行终点 `walkIn.toLabel` 由 `model.ts` 保证是**目的地**（v2.4.1 修复）；
 *   · 乘车时长取值规约见 `types.ts:416`（轻轨固定秒级线用 `rideSecText`，其余取整）。
 *
 * ── 沿用（不动）───────────────────────────────────────────────────────
 *   · 整卡可点 → 进详情页（`usePressGuard` 区分滚动与点击）；
 *   · 入场错峰 `delayMs`；`cardAction` 仍受支持（组合页用它挂「当下最快 / 已保存」角标），
 *     但已从底部槽**移到头部**（底部整条已删除）。
 */
import { useRouter } from "next/navigation";
import { LrtEtaInline } from "./LrtEta";
import RouteStack from "./RouteStack";
import { EtaText, macauClock, Row, TierBadge } from "./RoutePieces";
import { buildCardHref } from "@/lib/recommend/card-link";
import { usePressGuard } from "@/lib/use-press-guard";
import type { RecommendCard as CardData, SchoolZone } from "@/lib/recommend/types";

export default function RecommendCard({
  card,
  colors,
  zone,
  rank,
  fromSlug,
  toSlug,
  delayMs,
  hrefOverride,
  cardAction,
  onCardOpen,
}: {
  card: CardData;
  /** 线路码 → 主题色（服务端下发） */
  colors: Record<string, string>;
  /** 澳门科技大学座区 */
  zone: SchoolZone | null;
  /** 名次（1 起） */
  rank: number;
  fromSlug: string;
  toSlug: string;
  /** ★ v1.1.8：入场错峰（列表按 i*40ms 传入） */
  delayMs?: number;
  /** ★ v1.3.0（全澳导航）：**覆盖点击跳转目标**（如 `/nav/detail?...`）。传了则不再走旧 `buildCardHref`。 */
  hrefOverride?: string;
  /**
   * 头部附加角标（组合页用：「当下最快」「已保存」）；**不传则卡面只有标准内容**。
   * ★ v2.4.1：从底部动作槽移到头部 —— 底部整条已按用户要求删除。
   */
  cardAction?: React.ReactNode;
  /**
   * ★ 2026-09-23：**打开全屏详情弹窗**（主页「出发」推荐层 / 收藏组合页传入）。
   *   传了则**优先于 `hrefOverride` 与默认跳转** —— 点击不再整页导航
   *   （消除页面加载卡顿，也避免「跨链路 planId 匹配错卡」）。
   */
  onCardOpen?: () => void;
}) {
  const router = useRouter();
  /** ★ v1.1.8：整卡可点 + 列表要滚动 → 位移 >8px 或长按 >700ms 判为滚动，不触发跳转 */
  const press = usePressGuard();
  const colorOf = (c: string) => colors[c] ?? null;
  const first = card.rides[0];
  /** ★ v2.4.1：下车站取**末段**（旧版取首段 ⇒ 换乘路线把换乘站当下车站显示） */
  const last = card.rides[card.rides.length - 1];
  const hasAlts = (card.altBuses?.length ?? 0) > 0;
  /**
   * ★ B2：线路标签的**分段结构** —— 每段 = 该段主干线 + 段内并行线（`parallelRoutes`）。
   * 段内并列 = 「空白斜间隙」分隔、段间换乘 = 箭头 `→`（03 §G · v2.4.1 修订）。
   */
  const routeSegments = card.rides.map((r) => ({ codes: [r.route, ...(r.parallelRoutes ?? [])] }));

  /**
   * ★ v2.4.1：「上车到下车」总时长 —— **含换乘步行与中间段等车**（用户口径）。
   *   = Σ 各段乘车 + Σ 换乘步行 + Σ(第 2 段起的等车)
   *   首段等车**不计**：本行起点是「上车」，首段等车发生在**上车之前**。
   */
  const rideSpanMin = Math.round(
    card.rides.reduce((s, r) => s + r.minutes, 0) +
      card.transfers.reduce((s, t) => s + t.minutes, 0) +
      card.rides.slice(1).reduce((s, r) => s + r.waitMin, 0),
  );

  function onClick() {
    if (press.isGuarded()) return;
    if (!first) return;
    // ★ 2026-09-23：优先「全屏详情弹窗」—— 传了 onCardOpen 就不做整页导航
    if (onCardOpen) {
      onCardOpen();
      return;
    }
    if (hrefOverride) {
      router.push(hrefOverride);
      return;
    }
    router.push(
      buildCardHref({
        from: fromSlug,
        to: toSlug,
        zone,
        plan: card.planId,
        route: first.route,
        board: first.board,
        alight: first.alight,
        rank,
      }),
    );
  }

  return (
    <div
      className="card rc anim-fade-up"
      role="button"
      tabIndex={0}
      onPointerDown={press.onPointerDown}
      onPointerMove={press.onPointerMove}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={delayMs ? { animationDelay: `${delayMs}ms` } : undefined}
      aria-label={`第 ${rank} 名，全程 ${Math.round(card.totalMin)} 分钟，预计 ${macauClock(card.arriveAt)} 到达`}
    >
      {/* ── 头部：左上总用时 · 到达时刻 ／ 右上线路标签 ──
          ★ v2.4.1：已删除来源标注与开发者绿点（用户要求「不再标注方案来源」「删除绿色圆点」）*/}
      <div className="rc-head">
        <div className="rc-head__main">
          <span className="rc-total">{Math.round(card.totalMin)}</span>
          <span className="rc-total__unit">分</span>
        </div>
        <span className="rc-arrive">
          预计 <b>{macauClock(card.arriveAt)}</b> 到达
          {card.crossBorder && <span className="rc-warn"> · 不含通关</span>}
        </span>
        {cardAction}
        <RouteStack segments={routeSegments} colorOf={colorOf} size="sm" />
      </div>

      {/* ── 时间线 ── */}
      <div className="rc-line">
        {/* ① 步行：出发地 → 上车站。括号内 = 要比常速快多少才赶得上（档 3 时为空） */}
        <Row
          dot="walk"
          main={
            <>
              步行{" "}
              <b className={card.walkOut.estimated ? "rc-val--est" : undefined}>{card.walkOut.minutes}</b> 分
              {first?.tierHint && <span className="rc-sub">（{first.tierHint}）</span>}
            </>
          }
        />

        {/* ② 上车站 */}
        {first && <Row dot="wait" main={<span className="rc-board">上车 · {first.boardLabel}</span>} />}

        {/* ③ 附属行（属于 ②）：实时报站 + 赶车分档
            ★ v2.4.1：改用 `dot="sub"` —— 它是**上车站的附属信息**，不再单给一个巴士站图标 */}
        {first && (first.waitMin > 0 || first.liveText || !!first.liveDepartures?.length) && (
          <Row
            dot="sub"
            main={
              first.kind === "lrt" && first.liveDepartures?.length ? (
                /* ★ v1.0.6：轻轨首段的倒计时**只此一份**，由客户端每秒重算 */
                <LrtEtaInline
                  lineCode={first.route}
                  departuresMs={first.liveDepartures}
                  clocks={first.liveClocks}
                  state="running"
                  directionName={null}
                />
              ) : (
                <EtaText text={first.liveText || `等 ${first.waitMin} 分`} />
              )
            }
            aside={first.tierText ? <TierBadge tier={first.tier} tierText={first.tierText} /> : null}
          />
        )}

        {/* ④ 线路标签 + 上车到下车总时长（含换乘步行与中间段等车） */}
        <Row
          dot="ride"
          main={
            <>
              <RouteStack segments={routeSegments} colorOf={colorOf} size="sm" />
              <b>{rideSpanMin}</b> 分
            </>
          }
        />

        {/* ⑤ 下车站（**末段**；换乘路线这里才是真正的终点站） */}
        {last && <Row dot="wait" main={<span className="rc-board">下车 · {last.alightLabel}</span>} />}

        {/* ⑥ 步行：下车站 → **目的地**（`walkIn.toLabel` 已是目的地名，v2.4.1 修复） */}
        <Row
          dot="walk"
          last
          main={
            <>
              步行{" "}
              <b className={card.walkIn.estimated ? "rc-val--est" : undefined}>{card.walkIn.minutes}</b> 分
              {" → "}
              {card.walkIn.toLabel}
            </>
          }
        />
      </div>

      {/* ⑦ 后续班次（小字；紧接「步行 → 目的地」下方，不参与时间线竖线） */}
      {hasAlts && (
        <div className="rc-altrows">
          {card.altBuses!.map((a, k) => (
            <div className="rc-altrow" key={`${a.route}-${a.stopsAway}-${k}`}>
              <span className="rc-altrow__left">
                <RouteStack codes={[a.route]} colors={colors} size="sm" />
                <span>
                  后续班车还有 <b>{a.stopsAway}</b> 站
                </span>
              </span>
              <span className="rc-altrow__right">
                <span className={`rc-tier rc-tier--${a.tier}`}>{a.tierText}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
