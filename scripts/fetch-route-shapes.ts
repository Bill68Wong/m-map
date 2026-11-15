/**
 * 抓取全部线路走向并入库（scripts/fetch-route-shapes.ts）
 * 用法：
 *   npx tsx scripts/fetch-route-shapes.ts --only=26,50                    # dry-run：只打印「会写入什么」
 *   npx tsx scripts/fetch-route-shapes.ts --only=26,50 --apply --allow-prod
 *   npm run fetch:route-shapes -- cloud --only=26,50 --apply --allow-prod
 *
 * ⚠️ 默认 dry-run（2026-11-15 起）：过去本脚本**没有任何护栏**，一跑就写库；
 *    现在必须显式 `--apply`，且目标非本地库时还要 `--allow-prod`。
 *
 * ── 为什么是离线脚本（不能实时查）────────────────────────────────────
 *   高德有 **QPS 限流**：连发会返回 `CUQPS_HAS_EXCEEDED_THE_LIMIT`（infocode 10021），
 *   且月配额用尽时会**静默返回空**（不报错、只是没数据）⇒ 绝不能放在请求路径上。
 *   ⇒ 一次性抓全量入库（`route_shapes`），运行时地图只读库、零配额消耗。
 *
 * ── 匹配策略（关键）──────────────────────────────────────────────────
 *   一次 `bus/linename` 可能返回多条同名/近似线路，且**高德的 `direction` 顺序
 *   未必与我们的 `dsat_dir` 一致** ⇒ 不能按下标配对。
 *
 *   本脚本的做法：
 *     ① 从高德结果里挑「与我们的方向**起点站名/终点站名**最匹配」的那条
 *        （站名做繁简/空格归一后比较，取交集最大的）；
 *     ② 每个 `dsat_dir` 独立匹配（两个方向各找各的），**避免错配**；
 *     ③ 若某方向找不到匹配 ⇒ **不写入**（宁缺勿错），并在报告里列出来。
 *
 * ── 轻轨 ──────────────────────────────────────────────────────────────
 *   · 关键词用**中文名**（`氹仔线`），不是我们的码（`LRT-氹仔线`）；
 *   · 高德把轻轨标为「地铁站」，但**线路本身在公交库里**、走同一接口 ✓。
 */
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { wgs84ToGcj02 } from "../src/lib/amap/coord";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const argv = process.argv.slice(2);
const target = argv.find((a) => a === "local" || a === "cloud") as "local" | "cloud" | undefined;
const onlyArg = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const APPLY = argv.includes("--apply");
const ALLOW_PROD = argv.includes("--allow-prod");

/**
 * ── 几何判据的分辨度门槛（两条都必须满足，任一不满足 ⇒ 硬失败，不写库）────────
 *   · `GEO_AMBIGUOUS_MIN_GAP_M`：次优 − 最优 必须 ≥ 200m（**绝对间隔**）
 *   · `GEO_AMBIGUOUS_RATIO`    ：最优 必须 < 次优 × 0.5（**相对间隔**）
 *
 * 依据（2026-11-15 实测，`.verify/qa-b8-amap59.log`）：59 路两条候选的
 * 「折线首点 ↔ 我方 dir 首站」相差 **10015m**；2 / 21A 同类差距也在 km 级。
 * ⇒ 200m 已是极保守值：低于它说明两条候选几何几乎重合，**判不出方向**，此时宁可失败。
 *
 * ⚠️ 为什么必须硬失败而不是「取第一条」：2026-09-22 与 2026-11-15 两次抓取，
 *    6 个 target 全部因 `score===0` 取第一条 ⇒ 两个方向写入**同一条高德线**
 *    （`amap_line_id` 相同），下游 `migrate-v2150` 又把其中一条反转，才制造出
 *    「两方向逐点逆序」的假象。这条静默路径就是那次数据错误的直接原因。
 */
const GEO_AMBIGUOUS_MIN_GAP_M = 200;
const GEO_AMBIGUOUS_RATIO = 0.5;
/** 几何判据的绝对上限：最优 `dFirst + dLast` 超过此值 ⇒ 候选根本不覆盖本行程 */
const GEO_MAX_SUM_M = 3000;

const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);
if (!connStr) {
  console.error("❌ 未找到连接串");
  process.exit(1);
}
const KEY = process.env.AMAP_KEY ?? "";
if (!KEY) {
  console.error("❌ 缺少 AMAP_KEY");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);
console.log(`抓取范围：${only ? [...only].join(", ") : "全部线路"}`);
console.log(`执行模式：${APPLY ? "APPLY（会写库）" : "DRY-RUN（不写库）"}`);
{
  let isLocal = false;
  try {
    const h = new URL(connStr).hostname;
    isLocal = h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".local");
  } catch {
    /* 解析失败按非本地处理 */
  }
  if (APPLY && !isLocal && !ALLOW_PROD) {
    console.error("❌ 目标是非本地库，写入必须显式加 `--allow-prod`。");
    process.exit(1);
  }
}

/** 请求间隔（毫秒）——避开 QPS 限流（实测连发会 10021）*/
const GAP_MS = 700;
/** 单次请求最大重试 */
const MAX_RETRY = 3;
/** 轻轨码 → 高德关键词 */
const LRT_KEYWORD: Record<string, string> = {
  "LRT-氹仔线": "氹仔线",
  "LRT-石排湾线": "石排湾线",
  "LRT-横琴线": "横琴线",
};

/** 站名归一（繁简/空格/站字/斜杠台号）——用于方向匹配 */
function normName(s: string): string {
  return String(s ?? "")
    .replace(/\s+/g, "")
    .replace(/站$/, "")
    .replace(/\(.*?\)/g, "")
    .replace(/（.*?）/g, "")
    .trim();
}

/** 繁 → 简（只处理澳门站名里高频的字，够用于「方向匹配」的模糊比较即可） */
/**
 * 繁 → 简（手写高频字表）
 *
 * ★ **本表只用于安全阀告警，不参与选择、不阻断写入。**
 *   方向/线位由**几何判据**决定（`dFirst + dLast` 最小）；本表只在「站名命中且与几何最优
 *   不是同一条」时打一条告警，用来暴露「高德站名与我们的站序对不上」这类值得看一眼的情况。
 *
 * 曾经漏掉「廣」导致 `2 / 21A / 59` 三条线 6 个 target 站名 score 全部 0 分，
 * 旧实现于是走「score===0 取第一条」，把两个方向写成同一条高德线（`amap_line_id` 相同），
 * 下游 `db/migrate-v2150.ts:139` 再反转其中一条，才制造出「两方向逐点逆序」的假象
 * （2026-11-15 事故）。本次已补高频字。
 *
 * 将来**仍可能缺字**，但缺字只会让告警不响，**不会让选线出错** —— 因为选择权在几何判据。
 * ⇒ 看到告警不要去无限扩表；真要判的是「几何分不开」，那是硬失败。
 */
function toSimp(s: string): string {
  const map: Record<string, string> = {
    媽: "妈", 閣: "阁", 灣: "湾", 橫: "横",
    蓮: "莲", 華: "华", 場: "场", 運: "运",
    動: "动", 會: "会", 機: "机", 頭: "头",
    碼: "码", 橋: "桥", 總: "总", 東: "东",
    亞: "亚", 協: "协", 醫: "医", 學: "学",
    島: "岛", 園: "园", 門: "门", 關: "关",
    閘: "闸", 銀: "银", 邊: "边", 區: "区",
    環: "环", 業: "业", 樂: "乐", 陽: "阳",
    長: "长", 馬: "马", 路: "路",
    // ↓ 2026-11-15 补：前四个是那 6 个 target 全部 0 分的直接原因
    廣: "广", 寧: "宁", 樞: "枢", 紐: "纽",
    // ↓ 同类高频（澳门站名常见字，用于让安全阀能响）
    體: "体", 館: "馆", 廳: "厅", 樓: "楼",
    號: "号", 線: "线", 臺: "台", 檯: "台",
    廠: "厂", 鐵: "铁", 銅: "铜", 鋼: "钢",
    務: "务", 達: "达", 連: "连", 進: "进",
    遠: "远", 過: "过", 這: "这", 檢: "检",
    驗: "验", 塊: "块", 處: "处", 廚: "厨",
    頸: "颈", 腳: "脚", 灘: "滩", 墳: "坟",
    廟: "庙", 縣: "县", 鎮: "镇", 網: "网",
    點: "点", 電: "电", 車: "车",
  };
  return [...s].map((ch) => map[ch] ?? ch).join("");
}
function key(s: string): string {
  return toSimp(normName(s));
}

/** 两点球面距离（米）。入参均为 `[lng, lat]`，**必须同口径**（本脚本统一 GCJ-02） */
function haversineM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 高德 `polyline`（`lng,lat;lng,lat;…`，GCJ-02）→ 坐标数组 */
function parsePolylineLL(pl: string): [number, number][] {
  return String(pl || "")
    .split(";")
    .filter(Boolean)
    .map((p) => p.split(",").map(Number))
    .filter((a) => a.length === 2 && a.every(Number.isFinite))
    .map((a) => [a[0], a[1]] as [number, number]);
}

interface AmapBusline {
  id?: string;
  name?: string;
  type?: string;
  /** ★ 高德侧的去/回标记（0/1）——**顺序未必与我们的 dsat_dir 一致**，仅作溯源 */
  direction?: string;
  polyline?: string;
  distance?: string;
  start_stop?: string;
  end_stop?: string;
  start_time?: string;
  end_time?: string;
  departure_stop?: { name?: string };
  arrival_stop?: { name?: string };
}

async function queryAmap(keyword: string): Promise<AmapBusline[]> {
  const url =
    `https://restapi.amap.com/v3/bus/linename?key=${KEY}&city=820000` +
    `&keywords=${encodeURIComponent(keyword)}&offset=10&extensions=all`;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25_000) });
      const j = (await r.json()) as { status?: string; info?: string; buslines?: AmapBusline[] };
      if (j.status === "1") return j.buslines ?? [];
      // 10021 = QPS 超限 ⇒ 退避重试
      if (j.info === "CUQPS_HAS_EXCEEDED_THE_LIMIT") {
        const wait = 1500 * attempt;
        console.log(`      ⟳ QPS 限流，退避 ${wait}ms 后重试（${attempt}/${MAX_RETRY}）`);
        await sleep(wait);
        continue;
      }
      console.log(`      ⚠️ status=${j.status} info=${j.info}`);
      return [];
    } catch (e) {
      console.log(`      ⚠️ 请求失败：${(e as Error).message}（${attempt}/${MAX_RETRY}）`);
      await sleep(1200 * attempt);
    }
  }
  return [];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  const report: string[] = [];
  const say = (s: string) => {
    console.log(s);
    report.push(s);
  };

  try {
    // ① 全部启用线路（code / kind）
    const routes = (
      await pool.query(`SELECT code, kind, color FROM routes WHERE is_active ORDER BY kind DESC, code`)
    ).rows as { code: string; kind: string; color: string | null }[];

    // ② 每个 (线路, 方向) 的起终点站名 + 起终点**坐标**
    //    ⚠️ `stations.lat/lng` 是 WGS84，高德折线是 GCJ-02 ⇒ 必须转成 GCJ 再比（见 `endsGeo`）
    const stopRows = (
      await pool.query(
        `SELECT r.code, rs.dsat_dir, rs.seq, s.name_tc, s.lat, s.lng
           FROM route_stations rs
           JOIN routes r ON r.id = rs.route_id
           JOIN stations s ON s.code = rs.station_code
          ORDER BY r.code, rs.dsat_dir, rs.seq`,
      )
    ).rows as { code: string; dsat_dir: string; seq: number; name_tc: string; lat: number | null; lng: number | null }[];

    /** code|dir → { first, last, n }（站名归一后，用于名字打分） */
    const ends = new Map<string, { first: string; last: string; n: number }>();
    /** code|dir → { first, last }（GCJ-02 坐标，用于几何判据） */
    const endsGeo = new Map<string, { first: [number, number] | null; last: [number, number] | null }>();
    for (const r of stopRows) {
      const k = `${r.code}|${r.dsat_dir}`;
      const ll: [number, number] | null =
        r.lat != null && r.lng != null
          ? (() => {
              const g = wgs84ToGcj02({ lat: Number(r.lat), lng: Number(r.lng) });
              return [g.lng, g.lat] as [number, number];
            })()
          : null;
      const cur = ends.get(k);
      const geo = endsGeo.get(k);
      if (!cur) ends.set(k, { first: key(r.name_tc), last: key(r.name_tc), n: 1 });
      else {
        cur.last = key(r.name_tc);
        cur.n += 1;
      }
      if (!geo) endsGeo.set(k, { first: ll, last: ll });
      else geo.last = ll;
    }

    const targets = routes
      .filter((r) => !only || only.has(r.code))
      .flatMap((r) => {
        const dirs = [...ends.keys()].filter((k) => k.startsWith(`${r.code}|`)).map((k) => k.split("|")[1]);
        return (dirs.length ? dirs : ["0"]).map((dir) => ({ ...r, dir }));
      });

    say(`\n待抓取：${targets.length} 个 (线路 × 方向)`);

    let ok = 0;
    let miss = 0;
    let dry = 0;
    let hardFail = 0;

    for (const [i, t] of targets.entries()) {
      const keyword = t.kind === "lrt" ? (LRT_KEYWORD[t.code] ?? t.code.replace(/^LRT-/, "")) : t.code;
      const e = ends.get(`${t.code}|${t.dir}`) ?? { first: "", last: "", n: 0 };
      say(
        `\n[${i + 1}/${targets.length}] ${t.code}（${t.kind}）dir=${t.dir}` +
          ` · 我方首「${e.first}」末「${e.last}」`,
      );

      const lines = await queryAmap(keyword);
      if (!lines.length) {
        say(`   ✗ 高德无结果（关键词「${keyword}」）`);
        miss++;
        await sleep(GAP_MS);
        continue;
      }
      say(`   高德返回 ${lines.length} 条：${lines.map((l) => l.name ?? "?").slice(0, 5).join(" | ")}`);

      // ③ 方向匹配：**几何判据是唯一选择依据**；站名判据只作告警，不参与选择、不阻断写入
      //
      //   为什么站名没有否决权（2026-11-15 定案）：`toSimp` 是手写高频子集，结构性不可靠。
      //   若让站名否决几何，一旦它「恰好匹配到另一条对向线」就会把已经分离 8000m 的正确结论
      //   判成冲突 ⇒ 假红阻断合法采集 ⇒ 人去关掉门禁，损失更大。所以：
      //     · 几何分不开 / 候选不覆盖 ⇒ **硬失败**（不写库、退出码 1）；
      //     · 站名与几何相左      ⇒ **只告警**（照常按几何写入）。
      //   历史事故：旧实现只有站名判据且 `score===0` 就「取第一条」，2026-09-22 与 2026-11-15
      //   两次抓取都把 2/21A/59 的两方向写成同一条高德线（`amap_line_id` 相同），下游
      //   `db/migrate-v2150.ts:139` 再按端点几何反转其中一条，才制造出「两方向逐点逆序」的假象。
      const geo = endsGeo.get(`${t.code}|${t.dir}`) ?? { first: null, last: null };
      const cand = lines
        .filter((l) => l.polyline)
        .map((l) => {
          const s = key(l.start_stop ?? l.departure_stop?.name ?? "");
          const en = key(l.end_stop ?? l.arrival_stop?.name ?? "");
          let score = 0;
          if (e.first && s && (s.includes(e.first) || e.first.includes(s))) score += 2;
          if (e.last && en && (en.includes(e.last) || e.last.includes(en))) score += 2;
          const pts = parsePolylineLL(l.polyline as string);
          const dFirst = pts.length && geo.first ? haversineM(pts[0], geo.first) : null;
          const dLast = pts.length && geo.last ? haversineM(pts[pts.length - 1], geo.last) : null;
          const sum = dFirst != null && dLast != null ? dFirst + dLast : null;
          return { l, score, s, en, pts, dFirst, dLast, sum };
        });

      say(`   候选（我方首末站坐标口径 GCJ-02）：`);
      for (const c of cand) {
        const f = (x: number | null) => (x == null ? "-" : `${x.toFixed(0)}m`);
        say(
          `     · 「${c.l.name ?? "?"}」 score=${c.score} dFirst=${f(c.dFirst)} dLast=${f(c.dLast)} sum=${f(c.sum)} points=${c.pts.length}`,
        );
      }

      const nameWinner =
        cand.filter((c) => c.score > 0).sort((a, b) => b.score - a.score)[0] ?? null;
      const geoRanked = cand.filter((c) => c.sum != null).sort((a, b) => (a.sum as number) - (b.sum as number));
      const geoWinner = geoRanked[0] ?? null;
      const geoSecond = geoRanked[1] ?? null;

      let fail: string | null = null;
      if (!cand.length) fail = "高德结果里无 polyline";
      else if (!geoWinner) fail = "几何判据不可用（我方该 dir 缺首/末站坐标，或候选 polyline 顶点 <2）";
      else if ((geoWinner.sum as number) > GEO_MAX_SUM_M)
        fail = `几何最优 dFirst+dLast=${(geoWinner.sum as number).toFixed(0)}m > 上限 ${GEO_MAX_SUM_M}m ⇒ 候选不覆盖本行程`;
      else if (
        geoSecond &&
        ((geoSecond.sum as number) - (geoWinner.sum as number) < GEO_AMBIGUOUS_MIN_GAP_M ||
          (geoWinner.sum as number) > (geoSecond.sum as number) * GEO_AMBIGUOUS_RATIO)
      )
        fail =
          `几何分不开：最优「${geoWinner.l.name}」${(geoWinner.sum as number).toFixed(0)}m / ` +
          `次优「${geoSecond.l.name}」${(geoSecond.sum as number).toFixed(0)}m（要求间隔 ≥ ${GEO_AMBIGUOUS_MIN_GAP_M}m 且 最优 < 次优×${GEO_AMBIGUOUS_RATIO}）`;

      if (fail) {
        say(`   ✗ 硬失败：${fail}`);
        say(`   ✗ 未写库（该方向保持库内原值）`);
        hardFail++;
        await sleep(GAP_MS);
        continue;
      }

      const best = geoWinner as (typeof cand)[number];
      const basis = nameWinner
        ? `站名(score=${nameWinner.score})+几何 指向同一条`
        : `站名 0 分（缺字属预期）⇒ 仅几何判据，不会退化为「取第一条」`;
      say(`   ✓ 选定「${best.l.name ?? "?"}」：${basis} · sum=${(best.sum as number).toFixed(0)}m`);

      /**
       * ★ 站名与几何相左 ⇒ **只告警，不阻断**（选择权在几何）。
       *   看到这条告警**不要去扩 `toSimp` 表**：缺字只会让告警不响，不会让选线出错。
       *   真需要人工判断的是「几何分不开」（那是硬失败）。
       */
      if (nameWinner && nameWinner !== geoWinner) {
        say(
          `   ⚠️ 告警（不阻断）：站名指向「${nameWinner.l.name ?? "?"}」(score=${nameWinner.score}) 与几何最优 ` +
            `「${geoWinner.l.name ?? "?"}」(${(geoWinner.sum as number).toFixed(0)}m) 不是同一条；` +
            `已按**几何**写入。若反复出现，先看几何分离度是否够（够就不用管站名）。`,
        );
      }

      const nums = best.pts;
      if (nums.length < 2) {
        say(`   ✗ polyline 解析失败`);
        miss++;
        await sleep(GAP_MS);
        continue;
      }
      const pl = best.l.polyline as string;
      const lngs = nums.map((a) => a[0]);
      const lats = nums.map((a) => a[1]);

      if (!APPLY) {
        say(
          `   ◻ DRY-RUN：将写入 ${nums.length} 点 · amap_name=「${best.l.name ?? "?"}」` +
            ` · start/end=「${best.l.start_stop ?? "?"}」→「${best.l.end_stop ?? "?"}」`,
        );
        dry++;
        await sleep(GAP_MS);
        continue;
      }

      await pool.query(
        `INSERT INTO route_shapes
           (route_code, kind, dsat_dir, amap_line_id, amap_name, amap_dir, polyline, points,
            start_stop, end_stop, min_lng, min_lat, max_lng, max_lat, src, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'amap.v3.bus.linename',now())
         ON CONFLICT (route_code, dsat_dir) DO UPDATE SET
           kind=EXCLUDED.kind, amap_line_id=EXCLUDED.amap_line_id, amap_name=EXCLUDED.amap_name,
           amap_dir=EXCLUDED.amap_dir, polyline=EXCLUDED.polyline, points=EXCLUDED.points,
           start_stop=EXCLUDED.start_stop, end_stop=EXCLUDED.end_stop,
           min_lng=EXCLUDED.min_lng, min_lat=EXCLUDED.min_lat,
           max_lng=EXCLUDED.max_lng, max_lat=EXCLUDED.max_lat, fetched_at=now()`,
        [
          t.code,
          t.kind,
          t.dir,
          best.l.id ?? null,
          best.l.name ?? null,
          best.l.direction ?? null,
          pl,
          nums.length,
          best.l.start_stop ?? null,
          best.l.end_stop ?? null,
          Math.min(...lngs),
          Math.min(...lats),
          Math.max(...lngs),
          Math.max(...lats),
        ],
      );
      say(`   ✅ 入库：${nums.length} 点 · 起「${best.l.start_stop ?? "?"}」终「${best.l.end_stop ?? "?"}」`);
      ok++;
      await sleep(GAP_MS);
    }

    say(
      `\n===== 完成：写入 ${ok} / DRY-RUN ${dry} / 未命中 ${miss} / 硬失败 ${hardFail} / 共 ${targets.length} =====`,
    );
    if (hardFail > 0) {
      say(`❌ 有 ${hardFail} 个方向**硬失败未写库**（几何分不开 / 候选不覆盖）⇒ 退出码 1，本次采集不可作为验收依据`);
      process.exitCode = 1;
    }
    if (!APPLY) say(`（本次是 DRY-RUN，未写库；确认无误后加 \`--apply --allow-prod\` 重跑）`);

    const stat = (
      await pool.query(
        `SELECT kind, count(*)::int AS n, sum(points)::int AS pts, count(DISTINCT route_code)::int AS routes
           FROM route_shapes GROUP BY kind ORDER BY kind`,
      )
    ).rows as { kind: string; n: number; pts: number; routes: number }[];
    say("\n=== 入库复核 ===");
    for (const s of stat) say(`  ${s.kind}：${s.routes} 条线路 · ${s.n} 个方向 · ${s.pts} 个点`);

    fs.writeFileSync(path.join(process.cwd(), ".verify", "fetch-route-shapes.out.txt"), report.join("\n") + "\n", "utf8");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
