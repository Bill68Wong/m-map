/**
 * 把旧「通勤计时」方案**展开成逐条路线**并导入 `favorite_routes`
 * （db/import-favorite-routes.ts）
 * 用法：npm run db:import-favorite-routes -- [local|cloud] [--dry]
 *
 * ── 展开规则（2026-09-22 产品口径）────────────────────────────────────
 *   `plan_legs` 里 `route_options` 是**多条并行线路**（如 `["26","50"]`）。
 *   旧版把它们当**一个方案**（前端显示成 `26/50`）；新版按产品要求
 *   **一条线一行** ⇒ 对**含多值的腿做笛卡尔积**：
 *     `["26","50"]` × `["50","25B","25BS","102","701X","N6"]` = **12 条**
 *   ⇒ 加上轻轨那条（单线路）= 「擎天汇 → 横琴口岸」共 **13 行** ✓
 *
 * ── ★ 2026-09-24 修复：每线独立解析上下车站（编号：fav-preset-deadchain）──────
 *   **旧缺陷**：整条腿只取 `from_station` / `to_station` 两个站，配给该腿
 *   **所有**线路 —— 但多数线根本不经过这两个站（或经过但方向相反）⇒
 *   `chainToCandidates` 的 `segmentsOf` 解不出站序 ⇒ 整行静默变死链
 *   （线上实测 15 条 dead：gate-home-59 … home-hengqin-50-*）。
 *
 *   **新口径**：对每条线路，在**该线自身站序**（`route_stations` 按
 *   `(route, dsat_dir, seq)`）里找「距目标站最近、且沿行驶方向顺向可达」的
 *   停靠站作为该线的上/下车点：
 *     · 就近阈值 `MAX_SNAP_M = 800m`；
 *     · 多段链（如 home→hengqin 的两段）**联合求解**：相邻两段共用的换乘站
 *       必须同时是该线顺向站，且对前后两条线都顺向可达；
 *     · **无法顺向到达的线路组合不生成该行**（宁缺毋滥）。
 *   ⇒ 修复后：能就近修正的全部可解；真的到不了的（如 50 路顺向不经过莲花路）
 *      **不再生成**，且旧行被 `is_active=false` 退役。
 *
 * ⚠️ 安全阀：单个方案的展开上限 `MAX_EXPAND = 40`（防某条腿列了十几条线时爆炸）。
 * ⚠️ `source='user'` 的行**不被覆盖**（用户手工编辑过的路线优先）。
 * ⚠️ 幂等：`route_key` 唯一 + `ON CONFLICT DO UPDATE`（只更新 preset 行）。
 */
import { Pool } from "pg";

try {
  process.loadEnvFile();
} catch {
  /* .env 不存在 */
}

const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const dumpArg = argv.find((a) => a.startsWith("--dump="));
const dumpPath = dumpArg ? dumpArg.slice("--dump=".length) : undefined;
const target = argv.includes("cloud") ? "cloud" : argv.includes("local") ? "local" : undefined;
const connStr =
  target === "cloud"
    ? process.env.DATABASE_URL
    : target === "local"
      ? (process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL)
      : ((process.env.DATABASE_URL_LOCAL ?? process.env.DATABASE_URL) || process.env.DATABASE_URL);

if (!connStr) {
  console.error("❌ 未找到连接串");
  process.exit(1);
}
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}${dry ? "  [DRY-RUN 只算不写]" : ""}`);

/** 单个方案的展开上限 */
const MAX_EXPAND = 40;
/** 就近站阈值（米）——超过则视为「该线不服务此站」 */
const MAX_SNAP_M = 800;
/** 每个节点保留的就近候选数上限（按距离升序） */
const MAX_CAND = 8;

/** `places.id` → slug（与前端 `endpointSlug` 同口径） */
const PLACE_SLUG: Record<number, string> = { 1: "home", 2: "school", 3: "hengqin", 7: "gate" };

interface Leg {
  id: number;
  seq: number;
  leg_kind: string;
  route_options: string | null;
  from_station: string | null;
  to_station: string | null;
  board_candidates: string[] | null;
  alight_candidates: string[] | null;
  note: string | null;
}

interface Seg {
  kind: "walk" | "ride" | "transfer" | "cross_border";
  phase?: "out" | "in";
  from?: string;
  to?: string;
  label?: string;
  route?: string;
  kind2?: "bus" | "lrt";
  board?: string;
  boardLabel?: string;
  alight?: string;
  alightLabel?: string;
  at?: string;
}

/** 解析 `route_options` 列（JSON 数组字符串） */
function optionsOf(l: Leg): string[] {
  if (!l.route_options) return [];
  try {
    const a = JSON.parse(l.route_options);
    return Array.isArray(a) ? a.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ── 站码 / 距离工具（与 `src/lib/recommend/*` 同口径复刻）──────────────
/** 主码归一：剥掉站台号后缀（C690/3 → C690、M9/4 → M9；LRT-* 原样） */
const mainCodeOf = (code: string): string => /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;

/** 三段式站码匹配（复刻 `src/lib/recommend/enumerate.ts#idxsOf`） */
function idxsOf(stops: string[], target: string): number[] {
  const hit = (fn: (s: string) => boolean) => stops.map((s, i) => (fn(s) ? i : -1)).filter((i) => i >= 0);
  const exact = hit((s) => s === target);
  if (exact.length) return exact;
  const mid = hit((s) => s.startsWith(target + "/"));
  if (mid.length) return mid;
  const rev = hit((s) => target.startsWith(s + "/"));
  if (rev.length) return rev;
  const p = mainCodeOf(target);
  return hit((s) => mainCodeOf(s) === p);
}

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

async function main() {
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    // ① 站点：站名 + 坐标
    const nameOf = new Map<string, string>();
    const coords = new Map<string, { lat: number; lng: number }>();
    for (const r of (await pool.query(`SELECT code, name_tc, lat, lng FROM stations`)).rows as {
      code: string;
      name_tc: string | null;
      lat: number | null;
      lng: number | null;
    }[]) {
      nameOf.set(r.code, r.name_tc ?? "");
      if (r.lat !== null && r.lng !== null) coords.set(r.code, { lat: Number(r.lat), lng: Number(r.lng) });
    }
    const labelOf = (code: string | null | undefined): string | undefined => {
      if (!code) return undefined;
      const n = nameOf.get(code);
      return n ? `${code} ${n}` : code;
    };

    // ② 线路站序：`${route}|${dir}` → 有序站码；route → 方向列表（与 RouteIndex 同口径）
    const dirStops = new Map<string, string[]>();
    const dirsOf = new Map<string, string[]>();
    for (const row of (
      await pool.query(
        `SELECT r.code AS route, rs.dsat_dir AS dir, rs.station_code AS code
           FROM route_stations rs JOIN routes r ON r.id = rs.route_id
          ORDER BY r.code, rs.dsat_dir, rs.seq`,
      )
    ).rows as { route: string; dir: string; code: string }[]) {
      const key = `${row.route}|${row.dir}`;
      let arr = dirStops.get(key);
      if (!arr) {
        arr = [];
        dirStops.set(key, arr);
        const ds = dirsOf.get(row.route) ?? [];
        ds.push(row.dir);
        dirsOf.set(row.route, ds);
      }
      arr.push(row.code);
    }

    const stopSetCache = new Map<string, Set<string>>();
    const stopSetOf = (route: string): Set<string> => {
      let s = stopSetCache.get(route);
      if (!s) {
        s = new Set<string>();
        for (const d of dirsOf.get(route) ?? []) for (const c of dirStops.get(`${route}|${d}`) ?? []) s.add(c);
        stopSetCache.set(route, s);
      }
      return s;
    };

    /** 该线在「某方向」上能否顺向（from 在 to 之前）——判定与 `segmentsOf` 一致 */
    const forward = (route: string, fromCode: string, toCode: string): boolean => {
      for (const d of dirsOf.get(route) ?? []) {
        const stops = dirStops.get(`${route}|${d}`) ?? [];
        const fi = idxsOf(stops, fromCode);
        const ti = idxsOf(stops, toCode);
        if (!fi.length || !ti.length) continue;
        for (const i of fi) for (const j of ti) if (j > i) return true;
      }
      return false;
    };

    /** 距离目标站 ≤ MAX_SNAP_M、且**同时出现在给定所有线路**站序里的停靠站（按距离升序，取前 MAX_CAND） */
    const candidatesFor = (targetCode: string, onRoutes: string[]): { code: string; dist: number }[] => {
      const t = coords.get(targetCode);
      if (!t) return [];
      const sets = onRoutes.map(stopSetOf);
      if (!sets.length) return [];
      const out: { code: string; dist: number }[] = [];
      const seen = new Set<string>();
      for (const code of sets[0]) {
        if (seen.has(code)) continue;
        seen.add(code);
        if (!sets.every((s) => s.has(code))) continue;
        const c = coords.get(code);
        if (!c) continue;
        const dist = haversine(t, c);
        if (dist > MAX_SNAP_M) continue;
        out.push({ code, dist });
      }
      out.sort((a, b) => a.dist - b.dist);
      return out.slice(0, MAX_CAND);
    };

    /**
     * 联合求解一条链的各节点：
     *   nodes.length = 段数 + 1；node[0]=上车站，node[n]=下车站，中间为换乘站。
     *   约束：`forward(routes[k], nodes[k], nodes[k+1])` 对所有段成立，且每节点距目标 ≤800m。
     *   目标函数：各节点「就近距离」之和最小。无解返回 null。
     */
    const resolveNodes = (routes: string[], targets: (string | null)[]): string[] | null => {
      const n = routes.length; // 段数；targets.length = n + 1
      if (targets.length !== n + 1) return null;
      const cand: { code: string; dist: number }[][] = [];
      for (let k = 0; k <= n; k++) {
        const tgt = targets[k];
        if (!tgt) return null;
        const onRoutes = k === 0 ? [routes[0]] : k === n ? [routes[n - 1]] : [routes[k - 1], routes[k]];
        const c = candidatesFor(tgt, onRoutes);
        if (!c.length) return null;
        cand.push(c);
      }
      let best: { nodes: string[]; cost: number } | null = null;
      const cur: string[] = [];
      const recur = (k: number, cost: number): void => {
        if (best && cost >= best.cost) return;
        if (k > n) {
          if (!best || cost < best.cost) best = { nodes: [...cur], cost };
          return;
        }
        for (const c of cand[k]) {
          if (k > 0 && !forward(routes[k - 1], cur[k - 1], c.code)) continue;
          cur[k] = c.code;
          recur(k + 1, cost + c.dist);
        }
      };
      recur(0, 0);
      return best ? (best as { nodes: string[]; cost: number }).nodes : null;
    };

    // ③ 取启用的方案
    const plans = (
      await pool.query(
        `SELECT id, plan_key, from_place, to_place, summary
           FROM commute_plans WHERE is_active = true ORDER BY id`,
      )
    ).rows as { id: number; plan_key: string; from_place: number; to_place: number; summary: string }[];

    const legsAll = (await pool.query(`SELECT * FROM plan_legs ORDER BY plan_id, seq`)).rows as (Leg & {
      plan_id: number;
    })[];

    let total = 0;
    let skipped = 0;
    let dropped = 0;
    const rows: {
      route_key: string;
      from_slug: string;
      to_slug: string;
      name: string;
      route_labels: string[];
      segs: Seg[];
      sort_order: number;
      /** 仅 dry-run 展示：各节点「就近距离」 */
      snap?: string;
    }[] = [];

    for (const p of plans) {
      const fromSlug = PLACE_SLUG[p.from_place];
      const toSlug = PLACE_SLUG[p.to_place];
      if (!fromSlug || !toSlug) {
        console.log(`  ⚠️ 跳过 plan ${p.id}（places 未知：${p.from_place}→${p.to_place}）`);
        skipped++;
        continue;
      }
      const legs = legsAll.filter((l) => l.plan_id === p.id && l.leg_kind !== "cross_border");
      const rideLegs = legs.filter((l) => l.leg_kind === "bus" || l.leg_kind === "lrt");
      if (!rideLegs.length) continue;

      // 每段骑乘腿的候选线路（无 options 的腿不可解 → 跳过该方案）
      const choicesPerLeg = rideLegs.map((l) => optionsOf(l));
      if (choicesPerLeg.some((o) => !o.length)) {
        console.log(`  ⚠️ 跳过 plan ${p.id}（有骑乘腿无 route_options）`);
        skipped++;
        continue;
      }

      // 生成线路组合（笛卡尔积）
      let combos: string[][] = [[]];
      for (const opts of choicesPerLeg) {
        const next: string[][] = [];
        for (const c of combos) for (const o of opts) next.push([...c, o]);
        combos = next;
        if (combos.length > MAX_EXPAND) {
          console.log(`  ⚠️ plan ${p.id} 展开超上限（${combos.length} > ${MAX_EXPAND}）⇒ 截断`);
          combos = combos.slice(0, MAX_EXPAND);
        }
      }

      // 链节点「目标站」：首段上车点、各换乘点（= 下一段上车点）、末段下车点
      const nRide = rideLegs.length;
      const targets: (string | null)[] = [rideLegs[0].from_station];
      for (let k = 1; k < nRide; k++) targets.push(rideLegs[k].from_station ?? rideLegs[k - 1].to_station);
      targets.push(rideLegs[nRide - 1].to_station);

      let made = 0;
      const dropList: string[] = [];
      for (const routes of combos) {
        const nodes = resolveNodes(routes, targets);
        if (!nodes) {
          dropped++;
          dropList.push(routes.join("→"));
          continue;
        }
        // 按腿顺序重放 → segs
        const segs: Seg[] = [];
        let rc = 0;
        for (const l of legs) {
          if (l.leg_kind === "walk") {
            const isOut = rc === 0;
            segs.push({
              kind: "walk",
              phase: isOut ? "out" : "in",
              from: isOut ? `PLACE:${fromSlug}` : nodes[rc],
              to: isOut ? nodes[0] : `PLACE:${toSlug}`,
              label: labelOf(isOut ? nodes[0] : nodes[rc]),
            });
            continue;
          }
          if (l.leg_kind === "transfer") {
            const at = nodes[Math.min(rc, nRide)];
            segs.push({ kind: "transfer", at, label: labelOf(at) });
            continue;
          }
          if (l.leg_kind === "bus" || l.leg_kind === "lrt") {
            const route = routes[rc];
            const board = nodes[rc];
            const alight = nodes[rc + 1];
            segs.push({
              kind: "ride",
              route,
              kind2: l.leg_kind === "lrt" ? "lrt" : "bus",
              board,
              alight,
              boardLabel: labelOf(board),
              alightLabel: labelOf(alight),
            });
            rc++;
            continue;
          }
        }
        const labels = routes;
        const key = `${fromSlug}-${toSlug}-${labels.join("-")}`.replace(/[^A-Za-z0-9\u4e00-\u9fff-]/g, "");
        const snap = nodes
          .map((c, k) => {
            const t = targets[k] ? coords.get(targets[k] as string) : undefined;
            const cc = coords.get(c);
            const d = t && cc ? haversine(t, cc) : -1;
            return `${c}≈${d}m`;
          })
          .join("  ");
        rows.push({
          route_key: key,
          from_slug: fromSlug,
          to_slug: toSlug,
          name: labels.join(" → "),
          route_labels: labels,
          segs,
          sort_order: total,
          snap,
        });
        total++;
        made++;
      }
      if (combos.length > 1 || dropList.length) {
        console.log(
          `  · plan ${p.id} ${p.plan_key} 展开 ${combos.length} ⇒ 生成 ${made}` +
            (dropList.length ? ` · 剔除 ${dropList.length}（${dropList.join(", ")}）` : ""),
        );
      }
    }

    console.log(`\n展开完成：共 ${rows.length} 条路线（跳过 ${skipped} 个方案 · 剔除 ${dropped} 条无解组合）`);

    if (dumpPath) {
      const fs = await import("node:fs");
      fs.writeFileSync(
        dumpPath,
        JSON.stringify(
          rows.map((r) => ({ route_key: r.route_key, from_slug: r.from_slug, to_slug: r.to_slug, segs: r.segs })),
          null,
          2,
        ),
        "utf8",
      );
      console.log(`[dump] 已写出 ${rows.length} 条 → ${dumpPath}`);
    }

    if (dry) {
      console.log("\n=== DRY-RUN 明细 ===");
      for (const r of rows) {
        const chain = r.segs
          .filter((s) => s.kind === "ride")
          .map((s) => `${s.route} ${s.board}→${s.alight}`)
          .join(" | ");
        console.log(`  ${r.route_key.padEnd(34)} ${chain.padEnd(40)} [${r.snap}]`);
      }
      console.log("\n[DRY-RUN] 未写库。");
      return;
    }

    // ④ 写库（仅覆盖 preset 行；user 行不动）
    let up = 0;
    for (const r of rows) {
      await pool.query(
        `INSERT INTO favorite_routes
           (route_key, from_slug, to_slug, zones, name, route_labels, segs, source, is_active, sort_order)
         VALUES ($1,$2,$3,'{}',$4,$5,$6::jsonb,'preset',true,$7)
         ON CONFLICT (route_key) DO UPDATE SET
           name         = EXCLUDED.name,
           route_labels = EXCLUDED.route_labels,
           segs         = EXCLUDED.segs,
           sort_order   = EXCLUDED.sort_order,
           is_active    = true,
           updated_at   = now()
         WHERE favorite_routes.source <> 'user'`,
        [r.route_key, r.from_slug, r.to_slug, r.name, r.route_labels, JSON.stringify(r.segs), r.sort_order],
      );
      up++;
    }
    console.log(`✅ 已写入/更新 ${up} 行`);

    // ⑤ 退役：preset 行中不在本次生成集合里的（= 无法顺向到达、不再生成）
    const keys = rows.map((r) => r.route_key);
    const retired = (
      await pool.query(
        `UPDATE favorite_routes SET is_active = false, updated_at = now()
          WHERE source = 'preset' AND is_active AND NOT (route_key = ANY($1::text[]))
        RETURNING route_key`,
        [keys],
      )
    ).rows as { route_key: string }[];
    if (retired.length) console.log(`🧹 已退役 ${retired.length} 行（不再生成）：${retired.map((r) => r.route_key).join(", ")}`);
    else console.log("🧹 无需退役（无陈旧 preset 行）");

    // ⑥ 复核：按 OD 统计
    const stat = (
      await pool.query(
        `SELECT from_slug, to_slug, count(*)::int AS n
           FROM favorite_routes WHERE is_active GROUP BY 1,2 ORDER BY 1,2`,
      )
    ).rows as { from_slug: string; to_slug: string; n: number }[];
    console.log("\n=== 入库复核（按 OD，仅 active）===");
    for (const s of stat) console.log(`  ${s.from_slug} → ${s.to_slug}：${s.n} 条`);

    console.log("\n=== 擎天汇 → 横琴口岸 明细 ===");
    const hh = (
      await pool.query(
        `SELECT route_key, name, route_labels FROM favorite_routes
          WHERE from_slug='home' AND to_slug='hengqin' AND is_active ORDER BY sort_order`,
      )
    ).rows as { route_key: string; name: string; route_labels: string[] }[];
    for (const h of hh) console.log(`  ${h.name.padEnd(28)} [${h.route_labels.join(" → ")}]`);
    console.log(`  —— 合计 ${hh.length} 条`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
