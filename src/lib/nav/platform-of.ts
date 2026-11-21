/**
 * 导航态「主码 → 该腿实际站台坐标」（src/lib/nav/platform-of.ts，2026-11-21）
 *
 * ── 它修的是什么（真机验收 ③）────────────────────────────────────────────
 *   导航里站点标点仍然画在 `T373/1` 的位置，而这一趟实际停的是 `T373/2`。
 *
 *   根因链（静态可证，逐段核过）：
 *     ① 路线查看那一半的表 `platformOf`（`NavShell`）原料是 `stopsSheet`，而它只在
 *        「选着线 + **无导航态** + 无选线弹窗」时有效（`stopsSheetOn`）；
 *     ② 导航是从推荐卡直接进的，`rv.picked` 未必有值 ⇒ 导航态下 `platformOf` 基本为 `null`；
 *     ③ `NavMap` 见 `null` 就回落 `/api/stations` 的合成点 —— 而那个接口**按主码去重**
 *        （`byMain`，一个主码只留一行，通常是 `/1`）⇒ 屏幕上就是 `/1` 的位置。
 *
 *   实测（真库）：`T373/1` = `113.56514, 22.152071`；`T373/2` = `113.5649, 22.151752`
 *   ⇒ **相距 43.2m**（球面距离）。肉眼一眼能看出，但不会"跑出地图"，所以只有用户看得出来。
 *   ⚠️ 别把这 43.2m 当成"无所谓"：同一条线的两个站台常常分居**马路两侧**，
 *      画错一侧等于告诉用户在错误的路边等车。
 *
 * ── 为什么必须**按腿**（不能全局按主码）──────────────────────────────────
 *   实测（真库，2026-11-21）：
 *     · `26`  dir 0 seq 30 → `T373/2`
 *     · `AP1` dir 0 seq 15 → `T373/1`
 *     · `N2`  dir 1 seq 5  → `T373/1`
 *   同一个主码、甚至**同一个方向值**，不同线路停的站台也不同 ⇒
 *   「全局按主码取某一个站台」这条规则**在任何方向上都是错的**（这正是本文件拒绝做的事）。
 *   一次行程还有多腿，不同腿可能停同一主码的不同站台（换乘）⇒ 表必须**只按当前腿**建。
 *
 * ── 折叠规则：按**腿内经过顺序**取第一次，不是按 `seq` 取最小 ────────────
 *   腿内站序（`strips[].stops`）本身就是 board→alight 的经过顺序，环线里同一主码
 *   可能出现两次（去程/回程各一次）。取"第一次出现" = 用户先到的那一次，语义正确；
 *   而 `seq` 最小是同一条线上的全局最小值，**可能落在本腿窗外**（环线尤其）。
 *   （与 `stops-veh-marks.ts#gateRows` 的「同一主码只画首次出现行」同源。）
 *
 * ── `null` 是契约，不是失败 ──────────────────────────────────────────────
 *   本函数的返回值要进 `NavMap` 站点层 effect 的依赖数组：引用每帧变 ⇒ 1~2Hz 的导航帧
 *   会把全量 marker 重建一遍。故：
 *     · 无腿 / 无数据 / 一条都对不上 ⇒ 返回 **`null`（稳定引用）**，消费方回落既有行为；
 *     · 有数据 ⇒ 每次新建一个 `Map`（只在输入真变时才会重算，`useMemo` 保证）。
 *
 * 纯函数（零请求、零 React）：`scripts/test-platform-of.ts` 直接单测它。
 */
import { mainOf } from "@/lib/nav/track";

/** 站台行（`/api/route-stops` 的 `stops[]` 子集；坐标已是 **GCJ-02**） */
export interface PlatformCoordRow {
  /** **平台码**（`T373/2`），不是主码 */
  code: string;
  lng: number | null;
  lat: number | null;
}

/** 与 AMap `position` 同序的坐标（`[lng, lat]` 由此拆） */
export interface LngLat {
  lng: number;
  lat: number;
}

/**
 * 由「本腿的经过顺序（平台码）」+「该线该方向的全部站台行」产出 `主码 → 坐标`。
 *
 * @param legCodes 本腿站序的**平台码**（`strips[].stops[].code`），按经过顺序
 * @param rows     该线该方向的站台行（`/api/route-stops` 的 `stops[]`）
 * @returns `null` = 无可产出（消费方回落）；否则 `Map<主码, LngLat>`
 */
export function buildPlatformMap(
  legCodes: readonly string[],
  rows: readonly PlatformCoordRow[],
): Map<string, LngLat> | null {
  if (!legCodes.length || !rows.length) return null;

  /** 平台码 → 坐标（缺坐标的行**必须**跳过：契约是 `lat/lng: null` = 站表未补，不参与任何计算） */
  const byCode = new Map<string, LngLat>();
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    const lat = Number(r.lat);
    const lng = Number(r.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    /* ⚠️ 坐标已是 GCJ-02（`load-route-stops.ts` 出口转好）——禁止在这里再调 wgs84ToGcj02，
       否则整体偏移几百米，且**只在真地图上看得出来**。 */
    byCode.set(r.code, { lng, lat });
  }
  if (!byCode.size) return null;

  const out = new Map<string, LngLat>();
  for (const raw of legCodes) {
    const main = mainOf(raw);
    /* 同一主码在本腿第二次经过 ⇒ 不再覆盖（见文件头「折叠规则」） */
    if (out.has(main)) continue;
    /* 先按**完整平台码**取；取不到再按主码取 —— 兜底只为"站序里给的是主码"这一种历史形态，
       它会让结果退回 `/1` 附近，所以**它能命中就说明上游数据降级了**，不要把它当正常路径。 */
    const hit = byCode.get(raw) ?? byCode.get(main);
    if (hit) out.set(main, hit);
  }
  return out.size ? out : null;
}
