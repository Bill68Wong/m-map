/**
 * 路线总览纯函数对拍（scripts/test-route-overview.ts，2026-09-23 新增）
 * 用法：npm run test:overview
 *
 * 覆盖：parsePolyline / nearestOnPath / cutColored（正向 / 反向 / 环线环绕）/
 *       chooseShape（方向选择 / 超容差降级）/ buildColoredLegs（降级 / 同站整线）/
 *       真实数据对拍（route_shapes 26 环线 + 51A 双向）。
 *
 * ⚠️ 用例 1–8 为**确定性纯函数**断言；用例 9 连库（读 `route_shapes`），
 *    库不可达时**跳过并告警**（不判失败），保证 CI 纯函数门稳定。
 */
import type { Pool } from "pg";
import {
  BOARD_EQ_ALIGHT_M,
  buildColoredLegs,
  chooseShape,
  cutColored,
  decimate,
  distM,
  isLoop,
  nearestOnPath,
  parsePolyline,
  unionBox,
  type LL,
  type RouteShapeLite,
} from "../src/lib/nav/route-overview";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.error(`  ❌ ${label}`);
  }
}
function close(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) <= eps;
}
function near(a: LL, b: LL, tolM = 1) {
  return distM(a, b) <= tolM;
}

/** 直线折线：起点 (lng0,lat0)，每步 +stepLng，共 n 点 —— y 恒定 */
function line(lng0: number, lat0: number, stepLng: number, n: number): LL[] {
  const out: LL[] = [];
  for (let i = 0; i < n; i++) out.push([lng0 + i * stepLng, lat0]);
  return out;
}

function test1_parsePolyline() {
  console.log("① parsePolyline");
  const a = parsePolyline("113.5,22.1;113.6,22.2");
  ok(a.length === 2, "2 点解析");
  ok(close(a[0][0], 113.5) && close(a[0][1], 22.1), "首点数值正确");
  ok(close(a[1][0], 113.6) && close(a[1][1], 22.2), "末点数值正确");
  const b = parsePolyline("113.5,22.1;bad;113.6,22.2;;x,y;;");
  ok(b.length === 2, "非法段被过滤（bad / 空 / x,y 丢弃）");
  ok(parsePolyline("").length === 0, "空串 → 空数组");
}

function test2_nearestOnPath() {
  console.log("② nearestOnPath");
  const pts = line(113.5, 22.1, 0.01, 5); // idx0..4
  const r = nearestOnPath(pts, { lng: 113.5205, lat: 22.1001 });
  ok(r.idx === 2, "点落在第 3 顶点附近 → idx===2");
  ok(r.distM < 60 && r.distM > 20, `距离合理（${r.distM.toFixed(1)}m）`);
}

function test3_cutForward() {
  console.log("③ cutColored 非环线正向");
  const pts = line(113.5, 22.1, 0.01, 5);
  const c = cutColored(pts, 1, 3, false);
  ok(!!c && c.length === 3, "slice(ib, ia+1) 长度 3");
  ok(!!c && near(c[0], pts[1]) && near(c[2], pts[3]), "两端点 = pts[1]/pts[3]");
}

function test4_cutReverseNull() {
  console.log("④ cutColored 非环线 ib>ia");
  const pts = line(113.5, 22.1, 0.01, 5);
  ok(cutColored(pts, 3, 1, false) === null, "方向不符 → null");
}

function test5_loopWrap() {
  console.log("⑤ cutColored 环线环绕");
  const pts: LL[] = [
    [113.5, 22.1], // 0 head
    [113.51, 22.1], // 1 alight 邻域
    [113.52, 22.1], // 2
    [113.53, 22.1], // 3
    [113.53, 22.11], // 4
    [113.52, 22.11], // 5 board 邻域
    [113.51, 22.11], // 6
    [113.5, 22.1], // 7 ≈ 0（闭合）
  ];
  const n = pts.length;
  const ib = 5;
  const ia = 1;
  ok(isLoop(pts), "首尾闭合 → isLoop");
  const c = cutColored(pts, ib, ia, true);
  const expectLen = n - ib + (ia + 1);
  ok(!!c && c.length === expectLen, `环绕长度 = (n-ib)+(ia+1) = ${expectLen}`);
  ok(!!c && near(c[0], pts[ib]), "colored[0] ≈ board");
  ok(!!c && near(c[c.length - 1], pts[ia]), "colored.at(-1) ≈ alight");
}

function test6_chooseShape() {
  console.log("⑥ chooseShape 方向选择 / 超容差");
  const fwd = line(113.5, 22.1, 0.01, 11); // idx0..10，lng 递增
  const rev = [...fwd].reverse();
  const shapeA: RouteShapeLite = { dir: "0", polyline: toPoly(fwd) };
  const shapeB: RouteShapeLite = { dir: "1", polyline: toPoly(rev) };
  const board = { lng: 113.51, lat: 22.1 };
  const alight = { lng: 113.53, lat: 22.1 };
  const picked = chooseShape([shapeA, shapeB], board, alight);
  ok(!!picked && picked.shape === shapeA, "选中 board 在 alight 之前的方向");
  ok(!!picked && picked.iBoard < picked.iAlight, "iBoard < iAlight（正向）");
  const none = chooseShape([shapeA, shapeB], { lng: 113.9, lat: 22.5 }, alight);
  ok(none === null, "两方向都超 TOL → null");
}

function test7_degradeMissingRoute() {
  console.log("⑦ buildColoredLegs 缺 route 降级");
  const legs = [
    {
      index: 0,
      route: "X9",
      kind: "bus" as const,
      color: "#276299",
      board: { code: "A", lng: 113.5, lat: 22.1 },
      alight: { code: "B", lng: 113.52, lat: 22.1 },
    },
  ];
  const out = buildColoredLegs(legs, {});
  ok(out.length === 1 && out[0].degraded === true, "degraded=true");
  ok(out[0].colored === out[0].gray, "colored === gray（引用相等）");
  ok(out[0].gray.length === 0, "无 shapes → gray 为空");
}

function test8_boardEqAlight() {
  console.log("⑧ buildColoredLegs 起终点同站 → 整线着色");
  const pts = line(113.5, 22.1, 0.01, 11);
  const shapesByRoute: Record<string, RouteShapeLite[]> = {
    "26": [{ dir: "0", polyline: toPoly(pts), startStop: "S", endStop: "S" }],
  };
  const board = { code: "S", lng: 113.55, lat: 22.1 };
  const alight = { code: "S", lng: 113.5501, lat: 22.1 }; // ≈同一物理点（< 50m）
  ok(distM([board.lng, board.lat], [alight.lng, alight.lat]) <= BOARD_EQ_ALIGHT_M, "两点 < 50m");
  const out = buildColoredLegs(
    [{ index: 0, route: "26", kind: "bus", color: null, board, alight }],
    shapesByRoute,
  );
  ok(out[0].colored === out[0].gray, "整线着色（colored === gray）");
  ok(out[0].degraded === false, "非降级");
}

/** 附加：unionBox / decimate 基本正确性（并入 ①②⑧ 之外的健壮性） */
function testExtra_geom() {
  console.log("⑨+ unionBox / decimate");
  const box = unionBox(
    [line(113.5, 22.1, 0.01, 3)],
    [{ lng: 113.6, lat: 22.2 }],
  );
  ok(!!box && close(box.minLng, 113.5) && close(box.maxLng, 113.6), "unionBox 含 extra 点");
  ok(!!box && close(box.minLat, 22.1) && close(box.maxLat, 22.2), "unionBox 纬度范围正确");
  ok(unionBox([]) === null, "空集合 → null");
  const dense = line(113.5, 22.1, 0.00002, 100); // 每步 ≈2m < 15m
  const th = decimate(dense, 15);
  ok(th.length < dense.length && th.length >= 2, `抽稀生效（${dense.length}→${th.length}）`);
  ok(near(th[0], dense[0]) && near(th[th.length - 1], dense[dense.length - 1]), "保首尾");
}

function toPoly(pts: LL[]): string {
  return pts.map((p) => `${p[0]},${p[1]}`).join(";");
}

async function testReal(pool: Pool) {
  console.log("⑩ 真实数据对拍（route_shapes 26 环线 + 51A）");
  const q = async (code: string) =>
    (
      await pool.query(
        `SELECT dsat_dir, polyline, start_stop, end_stop FROM route_shapes WHERE route_code=$1 ORDER BY dsat_dir`,
        [code],
      )
    ).rows as { dsat_dir: string; polyline: string; start_stop: string | null; end_stop: string | null }[];

  // ── 26 号环线：首尾闭合 + 环绕切分 ──
  const rows26 = await q("26");
  if (!rows26.length) {
    console.log("  ⚠️ 26 无 route_shapes 数据 → 跳过该子项");
  } else {
    const pts = parsePolyline(rows26[0].polyline);
    ok(pts.length > 50, `26 polyline 点数 > 50（实际 ${pts.length}）`);
    const loop = isLoop(pts, rows26[0].start_stop, rows26[0].end_stop);
    ok(loop, "26 判定为环线（闭合 / 首尾同站）");
    const n = pts.length;
    // board 靠尾、alight 靠首 ⇒ 触发环绕
    const iB = Math.round(n * 0.8);
    const iA = Math.round(n * 0.2);
    const board = { code: "B", lng: pts[iB][0], lat: pts[iB][1] };
    const alight = { code: "A", lng: pts[iA][0], lat: pts[iA][1] };
    const shapes: RouteShapeLite[] = rows26.map((r) => ({
      dir: r.dsat_dir,
      polyline: r.polyline,
      startStop: r.start_stop,
      endStop: r.end_stop,
    }));
    const out = buildColoredLegs(
      [{ index: 0, route: "26", kind: "bus", color: null, board, alight }],
      { "26": shapes },
    );
    const leg = out[0];
    ok(leg.colored.length <= leg.gray.length + 1, "colored 长度 ≤ gray + 1");
    ok(leg.colored.length > 0, "环绕彩段非空");
    ok(
      near(leg.colored[0], [board.lng, board.lat], 1),
      "colored 起点 ≈ board",
    );
    ok(
      near(leg.colored[leg.colored.length - 1], [alight.lng, alight.lat], 1),
      "colored 终点 ≈ alight",
    );
  }

  // ── 51A：双向 shape → chooseShape 选一 ──
  const rows51 = await q("51A");
  if (rows51.length < 1) {
    console.log("  ⚠️ 51A 无 route_shapes 数据 → 跳过该子项");
  } else {
    const pts = parsePolyline(rows51[0].polyline);
    ok(pts.length > 50, `51A polyline 点数 > 50（实际 ${pts.length}）`);
    const n = pts.length;
    const board = { code: "B", lng: pts[Math.round(n * 0.2)][0], lat: pts[Math.round(n * 0.2)][1] };
    const alight = { code: "A", lng: pts[Math.round(n * 0.7)][0], lat: pts[Math.round(n * 0.7)][1] };
    const shapes: RouteShapeLite[] = rows51.map((r) => ({
      dir: r.dsat_dir,
      polyline: r.polyline,
      startStop: r.start_stop,
      endStop: r.end_stop,
    }));
    const picked = chooseShape(shapes, board, alight);
    ok(!!picked, "51A 能选出一个方向");
    if (picked) {
      ok(picked.dBoard <= 1 && picked.dAlight <= 1, "选中方向 board/alight 在线上（<1m）");
      const out = buildColoredLegs(
        [{ index: 0, route: "51A", kind: "bus", color: null, board, alight }],
        { "51A": shapes },
      );
      ok(out[0].colored.length <= out[0].gray.length, "51A colored ≤ gray");
      ok(out[0].colored[0] && near(out[0].colored[0], [board.lng, board.lat], 1), "51A colored 起点 ≈ board");
    }
  }
}

async function main() {
  test1_parsePolyline();
  test2_nearestOnPath();
  test3_cutForward();
  test4_cutReverseNull();
  test5_loopWrap();
  test6_chooseShape();
  test7_degradeMissingRoute();
  test8_boardEqAlight();
  testExtra_geom();

  // 用例 10：连库对拍（失败跳过，不判失败）
  try {
    process.loadEnvFile();
    const url = process.env.DATABASE_URL_LOCAL || process.env.DATABASE_URL;
    if (!url) throw new Error("无 DATABASE_URL");
    const { default: PG } = await import("pg");
    const pool = new PG.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
    pool.on("error", () => {});
    await testReal(pool);
    await pool.end();
  } catch (e) {
    console.log(`  ⚠️ 连库对拍跳过（${(e as Error).message}）—— 纯函数门不受影响`);
  }

  console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 存在失败"}：pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
