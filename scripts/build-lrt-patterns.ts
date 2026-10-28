/**
 * v3.2.0 数据入库：**离线模式权威表**（scripts/build-lrt-patterns.ts）
 * 用法：npm run db:build-lrt-patterns -- [local|cloud] [--apply|--rollback] [--allow-prod]
 *
 * ── 做什么（ADR-101 方案 C）───────────────────────────────────────────────
 *   读 `lrt_timetables`（氹仔线全量）→ 调 `src/lib/lrt/pattern.ts` 的**同一纯函数**
 *   `deriveStationPatterns` → 生成「每站每班一行」的 `lrt_station_patterns`。
 *   并打印**分布报表**，与 `14` 号 A2（`.verify/lrt-tpl-stats.txt`）对照验收。
 *
 * ── 刷新链路（team-lead 硬要求）───────────────────────────────────────────
 *   `lrt:refresh` = `lrt:fetch` → `db:build-lrt-patterns`（模式是时刻表的**派生数据**，
 *   刷新后必须同批重建，否则派生漂移）。
 *
 * ── 三种模式 ───────────────────────────────────────────────────────────
 *   缺省（无 --apply/--rollback）：**DRY-RUN**，只读；打印行数与分布报表（并做断言）。
 *   `--apply`：单事务「删本批（route_no=TPL）→ 全量重插」。
 *   `--rollback`：删除本批（route_no=TPL）全部行。
 *
 * ── 分布断言（AC-63）─────────────────────────────────────────────────────
 *   正向 `52222222222` ∈ [62.8%, 73.8%] · `42322213132` ∈ [23.0%, 29.7%]
 *   反向 `22222232222` ∈ [56.6%, 73.8%] · `13222222222` ∈ [20.3%, 30.7%]
 *   （按 (direction, day_type) 分组；越界 → 报表 FAIL 且退出码 1）
 *
 * 安全：会改数据 ⇒ 必须经 db-guard（非本地库需 --allow-prod）。
 */
import { Pool, type PoolClient } from "pg";
import { deriveStationPatterns, LRT_PATTERN_ROUTE_NO, type PatternInputRow } from "../src/lib/lrt/pattern";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const argv = process.argv.slice(2);
const target = argv.find((a) => a === "local" || a === "cloud") as "local" | "cloud" | undefined;
const APPLY = argv.includes("--apply");
const ROLLBACK = argv.includes("--rollback");

const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL)
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);

/** 模式表行（`lrt_station_patterns` 最小列集） */
export interface PatternRow {
  api_station: string;
  route_no: string;
  direction: string;
  day_type: string;
  dep_min: number;
  pattern: string;
}

/**
 * ★ 纯函数：`lrt_timetables` 行 → 模式表行（与 `next-departures` 预载的**同一实现**）。
 * 导出供一致性测试复用（`test-lrt-pattern-consistency`）。
 */
export function buildPatternRows(rows: PatternInputRow[]): PatternRow[] {
  const map = deriveStationPatterns(rows);
  const out: PatternRow[] = [];
  for (const [k, pattern] of map) {
    const parts = k.split("|");
    if (parts.length !== 5) continue;
    const [api_station, route_no, direction, day_type, depMinStr] = parts;
    out.push({ api_station, route_no, direction, day_type, dep_min: Number(depMinStr), pattern });
  }
  out.sort(
    (a, b) =>
      a.direction.localeCompare(b.direction) ||
      a.day_type.localeCompare(b.day_type) ||
      a.api_station.localeCompare(b.api_station) ||
      a.dep_min - b.dep_min,
  );
  return out;
}

/** ★ 纯函数：模式表行 → 映射（键域与 `pattern.ts#lrtPatternKey` 一致） */
export function patternsFromRows(rows: PatternRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of rows) {
    m.set(`${r.api_station}|${r.route_no}|${r.direction}|${r.day_type}|${r.dep_min}`, r.pattern);
  }
  return m;
}

/** 分布断言区间：方向 → 模式 → [lo%, hi%] */
const DIST_BOUNDS: Record<string, Record<string, [number, number]>> = {
  TFT: {
    "52222222222": [62.8, 73.8],
    "42322213132": [23.0, 29.7],
  },
  BAR: {
    "22222232222": [56.6, 73.8],
    "13222222222": [20.3, 30.7],
  },
};

/** 打印分布报表并返回越界项（对 AC-63 的分布断言） */
function reportDistribution(rows: PatternRow[]): string[] {
  // `${direction}|${day_type}` → pattern → count
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const g = `${r.direction}|${r.day_type}`;
    let m = groups.get(g);
    if (!m) {
      m = new Map<string, number>();
      groups.set(g, m);
    }
    m.set(r.pattern, (m.get(r.pattern) ?? 0) + 1);
  }

  const violations: string[] = [];
  console.log(`\n分布报表（按 方向|班别 分组；共 ${rows.length} 站班次行）：`);
  for (const [g, m] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [direction, dayType] = g.split("|");
    const total = [...m.values()].reduce((s, n) => s + n, 0);
    const bounds = DIST_BOUNDS[direction] ?? {};
    const parts = [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, n]) => {
        const pct = (n / total) * 100;
        const b = bounds[p];
        let mark = "";
        if (b) {
          const ok = pct >= b[0] - 0.05 && pct <= b[1] + 0.05;
          mark = ok ? "✅" : "⚠️";
          if (!ok) violations.push(`${direction}/${dayType}/${p}: ${pct.toFixed(1)}% ∉ [${b[0]}, ${b[1]}]`);
        }
        return `${p} ${pct.toFixed(1)}% ${mark}`.trim();
      });
    console.log(`  · ${direction} · ${dayType.padEnd(15)} (${total}) → ${parts.join("  ")}`);
  }
  return violations;
}

async function loadTplRows(pool: Pool): Promise<PatternInputRow[]> {
  const rows = (
    await pool.query(
      `SELECT api_station, route_no, direction, day_type, minutes
         FROM lrt_timetables WHERE route_no = $1`,
      [LRT_PATTERN_ROUTE_NO],
    )
  ).rows as PatternInputRow[];
  return rows;
}

async function applyReplace(pool: Pool, rows: PatternRow[]): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM lrt_station_patterns WHERE route_no = $1`, [LRT_PATTERN_ROUTE_NO]);
    // 批量插入（分块，避免参数上限）
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const values: unknown[] = [];
      const tuples = chunk.map((r, idx) => {
        const b = idx * 6;
        values.push(r.api_station, r.route_no, r.direction, r.day_type, r.dep_min, r.pattern);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
      });
      await client.query(
        `INSERT INTO lrt_station_patterns
           (api_station, route_no, direction, day_type, dep_min, pattern)
         VALUES ${tuples.join(",")}`,
        values,
      );
    }
    await client.query("COMMIT");
    console.log(`\n✅ 已提交事务（APPLY）：${rows.length} 行（先删后插，route_no=${LRT_PATTERN_ROUTE_NO}）。`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
    process.exit(1);
  }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(
    `模式：${APPLY ? "APPLY（将写库）" : ROLLBACK ? "ROLLBACK（将删除 TPL 全部行）" : "DRY-RUN（只读，不写库）"}`,
  );
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    const ttRows = await loadTplRows(pool);
    if (!ttRows.length) {
      console.error("❌ lrt_timetables 无 TPL 行（先跑 npm run lrt:fetch）");
      process.exit(1);
    }
    console.log(`\nTPL 时刻行：${ttRows.length} 行（应 = 12 站 × 2 方向 × 3 班别 = 72）`);

    const rows = buildPatternRows(ttRows);
    console.log(`派生模式行：${rows.length} 行（未命中模式的站班次不在其中 —— 属预期，回落分钟级）`);

    const violations = reportDistribution(rows);

    if (ROLLBACK) {
      const del = await pool.query(`DELETE FROM lrt_station_patterns WHERE route_no = $1`, [LRT_PATTERN_ROUTE_NO]);
      console.log(`\n✅ ROLLBACK 完成：删除 ${del.rowCount ?? 0} 行（route_no=${LRT_PATTERN_ROUTE_NO}）。`);
      return;
    }

    if (!APPLY) {
      console.log("\nDRY-RUN 结束：**未写库**。核对无误后加 `--apply` 执行。");
      if (violations.length) {
        console.error("\n❌ 分布断言失败（AC-63）：");
        for (const v of violations) console.error(`  · ${v}`);
        process.exit(1);
      }
      console.log("✅ 分布断言通过（AC-63）。");
      return;
    }

    await applyReplace(pool, rows);
    const after = (
      await pool.query(`SELECT count(*)::int AS n FROM lrt_station_patterns WHERE route_no = $1`, [
        LRT_PATTERN_ROUTE_NO,
      ])
    ).rows[0] as { n: number };
    console.log(`写后复核：lrt_station_patterns（TPL）现有 ${after.n} 行。`);
    console.log(`回滚：npm run db:build-lrt-patterns -- cloud --rollback --allow-prod`);
    if (violations.length) {
      console.error("\n⚠️ 注意：写库已成功，但分布断言有越界项（AC-63）——请人工复核。");
      for (const v of violations) console.error(`  · ${v}`);
      process.exit(1);
    }
  } finally {
    await pool.end();
  }
}

// 仅作为入口直接运行时执行（被 import 用于一致性测试时不跑）
if (process.argv[1] && /build-lrt-patterns\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error("✗", e);
    process.exit(1);
  });
}
