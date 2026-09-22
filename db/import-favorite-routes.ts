/**
 * 把旧「通勤计时」方案**展开成逐条路线**并导入 `favorite_routes`
 * （db/import-favorite-routes.ts）
 * 用法：npm run db:import-favorite-routes -- [local|cloud]
 *
 * ── 展开规则（2026-09-22 产品口径）────────────────────────────────────
 *   `plan_legs` 里 `route_options` 是**多条并行线路**（如 `["26","50"]`）。
 *   旧版把它们当**一个方案**（前端显示成 `26/50`）；新版按产品要求
 *   **一条线一行** ⇒ 对**含多值的腿做笛卡尔积**：
 *     `["26","50"]` × `["50","25B","25BS","102","701X","N6"]` = **12 条**
 *   ⇒ 加上轻轨那条（单线路）= 「擎天汇 → 横琴口岸」共 **13 行** ✓
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

const target = process.argv[2] as "local" | "cloud" | undefined;
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
console.log(`目标库：${connStr.replace(/:[^:@/]+@/, ":****@")}`);

/** 单个方案的展开上限 */
const MAX_EXPAND = 40;

/** `places.id` → slug（与前端 `endpointSlug` 同口径） */
const PLACE_SLUG: Record<number, string> = { 1: "home", 2: "school", 3: "hengqin", 7: "gate" };

interface Leg {
  id: number;
  seq: number;
  leg_kind: string;
  route_options: string | null;
  from_station: string | null;
  to_station: string | null;
  board_candidates: string | null;
  alight_candidates: string | null;
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
  alight?: string;
  boardLabel?: string;
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

async function main() {
  const pool = new Pool({ connectionString: connStr });
  pool.on("connect", (c) => c.query("SET default_transaction_read_only = off"));

  try {
    // ① 站名（补 boardLabel/alightLabel）
    const nameOf = new Map<string, string>();
    for (const r of (await pool.query(`SELECT code, name_tc FROM stations`)).rows as { code: string; name_tc: string }[]) {
      nameOf.set(r.code, r.name_tc ?? "");
    }
    const labelOf = (code: string | null): string | undefined => {
      if (!code) return undefined;
      const n = nameOf.get(code);
      return n ? `${code} ${n}` : code;
    };

    // ② 取启用的方案
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
    const rows: {
      route_key: string;
      from_slug: string;
      to_slug: string;
      name: string;
      route_labels: string[];
      segs: Seg[];
      sort_order: number;
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

      // ③ 找出「含多值」的骑乘腿 ⇒ 笛卡尔积
      const rideIdx = legs.map((l, i) => ({ l, i })).filter(({ l }) => l.leg_kind === "bus" || l.leg_kind === "lrt");
      const multi = rideIdx.filter(({ l }) => optionsOf(l).length > 1);

      // 生成线路组合
      let combos: string[][] = [[]];
      for (const { l } of multi) {
        const opts = optionsOf(l);
        const next: string[][] = [];
        for (const c of combos) for (const o of opts) next.push([...c, o]);
        combos = next;
        if (combos.length > MAX_EXPAND) {
          console.log(`  ⚠️ plan ${p.id} 展开超上限（${combos.length} > ${MAX_EXPAND}）⇒ 截断`);
          combos = combos.slice(0, MAX_EXPAND);
        }
      }
      // 单线路的骑乘腿 ⇒ 固定值（不进笛卡尔积）
      const fixedRides = rideIdx.filter(({ l }) => optionsOf(l).length === 1).map(({ l }) => optionsOf(l)[0]);
      const singleRides = rideIdx.filter(({ l }) => optionsOf(l).length === 0).map(({ l }) => l);

      for (const combo of combos) {
        // 按腿顺序重放：多值腿按 combo 顺序取，单值腿取固定值，无 options 腿用 route_meta 兜底
        let ci = 0;
        let fi = 0;
        const segs: Seg[] = [];
        const labels: string[] = [];
        for (const l of legs) {
          if (l.leg_kind === "walk") {
            const isOut = segs.every((s) => s.kind !== "ride");
            segs.push({
              kind: "walk",
              phase: isOut ? "out" : "in",
              from: isOut ? `PLACE:${fromSlug}` : (l.from_station ?? undefined),
              to: isOut ? (l.to_station ?? undefined) : `PLACE:${toSlug}`,
              label: labelOf(isOut ? l.to_station : l.from_station),
            });
            continue;
          }
          if (l.leg_kind === "transfer") {
            segs.push({ kind: "transfer", at: l.from_station ?? undefined, label: labelOf(l.from_station) });
            continue;
          }
          if (l.leg_kind === "bus" || l.leg_kind === "lrt") {
            let route: string | undefined;
            if (optionsOf(l).length > 1) route = combo[ci++];
            else if (optionsOf(l).length === 1) route = fixedRides[fi++] ?? optionsOf(l)[0];
            else route = singleRides.shift() ? undefined : undefined;
            if (!route) route = optionsOf(l)[0] ?? `R${l.id}`;
            labels.push(route);
            segs.push({
              kind: "ride",
              route,
              kind2: l.leg_kind === "lrt" ? "lrt" : "bus",
              board: l.from_station ?? undefined,
              alight: l.to_station ?? undefined,
              boardLabel: labelOf(l.from_station),
              alightLabel: labelOf(l.to_station),
            });
            continue;
          }
        }
        if (!labels.length) continue;
        const key = `${fromSlug}-${toSlug}-${labels.join("-")}`.replace(/[^A-Za-z0-9\u4e00-\u9fff-]/g, "");
        rows.push({
          route_key: key,
          from_slug: fromSlug,
          to_slug: toSlug,
          name: labels.join(" → "),
          route_labels: labels,
          segs,
          sort_order: total,
        });
        total++;
      }
      if (multi.length) console.log(`  · plan ${p.id} ${p.plan_key} 展开 ${combos.length} 条`);
    }

    console.log(`\n展开完成：共 ${rows.length} 条路线（跳过 ${skipped} 个方案）`);

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

    // ⑤ 复核：按 OD 统计
    const stat = (
      await pool.query(
        `SELECT from_slug, to_slug, count(*)::int AS n
           FROM favorite_routes WHERE is_active GROUP BY 1,2 ORDER BY 1,2`,
      )
    ).rows as { from_slug: string; to_slug: string; n: number }[];
    console.log("\n=== 入库复核（按 OD）===");
    for (const s of stat) console.log(`  ${s.from_slug} → ${s.to_slug}：${s.n} 条`);

    console.log("\n=== 擎天汇 → 横琴口岸 明细（应为 13 条）===");
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
