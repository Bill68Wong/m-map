/**
 * 同名站软吸附（src/lib/nav/anchor.ts，v2.3.0 · 07 §3.7 · Bug① FIX-09）
 *
 * ── 要解决的问题 ──────────────────────────────────────────────────────
 *   目的地是 **POI/地点（无站码）** 时，落站由「**离目的地坐标最近的站**」决定：
 *   · POI「關閘(拱北口岸)」→ 下车 `M244 中心街`（而非同名站 `M1 關閘總站`）；
 *   · POI「澳門理工大學」→ 落 `M161 高美士/利港`（比同名站 `M70` 更近）⇒ 与用户预期不符。
 *   ⇒ 名称重合的站本可满足，却被「纯最近站」逻辑挤掉。
 *
 * ── 策略：软吸附（偏好同名站）+ 卡片明示（不弹确认框）────────────────────
 *   把同名站**置入候选并前置**（不强制胜出）——最终仍由 `planNav` 的总时长模型排序：
 *   同名站通常胜出（更贴意图），但它若导致明显绕路，会被更优方案自然取代（**不制造硬性错误**）。
 *   ⚠️ 吸附**只改「下车锚站」**，**不改终点本身** —— `walkIn` 仍走到 POI 坐标（门到门仍到用户想去的地方）。
 *
 * ── 吸附判据（三级）───────────────────────────────────────────────────
 *   · **L1 完全相等**：归一后相等（两侧先剥站码前缀）→ **吸附**（超 700m 半径也额外纳入）；
 *   · **L2 强包含**：一者为另一者子串，且短串 ≥2 字、长度差 ≥2（如「澳門理工大學」⊂「澳門理工大學（氹仔）」）；
 *   · **L3 距离闸门**：名称命中但站距 POI 坐标 **> 800m** → **不吸附**（防跨区同名误吸）。
 *   同名多站 ⇒ 取**最近者**为锚（L1 优先于 L2，同级比距离）。
 *
 * ⚠️ 纯模块：不得 import 含 pg / next 的模块（供 nav-service / map-stations 复用）。
 */
import { gcj02ToWgs84, haversineM, type LatLng } from "@/lib/amap/coord";
import { normalizeName, normalizeQuery } from "@/lib/shared/normalize";
import type { RouteIndex } from "@/lib/recommend/types";
import type { GeoStation } from "./graph-search";

/** L3 距离闸门（米）：名称命中但站离 POI 超过它 → 不吸附（防跨区同名误吸） */
export const ANCHOR_MAX_M = 800;

/** 匹配级别：1 = 完全相等（强吸附）；2 = 强包含（弱吸附）；0 = 不命中 */
export type MatchLevel = 0 | 1 | 2;

/** 吸附结果 */
export interface AnchorHit {
  /** 吸附主码（DSAT 主码，如 `M70` / `M1`） */
  main: string;
  level: 1 | 2;
  /** 该站到 POI 的直线距离（米，WGS84 球面） */
  distM: number;
}

/** 剥掉站名里的「站码前缀」（`C653 金峰南岸` → `金峰南岸`；轻轨名无前缀则原样） */
export function stripStationCode(label: string): string {
  return label.replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "").trim();
}

/**
 * 归一化键集合：`normalizeName`（**匹配主入口**：NFKC + 去括注 + 繁简 + 异体 + 去分隔符 + 迭代剥交通后缀）
 * 与 `normalizeQuery`（NFKC + 繁简 + 异体 + 去空白）**两者都算**，任一对齐即算命中 —— 提高召回，
 * 误吸风险由 **L3 距离闸门** 兜住。过滤长度 < 2 的键（避免单字误配）。
 */
function keysOf(name: string): string[] {
  const out: string[] = [];
  for (const k of [normalizeName(name), normalizeQuery(name)]) {
    if (k && k.length >= 2 && !out.includes(k)) out.push(k);
  }
  return out;
}

/** 名称匹配级别（L1 完全相等 > L2 强包含 > 0） */
export function matchLevel(nameA: string, nameB: string): MatchLevel {
  const ka = keysOf(nameA);
  const kb = keysOf(nameB);
  if (!ka.length || !kb.length) return 0;
  for (const a of ka) for (const b of kb) if (a === b) return 1;
  for (const a of ka) {
    for (const b of kb) {
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      if (short.length >= 2 && long.length - short.length >= 2 && long.includes(short)) return 2;
    }
  }
  return 0;
}

/**
 * 求「POI/地点端点 → 吸附主码」（软吸附，07 §3.7）。
 *
 * @param endpoint 端点（label = POI/地点名；**lng/lat 为 GCJ-02**）
 * @param geo      站点地理（**WGS84**，`loadStationGeoCached()`；主码去重）
 * @param routeIdx 站序索引（`nameOf` 提供站名：`C653 金峰南岸` / `氹仔碼頭`）
 * @param kind     可选：限定载具种类（amap 侧防 LRT↔巴士错吸）
 * @returns 命中且过 L3 闸门 → 主码 + 级别 + 距离；否则 `null`（**保持现有「最近站」逻辑不动**）
 */
export function anchorMainFor(
  endpoint: { label?: string; lng: number; lat: number },
  geo: GeoStation[],
  routeIdx: RouteIndex,
  kind?: "bus" | "lrt",
): AnchorHit | null {
  const poiName = stripStationCode(endpoint.label ?? "");
  if (!poiName || !Number.isFinite(endpoint.lng) || !Number.isFinite(endpoint.lat)) return null;
  const poiWgs: LatLng = gcj02ToWgs84({ lng: endpoint.lng, lat: endpoint.lat });

  let best: AnchorHit | null = null;
  for (const g of geo) {
    // 载具种类过滤（防 LRT 腿吸到巴士站、反之亦然）
    const isLrt = g.main.startsWith("LRT-");
    if (kind === "lrt" && !isLrt) continue;
    if (kind === "bus" && isLrt) continue;

    const label = routeIdx.nameOf.get(g.main) ?? g.main;
    const level = matchLevel(poiName, stripStationCode(label));
    if (!level) continue;

    const distM = haversineM(poiWgs, { lat: g.lat, lng: g.lng });
    if (distM > ANCHOR_MAX_M) continue; // L3：距离闸门

    // 择优：级别更优（1 优于 2）优先；同级取更近者
    if (!best || level < best.level || (level === best.level && distM < best.distM)) {
      best = { main: g.main, level: level as 1 | 2, distM };
    }
  }
  return best;
}
