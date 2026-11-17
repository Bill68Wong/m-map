#!/usr/bin/env node
/**
 * 回滚：从 migrate-route-shapes-official.mjs 产出的备份文件还原 route_shapes
 *
 * 用法：
 *   node scripts/rollback-route-shapes-official.mjs --backup out.json            # dry-run（默认，零写入）
 *   node scripts/rollback-route-shapes-official.mjs --backup out.json --apply    # 真还原（单事务）
 *
 * ── 设计要点 ────────────────────────────────────────────────────────────
 *   · 默认 dry-run，与迁移脚本对称；不给 --apply 一行都不写。
 *   · 幂等：逐行比对新旧 polyline 的 sha256，只还原「当前值 != 备份值」的行。
 *     所以「还原 → 再还原」第二次是 0 行；「迁移 → 回滚 → 回滚」也是 0 行。
 *   · 5432 会话模式单连接（pooler 6543 事务模式下多语句快照不保证一致）。
 *   · 只碰备份文件里出现的 (route_code, dsat_dir)，不整表覆盖 —— 期间新增的行不会被误删/误改。
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 仓库根：由**脚本自身位置**反推，不许写死本机盘符/目录（理由见 migrate 脚本同处注释）。
 * `ROOT_FILE`：同一位置的目录 URL（末尾带 `/`），供 `createRequire` 使用。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILE = pathToFileURL(ROOT + "/").href;
const pg = createRequire(ROOT_FILE + "package.json")("pg");

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const bi = argv.indexOf("--backup");
const BACKUP = bi >= 0 ? argv[bi + 1] : null;
if (argv.includes("--help") || argv.includes("-h") || !BACKUP) {
  console.log("用法: node scripts/rollback-route-shapes-official.mjs --backup <path> [--apply]");
  process.exit(BACKUP ? 0 : 1);
}
if (!existsSync(BACKUP)) { console.error("FATAL: 备份文件不存在: " + BACKUP); process.exit(1); }

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const die = (m) => { console.error("FATAL: " + m); process.exit(1); };

const doc = JSON.parse(readFileSync(BACKUP, "utf8"));
if (!doc.rows || !Array.isArray(doc.rows)) die("备份文件缺 rows 数组");
if (doc.rows.length !== 117) die(`备份行数 ${doc.rows.length} != 117（文件不完整，拒绝使用）`);

function envK(n) {
  for (const f of [ROOT + "/.env", ROOT + "/.env.local"]) {
    let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
    for (const l of t.split(/\r?\n/)) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l); if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, ""); }
  }
  return "";
}
const url = new URL(envK("DATABASE_URL"));
const client = new pg.Client({
  host: url.hostname, port: 5432, user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password), database: "postgres", ssl: { rejectUnauthorized: false },
});
await client.connect();
console.log("INFO : 数据库连接：5432 会话模式单连接");
console.log(`INFO : 备份文件 ${BACKUP}（${doc.rows.length} 行，created_at ${doc.created_at_utc || "?"}）`);

const cur = new Map();
for (const r of (await client.query(`select route_code, dsat_dir, points, polyline from route_shapes`)).rows) {
  cur.set(`${r.route_code}/${r.dsat_dir}`, r);
}

const todo = [], same = [], missing = [];
for (const b of doc.rows) {
  const k = `${b.route_code}/${b.dsat_dir}`;
  const c = cur.get(k);
  if (!c) { missing.push(k); continue; }
  if (sha256(c.polyline) === sha256(b.polyline)) same.push(k);
  else todo.push({ ...b, _curPoints: c.points });
}

console.log("");
console.log("── 回滚推演 " + "─".repeat(50));
console.log(`  备份行数            ${doc.rows.length}`);
console.log(`  当前已与备份一致    ${same.length}（幂等：无需动）`);
console.log(`  需要还原            ${todo.length}`);
console.log(`  库中已不存在        ${missing.length}${missing.length ? " → " + missing.join(", ") : ""}`);
if (todo.length) console.log(`  预览（前 5）        ${todo.slice(0, 5).map((t) => `${t.route_code}/${t.dsat_dir} ${t._curPoints}→${t.points}点`).join(" ｜ ")}`);

if (!APPLY) {
  console.log("");
  console.log("INFO : DRY-RUN：未执行任何 UPDATE。加 --apply 才写库。");
  await client.end();
  process.exit(0);
}
if (!todo.length) { console.log("\nOK   : 幂等：0 行需要还原，不写库"); await client.end(); process.exit(0); }

try {
  await client.query("BEGIN");
  for (const t of todo) {
    const res = await client.query(
      `update route_shapes set polyline = $1, points = $2, geom_source = 'amap-gcj02'
        where route_code = $3 and dsat_dir = $4 returning route_code`,
      [t.polyline, Number(t.points), t.route_code, t.dsat_dir]);
    if (res.rowCount !== 1) throw new Error(`还原行数 ${res.rowCount}（期望 1）：${t.route_code}/${t.dsat_dir}`);
  }
  for (const t of todo) {
    const chk = await client.query(`select points from route_shapes where route_code=$1 and dsat_dir=$2`, [t.route_code, t.dsat_dir]);
    if (Number(chk.rows[0].points) !== Number(t.points)) throw new Error(`自检失败 ${t.route_code}/${t.dsat_dir}`);
  }
  await client.query("COMMIT");
  console.log(`\nOK   : 已还原 ${todo.length} 行（单事务）`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  die("还原失败已回滚：" + e.message);
}
await client.end();
