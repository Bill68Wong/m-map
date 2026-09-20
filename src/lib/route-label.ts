/**
 * 线路名展示统一口径（src/lib/route-label.ts，v0.19.1）
 * ⚠️ 纯展示层，禁止 import 任何含 pg/db 的模块（client 组件会直接 import）。
 */
import { sortRouteOptions } from "@/lib/timer-flow";

/** 轻轨码判定 */
export const isLrtCode = (code?: string | null): boolean => !!code && code.startsWith("LRT-");

/**
 * 线路标签文字（谷歌地图风格，简洁）：
 *   巴士 → '26' / '25B'（不带「路」字）；轻轨 → '氹仔線'（不带「輕軌·」前缀）
 */
export function lineNameOf(code: string): string {
  if (!code) return "";
  if (isLrtCode(code))
    return code
      .replace(/^LRT-/, "")
      .replace(/湾/g, "灣")
      .replace(/横/g, "橫")
      .replace(/线/g, "線");
  return code;
}

/**
 * 载具语义键（★ M Map 改版 S6：**不再返回 emoji**）。
 * 兼容旧签名（仍收线路码），返回可交给 `<Icon>` 的语义名 —— 全站零 emoji。
 */
export const kindIcon = (code: string): "lrt" | "bus" => (isLrtCode(code) ? "lrt" : "bus");

/** 多线路展示顺序：轻轨在前 + 巴士自然排序（25B → 25BS → 50 → 102 → N6） */
export { sortRouteOptions };
