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
 *     · 再**按 handler 切片**，只在被检方法自己的函数体内找调用点
 *       （⚠️ v3.6.0 评审阻断 1：整文件匹配会让「GET 有防护、POST 裸奔」的文件显示 OK）；
 *     · 策略常量**import 运行时同一份**（`src/lib/security/route-policy.ts`），
 *       禁止在脚本里写字面量白名单（否则常量一改脚本就静默恒绿）。
 *
 * ── 判定规则（每个 POST/PUT/PATCH/DELETE 必须命中其一）──────────────────
 *   ① `GONE_PREFIXES` 覆盖（中间件直接 410）—— 已下线，不可达；
 *   ② `SAME_ORIGIN_PREFIXES` 覆盖 **且** 该 handler 内真的调用了 `acquireToken(`（A4 两件套齐全）；
 *   ③ 该 handler 内真的有令牌/限流/同源调用
 *      （`hasInternalToken` / `acquireToken` / `acquireWithWait` / `isSameOrigin`）；
 *   ④ 显式 allowlist（脚本内常量，**每条必须打印豁免理由**）。
 *
 * GET 不校验：只读不写库，风控面由上游令牌桶 + 缓存覆盖（不属 AC-50 范围）。
 *
 * ── 第二部分：错误码闭集（AC-50d）──────────────────────────────────────
 *   PM 的 AC-50d：**4xx/5xx 响应体的 `error` 字段只允许 `API_ERROR` 里列出的取值**。
 *   S6 评审阻断 ③ 就是破了这条：`route-stops` 回了第七个值 `route_not_found`，
 *   而当时**没有任何自动门禁看得到它**（`.verify` 的断言里根本没覆盖这个接口）。
 *   ⇒ 本脚本增加静态扫描：扫每个 `route.ts` 里形如 `error: "字面量"` 的响应，
 *     字面量必须是六枚举之一（或者用 `API_ERROR.x` 标识符 —— 那种天然合规）。
 *
 *   为什么用静态扫描而不是 HTTP 断言：新接口一加，HTTP 断言就得跟着加，
 *   **忘加就等于没门禁**（阻断 ③ 正是这么漏的）；静态扫描对新文件自动生效。
 *
 *   `KNOWN_DEBT` 是**遗留欠账基线**（按「路由 + 字面量」匹配，不按行号 ⇒ 行号漂移不会误报）。
 *   基线内的只打印 `DEBT` 不算失败；**新出现的字面量一律 FAIL**。
 *   修掉某条后本脚本会提示「可从基线移除」，请顺手删行（基线只应缩短，不应变长）。
 *
 * ── 自检（`--self-test`）──────────────────────────────────────────────
 *   门禁脚本自己也会坏，且坏了的样子是「一直绿」。故内置三条反向断言：
 *     ① 裸奔 POST ⇒ 必须 FAIL；
 *     ② 注释里冒充防护调用 ⇒ 必须 FAIL；
 *     ③ **GET 有防护 + POST 裸奔 ⇒ POST 必须 FAIL**（切片回归的固定哨兵）。
 *   改本脚本后请跑 `--self-test`，或连同 `--self-test` 一起跑正式扫描。
 *
 * ── 部署须知（配环境变量的人看这里）──────────────────────────────────
 *   `POST /api/dsat/grab` 需在生产环境配 `GRAB_TOKEN`，未配时仅非生产环境放行（fail-closed）。
 *   本节说明的常规落点是 `.env.example`，但该文件被 `scripts/check-commit-scope.mjs` 的
 *   全文敏感词扫描硬拦（命中项全在历史既有行，与本轮无关），无法随 S2 一起更新 ⇒ 说明落在此处。
 *
 * 跑法：
 *   node node_modules/tsx/dist/cli.mjs scripts/check-api-guards.ts
 *   node node_modules/tsx/dist/cli.mjs scripts/check-api-guards.ts --self-test
 * 退出码：0 = 全部有防护（且自检全过）；1 = 存在裸奔写方法 / 自检失败
 */
import fs from "node:fs";
import path from "node:path";
import {
  GONE_PREFIXES,
  SAME_ORIGIN_PREFIXES,
  WRITE_METHODS,
  underPrefix,
} from "../src/lib/security/route-policy";

const API_ROOT = path.resolve("src/app/api");

type WriteMethod = (typeof WRITE_METHODS)[number];

/**
 * 显式豁免（每条**必须**写理由，并在输出里打印，禁止静默跳过）。
 *
 * 判据不是「这个接口不重要」，而是「它自己有别的鉴权机制」或「它根本不写数据」，
 * 且这两种情形都无法用通用规则安全表达。
 *
 * ⚠️⚠️ 纪律：**豁免理由必须能指出具体的 `文件:行`，否则就是空头支票**。
 *    「已有限流」「已做防护」这种话不算理由 —— 半年后没人能核验，等于永久放行。
 *    写不出文件:行 ⇒ 要么去补真防护，要么这个接口不该豁免。
 *
 * ⚠️ 主理人批准过的条目只有下面 3 条。新增任何一条都必须先拿批准 ——
 *    豁免是门禁上唯一的洞，加一条就等于让一个接口永久不被检查。
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
    pattern: /^\/api\/poi\/suggest$/,
    // ★ 为何不能在这个 handler 里加桶：`search` 桶已在**下游库**取过了，
    //   这里再加会**双扣配额**（一次用户请求扣两次），把搜索可用配额砍半。
    //   核验路径（评审可逐条打开）：
    //     · src/lib/amap/poi.ts:136 —— inputtips() 内 acquireToken(RATE_BUCKET.search)
    //     · src/lib/amap/poi.ts:196 —— placeText() 内 acquireToken(RATE_BUCKET.search)
    //     · src/lib/nav/poi-search.ts:198 —— searchAmap() 先过 circuitState()（高德月配额熔断）
    //   即：本接口的限流与熔断都在调用链上，只是不在 handler 可见范围内。
    reason:
      "限流在下游库而不是 handler：search 桶在 src/lib/amap/poi.ts:136（inputtips）/ :196（placeText）；" +
      "月配额熔断在 src/lib/nav/poi-search.ts:198 circuitState()。handler 再加会双扣配额",
  },
];

/**
 * 「真的调用了防护」的调用点特征。
 *
 * ⚠️ 只在**剥掉注释**后的 handler 切片里匹配 —— 否则一句
 *    `// TODO: 以后加 hasInternalToken` 也会让脚本变绿。
 * ⚠️ `acquireWithWait` 与 `acquireToken` 同属令牌桶（前者是可等待版本，
 *    `transit` 桶与 S5 的 `walking` 桶用的就是它），漏掉会误报 FAIL。
 */
const GUARD_CALLS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bhasInternalToken\s*\(/, label: "Bearer 令牌校验" },
  { pattern: /\brequireInternalToken\s*\(/, label: "Bearer 令牌校验" },
  { pattern: /\bacquire(?:Token|WithWait)\s*\(/, label: "令牌桶限流" },
  { pattern: /\bisSameOrigin\s*\(/, label: "同源校验" },
];

/** 「该 handler 内有限流」的单独判据（A4 两件套要用它，比 GUARD_CALLS 更窄） */
const BUCKET_CALL = /\bacquire(?:Token|WithWait)\s*\(/;

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

/** 找某个方法的导出位置（返回 index；找不到 = -1） */
function exportIndexOf(code: string, method: WriteMethod): number {
  const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const)\\s+${method}\\b`);
  const m = re.exec(code);
  return m ? m.index : -1;
}

/** 该文件是否用 `export { POST }` 形式导出（较少见，切片策略不同） */
function hasReExport(code: string, method: WriteMethod): boolean {
  return new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`).test(code);
}

/** 找出文件里导出的写方法 */
function writeMethodsOf(code: string): WriteMethod[] {
  return WRITE_METHODS.filter((m) => exportIndexOf(code, m) >= 0 || hasReExport(code, m));
}

/**
 * 取某个 handler 的**函数体切片**：从它的 `export` 起，到下一个 `export ` 或文件末尾。
 *
 * ── 为什么必须切片（评审阻断 1）────────────────────────────────────────
 *   整文件匹配时，「`GET` 里调了 `acquireToken`、`POST` 完全裸奔」的文件会被判 OK ——
 *   因为 `GUARD_CALLS` 在整文件里确实找得到 `acquireToken(`。切片后只在该方法自己的
 *   范围内找，这种「顺手被别人的防护照亮」的假绿灯就消失了。
 *
 * @returns `{ text, exact }`；`exact=false` 表示拿不到独立切片（`export { POST }` 形式，
 *          退回整文件匹配）。定位不到函数体时返回 `null`。
 */
function handlerSlice(code: string, method: WriteMethod): { text: string; exact: boolean } | null {
  const start = exportIndexOf(code, method);
  if (start < 0) {
    // `export { POST }` 形式：拿不到独立切片，退回整文件但标记 exact=false
    return hasReExport(code, method) ? { text: code, exact: false } : null;
  }
  const rest = code.slice(start + 1);
  const nextExport = rest.search(/\bexport\s/);
  const text = nextExport < 0 ? code.slice(start) : code.slice(start, start + 1 + nextExport);
  return { text, exact: true };
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
  route: string;
  method: WriteMethod;
  ok: boolean;
  attribution: string;
}

/**
 * 判定单个写方法。
 *
 * @param raw    文件源码（**未剥注释**，函数内部自行处理）
 * @param route  路由路径
 */
function judge(raw: string, route: string, method: WriteMethod): Verdict {
  const code = stripNonCode(raw);

  // ① 已下线（中间件 410）—— 保留代码但不可达
  if (underPrefix(route, GONE_PREFIXES)) {
    return { route, method, ok: true, attribution: "已下线 410（GONE_PREFIXES）" };
  }

  // ④ 豁免清单（理由必须打印，不静默跳过）
  for (const a of ALLOWLIST) {
    if (a.pattern.test(route)) {
      return { route, method, ok: true, attribution: `豁免：${a.reason}` };
    }
  }

  // ★ 只在该 handler 自己的切片里找防护（阻断 1 的修法）
  const sliceInfo = handlerSlice(code, method);
  if (sliceInfo === null) {
    return { route, method, ok: false, attribution: "定位不到该方法的函数体（无法判定防护）" };
  }
  const slice = sliceInfo.text;

  // ② 同源策略覆盖：必须「中间件同源 + 自身限流」两件套齐全
  if (underPrefix(route, SAME_ORIGIN_PREFIXES) && !BUCKET_CALL.test(slice)) {
    return {
      route,
      method,
      ok: false,
      attribution: "在 SAME_ORIGIN_PREFIXES 内但**没有** acquireToken() —— A4 两件套缺一",
    };
  }

  // ③ handler 内有防护调用
  const guards = GUARD_CALLS.filter((g) => g.pattern.test(slice)).map((g) => g.label);
  if (!guards.length) {
    return { route, method, ok: false, attribution: "该 handler 内无任何防护调用（裸奔写方法）" };
  }

  const via =
    underPrefix(route, SAME_ORIGIN_PREFIXES)
      ? `同源 403（中间件）+ ${guards.join(" + ")}`
      : guards.join(" + ");
  return {
    route,
    method,
    ok: true,
    attribution: sliceInfo.exact ? via : `${via}（⚠️ export{} 形式，按整文件匹配）`,
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 自检：把「门禁应该拦住什么」固化成断言
 * ══════════════════════════════════════════════════════════════════════ */

interface SelfCase {
  name: string;
  route: string;
  method: WriteMethod;
  source: string;
  /** 期望判定结果 */
  expectOk: boolean;
}

const SELF_CASES: SelfCase[] = [
  {
    // ⚠️ 这里必须用一个**不在 `GONE_PREFIXES` / `SAME_ORIGIN_PREFIXES` 里**的路径：
    //    用 `/api/timer` 会先命中「已下线 410」而通过，测不到「裸奔」这条规则（自检自己踩过）。
    name: "裸奔 POST",
    route: "/api/self-test/bare",
    method: "POST",
    source: `export async function POST(req: Request) { const b = await req.json(); return json(b); }`,
    expectOk: false,
  },
  {
    name: "注释里冒充防护调用",
    route: "/api/dsat/grab",
    method: "POST",
    source: `export async function POST() {
  // TODO: 以后加 hasInternalToken(req)
  /* acquireToken("x") 只是注释 */
  return ok();
}`,
    expectOk: false,
  },
  {
    name: "GET 有防护 + POST 裸奔（切片回归哨兵）",
    route: "/api/fake",
    method: "POST",
    source: `export async function GET() {
  await acquireToken("dsat");
  return ok();
}

export async function POST(req: Request) {
  const b = await req.json();
  return json(b);
}`,
    expectOk: false,
  },
  {
    name: "POST 自己有令牌桶",
    route: "/api/real",
    method: "POST",
    source: `export async function POST() { const rl = await acquireToken("fav"); return ok(rl); }`,
    expectOk: true,
  },
  {
    name: "POST 自己有 Bearer（acquireWithWait 不被误伤的反向对照）",
    route: "/api/real2",
    method: "POST",
    source: `export async function POST(req: Request) { if (!hasInternalToken(req)) return no(); return ok(); }`,
    expectOk: true,
  },
  {
    name: "POST 用 acquireWithWait（可等待版令牌桶）",
    route: "/api/real3",
    method: "POST",
    source: `export async function POST() { const rl = await acquireWithWait("walking", 600); return ok(rl); }`,
    expectOk: true,
  },
];

function selfTest(): void {
  console.log("═══ 门禁自检（--self-test）═══");
  let bad = 0;
  for (const c of SELF_CASES) {
    const v = judge(c.source, c.route, c.method);
    const ok = v.ok === c.expectOk;
    if (!ok) bad++;
    console.log(
      `${ok ? "OK  " : "FAIL"}  ${c.name.padEnd(38)} 期望=${c.expectOk ? "通过" : "拦截"} 实际=${v.ok ? "通过" : "拦截"}  ${v.attribution}`,
    );
  }
  console.log(`\n自检 ${SELF_CASES.length - bad} / 失败 ${bad}`);
  if (bad) {
    console.error("\n❌ 门禁脚本自身行为不符合预期 —— 它已经不可信，先修脚本再看扫描结果。");
    process.exit(1);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 正式扫描
 * ══════════════════════════════════════════════════════════════════════ */

function scan(): void {
  if (!fs.existsSync(API_ROOT)) {
    console.error(`找不到 ${API_ROOT}（请在仓库根目录运行）`);
    process.exit(1);
  }

  const files = collectRouteFiles(API_ROOT).sort();
  const verdicts: Verdict[] = [];
  const skips: { key: string; reason: string }[] = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const route = routePathOf(file);
    for (const method of writeMethodsOf(stripNonCode(raw))) {
      const v = judge(raw, route, method);
      verdicts.push(v);
      if (v.attribution.startsWith("豁免：")) {
        skips.push({ key: `${method} ${route}`, reason: v.attribution.slice(3) });
      }
      if (!v.ok) {
        // 失败时把文件位置一起打出来，省得再查
        console.log(`      ↳ 文件：${path.relative(process.cwd(), file)}`);
      }
    }
  }

  console.log("═══ 写接口防护门禁（AC-50 · check-api-guards）═══");
  console.log(`扫描 ${files.length} 个 route.ts · 写方法 ${verdicts.length} 个\n`);

  for (const v of verdicts) {
    console.log(`${v.ok ? "OK  " : "FAIL"}  ${v.method.padEnd(6)} ${v.route.padEnd(40)} ${v.attribution}`);
  }

  if (skips.length) {
    console.log("\n── 豁免清单（逐条打印理由，不是静默跳过）──");
    for (const s of skips) console.log(`SKIP  ${s.key.padEnd(40)} ${s.reason}`);
  }

  const failed = verdicts.filter((v) => !v.ok);
  console.log(`\n通过 ${verdicts.length - failed.length} / 失败 ${failed.length}`);
  if (failed.length) {
    console.error(
      "\n❌ 存在没有防护的写方法。给它们加令牌校验（hasInternalToken）、同源校验（isSameOrigin）" +
        "或令牌桶（acquireToken / acquireWithWait）。若确认它其实只读，走 ALLOWLIST 需先获批准。",
    );
    process.exit(1);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 第二部分：错误码闭集（AC-50d）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * **遗留欠账基线**（AC-50d 违规，先于本轮存在）。
 *
 * 键 = `${路由}|${字面量}`（**不按行号**，行号会漂）。基线内只打印 `DEBT`；
 * **任何新出现的字面量都 FAIL**。修掉一条后本脚本会提示移除，**基线只应缩短**。
 *
 * ⚠️ 加基线=又一处空头支票。加之前先问：这个字面量是不是已经下线（该走 GONE_PREFIXES）、
 *    或接口本身是不是 Bearer 保护（该走 ALLOWLIST）？两者都不是才是真欠账。
 */
const KNOWN_DEBT = new Set<string>([
  "/api/card|缺少必填参数（from/to/plan/route/board/alight）",
  "/api/nav|缺少或非法坐标：需 fromLng/fromLat/toLng/toLat（GCJ-02）",
  "/api/plans|方案查询失败，请稍后重试",
  "/api/recommend|缺少参数 from / to",
  "/api/route-shapes|missing_code",
  "/api/route-vehicles|缺少 code 参数（线路码，如 26 / 51A / N6）",
  "/api/route-vehicles|缺少或非法 dir 参数（应为 0 或 1）",
]);

/** 允许出现任意 `error` 字面量的路由（必须打印理由） */
const ERROR_LITERAL_ALLOW: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /^\/api\/cron\/rebuild$/,
    reason: "Bearer CRON_SECRET 保护的非公开运维接口，响应体不进公众面",
  },
];

interface ErrorFinding {
  file: string;
  route: string;
  literal: string;
  /** ok = 字面量本身就是六枚举之一（合规）；其余见注释 */
  status: "ok" | "new" | "debt" | "gone" | "allow";
  reason?: string;
}

/** 扫 `error: "…"` / `error: '…'` 字面量（只认响应构造处，注释与模板串不算） */
function scanErrorLiterals(): ErrorFinding[] {
  const out: ErrorFinding[] = [];
  for (const file of collectRouteFiles(API_ROOT).sort()) {
    const route = routePathOf(file);
    const code = stripNonCode(fs.readFileSync(file, "utf8"));
    // 注意：stripNonCode 会把字符串内容清空 ⇒ 必须用**原文**取字面量值，用**剥注释版**判位置。
    // 这里直接对原文按行扫（注释行前面会被 `//` 或 `*` 开头，简单跳过即可）。
    const rawLines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of rawLines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      const m = /\berror:\s*"([^"]*)"/.exec(line) ?? /\berror:\s*'([^']*)'/.exec(line);
      if (!m) continue;
      const literal = m[1];
      if (!literal) continue; // 空串不当错误码
      let status: ErrorFinding["status"] = "new";
      let reason: string | undefined;
      if (ENUM_VALUES.has(literal)) {
        // 直接写字面量但值在闭集内 ⇒ 合规（AC-50d 管的是**值**，不是写法）
        status = "ok";
      } else if (underPrefix(route, GONE_PREFIXES)) {
        status = "gone";
      } else {
        const allow = ERROR_LITERAL_ALLOW.find((a) => a.pattern.test(route));
        if (allow) {
          status = "allow";
          reason = allow.reason;
        } else if (KNOWN_DEBT.has(`${route}|${literal}`)) {
          status = "debt";
        }
      }
      out.push({ file, route, literal, status, reason });
    }
    void code; // （保留：位置判定目前按行做，不需要剥注释版）
  }
  return out;
}

/**
 * 六枚举闭集 —— **独立于 `API_ERROR` 再列一遍**，故意的。
 *
 * 若这里也 `import { API_ERROR }` 再取 `Object.values()`，那么有人往 `errors.ts`
 * 里加第七个值，本脚本会自动跟着"认可"它 —— 闭集就白设了。
 * ⇒ 脚本侧手工抄一份：**加枚举必须同时改两处**，改动会被 diff 看见。
 */
const ENUM_VALUES = new Set([
  "unauthorized",
  "forbidden",
  "gone",
  "rate_limited",
  "bad_request",
  "upstream_error",
]);

function scanErrors(): void {
  const findings = scanErrorLiterals();
  const ok = findings.filter((f) => f.status === "ok");
  const gone = findings.filter((f) => f.status === "gone");
  const allowed = findings.filter((f) => f.status === "allow");
  const debt = findings.filter((f) => f.status === "debt");
  const bad = findings.filter((f) => f.status === "new");

  console.log("\n═══ 错误码闭集（AC-50d · 4xx/5xx 的 error 只允许六枚举）═══");
  const checked = findings.length - ok.length - gone.length - allowed.length;
  console.log(`扫描 ${findings.length} 处 error 字面量 · 需合规 ${checked} 处` +
    `（已合规 ${ok.length} · 已下线 ${gone.length} · 豁免 ${allowed.length}）\n`);

  for (const f of bad) {
    console.log(`FAIL  ${f.route.padEnd(30)} ${JSON.stringify(f.literal)}`);
    console.log(`      ↳ ${path.relative(process.cwd(), f.file)}`);
  }
  if (debt.length) {
    console.log("── 遗留欠账（基线内，不阻塞；修掉后请从 KNOWN_DEBT 删行，基线只应缩短）──");
    for (const f of debt) console.log(`DEBT  ${f.route.padEnd(30)} ${JSON.stringify(f.literal)}`);
    console.log("");
  }
  if (allowed.length) {
    console.log("── 错误字面量豁免（逐条打印理由）──");
    // 同一路由多条字面量时只打一次理由行，避免重复刷屏
    const seen = new Set<string>();
    for (const f of allowed) {
      if (seen.has(f.route)) continue;
      seen.add(f.route);
      console.log(`SKIP  ${f.route.padEnd(30)} ${f.reason}`);
    }
    console.log("");
  }

  console.log(`错误码闭集：新增违规 ${bad.length} · 遗留欠账 ${debt.length}`);
  if (bad.length) {
    console.error(
      "\n❌ 有新增的 `error` 字面量不在六枚举内。改成 `errorResponse(API_ERROR.xxx)`，" +
        "或 `{ error: API_ERROR.bad_request }`（状态码可自定义，值必须闭集内）。",
    );
    process.exit(1);
  }
}

if (process.argv.includes("--self-test")) selfTest();
scan();
scanErrors();
