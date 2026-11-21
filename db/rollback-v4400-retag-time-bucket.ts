/**
 * 回滚 v4.4.0 的 `segment_samples.time_bucket` 重打
 * （db/rollback-v4400-retag-time-bucket.ts）
 *
 * 用法：
 *   npx tsx db/rollback-v4400-retag-time-bucket.ts                       # dry-run（只读，打印将还原多少行）
 *   npx tsx db/rollback-v4400-retag-time-bucket.ts -- --apply --allow-prod
 *   npx tsx db/rollback-v4400-retag-time-bucket.ts -- --apply --allow-prod --backup=backups/xxx.json
 *
 * 输入：`db/migrate-v4400-retag-time-bucket.ts` 在 apply 前写的备份 JSON：
 *   `{ rowCount, rows: [{id, time_bucket}] }`（`time_bucket` 是**改动前**的值）
 *
 * 做法：按旧值分组成批，`UPDATE segment_samples SET time_bucket = $1 WHERE id = ANY($2::bigint[])`。
 *   为什么按值分组而不是逐行 UPDATE：46k 行逐条 UPDATE 会跑成 46k 个事务里的 46k 次往返；
 *   按值分组只有 ≤5 条语句，且每组 id 数组能塞进一次 `ANY()`。
 *
 * ⚠️ 边界
 *   · 只还原**备份里那批 id**，不碰其它行（重打之后新写入的行保持新值）；
 *   · 还原同样带 `AND time_bucket IS DISTINCT FROM $1` —— 已经是旧值的行不重写；
 *   · 备份文件缺失或行数不符 ⇒ 中止（不要在没有证据的情况下改库）；
 *   · 目标库边界同迁移脚本：非本地库 `--apply` 必须 `--allow-prod`，并打印 host。
 */
import { Client } from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  process.loadEnvFile();
} catch {
  /* ignore */
}

const APPLY = process.argv.includes("--apply");
const ALLOW_PROD = process.argv.includes("--allow-prod");
const argOf = (k: string, d: string) => {
  const hit = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!hit) return d;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : "true";
};
const BACKUP_PATH = resolve(process.cwd(), argOf("backup", "backups/time-bucket-pre-retag-20261120.json"));
const target = process.argv[2] as "local" | "cloud" | undefined;

const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? process.env.DATABASE_URL_LOCAL
      : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);

const sessionUrl = (url: string) => {
  try {
    const u = new URL(url);
    if (u.port === "6543") u.port = "5432";
    return u.toString();
  } catch {
    return url;
  }
};

async function main() {
  if (!connStr) {
    console.error("❌ 未找到连接串");
    process.exit(1);
  }
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(connStr);
  if (APPLY && !isLocal && !ALLOW_PROD) {
    console.error("❌ 目标非本地库，`--apply` 需显式追加 `--allow-prod`");
    process.exit(1);
  }

  let backup: { rowCount: number; createdAt: string; rows: { id: string; time_bucket: string }[] };
  try {
    backup = JSON.parse(readFileSync(BACKUP_PATH, "utf8"));
  } catch (e) {
    console.error(`❌ 读不到备份文件 ${BACKUP_PATH}：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!Array.isArray(backup.rows) || backup.rows.length !== backup.rowCount) {
    console.error(`❌ 备份文件自相矛盾：rowCount=${backup.rowCount} 但 rows.length=${backup.rows?.length}`);
    process.exit(1);
  }

  let hostOf = "(无法解析)";
  try {
    const u = new URL(connStr);
    hostOf = `${u.hostname}:${u.port || "(默认端口)"}${u.pathname}`;
  } catch {
    /* ignore */
  }
  console.log(`目标 host：${hostOf}`);
  console.log(`备份：${BACKUP_PATH}（${backup.rowCount} 行，${backup.createdAt}）`);
  console.log(`模式：${APPLY ? "⚠️ APPLY（会写库）" : "DRY-RUN（只读）"}\n`);

  /** 按旧值分组 */
  const groups = new Map<string, string[]>();
  for (const r of backup.rows) {
    if (!groups.has(r.time_bucket)) groups.set(r.time_bucket, []);
    groups.get(r.time_bucket)!.push(String(r.id));
  }
  console.log("按旧值分组：");
  for (const [k, ids] of groups) console.log(`   ${k.padEnd(11)} ${ids.length} 行`);

  const client = new Client({
    connectionString: sessionUrl(connStr),
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    // 只统计「当前值 ≠ 备份值」的行（已是旧值的不用动）
    let toRestore = 0;
    for (const [oldVal, ids] of groups) {
      const r = await client.query(
        `SELECT count(*)::int AS n FROM segment_samples
          WHERE id = ANY($1::bigint[]) AND time_bucket IS DISTINCT FROM $2`,
        [ids, oldVal],
      );
      toRestore += r.rows[0].n as number;
    }
    console.log(`\n待还原 ${toRestore} 行（备份 ${backup.rowCount} 行中，其余已是旧值）`);

    if (!toRestore) {
      console.log("✅ 无需还原");
      return;
    }
    if (!APPLY) {
      console.log("DRY-RUN 结束。加 `-- --apply --allow-prod` 执行还原。");
      return;
    }

    await client.query("BEGIN");
    let restored = 0;
    try {
      for (const [oldVal, ids] of groups) {
        const res = await client.query(
          `UPDATE segment_samples SET time_bucket = $1
            WHERE id = ANY($2::bigint[]) AND time_bucket IS DISTINCT FROM $1`,
          [oldVal, ids],
        );
        restored += res.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    console.log(`✅ 已还原 ${restored} 行`);

    const left = (
      await client.query(
        `SELECT count(*)::int AS n FROM segment_samples WHERE time_bucket IN ('am_peak','pm_peak')`,
      )
    ).rows[0] as { n: number };
    console.log(`当前旧桶名行数：${left.n}（还原后应回到重打前的值）`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
