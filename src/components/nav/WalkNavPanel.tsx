"use client";

/**
 * 步行导航结果面板（src/components/nav/WalkNavPanel.tsx，2026-10-29 新增 / 第二期加跟随）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   只做**展示 + 交互按钮**：
 *   · 未跟随：查询中（先显示卡片上的分钟/距离）、成功（高德距离/时长 + 转向步骤）、失败（错误 + 重试）；
 *   · 跟随中：剩余距离 / 剩余时间 / 当前步提示 / 偏航告警 / 到达态；按钮「停止跟随」「重新规划」。
 *   地图画线、跟随取景由 `NavMap` 负责；会话与定位由 `NavShell` 持有。
 *
 * ⚠️ 坐标/口径：步进进度由 `walkProgress`（纯函数）以 GPS（GCJ-02）投影折线算得；
 *   距离/时长基准一律用高德返回值，卡片 `hint*` 只在查询期间兜底。
 * ⚠️ 容器复用 `.nav-card-overlay`（fixed z90 > 面板 70），本组件不自己定位。
 */
import Icon from "@/components/ui/Icon";
import {
  walkEtaMin,
  walkProgress,
  type WalkNavPhase,
  type WalkNavRequest,
  type WalkNavResult,
} from "./walk-nav";

/** GPS 点（GCJ-02；来自 `useUserFix`） */
export interface WalkFix {
  lng: number;
  lat: number;
}

export interface WalkNavPanelProps {
  request: WalkNavRequest;
  phase: WalkNavPhase;
  result: WalkNavResult | null;
  /** 实时定位（跟随用）；null = 尚未拿到/被拒权 */
  fix: WalkFix | null;
  /** 定位被拒/不可用 */
  denied?: boolean;
  /** 是否处于跟随模式 */
  following: boolean;
  /** 关闭（同时清理地图折线、退出跟随） */
  onClose: () => void;
  /** 失败重试（同一段重新查询） */
  onRetry: () => void;
  /** 开始跟随（必须在用户手势内触发，用于申请定位/屏幕常亮） */
  onStartFollow: () => void;
  /** 停止跟随（恢复总览取景） */
  onStopFollow: () => void;
  /** 从当前位置重新规划（偏航/绕路时用；保留跟随） */
  onReroute: () => void;
}

function fmtDistance(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m) || m <= 0) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`;
}

function fmtMin(min: number): string {
  if (!Number.isFinite(min) || min <= 0) return "—";
  return min < 1 ? "不到 1" : String(Math.round(min));
}

export default function WalkNavPanel({
  request,
  phase,
  result,
  fix,
  denied = false,
  following,
  onClose,
  onRetry,
  onStartFollow,
  onStopFollow,
  onReroute,
}: WalkNavPanelProps) {
  const ok = phase === "ready" && result?.ok ? result : null;
  const failed = phase === "failed" || (result && !result.ok) ? result : null;
  const progress =
    ok && fix && following ? walkProgress(ok.path, ok.steps, fix, request.to) : null;
  const etaMin = ok && progress ? walkEtaMin(progress, ok) : null;
  const step = ok && progress ? ok.steps[progress.stepIndex] : null;

  return (
    <div
      className="nav-card-overlay walk-nav"
      role="dialog"
      aria-modal="false"
      aria-label="步行导航"
      data-walk-follow={following ? "on" : "off"}
      data-walk-offroute={progress?.offRoute ? "on" : "off"}
    >
      <div className="walk-nav__head">
        <span className="walk-nav__title">{following ? "步行跟随" : "步行导航"}</span>
        <button type="button" className="btn btn--text btn--sm" onClick={onClose} aria-label="关闭步行导航">
          <Icon name="close" size={20} />
        </button>
      </div>

      <p className="walk-nav__od t-label">
        {request.from.label} → {request.to.label}
      </p>

      {following && progress?.arrived && (
        <div className="walk-nav__arrived" role="status">
          <Icon name="check" size={20} />
          <span>已到达 {request.to.label}</span>
        </div>
      )}

      <div className="walk-nav__stat" data-walk-phase={phase}>
        {following && progress?.arrived ? (
          <span className="walk-nav__dist">已到达终点 · 可以结束导航</span>
        ) : following && progress ? (
          <>
            <span className="walk-nav__min">
              <b>{fmtDistance(progress.remainingM)}</b> 剩余
            </span>
            {etaMin != null && <span className="walk-nav__dist">约 {fmtMin(etaMin)} 分钟</span>}
          </>
        ) : phase === "loading" ? (
          <span className="walk-nav__hint">正在规划步行路线…</span>
        ) : ok ? (
          <>
            <span className="walk-nav__min">
              <b>{Math.max(1, Math.round(ok.durationMin))}</b> 分
            </span>
            <span className="walk-nav__dist">{fmtDistance(ok.distanceM)}</span>
          </>
        ) : (
          <span className="walk-nav__hint walk-nav__hint--warn">
            {(failed && !failed.ok ? failed.error : "") || "步行路线规划失败"}
            <button type="button" className="btn btn--text btn--sm" onClick={onRetry}>
              重试
            </button>
          </span>
        )}
      </div>

      {/* 跟随态：当前一步提示（高德原文转向） */}
      {following && step && !progress?.arrived && (
        <div className="walk-nav__now" data-walk-step={progress?.stepIndex ?? 0}>
          <span className="walk-nav__step-no" aria-hidden="true">
            {(progress?.stepIndex ?? 0) + 1}
          </span>
          <span className="walk-nav__step-text">{step.instruction}</span>
          {progress && <span className="walk-nav__step-dist">{fmtDistance(progress.stepRemainingM)}</span>}
        </div>
      )}

      {following && progress?.offRoute && (
        <div className="walk-nav__offroute" role="alert">
          <span>已偏离路线约 {fmtDistance(progress.offsetM)}</span>
          <button type="button" className="btn btn--text btn--sm" onClick={onReroute}>
            重新规划
          </button>
        </div>
      )}

      {following && denied && (
        <p className="walk-nav__hint walk-nav__hint--warn">
          定位不可用 · 请在浏览器地址栏的定位权限中「允许」，再重新打开本页
        </p>
      )}
      {following && !denied && !fix && (
        <p className="walk-nav__hint">正在定位…请到室外开阔处等待 GPS 信号</p>
      )}

      {!following && ok && ok.steps.length > 0 && (
        <ol className="walk-nav__steps">
          {ok.steps.map((s, i) => (
            <li key={i} className="walk-nav__step">
              <span className="walk-nav__step-no" aria-hidden="true">
                {i + 1}
              </span>
              <span className="walk-nav__step-text">{s.instruction}</span>
              <span className="walk-nav__step-dist">{fmtDistance(s.distanceM)}</span>
            </li>
          ))}
        </ol>
      )}

      {!following && denied && (
        <p className="walk-nav__hint walk-nav__hint--warn">
          浏览器定位权限被拒绝 · 允许定位后才能「开始跟随」
        </p>
      )}

      {(following || ok) && (
        <div className="walk-nav__actions">
          {following ? (
            progress?.arrived ? (
              <button type="button" className="btn btn--primary btn--sm" onClick={onStopFollow}>
                结束导航
              </button>
            ) : (
              <>
                <button type="button" className="btn btn--text btn--sm" onClick={onStopFollow}>
                  停止跟随
                </button>
                <button type="button" className="btn btn--text btn--sm" onClick={onReroute}>
                  从当前位置重新规划
                </button>
              </>
            )
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={onStartFollow}
              disabled={denied || phase !== "ready" || !ok}
            >
              {denied ? "定位不可用" : "开始跟随"}
            </button>
          )}
        </div>
      )}

      <p className="walk-nav__foot t-muted">
        {following ? "跟随中 · 屏幕保持常亮 · 退出即恢复总览" : "路线由高德地图提供 · 仅供步行参考"}
      </p>
    </div>
  );
}
