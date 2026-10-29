/**
 * AC-50 写接口防护门禁（scripts/check-api-guards.ts · v3.6.0 S2）
 *
 * ── 它解决的是什么（为什么只能脚本化）───────────────────────────────────
 *   v3.6.0 拆掉访问口令门后，全站接口匿名可达。PM 的 AC-50 原话是：
 *   「不允许存在**仅靠中间件顺带保护**的接口」——意思是每个**会改数据**的写方法，
 *   必须自己拿得出防护凭据（令牌 / 同源 / 限流 / 已下线 410）。
 *
 *   这条是**代码静态事实**，HTTP 层打不出来：接口被挡住时，从外部看每个都"有防护"。
 *   所以只能扫源码。而扫源码最危险的写法是"文件里出现 `require` 字样就算过"——
 *   那等于给自己发假通行证。因此本脚本：
 *     · 先**剥掉注释与字符串里的干扰**，只认真正的调用点；
 *     · 策略常量**import 运行时同一份**（`src/lib/security/route-policy.ts`），
 *       禁止在脚本里写字面量白名单（否则常量一改脚本就静默恒绿）。
 *
 * ── 判定规则（每个 POST/PUT/PATCH/DELETE 必须命中其一）──────────────────
 *   ① `GONE_PREFIXES` 覆盖（中间件直接 410）—— 已下线，不可达；
 *   ② `SAME_ORIGIN_PREFIXES` 覆盖 **且** 文件内真的调用了 `acquireToken(`（A4 两件套齐全）；
 *   ③ 文件内真的有令牌/限流/同源调用（`hasInternalToken` / `acquireToken(` / `isSameOrigin`）；
 *   ④ 显式 allowlist（脚本内常量，**每条必须打印豁免理由**）。
 *
 * GET 不校验：只读不写库，风控面由上游令牌桶 + 缓存覆盖（不属 AC-50 范围）。
 *
 * 跑法：`node node_modules/tsx/dist/cli.mjs scripts/check-api-guards.ts`
 * 退出码：0 = 全部有防护；1 = 存在裸奔写方法（并逐个打印原因）
 */
import fs from "node:fs";
import path from "node:path";
import {
  SAME_ORIGIN_PREFIXES,
  underPrefix,
} from "../src/lib/security/route-policy";
import { GONE_PREFIXES } from "../src/lib/security/route-policy";

const API_ROOT = path.resolve("src/app/api");

/** 会改数据的 HTTP 方法（与 `route-policy.ts` 同口径，此处只用于解析源码） */
const WRITE_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
type WriteMethod = (typeof WRITE_METHODS)[number];

/**
 * 显式豁免（每条**必须**写理由，并在输出里打印，禁止静默跳过）。
 *
 * 判据不是"这个接口不重要"，而是"它自己有防护"或"它根本不写数据"，
 * 且这两种情形都无法用通用规则安全表达（前者是别的鉴权机制，
 * 后者是 POST 语义被 SDK / 只读计算占用）。
 */
const ALLOWLIST: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^\/api\/cron\/rebuild$/,
    reason: "Bearer CRON_SECRET 保护（运维接口，自带鉴权，见 route.ts#authorized）",
  },
  {
    pattern: /^\/api\/amap-service(\/|$)/,
    reason: "高德 JS SDK 代理，POST 属 SDK 协议的一部分，无业务写入、不下发密钥",
  },
  {
    pattern: /^\/api\/nav\/detail-body$/,
    reason: "只读计算（仅 SELECT：站坐标 / 线路色），由前端在详情弹窗调用，无业务写入",
  },
  {
    pattern: /^\/api\/nav\/switch-plans$/,
    reason: "只读计算（按切换目标重算方案），不写任何表",
  },
  {
    pattern: /^\/api\/poi\/suggest$/,
    reason: "搜索建议的 POST 变体（语义只读：查本地别名库 / 高德搜索），已受 search 令牌桶与月配额熔断约束",
  },
];

/**
 * 「真的调用了防护」的调用点特征。
 *
 * ⚠️ 只在**剥掉注释**后的正文里匹配 —— 否则一句
 *    `// TODO: 以后加 hasInternalToken` 也会让脚本变绿。
 */
const GUARD_CALLS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bhasInternalToken\s*\(/, label: "Bearer 令牌校验" },
  { pattern: /\brequireInternalToken\s*\(/, label: "Bearer 令牌校验" },
  { pattern: /\bacquireToken\s*\(/, label: "令牌桶限流" },
  { pattern: /\bisSameOrigin\s*\(/, label: "同源校验" },
];

/** 去掉块注释、行注释与字符串字面量内容（保留代码骨架，避免注释/文案误判） */
function stripNonCode(src: string): string {
  return (
    src
      // 块注释（含 JSDoc）
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      // 行注释
      .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ")
      // 单/双引号字符串内容（保留引号本身，防止跨行错位）
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  );
}

/** 找出文件里导出的写方法（兼容 `export async function POST` 与 `export const POST`） */
function writeMethodsOf(code: string, raw: string): WriteMethod[] {
  const found: WriteMethod[] = [];
  for (const m of WRITE_METHODS) {
    // 用 raw 判导出（注释里提到 `export function POST` 也该拦住；这里 raw 更保守）
    const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${m}\\b`);
    if (re.test(raw)) found.push(m);
    else if (new RegExp(`export\\s*\\{[^}]*\\b${m}\\b[^}]*\\}`).test(raw)) found.push(m);
  }
  return found;
}

/** 文件路径 → 路由路径（`src/app/api/a/[id]/route.ts` → `/api/a/[id]`） */
function routePathOf(file: string): string {
  const rel = path.relative(API_ROOT, path.dirname(file)).split(path.sep).join("/");
  return rel === "." ? "/api" : `/api/${rel}`;
}

/** 递归收集所有 route.ts */
function collectRouteFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectRouteFiles(full, out);
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

interface Verdict {
  file: string;
  route: string;
  method: WriteMethod;
  ok: boolean;
  attribution: string;
}

function judge(file: string, route: string, method: WriteMethod): Verdict {
  const raw = fs.readFileSync(file, "utf8");
  const code = stripNonCode(raw);

  // ① 已下线（中间件 410）—— 保留代码但不可达
  if (underPrefix(route, GONE_PREFIXES)) {
    return { file, route, method, ok: true, attribution: "已下线 410（GONE_PREFIXES）" };
  }

  // 豁免清单（理由必须打印，不静默跳过）
  for (const a of ALLOWLIST) {
    if (a.pattern.test(route)) {
      return { file, route, method, ok: true, attribution: `豁免：${a.reason}` };
    }
  }

  // ③ 文件自身有防护调用
  const guards = GUARD_CALLS.filter((g) => g.pattern.test(code)).map((g) => g.label);
  const hasBucket = /\bacquireToken\s*\(/.test(code);

  // ② 同源策略覆盖：必须「中间件同源 + 自身限流」两件套齐全
  if (underPrefix(route, SAME_ORIGIN_PREFIXES)) {
    if (hasBucket) {
      return { file, route, method, ok: true, attribution: "同源 403（中间件）+ 令牌桶限流" };
    }
    return {
      file,
      route,
      method,
      ok: false,
      attribution: "在 SAME_ORIGIN_PREFIXES 内但**没有** acquireToken() —— A4 两件套缺一",
    };
  }

  if (guards.length) {
    return { file, route, method, ok: true, attribution: guards.join(" + ") };
  }

  return { file, route, method, ok: false, attribution: "无任何防护调用（裸奔写方法）" };
}

function main(): void {
  if (!fs.existsSync(API_ROOT)) {
    console.error(`找不到 ${API_ROOT}（请在仓库根目录运行）`);
    process.exit(1);
  }

  const files = collectRouteFiles(API_ROOT).sort();
  const verdicts: Verdict[] = [];
  const skips: { route: string; reason: string }[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const code = stripNonCode(raw);
    const route = routePathOf(file);
    for (const method of writeMethodsOf(code, raw)) {
      const v = judge(file, route, method);
      verdicts.push(v);
      if (v.attribution.startsWith("豁免：")) {
        skips.push({ route: `${method} ${route}`, reason: v.attribution.slice(3) });
      }
    }
  }

  console.log("═══ 写接口防护门禁（AC-50 · check-api-guards）═══");
  console.log(`扫描 ${files.length} 个 route.ts · 写方法 ${verdicts.length} 个\n`);

  for (const v of verdicts) {
    const tag = v.ok ? "OK  " : "FAIL";
    console.log(`${tag}  ${v.method.padEnd(6)} ${v.route.padEnd(40)} ${v.attribution}`);
    if (!v.ok) console.log(`      ↳ 文件：${path.relative(process.cwd(), v.file)}`);
  }

  if (skips.length) {
    console.log("\n── 豁免清单（逐条打印理由，不是静默跳过）──");
    for (const s of skips) console.log(`SKIP  ${s.route.padEnd(40)} ${s.reason}`);
  }

  const failed = verdicts.filter((v) => !v.ok);
  console.log(`\n通过 ${verdicts.length - failed.length} / 失败 ${failed.length}`);
  if (failed.length) {
    console.error(
      "\n❌ 存在没有防护的写方法。给它们加令牌校验（hasInternalToken）、同源校验（isSameOrigin）" +
        "或令牌桶（acquireToken），或确认它其实只读并加进本脚本 ALLOWLIST（附理由）。",
    );
    process.exit(1);
  }
}

main();
