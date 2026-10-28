/**
 * 轻轨换乘站的**切法结构**（src/components/nav/lrt-transfer.ts，v2.10.0）
 *
 * ⚠️ 本文件**不含任何颜色**。
 *   · 切法（斜切 `diag` / 水平切 `half`）是**形状结构**，不是数据 —— 后端 `/api/stations`
 *     只下发 `color` / `color2`（源自 `routes.color`），不下发「怎么切」；
 *   · 颜色一律由 `NavMap` 以**行内 CSS 变量** `--c1 / --c2` 注入；CSS 只写**渐变结构**。
 *
 * ⚠️ 为什么只剩这两个站：`/api/stations` 现在对每个 `kind === "lrt"` 的站都会给 `color`
 *   （单线站 = 该线色；换乘站按 Spec §8 给 `color` / `color2`）
 *   ⇒ **原先的线路色兜底（lrt-colors.ts）已删除**，颜色完全由 DB 数据驱动。
 */
export type LrtTransferVariant = "diag" | "half";

/** 站点主码 → 切法（仅换乘站） */
export const LRT_TRANSFER_VARIANT: Record<string, LrtTransferVariant> = {
  /** 蓮花站：斜切 —— 左下横琴线(c1) / 右上氹仔线(c2) */
  "LRT-LOT": "diag",
  /** 協和醫院站：水平切 —— 上氹仔线(c1) / 下石排湾线(c2) */
  "LRT-UH": "half",
};

/** 站点主码 → 切法；非换乘站返回 `undefined` */
export function lrtTransferVariantOf(code: string): LrtTransferVariant | undefined {
  return LRT_TRANSFER_VARIANT[code];
}
