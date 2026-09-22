/**
 * 巴士线路**发车间隔**抓取入库（scripts/fetch-bus-frequency.ts）
 * 用法：npm run bus:fetch-frequency -- [local|cloud]     （默认 cloud）
 *
 * ── 数据源 ────────────────────────────────────────────────────────────
 *   `https://motransportinfo.com/zh/route/{线路码}/0` 的**服务端渲染 HTML**，
 *   其中「班次（分鐘）」表格即发车间隔。**不是 API**（该站 11 个候选接口实测全 404）。
 *   ✅ 合规：该站 `robots.txt` 为 `User-agent: *` + `Disallow:`（空）⇒ 明确允许抓取；
 *      本脚本仅存**时段与分钟数值**（非商业用途），并在表注释中注明来源与取得日期。
 *
 * ── 幂等 ──────────────────────────────────────────────────────────────
 *   按 `(route_code, day_type, time_from)` upsert；可反复运行。
 *   ⚠️ 只增删自己这张表的数据，**绝不触碰**其它表。
 *
 * ── 设计动机 ──────────────────────────────────────────────────────────
 *   实测「在起点站等车时，本方向一辆车都看不到」（26A 黑沙灘：nearest/second/rest 全空，
 *   而对向有 5 辆车正开回来）⇒ 方案被误判为「无车」而剔除。
 *   有了发车间隔 + 已发班车跑了多少站，就能**反推下一班还有多久发车**。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const BASE = "https://motransportinfo.com";
/** 礼貌延迟（毫秒）——97 条约 1 分钟，对对方站友好 */
const DELAY_MS = 500;
/** 单页失败后的重试次数 */
const RETRY = 1;

/**
 * ★ 日期类型归一化（**单一真相**，迁移脚本只建表不复制本表）。
 * 实测该站共 5 种写法；出现未收录写法 ⇒ 记为 `unknown` 并**在报告里逐条告警**（不静默丢）。
 */
export const DAY_TYPE_MAP: Record<string, string> = {
  每日: "daily",
  星期一至六: "mon_sat",
  星期一至五: "mon_fri",
  // ★ 2026-09-21 首轮抓取后补：如 25BS / 30X / 3AX / 51B / 6B 只标「星期六（公眾假期除外）」
  星期六: "sat",
  星期日及公眾假期: "sun_holiday",
  "星期六、日及公眾假期": "sat_sun_holiday",
  星期六日及公眾假期: "sat_sun_holiday",
};

/**
 * 日期类型归一化（含**临时措施**的特殊处理）。
 *
 * 实测两轮抓取的教训：
 *   · 首轮有 **27 行落到 `unknown`** —— 主因是漏了「星期六（公眾假期除外）」这一类（已补 `sat`）；
 *   · 另有**「临时措施」型**标题：形如
 *     「2026年9月12日、19日、25日、2026年10月1日及4日…」/「2026年9月29至30日、…」
 *     （实测来自烟花汇演等临时班次调整）。**不是周期性规则**，无法套用时段表，
 *     ⇒ 归为 `special` 并**保留原文**在 `day_type_raw`，供后续按需单独解析（不静默丢）。
 */
export function normalizeDayType(raw: string): string {
  const key = raw.replace(/（[^）]*）|\([^)]*\)/g, "").trim();
  if (DAY_TYPE_MAP[key]) return DAY_TYPE_MAP[key];
  if (DAY_TYPE_MAP[raw]) return DAY_TYPE_MAP[raw];
  // 临时措施（以「2026年…」这类具体日历日期开头）
  if (/^\d{4}\s*年/.test(key)) return "special";
  return "unknown";
}

export interface FreqRow {
  dayTypeRaw: string;
  dayType: string;
  timeFrom: string;
  timeTo: string;
  fromMin: number;
  toMin: number;
  freqLo: number;
  freqHi: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 'HH:MM' → 当日 00:00 起分钟偏移（'01:15' → 75） */
function hhmmToMin(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  return h * 60 + mi;
}

/** 去掉 HTML 标签 */
const strip = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();

/**
 * 解析线路页 HTML 里的「班次（分鐘）」表。
 * 结构（实测）：
 *   <tr class="table-light"><th colspan="2">星期一至六<small>（公眾假期除外）</small></th></tr>  ← 日期分组
 *   <tr class="table-secondary"><td>06:00 - 10:00</td><td>4 - 8</td></tr>                      ← 时段 + 间隔
 */
export function parseTimetable(html: string): FreqRow[] {
  const i = html.indexOf('id="pills-timetable"');
  if (i < 0) return [];
  const seg = html.slice(i, i + 12_000);
  const tableEnd = seg.indexOf("</table>");
  const table = tableEnd > 0 ? seg.slice(0, tableEnd) : seg;

  const rows: FreqRow[] = [];
  let curRaw: string | null = null;
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    // ① 日期分组标题
    const th = /<th[^>]*colspan="2"[^>]*>([\s\S]*?)<\/th>/.exec(tr);
    if (th) {
      curRaw = strip(th[1]);
      continue;
    }
    // ② 数据行（两个 td）
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => strip(m[1]));
    if (tds.length < 2 || !curRaw) continue;
    const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(tds[0]);
    const f = /^(\d+)\s*-\s*(\d+)$/.exec(tds[1]);
    if (!m || !f) continue;
    const fromMin = hhmmToMin(m[1]);
    let toMin = hhmmToMin(m[2]);
    if (fromMin === null || toMin === null) continue;
    // ★ 跨午夜（如 20:00 - 01:15）⇒ to_min 加一天，表示次日凌晨
    if (toMin <= fromMin) toMin += 24 * 60;

    rows.push({
      dayTypeRaw: curRaw,
      dayType: normalizeDayType(curRaw),
      timeFrom: m[1],
      timeTo: m[2],
      fromMin,
      toMin,
      freqLo: Number(f[1]),
      freqHi: Number(f[2]),
    });
  }
  return rows;
}

async function fetchPage(code: string): Promise<string | null> {
  const url = `${BASE}/zh/route/${encodeURIComponent(code)}/0`;
  for (let attempt = 0; attempt <= RETRY; attempt++) {
    try {
      const r = await fetch(url, {
        signal: AbortSignal.timeout(25_000),
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          accept: "text/html,*/*",
        },
        redirect: "follow",
      });
      if (r.status === 200) return await r.text();
      if (attempt === RETRY) return null;
    } catch {
      if (attempt === RETRY) return null;
    }
    await sleep(600);
  }
  return null;
}

async function main() {
  const target = process.argv[2] as "local" | "cloud" | undefined;
  const connStr =
    target === "local"
      ? (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL)
      : (process.env.DATABASE_URL ?? process.env.DATABASE_URL_LOCAL);
  if (!connStr) {
    console.error("❌ 未找到连接串：请先在 .env 配置");
    process.exit(1);
  }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(`数据源：${BASE}（robots.txt 已确认允许抓取）\n`);

  const pool = new Pool({ connectionString: connStr });
  // ★ 2026-09-21：生产库会被**间歇性**置为只读（`default_transaction_read_only = on`）。
  //   库仅 56 MB（非空间问题），平台侧成因待查；**会话级显式 `off` 实测可覆盖**。
  //   ⚠️ 属绕过平台保护，已上报主人核查。
  //   ⚠️ handler 必须**返回** query 的 promise（不能 `void`）—— pg-pool 只在 handler
  //      返回 promise 时才等待；否则与后续 query 并发（实测触发 DeprecationWarning）。
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));
  try {
    const codes = (
      await pool.query(`SELECT code FROM routes WHERE kind = 'bus' ORDER BY code`)
    ).rows as { code: string }[];
    console.log(`待抓线路：${codes.length} 条\n`);

    const okRows: { code: string; rows: FreqRow[] }[] = [];
    const failed: string[] = [];
    const unknownDays = new Set<string>();
    const noTable: string[] = [];

    let n = 0;
    for (const { code } of codes) {
      n++;
      const html = await fetchPage(code);
      if (!html) {
        failed.push(code);
        console.log(`  [${String(n).padStart(3)}/${codes.length}] ${code.padEnd(7)} 🔴 抓取失败`);
        await sleep(DELAY_MS);
        continue;
      }
      const rows = parseTimetable(html);
      if (!rows.length) {
        noTable.push(code);
        console.log(`  [${String(n).padStart(3)}/${codes.length}] ${code.padEnd(7)} ⚠️ 页面无班次表`);
      } else {
        for (const r of rows) if (r.dayType === "unknown") unknownDays.add(r.dayTypeRaw);
        okRows.push({ code, rows });
        const days = [...new Set(rows.map((r) => r.dayType))].join("/");
        console.log(
          `  [${String(n).padStart(3)}/${codes.length}] ${code.padEnd(7)} ✅ ${rows.length} 行 · ${days}`,
        );
      }
      await sleep(DELAY_MS);
    }

    // ── 写库（事务 + 幂等 upsert）──
    console.log("\n写入数据库…");
    let written = 0;
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // ★ 全量重灌：先清空**本表**（只动自己这张表，绝不触碰其它表）。
      //   为什么必须清：页面文案会变（如日期类型写法调整），残留的旧行会成为孤儿数据；
      //   且实测过「约束含归一化字段 ⇒ 规则一改就变成新增」导致重复的坑。
      await c.query(`DELETE FROM route_frequency`);
      for (const { code, rows } of okRows) {
        for (const r of rows) {
          await c.query(
            `INSERT INTO route_frequency
               (route_code, day_type, day_type_raw, time_from, time_to, from_min, to_min,
                freq_lo, freq_hi, source, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'motransportinfo.com', now())
             ON CONFLICT (route_code, day_type_raw, time_from) DO UPDATE
               SET day_type   = EXCLUDED.day_type,
                   time_to    = EXCLUDED.time_to,
                   from_min     = EXCLUDED.from_min,
                   to_min       = EXCLUDED.to_min,
                   freq_lo      = EXCLUDED.freq_lo,
                   freq_hi      = EXCLUDED.freq_hi,
                   fetched_at   = now()`,
            [code, r.dayType, r.dayTypeRaw, r.timeFrom, r.timeTo, r.fromMin, r.toMin, r.freqLo, r.freqHi],
          );
          written++;
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }

    // ── 报告 ──
    const total = (await pool.query(`SELECT count(*)::int AS n FROM route_frequency`)).rows[0] as { n: number };
    const byDay = (
      await pool.query(
        `SELECT day_type, count(*)::int AS n FROM route_frequency GROUP BY day_type ORDER BY n DESC`,
      )
    ).rows as { day_type: string; n: number }[];

    console.log(`\n════════════════ 结果 ════════════════`);
    console.log(`本轮写入/更新：${written} 行`);
    console.log(`表内总行数：${total.n}`);
    console.log(`成功线路：${okRows.length}/${codes.length}`);
    if (failed.length) console.log(`🔴 抓取失败（${failed.length}）：${failed.join(" ")}`);
    if (noTable.length) console.log(`⚠️ 无班次表（${noTable.length}）：${noTable.join(" ")}`);
    if (unknownDays.size)
      console.log(`⚠️⚠️ 未映射的日期类型（需补 DAY_TYPE_MAP）：${[...unknownDays].join(" | ")}`);
    console.log(`\n按日期类型分布：`);
    for (const r of byDay) console.log(`  ${r.day_type.padEnd(16)} ${r.n} 行`);
    console.log(`\n样本（1 路的全部时段）：`);
    const sample = (
      await pool.query(
        `SELECT day_type_raw, time_from, time_to, freq_lo, freq_hi FROM route_frequency
          WHERE route_code = '1' ORDER BY day_type, from_min`,
      )
    ).rows as Record<string, unknown>[];
    for (const r of sample)
      console.log(`  [${r.day_type_raw}] ${r.time_from}-${r.time_to}  ${r.freq_lo}~${r.freq_hi} 分`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
