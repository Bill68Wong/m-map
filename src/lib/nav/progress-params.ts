/**
 * 进度模型部署参数（★ 自动生成，勿手改 —— scripts/train-progress-model.mjs）
 *
 * 生成：2026-09-27T08:23:33.245Z
 * 数据：45 场采集 · 过滤后 103793 段（原始 128414）
 * 曲线：h[段型][剩余路程比 1−p 的 20 桶] = 剩余时间比例中位数（PAVA 单调化）
 * 依据：docs/区间进度模型-调研报告-20260927.md（§4 模型设计 · §8 批判自审）
 */
export type ProgressSegType = "short" | "mid" | "long_fast" | "long_slow";

/** 段型判定（服务端与训练同口径）：长度 + 中位速度 */
export function progressTypeOf(segLenM: number, mdSec: number): ProgressSegType {
  if (segLenM < 1000) return "short";
  if (segLenM < 2500) return "mid";
  return (segLenM * 3.6) / Math.max(1, mdSec) >= 25 ? "long_fast" : "long_slow";
}

/** 融合权重 w（pred = w·D + (1−w)·B）——批判自审⑩a 实测标定 */
export const PROGRESS_W: Record<ProgressSegType, number> = {
  short: 0.6,
  mid: 0.5,
  long_fast: 0.15,
  long_slow: 0.15,
};

/** 训练统计（诊断用） */
export const PROGRESS_META = {
  generatedAt: "2026-09-27T08:23:33.247Z",
  sessions: 45,
  segs: 103793,
  counts: {"short":{"segs":91306,"pts":465398},"mid":{"segs":9054,"pts":88682},"long_fast":{"segs":2773,"pts":39323},"long_slow":{"segs":660,"pts":10258}},
} as const;

/** h 曲线（剩余时间比例，桶 i = 剩余路程比 [i/20, (i+1)/20)） */
export const PROGRESS_H: Record<ProgressSegType, number[]> = {
  short: [0.143, 0.247, 0.271, 0.271, 0.294, 0.304, 0.341, 0.353, 0.397, 0.429, 0.467, 0.5, 0.55, 0.6, 0.659, 0.7, 0.75, 0.786, 0.8, 0.889],
  mid: [0.075, 0.164, 0.164, 0.192, 0.192, 0.231, 0.28, 0.321, 0.368, 0.41, 0.435, 0.5, 0.536, 0.581, 0.633, 0.667, 0.728, 0.793, 0.827, 0.875],
  long_fast: [0.129, 0.175, 0.203, 0.231, 0.286, 0.333, 0.375, 0.392, 0.455, 0.509, 0.537, 0.566, 0.6, 0.659, 0.679, 0.766, 0.78, 0.818, 0.87, 0.962],
  long_slow: [0.493, 0.493, 0.603, 0.603, 0.603, 0.603, 0.672, 0.672, 0.672, 0.706, 0.745, 0.756, 0.777, 0.777, 0.777, 0.777, 0.777, 0.893, 0.921, 0.97],
};
