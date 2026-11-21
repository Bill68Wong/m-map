/**
 * 回滚 v4.5.0：`stations.name_tc` 首尾空白规范化
 * （db/rollback-v4500-trim-station-name.ts）
 *
 * 用法：
 *   npx tsx db/rollback-v4500-trim-station-name.ts                       # dry-run
 *   npx tsx db/rollback-v4500-trim-station-name.ts -- --apply --allow-prod
 *   npx tsx db/rollback-v4500-trim-station-name.ts -- --apply --allow-prod --backup=backups/xxx.json
 *
 * 输入：`db/migrate-v4500-trim-station-name.ts` 在 apply 前写的备份
 *   `{ rowCount, rows: [{code, name_tc}] }`（`name_tc` 是**改动前**的值，含首尾空白）
 *
 * ⚠️ 还原会把尾空格**写回库**（这是"回滚"的定义）。除非确认 trim 本身有问题，
 *   否则不要执行 —— 规范的站名是有意的目标状态。
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
const BACKUP_PATH = resolve(process.cwd(), argOf("backup", "backups/station-name-trim-20261121.json"));
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

  let backup: { rowCount: number; createdAt: string; rows: { code: string; name_tc: string }[] };
  try {
    backup = JSON.parse(readFileSync(BACKUP_PATH, "utf8"));
  } catch (e) {
    console.error(`❌ 读不到备份文件 ${BACKUP_PATH}：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!Array.isArray(backup.rows) || backup.rows.length !== backup.rowCount) {
    console.error(`❌ 备份自相矛盾：rowCount=${backup.rowCount} / rows=${backup.rows?.length}`);
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

  const client = new Client({
    connectionString: sessionUrl(connStr),
    ssl: connStr.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const codes = backup.rows.map((r) => r.code);
    const cur = (
      await client.query(`SELECT code, name_tc FROM stations WHERE code = ANY($1::text[])`, [codes])
    ).rows as { code: string; name_tc: string }[];
    const curMap = new Map(cur.map((r) => [r.code, r.name_tc]));
    const diff = backup.rows.filter((r) => curMap.get(r.code) !== r.name_tc);
    console.log(`待还原 ${diff.length} 行（备份 ${backup.rowCount} 行中，其余已是备份值）`);

    if (!diff.length) {
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
      for (const r of diff) {
        const res = await client.query(
          `UPDATE stations SET name_tc = $1 WHERE code = $2 AND name_tc IS DISTINCT FROM $1`,
          [r.name_tc, r.code],
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
      await client.query(`SELECT count(*)::int AS n FROM stations WHERE name_tc IS DISTINCT FROM btrim(name_tc)`)
    ).rows[0] as { n: number };
    console.log(`当前带首尾空白的行：${left.n}（还原后应回到 ${backup.rowCount}）`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
