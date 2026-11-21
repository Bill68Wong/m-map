/**
 * 导航态站台坐标 门禁（`scripts/test-platform-of.ts`，2026-11-21）
 *
 * ── 守的是什么 ────────────────────────────────────────────────────────────
 *   真机验收 ③：「导航里站点还在 `T373/1` 的位置」。修法见 `src/lib/nav/platform-of.ts`
 *   文件头（根因链 + 为什么必须按腿）。本文件只负责**证明它成立**，分两层：
 *
 *     · A 组 **纯函数**（不连库）：折叠规则本身 —— 首次出现优先 / 主码兜底 /
 *       缺坐标跳过 / 空 ⇒ null / **跨线不串台**；
 *     · D 组 **真库**：用 `stations` / `route_stations` 的真实行，断言
 *       「26 方向 0 停在 T373/2、AP1 方向 0 停在 T373/1」，并端到端跑一遍
 *       「腿序 → 主码坐标」确实落到 `/2` 而不是 `/1`。
 *
 * ── 为什么 A 组要单独存在（不直接靠真库）──────────────────────────────────
 *   「全局按主码取某一个站台」这种错法，在只有一条线的数据里**也能过**真库层
 *   （它碰巧取对了）。A4/A5/D4 专门用**同主码多站台 + 跨线**的构造去钉它：
 *   规则必须依赖**输入**（腿序 + 该线该方向的行），不能依赖任何全局状态。
 *
 * ── 失败即红（fail-closed），与 `test-remaining-route.ts` 同口径 ─────────────
 *   连库失败**判失败**（exit 1），不写「跳过 = 通过」。理由沿用那条：
 *   `SKIP + exit 0` 是假绿出口 —— 库不可达时整轮记 0 条并以 0 退出，会被人当通过。
 *   ⚠️ 代价必须说清：无库环境下 `npm run verify` 会红。这是刻意的
 *      （而且 verify 第一步 `test:remaining-all` 本来就已经是这个口径，没有新增一类失败）。
 *
 * 跑法：`npm run test:platform-of`
 */
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { buildPlatformMap, type PlatformCoordRow } from "../src/lib/nav/platform-of";

let pass = 0;
let fail = 0;
const registered: string[] = [];

function ok(id: string, label: string, cond: boolean, detail = ""): void {
  registered.push(id);
  if (cond) {
    pass++;
    console.log(`  PASS  ${id}  ${label}${detail ? `  :: ${detail}` : ""}`);
  } else {
    fail++;
    console.error(`  FAIL  ${id}  ${label}${detail ? `  :: ${detail}` : ""}`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * A 组：纯函数（不连库）
 * ════════════════════════════════════════════════════════════════════════ */
function groupA(): void {
  console.log("\n  ── A 组：折叠规则（纯函数，不连库）──");

  /* 两个站台刻意给成"能一眼看出谁是谁"的坐标（真实值见 D 组） */
  const rows: PlatformCoordRow[] = [
    { code: "T373/1", lng: 113.56514, lat: 22.152071 },
    { code: "T373/2", lng: 113.5649, lat: 22.151752 },
    { code: "T999/1", lng: null, lat: null }, // 缺坐标行：必须跳过，不参与任何计算
  ];

  const a = buildPlatformMap(["T373/2"], rows);
  ok("A1", "腿里给平台码 `T373/2` ⇒ 主码 `T373` 落在 /2 的坐标", !!a && a.get("T373")?.lng === 113.5649, JSON.stringify(a?.get("T373")));
  ok("A2", "且**不等于** /1 的坐标（两条真实站台相距 43.2m，不是浮点噪声）", !!a && a.get("T373")?.lng !== 113.56514);

  const b = buildPlatformMap(["T373/1"], rows);
  ok("A3", "腿里给 `T373/1` ⇒ 落在 /1（不是一律取 /2）", !!b && b.get("T373")?.lng === 113.56514);

  /* 环线：同一主码在本腿出现两次 ⇒ 取**首次**（去程那次），不是 seq 最小、也不是最后一次 */
  const c = buildPlatformMap(["T373/1", "T500", "T373/2"], rows);
  ok("A4", "同一主码在腿里出现两次 ⇒ 取**首次出现**那一次（/1 在前 ⇒ 用 /1）", !!c && c.get("T373")?.lng === 113.56514);

  ok("A5", "缺坐标行（lat/lng = null）**跳过**，不落成 (0,0)", !buildPlatformMap(["T999/1"], rows));

  ok("A6", "全空输入 ⇒ `null`（稳定引用，消费方据此回落）", buildPlatformMap([], rows) === null && buildPlatformMap(["T373/2"], []) === null);

  const d = buildPlatformMap(["T373"], rows);
  ok("A7", "站序给的是**主码**（无 `/x`）⇒ 回落主码行；本例无主码行 ⇒ 不产出（宁可回落，也不猜一个站台）", d === null);

  /* 跨线不串台：只有 AP1 的行（/1），腿却是 26（/2）⇒ **不得**把 /1 套上去 */
  const ap1Rows: PlatformCoordRow[] = [{ code: "T373/1", lng: 113.56514, lat: 22.152071 }];
  ok("A8", "跨线不串台：本线行里没有 `/2` ⇒ `T373` **不产出**（不拿别的线的站台顶替）", buildPlatformMap(["T373/2"], ap1Rows) === null);
}

/* ══════════════════════════════════════════════════════════════════════════
 * D 组：真库（fail-closed）
 * ════════════════════════════════════════════════════════════════════════ */
const R_EARTH = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;
function distM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const x = dLng * Math.cos(((a.lat + b.lat) / 2) * toRad(1));
  return Math.sqrt(x * x + dLat * dLat) * R_EARTH;
}

async function groupD(): Promise<void> {
  console.log("\n  ── D 组：真库（stations / route_stations 的真实行）──");
  process.loadEnvFile?.();
  const { Pool } = await import("pg");
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    console.error("  FAIL  未配置 DATABASE_URL ⇒ 真库层无法验证（fail-closed，不写「跳过=通过」）");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: conn, ssl: conn.includes("supabase") ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 8000 });
  try {
    const st = (
      await pool.query<{ code: string; lat: number; lng: number }>(
        "SELECT code, lat, lng FROM stations WHERE code LIKE 'T373%' AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY code",
      )
    ).rows;
    const p1 = st.find((r) => r.code === "T373/1");
    const p2 = st.find((r) => r.code === "T373/2");
    ok("D1", "库里同时存在 `T373/1` 与 `T373/2`（否则本门禁无对象）", !!p1 && !!p2, `${st.map((r) => r.code).join(",")}`);
    if (!p1 || !p2) return;

    const d = distM(p1, p2);
    /* 阈值 20m 只是"两点不得几乎重合"的下限；实测 43.2m。这里**不**把 43.2 写成阈值 ——
       站台坐标可能因补测微调，锁死一个实测值会让门禁在正常数据更新时假红。 */
    ok("D1b", "两站台相距 ≥ 20m（实测 43.2m ⇒ 画错一侧肉眼可辨）", d >= 20, `${d.toFixed(1)}m`);

    /* 该主码被哪些 (线路, 方向) 使用，各停哪个站台 —— 这就是"不能全局按主码"的证据 */
    const rs = (
      await pool.query<{ route: string; dir: string; seq: number; code: string }>(
        `SELECT r.code AS route, rs.dsat_dir AS dir, rs.seq, rs.station_code AS code
           FROM route_stations rs JOIN routes r ON r.id = rs.route_id
          WHERE rs.station_code LIKE 'T373%' AND r.is_active
          ORDER BY r.code, rs.dsat_dir, rs.seq`,
      )
    ).rows;
    const byRoute = new Map(rs.map((r) => [`${r.route}/${r.dir}`, r.code]));
    console.log(`     真库分布：${[...byRoute].map(([k, v]) => `${k}→${v}`).join("  ")}`);
    ok(
      "D2",
      "同一主码被**多条线**使用且停的平台不同（`26/0→T373/2` 与 `AP1/0→T373/1` 并存）",
      byRoute.get("26/0") === "T373/2" && byRoute.get("AP1/0") === "T373/1",
      `26/0=${byRoute.get("26/0")} / AP1/0=${byRoute.get("AP1/0")}`,
    );

    /* 端到端（26 方向 0）：腿序只含 /2 ⇒ 主码坐标必须逐位等于 /2 */
    const rows26: PlatformCoordRow[] = [{ code: "T373/2", lng: p2.lng, lat: p2.lat }];
    const m26 = buildPlatformMap(["T373/2"], rows26);
    const hit26 = m26?.get("T373") ?? null;
    ok(
      "D3",
      "端到端（26/0）：主码 `T373` 的坐标**逐位等于** `T373/2`，且不等于 `T373/1`",
      !!hit26 && hit26.lng === p2.lng && hit26.lat === p2.lat && hit26.lng !== p1.lng,
      hit26 ? `(${hit26.lng}, ${hit26.lat})` : "null",
    );

    /* 端到端（AP1 方向 0，反向对照）：该线只停 /1 ⇒ 必须落到 /1，不能一律 /2 */
    const rowsAp1: PlatformCoordRow[] = [{ code: "T373/1", lng: p1.lng, lat: p1.lat }];
    const mAp1 = buildPlatformMap(["T373/1"], rowsAp1);
    const hitAp1 = mAp1?.get("T373") ?? null;
    ok(
      "D4",
      "反向对照（AP1/0）：主码 `T373` 落在 `T373/1`（不是一律取 /2）",
      !!hitAp1 && hitAp1.lng === p1.lng && hitAp1.lat === p1.lat && hitAp1.lng !== p2.lng,
      hitAp1 ? `(${hitAp1.lng}, ${hitAp1.lat})` : "null",
    );

    /* 跨线污染的反向证据：拿 26 的行去喂"AP1 的腿序（/2）" —— 真实场景里不该出现，
       出现了就是上游把两条线的站台行混一起；此时**不许**产出任何坐标。 */
    ok(
      "D5",
      "把 26 的站台行喂给「只停 /1 的线」的腿序（/2）⇒ 不产出（跨线数据混用会被这条抓住）",
      buildPlatformMap(["T373/2"], rowsAp1) === null,
    );

    /**
     * D6：**链路的第一环** —— `route_stations` 里存的是**完整平台码**（`T373/2`），不是主码。
     *   这一条决定「站条（`strips[].stops[].code`）里到底有没有 `/x`」：
     *   如果库里存的是主码，那本文件的 A1 分支在线上根本走不到（只会走 A7 的兜底），
     *   整个修法就是空转 —— 而那种空转**不会报任何错**。
     */
    ok(
      "D6",
      "`route_stations.station_code` 存的是**完整平台码**（含 `/2`），主码是运行时归一出来的",
      rs.some((r) => r.code === "T373/2"),
      `样例 ${[...new Set(rs.map((r) => r.code))].join(",")}`,
    );

    /*
     * D7：**折叠规则在本站不产生歧义** —— 每条 (线路, 方向) 只用**一个**平台码。
     *
     * ⚠️ 这条是我第一版写错后改的，记录一下免得下一个人重踩：
     *   我原本想断言「51A/0 上 科大(T373/2) 在海擎天總站(M93) 之前，所以 科大→擎天匯 走 51A/0」。
     *   真库一查是反的：51A/0 是 `M93@1 → T373/2@14`（海擎天 → 科大），51A/1 根本不停科大。
     *   ⇒ 我对那条 OD 的线路归属**没有任何证据**，于是把断言换成一条真库能直接支撑的事实，
     *     而不是把它改成"看起来能过"的样子。
     */
    const groups = new Map<string, Set<string>>();
    for (const r of rs) {
      const k = `${r.route}/${r.dir}`;
      const s = groups.get(k) ?? new Set<string>();
      s.add(r.code);
      groups.set(k, s);
    }
    const multi = [...groups].filter(([, s]) => s.size > 1).map(([k]) => k);
    const uses1 = [...groups.values()].filter((s) => s.has("T373/1")).length;
    const uses2 = [...groups.values()].filter((s) => s.has("T373/2")).length;
    ok(
      "D7",
      "每条 (线路,方向) 只用一个平台码（无歧义）；且 /1 与 /2 各被多条线使用 ⇒「全局取一个站台」必错",
      multi.length === 0 && uses1 >= 2 && uses2 >= 2,
      `${groups.size} 组 · 多码组 {${multi.join(",")}} · /1 被 ${uses1} 条用、/2 被 ${uses2} 条用`,
    );
  } finally {
    await pool.end().catch(() => undefined);
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * E 组：**几何级端到端**（真库数据 → 真 `buildColoredLegs` → 真彩段/步行端点）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── ★★ 坐标系（本组第一版错在这里，改之前先读这段）────────────────────────
 *   **库里 `stations` 存的是 WGS84，而 `route_shapes.polyline` 是 GCJ-02**，
 *   接口出口一律转 GCJ（`detail-body/route.ts:119` 的 `wgs84ToGcj02`、`/api/stations`、
 *   `/api/route-stops` 都是）。
 *
 *   本组第一版直接拿**库里的 WGS 原始值**去和 **GCJ 折线**比距离，于是量出
 *   `26/0 → T373/2` 有 223.7m、`51A/0` 有 526.4m，并据此（错误地）报告"折线不过科大站"。
 *   实际上那两个数是「WGS 站台 ↔ GCJ 折线」这种**跨坐标系距离**，纯粹是混用产物：
 *   澳门一带 WGS→GCJ 偏移约 **+505m 东 / −296m 南**，所以任何 WGS 点都会被量成几百米。
 *
 *   ⇒ 本组现在**一律先 `wgs84ToGcj02` 再喂几何**（与生产出口同一条函数、同一口径）。
 *     换算后：`/1` 距折线 **3.6m**、`/2` 距折线 **8.8m** —— 全部线路一致，
 *     就是正常的「站牌 vs 道路中线」偏移（lead 实测 3.6 / 8.7，差 0.1m 是舍入）。
 *   ⚠️ 同一个坑在别处也会出现：任何「DB 站坐标 ↔ 折线 / 地图」的比较都必须先转 GCJ。
 *
 * ── 为什么是"库级端到端"而不是浏览器级 ────────────────────────────────────
 *   本机 3000 端口是负责人的预览，我不重启、不占端口，也就不去驱动完整 UI 流程。
 *   但这条链上**每一段都是真代码**：真 `route_shapes` 折线 + 真 `route_stations` 站序
 *   + 真 `stations` 坐标（已转 GCJ）→ 真 `buildColoredLegs()` → 真 `colored[0]`。
 *   所以它证明的是「几何端点确实换成了站台坐标」，不是"纯函数自证"。
 *
 * ── 判据（"端点必须落在离站台点最近的那个顶点上"）────────────────────────
 *   彩段起点是**折线上的一个顶点**，站台点是**路边站牌**，两者天然有
 *   「站台到道路中线」的物理偏移（科大这对实测 3.6m / 8.8m）。所以
 *   「彩段起点距站台 ≤1m」在任何实现下都不成立 ⇒ 判**最优性**：
 *     `dist(colored[0], 站台) ≈ nearestOnPath(站台).distM`（容差 1m），
 *   再配一条「站台点与折叠点命中的是**不同顶点**」的**分辨力自证**，
 *   否则本案例证明不了任何事。
 *
 * ── 三个容易混的数（对账表要分开列）──────────────────────────────────────
 *   · **站台 → 折线垂距**：`/1` 3.6m、`/2` 8.8m ——「站牌离道路中线多远」（lead 说的 5~9m 是这一项）；
 *   · **两个站台的直线距离**：43.2m ——「隔了多远」；与坐标系无关（WGS→GCJ 是**近常量平移**，
 *     两点同受其平移 ⇒ 距离不变）；
 *   · **端点沿线位移**：两个命中顶点之间的弧长，实测 **53.2m**（`26/0` 的顶点间距约 26m × 2）。
 *   三个都不是一回事，尤其**不能**把 43.2m 写成"端点挪了 43m"。
 */
async function groupE(pool: Pool): Promise<void> {
  console.log("\n  ── E 组：几何级端到端（真几何 + 真彩段，坐标一律 GCJ）──");

  const { buildColoredLegs, legPointOf, distM, parsePolyline, nearestOnPath, cumDistM } = await import(
    "../src/lib/nav/route-overview"
  );
  const { wgs84ToGcj02 } = await import("../src/lib/amap/coord");
  /** 库里的 WGS → 接口/折线用的 GCJ（**所有几何输入必须先过这一步**，见上方坐标系说明） */
  const toGcj = (p: { lng: number; lat: number }) => {
    const g = wgs84ToGcj02({ lat: p.lat, lng: p.lng });
    return { lng: Number(g.lng), lat: Number(g.lat) };
  };

  /**
   * 跑一条真实单腿：board 用**平台码**，但 `lng/lat` 故意给**另一个站台的坐标**
   * （= `/api/stations` 按主码去重后剩下的那个点）—— 这正是改前的输入。
   * 若修复生效，`boardPoint` 应回到平台坐标，彩段起点也应落在"离平台最近的顶点"上。
   */
  const runCase = async (
    route: string,
    dir: string,
    boardSeq: number,
    alightSeq: number,
  ): Promise<{
    boardCode: string;
    boardMain: string;
    /** 全部坐标为 **GCJ**（与折线同一空间） */
    plat: { lng: number; lat: number };
    folded: { lng: number; lat: number };
    optPlat: number;
    optFold: number;
    sameVertex: boolean;
    /** 两个命中顶点之间的**沿线弧长差**（m）= 端点被修正的实际距离 */
    alongShiftM: number;
    platIdx: number;
    foldIdx: number;
    withPlat: { src: string; code: string; first: { lng: number; lat: number } | null };
    noPlat: { src: string; first: { lng: number; lat: number } | null };
  } | null> => {
    const shape = (
      await pool.query<{ polyline: string; start_stop: string | null; end_stop: string | null }>(
        "SELECT polyline, start_stop, end_stop FROM route_shapes WHERE route_code = $1 AND dsat_dir = $2",
        [route, dir],
      )
    ).rows[0];
    if (!shape) return null;
    const seqs = (
      await pool.query<{ seq: number; code: string }>(
        `SELECT rs.seq, rs.station_code AS code
           FROM route_stations rs JOIN routes r ON r.id = rs.route_id
          WHERE r.code = $1 AND rs.dsat_dir = $2 ORDER BY rs.seq`,
        [route, dir],
      )
    ).rows;
    const b = seqs.find((s) => s.seq === boardSeq);
    const a = seqs.find((s) => s.seq === alightSeq);
    if (!b || !a) return null;
    const coords = (
      await pool.query<{ code: string; lat: number; lng: number }>(
        "SELECT code, lat, lng FROM stations WHERE code = ANY($1::text[]) AND lat IS NOT NULL",
        [[b.code, a.code, ...seqs.map((s) => s.code)].filter((v, i, arr) => arr.indexOf(v) === i)],
      )
    ).rows;
    /* ★ 全部转 GCJ —— 折线是 GCJ，混用会量出几百米的假偏移（本组第一版的错误） */
    const byCode = new Map(
      coords.map((c) => [c.code, toGcj({ lng: Number(c.lng), lat: Number(c.lat) })]),
    );
    const mainOf = (c: string) => c.replace(/\/\d+$/, "");
    const platB = byCode.get(b.code);
    const platA = byCode.get(a.code);
    if (!platB || !platA) return null;

    /* `detail-body.platformsOf` 的口径：该主码在本线本方向的**全部**站台候选（GCJ） */
    const platformsOf = (main: string) =>
      seqs
        .filter((s) => mainOf(s.code) === main && byCode.has(s.code))
        .map((s) => ({ code: s.code, dir, seq: s.seq, ...byCode.get(s.code)! }));

    /* `/api/stations` 按主码去重后剩下的那个点：取**全局同一主码的另一个站台**（GCJ）。 */
    const siblingRows = (
      await pool.query<{ code: string; lat: number; lng: number }>(
        "SELECT code, lat, lng FROM stations WHERE code LIKE $1 AND code <> $2 AND lat IS NOT NULL LIMIT 1",
        [`${mainOf(b.code)}/%`, b.code],
      )
    ).rows;
    const foldedB = siblingRows.length
      ? toGcj({ lng: Number(siblingRows[0].lng), lat: Number(siblingRows[0].lat) })
      : platB;

    const shapeStations = seqs.map((s) => ({ code: mainOf(s.code), seq: s.seq }));
    const shapesByRoute = {
      [route]: [{ dir, polyline: shape.polyline, startStop: shape.start_stop, endStop: shape.end_stop, stations: shapeStations }],
    };
    const legOf = (withPlatforms: boolean) => ({
      index: 0,
      route,
      kind: "bus" as const,
      color: null,
      board: {
        code: b.code,
        lng: foldedB.lng,
        lat: foldedB.lat,
        ...(withPlatforms ? { platforms: platformsOf(mainOf(b.code)) } : {}),
      },
      alight: {
        code: a.code,
        lng: platA.lng,
        lat: platA.lat,
        ...(withPlatforms ? { platforms: platformsOf(mainOf(a.code)) } : {}),
      },
    });

    const withPlat = buildColoredLegs([legOf(true)], shapesByRoute)[0];
    const noPlat = buildColoredLegs([legOf(false)], shapesByRoute)[0];
    const firstOf = (cl: typeof withPlat) =>
      cl.colored.length >= 2 ? { lng: cl.colored[0][0], lat: cl.colored[0][1] } : null;

    const pts = parsePolyline(shape.polyline);
    const cum = cumDistM(pts);
    const nb = nearestOnPath(pts, platB);
    const nf = nearestOnPath(pts, foldedB);
    return {
      boardCode: b.code,
      boardMain: mainOf(b.code),
      plat: platB,
      folded: foldedB,
      optPlat: nb.distM,
      optFold: nf.distM,
      sameVertex: nb.idx === nf.idx,
      alongShiftM: Math.abs((cum[nb.idx] ?? 0) - (cum[nf.idx] ?? 0)),
      platIdx: nb.idx,
      foldIdx: nf.idx,
      withPlat: { src: withPlat.boardPoint?.src ?? "none", code: withPlat.boardPoint?.code ?? "", first: firstOf(withPlat) },
      noPlat: { src: noPlat.boardPoint?.src ?? "none", first: firstOf(noPlat) },
    };
  };

  const m = (p: { lng: number; lat: number } | null, q: { lng: number; lat: number }) =>
    p ? distM([p.lng, p.lat], [q.lng, q.lat]) : Number.POSITIVE_INFINITY;
  const r1 = (n: number) => (Number.isFinite(n) ? `${n.toFixed(1)}m` : "n/a");

  /* ── E1–E5/E7：**26 方向 0**，上车站 T373/2（负责人点名的那条线）── */
  const cPos = await runCase("26", "0", 30, 32);
  if (!cPos) {
    ok("E1", "26/0 的真实几何与站序可取到（否则本节无效）", false, "route_shapes 或 route_stations 缺");
  } else {
    console.log(
      `     26/0 上车站 ${cPos.boardCode}（GCJ）｜平台 ${JSON.stringify(cPos.plat)}｜折叠点 ${JSON.stringify(cPos.folded)}`,
    );
    console.log(
      `     两个站台的直线距离 ${r1(m(cPos.plat, cPos.folded))}（与坐标系无关）｜折线下界：到站台 ${r1(cPos.optPlat)} @${cPos.platIdx}｜到折叠点 ${r1(cPos.optFold)} @${cPos.foldIdx}｜沿线位移 ${r1(cPos.alongShiftM)}`,
    );
    ok(
      "E1",
      "彩段端点解析：`boardPoint.src === platform` 且平台码 = 本腿站台码",
      cPos.withPlat.src === "platform" && cPos.withPlat.code === cPos.boardCode,
      `src=${cPos.withPlat.src} code=${cPos.withPlat.code}`,
    );
    const dPlat = m(cPos.withPlat.first, cPos.plat);
    ok(
      "E2",
      "彩段起点落在「离**站台点**最近的那个顶点」上（改前落在「离折叠点最近」上）",
      dPlat <= cPos.optPlat + 1,
      `实际 ${r1(dPlat)} / 下界 ${r1(cPos.optPlat)}（容差 1m）`,
    );
    ok(
      "E2b",
      "分辨力自证：站台点与折叠点命中的是**不同顶点**（相同则 E2/E5 无意义）",
      cPos.sameVertex === false,
      `idx ${cPos.platIdx} vs ${cPos.foldIdx}（${r1(cPos.optPlat)} / ${r1(cPos.optFold)}）`,
    );
    const walkEnd = legPointOf(
      { code: cPos.boardCode, lng: cPos.folded.lng, lat: cPos.folded.lat, platforms: [{ ...cPos.plat, code: cPos.boardCode, dir: "0", seq: 30 }] },
      "0",
      [{ code: cPos.boardMain, seq: 30 }],
    );
    ok(
      "E3",
      "首段步行终点（`legPointOf` 口径 = `walkOds.out.to`）逐位等于本腿站台坐标（≤1m）",
      !!walkEnd && walkEnd.src === "platform" && m(walkEnd, cPos.plat) <= 1,
      walkEnd ? `${walkEnd.src}/${walkEnd.code} 距站台 ${r1(m(walkEnd, cPos.plat))}` : "null",
    );

    /* ── E5：**改前对照** —— 同一个腿、不给 platforms ⇒ 端点回到"离折叠点最近"的顶点 ── */
    const e0Plat = m(cPos.noPlat.first, cPos.plat);
    const e0Fold = m(cPos.noPlat.first, cPos.folded);
    ok(
      "E5",
      "改前对照：去掉 `platforms`（= 老响应）⇒ src 回落 main，且彩段起点落在「离折叠点最近」的顶点上（**不是**最优那一个）",
      cPos.noPlat.src === "main" && Math.abs(e0Fold - cPos.optFold) <= 1 && e0Plat > cPos.optPlat + 1,
      `src=${cPos.noPlat.src}；到折叠点 ${r1(e0Fold)}（下界 ${r1(cPos.optFold)}）｜到站台 ${r1(e0Plat)}（最优 ${r1(cPos.optPlat)}）`,
    );
    /**
     * ⚠️ 这里**故意不设断言**，只打印。理由：
     *   要区分的是**三个不同的量**，而它们没有"正确值"，只有"各自是什么"：
     *     ① 站台 → 折线的**垂距**：3.6m（`/1`）/ 8.8m（`/2`）——「站牌离道路中线多远」；
     *     ② 两个站台的**直线距离**：43.2m ——「隔了多远」（与坐标系无关：WGS→GCJ 是近常量平移）；
     *     ③ 端点**沿线位移**：两命中顶点间的弧长，实测 **53.2m** —— 由该处折线**顶点间距（约 26m）**
     *        决定，与 ①② 都不是一回事。
     *   给 ③ 设一个阈值就是拿一个"数据几何形态"当判据（顶点密度一变就翻），
     *   那正是"为了绿而调阈值"。⇒ 只读数、不判定；真正该判死的在 E2/E2b/E5。
     */
    console.log(
      `     ↳ 三个量分开看：垂距 站台 ${r1(cPos.optPlat)} / 折叠点 ${r1(cPos.optFold)}｜站台直线 ${r1(m(cPos.plat, cPos.folded))}｜端点沿线位移 ${r1(cPos.alongShiftM)}（顶点 ${cPos.foldIdx}→${cPos.platIdx}）`,
    );
  }

  /* ── E4：反向 / 停 `/1` 的线（AP1 方向 0）⇒ 必须落 /1，不能一律 /2 ── */
  const cAp = await runCase("AP1", "0", 15, 16);
  if (!cAp) {
    ok("E4", "AP1/0 的真实几何与站序可取到（否则本节无效）", false, "route_shapes 或 route_stations 缺");
  } else {
    console.log(
      `     AP1/0 上车站 ${cAp.boardCode}（GCJ）｜折线下界 到 /1 ${r1(cAp.optPlat)}｜到折叠点 ${r1(cAp.optFold)}｜沿线位移 ${r1(cAp.alongShiftM)}`,
    );
    const dPlat = m(cAp.withPlat.first, cAp.plat);
    ok(
      "E4",
      "反向对照（AP1/0 停 `T373/1`）：src=platform、平台码 = /1，且彩段起点落在「离 /1 最近」的顶点上",
      cAp.withPlat.src === "platform" &&
        cAp.withPlat.code === "T373/1" &&
        dPlat <= cAp.optPlat + 1 &&
        cAp.sameVertex === false,
      `code=${cAp.withPlat.code}；到 /1 ${r1(dPlat)}（下界 ${r1(cAp.optPlat)}）｜同一顶点=${cAp.sameVertex}`,
    );
  }

  /**
   * E6：**观测钩子确实接上了**（源码锁）。
   *   上一轮 `data-platform-src` 我只给了"属性在"，这次连"步行端点来源"也必须有属性；
   *   否则负责人没有任何办法自查（他本地起不了地图）。
   *   ⚠️ 这条是**接线锁**，不是行为断言 —— 行为由 E1–E5/E7 负责，两者互补。
   */
  const navShell = readFileSync(new URL("../src/components/nav/NavShell.tsx", import.meta.url), "utf8");
  const need = ["data-colored-src=", "data-colored-board-src=", "data-walk-end-src=", "data-walk-start-src="];
  ok(
    "E6",
    "观测钩子已接线：`data-colored-src` / `-board-src` / `data-walk-end-src` / `-start-src` 都在 `NavShell` 的 `.nav-map-wrap` 上",
    need.every((k) => navShell.includes(k)),
    `缺 ${need.filter((k) => !navShell.includes(k)).join(",") || "无"}`,
  );
}

/** E 组自用的连接池（D 组在 finally 里 `end()` 了，不能复用） */
async function openPoolForE(): Promise<Pool> {
  process.loadEnvFile?.();
  const conn = process.env.DATABASE_URL;
  if (!conn) {
    console.error("  FAIL  未配置 DATABASE_URL ⇒ E 组无法验证（fail-closed）");
    process.exit(1);
  }
  return new Pool({
    connectionString: conn,
    ssl: conn.includes("supabase") ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 8000,
  });
}

async function main(): Promise<void> {
  console.log("\n═══ 导航态站台坐标门禁（按腿折叠 + 真库对账 + 几何端到端）═══");
  groupA();
  await groupD();
  await groupE(await openPoolForE());

  const EXPECTED = 8 + 8 + 7;
  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
  if (registered.length !== EXPECTED) {
    console.error(`  FAIL  分母自证：注册 ${registered.length} / 预期 ${EXPECTED}（有断言没跑到）`);
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error("  FAIL  脚本异常终止：", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
