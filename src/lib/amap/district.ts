/**
 * 澳门行政区边界封装（src/lib/amap/district.ts，M Map 改版 S1）
 *
 * ── 职责 ──────────────────────────────────────────────────────────────
 *   用高德官方 `AMap.DistrictSearch`（extensions:'all'，adcode `820000`）取澳门
 *   行政区边界环（GCJ-02），并算出：
 *     ① `rings`        —— 澳门官方环（供域外遮罩「镂空」用）
 *     ② `exclaveRings` —— 横琴口岸澳方管辖区官方环（adcode `440499`，可选）
 *     ③ `bounds`       —— **外扩后**的 bbox（供 `setLimitBounds` / `setBounds`）
 *   取不到时**必须降级**为兜底矩形，**绝不抛错、绝不阻塞**底图/搜索/定位（§1.4 降级原则）。
 *
 * ── 合规（§1.2）──────────────────────────────────────────────────────
 *   · 边界**只取自高德官方行政区数据**，**不自绘**、不引入境外数据源；
 *   · 本模块**不落库、不写 localStorage**（合规待复核项 V5）——
 *     「仅内存 / sessionStorage」由调用方决定，本模块只返回内存对象；
 *   · bbox 是「可视/可拖范围」的**矩形约束**，**不在地图上画边界线**，合规。
 *
 * ── 实测（V3 探针，2026-09-20，无头 Chrome 真机）──────────────────────
 *   · V1 ✅ `search('820000', {level:'province'})` → `complete`，返回 boundaries；
 *   · V2 ✅ 环数 = **2**（澳门半岛 83 点 + 路氹 10 点）；
 *   · bbox = `113.533314~113.603872 / 22.106214~22.214074`；
 *   · V6 ✅ `search('440499')` 返回「澳门大学横琴校区(由澳门实施管辖)」及其官方环。
 *
 * ⚠️ 坐标：`DistrictSearch` 返回**已是 GCJ-02**，与地图 / `NavPoint` 口径一致，**不再转换**。
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** 经纬度 bbox（经度/纬度各取 min/max） */
export interface MacauBounds {
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

/** 一个环：[lng, lat] 点列（GCJ-02） */
export type Ring = [number, number][];

export interface MacauDistrict {
  /** 澳门行政区边界环（GCJ-02，官方数据）—— 遮罩的「洞」 */
  rings: Ring[];
  /**
   * 横琴口岸澳方管辖区官方环（GCJ-02）—— 一并镂空用。
   * 取不到时为空数组（此时该区域会被压暗，按 §1.4 ② 的口径）。
   */
  exclaveRings: Ring[];
  /** 外扩后的 bbox（覆盖澳门 + 横琴口岸澳方管辖区）—— 供 setLimitBounds / setBounds */
  bounds: MacauBounds;
  /** 数据来源：`district` = 高德官方边界；`fallback` = 兜底矩形 */
  source: "district" | "fallback";
}

/** 澳门 adcode（省级） */
export const MACAU_ADCODE = "820000";
/** 横琴口岸澳方管辖区 adcode（在高德行政区划里属广东） */
export const HENGQIN_EXCLAVE_ADCODE = "440499";

/**
 * 兜底矩形（DistrictSearch 失败时使用）。
 * 取值 = 实测 bbox（113.5333~113.6039 / 22.1062~22.2141）外扩约 0.05°（≈5km），
 * 保证「仅范围限制」降级版依然把视角收敛在澳门一带，不露出珠三角。
 */
export const MACAU_FALLBACK_BOUNDS: MacauBounds = {
  minLng: 113.48,
  maxLng: 113.66,
  minLat: 22.05,
  maxLat: 22.27,
};

/**
 * bbox 外扩量（度）。实测 bbox 已把横琴口岸澳方管辖区（≈113.53~113.56 / 22.11~22.13）
 * 包住，此处再外扩 0.012°（≈1.3km）留出余量，避免边缘站点/定位点被 `setLimitBounds` 卡边。
 */
const BBOX_PAD = 0.012;

/** 边界查询超时（ms）：超时即降级（不阻塞底图） */
const DISTRICT_TIMEOUT_MS = 6000;

/** 单点 → [lng, lat]（兼容高德返回数组或 LngLat 对象两种形态） */
function toPair(p: any): Ring[number] | null {
  if (Array.isArray(p) && p.length >= 2) {
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  if (p && typeof p === "object") {
    const lng = Number(p.lng);
    const lat = Number(p.lat);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }
  return null;
}

/** 原始 boundaries（number[][][]）→ Ring[]（过滤无效点/空环） */
function normalizeRings(boundaries: any): Ring[] {
  if (!Array.isArray(boundaries)) return [];
  const out: Ring[] = [];
  for (const raw of boundaries) {
    if (!Array.isArray(raw)) continue;
    const ring: Ring = [];
    for (const p of raw) {
      const pair = toPair(p);
      if (pair) ring.push(pair);
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

/** 多环 → bbox */
function bboxOf(rings: Ring[]): MacauBounds | null {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (!Number.isFinite(minLng) || !Number.isFinite(minLat)) return null;
  return { minLng, maxLng, minLat, maxLat };
}

/** 合并两个 bbox（任一为 null 时取另一个） */
function unionBounds(a: MacauBounds | null, b: MacauBounds | null): MacauBounds | null {
  if (!a) return b;
  if (!b) return a;
  return {
    minLng: Math.min(a.minLng, b.minLng),
    maxLng: Math.max(a.maxLng, b.maxLng),
    minLat: Math.min(a.minLat, b.minLat),
    maxLat: Math.max(a.maxLat, b.maxLat),
  };
}

/** bbox 外扩（供 setLimitBounds/setBounds，确保可视 ⊆ bounds） */
export function padBounds(b: MacauBounds, pad = BBOX_PAD): MacauBounds {
  return {
    minLng: b.minLng - pad,
    maxLng: b.maxLng + pad,
    minLat: b.minLat - pad,
    maxLat: b.maxLat + pad,
  };
}

/**
 * 遮罩外圈大矩形（远大于澳门，配合 minZoom 保证任何合法缩放/拖动都不露边）。
 *
 * ★ 绕向与形态**照搬 V3 探针已实测通过的形状**（`[[112.0,20.6],[115.1,20.6],[115.1,23.7],[112.0,23.7]]`），
 *   此处按 bbox 中心动态生成同一取向（右下→右上→左上→左下），外扩 ±1.6°（≈160km）。
 *   V3 实测：`contains(澳门)=false`（洞生效）、`contains(珠海)=true`（被压暗）。
 */
export function maskOuterRing(bounds: MacauBounds): Ring {
  const cx = (bounds.minLng + bounds.maxLng) / 2;
  const cy = (bounds.minLat + bounds.maxLat) / 2;
  const d = 1.6;
  return [
    [cx - d, cy - d],
    [cx + d, cy - d],
    [cx + d, cy + d],
    [cx - d, cy + d],
  ];
}

/**
 * 点是否落在**任一**环内（射线法 / ray casting）。
 *
 * 用途：判断定位点是否在「澳门行政区范围（含横琴口岸澳方管辖区）」内 ——
 *   ① 在范围内 → 允许把地图 `setZoomAndCenter` 到定位点；
 *   ② 在范围外 → **不移动地图**（保持澳门视野），蓝点按真实坐标如实落位（§1.4 ④）。
 * 环来自高德官方数据（GCJ-02），与定位点同口径。
 */
export function isInsideRings(lng: number, lat: number, rings: Ring[]): boolean {
  for (const ring of rings) {
    if (ring.length < 3) continue;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (intersect) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** 在 `timeoutMs` 内跑一个 Promise；超时/抛错一律 resolve 为 null（降级用） */
function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(v);
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(null);
      },
    );
  });
}

/** 单次 DistrictSearch 查询 → 原始 boundaries（失败/超时 → null） */
function searchBoundaries(AMap: any, adcode: string, timeoutMs: number): Promise<Ring[] | null> {
  return new Promise<Ring[] | null>((resolve) => {
    let done = false;
    const finish = (v: Ring[] | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      AMap.plugin(
        "AMap.DistrictSearch",
        () => {
          try {
            const ds = new AMap.DistrictSearch({
              // 澳门特别行政区为省级；用 province，失败由超时/兜底接管
              level: "province",
              subdistrict: 0,
              extensions: "all", // ★ 必须 all，否则不返回 boundaries
            });
            ds.search(adcode, (status: string, result: any) => {
              clearTimeout(timer);
              if (status !== "complete") return finish(null);
              const b = result?.districtList?.[0]?.boundaries;
              finish(normalizeRings(b));
            });
          } catch {
            clearTimeout(timer);
            finish(null);
          }
        },
        // 插件加载失败
        () => {
          clearTimeout(timer);
          finish(null);
        },
      );
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/**
 * 取澳门行政区边界 + 横琴口岸澳方管辖区环。
 *
 * **永不抛错**：任何失败（插件加载失败 / 超时 / 无 boundaries）→ `source:'fallback'`
 * 并返回兜底矩形 + 空环数组（调用方据此走「仅范围限制」降级）。
 */
export async function loadMacauDistrict(AMap: any, timeoutMs = DISTRICT_TIMEOUT_MS): Promise<MacauDistrict> {
  try {
    if (!AMap) throw new Error("AMap 未就绪");
    // 澳门主环 + 澳方管辖区环**并行**取（澳方管辖区失败不影响主流程）
    const [macauRings, exclaveRings] = await Promise.all([
      searchBoundaries(AMap, MACAU_ADCODE, timeoutMs),
      withTimeout(searchBoundaries(AMap, HENGQIN_EXCLAVE_ADCODE, timeoutMs), timeoutMs),
    ]);

    if (!macauRings || !macauRings.length) {
      return { rings: [], exclaveRings: [], bounds: { ...MACAU_FALLBACK_BOUNDS }, source: "fallback" };
    }

    const exclave = exclaveRings ?? [];
    const merged = unionBounds(bboxOf(macauRings), bboxOf(exclave)) ?? MACAU_FALLBACK_BOUNDS;
    return {
      rings: macauRings,
      exclaveRings: exclave,
      bounds: padBounds(merged),
      source: "district",
    };
  } catch {
    return { rings: [], exclaveRings: [], bounds: { ...MACAU_FALLBACK_BOUNDS }, source: "fallback" };
  }
}
