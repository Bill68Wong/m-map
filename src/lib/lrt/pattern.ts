/**
 * 氹仔线「站间间隔模式」判定（src/lib/lrt/pattern.ts · v3.2.0）
 *
 * ── 这是什么 ─────────────────────────────────────────────────────────────
 * 需求 1：氹仔线对「某站、某方向、下一班」精确判定其属于哪一种**站间间隔模式**
 * （`52222222222` / `42322213132` / `22222232222` / `13222222222`），再取该模式下的
 * **逐站偏差**做秒级读秒（见 `apply-bias.ts#fixDeparture`）。
 *
 * `lrt_timetables` 的粒度是「站 × 线路 × 方向 × 班别」，**没有任何班次标识**，因此
 * 「某一班属于哪个模式」不是库里现成字段，必须**由站间时序链式反推**得到。
 *
 * ── 算法（ADR-101 方案 C · 唯一纯函数实现）────────────────────────────────
 *   取起点站一趟发车 t0 → 下一站取「满足 `v − t ≥ 该段最小间隔` 的最小发车时刻」（二分 `firstAfter`）
 *   → 间隔 = 差 → 逐站链到底（终点站无时刻行，故 12 站 = 11 段）→ 得 11 位间隔序列 = 模式。
 *   把该链上 12 个站的发车分钟各映射为 `lrtPatternKey → pattern`。
 *   逐段最小间隔见 `LRT_TPL_MIN_GAP`（首跳跨海下限 4 分）—— 与 `.verify/lrt-tpl-chain2.mjs` /
 *   `.verify/lrt-tpl-stats.mjs` 口径一致（`14` 号 A2 分布即由此产出）。
 *
 * 离线脚本（`scripts/build-lrt-patterns.ts`）、预载内存派生（`next-departures.ts`）、
 * 直连路由**共用本实现** ⇒ 单一算法、无三重实现（ADR-101）。
 *
 * ⚠️ 纯函数：**无 DB、无 IO、无 Date** —— 可单测、可离线跑、可内存跑。
 * ⚠️ 站序常量与原型 `.verify/lrt-tpl-chain.mjs` 的 `ORDER` 对齐（api 码域，非本库 db_code）。
 */
import { rowOffsetsOf, type LrtTimetableMinutes } from "./eta";

/** 输入行 = `lrt_timetables` 的最小列集（不含 fetched_at）；字段名与库列一致（snake_case） */
export interface PatternInputRow {
  /** motransportinfo 站 id（`BAR` / `OCE` / …） */
  api_station: string;
  /** `'TPL' | 'SPVL' | 'HQL'` */
  route_no: string;
  /** 终点站 api 码：`'TFT' | 'BAR'`（氹仔线） */
  direction: string;
  /** `'mon_thurs' | 'fri' | 'sat_sun_holiday'` */
  day_type: string;
  minutes: { hour: number; minutes: number[] }[];
}

/** 参与模式判定的唯一线路（氹仔线） */
export const LRT_PATTERN_ROUTE_NO = "TPL";

/**
 * 氹仔线各方向「有发车行的 12 站」顺序（api 码域）。
 * key = **终点站** api 码；终点站自身无时刻行，故不含在数组里（12 站 / 11 段）。
 * ⚠️ 与 `.verify/lrt-tpl-chain.mjs` 的 `ORDER` **逐字对齐**，勿改顺序。
 */
export const LRT_TPL_ORDER: Record<string, string[]> = {
  TFT: ["BAR", "OCE", "JOC", "STA", "PAK", "COW", "LOT", "UH", "EAG", "COE", "MUS", "AIR"],
  BAR: ["TFT", "AIR", "MUS", "COE", "EAG", "UH", "LOT", "COW", "PAK", "STA", "JOC", "OCE"],
};

/**
 * 各方向**逐段最小间隔**（分钟）——即链式反推的物理下限（与 `.verify/lrt-tpl-chain2.mjs` 的
 * `MIN` 对齐，stats 亦用此口径）。
 *
 * 为什么需要：naive 口径「每跳只取 > t」会把「妈阁发车后 1 分钟就到的海洋发车」接成同一趟链
 *   —— 但媽閣→海洋跨海段 ~4~5 分钟**不可能** 1 分钟走完 ⇒ 那 1 分钟差是**两趟不同车的错接**，
 *   会产出伪模式 `12322213132`（现网 ~7%），把这批本该是 `42322213132` 的班次挤成「无模式」。
 *   加上首跳跨海下限 4 分后，链与实测/统计（`14` 号 A2：正向 `42322213132` 23.0~29.7%）吻合。
 *
 * ⚠️ 这不是「硬编码模式串」：它是**相邻站最小运行时间**这一物理常量（其余段 1 分）。
 *    生产端唯一依据 = `.verify/lrt-tpl-stats.mjs` 的 `MIN`（本表逐字对齐）。
 */
export const LRT_TPL_MIN_GAP: Record<string, number[]> = {
  TFT: [4, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], // 首跳 媽閣→海洋（跨海）下限 4 分
  BAR: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
};

/**
 * 站班次键（**查询方与构建方必须一致**）。
 * `depMin` 一律为「服务日 00:00 起分钟偏移」（hour 可 >23），与 `eta.ts#rowOffsetsOf` 同轴。
 */
export function lrtPatternKey(
  api_station: string,
  route_no: string,
  direction: string,
  day_type: string,
  depMin: number,
): string {
  return `${api_station}|${route_no}|${direction}|${day_type}|${depMin}`;
}

/** 升序数组中取「满足 v − t ≥ minGap」的最小值；无 → null（二分） */
function firstAfter(arr: number[], t: number, minGap: number): number | null {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] - t >= minGap) hi = mid;
    else lo = mid + 1;
  }
  return lo < arr.length ? arr[lo] : null;
}

/** 一条完整链的相邻间隔序列（joined string）= 模式编号；长度必为 `order.length - 1` */
function patternOfChain(chain: number[]): string {
  let s = "";
  for (let i = 1; i < chain.length; i++) s += String(chain[i] - chain[i - 1]);
  return s;
}

/**
 * 由时刻表行链式反推「站班次 → 模式」。
 *
 * @returns 命中模式的映射（key = `lrtPatternKey`，value = 模式串）；
 *          **歧义 / 截断 / 非氹仔线 → 不入映射**（视为无模式 ⇒ 回落分钟级，不猜）。
 *
 * 边界（对 AC-64「不得猜测模式」）：
 *  1. 仅 `route_no === LRT_PATTERN_ROUTE_NO`（氹仔线）参与；其余线返回空 Map。
 *  2. 链不完整（收班截断 / 缺站行）→ **整链丢弃**。
 *  3. 同一 `lrtPatternKey` 被多条链覆盖**且给出不同模式**（歧义）→ **从映射中剔除**。
 *     （若多条链给出**同一**模式，则不构成歧义，保留 —— ADR-101 「歧义」即指结论不一致。）
 *  4. 不硬编码具体模式串；模式即链条产出的字符串。
 */
export function deriveStationPatterns(rows: PatternInputRow[]): Map<string, string> {
  // `${direction}|${day_type}` → 站 api 码 → 升序分钟偏移
  const grouped = new Map<string, Map<string, number[]>>();
  for (const r of rows) {
    if (r.route_no !== LRT_PATTERN_ROUTE_NO) continue;
    if (!LRT_TPL_ORDER[r.direction]) continue;
    const gk = `${r.direction}|${r.day_type}`;
    let byStation = grouped.get(gk);
    if (!byStation) {
      byStation = new Map<string, number[]>();
      grouped.set(gk, byStation);
    }
    // rowOffsetsOf：升序去重（hour 可 >23，与查询端同轴）
    byStation.set(r.api_station, rowOffsetsOf(r.minutes as LrtTimetableMinutes["minutes"]));
  }

  const out = new Map<string, string>();
  /** 已知结论不一致的键 —— 一旦进入即永久剔除（后续链不得再写入） */
  const conflicted = new Set<string>();

  for (const [gk, byStation] of grouped) {
    const sep = gk.indexOf("|");
    const direction = gk.slice(0, sep);
    const dayType = gk.slice(sep + 1);
    const order = LRT_TPL_ORDER[direction];
    if (!order) continue;
    const minGaps = LRT_TPL_MIN_GAP[direction] ?? order.map(() => 1);
    const head = byStation.get(order[0]);
    if (!head || !head.length) continue;

    for (const t0 of head) {
      // 逐站 firstAfter 链式推进（每跳满足「≥ 上站时刻 + 该段最小间隔」）
      const chain: number[] = [t0];
      let t = t0;
      let ok = true;
      for (let i = 1; i < order.length; i++) {
        const arr = byStation.get(order[i]) ?? [];
        const n = firstAfter(arr, t, Math.max(1, minGaps[i - 1] ?? 1));
        if (n === null) {
          ok = false;
          break;
        }
        chain.push(n);
        t = n;
      }
      // 边界 2：链不完整（收班截断 / 缺站行）→ 整链丢弃
      if (!ok || chain.length !== order.length) continue;

      const pattern = patternOfChain(chain);
      for (let i = 0; i < order.length; i++) {
        const key = lrtPatternKey(order[i], LRT_PATTERN_ROUTE_NO, direction, dayType, chain[i]);
        if (conflicted.has(key)) continue;
        const prev = out.get(key);
        if (prev === undefined) {
          out.set(key, pattern);
        } else if (prev !== pattern) {
          // 边界 3：歧义 → 剔除（且永久标记，防后续链重新写入）
          out.delete(key);
          conflicted.add(key);
        }
        // prev === pattern：同一结论，无需处理
      }
    }
  }

  return out;
}
