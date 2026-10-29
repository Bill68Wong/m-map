/**
 * 数据不变量：站序方向 ⊆ shape 方向（scripts/check-shape-coverage.ts · v3.6.0 S6）
 *
 * ── 这条断言守的是什么 ──────────────────────────────────────────────────
 *   `/line/[code]` 的地图区按 `data.dir` 从 `route-shapes` 里挑「当前方向」画实线。
 *   如果某条线**站序有 dir=X，但 `route_shapes` 里没有 dir=X**，切到那个方向时
 *   地图会只剩灰色虚线（实线一条都画不出来）。
 *
 *   v3.6.0 S6 实测过：**今天是 0 条违规**（24 条双向线全部有 2 条 shape，
 *   69 条单 shape 线的 dir 与站序完全对齐）。但「今天成立」≠「以后成立」：
 *   这条不变量会被「下次跑 `fetch:route-shapes` 只抓到一半」破坏，而破坏时
 *   **没有任何编译错误 / 类型错误 / 测试失败**，表现只是「地图少画一条线」——
 *   用户不会报（他没觉得缺什么）。⇒ 必须用可执行断言钉住。
 *
 *   `LineMapPane` 里有运行时兜底（退回画第一条 + `console.error`），
 *   但**兜底只能让画面不空，不能让数据正确**。本脚本才是发现问题的那个。
 *
 * ── 为什么是「站序 ⊆ shape」单向包含 ────────────────────────────────────
 *   shape 多出来（有 shape 但站序没那个方向）**不是问题** —— 那可能是历史数据，
 *   `LineMapPane` 会把它画成灰色虚线，视觉上无害。
 *   只有「站序要、shape 没有」才会导致实线缺失 ⇒ 只断言这个方向。
 *
 * ── 两类豁免（各自有明确理由，逐条打印）────────────────────────────────
 *   ① **无任何 shape 的线路**（今天 7 条：`17S1`/`25BS`/`26S`/`2AS`/`3AS`/`52S`/`701XS`）
 *      不属本不变量范围 —— 它们走**地图区降级**（「暂无线路走向」），不依赖 shape。
 *   ② **`is_active=false` 的线路** 不属范围 —— 不进搜索结果、到不了全景页。
 *
 * 跑法：`node node_modules/tsx/dist/cli.mjs scripts/check-shape-coverage.ts`
 *      （或 `npm run check:shape-coverage`）
 * 退出码：0 = 不变量成立；1 = 存在违规（打印每条 route+缺失方向）
 */
import path from "node:path";
import { getPool } from "../src/lib/db";

/**
 * 载入 `.env`（本脚本**只读**、不改数据，故不经 `db-guard` —— 守卫是给写库命令用的）。
 * 与 `scripts/build-hop-stats.ts` 同款写法：先试当前目录，再退回脚本所在仓库根。
 */
try {
  process.loadEnvFile(path.resolve(process.cwd(), ".env"));
} catch {
  /* .env 不存在 ⇒ 下面 getPool() 会给出可读错误 */
}

interface Row {
  code: string;
  stop_dirs: string | null;
  shape_dirs: string | null;
}

async function main(): Promise<void> {
  console.log("═══ 数据不变量：站序方向 ⊆ shape 方向 ═══\n");

  const pool = getPool();
  let rows: Row[];
  try {
    // 一条 SQL 拿齐「站序方向集合」与「shape 方向集合」
    const r = await pool.query<Row>(
      `SELECT r.code,
              (SELECT string_agg(DISTINCT rs.dsat_dir, ',' ORDER BY rs.dsat_dir)
                 FROM route_stations rs WHERE rs.route_id = r.id) AS stop_dirs,
              (SELECT string_agg(DISTINCT s.dsat_dir, ',' ORDER BY s.dsat_dir)
                 FROM route_shapes s WHERE s.route_code = r.code) AS shape_dirs
         FROM routes r
        WHERE r.is_active
        ORDER BY r.code`,
    );
    rows = r.rows;
  } finally {
    await pool.end();
  }

  const noShape: string[] = [];
  const violations: { code: string; stopDirs: string; shapeDirs: string; missing: string }[] = [];
  let checked = 0;

  for (const x of rows) {
    const stopDirs = (x.stop_dirs ?? "").split(",").filter(Boolean);
    if (!stopDirs.length) continue; // 无站序 ⇒ 无从谈起（不进全景页）
    const shapeDirs = (x.shape_dirs ?? "").split(",").filter(Boolean);
    // 豁免①：完全无 shape ⇒ 走地图降级，不属本不变量
    if (!shapeDirs.length) {
      noShape.push(x.code);
      continue;
    }
    checked++;
    const have = new Set(shapeDirs);
    const missing = stopDirs.filter((d) => !have.has(d));
    if (missing.length) {
      violations.push({ code: x.code, stopDirs: stopDirs.join(","), shapeDirs: shapeDirs.join(","), missing: missing.join(",") });
    }
  }

  console.log(`active 线路 ${rows.length} 条`);
  console.log(`  参与断言（有 shape）        ${checked} 条`);
  console.log(`  豁免①（无任何 shape ⇒ 降级）${noShape.length} 条`);
  if (noShape.length) console.log(`    ${noShape.join(", ")}`);
  console.log("");

  if (violations.length) {
    console.error(`❌ 违规 ${violations.length} 条 —— 这些线路切到缺失方向时，地图实线会画不出来：`);
    for (const v of violations) {
      console.error(`   ${v.code.padEnd(10)} 站序方向=${v.stopDirs.padEnd(6)} shape方向=${v.shapeDirs.padEnd(6)} **缺 ${v.missing}**`);
    }
    console.error(
      "\n修法：重跑 `npm run fetch:route-shapes`（该方向采集失败/被跳过会留下这个洞）。" +
        "\n注意：`LineMapPane` 有运行时兜底（退回画第一条 + console.error），画面不会空，但数据是错的。",
    );
    process.exit(1);
  }

  console.log(`✅ 不变量成立：${checked} 条线路的每个站序方向都有对应 shape（0 违规）`);
  process.exit(0);
}

main().catch((e: unknown) => {
  console.error("✗ 检查失败（DB 不可用？）：", e instanceof Error ? e.message : e);
  process.exit(1);
});
