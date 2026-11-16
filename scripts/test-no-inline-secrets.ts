/**
 * 明文凭据内联门禁（`scripts/test-no-inline-secrets.ts`，2026-11-07 新建，2026-11-16 改为三分判定）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   2026-11-06 取证发现 `.verify/set-amap-key.mjs` / `set-amap-js-key.ts` /
 *   `set-secret-and-check.ts` 三个脚本把高德**真钥内联在源码里**（与 `.env` 逐字相同）。
 *   它们从未入库，靠的是运气而不是制度。本仓库曾因明文凭据进公开仓库被 GitHub 封号
 *   （见 `docs/复盘-GitHub封号事故-20261028.md`）—— 同类行为一旦落到 `src/` 或
 *   `scripts/` 就是**公开泄露**：仓库是 public 的，push 即等于公告。
 *
 * ── 这道门禁不是新造规则，是补一次清理的漏网项 ────────────────────────────
 *   `.gitignore` 第 60-69 行有一段 2026-10-30 的决策记录（D1）：
 *      「★ 采集与同步脚本移出公开仓库 —— `scripts/track-collect.mjs` 含 DSAT 鉴权签名
 *        实现与内部接口地址；`db/sync-all-routes.ts` 含 DSAT 未公开接口名。」
 *   也就是说，**六个星期前已经有人意识到「DSAT 内部接口地址不该进公开仓库」并动手搬了两个
 *   脚本** —— 但漏了 `src/lib/dsat/client.ts` 与 `scripts/probe-lang.ts`，这两个文件里的
 *   基址字面量一路进了 8 个提交，最早可追到项目第一个提交。
 *   本章门禁补的就是这个缺口：不是「又发现一个新风险」，而是「上次没搬干净」。
 *   下一个人看到时请照这个脉络理解，别以为在重复劳动。
 *
 *   ── 现状（2026-11-16 收口）──────────────────────────────────────────────
 *   那两处漏网项**已经改掉了**：`client.ts` 与 `probe-lang.ts` 不再内联地址，改为
 *   `dsatBaseUrl()` 惰性读取、缺失即抛（fail-closed；报错只提变量名，不回显值）。
 *   所以现在跑本门禁是**真绿** —— 交付级目录里确实没有字面量，而不是被豁免放过。
 *   全文还剩字面量的只有 `scripts/track-collect.mjs`（未入库，按三分规则落 WARN）与
 *   `docs/` 下的调研文档（同样未入库）。
 *   ⚠️ 本门禁存在就是为了防它复发：**绿是因为没人再写，不是因为被允许写。**
 *
 * ── 判据怎么来的：反向字面量，不猜形状 ───────────────────────────────────
 *   常见密钥扫描器（gitleaks / trufflehog 一类）靠**正则猜 token 长什么样**。
 *   那只对「标准形态」有效：高德 Key 是 32 位十六进制，被覆盖；但 `AACM_APPCODE` 这种
 *   平台公示码、以及任何自定义格式都会漏。
 *   本门禁反过来做：**读 `.env` 的真值，拿真值去全文查找**。命中即「这一串确实是我的凭据」，
 *   不依赖任何 token 形状假设。代价是只认完整值（见边界）。
 *
 * ── FAIL 三分：按「有没有泄漏通道」判，不按目录判 ─────────────────────────
 *   凭据泄漏的唯一通道是**版本库**。所以判据是文件在 git 里的状态，不是它躺在哪个目录：
 *
 *   | 文件状态                              | 判定            | 理由                              |
 *   |---------------------------------------|-----------------|-----------------------------------|
 *   | 被 git 跟踪（tracked）                | **FAIL**        | clone / fork / PR diff 全看得见    |
 *   | 未跟踪且未被忽略（untracked, loose）  | **FAIL**        | 一次 `git add -A` 就进索引         |
 *   | 未跟踪且被 `.gitignore` 覆盖          | WARN `[已忽略]` | 无泄漏通道，但仍值得提示           |
 *
 *   实现：`git ls-files -z` 取 tracked 集合；不在集合内时用 `git check-ignore -z --stdin`
 *   批量判忽略（退出码 0 = 有被忽略项；我们直接取它的 stdout，NUL 分隔）。
 *
 *   ⚠️ 第二行（untracked + 未被忽略 ⇒ FAIL）是这套判定的关键补丁：本地调试脚本、
 *      临时探针文件默认就落在这一格。它们不在版本库里，但**没有任何东西阻止它们进去**。
 *
 * ── WARN 分「已知 / 新增」：为什么必须这么切 ──────────────────────────────
 *   `.verify/` 下存量已有几十处平台共用码与前端 Key 残留（数量见台账文件）。若全部报红，
 *   第一次跑就是几十条 —— 然后所有人开始无视它。**「WARN 永远红」等于没有 WARN。**
 *   所以：登记过的部分只打一行汇总，**不计入 fail**；超出基线的部分才逐条打印路径。
 *   台账：`.verify/no-inline-secrets-allowlist.json`（只放 `{键名: {文件数, 出现数}}`，
 *   **不放值、不逐条列文件路径**）。
 *   ⚠️ 台账**只对 WARN 桶生效**。同一个键命中 tracked 文件时仍然是 FAIL，台账救不了它。
 *
 * ── 不存在「键级豁免」这个概念（刻意不设）────────────────────────────────
 *   本门禁**没有**、也**不允许**存在「某些键可以不算凭据」的白名单。`.env` 里每一个
 *   长度 ≥ 16 的键，一律按凭据处理，一视同仁。
 *
 *   这条吃过一次教训：曾经设过一个「非凭据键」白名单，把 `DSAT_BASE_URL` 登记进去、
 *   命中时降级为 WARN，理由是「它看起来是公开数据接口基址」。这个裁定是错的 ——
 *   `.env.example:128` 自己写的是「基址属**内部接入点**，**值不入档**」，把它命名为
 *   「公开」等于在代码里做了一个与仓库书面契约相反的裁定。而它恰恰是封号事故的成因类型
 *   （公开仓库含 DSAT 未公开接口信息）。
 *
 *   后果很直接：在豁免生效的那段时间里，`src/lib/dsat/client.ts:18` 与
 *   `scripts/probe-lang.ts:21` 这两处**被 git 跟踪的真违规**是绿的 —— 门禁盯着它们，
 *   却因为它们在本子上被划掉了而放过。**豁免机制的全部作用，就是让真正的目标隐形。**
 *
 *   所以这个机制被整个删除，不留空集合、不留「以后可以填」的位置。要判断某个值该不该
 *   在这里，请改这个文件并把理由写进代码评审，不要在数据里开一个口子。
 *   C1/C2 两条判据把这个结构性承诺钉住：C1 要求 `.env` 的每个合格键都进比对集，
 *   C2 要求「带 `_URL` 字样的键」也必须照常判凭据（防止有人以名字像公开地址为由重开豁免）。
 *
 * ── 数字变小 ≠ 债还清；扫描根变了必须重算基线 ────────────────────────────
 *   台账里的「已知残留」是**按当前扫描根**测出来的。扫描根一变（增删目录、放宽扩展名、
 *   调 2 MB 上限、某个目录被搬走），旧基线就不再可比 —— 它会把新增的债吸收掉，表现为
 *   「新增 0」。**warn 数字下降只说明「这次没看到」，不说明「债还清了」。**
 *   改动扫描范围时，请把台账整份重测并写清新的口径，不要沿用旧数。
 *
 * ── 为什么「长度 ≥ 16」是硬门槛 ──────────────────────────────────────────
 *   太短的值全文查找会命中一片：`ACCESS_PASSWORD` 在某些机器上只有几位；
 *   `AMAP_COORD_MODE=gcj02` 之类根本不是凭据却极易撞词。16 是「短到不误报、长到能覆盖
 *   真实凭据」的折中。代价见边界（短凭据守不住）。
 *
 * ── 边界（明确守不住什么）────────────────────────────────────────────────
 *   · 只认**完整值**。拆成两段字符串拼接、Base64 / hex 编码后内联、或只截前 24 位
 *     写进去 ⇒ 抓不到。
 *   · 只在本机存在 `.env` 时有效。CI / 干净克隆没有 `.env` ⇒ 整体 SKIP。
 *     要真正堵住，得在 CI 里用 secret 注入 `.env` 再跑。
 *   · 只查「`.env` 里有的键」。只配在 `.env.local` 里的键（`GHT` / `CRON_SECRET` /
 *     `GRAB_TOKEN` 之类）不在比对集内 ⇒ 查不到。
 *   · 只查白名单扩展名（`.ts .tsx .mjs .js .json .md .txt`）且单文件 ≤ 2 MB。
 *     **`.html` / `.log` 不在射程内** —— 前端 Key 在 `.html` 里的残留只有靠台账记数，
 *     不靠本扫描器发现（见交付说明里的口径差说明）。
 *   · 台账只记「文件数 / 出现数」这种汇总，不记具体路径 ⇒ 只能发现**总量增长**，
 *     发现不了「一个老文件里多插了一处、同时另一个老文件被清理」这种等量替换。
 *   · `backups/` 不在扫描根内。
 *   · 不防「已经泄露过的历史」：本门禁只看当前工作区，不遍历 `git log` 的历史 blob。
 *
 * ── 防假绿 ────────────────────────────────────────────────────────────────
 *   · 只读磁盘真实文件 + 调 git；不 import 生产模块、不连库、不跑被测脚本。
 *   · 扫描集**包含本文件自身**（E2）：本文件不含任何凭据值，因此仍是绿的；
 *     但「往门禁脚本里贴一个真值调试」这种最常见的偷懒会被自己抓住。
 *   · 读不到文件 / 目录不存在 / git 不可用 ⇒ 判红，绝不静默当空集。
 *   · A3 判据反证**输出不含值**：把本次打印过的每一行收集起来，断言其中不含任何
 *     比对集里的真值 —— 门禁自己的日志不能变成新的泄露渠道。
 *   · C2 从集合派生而非手挑子集，避免「用手挑的子集验全称命题」。
 *
 * ── 挂链状态 ──────────────────────────────────────────────────────────────
 *   本脚本**未挂进** `package.json` 的 `verify` 链：PR #101 在 `musttoukou-pr101`
 *   已把 verify 改到 47 段，主工作区是 42 段，此时动 `package.json` 会制造第二次行冲突。
 *   由 team-lead 在 PR 合并后统一处理。
 *
 * 跑法：`npx tsx scripts/test-no-inline-secrets.ts`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = path.resolve(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(ROOT, ".env");
const ALLOWLIST_FILE = path.join(ROOT, ".verify", "no-inline-secrets-allowlist.json");

/** 值长度下限：低于此值不参与比对（理由见头部注释） */
const MIN_SECRET_LEN = 16;
/** 单文件字节上限：超过则跳过，避免读大 dump 拖垮门禁 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** 每文件最多报几处命中，防止单个大文件刷屏 */
const MAX_LINES_PER_FILE = 20;
/** 新增残留最多列几个路径 */
const MAX_LISTED_NEW = 12;

const EXTS = new Set([".ts", ".tsx", ".mjs", ".js", ".json", ".md", ".txt"]);

/**
 * 扫描根：判 FAIL 还是 WARN 由 git 状态决定，不再由目录决定。
 * · REQUIRED：入库目录，任何正常 checkout 都必须存在 —— 缺了说明遍历失效 ⇒ 判红（F2）。
 * · OPTIONAL：`.verify/` 是**本机作业目录**，`.gitignore` 已排除，干净克隆里根本不存在。
 *   把它算进 F2 会让门禁在所有新克隆上恒红（「恒红等于没有门禁」）⇒ 缺失时静默跳过。
 */
const REQUIRED_ROOTS = ["src", "scripts", "db", "public", "docs"] as const;
const OPTIONAL_ROOTS = [".verify"] as const;
const SCAN_ROOTS = [...REQUIRED_ROOTS, ...OPTIONAL_ROOTS] as const;

/** 目录级排除（任意层级）：依赖 / VCS / Python 缓存 / Next 产物 */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "__pycache__"]);

/** 分母下限：候选文件数。低于此值说明遍历没跑起来 ⇒ 判红 */
const MIN_SCAN_FILES = 300;

/* 注意：这里**刻意没有**「非凭据键白名单」。理由见头部「不存在键级豁免」一段。 */

/* ══════════════════════════════════════════════════════════════════════════
 * 输出收集：所有输出都过 out()/outErr()，为了 A3 能反证「日志不含值」
 * ════════════════════════════════════════════════════════════════════════ */
const printed: string[] = [];
const out = (s: string): void => {
  printed.push(s);
  console.log(s);
};
const outErr = (s: string): void => {
  printed.push(s);
  console.error(s);
};

/* ══════════════════════════════════════════════════════════════════════════
 * 判据计数
 * ════════════════════════════════════════════════════════════════════════ */
let pass = 0;
let checkFail = 0;
const registered: string[] = [];

function check(id: string, label: string, cond: boolean, detail: string): void {
  registered.push(id);
  if (cond) {
    pass++;
    out(`  PASS  ${id}  ${label}`);
  } else {
    checkFail++;
    outErr(`  FAIL  ${id}  ${label}  →  ${detail}`);
  }
}

const rel = (p: string): string => {
  const r = path.relative(ROOT, p).split(path.sep).join("/");
  return r === "" ? "." : r;
};
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/* ══════════════════════════════════════════════════════════════════════════
 * .env 解析：只取「键 + 值」
 * ════════════════════════════════════════════════════════════════════════ */
interface SecretValue {
  key: string;
  value: string;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const a = s.charAt(0);
    const b = s.charAt(s.length - 1);
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return s.slice(1, -1);
  }
  return s;
}

/**
 * 解析 `.env` 文本 ⇒ 待比对的值集合。
 * 每行同时产出几个候选变体（原文 / 去引号 / 去行尾注释）：取错变体只会导致**漏报**，
 * 多取几个变体没有副作用。
 */
function parseEnv(text: string): SecretValue[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result: SecretValue[] = [];
  const seen = new Set<string>();
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    if (key === "") continue;
    const rest = line.slice(eq + 1).trim();
    const unquoted = stripQuotes(rest);
    const candidates = new Set<string>([rest, unquoted]);
    const hashIdx = unquoted.indexOf(" #");
    if (hashIdx > 0) candidates.add(unquoted.slice(0, hashIdx).trim());
    for (const v of candidates) {
      if (v === "" || v.length < MIN_SECRET_LEN) continue;
      const id = `${key}\u0000${v}`;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ key, value: v });
    }
  }
  return result;
}

/* ══════════════════════════════════════════════════════════════════════════
 * git 索引与三分判定
 * ════════════════════════════════════════════════════════════════════════ */
interface GitIndex {
  tracked: Set<string>;
  ignored: Set<string>;
}

type Verdict = "fail-tracked" | "fail-loose" | "warn-ignored";

function verdictOf(relPath: string, idx: GitIndex): Verdict {
  if (idx.tracked.has(relPath)) return "fail-tracked";
  if (idx.ignored.has(relPath)) return "warn-ignored";
  /* 未跟踪且未被忽略：一次 `git add -A` 就进索引 ⇒ 与 tracked 同等对待 */
  return "fail-loose";
}

const VERDICT_LABEL: Record<Verdict, string> = {
  "fail-tracked": "[已入库]",
  "fail-loose": "[未入库·未忽略]",
  "warn-ignored": "[已忽略]",
};

function gitOut(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: ROOT,
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function loadGitIndex(files: readonly string[]): GitIndex {
  const tracked = new Set(gitOut(["ls-files", "-z"]).split("\0").filter(Boolean));
  const ignored = new Set<string>();
  if (files.length > 0) {
    try {
      const s = gitOut(["check-ignore", "-z", "--stdin"], `${files.join("\0")}\0`);
      for (const p of s.split("\0")) if (p !== "") ignored.add(p);
    } catch (e) {
      /* 退出码 1 = 没有任何路径被忽略（正常情况）；此时 stdout 为空。
         真正的错误（128）也走这里 —— 下面的 F3 判据会兜住「git 不可用」。 */
      const stdout = (e as { stdout?: Buffer | string }).stdout;
      const s = stdout === undefined ? "" : stdout.toString();
      for (const p of s.split("\0")) if (p !== "") ignored.add(p);
    }
  }
  return { tracked, ignored };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 命中检测（纯函数，自测直接调它）
 * ════════════════════════════════════════════════════════════════════════ */
interface Hit {
  file: string;
  line: number;
  key: string;
  verdict: Verdict;
}

function isScannableExt(relPath: string): boolean {
  return EXTS.has(path.extname(relPath).toLowerCase());
}

/** 找出 needle 在 text 里出现的行号（最多 limit 处） */
function collectLines(text: string, needle: string, limit: number): number[] {
  const lines: number[] = [];
  let scanned = 0;
  let line = 1;
  let from = 0;
  while (lines.length < limit) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    for (let i = scanned; i < idx; i++) if (text.charCodeAt(i) === 10) line++;
    scanned = idx;
    lines.push(line);
    from = idx + 1;
  }
  return lines;
}

function judgeText(
  relPath: string,
  text: string,
  pairs: readonly SecretValue[],
  idx: GitIndex,
  limit: number,
): Hit[] {
  if (!isScannableExt(relPath)) return [];
  const norm = relPath.split("\\").join("/");
  const verdict = verdictOf(norm, idx);
  const hits: Hit[] = [];
  for (const p of pairs) {
    for (const ln of collectLines(text, p.value, limit)) {
      hits.push({ file: norm, line: ln, key: p.key, verdict });
    }
  }
  return hits;
}

/* ══════════════════════════════════════════════════════════════════════════
 * 目录遍历
 * ════════════════════════════════════════════════════════════════════════ */
interface Walk {
  files: string[];
  errors: string[];
  tooBig: number;
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
      if (SKIP_DIR_NAMES.has(ent.name) || ent.name.startsWith(".next")) continue;
      walk(full, acc);
      continue;
    }
    if (!ent.isFile()) continue;
    if (!isScannableExt(ent.name)) continue;
    try {
      if (statSync(full).size > MAX_FILE_BYTES) {
        acc.tooBig++;
        continue;
      }
    } catch {
      /* 取不到大小 ⇒ 照常尝试读，读失败会记 error */
    }
    acc.files.push(full);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 台账：已知残留（只放汇总数，不放值、不放路径）
 * ════════════════════════════════════════════════════════════════════════ */
interface Baseline {
  files: number;
  occurrences: number;
}

function loadAllowlist(): { base: Map<string, Baseline>; error?: string } {
  let text: string;
  try {
    text = readFileSync(ALLOWLIST_FILE, "utf8");
  } catch (e) {
    return { base: new Map(), error: errMsg(e) };
  }
  try {
    const parsed = JSON.parse(text) as { keys?: Record<string, Baseline> };
    const base = new Map<string, Baseline>();
    for (const [k, v] of Object.entries(parsed.keys ?? {})) {
      if (typeof v?.files === "number" && typeof v?.occurrences === "number") base.set(k, v);
    }
    return { base };
  } catch (e) {
    return { base: new Map(), error: `JSON 解析失败：${errMsg(e)}` };
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 自测样例：运行时拼接，本文件里不出现任何连续的可疑字面量
 * ════════════════════════════════════════════════════════════════════════ */
const PROBE_KEY = "PROBE_DEMO_KEY";
const PROBE_VALUE = ["probe", "not", "a", "real", "secret", String(process.pid)].join("-");
const PROBE_SHORT = "probe-short";
const PROBE_PAIRS: SecretValue[] = [{ key: PROBE_KEY, value: PROBE_VALUE }];
/** 自测用的人造索引：三种状态各一个路径 */
const PROBE_IDX: GitIndex = {
  tracked: new Set(["src/__probe_tracked.ts"]),
  ignored: new Set([".verify/__probe_ignored.mjs"]),
};

function main(): void {
  out("\n═══ 明文凭据内联门禁（反向字面量 + git 三分判定）═══\n");

  /* ── 0. 读 .env ──────────────────────────────────────────────────────── */
  let envText: string | null = null;
  try {
    envText = readFileSync(ENV_FILE, "utf8");
  } catch (e) {
    out("  SKIP（无 .env，本机未配置凭据）");
    out(`        ${errMsg(e)}`);
    out("");
  }
  const pairs: SecretValue[] = envText !== null ? parseEnv(envText) : [];
  const scanning = pairs.length > 0;

  if (envText !== null && !scanning) {
    out(`  SKIP（.env 里没有长度 ≥ ${MIN_SECRET_LEN} 的非空值，无可比对项）\n`);
  } else if (scanning) {
    const keys = [...new Set(pairs.map((p) => p.key))];
    out(`  LOAD  比对集：${pairs.length} 个值 / ${keys.length} 个键（只打印键名，不打印值）`);
    out(`        全部按凭据处理（本门禁不存在键级豁免）`);
    out("");
  }

  /* ── 1. 遍历 ─────────────────────────────────────────────────────────── */
  const acc: Walk = { files: [], errors: [], tooBig: 0 };
  for (const d of REQUIRED_ROOTS) walk(path.join(ROOT, d), acc);
  const absentOptional: string[] = [];
  for (const d of OPTIONAL_ROOTS) {
    const p = path.join(ROOT, d);
    if (!existsSync(p)) {
      absentOptional.push(d);
      continue;
    }
    walk(p, acc);
  }
  acc.files.sort();
  const scanSet = acc.files.map((f) => rel(f));
  /* 只有「必需根」的遍历错误才算失败；可选根缺失已在上面单独记录 */
  const requiredRootErrors = acc.errors.filter((e) =>
    REQUIRED_ROOTS.some((d) => e.startsWith(`${d}：`)),
  );

  /* ── 2. git 索引 ─────────────────────────────────────────────────────── */
  let idx: GitIndex = { tracked: new Set(), ignored: new Set() };
  let gitError: string | undefined;
  if (scanning) {
    try {
      idx = loadGitIndex(scanSet);
    } catch (e) {
      gitError = errMsg(e);
    }
  }

  /* ── 3. 扫描 ─────────────────────────────────────────────────────────── */
  const readErrors: string[] = [];
  const hits: Hit[] = [];
  if (scanning && gitError === undefined) {
    for (let i = 0; i < acc.files.length; i++) {
      let text: string;
      try {
        text = readFileSync(acc.files[i], "utf8");
      } catch (e) {
        readErrors.push(`${scanSet[i]}：${errMsg(e)}`);
        continue;
      }
      hits.push(...judgeText(scanSet[i], text, pairs, idx, MAX_LINES_PER_FILE));
    }
  }

  const looseCount = scanSet.filter((f) => verdictOf(f, idx) === "fail-loose").length;
  out(
    `  READ  候选文件 ${scanSet.length} 个（${SCAN_ROOTS.join(" / ")}）` +
      `；超 ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB 跳过 ${acc.tooBig} 个`,
  );
  if (absentOptional.length > 0) {
    out(`  INFO  可选扫描根不存在，已跳过：${absentOptional.join(" / ")}（干净克隆里正常，不算失败）`);
  }
  if (scanning && gitError === undefined) {
    out(
      `  GIT   tracked ${idx.tracked.size} / 已忽略 ${idx.ignored.size} / 扫描集中未忽略 ${looseCount}`,
    );
  }
  out("");

  /* ── 4. 分桶 ─────────────────────────────────────────────────────────── */
  const failHits = hits.filter((h) => h.verdict !== "warn-ignored");
  const warnHits = hits.filter((h) => h.verdict === "warn-ignored");

  const { base, error: allowErr } = loadAllowlist();
  interface KeyStat {
    files: Map<string, number>;
    occ: number;
  }
  const warnByKey = new Map<string, KeyStat>();
  for (const h of warnHits) {
    let s = warnByKey.get(h.key);
    if (s === undefined) {
      s = { files: new Map(), occ: 0 };
      warnByKey.set(h.key, s);
    }
    s.occ++;
    s.files.set(h.file, (s.files.get(h.file) ?? 0) + 1);
  }

  const knownTotal = new Set<string>();
  const newFiles: Hit[] = [];
  const newKeyCount = new Set<string>();
  for (const [key, s] of warnByKey) {
    const b = base.get(key);
    const isKnown = b !== undefined && s.files.size <= b.files && s.occ <= b.occurrences;
    if (isKnown) {
      for (const f of s.files.keys()) knownTotal.add(f);
    } else {
      newKeyCount.add(key);
      for (const h of warnHits) if (h.key === key) newFiles.push(h);
    }
  }

  /* ── 5. 打印 FAIL 级命中（路径 + 行号 + 变量名，不含值）───────────────── */
  if (failHits.length > 0) {
    outErr(`  ⛔ ${failHits.length} 处凭据值落在**会进版本库**的位置：`);
    for (const h of failHits) {
      outErr(`     ${h.file}:${h.line}   ← ${h.key}  ${VERDICT_LABEL[h.verdict]}`);
    }
    outErr("     处置口径：按「已泄露」处理 —— 先轮换该凭据，再改代码。删掉不等于没泄露过。");
    outErr("");
  }

  /* ── 6. 打印 WARN（已知汇总 / 新增列路径）────────────────────────────── */
  if (warnByKey.size > 0) {
    out("  ── WARN（未入库，无公开泄漏通道）──");
    if (knownTotal.size > 0) {
      out(`  已知残留（已登记，免报）：`);
      for (const [key, s] of warnByKey) {
        const b = base.get(key);
        if (b === undefined || s.files.size > b.files || s.occ > b.occurrences) continue;
        const drift =
          s.files.size < b.files || s.occ < b.occurrences
            ? `（基线 ${b.files}/${b.occurrences}，已减少，可下调台账）`
            : `（基线 ${b.files} 文件 / ${b.occurrences} 处）`;
        out(`     ${key.padEnd(24)} ${String(s.files.size).padStart(3)} 文件 / ${String(s.occ).padStart(3)} 处 ${drift}`);
      }
    }
    if (newFiles.length > 0) {
      out(`  新增（未登记，值得看一眼）：${newKeyCount.size} 个键`);
      for (const h of newFiles.slice(0, MAX_LISTED_NEW)) {
        out(`     ${h.file}:${h.line}   ← ${h.key}`);
      }
      if (newFiles.length > MAX_LISTED_NEW) out(`     ... 其余 ${newFiles.length - MAX_LISTED_NEW} 处省略`);
    } else {
      out(`  新增（未登记）：无`);
    }
    if (allowErr !== undefined) out(`  ⚠ 台账读取失败（${allowErr}）⇒ 本轮的「已知」为空`);
    out("");
  }

  /* ── 7. 判据 ─────────────────────────────────────────────────────────── */
  out("  ── A 组：现仓实扫 ──");
  if (scanning && gitError === undefined) {
    check(
      "A1",
      "tracked / 未忽略文件里不得出现任何凭据值",
      failHits.length === 0,
      `命中 ${failHits.length} 处（应 0）：${failHits
        .map((h) => `${h.file}:${h.line}/${h.key}${VERDICT_LABEL[h.verdict]}`)
        .join("；")}`,
    );
    check(
      "A2",
      `候选文件数必须 > ${MIN_SCAN_FILES}（低于此值说明遍历失效）`,
      scanSet.length > MIN_SCAN_FILES,
      `实际只扫到 ${scanSet.length} 个（期望 > ${MIN_SCAN_FILES}）`,
    );
    const leaked = printed.filter((l) => pairs.some((p) => l.includes(p.value)));
    check(
      "A3",
      "门禁自身输出不得包含任何比对集里的真值（日志不能成为新泄露渠道）",
      leaked.length === 0,
      `有 ${leaked.length} 行输出含真值`,
    );
  } else if (gitError !== undefined) {
    out("  INFO  A1/A2/A3 跳过：git 索引不可用（见 F3）");
  } else {
    out("  INFO  A1/A2/A3 跳过：本机无 .env，没有比对集（不是通过，是没测）");
  }

  out("");
  out("  ── C 组：不存在键级豁免 ──");
  /*
   * C1：独立于 parseEnv 再解析一遍 .env，确认「每个合格键都进了比对集」。
   * 刻意不复用 parseEnv —— 复用等于用同一个函数验它自己，漏键永远验不出来。
   */
  if (scanning && envText !== null) {
    const independent = new Set<string>();
    for (const raw of envText.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const k = line.slice(0, eq).replace(/^export\s+/, "").trim();
      const v = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
      if (k !== "" && v.length >= MIN_SECRET_LEN) independent.add(k);
    }
    const pairKeys = new Set(pairs.map((p) => p.key));
    const missing = [...independent].filter((k) => !pairKeys.has(k));
    check(
      "C1",
      "`.env` 里每个长度达标的键都必须进比对集（不存在按键名豁免）",
      missing.length === 0 && independent.size > 0,
      `.env 有 ${independent.size} 个合格键，其中 ${missing.length} 个没进比对集：${missing.join(" / ") || "（无）"}`,
    );
  } else {
    out("  INFO  C1 跳过：本机无 .env，没有键可验（不是通过，是没测）");
  }
  /*
   * C2：用行为断言代替「检查白名单内容」——因为白名单这个概念已被删除。
   * 直接验证「名字长得像公开地址的键」也会照常判凭据，挡住「以名字形状重开豁免」的路。
   */
  const urlProbe: SecretValue[] = [{ key: "DATABASE_URL", value: PROBE_VALUE }];
  const urlHit = judgeText("src/__probe_tracked.ts", `const k = "${PROBE_VALUE}";`, urlProbe, PROBE_IDX, 20);
  check(
    "C2",
    "自测：名字以 _URL 结尾的键也必须照常判凭据（不得按名字形状豁免）",
    urlHit.length === 1 && urlHit[0].verdict === "fail-tracked",
    `DATABASE_URL 型键未被判 fail-tracked（实际 ${urlHit[0]?.verdict ?? "无命中"}）⇒ 名字形状可以换到豁免`,
  );

  out("");
  out("  ── D 组：三分判定与扫描链自测（用假值，不碰真实凭据）──");
  const probeSrc = `a\nb\nconst k = "${PROBE_VALUE}";\nd`;
  const dTracked = judgeText("src/__probe_tracked.ts", probeSrc, PROBE_PAIRS, PROBE_IDX, 20);
  check(
    "D1",
    "自测：假值出现在 tracked 文件 ⇒ 判 fail-tracked",
    dTracked.length === 1 && dTracked[0].verdict === "fail-tracked",
    `实际档位 ${dTracked[0]?.verdict ?? "（无命中）"}`,
  );
  const dLoose = judgeText("src/__probe_loose.ts", probeSrc, PROBE_PAIRS, PROBE_IDX, 20);
  check(
    "D2",
    "自测：假值出现在「未跟踪且未忽略」文件 ⇒ 判 fail-loose（一次 git add -A 就进库）",
    dLoose.length === 1 && dLoose[0].verdict === "fail-loose",
    `实际档位 ${dLoose[0]?.verdict ?? "（无命中）"}`,
  );
  const dIgnored = judgeText(".verify/__probe_ignored.mjs", probeSrc, PROBE_PAIRS, PROBE_IDX, 20);
  check(
    "D3",
    "自测：假值出现在已忽略文件 ⇒ 判 warn-ignored（WARN，不阻断）",
    dIgnored.length === 1 && dIgnored[0].verdict === "warn-ignored",
    `实际档位 ${dIgnored[0]?.verdict ?? "（无命中）"}`,
  );
  check(
    "D4",
    `自测：长度 < ${MIN_SECRET_LEN} 的值不得进入比对集（防海量误报）`,
    parseEnv(`SHORT=${PROBE_SHORT}\nLONG=${PROBE_VALUE}`).every((p) => p.value !== PROBE_SHORT),
    `短值 ${PROBE_SHORT} 进了比对集 ⇒ 全仓误报`,
  );
  check(
    "D5",
    "自测：白名单扩展名之外的文件不扫（.png / .log 等）",
    judgeText("src/probe.png", probeSrc, PROBE_PAIRS, PROBE_IDX, 20).length === 0 &&
      judgeText("docs/probe.log", probeSrc, PROBE_PAIRS, PROBE_IDX, 20).length === 0 &&
      judgeText("src/probe.ts", probeSrc, PROBE_PAIRS, PROBE_IDX, 20).length === 1,
    "扩展名白名单失效（要么把 .png 扫了，要么把 .ts 漏了）",
  );
  check(
    "D6",
    "自测：行号必须准确（第 3 行命中 ⇒ 报 3，不能报 1）",
    dTracked.length === 1 && dTracked[0].line === 3,
    `报成了第 ${dTracked.length === 1 ? dTracked[0].line : "?"} 行`,
  );

  out("");
  out("  ── E/F 组：分母与默认失败 ──");
  const probeWalk: Walk = { files: [], errors: [], tooBig: 0 };
  walk(path.join(ROOT, `__no_such_dir_${process.pid}__`), probeWalk);
  check(
    "F1",
    "自测：不存在的目录必须报错（不得静默当空集 ⇒ 假绿）",
    probeWalk.errors.length === 1 && probeWalk.files.length === 0,
    `errors=${probeWalk.errors.length} files=${probeWalk.files.length}（期望 errors=1 files=0）`,
  );
  if (scanning) {
    check(
      "F2",
      "必需扫描根下的文件必须全部读取成功（不得静默漏读）",
      requiredRootErrors.length === 0 && readErrors.length === 0,
      `目录错误 ${requiredRootErrors.length} 处：${requiredRootErrors.join("；") || "（无）"}；文件错误 ${
        readErrors.length
      } 处：${readErrors.join("；") || "（无）"}`,
    );
    check(
      "F3",
      "git 索引必须可用（判不了 tracked / ignored ⇒ 三分判定失效，必须红）",
      gitError === undefined && idx.tracked.size > 0,
      `git 错误：${gitError ?? "（无）"}；tracked=${idx.tracked.size}`,
    );
  } else {
    out("  INFO  F2/F3 跳过：本机无 .env，本轮没有执行扫描（不是通过，是没测）");
  }
  check(
    "E2",
    "扫描集必须包含本文件自身（不存在「排除自己」的后门）",
    scanSet.includes(rel(SELF)),
    `扫描集里没有 ${rel(SELF)} ⇒ 存在自我豁免`,
  );

  /* ── 8. 汇总 ─────────────────────────────────────────────────────────── */
  const failTotal = checkFail + failHits.length;
  out("");
  out(`═══ 合计 ${registered.length} 条判据：PASS ${pass} / FAIL ${checkFail} ═══`);
  out(
    `口径：fail = 失败判据数 + FAIL 级命中数；warn = WARN 级命中文件数（已知 ${knownTotal.size} + 新增 ${newFiles.length} 处）`,
  );
  out(`pass=${pass} fail=${failTotal} warn=${knownTotal.size + new Set(newFiles.map((h) => h.file)).size}`);
  if (registered.length !== pass + checkFail) {
    outErr("  FAIL  分母自证：注册数与 PASS+FAIL 不相等");
    process.exit(1);
  }
  process.exit(failTotal === 0 ? 0 : 1);
}

main();
