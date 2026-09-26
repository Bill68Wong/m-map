/**
 * 轻轨读秒「唯一出口」：秒级偏差叠加（src/lib/lrt/apply-bias.ts · v3.2.0）
 *
 * ── 为什么必须唯一 ───────────────────────────────────────────────────────
 * `/api/lrt/eta` 与 `/api/station/eta`（轻轨分支）必须对「同一站 同一班」给出**同一个
 * `depMs`**（AC-67）。把「表定发车 → 实际发车」的换算收敛到**唯一函数** `fixDeparture`，
 * 两条链路的 `depMs` 必然同源 ⇒ 一致性由构造保证，而非靠两处对齐。
 *
 * ── 数据来源 ─────────────────────────────────────────────────────────────
 *   · `lrt_station_biases`（逐站/逐模式，**读秒唯一真源**）→ `BiasIndex.station`
 *   · `lrt_route_params.dep_bias_sec`（石排湾/横琴线路级兜底）→ `BiasIndex.line`
 *
 * ── 回落路径（写死，对 AC-63/64/65；**未命中一律不猜**）────────────────────
 *   1. 氹仔线（`TPL`）：`pattern != null` 且该站该模式的偏差为**有限数** → 秒级；否则分钟级。
 *   2. 石排湾/横琴（`SPVL`/`HQL`）：线路级偏差为有限数 → 秒级；否则分钟级。
 *   3. 任何 `NaN/undefined/非有限` → `secPrecise=false, biasSec=0`。
 *   4. `pattern` 为 `null`/未传 → 直接走未命中分支（分钟级）。
 *
 * ⚠️ 纯函数：无 DB、无 IO、无副作用（BiasIndex 由调用方用 `buildBiasIndex` 构造）。
 */
import { LRT_PATTERN_ROUTE_NO } from "./pattern";

/**
 * 偏差索引（server 侧由纯数据构造）。
 * key 域：`route_code` = 本库线路码（`LRT-氹仔线` …）；`api_station` = motransportinfo api 码
 * （`BAR` / `OCE` …）；`direction` = 终点站 api 码（`TFT` / `BAR` / `SPV` / `HQ`）。
 */
export interface BiasIndex {
  /** `${route_code}|${direction}|${pattern}|${api_station}` → dep_bias_sec */
  station: Map<string, number>;
  /** `${route_code}` → dep_bias_sec（石排湾/横琴线路级兜底） */
  line: Map<string, number>;
}

/** `lrt_station_biases` 最小列集 */
export interface BiasStationRow {
  route_code: string;
  direction: string;
  pattern: string;
  api_station: string;
  dep_bias_sec: number | string | null;
}
/** `lrt_route_params` 最小列集 */
export interface BiasLineRow {
  route_code: string;
  dep_bias_sec: number | string | null;
}

/** 站级偏差键（构建方与取用方必须一致） */
export function biasStationKey(
  route_code: string,
  direction: string,
  pattern: string,
  api_station: string,
): string {
  return `${route_code}|${direction}|${pattern}|${api_station}`;
}

/** 空索引（新表不存在 / 查询失败时的安全兜底） */
export function emptyBiasIndex(): BiasIndex {
  return { station: new Map(), line: new Map() };
}

/** 纯函数：把库行折成偏差索引（非有限值一律跳过 ⇒ 取用时回落分钟级） */
export function buildBiasIndex(stationRows: BiasStationRow[], lineRows: BiasLineRow[]): BiasIndex {
  const station = new Map<string, number>();
  for (const r of stationRows) {
    const v = Number(r.dep_bias_sec);
    if (Number.isFinite(v)) station.set(biasStationKey(r.route_code, r.direction, r.pattern, r.api_station), v);
  }
  const line = new Map<string, number>();
  for (const r of lineRows) {
    const v = Number(r.dep_bias_sec);
    if (Number.isFinite(v)) line.set(r.route_code, v);
  }
  return { station, line };
}

export interface FixDepartureArgs {
  /** 本库线路码（`LRT-氹仔线` …） */
  lineCode: string;
  /** `'TPL' | 'SPVL' | 'HQL'` */
  routeNo: string;
  /** 终点站 api 码 */
  directionApi: string;
  /** 上车站 api 码 */
  apiStation: string;
  /** 班别（保留入参：模式本就按班别派生，供诊断/未来扩展） */
  dayType: string;
  /** 表定发车「服务日 00:00 起分钟偏移」（可 >1440） */
  tableMin: number;
  /** 澳门当日 00:00（UTC ms） */
  dayStartMs: number;
  /** 由 `pattern.ts` 预取；null = 无模式 */
  pattern: string | null;
  biasIndex: BiasIndex;
}

export interface DepartureFix {
  /** 绝对发车时刻（= dayStartMs + (tableMin*60 + biasSec)*1000） */
  depMs: number;
  /** 实际叠加的偏差（秒）；未命中 = 0 */
  biasSec: number;
  /** true = 有秒级偏差数据 */
  secPrecise: boolean;
  pattern: string | null;
}

/**
 * 表定发车 → 实际发车（读秒唯一出口）。
 *
 * 不变式：`depMs` 与 `biasSec` 由同一函数统一产出 ⇒ 两路由对同一输入必然得到同一 `depMs`（AC-67）。
 */
export function fixDeparture(a: FixDepartureArgs): DepartureFix {
  let biasSec = 0;
  let secPrecise = false;

  if (a.routeNo === LRT_PATTERN_ROUTE_NO) {
    // 氹仔线：逐站/逐模式；未命中（变体/截断/歧义）→ 不猜，分钟级
    if (a.pattern != null) {
      const v = a.biasIndex.station.get(
        biasStationKey(a.lineCode, a.directionApi, a.pattern, a.apiStation),
      );
      if (typeof v === "number" && Number.isFinite(v)) {
        biasSec = v;
        secPrecise = true;
      }
    }
  } else {
    // 石排湾 / 横琴：线路级等效（两线单模式）；任何非有限值 → 分钟级
    const v = a.biasIndex.line.get(a.lineCode);
    if (typeof v === "number" && Number.isFinite(v)) {
      biasSec = v;
      secPrecise = true;
    }
  }

  const depMs = a.dayStartMs + (a.tableMin * 60 + biasSec) * 1000;
  return { depMs, biasSec, secPrecise, pattern: a.pattern };
}
