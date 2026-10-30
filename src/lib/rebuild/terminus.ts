/**
 * 总站集合（terminus）—— 判据的**基石层**（src/lib/rebuild/terminus.ts，v3.6.0）
 *
 * 为什么从 `long-stop.ts` 拆出来：该文件已承载「三道前置门 + 四计数 + 策略装配」，
 * 再塞进站序 SQL 与归一函数会越过单文件 300 行门禁，且两者是**不同职责**：
 *   · 本文件 = 「什么算总站」，纯集合运算，无阈值、无业务判断，可单测
 *   · `long-stop.ts` = 「长停样本该不该排除」，含阈值与门的编排
 * 拆开后 `segments-stats.ts` 只需 import 本文件即可拿到 `mainOf`（最常用的归一函数）。
 *
 * ⚠️ 归一函数（`mainOf` / SQL 里的 `regexp_replace`）必须**同义**，
 *    否则 JS 侧与 SQL 侧算出的总站集合永远不可能相等 —— 对拍护栏会变成「常红」而被人忽略。
 *    校验入口：`.verify/check-terminus-parity.mjs`（不一致即 exit 1）。
 */

/** 站码主码归一：`C690/3` → `C690`；无数字的码（如 `LRT-BAR`）**原样返回**。
 *  与 SQL 侧 `regexp_replace(station_code, '(^[A-Za-z]+[0-9]+).*$', '\1')` 同义。 */
export const mainOf = (code: string) => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;

export interface RouteStopSeqRow {
  route: string;
  dir: string;
  seq: number;
  station_code: string;
}

/** 站序原始行（两处共用；避免各写一条 SQL）。
 *
 * ⚠️ **只取 bus**（`r.kind='bus'`）：总站集合的唯一用途是长停站判据，
 *    而长停判据只作用于巴士 —— 轻轨有固定班表，不存在「司机休息」这类长停，
 *    也不走 segment_samples 的 dwell 口径。把 LRT 收进来只会让对拍两侧范围不一致
 *    （轻轨站码形如 `LRT-氹仔線`，无数字后缀，归一后与巴士站码不同族），
 *    制造「仅左有 N 个 LRT-*」这类真差集之外的噪声。
 *    实测：候选长停样本 921 条**全部**是巴士，LRT 0 条 ⇒ 加此限定对排除面零影响。 */
export const ROUTE_SEQ_SQL = `SELECT r.code AS route, rs.dsat_dir AS dir, rs.seq, rs.station_code
  FROM route_stations rs JOIN routes r ON r.id = rs.route_id
 WHERE r.kind = 'bus'`;

/**
 * 总站主码集合 = 任一线路任一方向的 seq=1 或 seq=max。
 *
 * ⚠️ 用**全澳并集**而非「本线端点」：(route, 站) 对级会漏掉本 bug 的核心样例 ——
 *    C654 聯生圓形地是 59 路总站、却是 25/26/26A/50/21A 的**中途站**，26 路在此休息。
 *    实测 status=1 且 ≥3 分的 11,182 段里，「别线总站/本线中途」233 段（2.1%）全是真实总站待发。
 *
 * 与 SQL 版（`TERMINUS_SQL`）逐行等价：`route_stations.seq` 在 schema 里是 `INT NOT NULL`
 * 且有 `UNIQUE (route_id, dsat_dir, seq)` ⇒ 不存在 seq 为 NULL 导致 `count(*)` 窗口偏差的情况。
 */
export function terminusMains(rows: RouteStopSeqRow[]): Set<string> {
  const maxSeq = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.route}|${r.dir}`;
    if (r.seq > (maxSeq.get(k) ?? 0)) maxSeq.set(k, r.seq);
  }
  const out = new Set<string>();
  for (const r of rows)
    if (r.seq === 1 || r.seq === maxSeq.get(`${r.route}|${r.dir}`)) out.add(mainOf(r.station_code));
  return out;
}

/**
 * 一致性断言用的**独立实现**（SQL 版），只供对拍，不参与过滤。
 *
 * ⚠️ 归一表达式必须与 `mainOf` **同义**，否则对拍永远不可能相等、护栏等于没挂：
 *    · `C690/3` ⇒ `C690`（剥站台号）
 *    · `LRT-BAR` ⇒ `LRT-BAR`（无数字，原样返回）
 *    旧实现 `regexp_replace(station_code, '[^A-Za-z0-9].*$', '')` 把 `LRT-BAR` 压成 `LRT`
 *    ⇒ 轻轨总站全部漏判，还凭空造出一个垃圾值 `LRT`（实测 JS 52 vs SQL 47、对拍常红）。
 *    现写法 `(^[A-Za-z]+[0-9]+).*$ → \1`：匹配到就取该前缀，匹配不到整条不替换。
 *
 * 返回列：`m` = 归一后的主码；`route`/`dir`/`seq` 供差集定位到「哪条线哪个方向哪一站」。
 *
 * ⚠️ 范围必须与 `ROUTE_SEQ_SQL` **完全一致**（同样 `r.kind='bus'`）：
 *    两处取不同范围会让对拍长期红在「仅左有 N 个 LRT-*」上 —— 那不是真差集，
 *    是范围不一致；红久了就没人看，护栏等于失效。
 */
export const TERMINUS_SQL = `SELECT DISTINCT
         regexp_replace(rs.station_code, '(^[A-Za-z]+[0-9]+).*$', '\\1') AS m,
         r.code AS route,
         rs.dsat_dir AS dir,
         rs.seq
  FROM route_stations rs JOIN routes r ON r.id = rs.route_id
 WHERE r.kind = 'bus'
   AND EXISTS (
   SELECT 1 FROM (
     SELECT route_id, dsat_dir, seq,
            row_number() OVER (PARTITION BY route_id, dsat_dir ORDER BY seq) AS rn,
            count(*)     OVER (PARTITION BY route_id, dsat_dir)            AS cnt
       FROM route_stations) x
    WHERE x.route_id = rs.route_id AND x.dsat_dir = rs.dsat_dir
      AND x.seq = rs.seq AND (x.rn = 1 OR x.rn = x.cnt))`;
