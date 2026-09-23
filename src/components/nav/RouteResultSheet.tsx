"use client";

/**
 * 全屏路线推荐弹窗（src/components/nav/RouteResultSheet.tsx，2026-09-23 新增）
 *
 * ── 定位 ──────────────────────────────────────────────────────────────
 *   主页「出发」**不再整页跳 `/nav`** —— 在本页弹出全屏推荐层（与「搜索弹窗 / 选线弹窗」
 *   同一种覆盖层形态）。收益：
 *     · 不整页加载（省掉 HTML / RSC / JS 导航等待 ⇒ 消除卡顿）；
 *     · 点卡片 → `RouteDetailSheet`（全屏详情弹窗），同样不跳页。
 *
 * ── 数据与生命周期 ────────────────────────────────────────────────────
 *   · `GET /api/nav?<query>`（与 `/nav` 页面同一接口 / 同一口径）；
 *   · **常驻挂载**（由 `open` 控制显示）：关闭后再开**保留上次结果**，不重新等待；
 *     换目的地（`query` 变化）或点「刷新」才重新拉取。
 *
 * ⚠️ 挂载位置：必须在 `.nav-map-wrap` **之外**（层叠上下文会压住弹窗，Spec AC-13）。
 * ⚠️ `/nav` 页面保留（直链 / 刷新 / 分享不受影响）——本弹窗只是主页的入口形态。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ComplianceBar from "@/components/nav/ComplianceBar";
import Icon from "@/components/ui/Icon";
import RecommendCards from "@/components/RecommendCards";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import type { FavoriteEndpoint } from "@/lib/favorites/types";
import type { RecommendCard } from "@/lib/recommend/types";

export interface RouteResultSheetProps {
  /** 是否打开（常驻挂载：关闭后保留数据，再次打开不重新等待） */
  open: boolean;
  /** 规范查询串（`/api/nav` 的 query；替换目的地后变化 → 重新拉取） */
  query: string;
  /** 顶部 OD 文案 */
  odLabel: string;
  /** 收藏入口数据（地点对；不传则不渲染收藏按钮） */
  fav?: { from: FavoriteEndpoint; to: FavoriteEndpoint } | null;
  onClose: () => void;
  /** 点卡片 → 打开全屏详情弹窗（`degraded` 随列表透传，详情头部显示「本地推算」徽标） */
  onOpenDetail: (card: RecommendCard, degraded: boolean) => void;
}

/** `/api/nav` 响应（只声明本弹窗消费的字段） */
interface NavResp {
  ok: boolean;
  error?: string;
  cards?: RecommendCard[];
  colors?: Record<string, string>;
  degraded?: boolean;
  emptyReason?: string | null;
  nearbyWalkMin?: number | null;
  excluded?: string[];
  missed?: string[];
  fromSlug?: string;
  toSlug?: string;
}

/** 本弹窗持有的结果数据 */
interface SheetData {
  cards: RecommendCard[];
  colors: Record<string, string>;
  degraded: boolean;
  emptyReason: string | null;
  nearbyWalkMin: number | null;
  excluded: string[];
  missed: string[];
  fromSlug: string;
  toSlug: string;
}

/** 空状态文案（与 `/nav` 页 `NavResultClient` 同口径） */
const EMPTY_TEXT: Record<string, { title: string; body: string }> = {
  too_close: { title: "距离很近", body: "起点与目的地很近，建议直接步行前往。" },
  no_live: { title: "暂时没有可用的班次", body: "这个时段通往该方向的线路大多已收班，或暂时没有在途车辆。" },
  no_candidate: { title: "找不到可用路线", body: "试试更近的车站，或换一个目的地。" },
  amap_unavailable: { title: "路网数据暂时不可用", body: "本地也没能算出可用路线。请稍后重试。" },
};

export default function RouteResultSheet({
  open,
  query,
  odLabel,
  fav = null,
  onClose,
  onOpenDetail,
}: RouteResultSheetProps) {
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [data, setData] = useState<SheetData | null>(null);
  const [err, setErr] = useState("");
  /** 已发起过加载的 query（防止同一 query 反复自动重拉；失败后由「重试」手动触发） */
  const loadedQueryRef = useRef<string | null>(null);
  /** 并发保护：只认最后一次请求的结果 */
  const reqIdRef = useRef(0);

  const load = useCallback(async () => {
    const id = ++reqIdRef.current;
    loadedQueryRef.current = query; // 先标记，避免 effect 重复触发
    setPhase("loading");
    setErr("");
    try {
      const res = await fetch(`/api/nav?${query}`, { cache: "no-store" });
      const j = (await res.json()) as NavResp;
      if (id !== reqIdRef.current) return;
      if (!j.ok) throw new Error(j.error ?? "加载失败");
      setData({
        cards: j.cards ?? [],
        colors: j.colors ?? {},
        degraded: !!j.degraded,
        emptyReason: j.emptyReason ?? null,
        nearbyWalkMin: j.nearbyWalkMin ?? null,
        excluded: j.excluded ?? [],
        missed: j.missed ?? [],
        fromSlug: j.fromSlug ?? "",
        toSlug: j.toSlug ?? "",
      });
      setPhase("ready");
    } catch (e) {
      if (id !== reqIdRef.current) return;
      setErr((e as Error).message || "加载失败，请稍后再试");
      setPhase("failed");
    }
  }, [query]);

  // 打开时（含首次）拉取；同一 query 只自动拉一次（关闭再开 = 秒显上次结果）
  useEffect(() => {
    if (!open) return;
    if (loadedQueryRef.current === query) return;
    void load();
  }, [open, query, load]);

  const empty =
    data && data.cards.length === 0 ? EMPTY_TEXT[data.emptyReason ?? "no_candidate"] : null;

  return (
    <div
      className={`result-sheet${open ? " result-sheet--open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label={`路线推荐 ${odLabel}`}
      aria-hidden={!open}
    >
      <div className="result-sheet__bar">
        <button type="button" className="btn btn--text btn--sm" onClick={onClose} aria-label="返回">
          <Icon name="back" size={20} />
          返回
        </button>
        <span className="result-sheet__od t-label">{odLabel}</span>
        <button
          type="button"
          className="btn btn--text btn--sm"
          onClick={() => void load()}
          disabled={phase === "loading"}
          aria-label="刷新路线结果"
        >
          {phase === "loading" ? "刷新中…" : "刷新"}
        </button>
        {/* ★ 收藏入口 ④（地点对）：与 `/nav` 页顶部 OD 栏同款 */}
        {fav && (
          <FavoriteButton kind="place" entry="odbar" from={fav.from} to={fav.to} query={query} />
        )}
      </div>

      <div className="result-sheet__body">
        {phase === "loading" && <span className="nav-result__progress" aria-hidden="true" />}

        {phase === "failed" && !data && (
          <p className="fav-note fav-note--warn t-label" role="status">
            {err}
            <button type="button" className="btn btn--text btn--sm" onClick={() => void load()}>
              重试
            </button>
          </p>
        )}

        {phase === "loading" && !data && (
          <div className="rc-list" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div className="card rc rc--skeleton" key={i}>
                <span className="rc-sk rc-sk--big" />
                <span className="rc-sk rc-sk--chip" />
                <span className="rc-sk rc-sk--line" />
                <span className="rc-sk rc-sk--line rc-sk--short" />
              </div>
            ))}
          </div>
        )}

        {data && (
          <>
            {data.degraded && (
              <div className="nav-degraded t-label">路网数据暂时不可用，以下为本地推算结果</div>
            )}
            {empty ? (
              <div className="card rc-empty">
                <p className="h-title">{empty.title}</p>
                <p className="t-body t-muted" style={{ marginTop: 6, lineHeight: 1.7 }}>
                  {empty.body}
                </p>
                {data.emptyReason === "too_close" && data.nearbyWalkMin != null && (
                  <p className="t-label t-muted" style={{ marginTop: 8, lineHeight: 1.6 }}>
                    步行约 <b>{data.nearbyWalkMin}</b> 分钟（比等车更快）。
                  </p>
                )}
              </div>
            ) : (
              <RecommendCards
                cards={data.cards}
                colors={data.colors}
                zone={null}
                fromSlug={data.fromSlug}
                toSlug={data.toSlug}
                excluded={data.excluded}
                missed={data.missed}
                onCardOpen={(c) => onOpenDetail(c, data.degraded)}
              />
            )}
          </>
        )}
      </div>

      <ComplianceBar />
    </div>
  );
}
