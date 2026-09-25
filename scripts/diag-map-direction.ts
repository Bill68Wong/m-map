/**
 * 诊断脚本：路线总览「方向反向 + 非乘车段未成灰虚线」（scripts/diag-map-direction.ts，v2.15 临时）
 *
 * 只读：连线上库（route_shapes / routes / stations）+ 线上 API（/api/nav、/api/nav/detail-body）。
 * 复现链路：OD → card.rides → detail-body legs → route-shapes shapes → buildColoredLegs
 *          → 输出每段 degraded / dir / iBoard / iAlight / colored 长度 / gray 长度。
 *
 * 用法：npx tsx scripts/diag-map-direction.ts [routeCode]
 */
import type { Pool } from "pg";
import {
  buildColoredLegs,
  chooseShape,
  isLoop,
  nearestOnPath,
  parsePolyline,
  type ColoredLeg,
  type OverviewLegInput,
  type RouteShapeLite,
} from "../src/lib/nav/route-overview";

try {
  process.loadEnvFile();
} catch {
  /* noop */
}

const BASE = process.env.DIAG_BASE ?? "https://musttoukou.vercel.app";
const ORIGIN = { lng: 113.5566, lat: 22.2001 }; // 待覆盖：脚本参数
const DEST = { lng: 113.545883, lat: 22.194627 }; // 大三巴牌坊（高德 GCJ-02）

/** /api/nav 返回的宽松结构（只取诊断所需字段） */
interface NavRide {
  route?: string;
  kind?: string;
  board?: string;
  alight?: string;
}
interface NavCard {
  id?: string;
  title?: string;
  rides?: NavRide[];
  [k: string]: unknown;
}
interface NavResp {
  cards?: NavCard[];
  data?: { cards?: NavCard[] };
  error?: unknown;
}
interface ShapesResp {
  shapes?: { dir?: string; polyline: string; startStop?: string | null; endStop?: string | null }[];
}

async function getJson<T = unknown>(url: string): Promise<T> {
  const r = await fetch(url);
  return r.json() as Promise<T>;
}

async function main() {
  const want = (process.argv[2] ?? "21A").trim();
  const fromLng = Number(process.argv[3] ?? ORIGIN.lng);
  const fromLat = Number(process.argv[4] ?? ORIGIN.lat);
  const toLng = Number(process.argv[5] ?? DEST.lng);
  const toLat = Number(process.argv[6] ?? DEST.lat);

  const nav = await getJson<NavResp>(
    `${BASE}/api/nav?fromLng=${fromLng}&fromLat=${fromLat}&toLng=${toLng}&toLat=${toLat}` +
      `&fromLabel=${encodeURIComponent("起点")}&toLabel=${encodeURIComponent("大三巴")}&limit=8&nocache=1`,
  );
  const cards: NavCard[] = nav.cards ?? nav.data?.cards ?? [];
  console.log(`\n=== /api/nav 返回 ${cards.length} 张卡 ===`);
  if (!cards.length) {
    console.log("无卡。nav keys:", Object.keys(nav), "err:", nav.error);
    return;
  }

  // 找含目标线路的卡（优先）
  let card = cards.find((c) =>
    (c.rides ?? []).some((r) => String(r.route).toUpperCase() === want.toUpperCase()),
  );
  if (!card) {
    console.log(`⚠️ 未找到含 ${want} 的卡，列出全部卡的 rides：`);
    for (const c of cards) {
      console.log(
        `  · ${c.id ?? c.title ?? "?"} → ` +
          (c.rides ?? [])
            .map((r) => `${r.route}(${r.kind}) ${r.board}→${r.alight}`)
            .join("  |  "),
      );
    }
    card = cards[0];
  } else {
    console.log(`命中含 ${want} 的卡。`);
  }
  console.log("\n选定卡 rides：");
  for (const r of card.rides ?? []) {
    console.log(`  · ${r.kind} ${r.route}: ${r.board} → ${r.alight}`);
  }

  // detail-body → legs
  const body = (await (
    await fetch(`${BASE}/api/nav/detail-body`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card }),
    })
  ).json()) as { legs?: OverviewLegInput[] };
  const legs: OverviewLegInput[] = body.legs ?? [];
  console.log(`\n=== detail-body legs（${legs.length}）===`);
  for (const l of legs) {
    console.log(
      `  [${l.index}] ${l.kind} ${l.route} color=${l.color} board=${l.board?.code}(${l.board?.lng},${l.board?.lat}) ` +
        `alight=${l.alight?.code}(${l.alight?.lng},${l.alight?.lat})`,
    );
  }

  // route-shapes
  const shapesByRoute: Record<string, RouteShapeLite[]> = {};
  const codes = [...new Set<string>(legs.map((l) => String(l.route)))];
  for (const code of codes) {
    const j = await getJson<ShapesResp>(`${BASE}/api/route-shapes?code=${encodeURIComponent(code)}`);
    shapesByRoute[code] = (j.shapes ?? []).map((s) => ({
      dir: s.dir,
      polyline: s.polyline,
      startStop: s.startStop ?? null,
      endStop: s.endStop ?? null,
    }));
    console.log(
      `\n=== route-shapes ${code}：${shapesByRoute[code].length} 个方向 ===` +
        shapesByRoute[code]
          .map(
            (s) =>
              `\n   dir=${s.dir} start=${s.startStop} end=${s.endStop} pts=${parsePolyline(s.polyline).length}`,
          )
          .join(""),
    );
  }

  // 逐段几何诊断
  const built = buildColoredLegs(legs, shapesByRoute);
  console.log("\n=== buildColoredLegs 结果 ===");
  for (const b of built) {
    console.log(
      `  [${b.index}] ${b.route} dir=${b.dir} degraded=${b.degraded} ` +
        `gray.pts=${b.gray.length} colored.pts=${b.colored.length} ` +
        `sameRef=${b.colored === b.gray}`,
    );
  }

  // ── 逐 shape 细查：board/alight 最近顶点索引与距离 ──
  console.log("\n=== 逐 shape 方向细查（iBoard vs iAlight）===");
  for (const l of legs) {
    const shapes = shapesByRoute[l.route] ?? [];
    if (!l.board || !l.alight) {
      console.log(`  [${l.index}] ${l.route}: board/alight 缺坐标 → 直接降级`);
      continue;
    }
    for (const s of shapes) {
      const pts = parsePolyline(s.polyline);
      if (pts.length < 2) {
        console.log(`  [${l.index}] ${l.route} dir=${s.dir}: polyline 无效`);
        continue;
      }
      const nb = nearestOnPath(pts, l.board);
      const na = nearestOnPath(pts, l.alight);
      const loop = isLoop(pts, s.startStop, s.endStop);
      console.log(
        `  [${l.index}] ${l.route} dir=${s.dir} n=${pts.length} loop=${loop} ` +
          `iBoard=${nb.idx}(${nb.distM.toFixed(1)}m) iAlight=${na.idx}(${na.distM.toFixed(1)}m) ` +
          `order=${nb.idx <= na.idx ? "正向(board在前)" : "反向(board在后)"}`,
      );
    }
    const picked = chooseShape(shapes, l.board, l.alight);
    console.log(
      `  → chooseShape 选中 dir=${picked?.dir ?? "null"} / ` +
        (picked
          ? `iBoard=${picked.iBoard} iAlight=${picked.iAlight} loop=${picked.loop} ` +
            `dBoard=${picked.dBoard.toFixed(1)} dAlight=${picked.dAlight.toFixed(1)}`
          : "全超容差"),
    );
  }

  // 线上库直查：21A 站序（看 board→alight 在站序中的先后）
  try {
    const { default: PG } = await import("pg");
    const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
    if (url) {
      const pool = new PG.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
      pool.on("error", () => {});
      await dbCheck(pool, want, built, legs);
      await pool.end();
    }
  } catch (e) {
    console.log("⚠️ 直连库失败：", (e as Error).message);
  }
}

async function dbCheck(pool: Pool, want: string, built: ColoredLeg[], legs: OverviewLegInput[]) {
  for (const l of legs) {
    const rs = (
      await pool.query(
        `SELECT rs.dir AS dsat_dir, rs.seq, s.code, s.name
           FROM route_stations rs
           JOIN routes r ON r.id = rs.route_id
           JOIN stations s ON s.code = rs.station_code
          WHERE r.code = $1
          ORDER BY rs.dir, rs.seq`,
        [l.route],
      )
    ).rows as { dsat_dir: string; seq: number; code: string; name: string }[];
    const dirs = [...new Set(rs.map((r) => r.dsat_dir))];
    console.log(`\n=== 库内 ${l.route} 站序（dirs=${dirs.join(",")}）找 board/alight ===`);
    for (const d of dirs) {
      const list = rs.filter((r) => r.dsat_dir === d);
      const ib = list.findIndex((r) => String(r.code).replace(/\/\d+$/, "") === String(l.board?.code));
      const ia = list.findIndex((r) => String(r.code).replace(/\/\d+$/, "") === String(l.alight?.code));
      console.log(
        `   dir=${d}: n=${list.length} iBoard=${ib} iAlight=${ia} ` +
          `order=${ib >= 0 && ia >= 0 ? (ib <= ia ? "正向" : "反向") : "缺失"}`,
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
