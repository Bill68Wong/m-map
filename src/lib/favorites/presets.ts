/**
 * 默认组合种子（src/lib/favorites/presets.ts，v2.3.0 · 07 §1.4 / 06 §3.5）
 *
 * ── 语义 ──────────────────────────────────────────────────────────────
 *   旧计时 4 预设（`PLACE_SHORT`）= `擎天匯(home)` / `澳科大(school)` /
 *   `橫琴口岸(hengqin)` / `關閘（拱北口岸）(gate)`；`PAIR_ORDER = [school, hengqin, gate]`
 *   ⇒ **3 对 ×（去/回）= 6 个默认组合**，标记 `isDefault: true`。
 *   · **仅当不存在同名组合时才注入**（不覆盖用户数据）；
 *   · **可被用户删除**（删掉不再复活 —— 由 `seedVersion` 幂等键保证，07 §1.4）；
 *   · 注入时机：首次读到 v2 文件（或 `seedVersion` 落后）时，见 `storage.applySeed`。
 *
 * ── 端点坐标从哪来（07 §1.4 回填）────────────────────────────────────
 *   **服务端** `queryPlaceCoords()`（`place_coords` JOIN `places` → `wgs84ToGcj02()`）
 *   ⇒ 由 server component（`/favorites`）取好、作为 props 下发给 `ComboSeeder`。
 *   ★ 澳科大（`school`）有多档 `zone`（B/C · N/O · R）⇒ **不写死**：
 *     服务端下发全部行，客户端按全局 `must.zone` 选（缺失则取 `zone=null` 行 / 首行）。
 *
 * ⚠️ 纯模块（客户端可 import）：**不得 import 含 pg / next 的模块**。
 */
import { HOME_SLUG, PAIR_ORDER } from "@/lib/home-plans-shared";
import { newId } from "./storage";
import { comboDefaultName, comboQueryOf, type Combo, type FavoriteEndpoint } from "./types";

/** 种子版本（增量 = 有新默认组合要补；幂等键，07 §1.4） */
export const SEED_VERSION = 1;

/** 服务端下发的端点坐标（每行 = 一个 place × zone；坐标 **GCJ-02**） */
export interface SeedPlaceCoord {
  slug: string;
  name: string;
  /** 澳科大座区（`B/C` | `N/O` | `R`）；其它 place 为 null */
  zone: string | null;
  lng: number;
  lat: number;
  /** 展示短名（`PLACE_SHORT[slug] ?? name`）—— 端点 label 用 */
  label: string;
}

/**
 * 取某 slug 的端点：优先匹配当前座区 → 再取 `zone=null` 行 → 兜底首行。
 * ⚠️ **不写死座区**（07 §1.4 裁定）：座区由调用方（客户端 `must.zone`）传入。
 */
function endpointFor(coords: SeedPlaceCoord[], slug: string, zone: string | null): FavoriteEndpoint | null {
  const rows = coords.filter((c) => c.slug === slug);
  if (!rows.length) return null;
  const pick = rows.find((r) => r.zone === zone) ?? rows.find((r) => r.zone === null) ?? rows[0];
  if (!Number.isFinite(pick.lng) || !Number.isFinite(pick.lat)) return null;
  // ⚠️ place 端点**不写 station code**（`home` 之类 slug 不是站码，写进 query 会污染 `parseNavParams`）
  return { kind: "place", label: pick.label || pick.name || slug, lng: pick.lng, lat: pick.lat };
}

/**
 * 构造 6 个默认组合（3 对 × 去/回）。
 * @param coords 服务端坐标（`queryPlaceCoords()` 结果）
 * @param zone   当前座区（客户端 `must.zone`；可为 null）
 * @returns 端点坐标不全时**跳过**该对（宁缺勿错）；`home` 缺失则整体返回空
 */
export function buildDefaultComboSeeds(coords: SeedPlaceCoord[], zone: string | null): Combo[] {
  const home = endpointFor(coords, HOME_SLUG, zone);
  if (!home) return [];
  const now = Date.now();
  const out: Combo[] = [];
  for (const other of PAIR_ORDER) {
    const ep = endpointFor(coords, other, zone);
    if (!ep) continue;
    // 去程（home → 该地点）与回程（该地点 → home）
    for (const [from, to] of [
      [home, ep],
      [ep, home],
    ] as const) {
      out.push({
        id: newId(),
        type: "combo",
        name: comboDefaultName(from, to),
        from,
        to,
        query: comboQueryOf(from, to),
        plans: [],
        isDefault: true,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return out;
}
