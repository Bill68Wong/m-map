/**
 * 灰线单调游标对拍（scripts/test-traveled-cut.ts，T7 · 2026-10-30 新增）
 * 用法：node node_modules/tsx/dist/cli.mjs scripts/test-traveled-cut.ts
 *
 * ── 覆盖 ──────────────────────────────────────────────────────────────
 *   1. 正常前进 20m/帧          → `ok`
 *   2. 首帧                     → `first`（横向过门才 accept）
 *   3. 横向偏 11m 落在折返另一遍 → `backward`（不许塌成一小撇）
 *   4. 单帧前跳 800m            → `too-fast`
 *   5. 长度反而变短             → `shrink`
 *   6. elapsed=90s 后回退       → `ok`（跨帧长间隔放行，不许永久冻死）
 *   7. 横向 > 60m               → `bad-snap`（灰线门 = 蓝点门，不是 250）
 *
 * ⚠️ **纯合成几何，不连库**（`route_stations` 正在重建，也不能让门禁依赖网络）。
 *    几何用等距近似还原：1m ≈ 1/111320 度纬；经度按 cos(lat) 折算。
 */
import {
  cutAt,
  monotonicCut,
  perpDistM,
  TRAVELED_SNAP_MAX_M,
  TRAVELED_STALE_MS,
} from "../src/lib/nav/track";
import type { LL } from "../src/lib/nav/route-overview";

/* ── 合成几何工具 ── */
const LAT0 = 22.18;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);
/** 平面米 → GCJ-02 点（原点 = (113.55, LAT0)） */
const ll = (xM: number, yM: number): LL => [113.55 + xM / M_PER_DEG_LNG, LAT0 + yM / M_PER_DEG_LAT];

/** 直线：0..N 米向北，每 `step` 米一个顶点（用于 ok / too-fast / shrink / stale / bad-snap） */
function straight(n = 100, step = 20): LL[] {
  const out: LL[] = [];
  for (let i = 0; i <= n; i++) out.push(ll(0, i * step));
  return out;
}

/**
 * 自折返：一条 20m 间距的「往返同路」走廊（真实线路的典型形态）。
 *   idx 0..2 = 西线（x=0, y=0→40，向北）
 *   idx 3..5 = 东线（x=20, y=40→0，掉头向南）
 * ⇒ 西线 y=20 (idx 1) 与东线 y=20 (idx 4) **空间仅差 20m**、沿线却隔 60m。
 */
function foldBack(): LL[] {
  return [ll(0, 0), ll(0, 20), ll(0, 40), ll(20, 40), ll(20, 20), ll(20, 0)];
}

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    fail++;
    console.error(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

console.log("\n【1】正常前进 20m/帧 ⇒ 逐帧 ok");
{
  const poly = straight();
  let cur = null as ReturnType<typeof monotonicCut> extends { idx: number } ? { idx: number; lenM: number; ts: number } | null : never;
  let allOk = true;
  let firstReason = "";
  let firstAccept = false;
  for (let i = 0; i < 20; i++) {
    const now = 1_000_000 + i * 1000;
    // GPS 精确落在第一遍顶点上（无横向偏移）
    const r = monotonicCut(poly, { lng: poly[i][0], lat: poly[i][1] }, cur, now);
    if (i === 0) {
      firstReason = r.reason;
      firstAccept = r.accept;
    } else if (!r.accept || r.reason !== "ok") {
      allOk = false;
      console.error(`      第 ${i} 帧被拒: ${r.reason}`);
    }
    if (r.accept) cur = { idx: r.idx, lenM: r.lenM, ts: now };
  }
  ok(firstReason === "first" && firstAccept, `首帧 reason=first 且 accept（实际 ${firstReason}/${firstAccept}）`);
  ok(allOk, "后续 19 帧全部 ok");
  ok(cur?.idx === 19, `游标推进到 idx=19（实际 ${cur?.idx}）`);
}

console.log("\n【2】弃用旧门：横向 250m 过去能过、现在必须拒（灰线门 = 蓝点门 60m）");
{
  const poly = straight();
  const prev = { idx: 10, lenM: 200, ts: 1_000_000 };
  const far = ll(200, 200); // 横向偏 200m（旧 CUT_TOLERANCE_M=250 会放行）
  const r = monotonicCut(poly, { lng: far[0], lat: far[1] }, prev, 1_001_000);
  ok(!r.accept && r.reason === "bad-snap", `200m 偏移 ⇒ bad-snap（实际 ${r.reason}）`);
  ok(TRAVELED_SNAP_MAX_M === 60, `TRAVELED_SNAP_MAX_M = 60（实际 ${TRAVELED_SNAP_MAX_M}）`);
}

console.log("\n【3】横向偏 11m 落在折返的另一遍 ⇒ backward（不许塌成一小撇）");
{
  const poly = foldBack();
  // 上一帧在东线 y=20（idx 4）
  const prev = { idx: 4, lenM: 100, ts: 1_000_000 };
  // 真实位置在东线 y=20 偏**西** 11m ⇒ 距西线 idx1 仅 9m、距东线 11m ⇒ 最近顶点跳到 idx=1
  const pos = ll(20 - 11, 20);
  // ⚠️ 投影位置用 `cutAt` 单独验（`monotonicCut` 拒帧时按契约返回 `prev`，不暴露内部 cut）
  const proj = cutAt(poly, { lng: pos[0], lat: pos[1] });
  ok(proj.idx === 1, `投影落到 idx=1（实际 ${proj.idx}，横向 ${proj.dist.toFixed(1)}m）`);
  const r = monotonicCut(poly, { lng: pos[0], lat: pos[1] }, prev, 1_001_000);
  ok(!r.accept && r.reason === "backward", `⇒ backward 冻结（实际 ${r.reason}）`);
  ok(r.idx === prev.idx && r.lenM === prev.lenM, `拒帧返回 prev（idx=${r.idx}, lenM=${r.lenM}）—— 不许塌成一小撇`);
}

console.log("\n【4】单帧前跳 800m ⇒ too-fast");
{
  const poly = straight(100, 20); // 全长 2000m
  const prev = { idx: 10, lenM: 200, ts: 1_000_000 };
  // 1 秒后跳到 idx=50（里程 1000m）⇒ 上行 800m，阈值 = 20*1 + 120 = 140 ⇒ 必拒
  const r = monotonicCut(poly, { lng: poly[50][0], lat: poly[50][1] }, prev, 1_001_000);
  ok(!r.accept && r.reason === "too-fast", `⇒ too-fast（实际 ${r.reason}）`);
  ok(r.idx === prev.idx, `拒帧保持 idx=${prev.idx}（实际 ${r.idx}）`);
}

console.log("\n【5】长度反而变短 ⇒ shrink（换腿后游标残留的形态）");
{
  const poly = straight(100, 20);
  // 人为把 prev.lenM 设成远超当前 idx 里程（模拟「poly 换了、ref 没清」）
  const prev = { idx: 5, lenM: 5000, ts: 1_000_000 };
  // 前进一格（idx 6，里程 120m）⇒ 不触发 backward；上行 20m ⇒ 不触发 too-fast；但 120 < 5000-1 ⇒ shrink
  const r = monotonicCut(poly, { lng: poly[6][0], lat: poly[6][1] }, prev, 1_001_000);
  ok(!r.accept && r.reason === "shrink", `⇒ shrink（实际 ${r.reason}）`);
  ok(r.lenM === prev.lenM, `拒帧保持 lenM=${prev.lenM}（实际 ${r.lenM}）—— 灰线绝不变短`);
}

console.log("\n【6】elapsed=90s 后回退 ⇒ ok（跨帧长间隔放行，不许永久冻死）");
{
  const poly = foldBack();
  const prev = { idx: 4, lenM: 100, ts: 1_000_000 };
  const pos = ll(20 - 11, 20); // 同【3】，投影会落到 idx=1（回退 3 格）
  const proj = cutAt(poly, { lng: pos[0], lat: pos[1] });
  ok(proj.idx === 1, `投影仍落到 idx=1（实际 ${proj.idx}）`);
  ok(TRAVELED_STALE_MS === 60_000, `TRAVELED_STALE_MS = 60000（实际 ${TRAVELED_STALE_MS}）`);
  // 90s > TRAVELED_STALE_MS(60s) ⇒ 跳过回退判定
  const r = monotonicCut(poly, { lng: pos[0], lat: pos[1] }, prev, 1_000_000 + 90_000);
  ok(r.accept && r.reason === "ok", `90s 后回退 ⇒ 放行 ok（实际 ${r.reason}/${r.accept}）`);
  ok(r.idx === 1 && r.lenM < prev.lenM, `游标真的退到 idx=1（lenM ${r.lenM}m < ${prev.lenM}m）`);
  // 该用例是「stale 必须同时豁免 ③回退 与 ⑤不缩短」的回归门：
  //   cum 单调 ⇒ idx 回退 ⟺ lenM 变小；只豁免 ③ 时 ⑤ 会把同一帧立刻拦回 ⇒ 此处会红。
  console.log("      ↑ 该断言同时锁住『stale 须同时豁免 ③回退 与 ⑤不缩短』这条不变式");
}

console.log("\n【7】首帧横向超门 ⇒ first 且 reject");
{
  const poly = straight();
  const far = ll(120, 100);
  const r = monotonicCut(poly, { lng: far[0], lat: far[1] }, null, 1_000_000);
  ok(!r.accept && r.reason === "first", `⇒ 首帧拒（实际 ${r.reason}/${r.accept}）`);
  ok(r.idx === -1 && r.lenM === 0, `返回 idx=-1 / lenM=0（实际 ${r.idx}/${r.lenM}）`);
}

console.log("\n【8】拒帧不推进 ts ⇒ 持续拒帧后 too-fast 阈值随时间放宽（不会永久卡死）");
{
  const poly = straight(100, 20);
  const cur = { idx: 5, lenM: 100, ts: 1_000_000 };
  // 目标 idx=50（里程 1000m）。1s 时上行 900m > 140 ⇒ 拒；随时间阈值增长
  const target = { lng: poly[50][0], lat: poly[50][1] };
  const r1 = monotonicCut(poly, target, cur, 1_001_000);
  ok(!r1.accept && r1.reason === "too-fast", `1s 时 ⇒ too-fast（实际 ${r1.reason}）`);
  // 60s 后：阈值 = 20*60 + 120 = 1320 > 900 ⇒ 放行
  const r2 = monotonicCut(poly, target, cur, 1_060_000);
  ok(r2.accept, `60s 后同一位置 ⇒ 放行（实际 ${r2.reason}/${r2.accept}）`);
}

console.log("\n【9】perpDistM 必须用真垂距，不能用「到最近顶点距离」（本轮最关键的修正）");
{
  // 20m 间距的两顶点，GPS 落在**段中点**、垂直偏移 25m（顶点量化误差最大处）
  const poly = straight(10, 20); // 顶点 y = 0,20,40,...
  const midY = 10; // 段 #0→#1 的中点
  const pos = ll(25, midY); // 垂距 = 25m（纯东西向偏移）
  const cut = cutAt(poly, { lng: pos[0], lat: pos[1] });
  const perp = perpDistM(poly, cut.idx, { lng: pos[0], lat: pos[1] });

  ok(Math.abs(perp - 25) < 1.0, `perpDistM 在段中点、偏移 25m ⇒ ≈25m（实际 ${perp.toFixed(2)}m）`);
  // cut.dist = √(25² + 10²) ≈ 26.9m（半段长 = 10m）⇒ 随顶点间距放大
  ok(
    cut.dist > perp + 1,
    `cut.dist 系统性高估（实际 ${cut.dist.toFixed(2)}m > 真垂距 ${perp.toFixed(2)}m）`,
  );

  // 更狠的一档：顶点间距 100m（p90 量级），偏移 25m ⇒ cut.dist ≈ √(25²+50²) ≈ 55.9m
  const poly100 = straight(10, 100);
  const midY100 = 50;
  const pos100 = ll(25, midY100);
  const cut100 = cutAt(poly100, { lng: pos100[0], lat: pos100[1] });
  const perp100 = perpDistM(poly100, cut100.idx, { lng: pos100[0], lat: pos100[1] });
  ok(Math.abs(perp100 - 25) < 1.0, `间距 100m 时 perpDistM 仍 ≈25m（实际 ${perp100.toFixed(2)}m）`);
  ok(
    cut100.dist > 50,
    `而 cut.dist ≈ ${cut100.dist.toFixed(2)}m —— 已逼近 60m 门 ⇒ 若拿它当判据会误拒合法帧`,
  );
  ok(
    perp100 <= TRAVELED_SNAP_MAX_M,
    `⇒ 用 perpDistM 判定应**通过** 60m 门（实际 ${perp100.toFixed(2)} ≤ ${TRAVELED_SNAP_MAX_M}）`,
  );

  // 端到端：同一帧，monotonicCut 用真垂距 ⇒ accept（反证：用 cut.dist 会被误拒）
  const r = monotonicCut(poly100, { lng: pos100[0], lat: pos100[1] }, null, 1_000_000);
  ok(r.accept && r.reason === "first", `monotonicCut 首帧采纳（实际 ${r.reason}/${r.accept}）`);
  ok(
    r.diag.verPerp <= TRAVELED_SNAP_MAX_M && r.diag.verVertex > 50,
    `diag 暴露两个量：真垂距 ${r.diag.verPerp.toFixed(2)} / 顶点距 ${r.diag.verVertex.toFixed(2)}（QA 可对比）`,
  );
}

console.log("\n【10】perpDistM 端点与退化输入");
{
  const poly = straight(5, 20);
  const atHead = perpDistM(poly, 0, { lng: poly[0][0], lat: poly[0][1] });
  ok(atHead < 1e-6, `首顶点自身 ⇒ 0（实际 ${atHead}）`);
  const atTail = perpDistM(poly, poly.length - 1, { lng: poly[poly.length - 1][0], lat: poly[poly.length - 1][1] });
  ok(atTail < 1e-6, `末顶点自身 ⇒ 0（实际 ${atTail}）`);
  ok(perpDistM([], 0, { lng: 0, lat: 0 }) === Infinity, "空折线 ⇒ Infinity");
  ok(perpDistM(poly, 99, { lng: 0, lat: 0 }) === Infinity, "idx 越界 ⇒ Infinity");
  // 重复顶点（段长为 0）⇒ 退化为点距，不许 NaN
  const dup = [ll(0, 0), ll(0, 0), ll(0, 20)];
  const dv = perpDistM(dup, 0, (() => {
    const q = ll(10, 0);
    return { lng: q[0], lat: q[1] };
  })());
  ok(Number.isFinite(dv) && Math.abs(dv - 10) < 1, `重复顶点 ⇒ 退化为点距 ≈10m（实际 ${dv}）`);
}

console.log("\n【11】拒帧时 diag.projIdx/projLenM 必须暴露「本来会落到哪」（QA 盲区补位）");
{
  const poly = foldBack();
  const prev = { idx: 4, lenM: 100, ts: 1_000_000 };
  const pos = ll(20 - 11, 20); // 同【3】：投影会落到 idx=1，但会被 backward 拒
  const r = monotonicCut(poly, { lng: pos[0], lat: pos[1] }, prev, 1_001_000);
  ok(!r.accept && r.reason === "backward", `本帧被拒（实际 ${r.reason}）`);
  ok(r.idx === prev.idx, `返回的 idx 仍是 prev=${prev.idx}（实际 ${r.idx}）`);
  ok(
    r.diag.projIdx === 1,
    `但 diag.projIdx=1 —— 暴露真实投影（实际 ${r.diag.projIdx}）⇒ QA 能判「算法判错」而非「定位偏了」`,
  );
  ok(
    Math.abs(r.diag.projLenM - 20) < 1,
    `diag.projLenM ≈20.0m（实际 ${r.diag.projLenM.toFixed(1)}）`,
  );
  ok(
    r.diag.projLenM < r.lenM,
    `projLenM(${r.diag.projLenM.toFixed(1)}) < 返回的 lenM(${r.lenM}) ⇒ 两者确实不同，缺了就会误判`,
  );

  // accept 时三者一致（此时不该有歧义）
  const poly2 = straight(10, 20);
  const r2 = monotonicCut(poly2, { lng: poly2[3][0], lat: poly2[3][1] }, null, 1_000_000);
  ok(r2.accept, `accept 帧（实际 ${r2.reason}）`);
  ok(
    r2.diag.projIdx === r2.idx && Math.abs(r2.diag.projLenM - r2.lenM) < 1e-6,
    `accept 时 projIdx/lenM 与 idx/lenM 一致（${r2.diag.projIdx}/${r2.idx}）`,
  );
}

console.log(`\n────────────────────────────────────────\n通过 ${pass} · 失败 ${fail}\n`);
if (fail > 0) process.exit(1);
