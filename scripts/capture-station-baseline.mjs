/**
 * 站点主码基线抓取 / 对比（scripts/capture-station-baseline.mjs）
 *
 * 用途：在**改动 `/api/stations` 的排序逻辑之前**，记录「主码 → 被选中的站台码」映射。
 *       改完后再跑一次，比对哪些主码换了站台 —— 这是"坐标是否漂移"的**精确**判据：
 *       code 变了坐标必然变、code 没变坐标必然没变（不需要坐标转换、不需要容差、
 *       不经 CDN、不受前端缓存影响）。
 *
 * ── 为什么是「逐字复现 API」而不是写个 SQL 就完事 ──────────────────────────
 *   `src/app/api/stations/route.ts` 的合并逻辑是「SQL 取出全部行（**无 ORDER BY**）
 *   → JS 端按主码 `Set` 覆盖 ⇒ 最后一行胜出」。这里有三个不能省的细节：
 *     ① **不能加 ORDER BY**：加了就变成"我假设的顺序"，而 API 用的是执行计划给的顺序；
 *     ② `mainCodeOf` 必须带 `?? code` 兜底：`LRT-LOT`/`LRT-氹仔线` 无数字，
 *        正则不匹配 ⇒ 真实实现回落成整串（每个轻轨站自成一组）。若写成
 *        `substring(code from '^[A-Za-z]+[0-9]+')` 会返回 NULL ⇒ 15 个轻轨站塌成
 *        一个组、净丢 14 个主码（实测 472 → 458），轻轨坐标漂移完全测不出来；
 *     ③ `kinds` 必须是 `kind IN ('bus','lrt')`：App 请求带 `include=lrt&v=2`，
 *        只取 bus 会让轻轨站不在基线里，"没变化"是假的。
 *
 * ── 两种运行方式 ──────────────────────────────────────────────────────
 *   node scripts/capture-station-baseline.mjs            抓一份新基线（写 .verify/）
 *   node scripts/capture-station-baseline.mjs --diff=<file>
 *                                                        与给定基线比对，列出变化的主码
 *
 * ── 只读保证 ─────────────────────────────────────────────────────────
 *   只执行单条 SELECT（下方 `assertReadOnly` 拦非 SELECT 语句）；不写库、不改文件之外的任何东西。
 *
 * ── 一个必须知道的局限 ───────────────────────────────────────────────
 *   API 那条 SQL 没有 ORDER BY ⇒ 返回顺序由**执行计划**决定。本脚本记录的是"此刻
 *   实际返回的顺序"，因此它能精确回答"此刻改前/改后有没有变"；但**不能**保证
 *   "将来执行计划不变"（一旦 PG 改走索引扫描，顺序就变 —— 这正是我们主张给
 *   `/api/stations` 加确定性 ORDER BY 的理由）。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Client } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

/** 只允许单条 SELECT —— 本脚本永不应写库 */
function assertReadOnly(sql) {
  const s = String(sql).trim().toUpperCase();
  if (!s.startsWith("SELECT") && !s.startsWith("WITH")) {
    throw new Error(`capture-station-baseline 只允许 SELECT，收到：${sql.slice(0, 60)}…`);
  }
}

/** 与 `src/lib/recommend/segment-lookup.ts#mainCodeOf` 逐字同构（**必须带 ?? code 兜底**） */
const mainCodeOf = (code) => /^[A-Za-z]+\d+/.exec(String(code ?? ""))?.[0] ?? String(code ?? "");

const REPO_ROOT = join(import.meta.dirname, "..");
const OUT_DIR = join(REPO_ROOT, ".verify");

async function capture() {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) throw new Error("未找到 DATABASE_URL（请检查 .env）");

  const client = new Client({
    connectionString: connStr,
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    /**
     * ⚠️ 与 `src/app/api/stations/route.ts` 的 SQL **逐字一致**（含"无 ORDER BY"这件事）。
     *    改这里 = 改基线口径 = 比对失效。
     */
    const sql = `SELECT code, name_tc, lat, lng, kind
                   FROM stations
                  WHERE kind IN ('bus','lrt') AND lat IS NOT NULL AND lng IS NOT NULL`;
    assertReadOnly(sql);

    const { rows } = await client.query(sql);

    // 逐字复现 API 的合并：按主码 Set 覆盖 ⇒ 最后一行胜出
    const byMain = new Map();
    for (const r of rows) byMain.set(mainCodeOf(r.code), r.code);

    // 诊断信息：ctid（判断执行计划是否为 seq scan），只用于观察、不参与判定
    const { rows: ctidRows } = await client.query(
      `SELECT code, ctid::text AS ctid FROM stations
        WHERE kind IN ('bus','lrt') AND lat IS NOT NULL AND lng IS NOT NULL`,
    );
    const ctidOf = new Map(ctidRows.map((r) => [r.code, r.ctid]));

    /*
     * 判断"返回顺序 == ctid 序"：若是，说明当前执行计划是 seq scan；
     * 若否，说明走了索引扫描 —— 那种情况下任何"按 ctid 猜选中行"的脚本都会错。
     */
    const returnedOrder = rows.map((r) => r.code);
    const ctidAscOrder = [...ctidRows]
      .sort((a, b) => compareCtid(a.ctid, b.ctid))
      .map((r) => r.code);
    const isCtidOrder = returnedOrder.join("\u0000") === ctidAscOrder.join("\u0000");

    return {
      capturedAt: new Date().toISOString(),
      sql,
      totalRows: rows.length,
      mainCount: byMain.size,
      planGuess: isCtidOrder ? "ctid-order (seq scan)" : "NOT-ctid-order (index scan?)",
      mapping: Object.fromEntries([...byMain.entries()].sort(([a], [b]) => a.localeCompare(b))),
      sample: returnedOrder.slice(0, 10),
    };
  } finally {
    await client.end();
  }
}

/** ctid 形如 `(123,4)` —— 按 page 再按 tuple 排序（纯字符串排序会把 (100,1) 排在 (99,1) 前） */
function compareCtid(a, b) {
  const pa = /\((\d+),(\d+)\)/.exec(a);
  const pb = /\((\d+),(\d+)\)/.exec(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  const [pa1, pa2] = [Number(pa[1]), Number(pa[2])];
  const [pb1, pb2] = [Number(pb[1]), Number(pb[2])];
  return pa1 - pb1 || pa2 - pb2;
}

function diff(baselinePath) {
  const base = JSON.parse(readFileSync(baselinePath, "utf8"));
  return capture().then((now) => {
    const changed = [];
    const baseMap = base.mapping ?? {};
    const nowMap = now.mapping ?? {};
    const allMains = new Set([...Object.keys(baseMap), ...Object.keys(nowMap)]);
    for (const m of [...allMains].sort()) {
      const b = baseMap[m];
      const n = nowMap[m];
      if (b !== n) changed.push({ main: m, before: b ?? null, after: n ?? null });
    }
    console.log(`基线：${baselinePath}`);
    console.log(`  基线抓取于 ${base.capturedAt}，主码 ${base.mainCount}`);
    console.log(`  本次抓取于 ${now.capturedAt}，主码 ${now.mainCount}`);
    console.log(`  执行计划判读：基线 ${base.planGuess} / 本次 ${now.planGuess}`);
    console.log(`\n主码 → 选中站台码 变化：${changed.length} 个`);
    for (const c of changed) console.log(`  ${c.main}: ${c.before} → ${c.after}`);
    return changed;
  });
}

const diffArg = process.argv.find((a) => a.startsWith("--diff="));

if (diffArg) {
  diff(diffArg.slice("--diff=".length)).catch((e) => {
    console.error("❌ 比对失败：", e.message);
    process.exit(1);
  });
} else {
  capture()
    .then((snap) => {
      mkdirSync(OUT_DIR, { recursive: true });
      const stamp = snap.capturedAt.replace(/[:.]/g, "-");
      const outPath = join(OUT_DIR, `stations-baseline-${stamp}.json`);
      writeFileSync(outPath, JSON.stringify(snap, null, 2) + "\n", "utf8");
      console.log(`✅ 基线已写入 ${outPath}`);
      console.log(`   行数 ${snap.totalRows} · 主码 ${snap.mainCount} · 执行计划判读 ${snap.planGuess}`);
      console.log(`   前 10 个返回的站台码：${snap.sample.join(", ")}`);
    })
    .catch((e) => {
      console.error("❌ 抓取失败：", e.message);
      process.exit(1);
    });
}
