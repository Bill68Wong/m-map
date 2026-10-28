/**
 * 推荐综合成本模型 + 用户偏好三档（src/lib/recommend/score.ts，B4 / 需求 8）
 *
 * ── 目的 ──────────────────────────────────────────────────────────────
 *   把「按 `totalMin` 单一升序」升级为**多因子效用排序**（对齐谷歌 Route options /
 *   高德 `BusMode`）：
 *     cost = totalMin + α×换乘次数 + (β−1)×步行分钟 + 紧接换乘风险项     // cost 升序
 *
 *   ⚠️ **α/β 只作排序效用，不并入展示的 `totalMin`**（05-Spec §4.4 / 06 §4.1）——
 *      `totalMin` 是对用户显示的时间；cost 是内部「广义成本」。二者分离，避免
 *      「显示时间对不上明细」。
 *
 * ── 参数依据（06-产品-补充调研-推荐排序机制.md）────────────────────────
 *   · α = 10（分/次）：文献「纯换乘惩罚」主流 10~18（马德里 15.2~17.7 / 爱尔兰 12.73~24.32 /
 *     西安 9.93~12.13），澳门网络线路少、站距短、总时长短 ⇒ 取**偏保守中值**。
 *     **不含**已计的等待/步行（`totalMin` 已 1:1 计入），避免重复计。
 *   · β = 1.8：OTP `walk.reluctance` 默认 2.0（步行痛苦度≈乘车 2 倍）；额外项 =
 *     `(β−1)×步行分钟 = 0.8×`。区间 1.5~2.0。
 *   · 安全余量 = 3 分钟：OTP「避免过短换乘 + 最大化可用等待」+ 谷歌「1 分钟换乘易在延误时崩塌」。
 *   · 风险项：仅对 `0 ≤ slack < 安全余量` 的换乘给**轻微**惩罚（抑制极限换乘，非惩罚普通等待）；
 *     基准 `PREF_RISK_FACTOR = 0.5`。
 *
 * ── 三档主判据（06 §4.5）────────────────────────────────────────────
 *   | 档               | 主判据     | tie-break 顺序                        |
 *   | balanced         | cost ↑     | ①换乘次数 ②步行量 ③来源(amap 优)④planId |
 *   | fewer_transfers  | 换乘次数 ↑ | ①cost ②步行量 ③来源 ④planId            |
 *   | less_walk        | 步行量 ↑   | ①cost ②换乘次数 ③来源 ④planId          |
 *
 * ── ⚠️ 契约边界 ──────────────────────────────────────────────────────
 *   · **偏好不进 `switch-plans`**（组内仍按 `totalMin`；`switch-plans-shared` 不动）；
 *   · `fastest` 档**不在范围内**（Spec §2/§3 锁定三档）。
 *
 * ⚠️ client-safe 纯模块（不 import 任何含 pg 的模块）。
 */
import type { RecommendCard } from "./types";

// ─────────────────────────── 类型与常量 ───────────────────────────

export type PrefMode = "balanced" | "fewer_transfers" | "less_walk";

/** 三档偏好（顺序即 UI 展示序；`balanced` 为默认档）。 */
export const PREF_MODES: PrefMode[] = ["balanced", "fewer_transfers", "less_walk"];

/** ★ 可审计常量（AC-62）：α = 每次换乘的纯不便成本（分）。 */
export const PREF_ALPHA = 10;
/** ★ 可审计常量（AC-62）：β = 步行总权重（额外项 =(β−1)×步行分钟）。 */
export const PREF_BETA = 1.8;
/** ★ 可审计常量（AC-62）：换乘安全余量（分）—— 与需求 7（model.ts 顺延闸门）**共用**。 */
export const TRANSFER_SAFETY_MIN = 3;
/** 紧接换乘风险系数（仅 `0 ≤ slack < safetyMin` 时给 `riskFactor × 缺口` 的轻微惩罚）。 */
export const PREF_RISK_FACTOR = 0.5;

export interface Prefs {
  mode: PrefMode;
  alpha: number;
  beta: number;
  safetyMin: number;
  riskFactor: number;
}

/** 三档默认参数（当前三档共享同一组 α/β/safety/risk，仅**主判据**不同）。 */
export const PREF_DEFAULTS: Record<PrefMode, Prefs> = {
  balanced: {
    mode: "balanced",
    alpha: PREF_ALPHA,
    beta: PREF_BETA,
    safetyMin: TRANSFER_SAFETY_MIN,
    riskFactor: PREF_RISK_FACTOR,
  },
  fewer_transfers: {
    mode: "fewer_transfers",
    alpha: PREF_ALPHA,
    beta: PREF_BETA,
    safetyMin: TRANSFER_SAFETY_MIN,
    riskFactor: PREF_RISK_FACTOR,
  },
  less_walk: {
    mode: "less_walk",
    alpha: PREF_ALPHA,
    beta: PREF_BETA,
    safetyMin: TRANSFER_SAFETY_MIN,
    riskFactor: PREF_RISK_FACTOR,
  },
};

// ─────────────────────────── 派生量 ───────────────────────────

/** 步行分钟 = 出站(`walkOut`) + 换乘步行(Σ `transfers.minutes`) + 进站(`walkIn`)。 */
export function walkMinutesOf(card: RecommendCard): number {
  const out = Number.isFinite(card.walkOut?.minutes) ? card.walkOut.minutes : 0;
  const inM = Number.isFinite(card.walkIn?.minutes) ? card.walkIn.minutes : 0;
  let transferWalk = 0;
  for (const t of card.transfers ?? []) transferWalk += Number.isFinite(t.minutes) ? t.minutes : 0;
  return out + inM + transferWalk;
}

/** 换乘次数（＝换乘段数）。 */
export function transfersCountOf(card: RecommendCard): number {
  return card.transfers?.length ?? 0;
}

/**
 * 广义成本（**纯函数，可复算 —— AC-62**）。
 *
 * `cost = totalMin + α×换乘次数 + (β−1)×步行分钟 + 紧接换乘风险项`
 *   风险项 = Σ `riskFactor × max(0, safetyMin − slackMin)`（仅 `slackMin != null` 时计入；
 *   巴士第 2 段无时刻表 ⇒ `slackMin === null` ⇒ 不加风险项）。
 */
export function costOf(card: RecommendCard, p: Prefs = PREF_DEFAULTS.balanced): number {
  const transfers = transfersCountOf(card);
  let risk = 0;
  for (const t of card.transfers ?? []) {
    if (t.slackMin != null && Number.isFinite(t.slackMin)) {
      risk += p.riskFactor * Math.max(0, p.safetyMin - t.slackMin);
    }
  }
  return card.totalMin + p.alpha * transfers + (p.beta - 1) * walkMinutesOf(card) + risk;
}

// ─────────────────────────── 参数解析 ───────────────────────────

/**
 * 解析 API 参数 `prefs`（照抄 `chain/walk/tiers` 可选参数模式）。
 * **非法值（含缺省）一律回落 `balanced`**（不 400）。
 */
export function parsePrefs(raw: string | null | undefined): Prefs {
  const m = (raw ?? "").trim();
  return (PREF_MODES as string[]).includes(m) ? PREF_DEFAULTS[m as PrefMode] : PREF_DEFAULTS.balanced;
}

// ─────────────────────────── 比较器 ───────────────────────────

const EPS = 1e-9;

/**
 * 三档偏好比较器（稳定；`origin` 可选 —— 高德优先）。
 *
 * @param originOf 卡片 → 来源；缺省则**跳过**来源 tie-break（`card.ts` / `sortCards` 用）；
 *                 `rank.ts` 传 `item.origin` 对应的查表函数。
 */
export function cmpByPref(
  a: RecommendCard,
  b: RecommendCard,
  p: Prefs = PREF_DEFAULTS.balanced,
  originOf?: (c: RecommendCard) => "amap" | "local",
): number {
  const costCmp = () => costOf(a, p) - costOf(b, p);
  const trCmp = () => transfersCountOf(a) - transfersCountOf(b);
  const walkCmp = () => walkMinutesOf(a) - walkMinutesOf(b);
  const originCmp = () => {
    if (!originOf) return 0;
    const oa = originOf(a);
    const ob = originOf(b);
    if (oa === ob) return 0;
    return oa === "amap" ? -1 : 1;
  };
  const idCmp = () => a.planId - b.planId;

  let order: Array<() => number>;
  if (p.mode === "fewer_transfers") order = [trCmp, costCmp, walkCmp, originCmp, idCmp];
  else if (p.mode === "less_walk") order = [walkCmp, costCmp, trCmp, originCmp, idCmp];
  else order = [costCmp, trCmp, walkCmp, originCmp, idCmp];

  for (const f of order) {
    const d = f();
    if (Math.abs(d) > EPS) return d;
  }
  return 0;
}
