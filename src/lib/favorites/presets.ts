/**
 * 默认组合种子（src/lib/favorites/presets.ts，v2.4.0）
 *
 * ── 语义（2026-09-21 拍板扩展）────────────────────────────────────────
 *   · **组合（父）= 一对 from/to**；**路线（子）= 同起点终点下的一条具体走法**；
 *   · **澳門科技大學有 3 个座区**（B/C · N/O · R）= **三个不同目的地**
 *     ⇒ 「家 ↔ 学校」拆成 **3 去 + 3 回 = 6 个组合**；
 *   · 加上「家 ↔ 横琴口岸」「家 ↔ 關閘」各 2 个 ⇒ **合计 10 个默认组合**。
 *   · 每个组合**预置**若干条路线（照抄旧版「通勤计时」的 14 个在用方案，
 *     按「一趟完整行程 = 一条路线」展开为 31 条 —— 见 `route-presets.ts`）。
 *
 * ── 端点坐标从哪来 ────────────────────────────────────────────────────
 *   **服务端** `queryPlaceCoords()`（`place_coords` JOIN `places` → `wgs84ToGcj02()`）
 *   ⇒ 由 server component（`/favorites`）取好、作为 props 下发给 `ComboSeeder`。
 *   ★ 澳門科技大學（`school`）有多档 `zone` ⇒ **逐个座区各建一对**（不写死、不落空）。
 *
 * ⚠️ 纯模块（客户端可 import）：**不得 import 含 pg / next 的模块**。
 */
import { HOME_SLUG } from "@/lib/home-plans-shared";
import { newId } from "./storage";
import {
  PLACE_HOME,
  PLACE_SCHOOL,
  PRESET_ROUTES,
  type PresetRoute,
} from "./route-presets";
import {
  comboDefaultName,
  comboQueryOf,
  planFingerprint,
  placeWalkEnd,
  walkKey,
  type Combo,
  type ComboPlan,
  type FavoriteEndpoint,
  type RouteSeg,
} from "./types";

/** 种子版本（增量 = 有新默认组合要补；幂等键）—— v2.4.0：6 → 10 个组合、新增预置路线 */
export const SEED_VERSION = 2;

/** 澳門科技大學的三个座区（顺序 = 组合生成顺序） */
export const SCHOOL_ZONES = ["B/C", "N/O", "R"] as const;
export type SchoolZoneValue = (typeof SCHOOL_ZONES)[number];

/** 服务端下发的端点坐标（每行 = 一个 place × zone；坐标 **GCJ-02**） */
export interface SeedPlaceCoord {
  slug: string;
  name: string;
  /** 澳門科技大學座区（`B/C` | `N/O` | `R`）；其它 place 为 null */
  zone: string | null;
  lng: number;
  lat: number;
  /** 展示短名（`PLACE_SHORT[slug] ?? name`）—— 端点 label 用 */
  label: string;
}

/**
 * 取某 slug 的端点：优先匹配指定座区 → 再取 `zone=null` 行 → 兜底首行。
 * ★ **不写死座区**：座区由调用方传入。
 */
function endpointFor(coords: SeedPlaceCoord[], slug: string, zone: string | null): FavoriteEndpoint | null {
  const rows = coords.filter((c) => c.slug === slug);
  if (!rows.length) return null;
  const pick = rows.find((r) => r.zone === zone) ?? rows.find((r) => r.zone === null) ?? rows[0];
  if (!Number.isFinite(pick.lng) || !Number.isFinite(pick.lat)) return null;
  // ⚠️ place 端点**不写 station code**（`home` 之类 slug 不是站码，写进 query 会污染 `parseNavParams`）
  return { kind: "place", label: pick.label || pick.name || slug, lng: pick.lng, lat: pick.lat };
}

/** 座区展示后缀（`澳門科技大學（N/O 座）`）—— 与 `model.ts#placeLabelOf` 同口径 */
function zoneLabel(label: string, zone: string): string {
  return `${label}（${zone} 座）`;
}

/** 预置路线骨架 → `RouteSeg[]`（补 `kind`/展示字段；步行耗时由 `walkDefaults` 另填） */
function segsOfPreset(p: PresetRoute): RouteSeg[] {
  const out: RouteSeg[] = [];
  for (const s of p.segs) {
    if (s.kind === "walk") {
      out.push({
        kind: "walk",
        phase: s.phase ?? "out",
        code: s.to && !s.to.startsWith("PLACE:") ? s.to : s.from && !s.from.startsWith("PLACE:") ? s.from : undefined,
        label: s.label,
        walkSrc: "measured",
      });
      continue;
    }
    if (s.kind === "transfer") {
      out.push({ kind: "transfer", code: s.at, label: s.label });
      continue;
    }
    // ride
    const labels = s.route ? [s.route] : [];
    out.push({
      kind: "ride",
      route: s.route,
      routes: labels.length ? labels : undefined,
      board: s.board,
      alight: s.alight,
      boardLabel: s.boardLabel,
      alightLabel: s.alightLabel,
      hops: s.hops ?? 0,
    });
  }
  return out;
}

/** 预置路线 → `ComboPlan`（指纹 + 快照 + 流程图结构） */
function planOfPreset(p: PresetRoute, now: number): ComboPlan {
  const segs = segsOfPreset(p);
  const rides = segs
    .filter((s) => s.kind === "ride")
    .map((s) => ({ route: s.route ?? "", board: s.board ?? "", alight: s.alight ?? "" }));
  const ridesForFp = rides.length ? rides : [{ route: p.routeLabels[0] ?? "", board: "", alight: "" }];
  const ridesView = segs.filter((s) => s.kind === "ride");
  const walkMin = segs.filter((s) => s.kind === "walk").reduce((a, s) => a + (s.minutes ?? 0), 0);
  return {
    id: newId(),
    fingerprint: planFingerprint(ridesForFp),
    snapshot: {
      capturedAt: now,
      fingerprint: planFingerprint(ridesForFp),
      totalMin: 0, // ★ 预置路线**不写死总耗时**（由「点开组合实时算」给真值）
      walkMin,
      transfers: Math.max(0, ridesView.length - 1),
      legs: ridesView.map((s) => `${s.route ?? ""} ${s.boardLabel ?? ""}→${s.alightLabel ?? ""}`),
      origin: "local",
    },
    route: segs,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 构造默认组合（v2.4.0：**10 个**）。
 *
 * 生成规则：
 *   · `home ↔ school`：**每个座区一对**（B/C · N/O · R）× 去/回 ⇒ 6 个组合；
 *   · `home ↔ hengqin` / `home ↔ gate`：各 去/回 ⇒ 4 个组合；
 *   · 每个组合按其 OD 从 `PRESET_ROUTES` 取路线（座区过滤：`zones` 含该座区才放入）。
 *
 * @param coords 服务端坐标（`queryPlaceCoords()` 结果）
 * @param _zone  **保留占位**（v2.4.0 已改成「三座区全建」⇒ 不再按当前座区过滤；
 *               签名保留以免调用方改动，调用可继续传 `must.zone`，值被忽略）
 * @returns 端点坐标不全时**跳过**该组合（宁缺勿错）；`home` 缺失则整体返回空
 */
export function buildDefaultComboSeeds(coords: SeedPlaceCoord[], _zone: string | null): Combo[] {
  const home = endpointFor(coords, HOME_SLUG, null);
  if (!home) return [];
  const now = Date.now();
  const out: Combo[] = [];

  const push = (from: FavoriteEndpoint, to: FavoriteEndpoint, fromSlug: string, toSlug: string, zoneKey: string | null) => {
    const odKey = `${fromSlug}|${toSlug}`;
    const applicable = PRESET_ROUTES.filter((p) => {
      if (`${p.od[0]}|${p.od[1]}` !== odKey) return false;
      if (!p.zones.length) return true; // 不区分座区
      return zoneKey ? p.zones.includes(zoneKey) : true; // 座区未知 → 全放（宁多勿缺）
    });
    const combo: Combo = {
      id: newId(),
      type: "combo",
      name: comboDefaultName(from, to),
      from,
      to,
      query: comboQueryOf(from, to),
      plans: applicable.map((p) => planOfPreset(p, now)),
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    };
    out.push(combo);
    return combo;
  };

  // ── home ↔ school：逐座区各一对（3 × 2 = 6 个组合）──
  for (const z of SCHOOL_ZONES) {
    const school = endpointFor(coords, "school", z);
    if (!school) continue;
    const schoolLabelled: FavoriteEndpoint = { ...school, label: zoneLabel(school.label || "澳門科技大學", z) };
    push(home, schoolLabelled, "home", "school", z);
    push(schoolLabelled, home, "school", "home", z);
  }

  // ── home ↔ hengqin / gate（各 2 个组合）──
  for (const other of ["hengqin", "gate"] as const) {
    const ep = endpointFor(coords, other, null);
    if (!ep) continue;
    push(home, ep, "home", other, null);
    push(ep, home, other, "home", null);
  }

  return out;
}

/** 供 UI 用：某组合的步行段列表（含钥匙，便于「同段共享」比对） */
export interface ComboWalkSegRef {
  /** 共享钥匙（`walkKey(comboId, from, to)`） */
  key: string;
  /** 该段归属的路线 id */
  planId: string;
  /** 段下标（在 `plan.route` 里的位置） */
  segIndex: number;
  /** 行走方向 */
  phase: "out" | "in";
  /** 两端（`PLACE:*` 或站码） */
  from: string;
  to: string;
  /** 该段展示名（如「步行 → C653 金峰南岸/金譽峰」） */
  label: string;
  /** 当前生效耗时（分钟；覆盖值优先，否则骨架默认值） */
  minutes?: number;
}

/**
 * ★ 列出某组合内**所有路线的全部步行段**（带共享钥匙）。
 * 用途：UI 渲染「流程图旁的步行设置」；同一钥匙 = 同段 ⇒ 共享一份覆盖值。
 *
 * 钥匙两端约定（与 `route-presets.ts` 骨架一致）：
 *   · `out`（出发地→上车站）：`PLACE:<起点slug>` → 站码
 *   · `in` （下车站→目的地）：站码 → `PLACE:<终点slug>`
 * ⇒ 起点/终点 slug 由组合的 `from`/`to` label 判定（`slugOfEndpoint`）。
 */
export function comboWalkSegs(combo: Combo): ComboWalkSegRef[] {
  const out: ComboWalkSegRef[] = [];
  const fromSlug = slugOfEndpoint(combo.from);
  const toSlug = slugOfEndpoint(combo.to);
  for (const plan of combo.plans) {
    const segs = plan.route ?? [];
    segs.forEach((s, i) => {
      if (s.kind !== "walk") return;
      const phase = s.phase ?? "out";
      const station = s.code ?? ""; // 该步行段的**站点侧**（站码）
      // out：出发地 → 上车站；in：下车站 → 目的地
      const fromE = phase === "out" ? placeWalkEnd(fromSlug) : station;
      const toE = phase === "out" ? station : placeWalkEnd(toSlug);
      const key = walkKey(combo.id, fromE, toE);
      const ov = plan.walkOv?.[key];
      out.push({
        key,
        planId: plan.id,
        segIndex: i,
        phase,
        from: fromE,
        to: toE,
        label: s.label ? `步行 → ${s.label}` : "步行",
        minutes: ov?.minutes ?? s.minutes,
      });
    });
  }
  return out;
}

/** 从端点猜 place slug（`label` 含关键词 → slug；找不到返回 `home`）
 *  ⚠️ v2.4.1：校名已繁体化，但**必须同时认简体与简称** —— 用户浏览器里 v2.4.0 写入的
 *    组合 label 是简体「澳门科技大学」，只认繁体会让旧组合的端点判定失败（步行钥匙错位）。 */
function slugOfEndpoint(ep: FavoriteEndpoint): string {
  const l = ep.label;
  if (l.includes("澳門科技大學") || l.includes("澳门科技大学") || l.includes("澳科大")) return "school";
  if (l.includes("橫琴") || l.includes("横琴")) return "hengqin";
  if (l.includes("關閘") || l.includes("关闸")) return "gate";
  return "home";
}

/** 供 UI 复用（步行端点的 place 侧标记） */
export { PLACE_HOME, PLACE_SCHOOL };
