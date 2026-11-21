/**
 * 迁移 v4.5.0：`stations.name_tc` 首尾空白规范化（trim）
 * （db/migrate-v4500-trim-station-name.ts）
 *
 * 用法：
 *   npx tsx db/migrate-v4500-trim-station-name.ts                  # dry-run（只读＋打印将改的行）
 *   npx tsx db/migrate-v4500-trim-station-name.ts -- --apply --allow-prod
 *
 * ── 为什么单独一步，而不是等下一次 `db:sync-all` ────────────────────────
 *   DSAT 原始数据里带尾空格（`M117` = `羅理基/馬六甲街   `、`M84/2` = `高士德/培正 `），
 *   写入端的 `.trim()` 已在 `db/sync-all-routes.ts` / `db/sync-routes.ts` 落好，但
 *   **下次全量同步才会生效** —— 而全量同步会连带重建 `route_stations`（2,910 行），
 *   影响面远大于"修 2 个站名"。
 *   ⇒ 本迁移只做一件事：把 `name_tc` 的首尾空白**就地规范化**。目标状态与"跑过 trim 的
 *     同步"完全一致，且不碰 `routes` / `route_stations` / 坐标。
 *
 * ── 为什么不需要联网取官方值 ──────────────────────────────────────────
 *   trim 是**纯本地变换**：`btrim(name_tc)` 就是 `.trim()` 在库侧的等价物。
 *   DSAT 送来的原文是带空格的，写入端 trim 后落库的就是 btrim 结果 ⇒ 无需再取一次官方值，
 *   也就避免了「为了修两个尾空格去请求一次外部接口」。
 *
 * ── 只改不一致的行 ──────────────────────────────────────────────────
 *   `WHERE name_tc IS DISTINCT FROM btrim(name_tc)`：已是规范值的行**不重写**
 *   （不产生新元组）。与 `scripts/check-station-writes.mjs` 的 D1/D2 判据同形。
 *
 * ── 备份与回滚 ──────────────────────────────────────────────────────
 *   `--apply` 前把受影响行 `(code, name_tc)` 落 `backups/station-name-trim-20261121.json`，
 *   并断言「备份行数 == 待更新行数」。
 *   回滚：`npx tsx db/rollback-v4500-trim-station-name.ts -- --apply --allow-prod`
 *
 * ── 边界 ────────────────────────────────────────────────────────────
 *   · 只动 `stations.name_tc`（不含 `name_pt`）；不改坐标、不改 `dsat_synced`；
 *   · 幂等：第二次执行受影响行为 0；
 *   · 事后核验：全表 `(code, name_tc)` 快照比对，**除受影响行外必须逐行相同**。
 */
import { Client } from "pg";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

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

/** 受影响行的唯一判据（与写入端 `.trim()` 等价） */
const AFFECTED = `name_tc IS DISTINCT FROM btrim(name_tc)`;

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
    const total = (await client.query(`SELECT count(*)::int AS n FROM stations`)).rows[0] as { n: number };
    const affected = (
      await client.query(`SELECT code, name_tc FROM stations WHERE ${AFFECTED} ORDER BY code`)
    ).rows as { code: string; name_tc: string }[];

    /** 全表快照（用于事后证明"只有这些行变了"） */
    const snap = (
      await client.query(`SELECT code, name_tc FROM stations ORDER BY code`)
    ).rows as { code: string; name_tc: string }[];
    const hashOf = (rows: { code: string; name_tc: string }[]) =>
      createHash("sha256").update(rows.map((r) => `${r.code}\t${r.name_tc}`).join("\n")).digest("hex");

    console.log(`扫描 ${total.n} 行 · 受影响 ${affected.length} 行`);
    for (const r of affected) {
      console.log(`   ${r.code}: [${JSON.stringify(r.name_tc)}] → [${JSON.stringify(r.name_tc.trim())}]`);
    }

    if (!affected.length) {
      console.log("\n✅ 无需处理（幂等：站名已全部规范）");
      return;
    }
    if (!APPLY) {
      console.log(`\nDRY-RUN 结束：将更新 ${affected.length} 行。加 \`-- --apply --allow-prod\` 执行。`);
      console.log(`备份将写入：${BACKUP_PATH}`);
      return;
    }

    // ── 备份（先落盘并校验行数）────────────────────────────────────
    mkdirSync(dirname(BACKUP_PATH), { recursive: true });
    writeFileSync(
      BACKUP_PATH,
      JSON.stringify(
        { createdAt: new Date().toISOString(), table: "stations", column: "name_tc", rowCount: affected.length, rows: affected },
        null,
        1,
      ),
      "utf8",
    );
    const reread = (
      await client.query(`SELECT code, name_tc FROM stations WHERE ${AFFECTED} ORDER BY code`)
    ).rows.length;
    if (reread !== affected.length) throw new Error(`备份后受影响行数变成 ${reread}（期间被写入），中止`);
    console.log(`\n🗄  备份已写入 ${BACKUP_PATH}（${affected.length} 行）`);

    // ── 执行（单事务）────────────────────────────────────────────
    const beforeHash = hashOf(snap);
    /**
     * ⚠️ 这条 SQL **故意把条件写全**，不用 `${AFFECTED}` 拼 ——
     *   `scripts/check-station-writes.mjs` 只扫字面量、不追 JS 变量（这是它的默认拒绝策略），
     *   拼变量会被判红（实测：D1「WHERE 里没有 IS DISTINCT FROM」）。
     *   下面那条运行时断言保证两处条件**不会漂移**：常量一改、这里没同步就当场抛错。
     */
    const UPDATE_SQL = `UPDATE stations SET name_tc = btrim(name_tc)
                          WHERE name_tc IS DISTINCT FROM btrim(name_tc)`;
    if (!UPDATE_SQL.includes(AFFECTED)) {
      throw new Error("UPDATE_SQL 与 AFFECTED 常量不一致（改了判据但没同步 UPDATE 语句）");
    }
    await client.query("BEGIN");
    let written = 0;
    try {
      const res = await client.query(UPDATE_SQL);
      written = res.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    console.log(`✅ 已更新 ${written} 行（预期 ${affected.length}）`);

    // ── 事后核验 ─────────────────────────────────────────────────
    const left = (await client.query(`SELECT count(*)::int AS n FROM stations WHERE ${AFFECTED}`)).rows[0] as { n: number };
    const after = (
      await client.query(`SELECT code, name_tc FROM stations ORDER BY code`)
    ).rows as { code: string; name_tc: string }[];
    const afterHash = hashOf(after);
    const beforeMap = new Map(snap.map((r) => [r.code, r.name_tc]));
    const changed = after.filter((r) => beforeMap.get(r.code) !== r.name_tc);

    console.log("\n──── 事后核验 ────");
    console.log(`① 仍带首尾空白：${left.n} 行 ${left.n === 0 ? "✅" : "❌"}`);
    console.log(`② 行数：${total.n} → ${after.length} ${total.n === after.length ? "✅" : "❌"}`);
    console.log(`③ 实写行数：${written}（必须 = ${affected.length}）${written === affected.length ? "✅" : "❌"}`);
    console.log(`④ 实际变化行数：${changed.length}（必须 = ${affected.length}，否则说明有多余写入）${changed.length === affected.length ? "✅" : "❌"}`);
    for (const c of changed) console.log(`     ${c.code}: 旧 [${JSON.stringify(beforeMap.get(c.code))}] → 新 [${JSON.stringify(c.name_tc)}]`);
    console.log(`⑤ 全表内容哈希：${beforeHash.slice(0, 12)}… → ${afterHash.slice(0, 12)}…（不同是预期，因为 2 行变了）`);

    const ok = left.n === 0 && written === affected.length && changed.length === affected.length && total.n === after.length;
    console.log(`\n核验结论：${ok ? "✅ 全部通过" : "❌ 有不符项 ⇒ 请立即回滚并上报"}`);
    console.log(`回滚：npx tsx db/rollback-v4500-trim-station-name.ts -- --apply --allow-prod --backup=${BACKUP_PATH}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
