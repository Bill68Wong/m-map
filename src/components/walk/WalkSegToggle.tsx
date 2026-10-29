"use client";

/**
 * 详情页「步行」行右侧的展开键（src/components/walk/WalkSegToggle.tsx，v3.6.0 · S5 · 设计 §2.1）
 *
 * ── 规格（设计锁定）────────────────────────────────────────────────────
 *   · `min-h 44px`（触摸目标）；chevron 20px，展开时旋转 180°；
 *   · `aria-expanded` / `aria-controls="walkseg-{id}"`（指向 `WalkStepList` 的 id）；
 *   · **展开态不记忆**（由父组件 `useState` 持有，不写 localStorage）—— 下次进来默认收起，
 *     否则每次都要先收起来才能看卡片。
 *   · 文案「步骤」（不是「查看步骤」）—— 该行本身已有「步行 5 分 → 新馬路」，
 *     再写一遍"查看"会让右侧过宽（390px 屏）。
 *
 * ── ★ 受控组件（**不是**容器）─────────────────────────────────────────────
 *   设计把 `.rc-walklist` 画在**该行之后**（`rc-row` 的兄弟节点），
 *   所以本组件**只出按钮**，展开内容由父组件紧随 `<Row>` 渲染。
 *   ⚠️ 若把列表塞进 `Row` 的 `aside`，它会落进 `.rc-row` 的 flex 行里被挤扁、
 *      按钮被推出视口（S5 真浏览器验收抓到过：`Element is outside of the viewport`）。
 */
import Icon from "@/components/ui/Icon";

export interface WalkSegToggleProps {
  /** 与 `WalkStepList` 的 `idPrefix` 一致（`aria-controls` 用） */
  idPrefix: string;
  /** 展开态（父组件持有） */
  open: boolean;
  /** 切换（带事件：父组件据此用 `closest()` 定位最近的滚动容器做受控滚动） */
  onToggle: (ev: React.MouseEvent<HTMLButtonElement>) => void;
}

export default function WalkSegToggle({ idPrefix, open, onToggle }: WalkSegToggleProps) {
  return (
    <button
      type="button"
      className="walkseg__toggle"
      aria-expanded={open}
      aria-controls={`walkseg-${idPrefix}`}
      onClick={onToggle}
    >
      <span className="walkseg__toggle-txt">步骤</span>
      <Icon name="caretDown" size={20} className={`walkseg__chev${open ? " is-open" : ""}`} />
    </button>
  );
}
