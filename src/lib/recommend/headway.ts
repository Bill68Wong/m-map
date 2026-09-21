/**
 * 发车间隔查询（src/lib/recommend/headway.ts，2026-09-21 新增）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   为「未发车」的线路推算**下一班等待时间**（配合 `live.ts` 的估算逻辑）。
 *   数据来自 `route_frequency` 表（来源与抓取见 `scripts/fetch-bus-frequency.ts`）。
 *
 * ── 为什么单独一个模块 ────────────────────────────────────────────────
 *   1. **纯查询 + 纯判定**，不碰实时链路 ⇒ 可单测、可独立验证；
 *   2. 把「日期类型匹配」这条易错逻辑（5 种写法 × 平日/周六/周日/假期）集中一处；
 *   3. `live.ts` 只需调用 `headwayAt()`，不必关心 SQL 与假期表。
 *
 * ── 日期类型匹配口径 ──────────────────────────────────────────────────
 *   抓取得到的 `day_type` 共 7 种（见 `scripts/fetch-bus-frequency.ts` 的 `DAY_TYPE_MAP`）：
 *     `daily` 每日 · `mon_sat` 星期一至六 · `mon_fri` 星期一至五 ·
 *     `sat` 星期六 · `sun_holiday` 星期日及公眾假期 ·
 *     `sat_sun_holiday` 星期六日及公眾假期 · `special` 临时措施（**不参与**自动匹配）
 *   ⚠️ `special` 是「特定日历日期」的临时班次，**不是周期规则** ⇒ 本模块**显式排除**它，
 *      避免把它误当成「每天都适用」。
 *   ⚠️ **假期一律按「非工作日」处理**：澳门公众假期落在周一~周五时，
 *      页面用的是「星期日及公眾假期」那一档（与轻轨 `day-type.ts` 口径一致）。
 */
import type { Pool } from "pg";
import { macauNowParts, type MacauNowParts } from "@/lib/lrt/day-type";

/** `route_frequency` 的一行（只取本模块用得到的列） */
export interface FreqRow {
  dayType: string;
  timeFrom: string;
  timeTo: string;
  fromMin: number;
  /** ⚠️ 跨午夜时段（如 20:00-01:15）会 > 1440，表示**次日** */
  toMin: number;
  freqLo: number;
  freqHi: number;
}

export interface HeadwayIndex {
  /** 线路码 → 该线全部时段行 */
  byRoute: Map<string, FreqRow[]>;
  /** 澳门公众假期（'YYYY-MM-DD'）—— 与轻轨共用 `lrt_holidays` */
  holidays: Set<string>;
  /** 载入的行数（诊断用） */
  size: number;
}

/** 该 `day_type` 是否适用于「今天」 */
export function matchesDayType(dayType: string, weekday: number, isHoliday: boolean): boolean {
  switch (dayType) {
    case "daily":
      return true;
    case "mon_sat":
      return !isHoliday && weekday >= 1 && weekday <= 6;
    case "mon_fri":
      return !isHoliday && weekday >= 1 && weekday <= 5;
    case "sat":
      return !isHoliday && weekday === 6;
    case "sun_holiday":
      return isHoliday || weekday === 0;
    case "sat_sun_holiday":
      return isHoliday || weekday === 0 || weekday === 6;
    // ⚠️ special（临时措施）与 unknown 一律不参与自动匹配
    default:
      return false;
  }
}

/** 载入发车间隔索引（模块级缓存，调用方传入 pool；行数很小，全量进内存） */
const CACHE_TTL_MS = 10 * 60_000;
let cache: { at: number; idx: HeadwayIndex } | null = null;

export async function loadHeadway(pool: Pool, force = false): Promise<HeadwayIndex> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.idx;

  const rows = (
    await pool.query(
      `SELECT route_code, day_type, time_from, time_to, from_min, to_min, freq_lo, freq_hi
         FROM route_frequency
        WHERE day_type <> 'special'`,
    )
  ).rows as {
    route_code: string;
    day_type: string;
    time_from: string;
    time_to: string;
    from_min: number;
    to_min: number;
    freq_lo: number;
    freq_hi: number;
  }[];

  const byRoute = new Map<string, FreqRow[]>();
  for (const r of rows) {
    const list = byRoute.get(r.route_code);
    const row: FreqRow = {
      dayType: r.day_type,
      timeFrom: r.time_from,
      timeTo: r.time_to,
      fromMin: Number(r.from_min),
      toMin: Number(r.to_min),
      freqLo: Number(r.freq_lo),
      freqHi: Number(r.freq_hi),
    };
    if (list) list.push(row);
    else byRoute.set(r.route_code, [row]);
  }

  // 假期表：与轻轨共用 `lrt_holidays`（列名用 information_schema 探测，避免写死）
  const holidays = new Set<string>();
  try {
    const cols = (
      await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'lrt_holidays'`,
      )
    ).rows as { column_name: string }[];
    const col = ["date", "ymd", "day", "holiday_date"].find((c) => cols.some((x) => x.column_name === c));
    if (col) {
      const hs = (await pool.query(`SELECT ${col}::text AS d FROM lrt_holidays`)).rows as { d: string }[];
      for (const h of hs) holidays.add(String(h.d).slice(0, 10));
    }
  } catch {
    /* 假期表不可用 ⇒ 退化为「只按星期判定」（保守：可能把假期当工作日） */
  }

  const idx: HeadwayIndex = { byRoute, holidays, size: rows.length };
  cache = { at: Date.now(), idx };
  return idx;
}

export interface HeadwayHit {
  lo: number;
  hi: number;
  /** 命中的时段（诊断/展示用，如 `06:00-10:00`） */
  span: string;
  dayType: string;
  /** true = 该时段跨午夜（`toMin > 1440`） */
  crossesMidnight: boolean;
}

/**
 * 查「此刻」该线路的发车间隔。
 *
 * @param idx      `loadHeadway()` 的结果
 * @param route    线路码（如 `26A`）
 * @param nowMs    时间基准（默认现在）
 * @returns 命中则给出**区间** `[lo, hi]`；未覆盖该线路/时段 ⇒ `null`（调用方走降级）
 *
 * ⚠️ 跨午夜处理：`20:00 - 01:15` 这类时段的 `toMin` 已 +1440（次日）。
 *    因此「凌晨 00:30」要同时匹配**前一天的该时段** ⇒ 用 `nowMin` 与 `nowMin + 1440` 各试一次。
 */
export function headwayAt(
  idx: HeadwayIndex,
  route: string,
  nowMs?: number,
): HeadwayHit | null {
  const list = idx.byRoute.get(route);
  if (!list || !list.length) return null;

  const parts: MacauNowParts = macauNowParts(nowMs ? new Date(nowMs) : undefined);
  const isHoliday = idx.holidays.has(parts.ymd);
  const nowMin = Math.floor(parts.daySec / 60);
  // 候选：今日分钟 + 昨日跨午夜段（用 +1440 对齐）
  const probes = [nowMin, nowMin + 1440];
  // 优先级：越具体越优先（sat_sun_holiday > sun_holiday > sat > mon_fri > mon_sat > daily）
  const PRIORITY = ["sat_sun_holiday", "sun_holiday", "sat", "mon_fri", "mon_sat", "daily"];

  let best: HeadwayHit | null = null;
  let bestPri = PRIORITY.length;
  for (const row of list) {
    if (!matchesDayType(row.dayType, parts.weekday, isHoliday)) continue;
    for (const t of probes) {
      if (t >= row.fromMin && t <= row.toMin) {
        const pri = PRIORITY.indexOf(row.dayType);
        if (pri >= 0 && pri < bestPri) {
          bestPri = pri;
          best = {
            lo: row.freqLo,
            hi: row.freqHi,
            span: `${row.timeFrom}-${row.timeTo}`,
            dayType: row.dayType,
            crossesMidnight: row.toMin > 1440,
          };
        }
        break;
      }
    }
  }
  return best;
}

/** 供诊断/测试：清空缓存 */
export function _clearHeadwayCache(): void {
  cache = null;
}
