/**
 * 「停运线路 ⇒ 404」门禁（`scripts/test-active-route-gate.ts`，2026-11-21 新建）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   三个**按码直取**的接口补 `routes.is_active` 过滤，并要求「查不到 ⇒ 404」：
 *     · `GET  /api/route-shapes?code=`     （`route.ts`，routes 元数据那条）
 *     · `GET  /api/route-vehicles?code=`   （`route.ts`，② 那条元数据查询）
 *     · `POST /api/nav/detail-body`        （`buildOverviewLegs` 的色查询）
 *   判据与完整论证在 `src/lib/routes/active-gate.ts` 的文件头；本文件只负责**证明它成立**。
 *
 * ── 为什么要三层断言（少一层都会漏）──────────────────────────────────────
 *   ① **源码文本锁**：SQL 里必须真的出现 `AND is_active`。
 *      —— 这一层抓「有人把过滤条件删了」，最快也最直接；但它**证明不了**行为。
 *   ② **行为断言（handler 级）**：真的调 handler，输入一条停运线路，看回的是不是 404。
 *      —— 这一层抓「SQL 写了 `is_active`，但 404 分支不可达 / 写在了空结果分支后面 /
 *         回的是 200 + 空数组」。这正是只锁字符串会漏掉的那一类。
 *   ③ **因果对照**：同一份假数据，只把 `is_active` 从 `false` 改成 `true`，必须回 200。
 *      —— 没有这一层，一个「永远回 404」的实现也能让 ② 全绿。
 *
 * ── 行为断言怎么在「没有真库」的环境里跑真 handler ─────────────────────────
 *   `src/lib/db.ts` 的 `getPool()` 是「全局单例优先」：
 *     `const globalForDb = globalThis as { pgPool?: Pool }; if (globalForDb.pgPool) return …`
 *   ⇒ 在**同一进程**里把 `globalThis.pgPool` 换成假连接池，handler 就会直接用它。
 *   这不是为测试新开的洞 —— `db.ts` 从一开始就是这么写的（惰性初始化那段注释明说了
 *   「便于无数据库环境下跑纯接口测试」），本文件只是第一个真用它的人。
 *
 *   ⚠️ 假库的「SQL 解释器」**只做一件事**：SQL 里出现 `is_active` 就按 `is_active` 过滤。
 *      它**分不出** `AND is_active` 与 `AND NOT is_active`（两者都含 `is_active`）。
 *      ⇒ 这个盲区由 ①（源码锁钉的是 `AND is_active` 整串）兜住，两层必须同时在场。
 *
 * ── 假库的边界（守不住什么，写清楚免得下一个人误信）──────────────────────
 *   · 它不实现 JOIN / 排序 / 聚合 —— `route_stations` 一律回空数组。因此本文件
 *     **不验证** `stops` / 站序 / `legs` 的内容，只验证**状态码与闸本身**；
 *   · `detail-body` 的 handler 级断言**没有**（它要过 `acquireToken` → `loadStatics`
 *     11 条查询 → 才能走到判据，假库要伪造一大片无关数据，代价大于收益）。
 *     它的判据层用 `activeGateOf` 直接单测（C 组）+ 源码接线锁（D 组）覆盖，
 *     这是「拿不到真库就用纯函数抽出判据来测」的口径，不是只锁字符串。
 *
 * 跑法：`npm run test:active-route-gate`
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import { activeGateOf, missingActiveCodes } from "../src/lib/routes/active-gate";
import { API_ERROR, errorResponse } from "../src/lib/http/errors";
import { GET as getRouteShapes } from "../src/app/api/route-shapes/route";
import { GET as getRouteVehicles } from "../src/app/api/route-vehicles/route";

const ROOT = process.cwd();
/** 原文（含注释）—— 只在需要读**论证文字**时用（D7） */
const read = (rel: string): string =>
  fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\s+/g, " ").trim();

/**
 * 剥掉注释后的**代码**（保留字符串字面量 —— 本文件要锁的 SQL 就在模板串里）。
 *
 * ⚠️ 为什么必须分两个读法：本文件第一次实现时用原文做位置锁，结果被**自己写的注释**骗了两次 ——
 *   · `note: "no_shape"` 在 404 判据的注释里先出现 ⇒ 「顺序锁」假红；
 *   · `found: null` 在 JSDoc 里出现 2 次 ⇒ 「计数锁」分母虚高。
 *   断言和被测代码共享同一份文本时，注释就是污染源：**位置/计数类锁一律读剥注释版**，
 *   只有「这段理由还在不在」这种**故意要读注释**的锁才读原文。
 */
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1 ");
const readCode = (rel: string): string =>
  stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8")).replace(/\s+/g, " ").trim();

let pass = 0;
let fail = 0;
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

/* ══════════════════════════════════════════════════════════════════════════
 * 假连接池（注入到 globalThis.pgPool，见文件头）
 * ════════════════════════════════════════════════════════════════════════ */
interface FakeRoute {
  code: string;
  kind: string;
  color: string | null;
  company: string | null;
  is_active: boolean;
}

let fakeRoutes: FakeRoute[] = [];
let fakeShapes: Record<string, unknown>[] = [];
/** true = 让所有查询抛错，模拟「库不可达」 */
let fakeBroken = false;

const fakePool = {
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (fakeBroken) throw new Error("（假库）模拟连接失败");
    const flat = sql.replace(/\s+/g, " ").trim();
    // ⚠️ 这里就是「假库的 SQL 解释器」，只认 is_active 这一个词（盲区见文件头）
    const hasActive = /\bis_active\b/.test(flat);

    if (/\bFROM routes\b/.test(flat)) {
      const p = params?.[0];
      const codes = Array.isArray(p) ? p.map(String) : [String(p)];
      const rows = fakeRoutes
        .filter((r) => codes.includes(r.code) && (!hasActive || r.is_active))
        .map((r) => ({ code: r.code, kind: r.kind, color: r.color, company: r.company }));
      return {
        rows: /\bLIMIT 1\b/.test(flat) ? rows.slice(0, 1) : rows,
        rowCount: rows.length,
      };
    }
    if (/\bFROM route_shapes\b/.test(flat)) return { rows: fakeShapes, rowCount: fakeShapes.length };
    // 站序/站点一律空 —— 本文件不验证它们（见文件头「假库的边界」）
    return { rows: [], rowCount: 0 };
  },
};

// 注入点必须在任何 handler 调用之前（`getPool()` 惰性读取这个全局）
(globalThis as unknown as { pgPool?: unknown }).pgPool = fakePool;

const routeRow = (code: string, isActive: boolean, kind = "bus"): FakeRoute => ({
  code,
  kind,
  color: "#276299",
  company: null,
  is_active: isActive,
});

const shapeRow = (code: string): Record<string, unknown> => ({
  route_code: code,
  kind: "bus",
  dsat_dir: "0",
  polyline: "113.5400,22.1900;113.5500,22.1950",
  points: 2,
  start_stop: "A",
  end_stop: "B",
  min_lng: 113.54,
  min_lat: 22.19,
  max_lng: 113.55,
  max_lat: 22.195,
});

const callShapes = async (code: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await getRouteShapes(
    new Request(`http://localhost/api/route-shapes?code=${encodeURIComponent(code)}`),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const callVehicles = async (
  code: string,
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await getRouteVehicles(
    new NextRequest(
      `http://localhost/api/route-vehicles?code=${encodeURIComponent(code)}&dir=0&kind=bus`,
    ),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

/* ══════════════════════════════════════════════════════════════════════════
 * ① 源码文本锁
 * ════════════════════════════════════════════════════════════════════════ */
/**
 * 三处 SQL 共用的锁：`FROM routes WHERE code = <单码|ANY> AND is_active`。
 *
 * ⚠️ 必须钉到 `AND is_active` **整串**，不能只钉 `is_active` ——
 *    `AND NOT is_active` 也含 `is_active`，只钉单词等于给反向过滤放行。
 */
const ACTIVE_SQL_LOCK = /FROM routes WHERE code = (?:ANY\(\$1::text\[\]\)|\$1) AND is_active\b/;

function groupA(): void {
  console.log("\n  ── A 组：源码文本锁（SQL 必须含 `AND is_active`）──");
  const files: [string, string][] = [
    ["A1", "src/app/api/route-shapes/route.ts"],
    ["A2", "src/app/api/route-vehicles/route.ts"],
    ["A3", "src/app/api/nav/detail-body/route.ts"],
  ];
  for (const [id, rel] of files) {
    const flat = readCode(rel);
    ok(id, `${rel} 的 routes 查询必须为 \`… WHERE code = … AND is_active\``, ACTIVE_SQL_LOCK.test(flat));
  }

  /*
   * A4 是 A1–A3 的**变异对照**：把改动前的 SQL 喂给同一个锁，必须判否。
   * 没有这条，一个恒真的正则（比如只写 /routes/）也能让 A1–A3 全绿。
   */
  const before1 = "SELECT code, kind, color FROM routes WHERE code = $1 LIMIT 1";
  const before2 = "SELECT kind, color, company FROM routes WHERE code = $1 LIMIT 1";
  const before3 = "SELECT code, color FROM routes WHERE code = ANY($1::text[])";
  const before4 = "SELECT code, color FROM routes WHERE code = $1 AND NOT is_active LIMIT 1";
  ok(
    "A4",
    "变异对照：改动前的三条 SQL 与 `AND NOT is_active` **都不得**被判为通过",
    !ACTIVE_SQL_LOCK.test(before1) &&
      !ACTIVE_SQL_LOCK.test(before2) &&
      !ACTIVE_SQL_LOCK.test(before3) &&
      !ACTIVE_SQL_LOCK.test(before4),
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * ② 行为断言（真 handler + 假库）
 * ════════════════════════════════════════════════════════════════════════ */
async function groupB(): Promise<void> {
  console.log("\n  ── B 组：行为断言（停运线路 ⇒ 404，真 handler、假库）──");

  /* ── route-shapes ── */
  fakeBroken = false;
  fakeRoutes = [routeRow("36", false)];
  fakeShapes = [shapeRow("36")];
  const shapesDead = await callShapes("36");
  ok(
    "B1",
    "route-shapes：停运线路（36，库里有残留 shape 行）⇒ **404**",
    shapesDead.status === 404,
    `实际 ${shapesDead.status}`,
  );
  ok(
    "B2",
    "route-shapes：404 响应体必须是 `shapes: []` + 六枚举 error，且**不带** `note: \"no_shape\"`",
    Array.isArray(shapesDead.body.shapes) &&
      (shapesDead.body.shapes as unknown[]).length === 0 &&
      shapesDead.body.error === API_ERROR.bad_request &&
      shapesDead.body.note === undefined,
    `实际 body = ${JSON.stringify(shapesDead.body)}`,
  );
  ok(
    "B3",
    "route-shapes：404 必须 `no-store`（线路恢复后不得被 CDN 记住空态）",
    (await (await getRouteShapes(new Request("http://localhost/api/route-shapes?code=36"))).headers.get(
      "cache-control",
    )) === "no-store",
  );

  /* 因果对照：同一份数据只把 is_active 翻成 true */
  fakeRoutes = [routeRow("36", true)];
  const shapesLive = await callShapes("36");
  ok(
    "B4",
    "route-shapes 因果对照：同样有 shape 行、只把 is_active 改成 true ⇒ 200 且 shapes 非空",
    shapesLive.status === 200 &&
      Array.isArray(shapesLive.body.shapes) &&
      (shapesLive.body.shapes as unknown[]).length === 1,
    `实际 ${shapesLive.status} / shapes=${JSON.stringify(shapesLive.body.shapes)}`,
  );

  /* 空形状（可修复状态）必须仍是 200 —— 别把 is_active 加成了「无走向也 404」 */
  fakeShapes = [];
  const shapesNoData = await callShapes("36");
  ok(
    "B5",
    "route-shapes 回归：在线但无 shape ⇒ 仍是 200 + `note: \"no_shape\"`（可修复状态不判 404）",
    shapesNoData.status === 200 && shapesNoData.body.note === "no_shape",
    `实际 ${shapesNoData.status} / note=${String(shapesNoData.body.note)}`,
  );

  /* ── route-vehicles ── */
  // 用 LRT 码：它在 §③ 提前返回，**不碰 DSAT**（本文件不做网络请求）
  const LRT = "LRT-氹仔线";
  fakeRoutes = [routeRow(LRT, false, "lrt")];
  const vehDead = await callVehicles(LRT);
  ok(
    "B6",
    "route-vehicles：停运线路 ⇒ **404**",
    vehDead.status === 404,
    `实际 ${vehDead.status}`,
  );
  ok(
    "B7",
    "route-vehicles：404 响应体必须带六枚举 error、且**不得**带 `vehicles` 数组（不许空数组冒充成功）",
    vehDead.body.error === API_ERROR.bad_request && vehDead.body.vehicles === undefined,
    `实际 body = ${JSON.stringify(vehDead.body)}`,
  );

  fakeRoutes = [routeRow(LRT, true, "lrt")];
  const vehLive = await callVehicles(LRT);
  ok(
    "B8",
    "route-vehicles 因果对照：同一线路只把 is_active 改成 true ⇒ 200（走到轻轨空态，不是 404）",
    vehLive.status === 200 && vehLive.body.note === "lrt_no_vehicle",
    `实际 ${vehLive.status} / note=${String(vehLive.body.note)}`,
  );

  /*
   * B9：库查询失败 ⇒ **不得** 404（未知 ≠ 停运）。
   * 这是三值口径的行为侧守卫：把 `routeSeen` 写成 boolean 会让这条红。
   */
  fakeBroken = true;
  const vehBroken = await callVehicles(LRT);
  fakeBroken = false;
  ok(
    "B9",
    "route-vehicles：库查询**失败** ⇒ 走既有降级（200 + note），**不得**判 404",
    vehBroken.status === 200,
    `实际 ${vehBroken.status}（404 说明把「未知」当成了「停运」）`,
  );

  fakeShapes = [];
  fakeRoutes = [];
}

/* ══════════════════════════════════════════════════════════════════════════
 * ③ 判据纯函数（detail-body 无 handler 级断言，见文件头）
 * ════════════════════════════════════════════════════════════════════════ */
function groupC(): void {
  console.log("\n  ── C 组：判据纯函数（`activeGateOf` / `missingActiveCodes`）──");

  ok("C1", "全部在线 ⇒ ok", activeGateOf(["26", "21A"], ["26", "21A"]) === "ok");
  ok("C2", "一条都不在线 ⇒ absent", activeGateOf(["26"], []) === "absent");
  ok(
    "C3",
    "多段卡里只要**一段**停运 ⇒ absent（整卡不可恢复）",
    activeGateOf(["26", "21A"], ["26"]) === "absent",
  );

  /*
   * ★ C4 是本文件最重要的一条：`found === null` 表示「查询失败、结论未知」。
   *   若有人把 activeGateOf 改写成 `missingActiveCodes(req, found ?? []).length ? …`，
   *   一次库抖动就会让**所有**详情弹窗 404 —— 那是个只在故障时才现形的灾难。
   */
  ok(
    "C4",
    "查询失败（found=null）⇒ **unknown**，不是 absent（否则库抖动 = 对全员 404）",
    activeGateOf(["26"], null) === "unknown",
  );
  ok("C5", "空请求 ⇒ ok（无事可判，不得空转成 absent）", activeGateOf([], null) === "ok" || activeGateOf([], []) === "ok");
  ok(
    "C6",
    "missingActiveCodes 去重且按请求顺序返回（便于日志直接对照请求）",
    JSON.stringify(missingActiveCodes(["26", "26", "21A", "26"], ["26"])) === JSON.stringify(["21A"]),
  );
  ok(
    "C7",
    "「在线」只问行是否存在：color 为空的线路照样算在线（本函数不看 color）",
    activeGateOf(["99"], ["99"]) === "ok",
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * ④ 接线锁 + 404 构造契约
 * ════════════════════════════════════════════════════════════════════════ */
async function groupD(): Promise<void> {
  console.log("\n  ── D 组：接线锁（404 必须写在空结果分支**之前**）──");

  const shapes = readCode("src/app/api/route-shapes/route.ts");
  /**
   * ⚠️ 锚点必须带**尾随逗号**（`"no_shape",`）。只写 `note: "no_shape"` 会先命中 404 判据
   *    自己那段注释里的「⚠️ **不带** `note: "no_shape"`」—— 我第一次就是这么写的，
   *    结果 404@4781 > no_shape@4189 直接假红。断言也会被自己的注释骗。
   */
  const idx404 = shapes.indexOf("status: 404");
  const idxNoShape = shapes.indexOf('"no_shape",');
  ok(
    "D1",
    "route-shapes：404 判据必须出现在 `note: \"no_shape\"` 分支**之前**（否则停运线先落进 200 通路）",
    idx404 >= 0 && idxNoShape >= 0 && idx404 < idxNoShape,
    `404@${idx404} / no_shape@${idxNoShape}`,
  );

  const veh = readCode("src/app/api/route-vehicles/route.ts");
  // 同上：`"lrt_no_vehicle",` 带逗号才只命中返回体，不命中文件头注释里的 `note:"lrt_no_vehicle"`
  const vIdx404 = veh.indexOf("status: 404");
  const vIdxLrt = veh.indexOf('"lrt_no_vehicle",');
  ok(
    "D2",
    "route-vehicles：404 判据必须出现在轻轨提前返回**之前**（停运的轻轨也要 404）",
    vIdx404 >= 0 && vIdxLrt >= 0 && vIdx404 < vIdxLrt,
    `404@${vIdx404} / lrt_no_vehicle@${vIdxLrt}`,
  );
  ok(
    "D3",
    "route-vehicles：判据必须是 `if (routeSeen === false)`（写成 `if (!routeSeen)` 会把「未知」判成「停运」）",
    /\bif \(routeSeen === false\)/.test(veh) && !/\bif \(!routeSeen\)/.test(veh),
  );

  const detail = readCode("src/app/api/nav/detail-body/route.ts");
  ok(
    "D4",
    "detail-body：`activeGateOf(...) === \"absent\"` ⇒ `errorResponse(API_ERROR.bad_request, 404)`",
    /activeGateOf\(card\.rides\.map[^)]*\)[^;]*=== "absent"/.test(detail) &&
      /errorResponse\(API_ERROR\.bad_request, 404\)/.test(detail),
  );
  const dGate = detail.indexOf("activeGateOf(");
  const dOk = detail.indexOf("ok: true");
  ok(
    "D5",
    "detail-body：闸必须在 `ok: true` 成功响应**之前**",
    dGate >= 0 && dOk >= 0 && dGate < dOk,
    `activeGateOf@${dGate} / ok:true@${dOk}`,
  );

  /* 404 的构造契约：调用方能按 `ok === false` 判失败（`useDetailBody` 就是这么判的） */
  const r = errorResponse(API_ERROR.bad_request, 404);
  const j = (await r.json()) as { ok?: boolean; error?: string };
  ok(
    "D6",
    "`errorResponse(API_ERROR.bad_request, 404)` ⇒ status 404 + `{ok:false, error:\"bad_request\"}` + no-store",
    r.status === 404 && j.ok === false && j.error === API_ERROR.bad_request && r.headers.get("cache-control") === "no-store",
    `status=${r.status} body=${JSON.stringify(j)}`,
  );

  /* 文档锁：判据的「为什么是 404 而不是 200 空结果」不能只剩代码、没有理由 */
  const gate = read("src/lib/routes/active-gate.ts");
  ok(
    "D7",
    "active-gate.ts 必须保留「为什么是 404，而不是 200 + 空结果」的论证（含 404/5xx 的用户动作差异）",
    gate.includes("为什么是 404，而不是 200") && gate.includes("LineClient.tsx:152"),
  );

  /**
   * ★ D8 是一次**变异测试逼出来的**断言（我第一次没写，被自己的变异跑抓出来）。
   *
   *   C4 单测的是 `activeGateOf(x, null) === "unknown"` —— 那是**纯函数**。
   *   把 detail-body 的 catch 分支从 `found: null` 改成 `found: []` 后，C4 依然全绿，
   *   而线上行为已经变成「库抖动 ⇒ 所有详情弹窗 404」。
   *   ⇒ 纯函数测对了**不等于调用点传对了**。这条锁的就是那个交接点：
   *      · `found: null` 必须**恰好出现一次**（查询失败分支）；
   *      · `found: []`   也必须**恰好出现一次**（空请求的早退分支，合法）。
   *   变异（catch 改成 `[]`）会让前者变 0、后者变 2 —— 两个计数同时翻，无法蒙混。
   */
  const countOf = (hay: string, needle: string): number => hay.split(needle).length - 1;
  ok(
    "D8",
    "detail-body：查询失败分支必须传 `found: null`（恰好 1 次），空请求早退才是 `found: []`（恰好 1 次）",
    countOf(detail, "found: null") === 1 && countOf(detail, "found: []") === 1,
    `found:null ×${countOf(detail, "found: null")} / found:[] ×${countOf(detail, "found: []")}`,
  );
}

async function main(): Promise<void> {
  console.log("\n═══ 停运线路闸门禁（is_active + 404）═══");
  groupA();
  await groupB();
  groupC();
  await groupD();

  const EXPECTED = 4 + 9 + 7 + 8;
  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
  if (registered.length !== EXPECTED) {
    console.error(`  FAIL  分母自证：注册 ${registered.length} 条 / 预期 ${EXPECTED} 条（有断言没跑到）`);
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error("  FAIL  脚本异常终止：", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
