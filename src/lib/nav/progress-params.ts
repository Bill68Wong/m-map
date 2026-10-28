/**
 * 进度模型部署参数（★ 自动生成，勿手改 —— scripts/train-progress-model.mjs）
 *
 * 生成：2026-09-27T11:27:58.224Z
 * 数据：50 场采集 · 过滤后 117784 段（原始 145883）
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
  generatedAt: "2026-09-27T11:27:58.226Z",
  sessions: 50,
  segs: 117784,
  counts: {"short":{"segs":103580,"pts":525117},"mid":{"segs":10313,"pts":100797},"long_fast":{"segs":3150,"pts":44680},"long_slow":{"segs":741,"pts":11447}},
} as const;

/** h 曲线（剩余时间比例，桶 i = 剩余路程比 [i/20, (i+1)/20)） */
export const PROGRESS_H: Record<ProgressSegType, number[]> = {
  short: [0.143, 0.25, 0.272, 0.272, 0.296, 0.303, 0.34, 0.353, 0.399, 0.429, 0.468, 0.5, 0.548, 0.6, 0.659, 0.7, 0.75, 0.786, 0.8, 0.889],
  mid: [0.076, 0.162, 0.162, 0.193, 0.193, 0.231, 0.279, 0.322, 0.368, 0.41, 0.438, 0.5, 0.536, 0.581, 0.63, 0.667, 0.729, 0.793, 0.828, 0.875],
  long_fast: [0.127, 0.173, 0.203, 0.231, 0.286, 0.333, 0.377, 0.39, 0.455, 0.509, 0.537, 0.566, 0.6, 0.659, 0.679, 0.766, 0.782, 0.816, 0.87, 0.962],
  long_slow: [0.492, 0.492, 0.605, 0.605, 0.605, 0.605, 0.672, 0.672, 0.672, 0.706, 0.743, 0.757, 0.779, 0.779, 0.779, 0.779, 0.779, 0.894, 0.92, 0.971],
};
