/**
 * 迁移 v4.4.0：重打 `segment_samples.time_bucket`（旧四桶 → 新五桶）
 * （db/migrate-v4400-retag-time-bucket.ts）
 *
 * 用法：
 *   npx tsx db/migrate-v4400-retag-time-bucket.ts                    # dry-run（只读＋打印方案）
 *   npx tsx db/migrate-v4400-retag-time-bucket.ts -- --apply --allow-prod
 *   npx tsx db/migrate-v4400-retag-time-bucket.ts -- --apply --backup=backups/xxx.json
 *
 * ── 为什么要有这一步（R13 收尾）──────────────────────────────────────
 *   `segment_samples.time_bucket` 是**写入时刻**打上的桶标签。历史上换过三次口径，
 *   于是同一列里躺着三种世代的值：
 *     · 旧四桶：`am_peak`(7–10) / `day`(10–17) / `pm_peak`(17–20) / `night`(20–7)
 *     · 新五桶：`am_work`/`am_weekend`(7–9) / `day`(9–16) / `pm`(16–20) / `night`(20–7)
 *     · 过渡期：部分行已经是新五桶
 *   聚合侧（`src/lib/rebuild/segment-stats.ts`）**不信任这一列**，一律按 `observed_at` 现算，
 *   所以 ETA 不受影响；但任何「按 time_bucket 分组」的即席查询/诊断都会把两套口径混在一起
 *   （实测：`am_peak` 还是 `am_work` 取决于行是什么时候写的，同一时段能分出两组数）。
 *
 * ── 为什么不「按旧值映射」────────────────────────────────────────────
 *   旧四桶与新五桶**不是一一对应**：`am_peak`(7–10) 横跨新口径的 `am_work`(7–9) 与 `day`(9–16)；
 *   `day`(10–17) 横跨 `day` 与 `pm`(16–20)。按值映射必然把 9:30 的样本塞进 `am_work`。
 *   ⇒ 唯一正确做法：**逐行按 `observed_at` 现算**（与生产 `bucketOfRoute` 同一判据，
 *     含节假日：`lrt_holidays` 命中的日期按周末处理）。
 *
 * ── 只改不一致的行 ──────────────────────────────────────────────────
 *   `WHERE time_bucket IS DISTINCT FROM <现算值>`：已经正确的行**不重写**（不产生新元组、
 *   不涨 WAL）。这与 `scripts/check-station-writes.mjs` 要求 stations 写入「值变化才写」
 *   是同一条原则 —— 只是这里守的是 `segment_samples`，那个脚本扫的是 `db/**` 的 stations SQL。
 *
 * ── 备份与回滚 ──────────────────────────────────────────────────────
 *   `--apply` 前会把**受影响行**的 `(id, time_bucket)` 全量落盘到
 *   `backups/time-bucket-pre-retag-20261120.json`（`backups/` 在 gitignore 内），
 *   并校验「备份行数 == 待更新行数」，不等则中止。
 *   回滚：`npx tsx db/rollback-v4400-retag-time-bucket.ts -- --apply --allow-prod`
 *   （按 id 批量还原旧值，见该文件头）。
 *
 * ── 边界 ────────────────────────────────────────────────────────────
 *   · **只动 `segment_samples.time_bucket`**，不碰其它列（`weekday` 不动，见 dry-run 的告警）；
 *   · 不动 `segment_stats`：它的 `time_bucket` 是**聚合时现算**的，库里本来就没有旧桶行
 *     （dry-run 会复核这一点）；
 *   · 幂等：重复执行时待更新行数为 0；
 *   · 向前兼容：不改结构、不删数据，旧代码读这一列照样能跑（只是看到的值更准）。
 *
 * ── ⚠️ 目标库边界 ───────────────────────────────────────────────────
 *   本机 `.env` **未配 `DATABASE_URL_LOCAL`** 时默认回落 `DATABASE_URL`（= 生产 pooler）。
 *   ⇒ **dry-run 安全、`--apply` 危险**：`--apply` 在非本地库上强制要求 `--allow-prod`，
 *   且运行时会打印目标库 host:port/db（不打口令）。
 */
import { Client } from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 ⇒ 下面会提示 */
}

const APPLY = process.argv.includes("--apply");
const ALLOW_PROD = process.argv.includes("--allow-prod");
const argOf = (k: string, d: string) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
};
const BACKUP_PATH = resolve(
  process.cwd(),
  argOf("backup", "backups/time-bucket-pre-retag-20261120.json"),
);
const target = process.argv[2] as "local" | "cloud" | undefined;

const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);

/** 连接串 → 会话模式（仅端口确实是 6543 时改写）。多语句必须同一后端，否则视图不一致 */
function sessionUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.port === "6543") u.port = "5432";
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * 现算桶 —— **必须**与 `src/lib/rebuild/buckets.ts: bucketOfRoute(weekday, hour, isHoliday)` 同判据：
 *   am 7–9（周末/节假日 → `am_weekend`，否则 `am_work`）/ day 9–16 / pm 16–20 / night 其余。
 * ⚠️ `EXTRACT(dow …)` 的 0 = 周日，与 `getUTCDay()` 一致；**不要**改成 `isodow`（那里 7 = 周日）。
 */
const BUCKET_SQL = `
  CASE
    WHEN EXTRACT(hour FROM (observed_at AT TIME ZONE 'Asia/Macau')) >= 7
     AND EXTRACT(hour FROM (observed_at AT TIME ZONE 'Asia/Macau')) < 9
    THEN CASE
           WHEN EXTRACT(dow FROM (observed_at AT TIME ZONE 'Asia/Macau')) IN (0, 6)
             OR (observed_at AT TIME ZONE 'Asia/Macau')::date = ANY($1::date[])
           THEN 'am_weekend' ELSE 'am_work' END
    WHEN EXTRACT(hour FROM (observed_at AT TIME ZONE 'Asia/Macau')) >= 9
     AND EXTRACT(hour FROM (observed_at AT TIME ZONE 'Asia/Macau')) < 16 THEN 'day'
    WHEN EXTRACT(hour FROM (observed_at AT TIME ZONE 'Asia/Macau')) >= 16
     AND EXTRACT(hour FROM (observed_at AT TIME ZONE 'Asia/Macau')) < 20 THEN 'pm'
    ELSE 'night'
  END`;

const NEW_BUCKETS = ["am_work", "am_weekend", "day", "pm", "night"] as const;

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串：请先在 .env 配置 DATABASE_URL / DATABASE_URL_LOCAL");
    process.exit(1);
  }
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(connStr);
  if (APPLY && !isLocal && !ALLOW_PROD) {
    console.error("❌ 目标非本地库，`--apply` 需显式追加 `--allow-prod`（防误写生产）");
    process.exit(1);
  }

  let hostOf = "(无法解析)";
  try {
    const u = new URL(connStr);
    hostOf = `${u.hostname}:${u.port || "(默认端口)"}${u.pathname}`;
  } catch {
    /* ignore */
  }
  console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
  console.log(`目标 host：${hostOf}`);
  if (!target && !process.env.DATABASE_URL_LOCAL) {
    console.log("⚠️ 未配 DATABASE_URL_LOCAL ⇒ 已默认回落生产库（dry-run 安全；--apply 需 --allow-prod）");
  }
  console.log(`模式：${APPLY ? "⚠️ APPLY（会写库）" : "DRY-RUN（只读）"}\n`);

  const client = new Client({
    connectionString: sessionUrl(connStr),
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    // ── ① 前置探测 ────────────────────────────────────────────────
    const col = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='segment_samples' AND column_name='time_bucket'`,
    );
    if (!col.rowCount) throw new Error("segment_samples.time_bucket 不存在 —— 库结构不对，中止");

    const holRes = await client.query(`SELECT holiday_date::text AS d FROM lrt_holidays`);
    const holidays = holRes.rows.map((r) => String(r.d).slice(0, 10));
    if (!holidays.length) {
      console.log("⚠️ lrt_holidays 为空 ⇒ 节假日将按普通日型打桶（与生产 getHolidays 的降级行为一致）");
    } else {
      console.log(`节假日 ${holidays.length} 天（用于 am_weekend 判定）`);
    }

    const total = (await client.query(`SELECT count(*)::int AS n FROM segment_samples`)).rows[0] as { n: number };
    const nullTs = (
      await client.query(`SELECT count(*)::int AS n FROM segment_samples WHERE observed_at IS NULL`)
    ).rows[0] as { n: number };
    console.log(`segment_samples ${total.n} 行 · observed_at 为 NULL ${nullTs.n} 行（这些行**不动**）\n`);

    /**
     * 「不合法时间戳」的判据：`observed_at` 列是 timestamptz，语法上不会有非法值，
     * 但可能有**语义异常**（1970 默认值 / 未来时间 / 跨年写错）。这里按 2026 年窗口外计数。
     * ⚠️ 这些行**仍然按现算打桶**（没有别的依据），只是让执行者先看到数量；
     *    数量不为 0 时应先查清来源再决定要不要 apply。
     */
    const oddTs = (
      await client.query(
        `SELECT count(*)::int AS n FROM segment_samples
          WHERE observed_at IS NOT NULL
            AND (observed_at < '2026-01-01T00:00:00+08:00' OR observed_at >= '2027-01-01T00:00:00+08:00')`,
      )
    ).rows[0] as { n: number };
    console.log(`⚠️ 语义异常时间戳（2026 年窗口外）${oddTs.n} 行 —— 它们仍按现算打桶，若不为 0 建议先查来源`);

    // ── ② 现分布 + 逐对迁移矩阵 ────────────────────────────────────
    const matrix = (
      await client.query(
        `SELECT time_bucket AS old_b, (${BUCKET_SQL}) AS new_b, count(*)::int AS n
           FROM segment_samples
          WHERE observed_at IS NOT NULL
          GROUP BY 1, 2 ORDER BY 1, 2`,
        [holidays],
      )
    ).rows as { old_b: string; new_b: string; n: number }[];

    const sumAll = matrix.reduce((a, r) => a + r.n, 0);
    const bad = matrix.filter((r) => r.old_b !== r.new_b);
    const toUpdate = bad.reduce((a, r) => a + r.n, 0);

    console.log("现值分布（旧 → 新）：");
    const byOld = new Map<string, number>();
    for (const r of matrix) byOld.set(r.old_b, (byOld.get(r.old_b) ?? 0) + r.n);
    for (const [k, v] of [...byOld.entries()].sort((a, b) => b[1] - a[1])) {
      const legacy = !(NEW_BUCKETS as readonly string[]).includes(k) ? "  ← 旧桶名" : "";
      console.log(`   ${k.padEnd(11)} ${String(v).padStart(7)}${legacy}`);
    }
    console.log(`\n需更新 ${toUpdate} 行（一致 ${sumAll - toUpdate} 行 / 总 ${sumAll}）`);
    if (bad.length) {
      console.log("迁移矩阵（仅不一致的）：");
      for (const r of [...bad].sort((a, b) => b.n - a.n)) {
        console.log(`   ${r.old_b.padEnd(11)} → ${r.new_b.padEnd(11)} ${String(r.n).padStart(6)}`);
      }
    }

    // ── ③ 重打后分布 + 口径自检 ────────────────────────────────────
    const after = (
      await client.query(
        `SELECT (${BUCKET_SQL}) AS b, count(*)::int AS n
           FROM segment_samples WHERE observed_at IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`,
        [holidays],
      )
    ).rows as { b: string; n: number }[];
    console.log("\n重打后分布预览：");
    for (const r of after) console.log(`   ${r.b.padEnd(11)} ${String(r.n).padStart(7)}`);
    const strayAfter = after.filter((r) => !(NEW_BUCKETS as readonly string[]).includes(r.b));
    console.log(`重打后仍落在旧桶名的行：${strayAfter.reduce((a, r) => a + r.n, 0)}（必须为 0）`);
    const sumAfter = after.reduce((a, r) => a + r.n, 0);
    console.log(`行数守恒：${sumAll} → ${sumAfter}${sumAll === sumAfter ? " ✅" : " ❌ 行数不守恒，中止"}`);
    if (sumAll !== sumAfter) throw new Error("行数不守恒（现算表达式漏了分支）");

    // ── ④ segment_stats 是否有旧桶行（判断是否需要重算）────────────────
    const statsLegacy = (
      await client.query(
        `SELECT time_bucket, count(*)::int AS n FROM segment_stats
          WHERE time_bucket NOT IN ('am_work','am_weekend','day','pm','night','all')
          GROUP BY 1 ORDER BY 1`,
      )
    ).rows as { time_bucket: string; n: number }[];
    if (!statsLegacy.length) {
      console.log("segment_stats：无旧桶行 ⇒ **无需**重算（它的桶是聚合时按 observed_at 现算的）");
    } else {
      console.log("segment_stats 存在旧桶行（需重算 `npm run db:segments`）：");
      for (const r of statsLegacy) console.log(`   ${r.time_bucket} ${r.n}`);
    }

    // ── ⑤ weekday 列是否与 observed_at 一致（本次不动，只告警）────────────
    const wdMismatch = (
      await client.query(
        `SELECT count(*)::int AS n FROM segment_samples
          WHERE observed_at IS NOT NULL
            AND weekday <> EXTRACT(dow FROM (observed_at AT TIME ZONE 'Asia/Macau'))::smallint`,
      )
    ).rows[0] as { n: number };
    if (wdMismatch.n) {
      console.log(
        `⚠️ 另有 ${wdMismatch.n} 行 \`weekday\` 与 observed_at 推导值不一致（本次**不动**，超出 v4.4.0 范围；如需修另开迁移）`,
      );
    } else {
      console.log("`weekday` 列与 observed_at 推导值一致（0 行不一致）—— 本次无需处理");
    }

    // ── ⑥ 抽样：将被改写的行长什么样 ────────────────────────────────
    const sample = (
      await client.query(
        `SELECT id, source, time_bucket AS old_b, (${BUCKET_SQL}) AS new_b, observed_at
           FROM segment_samples
          WHERE observed_at IS NOT NULL AND time_bucket IS DISTINCT FROM (${BUCKET_SQL})
          ORDER BY observed_at DESC LIMIT 8`,
        [holidays],
      )
    ).rows as { id: string; source: string; old_b: string; new_b: string; observed_at: Date }[];
    if (sample.length) {
      console.log("\n抽样（最近 8 行）：");
      for (const r of sample) {
        console.log(`   id=${r.id} ${r.source} ${r.old_b} → ${r.new_b} @ ${r.observed_at.toISOString()}`);
      }
    }

    if (!toUpdate) {
      console.log("\n✅ 无待更新行（幂等：可能已重打过）");
      return;
    }
    if (!APPLY) {
      console.log(`\nDRY-RUN 结束：将更新 ${toUpdate} 行。加 \`-- --apply --allow-prod\` 执行。`);
      console.log(`备份将写入：${BACKUP_PATH}`);
      return;
    }

    // ── ⑦ 备份（先落盘并校验行数，再改库）────────────────────────────
    const rows = (
      await client.query(
        `SELECT id::text AS id, time_bucket FROM segment_samples
          WHERE observed_at IS NOT NULL AND time_bucket IS DISTINCT FROM (${BUCKET_SQL})
          ORDER BY id`,
        [holidays],
      )
    ).rows as { id: string; time_bucket: string }[];
    if (rows.length !== toUpdate) {
      throw new Error(`备份行数 ${rows.length} != 待更新行数 ${toUpdate}（期间库被写入了，中止重算）`);
    }
    mkdirSync(dirname(BACKUP_PATH), { recursive: true });
    writeFileSync(
      BACKUP_PATH,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          table: "segment_samples",
          column: "time_bucket",
          fromScheme: "旧四桶 / 混合",
          toScheme: "新五桶（am_work|am_weekend|day|pm|night）",
          rowCount: rows.length,
          rows,
        },
        null,
        0,
      ),
      "utf8",
    );
    console.log(`\n🗄  备份已写入 ${BACKUP_PATH}（${rows.length} 行）`);

    // ── ⑧ 执行（单事务）────────────────────────────────────────────
    await client.query("BEGIN");
    let updated = 0;
    try {
      const res = await client.query(
        `UPDATE segment_samples
            SET time_bucket = (${BUCKET_SQL})
          WHERE observed_at IS NOT NULL AND time_bucket IS DISTINCT FROM (${BUCKET_SQL})`,
        [holidays],
      );
      updated = res.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    console.log(`✅ 已更新 ${updated} 行（预期 ${toUpdate}）${updated === toUpdate ? "" : "⚠️ 数量不符，请复核"}`);

    // ── ⑨ 事后核验 ────────────────────────────────────────────────
    const legacyLeft = (
      await client.query(
        `SELECT time_bucket, count(*)::int AS n FROM segment_samples
          WHERE time_bucket NOT IN ('am_work','am_weekend','day','pm','night')
          GROUP BY 1 ORDER BY 1`,
      )
    ).rows as { time_bucket: string; n: number }[];
    console.log(
      legacyLeft.length
        ? `❌ 仍有旧桶名：${legacyLeft.map((r) => `${r.time_bucket}=${r.n}`).join(" ")}`
        : "✅ 旧桶名归零（am_peak / pm_peak 已不存在）",
    );
    const afterReal = (
      await client.query(
        `SELECT time_bucket, count(*)::int AS n FROM segment_samples GROUP BY 1 ORDER BY 2 DESC`,
      )
    ).rows as { time_bucket: string; n: number }[];
    console.log("实际分布：");
    for (const r of afterReal) console.log(`   ${r.time_bucket.padEnd(11)} ${String(r.n).padStart(7)}`);

    // ── ⑩ 四条核验（逐条打 ✅/❌，作为"事后证据"直接可贴）──────────────────
    const previewMap = new Map(after.map((r) => [r.b, r.n]));
    const realMap = new Map(afterReal.map((r) => [r.time_bucket, r.n]));
    const distOk =
      previewMap.size === realMap.size && [...previewMap.entries()].every(([k, v]) => realMap.get(k) === v);
    const totalAfter = (await client.query(`SELECT count(*)::int AS n FROM segment_samples`)).rows[0] as { n: number };

    console.log("\n──── 事后核验 ────");
    console.log(`① 旧桶名归零：${legacyLeft.length ? `❌ 仍有 ${legacyLeft.map((r) => r.time_bucket + "=" + r.n).join(",")}` : "✅ am_peak/pm_peak 均为 0"}`);
    console.log(`② 行数守恒：${total.n} → ${totalAfter.n} ${total.n === totalAfter.n ? "✅" : "❌"}`);
    console.log(`③ 分布与 dry-run 预览：${distOk ? "✅ 完全一致" : "❌ 不一致"}`);
    if (!distOk) {
      for (const k of new Set([...previewMap.keys(), ...realMap.keys()])) {
        const p = previewMap.get(k) ?? 0;
        const r2 = realMap.get(k) ?? 0;
        if (p !== r2) console.log(`     ${k}: 预览 ${p} vs 实际 ${r2}`);
      }
    }
    // ④ 抽样 8 行：旧值取备份，新值取现库
    const pickIdx = rows.length
      ? Array.from({ length: Math.min(8, rows.length) }, (_, i) => Math.floor((i * rows.length) / Math.min(8, rows.length)))
      : [];
    const picked = pickIdx.map((i) => rows[i]);
    if (picked.length) {
      const cur = (
        await client.query(
          `SELECT id::text AS id, time_bucket, observed_at FROM segment_samples WHERE id = ANY($1::bigint[])`,
          [picked.map((r) => r.id)],
        )
      ).rows as { id: string; time_bucket: string; observed_at: Date }[];
      const curMap = new Map(cur.map((r) => [r.id, r]));
      console.log("④ 抽样 8 行（id · 澳门时刻 · 旧值 → 新值）：");
      for (const p of picked) {
        const c2 = curMap.get(p.id);
        const mp = c2 ? new Date(c2.observed_at.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ") : "?";
        console.log(`   id=${p.id}  ${mp}  ${p.time_bucket} → ${c2?.time_bucket ?? "?"}`);
      }
    }
    const allOk = !legacyLeft.length && total.n === totalAfter.n && distOk;
    console.log(`\n核验结论：${allOk ? "✅ 全部通过" : "❌ 有不符项 ⇒ 请立即回滚并上报"}`);
    console.log(`\n回滚：npx tsx db/rollback-v4400-retag-time-bucket.ts -- --apply --allow-prod --backup=${BACKUP_PATH}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
