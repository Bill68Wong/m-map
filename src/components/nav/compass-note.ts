/**
 * 朝向来源 → 一句说明（src/components/nav/compass-note.ts，★ 2026-11-15 · F3）
 *
 * ── 为什么必须有这句 ──────────────────────────────────────────────────
 *   箭头画出来之后，用户**无法从画面看出**这个方向是怎么来的：
 *     · 罗盘给的 ⇒ 就是他面朝的方向（可信）；
 *     · GPS 行进方向 ⇒ 是他"刚才往哪走"，站着不动会退回正北；
 *     · 都没有   ⇒ 干脆不画（见 `resolveHeading`），但仍要告诉他为什么没有。
 *   不说清楚，用户就会把"我朝行进方向"当成"我面朝这里"，拐弯时发现箭头不跟人走。
 *
 * ── 只出现在哪 ────────────────────────────────────────────────────────
 *   只出现在**步行面板**（`WalkOnlyPane`）—— 那里有位置放一行小字。
 *   导航详情面板不给位置，所以那里**宁可不画箭头**（正北兜底不画），
 *   而不是画一个没有解释、还会被误读的箭头。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   纯函数、无 React、无副作用 ⇒ 可用 `scripts/test-compass-fallback.ts` 直接断言；
 *   文案会**直接上屏** ⇒ 不许出现"失败/系统/异常"这类把锅甩给用户的词。
 */
import type { HeadingMode } from "@/lib/compass/heading";
import type { CompassStatus } from "./useCompassHeading";

/** iOS 等需要一次手势的机型：给一个可点的入口（不是一个弹窗） */
export const NOTE_HEADING_ENABLE = "点此开启朝向指示";
/** 没传感器 / 用户拒绝：不解释技术细节，只说实话 + 地图本来是正的 */
export const NOTE_HEADING_NORTH = "方向暂时读不到 · 地图按正北朝上";
/** 罗盘不可信（磁扰 / 精度差）：说明"我们没在骗你" */
export const NOTE_HEADING_POOR = "方向读数不稳 · 先按正北显示";
/** 用行进方向代替朝向：必须说清它是"往哪走"而不是"朝哪看" */
export const NOTE_HEADING_COURSE = "方向跟随行进方向 · 停下后按正北";

export interface HeadingNote {
  text: string;
  /** `enable` = 需要用户点一下才能开（渲染成按钮）；`null` = 纯说明文字 */
  action: "enable" | null;
}

/**
 * 决定步行面板上要不要出那一行小字、出哪一句。
 * @returns `null` = 什么都不显示（罗盘正常时**不该有多余文字**）
 *
 * ── 判定顺序是这次真机/浏览器验证改出来的，不要随手调换 ──────────────────
 *   第一版把"没有传感器"排在"跟行进方向"前面 ⇒ 实测出现自相矛盾的画面：
 *   箭头明明跟着行进方向转（来源 = course），下面却写着「方向暂时读不到 · 按正北」。
 *   ⇒ 判据必须是「**箭头现在在用什么**」优先，而不是「传感器状态如何」：
 *     ① 罗盘在给方向 ⇒ 不需要解释；
 *     ② iOS 还没试过权限 ⇒ 先给可点入口（此时没有比"去点一下"更有用的话）；
 *     ③ 正在用行进方向 ⇒ 必须解释（它是"往哪走"不是"朝哪看"）；
 *     ④ 其余（没有方向 / 质量差）⇒ 说明为什么没画。
 */
export function noteOfHeading(o: {
  /** 是否处于需要朝向的场景（步行段） */
  enabled: boolean;
  mode: HeadingMode;
  status: CompassStatus;
  /** 本机是否必须先有一次手势（iOS） */
  needsGesture: boolean;
}): HeadingNote | null {
  if (!o.enabled) return null;

  // ① 罗盘正常 ⇒ 不加字
  if (o.mode === "compass") return null;

  // ② 本机要求手势、且还没试过 ⇒ 给一个"点一下"的入口（不是弹窗、不自动申请）
  if (o.needsGesture && (o.status === "idle" || o.status === "needs_permission")) {
    return { text: NOTE_HEADING_ENABLE, action: "enable" };
  }

  // ③ 正在用行进方向 ⇒ 说明它是什么（否则用户拐弯时会发现箭头不跟人走）
  if (o.mode === "course") return { text: NOTE_HEADING_COURSE, action: null };

  // ④ 罗盘在收帧但质量不足 ⇒ 正在用正北兜底，说清楚
  if (o.status === "poor") return { text: NOTE_HEADING_POOR, action: null };

  // ⑤ 其余（拒绝 / 无传感器 / 还没出首帧）⇒ 说明为什么不画
  return { text: NOTE_HEADING_NORTH, action: null };
}
