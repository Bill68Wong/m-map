"use client";

/**
 * 分步搜索弹层（src/components/nav/StepSheet.tsx，M Map 改版 S2）
 *
 * ── 分步引导（设计 D.3 / PRD §8 状态机）───────────────────────────────
 *   ① 选目的地（S0） → ② 地图标定（S1 进入标志） → ③ 选出发地（S1） → ④ 出发（S2）
 *   · 顶部 4 圆点细进度轨（当前步实心 + 强调色，其余空心）；**不做编号**（避开 `01/02` AI 脚手架味）；
 *   · **每步只有 1 个主动作**，其余收进左上角返回箭头；
 *   · 弹层落在**拇指区**（屏幕下 1/3），列表独立滚动（`touch-action: pan-y`，不与地图抢手势）。
 *
 * ⚠️ 文案一律**简体**（站名/线路名才用繁体）。
 */
import Icon from "@/components/ui/Icon";
import PoiSearchBox from "./PoiSearchBox";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import { endpointOf, type FavoriteEndpoint, type PlaceFavorite } from "@/lib/favorites/types";
import type { NavPoint } from "@/lib/nav/types";

export interface StepSheetProps {
  /** 当前步 1~4 */
  step: 1 | 2 | 3 | 4;
  dest: NavPoint | null;
  from: NavPoint | null;
  userPos: { lng: number; lat: number } | null;
  colors: Record<string, string>;
  /** 常用地点对（收藏页地点对，取最近 3 条） */
  quickPairs: PlaceFavorite[];
  onPickDest: (p: NavPoint) => void;
  onClearDest: () => void;
  onPickFrom: (p: NavPoint) => void;
  onUseMyLocation: () => void;
  /** 第 2 步「用这个点」（读地图中心） */
  onUseMapCenter: () => void;
  onBack: () => void;
  onGo: () => void;
  going: boolean;
  canGo: boolean;
}

const STEP_LABEL: Record<1 | 2 | 3 | 4, string> = {
  1: "选目的地",
  2: "确认位置",
  3: "选出发地",
  4: "出发",
};

/** 端点 → NavPoint（同构；仅取导航所需字段） */
function toNavPoint(e: FavoriteEndpoint): NavPoint {
  const p: NavPoint = { kind: e.kind, label: e.label, lng: e.lng, lat: e.lat };
  if (e.code) p.code = e.code;
  if (e.poiId) p.poiId = e.poiId;
  if (e.adcode) p.adcode = e.adcode;
  return p;
}

export default function StepSheet({
  step,
  dest,
  from,
  userPos,
  colors,
  quickPairs,
  onPickDest,
  onClearDest,
  onPickFrom,
  onUseMyLocation,
  onUseMapCenter,
  onBack,
  onGo,
  going,
  canGo,
}: StepSheetProps) {
  const myLocation: NavPoint | null = userPos
    ? { kind: "gps", label: "我的位置", lng: userPos.lng, lat: userPos.lat }
    : null;
  const effectiveFrom = from ?? myLocation;

  return (
    <section className="step-sheet" aria-label={`规划路线 · ${STEP_LABEL[step]}`}>
      <div className="step-sheet__grip" aria-hidden="true" />

      <div className="step-sheet__head">
        {step > 1 && (
          <button type="button" className="step-sheet__back" onClick={onBack} aria-label="返回上一步">
            <Icon name="back" size={20} />
          </button>
        )}
        <span className="step-sheet__title">{STEP_LABEL[step]}</span>
        <ol className="step-dots" aria-hidden="true">
          {[1, 2, 3, 4].map((s) => (
            <li key={s} className={`step-dots__dot${s <= step ? " is-on" : ""}`} />
          ))}
        </ol>
      </div>

      <div className="step-sheet__body">
        {/* ① 选目的地（S0：**只有目的地框**） */}
        {step === 1 && (
          <>
            <PoiSearchBox
              label="目的地"
              value={dest}
              onChange={onPickDest}
              userPos={userPos}
              colors={colors}
              placeholder="去哪儿？"
            />
            {quickPairs.length > 0 && (
              <div className="step-sheet__quick">
                <p className="step-sheet__quick-title t-label">常用</p>
                {quickPairs.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="step-sheet__quick-row"
                    onClick={() => {
                      onPickFrom(toNavPoint(f.from));
                      onPickDest(toNavPoint(f.to));
                    }}
                  >
                    <Icon name="origin" size={16} />
                    <span className="step-sheet__quick-from">{f.from.label}</span>
                    <Icon name="arrowRight" size={16} />
                    <Icon name="destination" size={16} />
                    <span className="step-sheet__quick-to">{f.to.label}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="step-sheet__hint t-label t-muted">
              也可以直接点地图上的巴士站 / 地点，同样进入下一步。
            </p>
          </>
        )}

        {/* ② 地图标定（S1 的进入标志） */}
        {step === 2 && (
          <>
            <p className="step-sheet__lead">把地图挪一挪，让准星对准要去的地方</p>
            <div className="step-sheet__pin-preview">
              <Icon name="destination" size={20} />
              <span>{dest?.label ?? "未选择"}</span>
            </div>
            <button type="button" className="btn btn--primary btn--block" onClick={onUseMapCenter}>
              用这个点
            </button>
            <button type="button" className="btn btn--text btn--block" onClick={onClearDest}>
              换目的地
            </button>
          </>
        )}

        {/* ③ 选出发地（S1） */}
        {step === 3 && (
          <>
            <div className="step-sheet__dest-bar">
              <Icon name="destination" size={16} />
              <span className="step-sheet__dest-name">{dest?.label}</span>
              <button type="button" className="btn btn--text btn--sm" onClick={onClearDest}>
                换目的地
              </button>
            </div>
            <PoiSearchBox
              label="出发地"
              value={effectiveFrom}
              onChange={onPickFrom}
              userPos={userPos}
              colors={colors}
              placeholder={userPos ? "我的位置" : "输入出发地"}
            />
            {userPos ? (
              <button type="button" className="btn btn--outline btn--block btn--sm" onClick={onUseMyLocation}>
                <Icon name="locate" size={16} />
                使用我的位置
              </button>
            ) : (
              <p className="step-sheet__hint t-label t-muted">定位没成功，手动挑个出发点吧</p>
            )}
          </>
        )}

        {/* ④ 出发（S2） */}
        {step === 4 && (
          <>
            <div className="step-sheet__od">
              <span className="step-sheet__od-from">{effectiveFrom?.label}</span>
              <Icon name="arrowRight" size={16} />
              <span className="step-sheet__od-to">{dest?.label}</span>
            </div>
            <div className="step-sheet__actions">
              <button
                type="button"
                className="btn btn--primary btn--block btn--lg"
                disabled={!canGo || going}
                onClick={onGo}
              >
                {going ? "正在规划…" : "出发"}
              </button>
              {effectiveFrom && dest && (
                <FavoriteButton
                  kind="place"
                  entry="home"
                  from={endpointOf(effectiveFrom)}
                  to={endpointOf(dest)}
                  query={queryOf(effectiveFrom, dest)}
                  withLabel
                  className="fav-btn--block"
                />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** 规范化查询串（与 `parseNavParams().query` **逐字节一致**的口径） */
export function queryOf(from: NavPoint, to: NavPoint): string {
  const sp = new URLSearchParams({
    fromLng: String(from.lng),
    fromLat: String(from.lat),
    toLng: String(to.lng),
    toLat: String(to.lat),
    fromLabel: from.label,
    toLabel: to.label,
    fromKind: from.kind,
    toKind: to.kind,
  });
  if (from.code) sp.set("fromCode", from.code);
  if (to.code) sp.set("toCode", to.code);
  return sp.toString();
}
