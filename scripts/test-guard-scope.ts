/**
 * 提交/推送门禁的判据自测（`scripts/test-guard-scope.ts`，2026-11-16 新建）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   2026-11-16 把 `check-commit-scope.mjs` / `review-push.mjs` 的敏感判据从
 *   「读全文」改成「只看本次新增的行 + 存量基线双向 ratchet」。这次重构动的是**门禁本身**，
 *   而门禁最大的失效方式不是漏报，是**判据悄悄坏掉之后仍然显示 PASS**。
 *   本文件的作用：把「门禁会不会红」这件事本身变成可执行断言。
 *
 * ── 为什么不用 git（纯函数自测）───────────────────────────────────────────
 *   `push-guard-rules.mjs` 里导出的是纯函数（`parseAddedLines` / `findSensitiveInAddedLines`
 *   / `countSensitive` / `judgeLegacy`），全部只吃字符串。自测直接喂合成 diff 文本，
 *   不需要建临时仓、不需要动真实索引 ⇒ 也就不会污染工作区（铁律 44/45）。
 *   真实 git 路径的端到端验证另做（见交付报告里的 4 个突变 + 1 个反向断言）。
 *
 * ── 探针串为什么是「运行时拼出来的」──────────────────────────────────────
 *   本文件要喂给解析器「含敏感字串的新增行」才能证明它拦得住。但本文件自己也是一次
 *   `--all` 体检的扫描对象：**写死字面量就会把自测文件自己判成违规**，于是要么加豁免
 *   （把门关掉，铁律 46），要么写不成。
 *   所以探针用 `["get","RouteData",".html"].join("")` 在运行时拼出。
 *   ⚠️ 这与「把真内容拆开以躲过门禁」是两回事，区别在于：
 *      · 这里拼的是**只为测试存在的合成串**，拼完立刻断言它**确实能被规则匹配到**（B4 判据），
 *        证明探针没被架空；
 *      · 被保护的真实文件（`src/lib/dsat/client.ts` 等）**一个字都没动**，也没有任何拼接规避。
 *   若哪天有人把 B4 判据删掉，探针就可能被悄悄改成永不匹配的空壳 —— 那才是假绿。
 *
 *   ⚠️⚠️ **不要照抄这个写法去改生产代码。** 判据要求区分的不是「拼没拼字符串」，而是
 *   「风险字串还在不在能被执行的源码里」：
 *     · 本文件拼出来的是**只为测试存在的输入**，它不描述任何真实接口、不执行任何真实调用，
 *       拼它的目的恰恰是**证明门禁能拦住它自己**（B4 反向验证）。
 *     · 把 `src/lib/dsat/client.ts` 里的真实接口路径拆成拼接 ⇒ 字串照样会进仓库、照样被打包、
 *       照样可被读取还原，只是把门禁的匹配破坏了。**那是隐藏，不是消除。**
 *   一句话：夹具拼接是为了「让门禁能自测」，生产拼接是为了「让门禁看不见」。后者一律否决。
 *
 * ── 与 `--all` 的关系（E 组）──────────────────────────────────────────────
 *   E 组直接对真实仓库跑 `judgeLegacy`：任何文件的存量命中数偏离 `LEGACY_BASELINE` 都会红。
 *   也就是说本判据把 `--all` 的 ratchet 拉进了 `npm run verify`，不必等有人想起来跑体检。
 *   E1 走「按文件」、E2 走「按规则」，两条独立路径必须同时对上 13 —— 对不上说明正则边界
 *   与基线口径漂了，**这时不要改数字去凑**。
 *
 * ── 计数口径（B5 判据把它钉死）────────────────────────────────────────────
 *   基线用**命中行数**：同一行同一规则命中多次只算 1。复核命令是 `grep -cP`，
 *   不是 `grep -oP | wc -l`（后者是次数口径）。当前全仓两种口径恰好都等于 13，
 *   但**分叉随时可能重现**（历史上 README 就有一行含两个速率标记：行数 1 / 次数 2）。
 *   B5 用合成串断言「一行两次 ⇒ 1、两行 ⇒ 2」，谁把实现改回次数口径就会立刻红。
 *
 * 跑法：`npm run test:guard-scope`
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SENSITIVE,
  LEGACY_BASELINE,
  MAX_SCAN_BYTES,
  scanSizeVerdict,
  parseAddedLines,
  findSensitiveInAddedLines,
  countSensitive,
  judgeLegacy,
} from "./lib/push-guard-rules.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/* ══════════════════════════════════════════════════════════════════════════
 * 合成探针（运行时拼接，理由见文件头）
 * ════════════════════════════════════════════════════════════════════════ */
const P_ENDPOINT = ["get", "RouteData", ".html"].join("");
const P_AUTH = ["gen", "Token"].join("");
/** 一行「无关改动」：注释内容，不该命中任何规则 */
const SAFE_LINE = "// 仅调整注释措辞，无逻辑变更";

/** 组一个最小 `-U0` diff：header + hunk + 若干 `+` 行 */
function diffOf(newStart: number, lines: string[]): string {
  return [
    "diff --git a/probe.ts b/probe.ts",
    "index 1111111..2222222 100644",
    "--- a/probe.ts",
    "+++ b/probe.ts",
    `@@ -${newStart},0 +${newStart},${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    "",
  ].join("\n");
}

function main(): void {
  console.log("\n═══ 门禁判据自测（新增行 + 存量基线 ratchet）═══\n");

  /* ── A 组：diff 解析 ─────────────────────────────────────────────────── */
  console.log("  ── A 组：`git diff -U0` 解析 ──");
  {
    const d = diffOf(11, ["a", "b"]);
    const got = parseAddedLines(d);
    check(
      "A1",
      "两个 + 行 ⇒ 行号 11、12（取自 hunk 头的新文件起始行）",
      got.length === 2 && got[0].line === 11 && got[1].line === 12,
      `实际 ${JSON.stringify(got.map((g: { line: number }) => g.line))}`,
    );
  }
  {
    const d = diffOf(7, ["x"]);
    const got = parseAddedLines(d);
    check(
      "A2",
      "文件头 `---` / `+++` 不得被当成新增行",
      got.length === 1 && got[0].text === "x",
      `实际解析出 ${got.length} 行：${JSON.stringify(got.map((g: { text: string }) => g.text))}`,
    );
  }
  {
    /* 删一行、加一行：删除行不占新文件行号 ⇒ 新增行仍是 5 */
    const d = [
      "--- a/probe.ts",
      "+++ b/probe.ts",
      "@@ -5,2 +5,1 @@",
      "-old line",
      "+new line",
      "",
    ].join("\n");
    const got = parseAddedLines(d);
    check(
      "A3",
      "删除行不占新文件行号（删一行加一行 ⇒ 新增行仍报 5）",
      got.length === 1 && got[0].line === 5,
      `实际 ${JSON.stringify(got)}`,
    );
  }
  {
    const d = diffOf(3, ["a", "b", "c"]);
    const plusCount = d.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
    const got = parseAddedLines(d);
    check(
      "A4",
      "`-U0` 下解析出的行数 == diff 里的 + 行数（没有把上下文行混进来）",
      got.length === plusCount,
      `解析 ${got.length} 行，diff 有 ${plusCount} 个 + 行`,
    );
  }

  /* ── B 组：判据 A（新增行命中）──────────────────────────────────────── */
  console.log("\n  ── B 组：判据 A —— 只判本次新增的行 ──");
  {
    const d = diffOf(257, [SAFE_LINE, `const u = "${P_ENDPOINT}";`]);
    const hits = findSensitiveInAddedLines(parseAddedLines(d));
    check(
      "B1",
      "新增行写入接口路径探针 ⇒ 命中，且行号是 258",
      hits.length === 1 && hits[0].id === "dsat-endpoint-name" && hits[0].line === 258,
      `实际 ${JSON.stringify(hits)}`,
    );
  }
  {
    /* 突变②的纯函数形式：只删不加 ⇒ 判据 A 不该拦（拦的是 --all 的基线过期） */
    const d = [
      "--- a/probe.ts",
      "+++ b/probe.ts",
      "@@ -10,1 +10,0 @@",
      `-const t = ${P_AUTH}(qs);`,
      "",
    ].join("\n");
    const added = parseAddedLines(d);
    const hits = findSensitiveInAddedLines(added);
    check(
      "B2",
      "只删不增 ⇒ 0 新增行、0 命中（删除不归判据 A 管，由 --all 的「基线过期」负责）",
      added.length === 0 && hits.length === 0,
      `新增行 ${added.length}、命中 ${hits.length}`,
    );
  }
  {
    /* 反向断言：只改注释措辞 ⇒ 必须绿，否则实现过严，会把正常维护卡死 */
    const d = diffOf(4, [SAFE_LINE]);
    const hits = findSensitiveInAddedLines(parseAddedLines(d));
    check(
      "B3",
      "反向断言：新增行只改注释措辞 ⇒ 0 命中（实现不得过严）",
      hits.length === 0,
      `实际命中 ${JSON.stringify(hits)}`,
    );
  }
  {
    /* 防探针被架空：拼出来的串必须真的能被规则匹配到 */
    const c1 = countSensitive(P_ENDPOINT);
    const c2 = countSensitive(P_AUTH);
    check(
      "B4",
      "探针有效性：拼出的探针确实能命中规则（防止有人把它改成永不匹配的空壳）",
      (c1.get("dsat-endpoint-name") ?? 0) >= 1 && (c2.get("dsat-auth") ?? 0) >= 1,
      `接口路径探针命中 ${c1.get("dsat-endpoint-name") ?? 0}、鉴权探针命中 ${c2.get("dsat-auth") ?? 0}`,
    );
  }
  {
    /*
     * 口径语义钉子：基线用的是**命中行数**，不是匹配次数。
     * 这里刻意构造「同一行写两次」，断言计 1 —— 若有人把实现改回次数口径，这条会立刻红。
     * 真实样本就是 data/tracking/README.md：那一行把同一个速率标记写了两遍，行数 1 / 次数 2。
     * （本注释刻意不写那个字面量：本文件是新增文件，提交时会被全文扫描，
     *   写进去就会把自己拦下来 —— 这是实测踩过的坑，不是猜测。）
     */
    const oneLineTwice = `${P_ENDPOINT} and ${P_ENDPOINT}`;
    const n = countSensitive(oneLineTwice).get("dsat-endpoint-name") ?? 0;
    const twoLines = `${P_ENDPOINT}\n${P_ENDPOINT}`;
    const n2 = countSensitive(twoLines).get("dsat-endpoint-name") ?? 0;
    check(
      "B5",
      "计数口径钉死：同一行命中两次 ⇒ 记 1（行数）；拆成两行 ⇒ 记 2",
      n === 1 && n2 === 2,
      `同一行两次算作 ${n}（应 1）、两行算作 ${n2}（应 2）—— 有人把口径改回「匹配次数」了`,
    );
  }

  /* ── C 组：判据 B（存量基线双向 ratchet）────────────────────────────── */
  console.log("\n  ── C 组：判据 B —— 存量基线双向 ratchet ──");
  {
    /* 拿一个基线里真实存在的文件，构造「刚好等于基线」的文本 */
    const file = "src/lib/dsat/client.ts";
    const base = LEGACY_BASELINE[file] as Record<string, number>;
    const id = "dsat-auth";
    const n = base[id];
    const text = Array.from({ length: n }, () => P_AUTH).join("\n");
    const r = judgeLegacy(file, text);
    /* 该文件其它规则计数为 0 < 基线 ⇒ 会报「基线过期」，这是预期：
       只需确认 dsat-auth 这一条落在「存量」侧、不在「新增违规」侧 */
    const blockedAsNew = r.blocks.some((b: { id: string; kind: string }) => b.id === id && b.kind === "新增违规");
    const isLegacy = r.legacy.some((l: { id: string; actual: number }) => l.id === id && l.actual === n);
    check(
      "C1",
      `实际 == 基线（${id} = ${n}）⇒ 记为存量债，不判「新增违规」`,
      !blockedAsNew && isLegacy,
      `blocks=${JSON.stringify(r.blocks)}`,
    );
  }
  {
    const file = "src/lib/dsat/client.ts";
    const base = LEGACY_BASELINE[file] as Record<string, number>;
    const id = "dsat-auth";
    const text = Array.from({ length: base[id] + 1 }, () => P_AUTH).join("\n");
    const r = judgeLegacy(file, text);
    const hit = r.blocks.find((b: { id: string; kind: string }) => b.id === id);
    check(
      "C2",
      `实际 > 基线（${base[id]} + 1）⇒ 硬拦，且理由是「新增违规」`,
      hit !== undefined && hit.kind === "新增违规",
      `blocks=${JSON.stringify(r.blocks)}`,
    );
  }
  {
    const file = "src/lib/dsat/client.ts";
    const base = LEGACY_BASELINE[file] as Record<string, number>;
    const id = "dsat-auth";
    const text = Array.from({ length: Math.max(0, base[id] - 1) }, () => P_AUTH).join("\n");
    const r = judgeLegacy(file, text);
    const hit = r.blocks.find((b: { id: string; kind: string }) => b.id === id);
    check(
      "C3",
      `实际 < 基线（${base[id]} - 1）⇒ 也硬拦，理由是「基线过期」`,
      hit !== undefined && hit.kind === "基线过期",
      `blocks=${JSON.stringify(r.blocks)}`,
    );
  }
  {
    const r = judgeLegacy("src/lib/__不存在的探针__.ts", `const u = "${P_ENDPOINT}";`);
    const hit = r.blocks.find((b: { kind: string }) => b.kind === "新增违规");
    check(
      "C4",
      "未登记的文件里出现命中 ⇒ 基线视为 0 ⇒ 判「新增违规」",
      hit !== undefined,
      `blocks=${JSON.stringify(r.blocks)}`,
    );
  }

  /* ── D 组：台账完整性（防止基线静默失效）────────────────────────────── */
  console.log("\n  ── D 组：LEGACY_BASELINE 台账完整性 ──");
  {
    const ids = new Set(SENSITIVE.map((r: { id: string }) => r.id));
    const bad: string[] = [];
    for (const [file, rules] of Object.entries(LEGACY_BASELINE)) {
      for (const id of Object.keys(rules as Record<string, number>)) {
        if (!ids.has(id)) bad.push(`${file} → ${id}`);
      }
    }
    check(
      "D1",
      "基线引用的每个规则 id 都必须存在于 SENSITIVE（改 id 会让基线静默清零）",
      bad.length === 0,
      `失效引用：${bad.join(" / ") || "（无）"}`,
    );
  }
  {
    const missing = Object.keys(LEGACY_BASELINE).filter((f) => !existsSync(path.join(ROOT, f)));
    check(
      "D2",
      "基线里每个文件都必须真实存在（防止陈旧条目留着一个不存在的文件）",
      missing.length === 0,
      `不存在：${missing.join(" / ") || "（无）"}`,
    );
  }
  {
    const zero: string[] = [];
    for (const [file, rules] of Object.entries(LEGACY_BASELINE)) {
      for (const [id, n] of Object.entries(rules as Record<string, number>)) {
        if (!(n > 0)) zero.push(`${file} → ${id} = ${n}`);
      }
    }
    check(
      "D3",
      "基线里不得出现 0 值条目（0 等于「没债」，应当整条删掉）",
      zero.length === 0,
      `0 值条目：${zero.join(" / ") || "（无）"}`,
    );
  }
  {
    /*
     * 这条是「--all 只扫已跟踪文件」这个决定的配套保险：
     * 基线里若混进一个未跟踪文件，它**永远不会被扫描**，条目形同虚设，
     * 而且将来它入库时那些命中会以「新增行」身份撞上 pre-commit —— 两处都说不清。
     */
    let tracked = new Set<string>();
    try {
      const out = execFileSync("git", ["-c", "core.quotepath=false", "ls-files"], {
        cwd: ROOT,
        encoding: "utf8",
      });
      tracked = new Set(out.split("\n").map((s: string) => s.trim()).filter(Boolean));
    } catch {
      /* git 不可用时由下面判红 */
    }
    const untracked = Object.keys(LEGACY_BASELINE).filter((f) => !tracked.has(f));
    check(
      "D4",
      "基线里每个文件都必须是**已跟踪**文件（--all 只扫 tracked，未跟踪条目永远不会被检查）",
      tracked.size > 0 && untracked.length === 0,
      tracked.size === 0 ? "git ls-files 取不到文件清单" : `未跟踪：${untracked.join(" / ")}`,
    );
  }

  /* ── E 组：与真实仓库对账（把 --all 的 ratchet 拉进 verify）─────────── */
  console.log("\n  ── E 组：真实仓库对账（等价于 `check-commit-scope.mjs --all`）──");
  {
    const drift: string[] = [];
    const legacySummary: string[] = [];
    const byRule = new Map<string, number>();
    let total = 0;
    for (const file of Object.keys(LEGACY_BASELINE)) {
      const abs = path.join(ROOT, file);
      if (!existsSync(abs)) continue; // D2 已单独判
      if (statSync(abs).size > MAX_SCAN_BYTES) {
        drift.push(`${file} —— 体积超上限，无法对账`);
        continue;
      }
      const r = judgeLegacy(file, readFileSync(abs, "utf8"));
      for (const b of r.blocks) {
        drift.push(`${file} / ${b.id}：实际 ${b.actual} vs 基线 ${b.base}（${b.kind}）`);
      }
      for (const l of r.legacy) {
        legacySummary.push(`${file} ${l.id}=${l.actual}`);
        byRule.set(l.id, (byRule.get(l.id) ?? 0) + l.actual);
        total += l.actual;
      }
    }
    check(
      "E1",
      "真实仓库的存量命中必须与 LEGACY_BASELINE 逐条一致（>基线=新增违规，<基线=基线过期）",
      drift.length === 0,
      `偏离 ${drift.length} 条：${drift.join("；")}`,
    );
    console.log(`        存量债明细：${legacySummary.join(" · ")}`);

    /*
     * 第二条独立对账路径：按**规则**汇总。
     * 与按文件汇总必须同时成立（7+5+3+2+2+3+1 = 23 与 8+11+4 = 23）。
     * 若两者对不上，说明正则边界与基线口径已经不一致 —— 这时**不要改数字去凑**，要查规则。
     */
    const EXPECT_BY_RULE: Record<string, number> = {
      "dsat-endpoint-name": 6,
      "dsat-auth": 7,
    };
    const ruleDrift: string[] = [];
    for (const [id, want] of Object.entries(EXPECT_BY_RULE)) {
      const got = byRule.get(id) ?? 0;
      if (got !== want) ruleDrift.push(`${id}：实际 ${got}，期望 ${want}`);
    }
    const extra = [...byRule.keys()].filter((id) => !(id in EXPECT_BY_RULE));
    if (extra.length > 0) ruleDrift.push(`出现预期之外的规则命中：${extra.join(" / ")}`);
    check(
      "E2",
      "按「规则」汇总也必须对上（接口名 6 + 签名 7 = 13，与按文件的 13 双向一致）",
      ruleDrift.length === 0 && total === 13,
      `合计 ${total}（期望 13）；${ruleDrift.join("；") || "（规则分布一致）"}`,
    );
  }

  /* ── F 组：默认失败（超限必须报错，不许静默跳过）─────────────────────── */
  console.log("\n  ── F 组：默认失败 —— 扫不了就必须红，不许静默跳过 ──");
  {
    const over = scanSizeVerdict(MAX_SCAN_BYTES + 1);
    const at = scanSizeVerdict(MAX_SCAN_BYTES);
    check(
      "F1",
      "超上限 ⇒ 返回 ok:false 且带原因（调用方据此硬拦），恰好等于上限 ⇒ ok:true",
      over.ok === false && typeof over.reason === "string" && over.reason.length > 0 && at.ok === true,
      `超限返回 ${JSON.stringify(over)}、边界返回 ${JSON.stringify(at)}`,
    );
  }
  {
    /*
     * 回归钉：改造前阈值是 400 KB，`src/app/globals.css`（425 KB）因此被
     * `return ""` 静默跳过 —— 那个文件多年没被体检过，而门禁一直显示绿。
     * 谁把阈值改回 400 KB，这条会立刻红。
     */
    const css = path.join(ROOT, "src/app/globals.css");
    const size = existsSync(css) ? statSync(css).size : 0;
    check(
      "F2",
      "扫描上限必须大于仓库里最大的待扫文本文件（globals.css 已 425 KB，阈值不得回退到 400 KB）",
      size > 0 && MAX_SCAN_BYTES > size,
      `globals.css = ${Math.round(size / 1024)} KB，上限 = ${Math.round(MAX_SCAN_BYTES / 1024)} KB`,
    );
  }

  /* ── 汇总 ────────────────────────────────────────────────────────────── */
  console.log(`\n═══ 合计 ${registered.length} 条判据：PASS ${pass} / FAIL ${fail} ═══`);
  if (registered.length !== pass + fail) {
    console.error("  FAIL  分母自证：注册数与 PASS+FAIL 不相等");
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
