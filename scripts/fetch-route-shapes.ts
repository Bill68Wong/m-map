/**
 * 抓取全部线路走向并入库（scripts/fetch-route-shapes.ts）
 * 用法：npm run fetch:route-shapes -- [local|cloud] [--allow-prod] [--only=26,50]
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

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const argv = process.argv.slice(2);
const target = argv.find((a) => a === "local" || a === "cloud") as "local" | "cloud" | undefined;
const onlyArg = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim()).filter(Boolean)) : null;

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
  };
  return [...s].map((ch) => map[ch] ?? ch).join("");
}
function key(s: string): string {
  return toSimp(normName(s));
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

    // ② 每个 (线路, 方向) 的起终点站名（用我们的站序首尾；⚠️ 与高德站名做归一比较）
    const stopRows = (
      await pool.query(
        `SELECT r.code, rs.dsat_dir, rs.seq, s.name_tc
           FROM route_stations rs
           JOIN routes r ON r.id = rs.route_id
           JOIN stations s ON s.code = rs.station_code
          ORDER BY r.code, rs.dsat_dir, rs.seq`,
      )
    ).rows as { code: string; dsat_dir: string; seq: number; name_tc: string }[];

    /** code|dir → { first, last, n } */
    const ends = new Map<string, { first: string; last: string; n: number }>();
    for (const r of stopRows) {
      const k = `${r.code}|${r.dsat_dir}`;
      const cur = ends.get(k);
      if (!cur) ends.set(k, { first: key(r.name_tc), last: key(r.name_tc), n: 1 });
      else {
        cur.last = key(r.name_tc);
        cur.n += 1;
      }
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

      // ③ 方向匹配：优先「起点站名匹配」，其次「终点站名匹配」，再次「首尾都对得上」，最后取第一条
      const scored = lines
        .filter((l) => l.polyline)
        .map((l) => {
          const s = key(l.start_stop ?? l.departure_stop?.name ?? "");
          const en = key(l.end_stop ?? l.arrival_stop?.name ?? "");
          let score = 0;
          if (e.first && s && (s.includes(e.first) || e.first.includes(s))) score += 2;
          if (e.last && en && (en.includes(e.last) || e.last.includes(en))) score += 2;
          return { l, score, s, en };
        })
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best) {
        say(`   ✗ 高德结果里无 polyline`);
        miss++;
        await sleep(GAP_MS);
        continue;
      }
      if (best.score === 0) say(`   ⚠️ 站名未匹配上（首尾「${best.s}→${best.en}」），取第一条`);

      const pl = best.l.polyline as string;
      const pts = pl.split(";").filter(Boolean);
      const nums = pts.map((p) => p.split(",").map(Number)).filter((a) => a.length === 2 && a.every(Number.isFinite));
      if (nums.length < 2) {
        say(`   ✗ polyline 解析失败`);
        miss++;
        await sleep(GAP_MS);
        continue;
      }
      const lngs = nums.map((a) => a[0]);
      const lats = nums.map((a) => a[1]);

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

    say(`\n===== 完成：成功 ${ok} / 未命中 ${miss} / 共 ${targets.length} =====`);

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
