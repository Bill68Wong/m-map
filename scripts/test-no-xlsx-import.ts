/**
 * `xlsx` 依赖使用范围门禁（`scripts/test-no-xlsx-import.ts`，2026-11-17 新建）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   `xlsx`（SheetJS）是**离线批处理依赖**，只为读官方 `BUS_ROUTE_SEQ.xls`（BIFF8/OLE2 真 Excel，
 *   5.7MB）而引入，已锁定 `0.18.5` 放在 `devDependencies`。
 *
 *   它一旦被 `import` 进 `src/`（Next.js 打包图内），后果是：
 *     · 前端 bundle 立刻胖一圈（该库含完整 BIFF/ODS/CSV 解析器）；
 *     · **但没有任何现有测试会红** —— 打包体积不在 verify 的射程内。
 *   所以需要本门禁：把「它只能待在 scripts/」这条约定变成可执行判据。
 *
 * ── 为什么判「import 形态」而不是裸子串 ───────────────────────────────────
 *   仓库里已经有一处裸子串命中，是**注释**：
 *     `scripts/parse-saved-places.mjs:6`：「…甚至从表格另存的 xlsx 转 csv」
 *   若用裸子串判据，这行会红 —— 然后有人为了过门禁去改注释，**门禁从此不可信**。
 *   这与本仓库踩过的失败模式同型（`fetch-route-shapes.ts:314-316`：假红阻断合法采集 ⇒
 *   人把门禁关掉，损失更大）。所以只认真正的导入语句。
 *
 * ── 判据（4 种形态，`import "xlsx"` 最容易漏）────────────────────────────
 *   1. `import X from "xlsx"` / `import { a } from "xlsx"` / `import type … from "xlsx"`
 *   2. `import "xlsx"`（副作用裸导入：无 `from`、无 `require`）
 *   3. `import("xlsx")`（动态导入）
 *   4. `require("xlsx")`
 *
 * ── 允许范围 ──────────────────────────────────────────────────────────────
 *   `scripts/**` 允许（离线工具本来就该在这儿）；`src/**`、`db/**`、根级配置一律禁。
 *   注：本文件自己也在 `scripts/` 下 ⇒ 天然不在扫描范围，不需要任何「排除自己」的后门。
 *
 * ── 附带的第二条判据（非文本）────────────────────────────────────────────
 *   `package.json` 里 `xlsx` 只能出现在 `devDependencies`，且版本必须是**精确版本**（不含
 *   `^` / `~` / `>` / `*`）。否则有人把它挪进 `dependencies` 就等于让它进运行时依赖树 ——
 *   那时即使源码里没 import，一次 `import` 也会被当作合法依赖放过。
 *
 * ── 边界 ──────────────────────────────────────────────────────────────────
 *   · 只认静态文本里的导入形态。**动态拼接**（`require("x" + "lsx")`）抓不到 —— 与
 *     `test-no-inline-secrets` 同类取舍，但这里风险低得多：没人会为了绕门禁去拼库名。
 *   · 注释按「整行以双斜杠 / 星号 / 斜杠星号 开头」跳过（不做完整词法分析）。因此
 *     行尾注释里若写了 `from "xlsx"` 会被误判 —— 极少见，且误判方向是「多报」不是「漏报」。
 *
 * 跑法：`npm run test:no-xlsx-import`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 允许引用 xlsx 的路径前缀（离线工具目录） */
const ALLOW_PREFIX = "scripts/";
/** 需要扫描的代码扩展名 */
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
/** 目录级排除 */
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", "out", "build"]);

/** 4 种导入形态。共同点：都要求字面量 `"xlsx"` 出现在导入位置上。 */
const IMPORT_FORMS: Array<{ id: string; re: RegExp; what: string }> = [
  {
    id: "from",
    re: /\bimport\s+(?:type\s+)?[^;\n]*?\bfrom\s*['"]xlsx['"]/,
    what: 'import … from "xlsx"',
  },
  { id: "bare", re: /\bimport\s*['"]xlsx['"]/, what: 'import "xlsx"（副作用裸导入）' },
  { id: "dynamic", re: /\bimport\s*\(\s*['"]xlsx['"]\s*\)/, what: 'import("xlsx")（动态）' },
  { id: "require", re: /\brequire\s*\(\s*['"]xlsx['"]\s*\)/, what: 'require("xlsx")' },
];

let pass = 0;
let fail = 0;
const registered: string[] = [];

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

interface Walk {
  files: string[];
  errors: string[];
}

function walk(dir: string, acc: Walk): void {
  let entries;
  try {
    entries = execFileSync("git", ["-c", "core.quotepath=false", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    acc.errors.push(`git ls-files 失败：${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const f of entries.split("\n").map((s) => s.trim()).filter(Boolean)) {
    const parts = f.split("/");
    if (parts.some((p) => SKIP_DIRS.has(p) || p.startsWith(".next"))) continue;
    if (!EXTS.has(path.extname(f).toLowerCase())) continue;
    const full = path.join(dir, f);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    acc.files.push(f);
  }
}

/** 该行是否是「整行注释」（只做形态级判断，不做词法分析；理由见边界） */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/");
}

function main(): void {
  console.log("\n═══ xlsx 使用范围门禁（只允许 scripts/ 引用）═══\n");

  const acc: Walk = { files: [], errors: [] };
  walk(ROOT, acc);
  acc.files.sort();

  check(
    "F1",
    "git 文件清单必须取到（取不到就无法证明「没人引用」，默认失败）",
    acc.errors.length === 0 && acc.files.length > 100,
    `错误 ${acc.errors.length} 条：${acc.errors.join("；") || "（无）"}；文件 ${acc.files.length} 个`,
  );

  const offenders: string[] = [];
  const scanned: string[] = [];
  let skippedByScope = 0;
  for (const f of acc.files) {
    if (f.startsWith(ALLOW_PREFIX)) {
      skippedByScope++;
      continue;
    }
    scanned.push(f);
    let text: string;
    try {
      text = readFileSync(path.join(ROOT, f), "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      for (const { re, what } of IMPORT_FORMS) {
        if (re.test(line)) offenders.push(`${f}:${i + 1}  ${what}`);
      }
    }
  }

  console.log(
    `  READ  扫描 ${scanned.length} 个代码文件（scripts/ 下 ${skippedByScope} 个按约定跳过）`,
  );

  check(
    "A1",
    "scripts/ 之外不得出现 xlsx 的导入语句（4 种形态全覆盖）",
    offenders.length === 0,
    `命中 ${offenders.length} 处：\n        ${offenders.slice(0, 10).join("\n        ")}`,
  );
  check(
    "A2",
    "扫描分母必须 > 100（低于此值说明遍历/过滤写坏了）",
    scanned.length > 100,
    `实际只扫到 ${scanned.length} 个文件`,
  );

  /* 自测：四种形态各自必须能被识别（否则「0 命中」可能只是正则写错了） */
  const SAMPLE: Array<[string, string]> = [
    ["from", 'import XLSX from "xlsx";'],
    ["from", "import type { WorkBook } from 'xlsx';"],
    ["bare", 'import "xlsx";'],
    ["dynamic", 'const m = await import("xlsx");'],
    ["require", 'const x = require("xlsx");'],
  ];
  const missed = SAMPLE.filter(([, src]) => !IMPORT_FORMS.some(({ re }) => re.test(src)));
  check(
    "A3",
    "自测：4 种导入形态各自都能被识别（防止正则写坏导致「永远 0 命中」）",
    missed.length === 0,
    `漏识别 ${missed.length} 条：${missed.map(([, s]) => s).join(" / ")}`,
  );
  const negatives = [
    "// 从表格另存的 xlsx 转 csv",
    "* 可能是 txt / csv / 甚至 xlsx",
    'const name = "xlsx";',
    "const ext = path.extname(f) === '.xlsx';",
  ];
  const falsePos = negatives.filter((s) => IMPORT_FORMS.some(({ re }) => re.test(s)));
  check(
    "A4",
    "自测：注释与普通字符串提到 xlsx 不得判红（否则会逼人去改注释）",
    falsePos.length === 0,
    `误报 ${falsePos.length} 条：${falsePos.join(" / ")}`,
  );

  /* 包装清单判据：只能 devDependencies + 精确版本 */
  const pkgPath = path.join(ROOT, "package.json");
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | null = null;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    pkg = null;
  }
  check("B1", "package.json 必须可解析", pkg !== null, "读取或解析失败");

  if (pkg !== null) {
    const inDeps = pkg.dependencies?.xlsx;
    const inDev = pkg.devDependencies?.xlsx;
    check(
      "B2",
      "xlsx 不得出现在 dependencies（否则会进运行时依赖树）",
      inDeps === undefined,
      `dependencies.xlsx = ${String(inDeps)}`,
    );
    if (inDev === undefined) {
      console.log("  INFO  当前 devDependencies 里还没有 xlsx（换源脚本尚未引入依赖）—— 引入时请锁 0.18.5");
      check("B3", "xlsx 版本必须是精确版本（不含 ^ ~ > < * 等范围符号）", true, "");
    } else {
      check(
        "B3",
        "xlsx 版本必须是精确版本（不含 ^ ~ > < * 等范围符号）",
        /^\d+\.\d+\.\d+$/.test(inDev),
        `devDependencies.xlsx = "${inDev}"`,
      );
    }
  }

  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
  if (registered.length !== pass + fail) {
    console.error("  FAIL  分母自证：注册数与 PASS+FAIL 不相等");
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
