"use client";

/**
 * 推荐列表 pane（src/components/nav/RouteResultPane.tsx，2026-09-23 新增）
 *
 * 从 `RouteResultSheet` 抽出「列表渲染」，改为 `RouteSheet` 宿主的**常驻子 pane**
 *   （`hidden`/`display` 切换，**不卸载** ⇒ 保留滚动位置，秒回）。
 * 数据由宿主 `useRecommend` 下发（同一份数据供宿主渲染 peek 摘要）。
 */
import RecommendCards from "@/components/RecommendCards";
import type { RecommendCard } from "@/lib/recommend/types";
import type { RecommendData } from "./useRecommend";

/** 空状态文案（与 `/nav` 页同口径） */
const EMPTY_TEXT: Record<string, { title: string; body: string }> = {
  too_close: { title: "距离很近", body: "起点与目的地很近，建议直接步行前往。" },
  no_live: { title: "暂时没有可用的班次", body: "这个时段通往该方向的线路大多已收班，或暂时没有在途车辆。" },
  no_candidate: { title: "找不到可用路线", body: "试试更近的车站，或换一个目的地。" },
  amap_unavailable: { title: "路网数据暂时不可用", body: "本地也没能算出可用路线。请稍后重试。" },
};

export interface RouteResultPaneProps {
  phase: "idle" | "loading" | "ready" | "failed";
  data: RecommendData | null;
  err: string;
  onRetry: () => void;
  onCardOpen: (card: RecommendCard, degraded: boolean) => void;
}

export default function RouteResultPane({ phase, data, err, onRetry, onCardOpen }: RouteResultPaneProps) {
  const empty = data && data.cards.length === 0 ? EMPTY_TEXT[data.emptyReason ?? "no_candidate"] : null;

  return (
    <div className="route-pane route-pane--recommend">
      {phase === "loading" && <span className="nav-result__progress" aria-hidden="true" />}

      {phase === "failed" && !data && (
        <p className="fav-note fav-note--warn t-label" role="status">
          {err}
          <button type="button" className="btn btn--text btn--sm" onClick={onRetry}>
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
              onCardOpen={(c) => onCardOpen(c, data.degraded)}
            />
          )}
        </>
      )}
    </div>
  );
}
