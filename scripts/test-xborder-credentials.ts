/**
 * 机场凭据降级门禁（scripts/test-xborder-credentials.ts · ★ P4 / 2026-11-14）
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 *   旧缺陷：`AACM_APPCODE` 未配置时 `/api/cross-border/airport/flights` 回
 *   **503 `upstream_error`**（本地实测 2.004s + `{"ok":false,"error":"upstream_error"}`）。
 *   前端 `useXbList` 把非 2xx 一律当错误 ⇒ `XbError` 说「可能是上游（政府接口）
 *   或我们的采集出了问题」。**归因完全错了**：真相是部署方少配一个环境变量，
 *   用户去查网络、运维去查政府接口，两边都查不到东西。
 *
 *   修法（本文件逐条钉住）：
 *     · 未配 ⇒ `200 + emptyReason:"not_configured"`（**不 503**）；
 *     · 未配 ⇒ **不发起采集**（试了必 403，白打日志 + 白等 2s）；
 *     · 判定口径只有 `credentials.ts` 一份，路由与 `airport/fetch.ts` 都不许自己读 env；
 *     · 未配时每进程打一条 warn（否则线上静默降级，没人发现航班一整天没数据）。
 *
 * ── 为什么大量用静态判据 ──────────────────────────────────────────────
 *   要验的是"路由在缺凭据时**做了什么/没做什么**"，而 `route.ts` 不能导出辅助函数
 *   （Next 的 `.next/types` 导出白名单会让 `next build` 失败，`tsc` 抓不到 ——
 *   本项目踩过），跑 HTTP 又需要真库 + 真上游。
 *   ⇒ 纯函数部分用假 env 直接断言；路由行为用「代码里必须存在/不得存在」的钉子守，
 *     再由本轮验证记录里的**真请求**（改前 503 → 改后 200）兜底。
 *
 * 跑法：`npm run test:xborder-credentials`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AACM_APPCODE_ENV,
  hasAacmAppcode,
  readAacmAppcode,
  type EnvLike,
} from "../src/lib/cross-border/credentials";
import { XB_EMPTY_REASONS } from "../src/lib/cross-border/types";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${detail ? `  — ${detail}` : ""}`);
}

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

/**
 * 去掉**整行注释**后再做文本判据（与 `test-cron-auth.ts` 同一手法）。
 * 必需：这两个文件都用大段 JSDoc 记录"旧实现回 503""凭据从 AACM_APPCODE 读"，
 * 直接 grep 原文会把说明文字当成代码命中。
 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

/* ══════════════════════════════════════════════════════════════════════
 * ① 取值口径（纯函数 · 喂假 env，不碰真环境）
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ① readAacmAppcode / hasAacmAppcode ═══\n");

const cases: Array<{ label: string; env: EnvLike; value: string; has: boolean }> = [
  { label: "完全未定义", env: {}, value: "", has: false },
  { label: "空串（.env 占位形态 `AACM_APPCODE=`）", env: { AACM_APPCODE: "" }, value: "", has: false },
  { label: "纯空白（复制时带了空格）", env: { AACM_APPCODE: "   " }, value: "", has: false },
  { label: "制表符/换行", env: { AACM_APPCODE: "\t\n " }, value: "", has: false },
  { label: "正常值", env: { AACM_APPCODE: "abc123def456" }, value: "abc123def456", has: true },
  { label: "前后各一个空格 ⇒ trim", env: { AACM_APPCODE: " abc123 " }, value: "abc123", has: true },
  { label: "值里含空格（内部空格不裁）", env: { AACM_APPCODE: "a b" }, value: "a b", has: true },
  { label: "只有别的键，不能顶替", env: { AACM_APPCODE_: "abc", other: "abc" }, value: "", has: false },
];

for (const c of cases) {
  ok(
    readAacmAppcode(c.env) === c.value && hasAacmAppcode(c.env) === c.has,
    `取值：${c.label}`,
    `→ "${readAacmAppcode(c.env)}" / has=${hasAacmAppcode(c.env)}`,
  );
}

/* 非字符串（某些运行时会注入 undefined，测试里再试一次 null）：不做 String() 转换 ——
   `String(undefined)` 会得到字面量 "undefined"，那是比"未配"更糟的假阳性。 */
ok(readAacmAppcode({ AACM_APPCODE: undefined }) === "", "取值：值为 undefined ⇒ 视为未配（不变成字符串 \"undefined\"）");
ok(
  readAacmAppcode({ AACM_APPCODE: null as unknown as string }) === "",
  "取值：值为 null ⇒ 视为未配",
);

/* ★ 环境无关：凭据缺失在任何环境都拉不到数据，判定不得看 NODE_ENV。
   （对照 P7：`checkCronAuth` 也是"未配密钥一律拒绝"，同样不看环境。） */
ok(
  hasAacmAppcode({ NODE_ENV: "development" }) === false &&
    hasAacmAppcode({ NODE_ENV: "production" }) === false,
  "环境无关：development/production 下缺凭据都得是「未配」",
);

/* 真实 process.env 里当前确实没配（本仓库本地常态）—— 这条不是断言"应该没配"，
   而是**记录基线**：若本地已配，下面 ②③ 的静态结论仍成立，只是提示一句。 */
const liveHas = hasAacmAppcode();
console.log(
  `INFO 当前进程 ${AACM_APPCODE_ENV} ${liveHas ? "已配置（真实数据可拉取）" : "未配置（接口将走 not_configured 降级）"}`,
);

/* ══════════════════════════════════════════════════════════════════════
 * ② 路由行为钉子（静态 · 防回退）
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ② 路由：未配凭据不得 503、不得试采集 ═══\n");

const ROUTE = "src/app/api/cross-border/airport/flights/route.ts";
const routeCode = codeOnly(read(ROUTE));

ok(/hasAacmAppcode\s*\(/.test(routeCode), "路由用 hasAacmAppcode 判定（口径唯一）");
ok(
  !/process\.env\s*\.\s*AACM_APPCODE/.test(routeCode),
  "路由**不得**自己读 process.env.AACM_APPCODE（两份口径必然漂移）",
);
ok(
  !/NODE_ENV/.test(routeCode),
  "路由代码不读 NODE_ENV（缺凭据与运行环境无关，不许出现「本地放行」式分支）",
);
/* ★ 这条是 P4 的命门：503 分支的前置条件必须含 `refresh.attempted`。
   未配凭据时路由给的是 `{ attempted: false, ok: false }`；
   少了这个前提，`!refresh.ok && fetchedAt === null` 立刻又把未配置变成 503，P4 等于没改。 */
ok(
  /refresh\.attempted\s*&&\s*!\s*refresh\.ok\s*&&\s*fetchedAt\s*===\s*null/.test(routeCode),
  "503 分支必须带 `refresh.attempted &&`（否则未配凭据又回 503）",
);
ok(
  /attempted:\s*false\s*,\s*ok:\s*false/.test(routeCode),
  "未配凭据时构造 `attempted:false, ok:false`（而不是去试一次必失败的上游）",
);
ok(
  /configured\s*\?\s*await\s*tryRefresh/.test(routeCode),
  "已配才调 tryRefresh（未配不发起采集：白打日志 + 白等 2s）",
);
ok(
  /notConfigured\s*:\s*!\s*configured/.test(routeCode),
  "把 `notConfigured: !configured` 交给 buildListResponse（归因在 respond.ts 统一算）",
);
ok(
  /warnedNoCredential/.test(routeCode) && /console\.warn/.test(routeCode),
  "未配时每进程打一次 warn（否则线上静默降级、无人发现）",
);
ok(!/console\.warn[\s\S]{0,200}appcode\b/.test(routeCode), "warn 里不含凭据值（只提变量名）");

/* 反向对照：503 仍然存在。删掉它会把"上游真挂了 + 无旧数据"也降级成 200 空态，
   那是另一个归因错误（用户以为今天没航班）。 */
ok(/API_ERROR\.upstream_error,\s*503/.test(routeCode), "反向对照：上游失败且无旧数据**仍**回 503（不许一刀切降级）");

/* ══════════════════════════════════════════════════════════════════════
 * ③ 取值点与错误文案（fetch.ts）
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ③ fetch.ts：同一个取值口径、文案只提变量名 ═══\n");

const FETCH = "src/lib/cross-border/airport/fetch.ts";
const fetchSrc = read(FETCH);
const fetchCode = codeOnly(fetchSrc);

ok(/readAacmAppcode\s*\(/.test(fetchCode), "fetch.ts 用 readAacmAppcode 取值");
ok(
  !/process\.env\s*\.\s*AACM_APPCODE/.test(fetchCode),
  "fetch.ts **不得**自己读 process.env.AACM_APPCODE",
);
ok(/AACM_APPCODE_ENV/.test(fetchCode), "抛错文案里的变量名来自常量（改名不必两处改）");
ok(/缺少环境变量/.test(fetchCode), "缺凭据时明确抛错（不是静默返回空数组）");
/* 凭据值只能进 `Authorization` 头，**不得**出现在日志/错误文案里
   （本仓库曾因凭据泄漏被封号，见 docs/复盘-GitHub封号事故-20261028.md）。
   判据按"同一行内 console/throw 里出现 `${appcode}`"来写 —— 不能笼统 grep
   `APPCODE ${appcode}`：`Authorization: \`APPCODE ${appcode}\`` 那一行**必须**有值。 */
ok(
  !/console\.(log|warn|error|info)\s*\([^)\n]*\$\{\s*appcode\s*\}/.test(fetchCode) &&
    !/throw new Error\s*\([^)\n]*\$\{\s*appcode\s*\}/.test(fetchCode),
  "凭据值不得出现在日志/错误文案里（只许进 Authorization 头）",
);

const CRED = "src/lib/cross-border/credentials.ts";
const credCode = codeOnly(read(CRED));
ok(!/NODE_ENV/.test(credCode), "credentials.ts 不读 NODE_ENV（判定与环境解耦）");
ok(/AACM_APPCODE/.test(credCode), "变量名常量仍是 AACM_APPCODE（与 .env.example / data.gov.mo 一致）");

/* ══════════════════════════════════════════════════════════════════════
 * ④ 枚举与接线
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ④ 枚举与门禁接线 ═══\n");

ok(
  (XB_EMPTY_REASONS as readonly string[]).includes("not_configured"),
  "XbEmptyReason 含 not_configured（前端才有话术可挂）",
);
/* 文案分支必须真存在：emptyCopy 是 if 链、没有穷尽性检查，
   漏分支会静默落进兜底话术（"数据获取中"），用户被骗去反复刷新。 */
const viewCode = codeOnly(read("src/components/cross-border/xb-view.ts"));
ok(
  /reason\s*===\s*"not_configured"/.test(viewCode),
  "xb-view.ts#emptyCopy 有 not_configured 分支（否则静默显示「数据获取中」）",
);

const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
ok(
  typeof pkg.scripts["test:xborder-credentials"] === "string" &&
    pkg.scripts.verify.includes("test:xborder-credentials"),
  "`test:xborder-credentials` 已接入 verify（否则等于没人跑）",
);

const envExample = read(".env.example");
ok(
  !/^AACM_APPCODE=/m.test(envExample),
  ".env.example 里该键保持注释状态（示例文件不假装已配置）",
);
ok(
  /可选/.test(envExample) && /not_configured/.test(envExample),
  ".env.example 标注「可选，缺省时降级」并写明降级取值（照抄示例的人不会以为必须配）",
);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
