/**
 * 澳门公众假期缓存（src/lib/rebuild/holidays.ts，v3.5.5）
 *
 * 数据源：`lrt_holidays` 表（澳门特别行政区公众假期，source=macau_gov；与轻轨运营共用）。
 * 用途：分桶的「节假日按周末逻辑」判定（查询侧 + 聚合侧）；发车间隔（headway.ts）另有自己的加载。
 * 缓存：模块级懒加载 + TTL 6 小时（假期表变化极低频）；表缺失 → 空集（等价无节假日支持，不阻断）。
 */
import type { Pool } from "pg";
import { nowBucketOf } from "./buckets";

const TTL_MS = 6 * 3600_000;
let cache: { at: number; set: Set<string> } | null = null;

export async function getHolidays(pool: Pool): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.set;
  const set = new Set<string>();
  try {
    // ⚠️ holiday_date 为 **date 类型**——必须用 `::text` 直读（输出即 YYYY-MM-DD）。
    //    切勿改用 JS Date 转换：node-pg 会把 date 解析成「本地午夜」的 Date，
    //    `toISOString()` 在 GMT+8 下会回退一天（曾致 9-26「中秋節翌日」被误读为 9-25）。
    const r = await pool.query(`SELECT holiday_date::text AS d FROM lrt_holidays`);
    for (const row of r.rows as { d: string }[]) set.add(String(row.d).slice(0, 10));
  } catch {
    /* 表缺失/查询失败 → 空集（不阻断；查询退化为「无节假日支持」） */
  }
  cache = { at: Date.now(), set };
  return set;
}

/** 由 epoch ms 取澳门日期串（YYYY-MM-DD） */
export const macauDayOf = (ms: number): string => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

/** ★ 节假日感知的「当前桶」——server 侧统一入口（查假期表 → queryBucketOf）。 */
export async function nowBucketOfHolidayAware(pool: Pool, ms: number): Promise<string> {
  const hol = await getHolidays(pool);
  return nowBucketOf(ms, hol.has(macauDayOf(ms)));
}
