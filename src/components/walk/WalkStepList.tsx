"use client";

/**
 * 步行步骤列表（src/components/walk/WalkStepList.tsx，v3.6.0 · S5 · 设计 §2.1）
 *
 * ── 三态（AC-04 / 设计 §2.1 表）──────────────────────────────────────────
 *   `now`   = `i === currentIdx`：绿圆盘 + 600 字重 + 绿浅底 + `aria-current="step"`
 *   `done`  = `i < currentIdx`：整行 `--meta` + 行尾勾 + 引导线转灰
 *   `ahead` = `i > currentIdx`：`--fg-2` 正文 + `--muted` 图标/距离
 *   ⚠️ 这是**步级**进度（索引切分）。地图的 `nowPath` 是**米级**（`ratio` 切分）——
 *      两套**不得混用**（设计 §2.3 细节 5：一步 180 米走 3 分钟，步级中途零反馈）。
 *
 * ── 为什么不用虚拟滚动 ────────────────────────────────────────────────
 *   步行段典型 3~10 步，全量渲染反而更稳（虚拟滚动会让 `data-walk-step` 的断言目标被回收）。
 *   只有超长步行（AC-09 >2500 米，可能 40+ 步）才需要折叠 —— 由调用方分页，
 *   本组件只管渲染给定数组。
 */
import Icon from "@/components/ui/Icon";
import type { WalkStep, WalkTurn } from "@/lib/walk/walk-shared";

const TURN_ICON: Record<WalkTurn, "turnStraight" | "turnLeft" | "turnRight" | "undo" | "walkArrive"> = {
  straight: "turnStraight",
  left: "turnLeft",
  right: "turnRight",
  uturn: "undo",
  arrive: "walkArrive",
};

/** 米数显示（≥1000 转公里，1 位小数）—— 与横幅同口径，避免两处格式不一致 */
export function distText(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return "0 米";
  if (m >= 1000) return `${(m / 1000).toFixed(1)} 公里`;
  return `${Math.round(m)} 米`;
}

export interface WalkStepListProps {
  steps: WalkStep[];
  /** 当前步（-1 = 预览态，全部按「未走」渲染） */
  currentIdx: number;
  /** id 前缀（`aria-controls` 指向用；同一页可能有两段步行） */
  idPrefix: string;
  /** 超长步行提示（AC-09：> 2500 米） */
  longWalk?: boolean;
  /** 手动兜底「上一步 / 下一步」（仅 manual 模式或用户手动模式出现） */
  manual?: { onPrev: () => void; onNext: () => void } | null;
  className?: string;
}

export default function WalkStepList({
  steps,
  currentIdx,
  idPrefix,
  longWalk = false,
  manual = null,
  className = "",
}: WalkStepListProps) {
  if (!steps.length) return null;
  return (
    <div className={`rc-walklist ${className}`.trim()} id={`walkseg-${idPrefix}`}>
      {longWalk && (
        <p className="walklist__long t-label" role="note">
          该段步行较远，请确认是否改乘
        </p>
      )}
      {steps.map((s, i) => {
        const state = currentIdx < 0 ? "ahead" : i < currentIdx ? "done" : i === currentIdx ? "now" : "ahead";
        return (
          <div
            key={s.idx}
            className={`walkstep walkstep--${state}`}
            data-walk-state={state}
            aria-current={state === "now" ? "step" : undefined}
          >
            <span className="walkstep__rail" aria-hidden="true" />
            <span className="walkstep__mark" aria-hidden="true">
              <Icon name={TURN_ICON[s.turn] ?? "turnStraight"} size={20} />
            </span>
            <span className="walkstep__body">
              {/* 指令是**成句可读**的（无障碍硬要求：不得只给箭头图标） */}
              <span className="walkstep__txt">{s.text}</span>
              {s.sub ? <span className="walkstep__sub">{s.sub}</span> : null}
            </span>
            {state === "done" ? (
              <span className="walkstep__done" aria-label="已完成">
                <Icon name="check" size={16} />
              </span>
            ) : (
              <span className="walkstep__dist">{distText(s.distM)}</span>
            )}
          </div>
        );
      })}

      {manual && (
        <div className="walklist__manual">
          <button type="button" className="btn btn--text btn--sm" onClick={manual.onPrev}>
            上一步
          </button>
          <button type="button" className="btn btn--text btn--sm" onClick={manual.onNext}>
            下一步
          </button>
        </div>
      )}
    </div>
  );
}
