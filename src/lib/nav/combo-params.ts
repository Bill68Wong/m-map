/**
 * 组合实时计算参数（src/lib/nav/combo-params.ts，v2.3.0 · 07 §2）
 *
 * ── 契约（07 §2.1 / 05-Spec §5 修订）───────────────────────────────────
 *   `/api/nav` 追加**可选**参数 `chain` / `walk` / `tiers`，承载用户自定义站链
 *   与步行/五档参数；编码一律 `encodeURIComponent(JSON.stringify(<结构>))`。
 *   **缺省（不传）= v2.2.0 行为完全不变** —— 本模块只在参数存在时生效。
 *
 *   本模块**不新增端点**：只做编解码 + 严格校验 + 步行覆盖的纯函数，供
 *   `nav-params.ts`（页面解析，宽松）与 `api/nav/route.ts`（接口解析，严格 400）共用。
 *
 * ⚠️ 纯模块：**不得 import 任何含 pg / next 的模块** —— `nav-params.ts` 会被客户端引用。
 */
import { WALK_BASE_M_PER_MIN } from "@/lib/recommend/types";
import type { TierSpeedOverride } from "@/lib/recommend/catch-up";
import type { CatchTier } from "@/lib/recommend/types";
import type { WalkInfo } from "./types";

// ─────────────────────────── 类型（07 §1.1 / 06 §3.7 落定）───────────────────────────

/** 站链节点种类：上车 / 换乘 / 下车 */
export type ChainStepKind = "board" | "transfer" | "alight";

/** 站链节点。`code` = 站码（可为站台码如 `T373/1`）；`routes?` = 该段容许的并行线 */
export interface ChainStep {
  kind: ChainStepKind;
  code?: string;
  label: string;
  lng?: number;
  lat?: number;
  /** 该「上车/换乘」节点容许的**并行线路候选**（D1 段内并行）；空/缺省 = 自动选线 */
  routes?: string[];
}

/** 步行覆盖（单段）：`link=false` 表示距离与时长不联动（各自独立） */
export interface WalkSegOverride {
  distanceM?: number;
  minutes?: number;
  link?: boolean;
}

/** 两段步行覆盖：seg1 = 出发地→上车站；seg2 = 下车站→目的地 */
export interface WalkOverride {
  seg1?: WalkSegOverride;
  seg2?: WalkSegOverride;
}

export type TierNumber = 1 | 2 | 3 | 4 | 5;

/** 五档覆盖：`speedMps` 覆盖派生速度；`minutes` 直接覆盖该档所需用时 */
export interface TierOverride {
  speedMps?: Partial<Record<TierNumber, number>>;
  minutes?: Partial<Record<TierNumber, number>>;
}

/** 最多 3 个换乘（4 段，07 §1.2） */
export const MAX_TRANSFERS = 3;
/** 站链节点上限：4 段 = 5 个节点（board / transfer… / alight，节点数 = 段数 + 1） */
export const MAX_CHAIN_STEPS = MAX_TRANSFERS + 2;

const TIERS: readonly TierNumber[] = [1, 2, 3, 4, 5];
const KINDS: readonly ChainStepKind[] = ["board", "transfer", "alight"];

// ─────────────────────────── 编码 / 解码 ───────────────────────────

/** 统一编码：`encodeURIComponent(JSON.stringify(v))` */
export function encodeComboParam(v: unknown): string {
  return encodeURIComponent(JSON.stringify(v));
}

export type DecodeChain =
  | { ok: true; chain: ChainStep[] }
  | { ok: false; error: string };

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 解析参数 JSON。**容忍两种调用方约定**：
 *   · 已解码（`searchParams.get()` 的标准返回值 = 纯 JSON）；
 *   · 仍带 `encodeURIComponent`（调用方手工 `encodeURIComponent(JSON.stringify(...))` 后未再解）。
 * 先按纯 JSON 解析，失败再 `decodeURIComponent` 后重试。
 */
function parseJsonParam(raw: string): { ok: true; data: unknown } | { ok: false } {
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    try {
      return { ok: true, data: JSON.parse(decodeURIComponent(raw)) };
    } catch {
      return { ok: false };
    }
  }
}

/**
 * 解码并**严格校验**站链。
 * 规则：JSON 数组 · 2~5 项（段数 = 节点数 − 1 ≤ 4）· 首项 `board`、末项 `alight`、
 *       中间均为 `transfer` · 每项必须有非空 `code`（用于段解析）。
 * 失败返回 `{ ok:false, error }`（接口侧应回 400，而不是静默降级）。
 */
export function decodeChain(raw: string): DecodeChain {
  const parsed = parseJsonParam(raw);
  if (!parsed.ok) {
    return { ok: false, error: "chain 不是合法 JSON（应为 encodeURIComponent(JSON.stringify(ChainStep[]))）" };
  }
  const data = parsed.data;
  if (!Array.isArray(data)) return { ok: false, error: "chain 必须是数组" };
  if (data.length < 2) return { ok: false, error: "chain 至少需要 2 个节点（上车+下车）" };
  if (data.length > MAX_CHAIN_STEPS) {
    return { ok: false, error: `chain 最多 ${MAX_CHAIN_STEPS} 个节点（换乘 ≤ ${MAX_TRANSFERS}）` };
  }
  const chain: ChainStep[] = [];
  for (let i = 0; i < data.length; i++) {
    const it = data[i] as Record<string, unknown> | null;
    if (!it || typeof it !== "object" || Array.isArray(it)) return { ok: false, error: `chain[${i}] 必须是对象` };
    const kind = it.kind;
    if (typeof kind !== "string" || !(KINDS as string[]).includes(kind)) {
      return { ok: false, error: `chain[${i}].kind 非法（应为 board|transfer|alight）` };
    }
    const wantKind: ChainStepKind = i === 0 ? "board" : i === data.length - 1 ? "alight" : "transfer";
    if (kind !== wantKind) {
      return { ok: false, error: `chain[${i}].kind 应为 ${wantKind}（首=board / 末=alight / 中间=transfer）` };
    }
    const code = typeof it.code === "string" ? it.code.trim() : "";
    if (!code) return { ok: false, error: `chain[${i}].code 缺失（站链节点必须带站码）` };
    const label = typeof it.label === "string" ? it.label : code;
    const step: ChainStep = { kind: kind as ChainStepKind, code, label };
    if (isFiniteNum(it.lng)) step.lng = it.lng;
    if (isFiniteNum(it.lat)) step.lat = it.lat;
    if (it.routes !== undefined) {
      if (!Array.isArray(it.routes)) return { ok: false, error: `chain[${i}].routes 必须是字符串数组` };
      const routes = it.routes
        .filter((r): r is string => typeof r === "string")
        .map((r) => r.trim())
        .filter(Boolean);
      if (!routes.length) return { ok: false, error: `chain[${i}].routes 为空数组（应缺省以自动选线）` };
      step.routes = routes;
    }
    chain.push(step);
  }
  return { ok: true, chain };
}

export type DecodeWalk = { ok: true; walk: WalkOverride } | { ok: false; error: string };

function segOf(raw: unknown, name: string): { ok: true; seg: WalkSegOverride } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${name} 必须是对象` };
  }
  const o = raw as Record<string, unknown>;
  const seg: WalkSegOverride = {};
  if (o.distanceM !== undefined) {
    if (!isFiniteNum(o.distanceM) || o.distanceM < 0 || o.distanceM > 20000) {
      return { ok: false, error: `${name}.distanceM 非法（0~20000 米）` };
    }
    seg.distanceM = o.distanceM;
  }
  if (o.minutes !== undefined) {
    if (!isFiniteNum(o.minutes) || o.minutes < 0 || o.minutes > 180) {
      return { ok: false, error: `${name}.minutes 非法（0~180 分）` };
    }
    seg.minutes = o.minutes;
  }
  if (o.link !== undefined) {
    if (typeof o.link !== "boolean") return { ok: false, error: `${name}.link 必须是布尔值` };
    seg.link = o.link;
  }
  return { ok: true, seg };
}

/** 解码并校验步行覆盖；空对象视为「无覆盖」。 */
export function decodeWalk(raw: string): DecodeWalk {
  const parsed = parseJsonParam(raw);
  if (!parsed.ok) return { ok: false, error: "walk 不是合法 JSON" };
  const data = parsed.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "walk 必须是对象" };
  }
  const o = data as Record<string, unknown>;
  const walk: WalkOverride = {};
  if (o.seg1 !== undefined) {
    const r = segOf(o.seg1, "walk.seg1");
    if (!r.ok) return r;
    walk.seg1 = r.seg;
  }
  if (o.seg2 !== undefined) {
    const r = segOf(o.seg2, "walk.seg2");
    if (!r.ok) return r;
    walk.seg2 = r.seg;
  }
  return { ok: true, walk };
}

export type DecodeTiers = { ok: true; tiers: TierOverride } | { ok: false; error: string };

function tierRecord(raw: unknown, name: string, min: number, max: number): { ok: true; map: Partial<Record<TierNumber, number>> } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `${name} 必须是对象` };
  }
  const o = raw as Record<string, unknown>;
  const map: Partial<Record<TierNumber, number>> = {};
  for (const k of TIERS) {
    const v = o[String(k)];
    if (v === undefined) continue;
    if (!isFiniteNum(v) || v < min || v > max) {
      return { ok: false, error: `${name}.${k} 非法（${min}~${max}）` };
    }
    map[k] = v;
  }
  return { ok: true, map };
}

/** 解码并校验五档覆盖。 */
export function decodeTiers(raw: string): DecodeTiers {
  const parsed = parseJsonParam(raw);
  if (!parsed.ok) return { ok: false, error: "tiers 不是合法 JSON" };
  const data = parsed.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "tiers 必须是对象" };
  }
  const o = data as Record<string, unknown>;
  const tiers: TierOverride = {};
  if (o.speedMps !== undefined) {
    const r = tierRecord(o.speedMps, "tiers.speedMps", 0.5, 6);
    if (!r.ok) return r;
    tiers.speedMps = r.map;
  }
  if (o.minutes !== undefined) {
    const r = tierRecord(o.minutes, "tiers.minutes", 0, 120);
    if (!r.ok) return r;
    tiers.minutes = r.map;
  }
  return { ok: true, tiers };
}

// ─────────────────────────── 覆盖应用（纯函数）───────────────────────────

/**
 * 把用户步行覆盖套用到一段步行信息上（07 §2.5 联动语义）。
 * · 只给 `distanceM` → `minutes = distanceM ÷ 84`（联动派生）；
 * · 给 `minutes` 且 `link !== false` 且带距离 → 仍按 `distanceM ÷ 84`（联动，距离优先）；
 * · `link === false` → 用给定 `minutes` 原值（不联动）；
 * · 只给 `minutes` → 用该值（距离保持原样）。
 * 用户显式给定 ⇒ `estimated = false`（视为权威值，不再标「预估」）。
 */
export function applyWalkSeg(info: WalkInfo, seg?: WalkSegOverride): WalkInfo {
  if (!seg) return info;
  const hasD = seg.distanceM !== undefined;
  const hasM = seg.minutes !== undefined;
  if (!hasD && !hasM) return info;
  const distanceM = hasD ? (seg.distanceM as number) : (info.distanceM ?? null);
  let minutes = info.minutes;
  if (hasM && seg.link === false) minutes = seg.minutes as number;
  else if (hasD) minutes = (seg.distanceM as number) / WALK_BASE_M_PER_MIN;
  else if (hasM) minutes = seg.minutes as number;
  return { ...info, minutes, distanceM: distanceM ?? undefined, estimated: false };
}

/**
 * `TierOverride` → `TierSpeedOverride`（供 `catch-up.ts#requiredSec` 覆盖）：
 * · `speedMps[k]` → 耗时比 `ratio[k] = (84/60) ÷ speedMps[k]`（基准档 3 = 1.4 m/s）；
 * · `minutes[k]` → `requiredSec[k] = minutes[k] × 60`（直接覆盖该档所需秒数）。
 * 无有效覆盖项 → `undefined`（走模块默认 `SPEED_RATIO`）。
 */
export function tierSpeedOverrideOf(t?: TierOverride): TierSpeedOverride | undefined {
  if (!t) return undefined;
  const baseSpeedMps = WALK_BASE_M_PER_MIN / 60; // 1.4 m/s
  const ratio: Partial<Record<CatchTier, number>> = {};
  const requiredSec: Partial<Record<CatchTier, number>> = {};
  if (t.speedMps) {
    for (const k of TIERS) {
      const v = t.speedMps[k];
      if (v !== undefined && Number.isFinite(v) && v > 0) ratio[k as CatchTier] = baseSpeedMps / v;
    }
  }
  if (t.minutes) {
    for (const k of TIERS) {
      const v = t.minutes[k];
      if (v !== undefined && Number.isFinite(v) && v >= 0) requiredSec[k as CatchTier] = v * 60;
    }
  }
  if (!Object.keys(ratio).length && !Object.keys(requiredSec).length) return undefined;
  return { ratio, requiredSec };
}
