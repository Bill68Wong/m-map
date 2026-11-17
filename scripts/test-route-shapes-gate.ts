/**
 * route_shapes 换源验收门禁（`scripts/test-route-shapes-gate.ts`，2026-11-17 新建）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   把 `route_shapes` 的折线从「高德/自建几何」换成「官方 ROUTE_NETWORK 几何」是一次
 *   全量数据替换：108 行会被覆盖，9 行因无官方源保持原样。这种批量替换最危险的失败方式
 *   不是「报错」，而是**静默变差**：几何少画一段、站线错位、只更新了一半的表。
 *   本门禁把「换源计划本身」和「数据库现实」分成两层分别断言：
 *     · 计划层（A/B 组）：只读 `.verify/route-shapes-baseline.csv`，不连库 —— 决定"这版计划能不能落"。
 *     · 现实层（C 组）：连库对账 —— 决定"落下去之后是不是真的对了"。库不可达则**明确跳过**（不算通过）。
 *
 * ── 判据来源与口径（三方交叉过，不要自己另立一套）────────────────────────
 *   `gate_ok` 的定义经本文件 A4 判据**反向验证**：全 117 行 × 前后两侧，
 *   `gate_ok == (len >= seglinesum ? 1 : 0)` **零例外**（EPS 实为 0）。
 *   也就是说本文件不是"又实现了一遍几何算法"，而是**用基线的定义去校验基线自身与数据库**，
 *   避免出现第二套口径（那正是三方明确警告过的坑）。
 *
 *   ⚠️ 为什么不去数据库里自己重算 `seglinesum`：站坐标有两个源
 *   （`station_amap_map` 主源 / `stations` 兜底），且当前主源只覆盖部分站点
 *   （实测 route 1/0 仅 10/17 站有坐标）。自己重算必然得到偏小的 Σ直，
 *   与基线差一大截 ⇒ 会造出第二套口径。**基线是唯一真源。**
 *
 * ── ratchet 的正确方向（这条最容易写反）──────────────────────────────────
 *   ❌ 错：`valid 覆盖率不得低于 94.1%` —— 把缺陷态锁成下限，缺陷永远修不掉。
 *   ❌ 错：`全库 gate_ok 不得出现 0`  —— 石排湾 2 行源里就没有，PR 永久红。
 *   ✅ 对：两条并列 ——
 *        ① 新数据全绿：参与换源的 108 行 `gate_ok_after` 必须全为 1。
 *        ② 存量不许新增：`gate_ok_before = 0` 的**集合**必须恰好是那 3 个
 *           `(route_code, dsat_dir)`，**断言集合相等，不是计数相等**
 *           （写 `count(*) == 3` 会让"换出另外 3 个 0"也算通过）。
 *   一句话：**它保护的是「不退化」，不是「保护现状」—— 现状里包含缺陷。**
 *
 * ── 作用域（scope）说明 ───────────────────────────────────────────────────
 *   硬门禁只对**本次被写入的行**（108）生效；未参与换源的 9 行只能断言「没被碰过」
 *   （`after` 三列为空 + 数据库里 polyline 哈希不变），不能拿新标准去要求它们。
 *   第 9 行是 `36/0`：它在基线里 `points_before` 与 `after` 全为空（无站序数据），
 *   属**数据缺口**而非换源失败 —— 本文件把它列为 INFO，不判红。
 *
 * ── 边界（明确守不住什么）────────────────────────────────────────────────
 *   · ①' 违反只证明「几何与站序互不自洽」，**分不出是哪一侧错**（几何缺段 / 站序错 / 两者都错）。
 *     所以报错文案写的是「不自洽，需对拍官方数据归因」，不是「几何错误」——
 *     否则下一个人会去改站序，改反方向。
 *   · 不做里程单调性断言：实测 `len_official / len_now` 中位 0.994，**有涨有跌**
 *     （37/0 −5.4%、MT2/0 +65%），写「不得减少」会在约一半线路上假红。
 *   · 不把 80m/120m 单阈值当门禁：实测换源前有 9 行超阈值（其中 7 行巴士本来在线工作），
 *     拿它当门禁会误杀；本文件只把它降为**告警**。
 *   · 计划层依赖 `.verify/route-shapes-baseline.csv`；该目录被 gitignore，
 *     CI/干净克隆里没有 ⇒ 计划层**跳过并明示**（不算通过）。
 *   · 不可变断言（C5）依赖迁移前快照 `.verify/route-shapes-polyline-sha256.json`，
 *     同属本地产物；缺失时跳过并明示。它是**迁移窗口**的护栏，不是永久不变量。
 *
 * ── 防假绿 ────────────────────────────────────────────────────────────────
 *   · 跳过单独计数（`skip`），绝不计入 `pass` —— 沿用 `test-route-overview.ts` 的约定。
 *   · 库不可达 ⇒ 全部 C 组判为 skip，并在结尾显式提示「现实层未验证」。
 *   · 表头必须逐字匹配（A1）：基线若被改名/加列，立刻红，不允许"碰巧还能跑"。
 *   · C7 要求「要么全没换源，要么 108 行全换」，拦住**半途而废的迁移**。
 *
 * 跑法：`npm run test:route-shapes-gate`
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * 基线路径可被 `ROUTE_SHAPES_BASELINE` 覆盖。
 * 用途有二：① 红测（把基线复制一份、故意改坏，验证判据真的会红，而不必动真文件）；
 * ② 对比两个候选版本的基线（例如「换源前计划」vs「换源后实测」）。
 * 默认仍读 `.verify/route-shapes-baseline.csv`，正常跑不受影响。
 */
const CSV_PATH = process.env.ROUTE_SHAPES_BASELINE
  ? path.resolve(process.env.ROUTE_SHAPES_BASELINE)
  : path.join(ROOT, ".verify", "route-shapes-baseline.csv");
const HASH_PATH = path.join(ROOT, ".verify", "route-shapes-polyline-sha256.json");

/**
 * 基线**必需列**（按名读取，不钉列顺序、不钉列数）。
 *
 * 为什么不逐字钉死表头：这份 CSV 是分析产物，列会随分析口径增删（实测 15↔16 列来回变过两次，
 * 中途还出现过 `has_official`）。**门禁该守的是「列的语义没变」，不是「分析师不许加列」。**
 * 所以：必需列缺一列或改一名 ⇒ 红（A1）；多出来的列 ⇒ 只打 INFO。
 * 而「列的含义被悄悄改了」由 A4（gate_ok 口径自证）兜住，那比钉表头更本质。
 */
const REQUIRED_COLUMNS = [
  "route_code",
  "dsat_dir",
  "is_lrt",
  "stations",
  "points_before",
  "len_before_m",
  "seglinesum_m",
  "maxdev_before_m",
  "gate_ok_before",
  "points_after",
  "len_after_m",
  "maxdev_after_m",
  "gate_ok_after",
];
/** 可选列：显式标注「是否拿到官方几何」。有就用它判定作用域，没有就从 len_after_m 推。 */
const OPTIONAL_COLUMN_HAS_OFFICIAL = "has_official";
/**
 * 「无数据」记号。**定稿只认 `NA`**（`data-engineer` 2026-11-17 21:00 定稿，SHA-256 `50aa6545…`）。
 * 其余写法（空串 / `-` / `null`）只在基线演进过程中短暂出现过，保留兼容但**不再视为约定**；
 * 见到它们不算错，但也不该再新增。
 *
 * ⚠️ 注意 `0` **不在**此表里，这是刻意的：`gate_ok_after = 0` 表示「仍在违反」，
 * 把它当归零会让 ratchet 失去全部意义（详见 isNA 的注释）。
 */
const BLANK_TOKENS = new Set(["", "-", "—", "NA", "N/A", "na", "null", "NULL"]);

/** 换源前 `gate_ok = 0` 的冻结集合（集合相等，不是计数相等） */
const FROZEN_ZERO_BEFORE = ["LRT-石排湾线/0", "LRT-石排湾线/1", "MT2/0"];
/**
 * 换源后仍应为 0 的集合：石排湾两行无官方源保持原样；
 * `MT2/0` 换源后应转 1（官方几何补上了缺失的机场环）。
 */
const FROZEN_ZERO_AFTER = ["LRT-石排湾线/0", "LRT-石排湾线/1"];
/** 不参与换源的行（无官方几何）。第 9 行 `36/0` 无站序数据，属数据缺口。 */
const UNTOUCHED = [
  "15T/0",
  "17T/0",
  "36/0",
  "LRT-氹仔线/0",
  "LRT-氹仔线/1",
  "LRT-横琴线/0",
  "LRT-横琴线/1",
  "LRT-石排湾线/0",
  "LRT-石排湾线/1",
];
/** 数据缺口行：站序侧指标缺失（`stations=0`），无法参与 ①' 判定 —— 只做 INFO，不判红 */
const DATA_GAP = new Set(["36/0"]);

/** 澳门范围盒（实测 lng 113.534–113.595 / lat 22.110–22.213，此处留余量） */
const MACAU_BOX = { minLng: 113.4, maxLng: 113.7, minLat: 22.0, maxLat: 22.3 };
/** 换源后站-线偏离告警阈值（米）：巴士 80 / 轻轨 120 —— 只告警不阻断 */
const DEV_WARN = { bus: 80, lrt: 120 };
/** 几何比里程最多允许超前多久（分钟）——「只更新了一半」的判据 */
const FRESH_MIN = 10;

let pass = 0;
let fail = 0;
let skip = 0;
const registered: string[] = [];

function ok(id: string, label: string, cond: boolean, detail = ""): void {
  registered.push(id);
  if (cond) {
    pass++;
    console.log(`  PASS  ${id}  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${id}  ${label}${detail ? `  →  ${detail}` : ""}`);
  }
}

function skipped(id: string, label: string, reason: string): void {
  registered.push(id);
  skip++;
  console.log(`  SKIP  ${id}  ${label}  （${reason}，**不计入通过**）`);
}

function info(msg: string): void {
  console.log(`  INFO  ${msg}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 基线解析
 * ════════════════════════════════════════════════════════════════════════ */
interface Row {
  key: string;
  route_code: string;
  dsat_dir: string;
  is_lrt: number;
  /** 该行是否拿到了官方几何（参与换源）。有 has_official 列就用它，否则按 after 是否有值推。 */
  hasOfficial: boolean;
  raw: Record<string, string>;
  n: (col: string) => number | null;
}

function loadBaseline(): { rows: Row[]; header: string[] } | null {
  if (!existsSync(CSV_PATH)) return null;
  const text = readFileSync(CSV_PATH, "utf8").trim();
  const lines = text.split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") continue;
    const cells = line.split(",");
    const raw: Record<string, string> = {};
    header.forEach((h, i) => {
      const v = (cells[i] ?? "").trim();
      raw[h] = BLANK_TOKENS.has(v) ? "" : v;
    });
    const n = (col: string): number | null => {
      const v = raw[col];
      if (v === undefined || v === "") return null;
      const x = Number(v);
      return Number.isFinite(x) ? x : NaN;
    };
    rows.push({
      key: `${raw.route_code}/${raw.dsat_dir}`,
      route_code: raw.route_code,
      dsat_dir: raw.dsat_dir,
      is_lrt: Number(raw.is_lrt) === 1 ? 1 : 0,
      hasOfficial:
        raw[OPTIONAL_COLUMN_HAS_OFFICIAL] !== undefined
          ? Number(raw[OPTIONAL_COLUMN_HAS_OFFICIAL]) === 1
          : !isNA(raw.len_after_m),
      raw,
      n,
    });
  }
  return { rows, header };
}

const sortedKeys = (a: string[]): string[] => [...a].sort();
const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && sortedKeys(a).every((x, i) => x === sortedKeys(b)[i]);
/**
 * 「无数据」的判定。基线定稿只用 `NA` 一个记号（实测曾短暂出现过空串 / `0` / `-`，
 * 那是写入中途的半成品，不是约定）。
 *
 * ⚠️⚠️ **绝不能把 `0` 也算作空。** 这条被 architect 点出来过，且是本文件里最危险的一处：
 *   `gate_ok_after = 0` 的含义是「该行换源后仍在违反」——ratchet 的全部价值就在抓它。
 *   一旦 `isNA(0)` 为真，这个违反值会被当成「无数据」而从违反集合里消失 ⇒ ratchet 永久抓不到
 *   新增违反，且**永远不会红**。假阴性比假红危险得多。
 *   （最初版本写的是 `v.trim() === "" || Number(v) === 0`，已删除后半句。）
 */
const isNA = (v?: string): boolean =>
  v === undefined || v.trim() === "" || v.trim().toUpperCase() === "NA";

/* ══════════════════════════════════════════════════════════════════════════
 * 数据库
 * ════════════════════════════════════════════════════════════════════════ */
interface DbRow {
  route_code: string;
  dsat_dir: string;
  polyline: string;
  points: number;
  start_stop: string | null;
  end_stop: string | null;
  fetched_at: Date | null;
}

async function openPool(): Promise<Pool | null> {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    /* .env 不存在 ⇒ 下面连接失败会走 skip */
  }
  const conn = process.env.DATABASE_URL;
  if (!conn) return null;
  const pool = new Pool({ connectionString: conn, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try {
    await pool.query("SELECT 1");
    return pool;
  } catch {
    await pool.end().catch(() => undefined);
    return null;
  }
}

async function main(): Promise<void> {
  console.log("\n═══ route_shapes 换源验收门禁（计划层 + 现实层）═══\n");

  const base = loadBaseline();

  /* ── A 组：基线文件完整性（纯 CSV）──────────────────────────────────── */
  console.log("  ── A 组：基线文件完整性 ──");
  if (base === null) {
    for (const id of ["A1", "A2", "A3", "A4"]) {
      skipped(id, "计划层断言", "未找到 .verify/route-shapes-baseline.csv（该目录被 gitignore，本机未随附）");
    }
    skipped("B1–B5", "换源计划 ratchet", "同上");
  } else {
    const { rows, header } = base;

    const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
    const dupCols = header.filter((h, i) => header.indexOf(h) !== i);
    const extra = header.filter((h) => !REQUIRED_COLUMNS.includes(h) && h !== OPTIONAL_COLUMN_HAS_OFFICIAL);
    ok(
      "A1",
      `基线必需列必须齐全且不重名（列顺序/多余列不限制，只守语义）`,
      missing.length === 0 && dupCols.length === 0,
      `缺列 {${missing.join(", ") || "无"}}；重名 {${[...new Set(dupCols)].join(", ") || "无"}}；实际 ${header.length} 列`,
    );
    if (extra.length > 0) info(`基线含非必需列（忽略，不影响判据）：${extra.join(", ")}`);
    info(
      `作用域判定依据：${header.includes(OPTIONAL_COLUMN_HAS_OFFICIAL) ? "has_official 列（显式）" : "len_after_m 是否为空（推得）"}`,
    );

    const keys = rows.map((r) => r.key);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    ok(
      "A2",
      "行数与主键唯一性（117 行、(route_code, dsat_dir) 不得重复）",
      rows.length === 117 && dup.length === 0,
      `行数 ${rows.length}，重复键 ${[...new Set(dup)].join(" / ") || "（无）"}`,
    );

    const nanRows = rows.filter((r) =>
      Object.entries(r.raw).some(([k, v]) => !["route_code", "dsat_dir"].includes(k) && v !== "" && Number.isNaN(Number(v))),
    );
    ok(
      "A3",
      "数值列不得出现 NaN / Infinity（空值允许，空 = 无此侧数据）",
      nanRows.length === 0,
      `异常行：${nanRows.map((r) => r.key).join(" / ")}`,
    );

    /*
     * A4 是整套判据的**口径自证**：用基线的定义去校验基线自身。
     * 若这条红了，说明 `gate_ok` 不再等于 `len >= seglinesum`，
     * 那么下面所有基于 gate_ok 的 ratchet 都在用一套来路不明的数字。
     */
    const bad = rows.filter((r) => {
      const seg = r.n("seglinesum_m");
      for (const side of ["before", "after"] as const) {
        const flag = r.n(`gate_ok_${side}`);
        const len = r.n(`len_${side}_m`);
        if (flag === null || len === null || seg === null) continue;
        if ((len >= seg ? 1 : 0) !== flag) return true;
      }
      return false;
    });
    ok(
      "A4",
      "口径自证：gate_ok 必须能由 (len >= seglinesum) 复现，全行零例外",
      bad.length === 0,
      `不一致 ${bad.length} 行：${bad.slice(0, 5).map((r) => r.key).join(" / ")}`,
    );

    /* ── B 组：换源计划 ratchet ────────────────────────────────────────── */
    console.log("\n  ── B 组：换源计划 ratchet（方向：不退化，不是保护现状）──");

    const zeroBefore = rows.filter((r) => r.n("gate_ok_before") === 0).map((r) => r.key);
    ok(
      "B1",
      "换源前 gate_ok=0 的**集合**必须恰好是那 3 对（集合相等，不是计数相等）",
      sameSet(zeroBefore, FROZEN_ZERO_BEFORE),
      `实际 {${sortedKeys(zeroBefore).join(", ")}}，期望 {${sortedKeys(FROZEN_ZERO_BEFORE).join(", ")}}`,
    );

    const swapped = rows.filter((r) => r.hasOfficial);
    ok(
      "B2",
      "参与换源的行数必须为 108（与 117 − 9 未换源一致）",
      swapped.length === 108,
      `实际 ${swapped.length}`,
    );

    const notGreen = swapped.filter((r) => r.n("gate_ok_after") !== 1);
    ok(
      "B3",
      "① 新数据全绿：参与换源的每一行 gate_ok_after 必须为 1",
      notGreen.length === 0,
      `未达标 ${notGreen.length} 行：${notGreen.slice(0, 6).map((r) => r.key).join(" / ")}`,
    );

    /*
     * ② 换源后的全库 0 集合 = 未换源行的 before 值 + 已换源行的 after 值。
     * 未换源行的 after 列为空（本来就没写），所以用它自己的 before 顶上。
     */
    /*
     * ⚠️ B4 断言的是**换源后的终态模型**，不是"再读一遍 `gate_ok_after` 列"。
     *
     * 模型：未参与换源的行（`has_official=0`）几何不动（这一点由 C5 的 SHA-256 逐字节断言保证），
     * 站序也不可能变 ⇒ 它们的 `gate_ok` 必然沿用 `gate_ok_before`。所以终态里"仍为 0"的集合
     * =（已换源行的 `gate_ok_after` 为 0 的）∪（未换源行的 `gate_ok_before` 为 0 的）。
     *
     * 为什么不直接取 `gate_ok_after` 列：那 9 行该列是 `NA`（不适用），直接取会得到空集，
     * 于是"石排湾两行仍在违反"这个**真实存在的存量缺陷**会从集合里消失 —— 那是假绿。
     * `data-engineer` 建议的「`gate_ok_after = 0` 的集合 = ∅」是另一个（更弱的）命题：
     * 它只证明"换源行都 OK"，而那件事 B3 已经单独断言了。
     */
    const effectiveAfterZero = rows
      .filter((r) => {
        const after = r.hasOfficial ? r.n("gate_ok_after") : r.n("gate_ok_before");
        return after === 0;
      })
      .map((r) => r.key);
    ok(
      "B4",
      "② 存量不许新增：换源后终态 gate_ok=0 的集合必须恰好是石排湾那 2 对（模型：未换源行沿用 before；该模型由 C2/C3/C5 三联断言支撑，三者任一放宽则本判据须改为直读列）",
      sameSet(effectiveAfterZero, FROZEN_ZERO_AFTER),
      `实际 {${sortedKeys(effectiveAfterZero).join(", ")}}，期望 {${sortedKeys(FROZEN_ZERO_AFTER).join(", ")}}`,
    );

    const untouchedActual = rows.filter((r) => !r.hasOfficial).map((r) => r.key);
    ok(
      "B5",
      "未参与换源的行集合必须恰好是那 9 对（防止计划里悄悄多/少一条线）",
      sameSet(untouchedActual, UNTOUCHED),
      `实际 {${sortedKeys(untouchedActual).join(", ")}}`,
    );

    /*
     * B6：未参与换源的行，**after 侧所有列都必须是 NA**（不只是点数/长度/偏离）。
     *
     * 特别要覆盖 `gate_ok_after`：如果某行本该是 `NA` 却写成 `0`，那是一个"仍在违反"的信号。
     * 若判据只查前几列、或把 `0` 当空（旧 `isBlank` 的写法），这个信号就会被吞掉 ——
     * 那是**假阴性**：ratchet 永远抓不到它。这条同时也是 `isNA(0) === false` 的守卫。
     */
    const AFTER_COLUMNS = ["points_after", "len_after_m", "seglinesum_after_m", "maxdev_after_m", "gate_ok_after", "ratio_after"];
    const untouchedTouched = rows.filter(
      (r) => !r.hasOfficial && AFTER_COLUMNS.some((c) => !isNA(r.raw[c])),
    );
    ok(
      "B6",
      "未参与换源的行，其 after 六列必须全为 NA（含 gate_ok_after —— 0 会被当成违反信号）",
      untouchedTouched.length === 0,
      `被改写：${untouchedTouched.map((r) => r.key).join(" / ")}`,
    );

    /* ── B' 组：告警（不阻断）────────────────────────────────────────── */
    const devWarn = swapped.filter((r) => {
      const d = r.n("maxdev_after_m");
      return d !== null && d > (r.is_lrt === 1 ? DEV_WARN.lrt : DEV_WARN.bus);
    });
    const shrink = swapped.filter((r) => {
      const a = r.n("points_after");
      const b = r.n("points_before");
      return a !== null && b !== null && b > 0 && a < b * 0.5;
    });
    console.log("");
    info(`告警（不阻断）：站-线偏离超阈值 ${devWarn.length} 行` +
      (devWarn.length ? ` —— ${devWarn.slice(0, 5).map((r) => `${r.key}(${r.raw.maxdev_after_m}m)`).join("、")}` : ""));
    info(`告警（不阻断）：换源后顶点数 < 原值 50% ${shrink.length} 行` +
      (shrink.length ? ` —— ${shrink.slice(0, 5).map((r) => r.key).join("、")}` : ""));
    const gap = rows.filter((r) => DATA_GAP.has(r.key));
    if (gap.length) {
      info(
        `数据缺口（不判红）：${gap.map((r) => r.key).join(" / ")} —— ` +
          `站序侧指标为 NA（stations=0，0 站算不出 Σ相邻站直线），几何侧仍有值；` +
          `它是停运线路（routes.is_active=false）的残留几何行，无官方源，108/9 不受影响`,
      );
    }
  }

  /* ── C 组：数据库现实层 ─────────────────────────────────────────────── */
  console.log("\n  ── C 组：数据库对账（现实层）──");
  const pool = await openPool();
  if (pool === null) {
    for (const id of ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]) {
      skipped(id, "现实层断言", "数据库不可达或未配置 DATABASE_URL");
    }
    info("**现实层未验证** —— 这不等于通过。换了机器/没配库时请手动补跑。");
  } else {
    try {
      const db = (
        await pool.query<DbRow>(
          "SELECT route_code, dsat_dir, polyline, points, start_stop, end_stop, fetched_at FROM route_shapes",
        )
      ).rows;
      const dbMap = new Map(db.map((r) => [`${r.route_code}/${r.dsat_dir}`, r]));

      ok(
        "C1",
        "数据库行数与键集必须与基线完全一致（117 行，不多不少）",
        db.length === 117 && base !== null && sameSet([...dbMap.keys()], base.rows.map((r) => r.key)),
        `库内 ${db.length} 行；差集：${base === null ? "无基线" : [
          ...[...dbMap.keys()].filter((k) => !base.rows.some((r) => r.key === k)),
          ...base.rows.filter((r) => !dbMap.has(r.key)).map((r) => r.key),
        ].join(" / ") || "（无）"}`,
      );

      /* C2：每行必须是「换源前」或「换源后」之一 —— 这条同时能判出迁移是否已落地 */
      const offSpec: string[] = [];
      const swappedInDb: string[] = [];
      if (base !== null) {
        for (const r of base.rows) {
          const d = dbMap.get(r.key);
          if (!d) continue;
          const before = r.n("points_before");
          const after = r.n("points_after");
          if (before !== null && d.points === before) continue;
          if (after !== null && d.points === after) {
            swappedInDb.push(r.key);
            continue;
          }
          if (DATA_GAP.has(r.key)) continue; // 36/0 基线无数，跳过点数比对
          offSpec.push(`${r.key} 库=${d.points} 计划前=${before ?? "空"} 计划后=${after ?? "空"}`);
        }
      }
      ok(
        "C2",
        "每行数据库点数必须精确等于「换源前」或「换源后」之一（半新半旧即红）",
        base !== null && offSpec.length === 0,
        `不符 ${offSpec.length} 行：${offSpec.slice(0, 6).join("；")}`,
      );

      /*
       * C3：`start_stop` / `end_stop` 必须**与换源前逐行相同，且非空**。
       *
       * 为什么不要求「从官方数据回填」：官方 ROUTE_NETWORK **没有**这两个字段；
       * 而且我方站名是**简体**（`城市日大马路/波尔图街`）、官方与 `stations.name_tc` 是**繁体**
       * （`城市日大馬路/波爾圖街`）—— 若真去回填，会造成同列简繁混排。
       * 正确做法是：换源脚本用**定向 UPDATE**（只 SET polyline/points），或用整行 upsert 时
       * 把库里现有两列原样带上。两种实现都能过本判据，但都能被「变成 null」抓住。
       *
       * 为什么这两个字段一字不能动：`isLoop` 有两个分支（首尾同名 / 几何首尾距 ≤25m）。
       * 实测 `26/0` 首末距 98.6m、`AP1/0` 只有 23.1m（离 25m 门只剩 1.9m）、`MT2/0` 102.8m
       * 且首末不同名 ⇒ 站名一变，环线判定可能翻转。
       */
      const stopDrift: string[] = [];
      let stopChecked = 0;
      if (existsSync(HASH_PATH)) {
        const snap = JSON.parse(readFileSync(HASH_PATH, "utf8")) as Record<
          string,
          { start_stop?: string | null; end_stop?: string | null }
        >;
        for (const r of db) {
          const k = `${r.route_code}/${r.dsat_dir}`;
          const s = snap[k];
          if (!s || s.start_stop === undefined) continue;
          stopChecked++;
          if (r.start_stop !== s.start_stop || r.end_stop !== s.end_stop) {
            stopDrift.push(`${k}：${s.start_stop ?? "空"}/${s.end_stop ?? "空"} → ${r.start_stop ?? "空"}/${r.end_stop ?? "空"}`);
          }
        }
      }
      const noStop = db.filter((r) => !r.start_stop || !r.end_stop);
      ok(
        "C3",
        stopChecked > 0
          ? `start_stop / end_stop 必须非空，且与换源前逐行相同（已比对 ${stopChecked} 行）`
          : "start_stop / end_stop 必须非空",
        noStop.length === 0 && stopDrift.length === 0,
        `空值 ${noStop.length} 行；与快照不一致 ${stopDrift.length} 行：${stopDrift.slice(0, 4).join("；") || "（无）"}`,
      );

      const geoBad: string[] = [];
      for (const r of db) {
        const parts = r.polyline.split(";");
        if (r.points < 2) geoBad.push(`${r.route_code}/${r.dsat_dir} 点数 ${r.points} < 2`);
        else if (parts.length !== r.points) geoBad.push(`${r.route_code}/${r.dsat_dir} 点数不符 ${parts.length}≠${r.points}`);
        else {
          for (const p of parts) {
            const [lngS, latS] = p.split(",");
            const lng = Number(lngS);
            const lat = Number(latS);
            if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
              geoBad.push(`${r.route_code}/${r.dsat_dir} 非有限坐标`);
              break;
            }
            if (lng < MACAU_BOX.minLng || lng > MACAU_BOX.maxLng || lat < MACAU_BOX.minLat || lat > MACAU_BOX.maxLat) {
              geoBad.push(`${r.route_code}/${r.dsat_dir} 越出澳门盒 (${lng},${lat})`);
              break;
            }
          }
        }
      }
      ok(
        "C4",
        "几何健全：每行点数 ≥2、`;` 分段数与 points 列一致、坐标有限且落在澳门范围",
        geoBad.length === 0,
        `${geoBad.length} 行异常：${geoBad.slice(0, 5).join("；")}`,
      );

      /* C5：未换源行必须逐字节不变（迁移窗口护栏，依赖迁移前快照） */
      if (!existsSync(HASH_PATH)) {
        skipped("C5", "未换源行 polyline 不可变", "缺迁移前快照 .verify/route-shapes-polyline-sha256.json");
      } else {
        const snap = JSON.parse(readFileSync(HASH_PATH, "utf8")) as Record<string, { sha256: string; points: number }>;
        const changed = UNTOUCHED.filter((k) => {
          const d = dbMap.get(k);
          const s = snap[k];
          if (!d || !s) return false;
          return createHash("sha256").update(d.polyline).digest("hex") !== s.sha256;
        });
        ok(
          "C5",
          "未参与换源的 9 行 polyline 必须与迁移前快照逐字节一致（SHA-256）",
          changed.length === 0,
          `被改动：${changed.join(" / ")}`,
        );
      }

      /*
       * C6：单向新鲜度。「只更新了 route_shapes 而忘了重算 mileage」会让进度模型
       * 静默降级（不报错、只是数字不对）。判据只看一个方向：
       * 几何比里程新超过 10 分钟 ⇒ 红。反过来（里程比几何新）是历史常态，不管。
       *
       * ⚠️ 作用域**只限已换源的线路**：当前库里有 3 条线路（2 / 21A / 59）本来就存在
       * 9 天的历史缺口（几何 2026-11-15 重取过、里程还停在 11-06），那是既有债、
       * 与本次换源无关。若全库无条件断言，这条一上线就红在旧账上 —— 那会让真正
       * 需要它的人关掉它。未换源时本断言**跳过**并明示。
       */
      const swappedRoutes = [...new Set(swappedInDb.map((k) => k.split("/")[0]))];
      if (swappedRoutes.length === 0) {
        skipped("C6", "几何不得比沿线里程新超过 10 分钟", "库内尚未换源，本断言暂无可检对象");
        const pre = (
          await pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM (
               SELECT s.route_code
                 FROM route_shapes s
                 LEFT JOIN route_station_mileage m ON m.route_code = s.route_code
                GROUP BY s.route_code
               HAVING EXTRACT(EPOCH FROM (max(s.fetched_at) - max(m.updated_at)))/60.0 > $1) t`,
            [FRESH_MIN],
          )
        ).rows[0];
        if (Number(pre.n) > 0) {
          info(`既有债（与本次换源无关）：全库有 ${pre.n} 条线路的几何比里程新 >${FRESH_MIN} 分钟，换源重算里程时应顺带清掉`);
        }
      } else {
        const stale = (
          await pool.query<{ route_code: string; diff_min: string | null }>(
            `SELECT s.route_code,
                    EXTRACT(EPOCH FROM (max(s.fetched_at) - max(m.updated_at)))/60.0 AS diff_min
               FROM route_shapes s
               LEFT JOIN route_station_mileage m ON m.route_code = s.route_code
              WHERE s.route_code = ANY($2)
              GROUP BY s.route_code
             HAVING EXTRACT(EPOCH FROM (max(s.fetched_at) - max(m.updated_at)))/60.0 > $1`,
            [FRESH_MIN, swappedRoutes],
          )
        ).rows;
        ok(
          "C6",
          `已换源线路的几何不得比沿线里程新超过 ${FRESH_MIN} 分钟（抓「只换了一半表」）`,
          stale.length === 0,
          `${stale.length} 条：${stale.slice(0, 6).map((r) => `${r.route_code}(+${Number(r.diff_min).toFixed(0)}min)`).join(" / ")}`,
        );
      }

      /*
       * C7：全有或全无。迁移被中途打断会留下「一部分已换、一部分没换」的混合态，
       * 而 C2 对混合态是放行的（每行各自合法）。这条把混合态单独堵掉。
       */
      ok(
        "C7",
        "迁移必须全有或全无：库内已换源行数必须为 0 或 108（不得是中间态）",
        swappedInDb.length === 0 || swappedInDb.length === 108,
        `已换源 ${swappedInDb.length} 行（既不是 0 也不是 108）——迁移被中断？`,
      );
      info(`库内当前进度：已换源 ${swappedInDb.length} / 108 行${swappedInDb.length === 0 ? "（尚未开始）" : ""}`);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }

  /* ── 汇总 ────────────────────────────────────────────────────────────── */
  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} / SKIP ${skip} ═══`);
  if (registered.length !== pass + fail + skip) {
    console.error("  FAIL  分母自证：注册数与 PASS+FAIL+SKIP 不相等");
    process.exit(1);
  }
  if (skip > 0) {
    console.log(`  ⚠️ 有 ${skip} 条判据被跳过（**不计入通过**）—— 本机上这些方面没有被验证。`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error("  FAIL  脚本异常终止：", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
