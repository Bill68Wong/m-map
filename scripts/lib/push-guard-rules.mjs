/**
 * 推送/提交守卫的**唯一规则源**
 *
 * 为什么集中：`check-commit-scope.mjs`（提交视角，看暂存区）与
 * `review-push.mjs`（推送视角，看领先远端的全部提交）必须用同一套
 * 「允许路径 / 禁止类型 / 敏感特征」。各写一份就会漂移——
 * 一处放宽、另一处仍严，最终两道门都不可信（铁律 44b 假绿来源之「双份判定」）。
 *
 * ⚠️ 本文件**必然包含敏感词字面量**（正则源就在这儿），扫描自己一定命中，
 * 因此由 `SELF_EXEMPT` 显式豁免。豁免范围保持最小：只此一个文件（铁律 46）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 2026-11-16 重构：判据从「全文命中」改成「新增行命中 + 存量基线双向 ratchet」
 *
 * 为什么必须改（结构性缺陷，不是操作失误）：
 *   原实现对每个改动文件**读全文**再跑 SENSITIVE。于是 `src/lib/dsat/client.ts`
 *   （自 2026-09-23 `1c83f74`）与 `scripts/probe-lang.ts`（自 2026-09-27）**永远无法提交**：
 *   它们命中的是历史内容，而且**删不掉** —— `getRouteData.html` 是真实要调的接口路径，
 *   `genToken` 是真实函数名。这两个文件从 2026-10-28 门禁上线起就再没被改过。
 *   唯一能提交的办法是 `--no-verify`，那比缺陷本身更坏：一旦养成绕过习惯，门禁全线失效。
 *
 * 新判据分两条，各管一件事：
 *   判据 A（提交时 / 推送前看 delta）：**只判本次新增的行**。新增文件 = 全文（本来就是全新增）。
 *     门禁要防的是「往公开仓库里**新写**风险内容」，不是「文件历史上曾有」。
 *   判据 B（体检 `--all`）：**存量不涨**。用 `LEGACY_BASELINE` 记下已登记的历史命中数，
 *     实际 == 基线 ⇒ 存量债免报；> 基线 ⇒ 硬拦（新增违规）；< 基线 ⇒ **也硬拦**
 *     （基线过期必须下调）。双向是故意的：只涨不跌的基线会虚高，反过来掩护未来的新增。
 *   判据 C（文案）：每条命中都要能看出「是自己新写的」还是「历史遗留」。
 *
 * 计数口径（**别改，改了基线全失效**）：单位是**命中行数** —— 同一行里同一条规则命中多次只算 1 行；
 * 同一行若同时命中两条不同规则，则**两条各自记 1**（当前实测无此情况）。
 *
 *   ⚠️ 复核时用错命令会得出不同数字，这不是基线错了：
 *     `grep -cP  '<合并正则>' <file>`      → 行数（**基线用的就是这个**）
 *     `grep -oP '<合并正则>' <file> | wc -l` → 匹配次数（**不是基线口径**）
 *   两者可能在「一行写了两个速率标记」这类内容上分叉（历史上 `data/tracking/README.md` 就是
 *   这样一个样本：行数 1 / 次数 2；那行已于 2026-11-16 清理）。当前全仓恰好两者都等于 13，
 *   但**口径分叉随时可能重现** —— 复核时若看到两个不同的数，先确认自己用的是哪条命令。
 *
 * 为什么选行数而不是次数：本项目的复核习惯是 `grep -c`，选行数能让「复核命令」与「基线口径」
 * 天然对齐；次数口径的要求是要记住 `grep -o`，一忘就误判。代价是同一行多命中会少计，
 * 但那种写法本身罕见，且不影响「有没有、涨没涨」这个真正要判的问题。
 * ══════════════════════════════════════════════════════════════════════════
 */

/** 允许进入仓库的路径前缀（`.githooks/` = 推送审核钩子，属门禁工具本体） */
export const ALLOW_PREFIX = ["src/", "public/", "scripts/", "db/", ".githooks/"];

/**
 * 允许进入仓库的文档白名单（2026-11-05 文档清理后确立）。
 * 除这些之外的 docs/ 文件均视为内部过程文档，只留本地，不进公开仓库。
 */
export const ALLOW_DOCS = ["docs/decisions/ADR-", "docs/brand-export/"];

/** 允许进入仓库的单文件（构建配置 / 依赖清单 / 入口说明） */
export const ALLOW_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.ts",
  "eslint.config.mjs",
  "vercel.json",
  ".gitignore",
  ".gitattributes",
  ".env.example",
  "README.md",
  "next-env.d.ts",
]);

/** 扩展名硬拦截：二进制大件 / 备份 / 环境文件 */
export const BLOCK_EXT = [".pptx", ".mp4", ".mov", ".dump", ".sql", ".gz", ".zip"];

/**
 * `BLOCK_EXT` 的显式豁免（**必须由门禁侧枚举，不得由被检文件自证**）。
 *
 * 只有一条，理由必须写清：`db/schema.sql` 是**建表结构单一真源**，自仓库建立起就是
 * 已跟踪的纯文本文件，且**必须与迁移脚本同批提交**（新增表不更新 schema.sql 会在换机器
 * 跑 `db:schema` 时缺表）。`.sql` 进 BLOCK_EXT 的初衷是拦 `backups/` 下的**数据 dump**
 * （含真实数据、体积大），与该文件无关 —— 若不豁免，等于要求提交迁移却不许提交结构定义，
 * 长期结果是 schema.sql 与库悄悄分叉。
 *
 * ⚠️ 新增条目前先问：它是不是「已跟踪的纯文本结构/契约文件」？是数据快照一律不加。
 */
export const BLOCK_EXT_ALLOW = new Set(["db/schema.sql"]);

/**
 * 敏感内容特征：命中即硬拦（这些是「绕过访问控制」的说明书特征）。
 *
 * `id` 是**稳定键**，供 `LEGACY_BASELINE` 引用。`why` 是给人看的文案，可以改；
 * `id` **不要改** —— 改一次等于把该规则的全部基线清零，会立刻触发「基线过期」。
 */
export const SENSITIVE = [
  { id: "dsat-endpoint", re: /macauweb/i, why: "DSAT 内部接口路径" },
  { id: "dsat-endpoint-name", re: /getRouteAndCompanyList|getRouteData\.html/i, why: "DSAT 未公开接口名" },
  { id: "dsat-auth", re: /genToken|token\s*=\s*md5|md5\(qs\)/i, why: "DSAT 鉴权签名实现" },
  { id: "reverse-eng", re: /签名算法|已破解|已逆向|逆向非公开接口|抓包破解/i, why: "逆向分析描述" },
  { id: "rate-metric", re: /次\s*\/\s*秒|次\/秒|req\/s/i, why: "采集强度指标（易被判异常使用）" },
  { id: "db-url", re: /DATABASE_URL\s*=\s*postgres/i, why: "疑似真实数据库连接串" },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{20,}\b/, why: "疑似 JWT / Token 明文" },
  { id: "supabase-key", re: /sbp_[A-Za-z0-9]{20,}/, why: "疑似 Supabase 密钥" },
];

/**
 * 自身豁免：规则文件里就含这些字面量，扫自己必然误报。
 * 扩大这张表 = 削弱门禁，新增条目必须在注释里写明「为什么它自己也含敏感字面量」。
 *
 * ⚠️ 2026-11-16 明确驳回一次扩表请求：`src/lib/dsat/client.ts` 与 `scripts/probe-lang.ts`
 * 曾被提议加进来「解决提交被拦」。那是**把门关掉**，不是修门（铁律 46）——
 * 加进去之后，这两个文件里将来新写的任何风险内容也一并免检。正确做法是判据 A + 判据 B。
 */
export const SELF_EXEMPT = new Set(["scripts/lib/push-guard-rules.mjs"]);

/**
 * 存量基线（判据 B）：`{ 文件: { 规则id: 命中行数 } }`。
 *
 * 这里记的都是**已登记的历史债**，不是「允许写」。任何一条数字变化都会让 `--all` 变红：
 *   · 变大 ⇒ 有人在老文件里新写了风险内容 ⇒ 拦。
 *   · 变小 ⇒ 债被还了一部分，基线必须同步下调 ⇒ 也拦（防止基线虚高掩护未来新增）。
 *   · 还清了就把该规则 id 从条目里删掉；整个文件还清了就把该文件删掉。
 *
 * ⚠️ 任何清理动作都必须与基线下调**在同一次提交里**，否则 `--all` / `verify` 会因为
 *    「改少了」把你拦住 —— 那不是误报，是基线的双向判据在工作。
 *
 * 口径：命中行数（见文件头）。两条独立对账路径必须都对上 13：
 *   按文件 2 + 3 + 2 + 5 + 1 = 13
 *   按规则 接口名 6 + 签名 7 = 13
 *
 * ⚠️ 2026-11-16 基线由 23 下调到 13：`data/tracking/README.md`、`src/lib/amap/client.ts`、
 *   `src/lib/dsat/token.ts`、`src/lib/dsat/client.ts` 里**可改写而且不损功能**的注释被清掉了
 *   （把接口路径/速率数值/摘要分段描述移出已跟踪文件）。`rate-metric` 两条债务整条消失，
 *   所以 `data/tracking/README.md` 与 `src/lib/amap/client.ts` 已从基线中移除。
 *   这正是「还债必须与基线下调在同一次提交里」的实例 —— 若不改基线，`--all` 会判「基线过期」。
 *
 * ⚠️ `scripts/sync-route-loop-flags.ts` **不在基线里**，这是故意的：它尚未入库
 *    （`git ls-files` 里没有），不属于「仓库现有的存量」。它首次提交时状态为 A，
 *    会被 pre-commit 全文照扫 —— 那才是它的防守点。
 *
 * 新增条目属于「登记新债」，必须能说清为什么删不掉（真实接口路径 / 真实函数名 / 真实 import）。
 */
export const LEGACY_BASELINE = {
  "scripts/probe-dirs.ts": { "dsat-endpoint-name": 2 },
  "scripts/probe-lang.ts": { "dsat-endpoint-name": 1, "dsat-auth": 2 },
  "scripts/test-dsat.ts": { "dsat-auth": 2 },
  "src/lib/dsat/client.ts": { "dsat-endpoint-name": 3, "dsat-auth": 2 },
  "src/lib/dsat/token.ts": { "dsat-auth": 1 },
};

/**
 * 全文扫描时跳过的体积上限。超过则**不静默跳过**——由调用方记一条「未扫描」并判红，
 * 因为「没看」不等于「没问题」（默认方向为失败）。
 *
 * 2026-11-16 由 400 KB 提到 2 MB：原值会把 `src/app/globals.css`（425 KB）挡在扫描之外，
 * 而旧代码对超限文件是 `return ""` **静默跳过** —— 等于这个文件从来没被体检过。
 * 提上限后全仓仅多读 1 个文件（实测 >400 KB 的只有它），代价可忽略。
 *
 * ⚠️ 阈值不是重点，「超限怎么办」才是。调用方必须走下面的 `scanSizeVerdict()` 并把
 * `ok === false` 转成**硬拦**，绝不能写成 `if (tooBig) continue;` 那种静默跳过 ——
 * 那正是改造前的假绿来源。自测 F1 钉住这条语义。
 */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/**
 * 体积判定（纯函数）：给调用方一个统一的「能不能扫」结论。
 * @returns {{ok: true} | {ok: false, reason: string}} —— `ok: false` 必须被转成硬拦。
 */
export function scanSizeVerdict(sizeBytes) {
  if (sizeBytes > MAX_SCAN_BYTES) {
    return {
      ok: false,
      reason: `体积 ${Math.round(sizeBytes / 1024)} KB 超过 ${Math.round(MAX_SCAN_BYTES / 1024)} KB 上限，无法完整扫描`,
    };
  }
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 操作规程：重命名一个「存量债文件」（照着做，不要临场发挥）
 *
 * 为什么需要这份规程：判据 A 取新增行的命令是 `git diff --cached -U0 -- <新路径>`，
 * pathspec 只给新路径时 git 配不上旧路径，会把它当 **new file** 处理 ⇒ 整份内容都是 `+` 行
 * （比「只扫新增行」更严，不会假绿）。于是重命名一个存量债文件时，新路径不在基线里，
 * 全文命中就会被判「新增违规」。
 *
 * 操作步骤（照着做；**注意：纯重命名也会被拦**，这不是 bug）：
 *   因为整份内容都以 `+` 出现，所以重命名一个存量债文件时，pre-commit 会把它的**全部存量命中**
 *   当作「本次新增行」报出来并拦下。三条路，按优先级：
 *
 *   1.【首选】借这次重命名把债还掉：那些命中本来就是可改写的注释/日志文案。
 *     改完从 `LEGACY_BASELINE` **删掉旧路径条目**即可（新路径不需要加，因为已 0 命中）。
 *   2.【必须原样搬】内容一个字都不能动时：先与负责人确认，然后在**同一次提交**里
 *     「旧路径删条目 + 新路径加相同数字」，否则 `--all` 会以新路径「新增违规」变红。
 *     此时 pre-commit 仍需临时放行手段（`--no-verify` 有代价，属例外而非常规；
 *     事后必须补跑 `--all` 并把输出留证）。
 *   3.【禁止】把内容拆成字符串拼接 / 编码以躲开扫描 —— 那是**隐藏而非消除**，
 *     字串照样进仓库、照样可还原（详见 `test-guard-scope.ts` 头部对夹具拼接与生产拼接的区分）。
 *
 *   无论走哪条，收尾都必须 `node scripts/check-commit-scope.mjs --all` 输出「与基线一致」，
 *   且 `npm run verify` 里 E1/E2 通过 —— 那是减债动作唯一的反向防线。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 单文件 diff 文本上限：超过同样判红，理由同上 */
export const MAX_DIFF_BYTES = 2 * 1024 * 1024;

/* ══════════════════════════════════════════════════════════════════════════
 * 以下为**纯函数**（无 I/O、无 git、无 process）。两个调用点与自测共用同一份。
 * 自测直接喂合成字符串即可，不需要真实 git 状态（铁律 44/45）。
 * ════════════════════════════════════════════════════════════════════════ */

/** 带 /g 的正则副本：避免共享 `re` 的 lastIndex 状态串味 */
function globalRe(re) {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/**
 * 全文命中计数（判据 B 的口径：**命中行数**）。
 *
 * 逐行 × 逐规则判定：同一行里同一条规则命中多次只算 1；同一行命中两条不同规则则各记 1。
 * ⚠️ 必须用**无 /g** 的正则副本逐行 `test()`：`String.match(re)` 在 `re` 带 /g 时返回全部匹配
 *    （那是次数，不是行数），不带 /g 时返回「首个匹配 + groups」，`length` 根本不是命中数。
 *    这里统一 `new RegExp(re.source, re.flags 去掉 g)` + `test(line)`，两种情况都不会踩到。
 *
 * @returns {Map<string, number>} 规则 id → 命中行数（无命中不出现在 Map 里）
 */
export function countSensitive(text) {
  const out = new Map();
  const compiled = SENSITIVE.map(({ id, re }) => [id, new RegExp(re.source, re.flags.replace(/g/g, ""))]);
  for (const line of text.split("\n")) {
    for (const [id, re] of compiled) {
      if (re.test(line)) out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * 解析 unified diff（**必须带 `-U0`**）的输出，取出新增行。
 *
 * 为什么必须 `-U0`：带上下文时，被删/未改动的旧行会以 ` ` 前缀出现；若误把它们当新增行扫，
 * 判据 A 就退化成「全文扫描」，重构白做。带 `-U0` 时没有上下文行，只有 `+` / `-`。
 *
 * 行号取自 hunk 头 `@@ -a,b +c,d @@` 的 `c`（新文件起始行），每个 `+` 行递增；
 * `-` 行不占新文件行号（这是最容易写错的一处）。
 *
 * @returns {Array<{line: number, text: string}>}
 */
export function parseAddedLines(diffText) {
  const added = [];
  let newLine = 0;
  const META = [
    "diff ",
    "index ",
    "new file mode",
    "deleted file mode",
    "old mode",
    "new mode",
    "similarity index",
    "dissimilarity index",
    "rename ",
    "copy ",
    "Binary files ",
    "GIT binary patch",
  ];
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (m) newLine = Number(m[1]);
      continue;
    }
    // 文件头 `+++`/`---` 必须先于通配的 `+`/`-` 判定，否则会被当成新增行
    if (raw.startsWith("+++ ") || raw.startsWith("--- ")) continue;
    if (META.some((p) => raw.startsWith(p))) continue;
    if (raw.startsWith("\\ No newline at end of file")) continue;
    if (raw.startsWith("+")) {
      added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
      continue;
    }
    if (raw.startsWith("-")) continue; // 删除行不占新文件行号
    if (raw.startsWith(" ")) {
      newLine += 1; // 万一有人忘了 -U0，上下文行也要正确推进行号
      continue;
    }
    // 其余空行 / 未知元数据行：忽略
  }
  return added;
}

/**
 * 在新增行里找敏感命中。
 * @returns {Array<{id: string, why: string, line: number}>} —— **不回显行内容**：
 *   命中内容本身就是敏感字，打进终端或报告等于二次扩散。
 */
export function findSensitiveInAddedLines(addedLines) {
  const hits = [];
  for (const { id, re, why } of SENSITIVE) {
    const g = globalRe(re);
    for (const l of addedLines) {
      g.lastIndex = 0;
      if (g.test(l.text)) hits.push({ id, why, line: l.line });
    }
  }
  return hits;
}

/**
 * 判据 B：单文件存量比对。
 *
 * @returns {{
 *   blocks: Array<{file: string, id: string, why: string, kind: "新增违规"|"基线过期", actual: number, base: number}>,
 *   legacy: Array<{file: string, id: string, why: string, actual: number}>
 * }}
 */
export function judgeLegacy(file, text) {
  const counts = countSensitive(text);
  const base = LEGACY_BASELINE[file] ?? {};
  const blocks = [];
  const legacy = [];
  for (const { id, why } of SENSITIVE) {
    const actual = counts.get(id) ?? 0;
    const baseCount = base[id] ?? 0;
    if (actual === 0 && baseCount === 0) continue;
    if (actual > baseCount) {
      blocks.push({ file, id, why, kind: "新增违规", actual, base: baseCount });
    } else if (actual < baseCount) {
      blocks.push({ file, id, why, kind: "基线过期", actual, base: baseCount });
    } else {
      legacy.push({ file, id, why, actual });
    }
  }
  return { blocks, legacy };
}

/** 基线里登记过的文件集合（供 `--all` 输出「已登记 N 个文件」这类汇总） */
export const LEGACY_FILES = Object.freeze(Object.keys(LEGACY_BASELINE));

/** 规则 id → 可读文案（报告里用 id 存基线、用 why 给人看） */
export function ruleWhy(id) {
  return SENSITIVE.find((r) => r.id === id)?.why ?? id;
}
