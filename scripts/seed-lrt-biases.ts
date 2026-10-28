/**
 * v3.2.0 数据入库：**轻轨逐站/逐模式偏差**（scripts/seed-lrt-biases.ts）
 * 用法：npm run db:seed-lrt-biases -- [local|cloud] [--apply|--rollback] [--allow-prod]
 *
 * ── 写什么（56 行 · 与 06 §6 逐行一致）────────────────────────────────────
 *   · 氹仔线（`LRT-氹仔线`）：4 模式 × 13 站 = 52 行（四模式本就方向专属，勿再 × 方向）
 *       · dir=`TFT`（媽閣→氹仔碼頭）：`52222222222` · `42322213132`
 *       · dir=`BAR`（氹仔碼頭→媽閣）：`22222232222` · `13222222222`（含路氹東 132 勘误）
 *   · 石排湾线（`LRT-石排湾线`）：2 行（`pattern='default'`，线路级）
 *   · 横琴线（`LRT-横琴线`）：2 行（`pattern='default'`，线路级）
 *
 * ── 三种模式 ───────────────────────────────────────────────────────────
 *   缺省（无 --apply/--rollback）：**DRY-RUN**，只读；打印行数 / 校验 / 分布。
 *   `--apply`：单事务 upsert 全部 56 行。
 *   `--rollback`：删除本批范围（三条线路）的全部行。
 *
 * ── 校验（DRY-RUN/APPLY 均先跑，任一失败即中止、不写库）────────────────────
 *   ① 行数 = 56；② `pattern` ∈ 四主力串 ∪ {default}；③ 氹仔线每 (direction,pattern) 恰 13 行；
 *   ④ `dep_bias_sec ∈ [-35, 90]`；⑤ 起点站 `arr=null`、终点站 `arr=dep=null`；
 *   ⑥ **一致性断言**：石排湾/横琴 `dep_bias_sec` == `lrt_route_params.dep_bias_sec`（−5 / +40）。
 *
 * 安全：会改数据 ⇒ 必须经 db-guard（非本地库需 --allow-prod）。
 */
import { Pool, type PoolClient } from "pg";
import { LRT_TPL_ORDER } from "../src/lib/lrt/pattern";

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

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
console.log(
  `模式：${APPLY ? "APPLY（将写库）" : ROLLBACK ? "ROLLBACK（将删除本批 56 行）" : "DRY-RUN（只读，不写库）"}`,
);

const LINE_TPL = "LRT-氹仔线";
const LINE_SPVL = "LRT-石排湾线";
const LINE_HQL = "LRT-横琴线";
const TPL_SOURCE = "手记实测 2026-09-26";
const TPL_MEASURED_ON = "2026-09-26";
const MAIN_PATTERNS = ["52222222222", "42322213132", "22222232222", "13222222222"] as const;

interface SeedRow {
  route_code: string;
  direction: string;
  pattern: string;
  api_station: string;
  arr_bias_sec: number | null;
  dep_bias_sec: number | null;
  source: string;
  measured_on: string;
  note: string | null;
}

/** 氹仔线一条模式：13 站（与 06 §6.1 逐行一致）；`arr`/`dep` = null 表示无该语义 */
function tplPattern(
  direction: string,
  pattern: string,
  stations: { api: string; arr: number | null; dep: number | null; note?: string }[],
): SeedRow[] {
  return stations.map((s) => ({
    route_code: LINE_TPL,
    direction,
    pattern,
    api_station: s.api,
    arr_bias_sec: s.arr,
    dep_bias_sec: s.dep,
    source: TPL_SOURCE,
    measured_on: TPL_MEASURED_ON,
    note: s.note ?? null,
  }));
}

const TPL_ROWS: SeedRow[] = [
  // ── dir=TFT · 52222222222（媽閣→氹仔碼頭）──
  ...tplPattern("TFT", "52222222222", [
    { api: "BAR", arr: null, dep: 25 },
    { api: "OCE", arr: -5, dep: 10 },
    { api: "JOC", arr: -15, dep: 5 },
    { api: "STA", arr: 5, dep: 30 },
    { api: "PAK", arr: -5, dep: 25 },
    { api: "COW", arr: 0, dep: 25 },
    { api: "LOT", arr: 10, dep: 40 },
    { api: "UH", arr: -10, dep: 20 },
    { api: "EAG", arr: 0, dep: 30 },
    { api: "COE", arr: -10, dep: 20 },
    { api: "MUS", arr: 5, dep: 25 },
    { api: "AIR", arr: 20, dep: 50 },
    { api: "TFT", arr: null, dep: null },
  ]),
  // ── dir=TFT · 42322213132 ──
  ...tplPattern("TFT", "42322213132", [
    { api: "BAR", arr: null, dep: -5 },
    { api: "OCE", arr: 25, dep: 40 },
    { api: "JOC", arr: 15, dep: 35 },
    { api: "STA", arr: -25, dep: 0 },
    { api: "PAK", arr: -35, dep: -5 },
    { api: "COW", arr: -30, dep: -5 },
    { api: "LOT", arr: -20, dep: 10 },
    { api: "UH", arr: 20, dep: 50 },
    { api: "EAG", arr: -30, dep: 0 },
    { api: "COE", arr: 15, dep: 45 },
    { api: "MUS", arr: -35, dep: -5 },
    { api: "AIR", arr: -10, dep: 20 },
    { api: "TFT", arr: null, dep: null },
  ]),
  // ── dir=BAR · 22222232222（氹仔碼頭→媽閣）──
  ...tplPattern("BAR", "22222232222", [
    { api: "TFT", arr: null, dep: 25 },
    { api: "AIR", arr: -15, dep: 15 },
    { api: "MUS", arr: 5, dep: 30 },
    { api: "COE", arr: 75, dep: 90 },
    { api: "EAG", arr: 55, dep: 70 },
    { api: "UH", arr: 55, dep: 80 },
    { api: "LOT", arr: 45, dep: 65 },
    { api: "COW", arr: -10, dep: 10 },
    { api: "PAK", arr: -10, dep: 10 },
    { api: "STA", arr: -30, dep: -5 },
    { api: "JOC", arr: -15, dep: 5 },
    { api: "OCE", arr: -15, dep: 5 },
    { api: "BAR", arr: null, dep: null },
  ]),
  // ── dir=BAR · 13222222222（含 2026-09-26 勘误：路氹東 −10/+20）──
  ...tplPattern("BAR", "13222222222", [
    { api: "TFT", arr: null, dep: -5 },
    { api: "AIR", arr: 15, dep: 45 },
    { api: "MUS", arr: -25, dep: 0 },
    { api: "COE", arr: -10, dep: 20, note: "2026-09-26 勘误（原 +50/+'20 系误记）" },
    { api: "EAG", arr: -20, dep: 0, note: "受上一行误记连累，嫌疑随勘误解除" },
    { api: "UH", arr: -15, dep: 15 },
    { api: "LOT", arr: -10, dep: 15 },
    { api: "COW", arr: 0, dep: 25 },
    { api: "PAK", arr: 10, dep: 35 },
    { api: "STA", arr: 0, dep: 25 },
    { api: "JOC", arr: 15, dep: 35 },
    { api: "OCE", arr: 15, dep: 35 },
    { api: "BAR", arr: null, dep: null },
  ]),
];

/** 石排湾 / 横琴：线路级（`pattern='default'`） */
const SHORT_LINE_ROWS: SeedRow[] = [
  {
    route_code: LINE_SPVL,
    direction: "SPV",
    pattern: "default",
    api_station: "UH",
    arr_bias_sec: null,
    dep_bias_sec: -5,
    source: "线路级",
    measured_on: "2026-09-22",
    note: "协和医院→石排湾（实测）；关门偏差",
  },
  {
    route_code: LINE_SPVL,
    direction: "SPV",
    pattern: "default",
    api_station: "SPV",
    arr_bias_sec: null,
    dep_bias_sec: -5,
    source: "线路级",
    measured_on: "2026-09-22",
    note: "终点无发车，线路级登记（与 lrt_route_params 一致）",
  },
  {
    route_code: LINE_HQL,
    direction: "HQ",
    pattern: "default",
    api_station: "LOT",
    arr_bias_sec: null,
    dep_bias_sec: 40,
    source: "线路级",
    measured_on: "2026-09-22",
    note: "莲花→横琴（实测）；关门偏差",
  },
  {
    route_code: LINE_HQL,
    direction: "HQ",
    pattern: "default",
    api_station: "HQ",
    arr_bias_sec: null,
    dep_bias_sec: 40,
    source: "线路级",
    measured_on: "2026-09-22",
    note: "终点无发车，线路级登记",
  },
];

const ALL_ROWS: SeedRow[] = [...TPL_ROWS, ...SHORT_LINE_ROWS];
const SCOPE_ROUTE_CODES = [LINE_TPL, LINE_SPVL, LINE_HQL];

/** 纯校验（不依赖 DB 的部分）：返回错误消息数组 */
function validateRows(rows: SeedRow[]): string[] {
  const errs: string[] = [];
  if (rows.length !== 56) errs.push(`行数应为 56，实际 ${rows.length}`);

  const seen = new Set<string>();
  for (const r of rows) {
    const k = `${r.route_code}|${r.direction}|${r.pattern}|${r.api_station}`;
    if (seen.has(k)) errs.push(`重复键：${k}（违反 UNIQUE）`);
    seen.add(k);

    if (r.pattern !== "default" && !(MAIN_PATTERNS as readonly string[]).includes(r.pattern)) {
      errs.push(`非法模式：${r.route_code}/${r.direction}/${r.pattern}/${r.api_station}`);
    }
    if (r.dep_bias_sec !== null && (r.dep_bias_sec < -35 || r.dep_bias_sec > 90)) {
      errs.push(`dep_bias_sec 越界 [−35,90]：${k} = ${r.dep_bias_sec}`);
    }

    if (r.route_code === LINE_TPL) {
      // 终点站 = 方向码（TFT/BAR）—— 终点**无时刻行**，故不在站序表内，先单独判定
      if (r.api_station === r.direction) {
        if (r.arr_bias_sec !== null || r.dep_bias_sec !== null) errs.push(`氹仔线终点站应 arr=dep=null：${k}`);
        continue;
      }
      const order = LRT_TPL_ORDER[r.direction];
      if (!order) {
        errs.push(`氹仔线方向不在站序表：${k}`);
        continue;
      }
      if (!order.includes(r.api_station)) {
        errs.push(`站不在该方向站序内：${k}`);
        continue;
      }
      const isStart = r.api_station === order[0];
      if (isStart) {
        if (r.arr_bias_sec !== null) errs.push(`氹仔线起点站应 arr=null：${k}`);
      } else if (r.arr_bias_sec === null || r.dep_bias_sec === null) {
        errs.push(`氹仔线中间站 arr/dep 应均非空：${k}`);
      }
    } else {
      // 石排湾 / 横琴：线路级，两行 arr 均 null（终点行 dep 亦按线路级登记）
      if (r.arr_bias_sec !== null) errs.push(`石排湾/横琴行 arr 应为 null：${k}`);
    }
  }

  // 氹仔线每 (direction,pattern) 恰 13 行
  const counts = new Map<string, number>();
  for (const r of TPL_ROWS) {
    const k = `${r.direction}|${r.pattern}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  for (const p of MAIN_PATTERNS) {
    const dirs = p === "52222222222" || p === "42322213132" ? ["TFT"] : ["BAR"];
    for (const d of dirs) {
      const n = counts.get(`${d}|${p}`) ?? 0;
      if (n !== 13) errs.push(`氹仔线 ${d}/${p} 应 13 行，实际 ${n}`);
    }
  }
  return errs;
}

/** 打印分布摘要 */
function printDistribution(rows: SeedRow[]): void {
  const byGroup = new Map<string, { n: number; minDep: number; maxDep: number }>();
  for (const r of rows) {
    const g = `${r.route_code} · ${r.direction} · ${r.pattern}`;
    const e = byGroup.get(g) ?? { n: 0, minDep: Infinity, maxDep: -Infinity };
    e.n++;
    if (r.dep_bias_sec !== null) {
      e.minDep = Math.min(e.minDep, r.dep_bias_sec);
      e.maxDep = Math.max(e.maxDep, r.dep_bias_sec);
    }
    byGroup.set(g, e);
  }
  console.log("\n分布摘要（组 → 行数 · dep 范围）：");
  for (const [g, e] of byGroup) {
    const range = e.n && e.minDep !== Infinity ? `${e.minDep}~${e.maxDep}s` : "—";
    console.log(`  · ${g.padEnd(34)} ${String(e.n).padStart(3)} 行   dep ${range}`);
  }
}

async function loadLineParams(pool: Pool): Promise<Map<string, number>> {
  const rows = (
    await pool.query(`SELECT route_code, dep_bias_sec FROM lrt_route_params`)
  ).rows as { route_code: string; dep_bias_sec: number | string }[];
  return new Map(rows.map((r) => [r.route_code, Number(r.dep_bias_sec)]));
}

/** 一致性断言：石排湾/横琴 dep 必须等于 lrt_route_params.dep_bias_sec */
function assertShortLineConsistency(rows: SeedRow[], params: Map<string, number>): string[] {
  const errs: string[] = [];
  for (const line of [LINE_SPVL, LINE_HQL]) {
    const expected = params.get(line);
    if (expected === undefined) {
      errs.push(`lrt_route_params 缺 ${line} 行 ⇒ 无法做一致性断言（先跑 db:migrate-v2100）`);
      continue;
    }
    for (const r of rows.filter((x) => x.route_code === line)) {
      if (r.dep_bias_sec !== expected) {
        errs.push(`${line}/${r.api_station} dep=${r.dep_bias_sec} ≠ lrt_route_params ${expected}`);
      }
    }
  }
  return errs;
}

async function applyUpsert(pool: Pool, rows: SeedRow[]): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      await client.query(
        `INSERT INTO lrt_station_biases
           (route_code, direction, pattern, api_station, arr_bias_sec, dep_bias_sec, source, measured_on, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (route_code, direction, pattern, api_station) DO UPDATE SET
           arr_bias_sec = EXCLUDED.arr_bias_sec,
           dep_bias_sec = EXCLUDED.dep_bias_sec,
           source       = EXCLUDED.source,
           measured_on  = EXCLUDED.measured_on,
           note         = EXCLUDED.note,
           updated_at   = now()`,
        [
          r.route_code,
          r.direction,
          r.pattern,
          r.api_station,
          r.arr_bias_sec,
          r.dep_bias_sec,
          r.source,
          r.measured_on,
          r.note,
        ],
      );
    }
    await client.query("COMMIT");
    console.log(`\n✅ 已提交事务（APPLY）：${rows.length} 行 upsert。`);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    // ── ① 纯校验 ──
    const errs = validateRows(ALL_ROWS);
    if (errs.length) {
      console.error("\n❌ 校验失败 ⇒ 中止，不写库：");
      for (const e of errs) console.error(`  · ${e}`);
      process.exit(1);
    }
    console.log(`\n✅ 纯校验通过：${ALL_ROWS.length} 行；模式合法；氹仔线每 (dir,pattern) = 13 行；dep ∈ [−35,90]`);

    // ── ② 一致性断言（需读 lrt_route_params）──
    const params = await loadLineParams(pool);
    const cerrs = assertShortLineConsistency(ALL_ROWS, params);
    if (cerrs.length) {
      console.error("\n❌ 一致性断言失败 ⇒ 中止，不写库：");
      for (const e of cerrs) console.error(`  · ${e}`);
      process.exit(1);
    }
    console.log(
      `✅ 一致性断言通过：石排湾 ${params.get(LINE_SPVL)} / 横琴 ${params.get(LINE_HQL)} == lrt_route_params.dep_bias_sec`,
    );

    printDistribution(ALL_ROWS);

    // ── ③ 三态 ──
    if (ROLLBACK) {
      const del = await pool.query(`DELETE FROM lrt_station_biases WHERE route_code = ANY($1)`, [SCOPE_ROUTE_CODES]);
      console.log(`\n✅ ROLLBACK 完成：删除 ${del.rowCount ?? 0} 行（${SCOPE_ROUTE_CODES.join(" / ")}）。`);
      return;
    }

    if (!APPLY) {
      console.log("\nDRY-RUN 结束：**未写库**。核对无误后加 `--apply` 执行。");
      return;
    }

    await applyUpsert(pool, ALL_ROWS);
    const after = (
      await pool.query(`SELECT count(*)::int AS n FROM lrt_station_biases WHERE route_code = ANY($1)`, [
        SCOPE_ROUTE_CODES,
      ])
    ).rows[0] as { n: number };
    console.log(`写后复核：本批范围现有 ${after.n} 行。`);
    console.log(`回滚：npm run db:seed-lrt-biases -- cloud --rollback --allow-prod（删除上述 ${after.n} 行）。`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
