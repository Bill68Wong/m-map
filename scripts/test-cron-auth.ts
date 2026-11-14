/**
 * Cron 鉴权门禁（scripts/test-cron-auth.ts · ★ P7 / 2026-11-14）
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 *   旧实现：`CRON_SECRET` 未配置时 `NODE_ENV !== "production"` 即**放行**。
 *   后果不是"理论风险"：本地 `curl localhost:3000/api/cron/rebuild` 实测跑满 8.1s
 *   全量重算（`segment_samples_window` 扫 207,168 行），**真写生产派生表**，
 *   还返回 200 让人以为只是查了一下。
 *
 *   本文件把「未配密钥 ⇒ 一律 401」钉成可执行判据，并额外钉住三条**实现纪律**：
 *     · 判定不得再看 `NODE_ENV`（否则环境一变就又漏）；
 *     · 判定必须用常量时间比较（`timingSafeEqual`），不能退化成 `===`；
 *     · 路由不得自己再拼一遍 `Bearer`（口径只能有一份）。
 *
 * ── 为什么不测「带对密钥 → 200」 ────────────────────────────────────────
 *   那会**真跑一次重算、改写生产派生表**，门禁不能这么干。
 *   所以 HTTP 层的验证只做 401 侧（见本轮验证记录：`dev 无密钥 → 401 / reason=no_secret`），
 *   「放行侧」由本脚本对 `checkCronAuth` 的纯函数断言覆盖 —— 放行与否**只由这一个函数决定**，
 *   路由里那 4 行只负责把 `authorization` / `key` 递进来。
 *
 * 跑法：`npm run test:cron-auth`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkCronAuth } from "../src/lib/security/cron-auth";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${detail ? `  — ${detail}` : ""}`);
}

/** 判定一次并返回 `ok:<bool> reason:<string>` 便于人读 */
function judge(
  authorization: string | null,
  key: string | null,
  secret: string | undefined,
): { ok: boolean; reason: string } {
  const r = checkCronAuth({ authorization, key }, secret);
  return r.ok ? { ok: true, reason: "-" } : { ok: false, reason: r.reason };
}

/** 断言「放行 / 拒绝 + 原因」 */
function expect(
  label: string,
  authorization: string | null,
  key: string | null,
  secret: string | undefined,
  wantOk: boolean,
  wantReason?: "no_secret" | "bad_secret",
): void {
  const g = judge(authorization, key, secret);
  const good = g.ok === wantOk && (!wantReason || g.reason === wantReason);
  ok(
    good,
    label,
    `→ ${g.ok ? "放行" : `拒绝(${g.reason})`}` + (good ? "" : `  期望 ${wantOk ? "放行" : `拒绝(${wantReason})`}`),
  );
}

console.log("═══ ① 未配置密钥：一律拒绝（P7 的核心）═══\n");

// 这一组是本次改动的全部理由：secret 为 undefined 时必须 no_secret，
// **与环境无关** —— 无论 NODE_ENV 是 development 还是 production。
expect("未配密钥 + 无 Authorization", null, null, undefined, false, "no_secret");
expect("未配密钥 + 随便一个 Bearer", "Bearer anything", null, undefined, false, "no_secret");
expect("未配密钥 + ?key=随便写", null, "anything", undefined, false, "no_secret");
expect("未配密钥 + `Bearer `（空 token）", "Bearer ", null, undefined, false, "no_secret");

// 空串是最常见的"占位"写法：`CRON_SECRET=` 写进 .env。
// 若把空串当有效密钥，`Bearer ` 就是万能通行证。
expect("配成空串 + `Bearer `", "Bearer ", null, "", false, "no_secret");
expect("配成空串 + ?key=（空）", null, "", "", false, "no_secret");

console.log("\n═══ ② 配了密钥：Bearer 精确匹配才放行 ═══\n");

expect("正确 Bearer", "Bearer s3cr3t", null, "s3cr3t", true);
expect("错误 Bearer", "Bearer wrong", null, "s3cr3t", false, "bad_secret");
expect("完全没带 Authorization", null, null, "s3cr3t", false, "bad_secret");
// 前缀陷阱：旧实现若用 indexOf/startsWith 就会漏
expect("长度更长的前缀命中（s3cr3t-plus）", "Bearer s3cr3t-plus", null, "s3cr3t", false, "bad_secret");
expect("缺 Bearer 前缀（裸 token）", "s3cr3t", null, "s3cr3t", false, "bad_secret");
expect("大小写不符（bearer）", "bearer s3cr3t", null, "s3cr3t", false, "bad_secret");
expect("尾随空格", "Bearer s3cr3t ", null, "s3cr3t", false, "bad_secret");

console.log("\n═══ ③ `?key=` 兼容口（仍要求同一密钥）═══\n");

expect("?key 正确", null, "s3cr3t", "s3cr3t", true);
expect("?key 错误", null, "wrong", "s3cr3t", false, "bad_secret");
expect("Bearer 正确 + ?key 错误 ⇒ 放行", "Bearer s3cr3t", "wrong", "s3cr3t", true);
expect("Bearer 错误 + ?key 正确 ⇒ 放行", "Bearer wrong", "s3cr3t", "s3cr3t", true);

console.log("\n═══ ④ 密钥形态边界（不能因字符特殊而误判）═══\n");

expect("含正则元字符的密钥（.*+?[]）", "Bearer .*+?[]()", null, ".*+?[]()", true);
expect("含正则元字符的密钥：只差一个点号", "Bearer .*+?[]()", null, ".*+?[](", false, "bad_secret");
expect("含空格/中文的密钥", "Bearer 密 钥 abc", null, "密 钥 abc", true);
expect("超长密钥（200 字节）", `Bearer ${"x".repeat(200)}`, null, "x".repeat(200), true);
expect("超长密钥：少一位", `Bearer ${"x".repeat(199)}`, null, "x".repeat(200), false, "bad_secret");

console.log("\n═══ ⑤ 实现纪律（静态钉子，防回退）═══\n");

const root = path.resolve(import.meta.dirname, "..");
const routeSrc = readFileSync(path.join(root, "src/app/api/cron/rebuild/route.ts"), "utf8");
const authSrc = readFileSync(path.join(root, "src/lib/security/cron-auth.ts"), "utf8");

/**
 * 去掉**整行注释**后再做文本判据。
 *
 * ⚠️ 这一步不是可选的：两个文件都用大段 JSDoc 记录"旧实现靠 NODE_ENV 放行"这件事，
 *   直接对原文 grep 会把**说明文字**当成**代码**命中 —— 本门禁第一版就是这么红的
 *   （34/36，两条假 FAIL）。
 *   只剥「行首是 `*` / `//` / `/*`」的行：本项目注释全是这种整行块注释，
 *   不用正则剥行尾注释，避免被字符串里的 `//`（如 `https://`）骗到。
 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
const routeCode = codeOnly(routeSrc);
const authCode = codeOnly(authSrc);

ok(
  !/NODE_ENV\s*!==\s*["']production["']/.test(routeCode),
  "路由代码里**不得**再出现 `NODE_ENV !== \"production\"` 放行",
);
ok(!/NODE_ENV/.test(authCode), "鉴权模块代码不读 NODE_ENV（判定与环境解耦）");
ok(/checkCronAuth\s*\(/.test(routeCode), "路由调用 checkCronAuth（口径唯一）");
ok(
  !/`Bearer \$\{/.test(routeCode),
  "路由里**不得**自己拼 `Bearer ${...}`（两份口径必然漂移）",
);
ok(/timingSafeEqual/.test(authSrc), "鉴权用常量时间比较（timingSafeEqual）");
ok(/CRON_SECRET/.test(authSrc), "密钥变量名仍是 CRON_SECRET（与 Vercel 配置一致）");
ok(
  /warnedNoSecret/.test(routeCode) && /console\.warn/.test(routeCode),
  "漏配密钥时打一次 warn（否则生产静默 401、无告警）",
);
ok(
  /401/.test(routeCode),
  "未授权回 401（不是 403/200）",
);

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
ok(typeof pkg.scripts["db:rebuild"] === "string", "`npm run db:rebuild` 存在（本地重算入口）");
ok(
  (pkg.scripts["db:rebuild"] ?? "").includes("db-guard"),
  "`db:rebuild` 走 db-guard（打线上库必须显式 --allow-prod）",
);
ok(
  typeof pkg.scripts["test:cron-auth"] === "string" && pkg.scripts.verify.includes("test:cron-auth"),
  "`test:cron-auth` 已接入 verify（否则等于没人跑）",
);

// 步骤清单只能有一份：路由与 CLI 都必须走 run-all，不能各自复刻
const cliSrc = readFileSync(path.join(root, "scripts/rebuild-derived.ts"), "utf8");
ok(/runRebuildSteps/.test(routeCode), "路由用共享步骤清单 runRebuildSteps");
ok(/runRebuildSteps/.test(cliSrc), "CLI 用同一份 runRebuildSteps（口径不漂）");
ok(
  !/rebuildSegmentStats\s*\(/.test(routeCode) && !/rebuildSegmentStats\s*\(/.test(cliSrc),
  "路由与 CLI 都不直接调 rebuildSegmentStats（口径固定点收敛在 run-all）",
);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
