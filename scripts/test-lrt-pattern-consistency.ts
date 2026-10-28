/**
 * 模式一致性护栏：**表派生 == 内存派生**（scripts/test-lrt-pattern-consistency.ts · v3.2.0）
 *
 * ADR-101 方案 C 的防漂移护栏：离线脚本（`build-lrt-patterns` → 表）与预载内存派生
 * （`next-departures`）必须对**同一份时刻表快照**给出**逐行相等**的模式映射；
 * 时刻表刷新后两者若不同步 ⇒ 本测试变红。
 *
 * 断言：
 *   ① 往返：`deriveStationPatterns` == `patternsFromRows(buildPatternRows(...))`（离线转换无损）；
 *   ② 入库：若 `lrt_station_patterns`（TPL）已建且有行 → 与内存派生**逐行相等**；
 *      若表不存在/为空 → **SKIP**（提示先跑 migrate + build，不误报绿）。
 *
 * 运行：npm run test:lrt-pattern-consistency（= tsx scripts/test-lrt-pattern-consistency.ts）
 */
import { Pool } from "pg";
import { deriveStationPatterns, LRT_PATTERN_ROUTE_NO, type PatternInputRow } from "../src/lib/lrt/pattern";
import { buildPatternRows, patternsFromRows, type PatternRow } from "./build-lrt-patterns";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const connStr = process.env.DATABASE_URL ?? process.env.DATABASE_URL_LOCAL;
if (!connStr) {
  console.error("❌ 未找到连接串（.env 的 DATABASE_URL）");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}

/** 逐行相等比较（Map<string,string>）；返回不一致明细（最多 20 条） */
function diffMaps(a: Map<string, string>, b: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv === undefined) diffs.push(`仅 A 有：${k} = ${v}`);
    else if (bv !== v) diffs.push(`值不同：${k} A=${v} B=${bv}`);
    if (diffs.length >= 20) break;
  }
  if (diffs.length < 20) {
    for (const [k, v] of b) {
      if (!a.has(k)) {
        diffs.push(`仅 B 有：${k} = ${v}`);
        if (diffs.length >= 20) break;
      }
    }
  }
  return diffs;
}

async function main() {
  const pool = new Pool({ connectionString: connStr });
  console.log("模式一致性护栏：表派生 == 内存派生\n");

  try {
    const rows = (
      await pool.query(
        `SELECT api_station, route_no, direction, day_type, minutes
           FROM lrt_timetables WHERE route_no = $1`,
        [LRT_PATTERN_ROUTE_NO],
      )
    ).rows as PatternInputRow[];
    if (!rows.length) {
      console.error("❌ lrt_timetables 无 TPL 行（先跑 npm run lrt:fetch）");
      process.exit(1);
    }
    console.log(`TPL 时刻行：${rows.length} 行\n`);

    // ── ① 内存派生 ──
    const mem = deriveStationPatterns(rows);

    // ── ② 离线转换往返（buildPatternRows → patternsFromRows）──
    const built = buildPatternRows(rows);
    const roundtrip = patternsFromRows(built);
    const rtDiff = diffMaps(mem, roundtrip);
    assert(mem.size === roundtrip.size, `往返行数相等（${mem.size}）`);
    assert(rtDiff.length === 0, "往返逐行相等（离线转换无损）");
    for (const d of rtDiff) console.error(`      · ${d}`);

    // ── ③ 与入库表逐行相等（表不存在/为空 → SKIP）──
    let dbRows: PatternRow[] = [];
    let tableMissing = false;
    try {
      dbRows = (
        await pool.query(
          `SELECT api_station, route_no, direction, day_type, dep_min, pattern
             FROM lrt_station_patterns WHERE route_no = $1`,
          [LRT_PATTERN_ROUTE_NO],
        )
      ).rows as PatternRow[];
    } catch {
      tableMissing = true;
    }

    if (tableMissing || dbRows.length === 0) {
      console.log(
        `\n⚠️ SKIP：lrt_station_patterns 未建或无行（${tableMissing ? "表不存在" : "0 行"}）` +
          ` —— 先跑 db:migrate-v3200 + db:build-lrt-patterns --apply 再复跑本测试。`,
      );
      console.log("   （往返断言①已通过：内存派生与离线转换一致。）");
    } else {
      const fromDb = patternsFromRows(dbRows);
      const dbDiff = diffMaps(mem, fromDb);
      assert(mem.size === fromDb.size, `表派生与内存派生行数相等（表 ${fromDb.size} / 内存 ${mem.size}）`);
      assert(dbDiff.length === 0, "表派生 == 内存派生（逐行相等）");
      for (const d of dbDiff) console.error(`      · ${d}`);
    }
  } finally {
    await pool.end();
  }

  console.log("\n" + (fail === 0 ? "✅ 通过" : "❌ 有失败") + "：pass=" + pass + " fail=" + fail);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
