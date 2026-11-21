/**
 * stations 表写入规约检查（scripts/check-station-writes.mjs）
 *
 * 为什么需要它：`stations` 的 upsert / update 若**无条件重写**整行，每次跑都会产生
 * 新元组 ⇒ ctid 顺序被打乱 ⇒ `/api/stations` 的「主码 → 选中站台」结果可能变化
 * ⇒ **用户收藏的坐标键漂移、收藏失联**（收藏去重键含坐标，见 `favorites/v3.ts`）。
 * 这类问题不报错、不越界，只是"某些站的点位悄悄变了"，人工看代码看不出来。
 *
 * ── 判据（D0–D4，每条都配了变异用例，见 `--selftest`）─────────────────────
 *   D0 捕获形态异常（2026-11-20 评审整改 P4）：`STMT_RE` 只对**模板字符串**成立。
 *      捕获超 2000 字符、或出现 `";` / `+ "` 这类拼接特征 ⇒ 直接红。
 *      ⇒ **stations 写入 SQL 必须用模板字符串**（反引号），这是本检查器的前提。
 *   D1 每条 `UPDATE stations SET …` / `INSERT INTO stations … ON CONFLICT … DO UPDATE`
 *      必须含 `IS DISTINCT FROM`（否则等于每次都重写）
 *   D2 **单列** `SET` 时，该列必须以 `col IS DISTINCT FROM …` 形式出现在 WHERE
 *      （防「漏判」：`SET name_tc` 却只判了 `dsat_synced`）
 *   D3 **多列** `SET` 必须整行比较 `(c1,c2,…) IS DISTINCT FROM (…)`，
 *      且**左列表与 SET 列集合相等**（去重、顺序无关、去表限定符）
 *      （防「连接词错」写成 AND 分列 ⇒ 两列都变才写；也防「漏列」⇒ 有的列根本没参与比较）
 *   D4 白名单条目必须仍能命中它的 `detect` 特征串，否则报「已失效，请移除」
 *      （防白名单僵化：某条路径早就修好了、白名单还挂着 ⇒ 门永远开一条缝）
 *
 * ── 默认拒绝（2026-11-20 前端评审追加）──────────────────────────────────
 *   `IS DISTINCT FROM` 的**可接受形态只有两种**：
 *     ① 单列：`col IS DISTINCT FROM …`
 *     ② 多列：`(c1,c2,…) IS DISTINCT FROM (…)`，且左列表集合 == SET 列集合
 *   其它形态（`ROW(a,b) IS DISTINCT FROM ROW(…)`、`coalesce(col,…) IS DISTINCT FROM …`、
 *   任何函数包裹）一律**判红**，并在提示里给出改写方式。
 *   理由：加正向正则只能堵「已经想到的写法」，而默认拒绝让**没见过的写法先红再决定**。
 *   代价：确实等价的新写法要改一句或加一条自检用例 —— 这个成本我们接受（改脚本比漏检便宜）。
 *
 * ── 为什么必须是 allowlist 骨架（2026-11-20 与前端共同收敛的一条通用规则）──
 *   两个方向的失效**不对称**：
 *     · allowlist 漏了某个可接受形态 ⇒ **红**（响的、当场的、必须处理）；
 *     · blocklist 漏了某个坏形态 ⇒ **绿**（哑的、滞后的、没人知道）。
 *   ⇒ 门禁最怕的不是"判错一次"，是"判错了还没人知道"。本文件里三条改动是同一命题的三面：
 *     默认拒绝（形态）、白名单过期检测（条目）、缺文件跳过（环境）——都是「让失效可见」。
 *   ⚠️ 但 allowlist 只适用于**形态封闭、数量有限**的对象（`IS DISTINCT FROM` 左右能写什么
 *     是有限集）。**开放集**（如"任意 JS 表达式"）不能用 allowlist，那会天天堵人 ——
 *     开放集别做形态判据，改用类型系统 / 约定 + review。
 *   ⚠️ D1（「必须含 `IS DISTINCT FROM`」）看着像"必须含"式的正面判据，但它只是**前置条件**，
 *     放行判定在 D2/D3。**不要照着 D1 的写法去加"见某某即红"的新判据** —— 那是退化成 blocklist。
 *
 * ── 2026-11-20 评审整改（前端只读评审 + 负责人裁决，5 条）─────────────────
 *   P1 挂进 `npm run verify`（`check:station-writes`）—— 不挂 = 一次性脚本。
 *   P2 D2 取消 40 字符窗口：旧写法在多列长列名下**假红**、窗口跨 `OR` 时**假绿**。
 *      现在 D2 只做单列且要求列名紧跟 `IS DISTINCT FROM`，多列完全交给 D3。
 *   P3 D3 从「判形状」改成「判集合相等」：`SET a,b,extra` 配 `(a,b)` 不再能过。
 *   P4 捕获层护栏（见 D0）。
 *   P5 `expected:{red,white}` 降级为**打印提示**，不参与退出码 ——
 *      否则「数字不符即红」会被人直接改数字调绿，那是假绿的最短路径。
 *
 * ── 文件不在本机时的行为（2026-11-20 负责人裁决）──────────────────────
 *   白名单里指向 **未入库文件**（如 `db/sync-all-routes.ts`，按 D1 决策移出公开仓库）
 *   的条目，在新 clone / 换机器的环境里**找不到文件**。此时：
 *     · **不算红、不算过期、不影响退出码** —— 只打一行 `○ 跳过（文件不在本机）`；
 *     · 理由：该文件本来就不该出现在干净 clone 里，若报红则新环境第一次跑门禁就是红的，
 *       所有人学会「这条红是正常的」⇒ 门禁从此失效（比漏检更糟）。
 *   ⚠️ 边界的代价：真删掉了某个曾受管制的文件，本检查**不会**提醒你删除白名单条目。
 *      这类情况由人工 review 白名单文件变更兜底（白名单本身是受版本控制的 JSON）。
 *
 * ── 诊断输出不许「沉默即正常」（2026-11-20 负责人定为通用规则）────────────
 *   凡是「为 0 就跳过打印」的地方，一律改成「**无条件打印结论 + 数值**」：
 *   非零报红/报警，为零打一行 `✓ … 0`。
 *   理由：否则下一个人（包括作者自己）会把「没看到」读成「没发生」 ——
 *   本脚本的 `--selftest` 与 `weekday` 校验都各踩过一次这个坑。
 *   本文件的 reds / whites / stale / missing 四段现在都遵守这条。
 *
 * ── 为什么不做「见 AND 即红」────────────────────────────────────────────
 *   正确写法的外层**必须**是 AND：
 *       WHERE code = $1 AND (lat IS DISTINCT FROM $2 OR lng IS DISTINCT FROM $3)
 *   笼统禁 AND 会误伤它；而且 `NOT (a IS NOT DISTINCT FROM b AND …)` 这类等价变形
 *   任何"连接词黑名单"都判不出来。⇒ 改用**形式约束**（D3）：多列必须是整行比较，
 *   于是"语义正确性由语法形态保证"，检查器不必理解布尔逻辑，也无法用等价变形绕过。
 *
 * ── D3 的一个 caveat（必读）────────────────────────────────────────────
 *   整行比较**不阻止「用 NULL 覆盖有效坐标」**：
 *       WHERE (lat, lng) IS DISTINCT FROM (NULL, NULL)   -- 有值时判"不同" ⇒ 写入 NULL
 *   若入参可能为 NULL，须另加 `AND $2 IS NOT NULL`。当前 `import-station-coords`
 *   的三条调用路径都在 JS 侧挡住了（见白名单说明），所以暂无此风险。
 *
 * ── 白名单 ───────────────────────────────────────────────────────────
 *   外部数据：`scripts/data/station-writes-whitelist.json`（不写死在逻辑里）。
 *   分类口径是「**调用方是否已去重**」，不是「SQL 有没有 WHERE」——
 *   只看 SQL 会把"JS 侧已经判过"的路径误报成红，然后有人为了让它变绿去改错地方。
 *   每条理由必须可核查（带 `file:line` 或可复现判据），不许写「历史原因」。
 *
 * 用法：
 *   node scripts/check-station-writes.mjs            # 正常检查
 *   node scripts/check-station-writes.mjs --selftest # 跑 4 条判据的变异自检
 *
 * 只读：纯文本扫描，**不连库**。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");
const DB_DIR = join(REPO_ROOT, "db");
const WHITELIST_PATH = join(REPO_ROOT, "scripts", "data", "station-writes-whitelist.json");

/** 目标语句的识别式 */
const STMT_RE = /(UPDATE\s+stations\s+SET[\s\S]*?)(?:`|$)|(INSERT\s+INTO\s+stations[\s\S]*?ON\s+CONFLICT[\s\S]*?DO\s+UPDATE[\s\S]*?)(?:`|$)/gi;

/** 递归收集 db/**\/*.ts */
function collectFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

/** 定位行号（1 基） */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** 把 SQL 压成单行便于分析（保留原串用于展示时再还原） */
const flat = (s) => s.replace(/\s+/g, " ").trim();

/**
 * 从一条语句里拆出「SET 子句」与「WHERE 子句」。
 * @returns {{setCols:string[], where:string, isOnConflict:boolean}}
 */
function parseStatement(stmt) {
  const s = flat(stmt);
  const isOnConflict = /ON\s+CONFLICT/i.test(s);

  // SET 子句：取**最后一个** SET（`UPDATE … SET` 或 `DO UPDATE SET`）到 WHERE / 末尾
  const setIdx = s.search(/(?:\bDO\s+UPDATE\s+SET\b|\bUPDATE\s+stations\s+SET\b|\bSET\b)(?![\s\S]*\bSET\b)/i);
  const effectiveSetIdx = setIdx >= 0 ? setIdx : s.toUpperCase().lastIndexOf(" SET ");
  const afterSet = effectiveSetIdx >= 0 ? s.slice(s.toUpperCase().indexOf("SET", effectiveSetIdx) + 3) : "";
  const whereM = /\bWHERE\b/i.exec(afterSet);
  const setClause = whereM ? afterSet.slice(0, whereM.index) : afterSet;
  const where = whereM ? afterSet.slice(whereM.index) : "";

  /**
   * 列名提取：只取 SET 左侧的标识符。
   * ⚠️ 必须排除 `EXCLUDED.name_tc` 里的 `name_tc`、以及 `regexp_replace(name_tc, …)` 这类
   *    右值里出现的列名 —— 否则会把"被引用的列"当成"被写入的列"。
   *    做法：按逗号切分 SET 子句（顶层逗号），每段取第一个 `=` 左侧的末段标识符。
   */
  const setCols = [];
  for (const part of splitTopLevel(setClause)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const lhs = part.slice(0, eq).trim();
    const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(lhs);
    if (m) setCols.push(m[1]);
  }
  return { setCols, where, isOnConflict };
}

/** 按顶层（括号外）逗号切分 */
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** D1–D3 判据；返回违规说明数组（空 = 通过） */
function judge(parsed) {
  const problems = [];
  const { setCols, where } = parsed;

  if (setCols.length === 0) {
    problems.push("D0: 未能从 SET 子句解析出列名 ⇒ SQL 形态不受支持（stations 写入必须用模板字符串，见文件头）");
    return problems;
  }
  if (!where) {
    problems.push("D1: 整条语句没有 WHERE ⇒ 每次都会重写整行");
    return problems;
  }
  if (!/IS\s+DISTINCT\s+FROM/i.test(where)) {
    problems.push("D1: WHERE 里没有 IS DISTINCT FROM ⇒ 条件与「值是否变化」无关");
  }

  /**
   * ★ D2 只负责**单列**（2026-11-20 评审整改 P2）。
   *
   * 旧写法是 `\bcol\b[\s\S]{0,40}?IS DISTINCT FROM` —— 那个 40 是隐式魔数，会两头错：
   *   · 假红：多列且列名长（`station_name_tc` 距 `IS DISTINCT FROM` 超 40 字符）；
   *   · 假绿：窗口跨过 `OR`/`AND`，把**别的列**的条件算给本列。
   * 现在单列分支**不留窗口**：要求列名**紧跟** `IS DISTINCT FROM`，
   * 跨列不可能命中（`lng` 出现在 `lat IS DISTINCT FROM` 前面时，`\blng\b\s+IS` 不成立）。
   * 多列完全不进 D2 —— 交给 D3 的集合相等，两处魔数一起消失。
   */
  if (setCols.length === 1) {
    const col = setCols[0];
    const re = new RegExp(`\\b${col}\\b\\s+IS\\s+DISTINCT\\s+FROM\\b`, "i");
    if (!re.test(where))
      problems.push(
        `D2: SET 列 \`${col}\` 未在 WHERE 中以 \`${col} IS DISTINCT FROM …\` 形式出现` +
          `（未识别的比较形态一律按红处理：可接受形态只有 \`col IS DISTINCT FROM …\` 与 ` +
          `\`(c1,c2,…) IS DISTINCT FROM (…)\`；\`ROW(a,b)\`、\`coalesce(col,…)\` 等请改写成这两种之一）`,
      );
    return problems;
  }

  /**
   * ★ D3 多列：**整行比较 + 左列表必须与 SET 列集合相等**（评审整改 P3）。
   *
   * 旧实现只判「形状」（`(a,b,…) IS DISTINCT FROM (` 存在即过），
   * 于是 `SET lat=$1, lng=$2, extra=$3` 配 `(lat, lng) IS DISTINCT FROM ($1,$2)` 能过 ——
   * `extra` 根本没参与比较，「值变了才写」的语义已破。
   * ⇒ 从 WHERE 里抓左列表，做**集合相等**（去重、顺序无关、去掉 `stations.` 这类限定符）。
   */
  const rows = findRowComparisons(where);
  if (!rows.length) {
    problems.push(
      `D3: ${setCols.length} 列 SET（${setCols.join(", ")}）但 WHERE 未用整行比较 ` +
        `(c1,c2,…) IS DISTINCT FROM (e1,e2,…)` +
        `（未识别的比较形态一律按红处理：\`ROW(a,b) IS DISTINCT FROM ROW(…)\` 这类写法请改成 ` +
        `\`(a,b) IS DISTINCT FROM (…)\`，否则本检查器判不出来 —— 判不出来就不放过）`,
    );
    return problems;
  }
  const norm = (a) => [...new Set(a)].sort().join(",");
  const want = norm(setCols);
  if (!rows.some((r) => norm(r) === want)) {
    const got = rows.map((r) => `(${r.join(", ")})`).join(" 或 ");
    problems.push(
      `D3: 整行比较的列集合 ${got} 与 SET 列集合 (${[...new Set(setCols)].join(", ")}) 不相等 ` +
        `⇒ 有列没参与比较（顺序无关，但集合必须相同）`,
    );
  }
  return problems;
}

/**
 * 从 WHERE 里抽「整行比较」的左列表。
 * 只认**无嵌套括号**的左列表：`(coalesce(a,b), c) IS DISTINCT FROM …` 抓不到 ⇒ 直接红，
 * 这是有意的（判不出来就不要放过）。
 * @returns {string[][]} 每个元素是一组列名（已去 `表.` 限定符）
 */
function findRowComparisons(where) {
  const out = [];
  const re = /\(([^()]*)\)\s*IS\s+DISTINCT\s+FROM\s*\(/gi;
  let m;
  while ((m = re.exec(where)) !== null) {
    const cols = m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(".").pop().trim())
      .filter((s) => /^[A-Za-z_]\w*$/.test(s));
    if (cols.length >= 2) out.push(cols);
  }
  return out;
}

/**
 * ★ P4：捕获层的护栏（评审整改）。
 *
 * `STMT_RE` 以「反引号」或「文件尾」终止 —— 这只对**模板字符串**成立。
 * 若有人写成 `pool.query("UPDATE stations SET …")` 或用 `+` 拼接，捕获会一直吃到文件尾，
 * 判定对象就变成「多条语句的拼接」，D1–D3 的结论不可信。
 * ⇒ 形态异常时**直接判红**，而不是带着可疑语料继续判。
 */
const MAX_STMT_CHARS = 2000;
function captureProblems(stmt) {
  const out = [];
  if (stmt.length > MAX_STMT_CHARS) {
    out.push(`D0: 捕获长度 ${stmt.length} > ${MAX_STMT_CHARS} 字符 ⇒ 大概率是 STMT_RE 吃到了后续内容`);
  }
  if (/";|\+\s*["'`]/.test(stmt)) {
    out.push("D0: 捕获里出现双引号终止 / 字符串拼接特征 ⇒ stations 写入 SQL 必须用模板字符串");
  }
  return out;
}

/** 捕获护栏 + 判据，统一入口（主检查与 D4 过期检测共用，避免两处口径漂移） */
const violations = (stmt) => [...captureProblems(stmt), ...judge(parseStatement(stmt))];

/** 载入白名单（外部数据） */
function loadWhitelistDoc() {
  try {
    return JSON.parse(readFileSync(WHITELIST_PATH, "utf8"));
  } catch {
    return { entries: [] };
  }
}
const loadWhitelist = () => loadWhitelistDoc().entries ?? [];

/** 主检查 */
function check() {
  const files = collectFiles(DB_DIR);
  const whitelist = loadWhitelist();
  const expected = loadWhitelistDoc().expected ?? null;
  const whitelistHit = new Set();
  const reds = [];
  const whites = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");

    // 逐条抽取语句（用 exec 循环拿 index 以定位行号）
    const re = new RegExp(STMT_RE.source, "gi");
    let m;
    while ((m = re.exec(text)) !== null) {
      const raw = m[1] ?? m[2];
      if (!raw) continue;
      const stmt = raw.trim();
      if (!stmt) continue;
      const line = lineOf(text, m.index);

      const problems = violations(stmt);
      if (problems.length === 0) continue;

      // 白名单匹配：同一文件 + detect 命中
      const wl = whitelist.findIndex(
        (w, i) =>
          (w.file === rel || rel.endsWith(w.file)) &&
          (whitelistHit.has(i) ? false : new RegExp(w.detect, "i").test(stmt)),
      );
      if (wl >= 0) {
        whitelistHit.add(wl);
        whites.push({ file: rel, line, why: whitelist[wl].why, category: whitelist[wl].category });
        continue;
      }

      reds.push({ file: rel, line, stmt, problems });
    }
  }

  /**
   * D4：白名单过期检测。
   *
   * ⚠️ 这里有一个容易写错的点（本脚本第一版就写错了）：
   *   若只判「detect 能否在文件里找到」，则**抓不到"已修好仍挂白名单"** ——
   *   因为修好之后语句原文还在（只是多了 WHERE），detect 照样能匹配。
   *   而"已修好仍挂着"正是白名单僵化的主要形态。
   * ⇒ 必须分两种失效：
   *   (a) detect 找不到 ⇒ 语句被删/重写；
   *   (b) detect 能找到、但它对应的语句**现在已通过判据** ⇒ 白名单多余。
   */
  const stale = [];
  /** ★ 见文件头「文件不在本机时的行为」：未入库文件 ⇒ 跳过，不计红不计过期 */
  const missing = [];
  const relOf = (f) => relative(REPO_ROOT, f).replace(/\\/g, "/");
  whitelist.forEach((w, i) => {
    if (whitelistHit.has(i)) return; // 被使用过 ⇒ 仍然有效
    const target = files.find((f) => relOf(f) === w.file || relOf(f).endsWith(w.file));
    if (!target) {
      missing.push({ ...w, missingWhy: "文件不在本机（未入库 / 未同步），跳过" });
      return;
    }
    const text = readFileSync(target, "utf8");
    const detRe = new RegExp(w.detect, "i");
    if (!detRe.test(text)) {
      stale.push({ ...w, staleWhy: "该条目已找不到对应语句，请移除" });
      return;
    }
    // detect 还在 —— 看它对应的语句现在是否已经合规（合规 ⇒ 白名单多余）
    let found = false;
    let anyViolation = false;
    const stmtRe = new RegExp(STMT_RE.source, "gi");
    let mm;
    while ((mm = stmtRe.exec(text)) !== null) {
      const raw = (mm[1] ?? mm[2] ?? "").trim();
      if (!raw || !detRe.test(raw)) continue;
      found = true;
      if (violations(raw).length > 0) {
        anyViolation = true;
        break;
      }
    }
    if (found && !anyViolation) {
      stale.push({ ...w, staleWhy: "该路径已修好（语句已通过判据），白名单多余 ⇒ 请移除" });
    }
  });

  return { reds, whites, stale, missing, whitelist, expected };
}

function report({ reds, whites, stale, missing = [], expected = null }) {
  console.log("════════ stations 写入规约检查 ════════\n");

  if (reds.length) {
    console.log(`❌ 红 ${reds.length} 条：\n`);
    reds.forEach((r, i) => {
      console.log(`  [${i + 1}] ${r.file}:${r.line}`);
      console.log(`      ${flat(r.stmt).slice(0, 160)}${flat(r.stmt).length > 160 ? "…" : ""}`);
      r.problems.forEach((p) => console.log(`      ↳ ${p}`));
      console.log("");
    });
  } else {
    console.log("✅ 红 0 条（全部写入路径都带「值变化才写」的条件）\n");
  }

  if (whites.length) {
    console.log(`⚪ 白名单 ${whites.length} 条：`);
    const byCat = new Map();
    for (const w of whites) {
      const k = w.category ?? "未分类";
      if (!byCat.has(k)) byCat.set(k, []);
      byCat.get(k).push(w);
    }
    for (const [cat, list] of byCat) {
      console.log(`   ▸ ${cat}（${list.length}）`);
      for (const w of list) console.log(`       ${w.file}:${w.line} — ${w.why}`);
    }
    console.log("");
  } else {
    // ★ 2026-11-20 负责人定的通用规则：诊断输出不许「沉默即正常」——为 0 也要打印结论。
    console.log("✓ 白名单 0 条（没有豁免路径）\n");
  }

  if (stale.length) {
    console.log(`⚠️ 白名单过期 ${stale.length} 条：`);
    for (const w of stale) {
      console.log(`       ${w.file} — ${w.staleWhy ?? "已失效，请移除"}`);
      console.log(`         detect=/${w.detect}/`);
    }
    console.log("");
  } else {
    console.log("✓ 白名单过期 0 条（没有「已修好仍挂着」的僵化条目）\n");
  }

  if (missing.length) {
    console.log(`○ 跳过 ${missing.length} 条（文件不在本机，未入库 / 未同步）：`);
    for (const w of missing) console.log(`       ${w.file} — ${w.why}`);
    console.log("");
  } else {
    console.log("✓ 跳过 0 条（所有受管制文件都在本机）\n");
  }

  /**
   * ★ P5：`expected` 只作**提示**，不参与退出码。
   * 理由：一旦「数字不符即失败」，下一个人就会去改白名单里的数字把它调绿 ——
   * 那正是我们最怕的假绿形态。真正的门禁是 D1–D4 本身，不是计数。
   */
  if (expected) {
    const same = expected.red === reds.length && expected.white === whites.length;
    console.log(
      `基线提示：白名单声明 红 ${expected.red} / 白 ${expected.white} ⇒ 本次 红 ${reds.length} / 白 ${whites.length}` +
        `${same ? "（一致）" : "（不一致，仅提示，不判失败）"}`,
    );
    if (expected.note) console.log(`          ${expected.note}`);
    console.log("");
  }

  console.log(`────── 统计：红 ${reds.length} / 白 ${whites.length}${stale.length ? ` / 过期 ${stale.length}` : ""}${missing.length ? ` / 跳过 ${missing.length}` : ""} ──────`);
  return reds.length === 0 && stale.length === 0;
}

/* ══ 变异自检：4 条判据各配一条「必须报红」的样例 ══ */
/**
 * ⚠️ 这些用例里有几条断言的是**提示语子串**（`/D3.*未识别/` 等）。
 *   这意味着文案是契约的一部分：改措辞的人必须同时改断言，否则自检会红。
 *   为什么保留这种耦合：只断言「红了」测不出「红的原因对不对」——
 *   一个报错原因写错的检查器，比不检查更费人（人会先去怀疑工具）。
 *   若将来嫌改文案成本高，把 `未识别` 抽成常量 token 同时供两边使用即可（属加法，不急）。
 */
function selftest() {
  const cases = [
    {
      id: "D1 无 WHERE",
      sql: "UPDATE stations SET name_tc = $1 WHERE code = $2",
      expect: /D1/,
    },
    {
      id: "D1 WHERE 无 IS DISTINCT FROM",
      sql: "UPDATE stations SET name_tc = $1 WHERE code = $2 AND name_tc <> $1",
      expect: /D1/,
    },
    {
      id: "D2 漏列（两列 SET 只判一列）",
      sql: "UPDATE stations SET lat = $1, lng = $2 WHERE code = $3 AND lat IS DISTINCT FROM $1",
      expect: /D2|D3/,
    },
    {
      id: "D3 AND 分列（单列变化会被静默跳过）",
      sql:
        "UPDATE stations SET lat = $1, lng = $2 WHERE code = $3 " +
        "AND lat IS DISTINCT FROM $1 AND lng IS DISTINCT FROM $2",
      expect: /D3/,
    },
    {
      id: "正向对照：整行比较（必须通过）",
      sql: "UPDATE stations SET lat = $1, lng = $2 WHERE code = $3 AND (lat, lng) IS DISTINCT FROM ($1, $2)",
      expect: null,
    },
    {
      id: "正向对照：单列 OR（必须通过）",
      sql:
        "INSERT INTO stations (code, name_tc, kind, dsat_synced) VALUES ($1,$2,'bus',true) " +
        "ON CONFLICT (code) DO UPDATE SET name_tc = EXCLUDED.name_tc " +
        "WHERE stations.name_tc IS DISTINCT FROM EXCLUDED.name_tc",
      expect: null,
    },
    /* ── P2 整改：D2 不再有 40 字符窗口 ── */
    {
      id: "P2 正向：长列名单列比较（旧写法会假红）",
      sql: "UPDATE stations SET last_synced_at = $1 WHERE code = $2 AND last_synced_at IS DISTINCT FROM $1",
      expect: null,
    },
    {
      id: "P2 反向：单列 SET 但只判了别的列",
      sql: "UPDATE stations SET last_synced_at = $1 WHERE code = $2 AND dsat_synced IS DISTINCT FROM $1",
      expect: /D2/,
    },
    /* ── P3 整改：D3 判集合相等，不判形状 ── */
    {
      id: "P3 反向：整行比较漏列（extra 未参与）",
      sql:
        "UPDATE stations SET lat = $1, lng = $2, extra = $3 WHERE code = $4 " +
        "AND (lat, lng) IS DISTINCT FROM ($1, $2)",
      expect: /D3.*不相等/,
    },
    {
      id: "P3 正向：SET 列顺序与整行比较相反（必须通过）",
      sql: "UPDATE stations SET lng = $2, lat = $1 WHERE code = $3 AND (lat, lng) IS DISTINCT FROM ($1, $2)",
      expect: null,
    },
    {
      id: "P3 正向：带表限定符的整行比较（必须通过）",
      sql:
        "INSERT INTO stations (code, name_tc, dsat_synced) VALUES ($1,$2,true) " +
        "ON CONFLICT (code) DO UPDATE SET name_tc = EXCLUDED.name_tc, dsat_synced = true " +
        "WHERE (stations.name_tc, stations.dsat_synced) IS DISTINCT FROM (EXCLUDED.name_tc, EXCLUDED.dsat_synced)",
      expect: null,
    },
    /* ── 默认拒绝：未识别的比较形态一律红（不接受「先绿再发现」）── */
    {
      id: "默认拒绝：ROW(a,b) 形态（未识别，必须红）",
      sql:
        "UPDATE stations SET lat = $1, lng = $2 WHERE code = $3 " +
        "AND ROW(lat, lng) IS DISTINCT FROM ROW($1, $2)",
      expect: /D3.*未识别/,
    },
    {
      id: "默认拒绝：单列用函数包裹（coalesce，未识别，必须红）",
      sql:
        "UPDATE stations SET lat = $1 WHERE code = $2 " +
        "AND coalesce(lat, 0) IS DISTINCT FROM coalesce($1, 0)",
      expect: /D2.*未识别/,
    },
    {
      /**
       * 第三形态（前端 2026-11-20 提供）：`NOT (a IS NOT DISTINCT FROM b)` 是「双重否定 = distinct」，
       * 语义等价但**不含** `IS DISTINCT FROM` 这个子串（含的是 `IS NOT DISTINCT FROM`）。
       * ⇒ D1 看不见、D2/D3 都抓不到 ⇒ 落到「未识别 ⇒ 红」。
       * 加这条不是为了测一个"会红的写法"，而是为了证明**默认拒绝是策略而不是针对 ROW 的补丁**：
       * 换任何新形态都不会变成绿。
       */
      id: "默认拒绝：NOT (a IS NOT DISTINCT FROM b)（第三形态，必须红）",
      sql: "UPDATE stations SET lat = $1 WHERE code = $2 AND NOT (lat IS NOT DISTINCT FROM $1)",
      expect: /D2.*未识别/,
    },
  ];

  /* ── P4 整改：捕获层护栏（不走 parser，直接喂异常语料）── */
  const captureCases = [
    {
      id: "P4 反向：捕获里出现双引号终止 / 拼接",
      stmt: 'UPDATE stations SET name_tc = $1 WHERE code = $2 AND name_tc IS DISTINCT FROM $1"); + "x',
      expect: /D0/,
    },
    {
      id: "P4 反向：捕获超长（吃到后续内容）",
      stmt: "UPDATE stations SET name_tc = $1 WHERE code = $2 AND name_tc IS DISTINCT FROM $1 " + "--".padEnd(3000, "x"),
      expect: /D0/,
    },
    {
      id: "P4 正向：正常模板字符串语句",
      stmt: "UPDATE stations SET name_tc = $1 WHERE code = $2 AND name_tc IS DISTINCT FROM $1",
      expect: null,
    },
  ];

  let pass = 0;
  const total = cases.length + captureCases.length;
  for (const c of cases) {
    const problems = violations(c.sql);
    const gotRed = problems.length > 0;
    const wantRed = c.expect !== null;
    const ok = gotRed === wantRed && (!wantRed || c.expect.test(problems.join(" ")));
    console.log(`${ok ? "✅" : "❌"} ${c.id} → ${gotRed ? "红" : "绿"}${ok ? "" : "  ← 不符合预期"}`);
    if (!ok) problems.forEach((p) => console.log(`      ${p}`));
    if (ok) pass++;
  }
  for (const c of captureCases) {
    const problems = violations(c.stmt);
    const gotRed = problems.length > 0;
    const wantRed = c.expect !== null;
    const ok = gotRed === wantRed && (!wantRed || c.expect.test(problems.join(" ")));
    console.log(`${ok ? "✅" : "❌"} ${c.id} → ${gotRed ? "红" : "绿"}${ok ? "" : "  ← 不符合预期"}`);
    if (!ok) problems.forEach((p) => console.log(`      ${p}`));
    if (ok) pass++;
  }
  console.log(`\n变异自检：${pass}/${total} 通过`);
  return pass === total;
}

if (process.argv.includes("--selftest")) {
  process.exit(selftest() ? 0 : 1);
} else {
  process.exit(report(check()) ? 0 : 1);
}
