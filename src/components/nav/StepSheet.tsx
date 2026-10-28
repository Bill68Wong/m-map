"use client";

/**
 * 分步搜索弹层（src/components/nav/StepSheet.tsx，M Map 改版 S2；★ 修复包 v2.2.1-B6 弹窗改进）
 *
 * ── 分步引导（设计 D.3 / PRD §8 状态机）───────────────────────────────
 *   ① 选目的地（S0） → ② 地图标定 → ③ 选出发地 → ④ 出发
 *   · 顶部 4 圆点细进度轨（当前步实心 + 强调色）；**不做编号**；
 *   · **每步只有 1 个主动作**，其余收进左上角返回箭头。
 *
 * ── ★ B6 弹窗改进（08 §B，三个用户反馈）──────────────────────────────
 *   1. **位置偏下** → 固定**顶部锚点**（不再由内容决定）：每步不同 ——
 *      ① 14vh · ② 62vh（此步主角是地图，故意收小）· ③ 14vh · ④ 46vh（08 §B.5）；
 *   2. **宽度** → 移动端**近全宽**（左右各 12px 留缝，四角圆角 14）；桌面**居中面板** 440px / top 96px；
 *   3. **难以下拖** → **整层可拖**：只在 **grip + 头部区（y < 56px）**起拖，`|Δx| > |Δy|` 放弃接管，
 *      上界橡皮筋 ×0.35，下拖 >100px 或速度 >0.5px/ms 关闭，吸附到 6vh / 本步默认 / 62vh 三点。
 *      滚动隔离：弹层 `touch-action: none`，**只有内容区滚**（`pan-y` + `overscroll-behavior: contain`）。
 *
 * ⚠️ 文案一律**简体**（站名/线路名才用繁体）。
 * ⚠️ **不重构**分步状态机（步由 `NavShell` 管），本组件只做展示 + 手势。
 */
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import PoiSearchBox from "./PoiSearchBox";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import { endpointOf, type FavoriteEndpoint } from "@/lib/favorites/types";
import type { NavPoint } from "@/lib/nav/types";

/** 每步的**顶部锚点**（vh）—— 08 §B.5：版面节奏跟内容走，而不是一个固定盒子 */
const STEP_TOP_VH: Record<1 | 2 | 3 | 4, number> = { 1: 14, 2: 62, 3: 14, 4: 46 };
/** 吸附点（vh）：展开 / 收起 */
const SNAP_EXPANDED_VH = 6;
const SNAP_COLLAPSED_VH = 62;
/** 起拖区高度（px）：grip + 头部（08 §B.3） */
const HANDLE_H = 56;
/** 关闭阈值：下拖像素 / 速度（px/ms） */
const CLOSE_PX = 100;
const CLOSE_V = 0.5;
/** 上界橡皮筋阻尼（08 §B.3） */
const RUBBER = 0.35;

export interface StepSheetProps {
  /** 当前步 1~4 */
  step: 1 | 2 | 3 | 4;
  dest: NavPoint | null;
  from: NavPoint | null;
  userPos: { lng: number; lat: number } | null;
  colors: Record<string, string>;
  /**
   * 常用地点对（★ S2：来源改为**收藏组合**，取最近 3 条）
   * ⚠️ 用**结构类型**而非 import `Combo`：`Combo` 与本结构兼容（同构子集），
   *    这样 StepSheet 不必依赖收藏模块类型（减少耦合面）。
   */
  quickPairs: { id: string; from: FavoriteEndpoint; to: FavoriteEndpoint }[];
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
  /** ★ B6：收起（下拖超阈值 / Esc）——由 `NavShell` 关闭弹层 */
  onDismiss?: () => void;
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
  onDismiss,
}: StepSheetProps) {
  const myLocation: NavPoint | null = userPos
    ? { kind: "gps", label: "我的位置", lng: userPos.lng, lat: userPos.lat }
    : null;
  const effectiveFrom = from ?? myLocation;

  /** ★ B6：吸附点 = 展开 / 本步默认 / 收起（随步变化） */
  const [snapVh, setSnapVh] = useState<number>(STEP_TOP_VH[step]);
  const [dragPx, setDragPx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ y0: 0, x0: 0, t0: 0, on: false, decided: false });

  // 换步 → 回到该步的默认锚点（08 §B.5 每步高度不同）
  useEffect(() => {
    setSnapVh(STEP_TOP_VH[step]);
    setDragPx(0);
  }, [step]);

  const vhOf = () => (typeof window === "undefined" ? 800 : window.innerHeight);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    // 只在「grip + 头部」区起拖 —— 否则把事件留给列表/输入框（08 §B.3）
    if (e.clientY - rect.top > HANDLE_H) return;
    drag.current = { y0: e.clientY, x0: e.clientX, t0: Date.now(), on: true, decided: false };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d.on) return;
    const dy = e.clientY - d.y0;
    const dx = e.clientX - d.x0;
    if (!d.decided) {
      if (Math.abs(dy) < 6) return; // 位移太小，先不接管
      if (Math.abs(dx) > Math.abs(dy)) {
        d.on = false; // 横向为主 → 放弃接管
        setDragging(false);
        return;
      }
      d.decided = true;
    }
    const px = vhOf() / 100;
    const minDy = -(snapVh - SNAP_EXPANDED_VH) * px;
    const maxDy = (SNAP_COLLAPSED_VH - snapVh) * px;
    let v = dy;
    if (v < minDy) v = minDy + (v - minDy) * RUBBER; // 上界橡皮筋
    if (v > maxDy) v = maxDy + (v - maxDy) * RUBBER;
    setDragPx(v);
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d.on) return;
    d.on = false;
    const dy = dragPx;
    const dt = Math.max(1, Date.now() - d.t0);
    const v = dy / dt;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDragging(false);
    setDragPx(0);
    // 关闭：在收起态继续下拖 > 100px 或速度 > 0.5px/ms
    if ((dy > CLOSE_PX || v > CLOSE_V) && snapVh >= SNAP_COLLAPSED_VH) {
      onDismiss?.();
      return;
    }
    // 吸附到最近的点
    const snaps = [SNAP_EXPANDED_VH, STEP_TOP_VH[step], SNAP_COLLAPSED_VH];
    const target = snapVh + (dy / vhOf()) * 100;
    let best = snaps[0];
    for (const s of snaps) if (Math.abs(s - target) < Math.abs(best - target)) best = s;
    setSnapVh(best);
  }

  // 键盘：Esc = 关闭；↑/↓ 在吸附点间切换（桌面/外接键盘）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const snaps = [SNAP_EXPANDED_VH, STEP_TOP_VH[step], SNAP_COLLAPSED_VH];
      if (e.key === "Escape") {
        onDismiss?.();
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const i = snaps.indexOf(snapVh);
      const cur = i < 0 ? 1 : i;
      const next = e.key === "ArrowUp" ? Math.max(0, cur - 1) : Math.min(snaps.length - 1, cur + 1);
      setSnapVh(snaps[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [snapVh, step, onDismiss]);

  const snapState =
    snapVh <= SNAP_EXPANDED_VH + 0.5 ? "expanded" : snapVh >= SNAP_COLLAPSED_VH - 0.5 ? "collapsed" : "default";

  return (
    <section
      className="step-sheet"
      aria-label={`规划路线 · ${STEP_LABEL[step]}`}
      data-snap={snapState}
      data-dragging={dragging ? "on" : undefined}
      style={
        {
          "--sheet-top": `${snapVh}vh`,
          transform: dragPx ? `translateY(${dragPx}px)` : undefined,
        } as React.CSSProperties
      }
    >
      {/* ★ B6：拖拽把手区（grip + 头部）—— 只有这里起拖 */}
      <div
        className="step-sheet__handle"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
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
              {/* ★ v3.3.0（AC-115）：v3 起 = 只收藏「组合」（OD）；文案常量在组件内统一 */}
              {effectiveFrom && dest && (
                <FavoriteButton
                  from={endpointOf(effectiveFrom)}
                  to={endpointOf(dest)}
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
