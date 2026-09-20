/**
 * 数据库目标守卫 —— 离线脚本的统一入口（`scripts/db-guard.ts`）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 本项目**只有一套云端库**（生产库），队友们共用同一套数据。而 `db:*` 系列命令
 * 在**不带参数时会回退到 `DATABASE_URL`（= 生产库）** ⇒ 一条手滑的命令就能改动
 * 线上真实数据。本守卫把「明确知道自己在动线上库」变成一次**必须显式表达**的动作。
 *
 * ── 规则（只有一条）─────────────────────────────────────────────────────
 *   目标是**本地库**（localhost / 127.0.0.1 / ::1 / *.local）→ 直接放行
 *   目标是**非本地**（云端生产库 / 局域网库 / 其它）→ **必须**在命令末尾加 `--allow-prod`，
 *   否则只打印提示、**不执行**、退出码 1。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   # 由 package.json 调用（推荐路径）
 *   npm run db:seed                      # 被拦住（因为目标是线上库）
 *   npm run db:seed -- --allow-prod      # 确认动线上 ⇒ 正常执行
 *   npm run db:schema -- cloud --allow-prod
 *
 *   # 只想看判定结果，不执行任何东西
 *   npx tsx scripts/db-guard.ts check
 *   npx tsx scripts/db-guard.ts check --url=postgresql://user:pw@host:5432/db
 *
 * ── 边界（诚实说明）────────────────────────────────────────────────────
 *   · 它防的是**手滑**，不是恶意绕过：直接 `npx tsx db/seed.ts` 仍会执行。
 *     团队约定：**一律走 npm script**（见 `docs/协作-多人开发与上线规矩.md`）。
 *   · 它**不参与应用运行时**（`src/` 一律不 import 本文件）—— Vercel 上的接口与 Cron
 *     不受任何影响。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");

export type TargetKind = "local" | "cloud" | "remote";

export interface DbTarget {
  kind: TargetKind;
  host: string;
  port: string;
  user: string;
  database: string;
}

/** 载入项目根 `.env`（没有也不报错，交给下面的「未找到连接串」分支） */
export function loadEnv(): void {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    /* 没有 .env：后面会提示缺连接串 */
  }
}

/**
 * 按**与既有 db 脚本完全一致**的口径挑选连接串：
 * `cloud` 参数 → DATABASE_URL · `local` 参数 → DATABASE_URL_LOCAL ·
 * 缺省 → 优先 DATABASE_URL_LOCAL，否则回退 DATABASE_URL。
 */
export function pickUrl(args: string[]): { url: string | undefined; source: string } {
  if (args.includes("cloud")) return { url: process.env.DATABASE_URL, source: "参数 `cloud` ⇒ DATABASE_URL" };
  if (args.includes("local")) return { url: process.env.DATABASE_URL_LOCAL, source: "参数 `local` ⇒ DATABASE_URL_LOCAL" };
  if (process.env.DATABASE_URL_LOCAL) {
    return { url: process.env.DATABASE_URL_LOCAL, source: "缺省：命中 DATABASE_URL_LOCAL（本地库）" };
  }
  return { url: process.env.DATABASE_URL, source: "缺省：无本地库 ⇒ **回退 DATABASE_URL**" };
}

/** 解析连接串 → 目标判定（不做任何网络连接） */
export function classify(url: string): DbTarget {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".local");
  const isCloud = /(^|\.)supabase\.com$/.test(host) || /(^|\.)supabase\.co$/.test(host) || /pooler\.supabase\.com$/.test(host);
  return {
    kind: isLocal ? "local" : isCloud ? "cloud" : "remote",
    host,
    port: u.port || "-",
    user: u.username ? decodeURIComponent(u.username) : "-",
    database: u.pathname.replace(/^\//, "") || "-",
  };
}

/** 打码后的连接串（**永不打印密码**；只用来让人确认「打到哪」） */
export function maskUrl(url: string): string {
  const u = new URL(url);
  const user = u.username ? `${decodeURIComponent(u.username)}@` : "";
  return `${u.protocol}//${user}${u.hostname}:${u.port || "-"}/${u.pathname.replace(/^\//, "")}`;
}

const LINE = "─".repeat(66);
const KIND_LABEL: Record<TargetKind, string> = {
  local: "本地库（localhost）",
  cloud: "云端库（**线上生产库**）",
  remote: "非本地库（局域网 / 其它主机）",
};

function banner(target: DbTarget, source: string, url: string, willRun?: string): void {
  const acct = target.kind === "local" ? target.user : `${target.user}${target.user.startsWith("dev_partner") ? "（受限合作者账号）" : target.user === "postgres" || target.user.startsWith("postgres.") ? "（负责人超级账号）" : ""}`;
  console.log(LINE);
  console.log(` 🎯 数据库目标：${KIND_LABEL[target.kind]}`);
  console.log(`    连接串：${maskUrl(url)}`);
  console.log(`    账号：${acct}`);
  console.log(`    来源：${source}`);
  if (willRun) console.log(`    即将执行：${willRun}`);
  console.log(LINE);
}

function usage(): never {
  console.log(
    [
      "数据库目标守卫 —— 用法：",
      "  tsx scripts/db-guard.ts run <脚本路径> [参数...] [--allow-prod]",
      "  tsx scripts/db-guard.ts check [--url=postgresql://...]",
      "",
      "说明：目标是本地库时直接放行；非本地（含线上生产库）必须显式加 --allow-prod。",
    ].join("\n"),
  );
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  loadEnv();

  // ── check：只看判定，不执行任何脚本 ──
  if (cmd === "check") {
    const rest = argv.slice(1);
    const inline = rest.find((a) => a.startsWith("--url="));
    const picked = inline ? { url: inline.slice("--url=".length), source: "命令行 --url" } : pickUrl(rest);
    if (!picked.url) {
      console.log("⚠️ 未找到连接串（.env 里既没有 DATABASE_URL_LOCAL 也没有 DATABASE_URL）");
      process.exit(2);
    }
    const t = classify(picked.url);
    banner(t, picked.source, picked.url);
    console.log(t.kind === "local" ? "✅ 判定：本地库 ⇒ 直接放行（无需 --allow-prod）" : "🔒 判定：非本地 ⇒ 需要 --allow-prod 才放行");
    process.exit(0);
  }

  if (cmd !== "run") usage();

  const rest = argv.slice(1);
  const allowProd = rest.includes("--allow-prod");
  const passArgs = rest.filter((a) => a !== "--allow-prod");
  const script = passArgs[0];
  if (!script) usage();
  const scriptArgs = passArgs.slice(1);

  const picked = pickUrl(scriptArgs);
  if (!picked.url) {
    console.log("❌ 未找到连接串：请在 `.env` 配置 DATABASE_URL（参照 `.env.example`）");
    process.exit(2);
  }
  const t = classify(picked.url);
  banner(t, picked.source, picked.url, `${script}${scriptArgs.length ? " " + scriptArgs.join(" ") : ""}`);

  if (t.kind !== "local" && !allowProd) {
    console.log("⚠️  目标是**非本地库**（本项目的云端库 = 线上生产库，队友们共用同一套数据）");
    console.log("    改动会**立刻**反映到真实用户，或覆盖别人的数据。为防手滑，本命令默认**不执行**。");
    console.log("");
    console.log("    确认要动它，请在命令末尾加 `--allow-prod` 重跑：");
    console.log(`      npm run <脚本名> -- ${scriptArgs.length ? scriptArgs.join(" ") + " " : ""}--allow-prod`);
    console.log("");
    console.log("    若你只是想本地开发：请把 `.env` 的 DATABASE_URL 指向**你自己的**数据库，");
    console.log("    或参见 `docs/协作-多人开发与上线规矩.md` 的数据规矩。");
    console.log(LINE);
    process.exit(1);
  }

  if (t.kind !== "local") console.log("🔓 已确认动非本地库（--allow-prod）：开始执行…");

  const r = spawnSync(process.execPath, [TSX_CLI, script, ...scriptArgs], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) {
    console.error(`❌ 启动失败：${r.error.message}`);
    process.exit(1);
  }
  process.exit(r.status ?? 1);
}

// 仅在作为入口直接运行时执行（被 import 用于自测时不跑）
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
