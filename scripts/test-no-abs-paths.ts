/**
 * 本机专属绝对路径静态门禁（`scripts/test-no-abs-paths.ts`，2026-11-11 新建）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   PR #96 修掉了 18 个文件里 39 处写死的作者机路径（`<盘符>:/…/musttoukou`）。
 *   这类字符串**编译通过、类型通过、单测通过**，只有在**别人的机器**上才会炸：
 *   队友 checkout 后 `npm run verify` 在 `test:remaining-route` 读 `.env` 时 ENOENT，
 *   整条链必红 —— 而报错位置离真正的原因（一行写死的路径）很远，极难分诊。
 *   负责人裁定：加一道自动检查，别让它再长回来。
 *
 * ── 判据总数：共 20 条（A3 / B6 / C2 / D5 / E2 / F2）────────────────────────
 *   A 组  本仓库根路径写死（盘符或绝对根斜杠 + 仓库名）
 *   B 组  写死具体用户名（`<盘符>:/Users/<名字>/`、`/Users/<名字>/`、`/home/<名字>/`）
 *   C 组  「有 env / homedir 就放过」的漏洞必须不存在（同行有动态来源仍判红）
 *   D 组  注释剔除的有效性自证（注释里的路径不算违规，代码里的算）
 *   E 组  分母（扫描文件数 > 300；且扫描集**包含本文件自身**）
 *   F 组  默认失败（目录不存在 / 文件读不到 ⇒ 判红，不 skip）
 *
 * ── 规则为什么这么定（照工单口径，且不误伤存量）────────────────────────────
 *   · A 组按工单口径看「仓库名前 30 字符内是否有盘符或绝对根斜杠」，另加一条
 *     「盘符 + 路径紧邻仓库名」的兜底正则：长路径会把盘符挤出窗口，只看窗口会漏判。
 *   · B 组要求命中处**紧跟引号（或模板插值的 `}`）**。理由：`https://host/home/x`、
 *     站内路由 `/api/home/x` 这类合法路径若不加这个前提会被误判成「写死用户名」。
 *     同时要求「用户名目录 + 后续一段」成立（`Users/<名字>/` 完整出现），与工单
 *     写明的形态一致。
 *   · 白名单只看**账户名这一层**：`Program Files` / `Program Files (x86)` / `Public`
 *     / `Shared` / `Default` 不是个人账户名 ⇒ 放行。除此之外一律红。
 *   · C 组是**反向**判据：没有「有 process.env / os.homedir 就豁免」的后门。
 *     写死用户名本身不可移植，有降级链也不代表别人跑得动（降级链只是不崩而已）。
 *     注意：这**不**针对 `db/migrate-v3703-drop-legacy.ts` 的 `PG_DUMP_PATH` 优先 +
 *     `?? null` 降级 —— 那一串是 `D:/Development/Databases/PostgreSQL/bin/`，属于
 *     「工具安装位置」而非「个人账户目录」，本门禁不覆盖该形态（见下方边界）。
 *
 * ── 边界（明确不覆盖，避免误以为是万能）────────────────────────────────────
 *   · 不含用户名、但同样只在本机成立的工具安装路径（如 `D:/Development/Databases/…`）
 *     不在本门禁射程内：它们已有 env 优先 + 返回 null 的降级链，且形态因机器而异，
 *     强行匹配会误伤 `C:/Program Files/...` 这类正常跨平台候选。
 *   · 注释剔除是**状态机**（区分字符串/模板/正则/行注释/块注释），但模板字面量里的
 *     `${…}` 表达式按字符串整体保留、不递归解析；JSX 文本里若出现落单的直角引号，
 *     可能让后续状态偏移。两者都只会「少报」，不会误报。
 *
 * ── 防假绿 ────────────────────────────────────────────────────────────────
 *   · 只读磁盘真实文件；不 import 生产模块、不连库、不跑被测脚本。
 *   · 不做整行快照相等比较；匹配的是结构正则。
 *   · 每条失败信息都带「文件路径 + 行号 + 命中片段」。
 *   · 读不到 / 目录不存在 ⇒ 判红，绝不 skip、绝不 exit(0)。
 *   · 扫描集**包含本文件自身**（E2 断言）；本文件的自测样例按路径段拼接构造，
 *     因此本文件在自身规则下是干净的 —— 无需「排除自己」的后门。
 *
 * 跑法：`npm run test:no-abs-paths`（verify 链第 37 段）
 */
import { readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.resolve(fileURLToPath(import.meta.url));

const SCAN_DIRS = ["db", "scripts", "src"] as const;
const EXTS = new Set([".ts", ".tsx", ".mjs", ".js"]);
/** 目录级豁免：与 `eslint.config.mjs` 的 ignores 对齐（构建产物 / 本地产物 / 非产品代码） */
const SKIP_DIRS = new Set([
  "node_modules",
  ".verify",
  "docs",
  "backups",
  "data",
  "public",
  "out",
  "build",
]);

/** 扫描文件数下限：低于此值说明「扫描根本没跑起来」，直接判红 */
const MIN_FILES = 300;

let pass = 0;
let fail = 0;
const registered: string[] = [];

function rel(p: string): string {
  const r = path.relative(ROOT, p).split(path.sep).join("/");
  return r === "" ? "." : r;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 注册并执行一条判据。detail 必须能直接定位问题（路径 + 行号 + 缺了什么） */
function check(id: string, label: string, cond: boolean, detail: string): void {
  registered.push(id);
  if (cond) {
    pass++;
    console.log(`  PASS  ${id}  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${id}  ${label}  →  ${detail}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 注释剔除：状态机（区分字符串 / 模板 / 正则 / 行注释 / 块注释）
 * 输出与原文字数无关，但**换行数严格一致** ⇒ 行号可直接用于报错。
 * ════════════════════════════════════════════════════════════════════════ */
type ScanState = "code" | "line" | "block" | "dq" | "sq" | "tpl" | "regex" | "regexClass";

/** 能出现在正则字面量之前的「上一个有意义字符」 */
const REGEX_PREV = new Set("=(,:;[!&|?{}+-*%~^<>".split(""));

function stripComments(source: string): string {
  const n = source.length;
  let out = "";
  let st: ScanState = "code";
  let prevSig = "";
  let i = 0;
  while (i < n) {
    const c = source.charAt(i);
    const c2 = i + 1 < n ? source.charAt(i + 1) : "";
    if (st === "code") {
      if (c === "/" && c2 === "/") {
        st = "line";
        out += " ";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        st = "block";
        out += " ";
        i += 2;
        continue;
      }
      if (c === '"') {
        st = "dq";
        out += c;
        i++;
        continue;
      }
      if (c === "'") {
        st = "sq";
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        st = "tpl";
        out += c;
        i++;
        continue;
      }
      if (c === "/" && (prevSig === "" || REGEX_PREV.has(prevSig))) {
        st = "regex";
        out += c;
        i++;
        continue;
      }
      out += c;
      if (!/\s/.test(c)) prevSig = c;
      i++;
      continue;
    }
    if (st === "line") {
      if (c === "\n") {
        st = "code";
        prevSig = "";
        out += c;
      } else {
        out += " ";
      }
      i++;
      continue;
    }
    if (st === "block") {
      if (c === "*" && c2 === "/") {
        st = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? "\n" : " ";
      i++;
      continue;
    }
    if (st === "dq" || st === "sq" || st === "tpl") {
      /* 字符串**原样保留** —— 违规路径就藏在字符串里，抹掉等于自废武功 */
      if (c === "\\") {
        out += c + c2;
        i += 2;
        continue;
      }
      out += c;
      const closed = (st === "dq" && c === '"') || (st === "sq" && c === "'") || (st === "tpl" && c === "`");
      if (closed) {
        st = "code";
        prevSig = c;
      }
      i++;
      continue;
    }
    if (st === "regex") {
      out += c;
      if (c === "\\") {
        out += c2;
        i += 2;
        continue;
      }
      if (c === "[") st = "regexClass";
      else if (c === "/") {
        st = "code";
        prevSig = "/";
      } else if (c === "\n") {
        /* 跨行 ⇒ 其实不是正则字面量，退回普通代码态，避免吞掉后续代码 */
        st = "code";
        prevSig = "";
      }
      i++;
      continue;
    }
    /* regexClass */
    out += c;
    if (c === "\\") {
      out += c2;
      i += 2;
      continue;
    }
    if (c === "]") st = "regex";
    i++;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 两条匹配规则
 * ════════════════════════════════════════════════════════════════════════ */
const REPO_WORD = "musttoukou";
const DRIVE_PATH = /[A-Za-z]:[\\/]/;
/** 绝对根斜杠前缀：`/mnt/d/...` `/Users/...`；要求斜杠前不是字母数字（排除 `Bill68Wong/`） */
const ABS_PREFIX = /(?:^|[^A-Za-z0-9_.:-])\/(?:[^\s/"'`]+\/)+[^\s/"'`]*$/;
/** 兜底：盘符 + 路径紧邻仓库名（长路径把盘符挤出 30 字符窗口时不漏判） */
const REPO_ADJACENT = new RegExp(`[A-Za-z]:[\\\\/][^\\s"'\\x60]*${REPO_WORD}`);

function hitsRepoRoot(line: string): boolean {
  let idx = line.indexOf(REPO_WORD);
  while (idx !== -1) {
    const before = line.slice(Math.max(0, idx - 30), idx);
    if (DRIVE_PATH.test(before) || ABS_PREFIX.test(before)) return true;
    idx = line.indexOf(REPO_WORD, idx + 1);
  }
  return REPO_ADJACENT.test(line);
}

/** 账户名白名单（只看 `Users/<这一层>`）：这些不是个人账户名 */
const NAME_WHITELIST = new Set(["program files", "program files (x86)", "public", "shared", "default"]);
/** 命中处的前一个字符：引号（字符串字面量起点）或 `}`（模板插值结尾） */
const LEAD_OK = new Set(['"', "'", "`", "}"]);
/** `Users/<名字>/` 或 `home/<名字>/`（要求后面还有一段，与工单形态一致） */
const USER_DIR = /(?:[A-Za-z]:)?\/(users|home)\/([^/"'`\r\n]+?)\//gi;

function hitsUserPath(line: string): boolean {
  const norm = line.replace(/\\/g, "/");
  USER_DIR.lastIndex = 0;
  let m = USER_DIR.exec(norm);
  while (m !== null) {
    const name = m[2].trim().toLowerCase();
    const lead = m.index > 0 ? norm.charAt(m.index - 1) : "";
    if (LEAD_OK.has(lead) && !NAME_WHITELIST.has(name)) return true;
    m = USER_DIR.exec(norm);
  }
  return false;
}

/** 对**任意源码片段**跑同一套规则（自测用；先剔注释，再逐行匹配） */
function judgeViolation(src: string): boolean {
  const lines = stripComments(src).split("\n");
  for (const line of lines) {
    if (hitsRepoRoot(line) || hitsUserPath(line)) return true;
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 目录遍历与逐文件扫描
 * ════════════════════════════════════════════════════════════════════════ */
interface Walk {
  files: string[];
  errors: string[];
}

function walk(dir: string, acc: Walk): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    acc.errors.push(`${rel(dir)}：${errMsg(e)}`);
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".next")) continue;
      walk(full, acc);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!EXTS.has(path.extname(ent.name).toLowerCase())) continue;
    acc.files.push(full);
  }
}

interface Hit {
  file: string;
  line: number;
  snippet: string;
}

interface FileScan {
  a: Hit[];
  b: Hit[];
  error?: string;
}

function scanFile(file: string): FileScan {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    return { a: [], b: [], error: `${rel(file)}：${errMsg(e)}` };
  }
  const stripped = stripComments(text);
  const rawLines = text.split("\n").length;
  const codeLines = stripped.split("\n").length;
  if (rawLines !== codeLines) {
    /* 行号错位会让报错指错行 ⇒ 默认失败，而不是带着错位继续跑 */
    return { a: [], b: [], error: `${rel(file)}：注释剔除后行数 ${codeLines} != 原文 ${rawLines}` };
  }
  const a: Hit[] = [];
  const b: Hit[] = [];
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hit: Hit = { file: rel(file), line: i + 1, snippet: line.trim().slice(0, 140) };
    if (hitsRepoRoot(line)) a.push(hit);
    if (hitsUserPath(line)) b.push(hit);
  }
  return { a, b };
}

function fmt(list: Hit[]): string {
  if (list.length === 0) return "（无）";
  return "\n      " + list.map((h) => `${h.file}:${h.line}  ${h.snippet}`).join("\n      ");
}

/* ══════════════════════════════════════════════════════════════════════════
 * 自测样例：按**路径段拼接**构造
 *   这样本文件里不含连续的可疑字面量 ⇒ 本文件参与扫描（E2）也不会自证违规。
 *   拼接后的**运行时字符串**与工单口径逐字一致。
 * ════════════════════════════════════════════════════════════════════════ */
const S = (parts: string[]): string => parts.join("/");
const PROBE_USER = "bob";
const PATH_BOB_WIN = S(["C:", "Users", PROBE_USER, "x"]);
const PATH_BOB_MAC = S(["", "Users", PROBE_USER, "x"]);
const PATH_BOB_LINUX = S(["", "home", PROBE_USER, "x"]);
const PATH_REPO = S(["D:", "Projects", "University", "Studio", REPO_WORD]);

function main(): void {
  console.log("\n═══ 本机专属绝对路径静态门禁（禁止写死盘符 / 用户名）═══\n");

  /* ── 遍历 ─────────────────────────────────────────────────────────── */
  const acc: Walk = { files: [], errors: [] };
  for (const d of SCAN_DIRS) walk(path.join(ROOT, d), acc);
  acc.files.sort();

  const scans: FileScan[] = acc.files.map((f) => scanFile(f));
  const allA: Hit[] = [];
  const allB: Hit[] = [];
  const readErrors: string[] = [];
  for (const s of scans) {
    allA.push(...s.a);
    allB.push(...s.b);
    if (s.error !== undefined) readErrors.push(s.error);
  }

  console.log(
    `  READ  扫描 ${acc.files.length} 个文件（${SCAN_DIRS.join(" / ")}）` +
      `；A 组命中 ${allA.length} 处；B 组命中 ${allB.length} 处；目录错误 ${acc.errors.length} 处`,
  );

  /* ── A 组 ─────────────────────────────────────────────────────────── */
  check(
    "A1",
    "现仓代码里不得出现带盘符 / 绝对根斜杠的仓库根路径",
    allA.length === 0,
    `命中 ${allA.length} 处（应 0）：${fmt(allA)}`,
  );
  check(
    "A2",
    `自测：${PATH_REPO} 必须判红（有盘符 + 仓库名）`,
    judgeViolation(`const __p = "${PATH_REPO}";`),
    "样例未被判红 ⇒ A 组规则失效",
  );
  check(
    "A3",
    `自测：单独的 ${REPO_WORD} 一词（无盘符）不得判红`,
    !judgeViolation(`const repo = "${REPO_WORD}";`),
    "无盘符的裸词被误判 ⇒ A 组会误伤 `owner/repo` 这类正常字符串",
  );

  /* ── B 组 ─────────────────────────────────────────────────────────── */
  check(
    "B1",
    "现仓代码里不得写死具体用户名（Users/<名字>/ 或 home/<名字>/）",
    allB.length === 0,
    `命中 ${allB.length} 处（应 0）：${fmt(allB)}`,
  );
  check("B2", `自测：${PATH_BOB_WIN} 必须判红`, judgeViolation(`const p = "${PATH_BOB_WIN}";`), "Windows 账户名未判红");
  check("B3", `自测：${PATH_BOB_MAC} 必须判红`, judgeViolation(`const p = "${PATH_BOB_MAC}";`), "macOS 账户名未判红");
  check("B4", `自测：${PATH_BOB_LINUX} 必须判红`, judgeViolation(`const p = "${PATH_BOB_LINUX}";`), "Linux 账户名未判红");
  const wlBad = ["Program Files", "Program Files (x86)", "Public", "Shared", "Default"].filter((name) =>
    judgeViolation(`const p = "${S(["C:", "Users", name, "app"])}";`),
  );
  check(
    "B5",
    "自测：账户名白名单（Program Files / (x86) / Public / Shared / Default）不得判红",
    wlBad.length === 0,
    `被误判的白名单：${wlBad.join(" / ")}`,
  );
  const fpCases = [`const u = "https://a.b${S(["", "home", "x"])}";`, `const r = "${S(["", "api", "home", "x"])}";`];
  const fpBad = fpCases.filter((c) => judgeViolation(c));
  check(
    "B6",
    "自测：URL 路径段与站内路由（/home/、/api/home/）不得误判",
    fpBad.length === 0,
    `误判样例：${fpBad.join(" | ")}`,
  );

  /* ── C 组：不允许「有 env / homedir 就豁免」的后门 ─────────────────── */
  check(
    "C1",
    "自测：同一行已有 os.homedir() 时，写死用户名仍必须判红",
    judgeViolation(`const p = path.join(os.homedir(), "${PATH_BOB_WIN}");`),
    "出现「有 homedir 就放过」的豁免 ⇒ 不可移植的写死路径被放行",
  );
  check(
    "C2",
    "自测：同一行已有 process.env 时，写死用户名仍必须判红",
    judgeViolation(`const p = process.env.PW_DIR ?? "${PATH_BOB_WIN}";`),
    "出现「有 env 就放过」的豁免 ⇒ 不可移植的写死路径被放行",
  );

  /* ── D 组：注释剔除的有效性自证 ───────────────────────────────────── */
  const d1 = `const s = "${PATH_BOB_WIN}"; // ${PATH_REPO}`;
  check("D1", "自测：行尾注释前的代码命中 ⇒ 必须判红（样例与工单一致）", judgeViolation(d1), `样例未判红：${d1}`);
  check(
    "D2",
    "自测：纯行注释里的路径 ⇒ 不得判红",
    !judgeViolation(`// ${PATH_BOB_WIN}`),
    "注释里的路径被判红 ⇒ 会把历史说明当成违规",
  );
  check(
    "D3",
    "自测：块注释 / 星号续行里的路径 ⇒ 不得判红",
    !judgeViolation(`/*\n * ${PATH_BOB_WIN}\n * ${PATH_REPO}\n */`),
    "块注释里的路径被判红",
  );
  const d4src = `a\n/* b\n${PATH_BOB_WIN}\nc */\nd`;
  check(
    "D4",
    "自测：注释剔除后换行数守恒（行号才不会错位）",
    stripComments(d4src).split("\n").length === d4src.split("\n").length,
    `剔除后 ${stripComments(d4src).split("\n").length} 行 != 原文 ${d4src.split("\n").length} 行`,
  );
  check(
    "D5",
    "自测：字符串里的 // 不得被当成注释（URL 之后的代码仍要被扫）",
    judgeViolation(`const u = "https://a.b/c"; const p = "${PATH_BOB_WIN}";`),
    "URL 里的 // 被误当注释 ⇒ 同一行后面的写死路径被吞掉（假绿通道）",
  );

  /* ── E 组：分母 ───────────────────────────────────────────────────── */
  check(
    "E1",
    `扫描文件数必须 > ${MIN_FILES}（低于此值说明遍历失效）`,
    acc.files.length > MIN_FILES,
    `实际只扫到 ${acc.files.length} 个文件（期望 > ${MIN_FILES}）`,
  );
  check(
    "E2",
    "扫描集必须包含本文件自身（不存在「排除自己」的后门）",
    acc.files.some((f) => path.resolve(f) === SELF),
    `扫描集里没有 ${rel(SELF)} ⇒ 存在自我豁免`,
  );

  /* ── F 组：默认失败 ───────────────────────────────────────────────── */
  const probe: Walk = { files: [], errors: [] };
  walk(path.join(tmpdir(), `__no_abs_paths_probe_${process.pid}__`), probe);
  check(
    "F1",
    "自测：不存在的目录必须报错（不得静默当空集）",
    probe.errors.length === 1 && probe.files.length === 0,
    `errors=${probe.errors.length} files=${probe.files.length}（期望 errors=1 files=0）`,
  );
  check(
    "F2",
    "三个扫描根与全部文件都必须读取成功",
    acc.errors.length === 0 && readErrors.length === 0,
    `目录错误 ${acc.errors.length} 处：${acc.errors.join("；") || "（无）"}；文件错误 ${readErrors.length} 处：${
      readErrors.join("；") || "（无）"
    }`,
  );

  /* ── 汇总 ─────────────────────────────────────────────────────────── */
  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
  if (registered.length !== pass + fail) {
    console.error("  FAIL  分母自证：注册数与 PASS+FAIL 不相等");
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
