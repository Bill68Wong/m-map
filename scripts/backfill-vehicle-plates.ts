/**
 * 回填 vehicle_plates（车牌 ↔ 车队编号 ↔ 车型）
 * 用法：npm run db:backfill-vehicle-plates -- cloud --allow-prod
 *
 * ── 两段式（★ 关键设计）───────────────────────────────────────────────
 *   ① **历史播种**：从 `bus_snapshots`（既有采集产物，4080 行 / 229 个车牌）
 *      直接取 plate+bus_code 落库 —— **零 DSAT 请求**。即使后面实时那一轮全失败，
 *      库里也已经有可用数据，不会空手而归。
 *   ② **实时补全**：按 (线路 × 方向) 逐条抓一轮，拿 busType（历史表里没有这列）
 *      与历史没覆盖到的新车牌。节流 250ms，并发 1，**不做任何轮询**。
 *
 * ── 为什么不用「线路清单接口」枚举 ─────────────────────────────────────
 *   方向值以**库里 `route_stations.dsat_dir` 为准**（96 条巴士线，真实存在的组合）。
 *   凭接口清单猜方向会发出大量无效请求（`dir` 错则接口回空，白耗配额）。
 *
 * ── 写入口径 ──────────────────────────────────────────────────────────
 *   统一走 `upsertVehiclePlates`（COALESCE 保住旧标定，见 vehicle-plates.ts 文件头）。
 *   本脚本只做「喂数据 + 报账」，不自己拼 SQL。
 */
import { Pool } from "pg";
import { getBusPositions, getBusLocations } from "../src/lib/dsat/client";
import {
  buildPlateRow,
  upsertVehiclePlates,
  type PlateInput,
  type PlateRow,
} from "../src/lib/dsat/vehicle-plates";
import { segmentTable } from "../src/lib/dsat/vehicle-models";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const target = process.argv[2] as "local" | "cloud" | undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);

if (!connStr) {
  console.error("❌ 未找到连接串：请先在 .env 配置（参照 .env.example）");
  process.exit(1);
}

/** DSAT 请求间隔（毫秒）：一次性回填，但也不该把上游当压力测试打 */
const PACE_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ★ 本脚本自建 Pool（与其它 db:* 脚本一致：连接串由 db-guard 的 `cloud`/`local` 参数决定），
  //   并**显式传给** `upsertVehiclePlates(..., pool)`。绝不让落库层退回 getPool()
  //   —— 那会按 `DATABASE_URL_LOCAL || DATABASE_URL` 另行解析，可能读到另一个库。
  const pool = new Pool({
    connectionString: connStr,
    ssl: connStr?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    console.log(`片区段表共 ${segmentTable().length} 段静态标定`);

    // ── ① 历史播种：bus_snapshots → 无任何 DSAT 请求 ──
    const seed = (
      await pool.query(
        `SELECT bus_plate, bus_code, max(polled_at) AS last
           FROM bus_snapshots
          WHERE bus_plate IS NOT NULL AND bus_plate <> ''
          GROUP BY bus_plate, bus_code
          ORDER BY bus_plate`,
      )
    ).rows as { bus_plate: string; bus_code: string | null; last: string | null }[];

    const seedRows = seed
      .map((r) => buildPlateRow({ plate: r.bus_plate, busCode: r.bus_code }))
      .filter((r): r is PlateRow => r !== null);
    const seedWritten = await upsertVehiclePlates(seedRows, pool);
    const seedPlates = new Set(seedRows.map((r) => r.plate)).size;
    console.log(`① 历史播种：bus_snapshots ${seed.length} 组 → ${seedPlates} 个车牌 → 写入 ${seedWritten} 行`);

    // ── ② 实时补全：(线路 × 方向) 逐条 ──
    const pairs = (
      await pool.query(
        `SELECT r.code AS route, rs.dsat_dir AS dir
           FROM routes r
           JOIN route_stations rs ON rs.route_id = r.id
          WHERE r.kind = 'bus'
          GROUP BY r.code, rs.dsat_dir
          ORDER BY r.code, rs.dsat_dir`,
      )
    ).rows as { route: string; dir: string }[];
    console.log(`② 实时补全：${pairs.length} 个 (线路 × 方向) 组合，节流 ${PACE_MS}ms`);

    // 车牌 → 输入（同一车牌多线路出现时合并：busCode 取首个非空，busType 取首个非空）
    const byPlate = new Map<string, PlateInput>();
    let called = 0;
    let okPairs = 0;
    const failReasons = new Map<string, number>();

    const put = (plate: string, busCode: string | null, busType: string | null) => {
      const key = plate.toUpperCase().replace(/\s+/g, "");
      if (!key) return;
      const cur = byPlate.get(key);
      if (!cur) {
        byPlate.set(key, { plate: key, busCode, busType });
        return;
      }
      if (!cur.busCode && busCode) cur.busCode = busCode;
      if (!cur.busType && busType) cur.busType = busType;
    };

    for (const { route, dir } of pairs) {
      const [posRes, locRes] = await Promise.all([
        getBusPositions(route, dir, "live_pos"),
        getBusLocations(route, dir, "live_pos"),
      ]);
      called += 2;

      let got = 0;
      // 报站接口：plate + busCode（无 busType）
      for (const block of posRes.ok ? (posRes.data?.routeInfo ?? []) : []) {
        for (const b of block.busInfo ?? []) {
          const plate = String(b.busPlate ?? "").trim();
          if (!plate) continue;
          put(plate, b.busCode != null ? String(b.busCode) : null, null);
          got++;
        }
      }
      // 位置接口：plate + busType（无 busCode）
      for (const b of locRes.ok ? (locRes.data?.busInfoList ?? []) : []) {
        const plate = String(b.busPlate ?? "").trim();
        if (!plate) continue;
        put(plate, null, b.busType != null ? String(b.busType) : null);
        got++;
      }

      if (posRes.ok || locRes.ok) okPairs++;
      else {
        const why = posRes.error ?? locRes.error ?? "unknown";
        const key = why.slice(0, 60);
        failReasons.set(key, (failReasons.get(key) ?? 0) + 1);
      }
      if (got > 0) process.stdout.write(`  ${route}/${dir}:${got} `);
      await sleep(PACE_MS);
    }
    console.log("");

    const liveRows = [...byPlate.values()]
      .map((x) => buildPlateRow(x))
      .filter((r): r is PlateRow => r !== null);
    const liveWritten = await upsertVehiclePlates(liveRows, pool);
    console.log(
      `② 实时补全：DSAT 调用 ${called} 次 · 成功组合 ${okPairs}/${pairs.length} · ` +
        `见车 ${byPlate.size} 个车牌 → 写入 ${liveWritten} 行`,
    );
    if (failReasons.size > 0) {
      console.log("   失败原因（前 5）：");
      for (const [why, n] of [...failReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
        console.log(`     · ${n} 次：${why}`);
      }
    }

    // ── ③ 报账 ──
    const stat = (
      await pool.query(
        `SELECT count(*)::int AS rows,
                count(bus_code)::int AS with_code,
                count(model)::int AS with_model,
                count(bus_type)::int AS with_type,
                count(*) FILTER (WHERE company = 'transmac')::int AS transmac,
                count(*) FILTER (WHERE company = 'tcm')::int AS tcm,
                count(*) FILTER (WHERE company IS NULL)::int AS company_unknown
           FROM vehicle_plates`,
      )
    ).rows[0] as {
      rows: number;
      with_code: number;
      with_model: number;
      with_type: number;
      transmac: number;
      tcm: number;
      company_unknown: number;
    };

    console.log(`\n── 入库结果 ──────────────────────────────────────────`);
    console.log(`总车牌数        ${stat.rows}`);
    console.log(`有车队编号      ${stat.with_code}`);
    console.log(`有型号          ${stat.with_model}`);
    console.log(`有 busType      ${stat.with_type}`);
    console.log(`新福利/澳巴/未知 ${stat.transmac} / ${stat.tcm} / ${stat.company_unknown}`);

    const unmodeled = (
      await pool.query(
        `SELECT bus_code, count(*)::int AS n
           FROM vehicle_plates
          WHERE model IS NULL AND bus_code IS NOT NULL
          GROUP BY bus_code
          ORDER BY n DESC, bus_code
          LIMIT 20`,
      )
    ).rows as { bus_code: string; n: number }[];
    console.log(`\n无型号的车队编号（前 ${unmodeled.length} 个，共 ${
      ((await pool.query(`SELECT count(DISTINCT bus_code)::int AS n FROM vehicle_plates WHERE model IS NULL AND bus_code IS NOT NULL`)).rows[0] as { n: number }).n
    } 个不同编号）：`);
    console.log(
      unmodeled.length === 0
        ? "  （无 —— 所有已采编号都命中了区段表）"
        : unmodeled.map((r) => `  · ${r.bus_code}（${r.n} 台）`).join("\n"),
    );

    const modeled = (
      await pool.query(
        `SELECT bus_code, model, model_source, model_confidence, count(*)::int AS n
           FROM vehicle_plates
          WHERE model IS NOT NULL
          GROUP BY 1,2,3,4 ORDER BY 5 DESC LIMIT 15`,
      )
    ).rows as { bus_code: string; model: string; model_source: string; model_confidence: string; n: number }[];
    console.log(`\n已标定型号分布（前 ${modeled.length} 组）：`);
    console.log(
      modeled.length === 0
        ? "  （无）"
        : modeled
            .map(
              (r) => `  · ${r.bus_code.padEnd(6)} ${r.model.padEnd(16)} ${r.model_confidence.padEnd(7)} ${r.model_source}  ×${r.n}`,
            )
            .join("\n"),
    );
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
