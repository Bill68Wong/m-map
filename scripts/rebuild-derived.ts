/**
 * 派生数据全量重算 CLI（scripts/rebuild-derived.ts，★ P7 / 2026-11-14 新增）
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────
 *   P7 把 `/api/cron/rebuild` 收紧成「无 CRON_SECRET 一律 401」后，本地就不再有
 *   「一条 GET 就能重算」的口子了。**这是有意的**：那个口子会写生产派生表。
 *   替代入口就是本脚本 —— 与 cron **同一份步骤清单**（`src/lib/rebuild/run-all.ts`）。
 *
 * ── 用法 ──────────────────────────────────────────────────────────────
 *   npm run db:rebuild                          # 打本地库（localhost 直接放行）
 *   npm run db:rebuild -- cloud --allow-prod     # 打线上库（必须显式 --allow-prod）
 *
 *   ⚠️ `--allow-prod` 是 `scripts/db-guard.ts` 的规矩，不是本脚本的：目标是线上库时
 *      不加它只会打印提示、不执行。别把它当成可以省的参数。
 *
 * ── 与旧脚本的分工 ────────────────────────────────────────────────────
 *   `db:segments` / `db:walktimes` / `db:transferwalks` 是**单项**重建（带 --dry、
 *   --from=<口径> 等诊断参数），做对拍/排查时用它们。
 *   本脚本只做「与 cron 完全一样」的那一轮——口径固定 `sampleFrom=track`，
 *   因为它的用途是**复现 cron 行为**，不是做实验。
 *
 * ── 输出 ──────────────────────────────────────────────────────────────
 *   逐步骤打印 ok / 耗时 / 关键计数；任一步失败 ⇒ 退出码 1（便于 CI / `&&` 串联）。
 *   失败不中断后续步骤，与路由内行为一致（理由见 run-all.ts 顶部）。
 */
import { Pool } from "pg";
import { runRebuildSteps } from "../src/lib/rebuild/run-all";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在：CI 里用真实环境变量 */
}

const target = ((process.argv[2] ?? "cloud") as "local" | "cloud");
if (!["local", "cloud"].includes(target)) {
  throw new Error(`第一个参数只能是 local|cloud（收到 ${target}）`);
}
const dbUrl = target === "cloud" ? process.env.DATABASE_URL : (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL);
if (!dbUrl) throw new Error(`未找到 ${target === "cloud" ? "DATABASE_URL" : "DATABASE_URL_LOCAL"}`);

const u = new URL(dbUrl);
const pool = new Pool({
  host: u.hostname,
  port: Number(u.port || 5432),
  database: u.pathname.slice(1),
  user: u.username,
  password: decodeURIComponent(u.password || ""),
  ...(target === "cloud" ? { ssl: { rejectUnauthorized: false } } : {}),
});

/** 摘要里挑几个最能说明问题的数字打出来（不同步骤字段不同，缺失就跳过） */
function brief(summary: Record<string, unknown>): string {
  const keys = [
    "deleted",
    "remaining",
    "sessions",
    "samples",
    "written",
    "inserted",
    "valid",
    "totalSamples",
    "before",
    "flights",
    "sailings",
  ];
  const parts: string[] = [];
  for (const k of keys) {
    const v = summary[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join(" · ");
}

async function main() {
  const t0 = Date.now();
  console.log(`▶ 派生数据全量重算（${target}）· 口径 sampleFrom=track（与 cron 一致）`);
  const results = await runRebuildSteps(pool);

  for (const r of results) {
    const head = `${r.ok ? "✅" : "❌"} ${r.name.padEnd(24)} ${String(r.ms).padStart(6)}ms`;
    if (r.ok) console.log(`${head}  ${brief(r.summary)}`);
    // 失败信息原文照打：截断后反而看不出是哪张表/哪个 SQL 出问题
    else console.log(`${head}  ${r.err}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? `\n✅ 全部 ${results.length} 个步骤成功，总耗时 ${Date.now() - t0}ms`
      : `\n❌ ${failed.length}/${results.length} 个步骤失败：${failed.map((r) => r.name).join(", ")}`,
  );
  await pool.end();
  process.exitCode = failed.length === 0 ? 0 : 1;
}

void main().catch(async (e) => {
  console.error("❌ 重算中止：", e instanceof Error ? e.message : e);
  // 连池都没建起来时 pool.end() 也要容错，否则退出码会被二次异常吃掉
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
