/**
 * 同卡多线（R3）：本腿车辆帧的**线路集合**与**多线帧合并**（纯函数 · client-safe）
 *
 * ── 为什么需要（根因，2026-11-17 定性）───────────────────────────────────
 *   `useRideTracking` 的 `fetchFrame` 原来只按**推荐线**取帧：
 *     `/api/route-vehicles?code=${leg.route}&dir=…`
 *   ⇒ 并行线（`leg.parallelRoutes`）的车从来没进过 `list`
 *   ⇒ `rankBoardingVehicles` 只在推荐线内排序、`pickLockPlateOf` 只可能锁推荐线
 *   ⇒ 用户实际上了并行线（例：推荐 25、实际 21A）时，
 *     ① 21A 无车牌可匹配；②「不是这辆」翻候选也翻不到 21A。
 *   **这不是判据保守，是数据从未进来。**
 *
 * ── 本模块只做两件纯事（便于自测，不碰 React）────────────────────────────
 *   · `routeSetOf`：把 `[推荐线, ...并行线]` 去重保序 —— 单线腿必须仍只回 1 条，
 *     否则会给**所有**场景增加请求数（R3 的硬约束）。
 *   · `mergeFrameVehicles`：多线帧合并 + 按 `plate` 去重 + 打 `route` 标签。
 *
 * ── 去重为什么要「推荐线优先」───────────────────────────────────────────
 *   同一辆车可能同时出现在两条线的帧里（共线段 / 临时调车）。同 `plate` 只保留一条，
 *   且**优先保留推荐线那条副本**：推荐线的 `progress` / `interval` 是按本腿几何算的，
 *   比并行线的更有用（本腿的 `colored` 就是推荐线的形状）。
 *
 * ── 失败隔离（R3 ③）─────────────────────────────────────────────────────
 *   某一条线的帧失败**不得**让整帧失败：调用方按线 catch ⇒ 传入 `frames` 的只有成功的线，
 *   本函数天然只处理成功部分。失败线由调用方记一次 warn（不改 UI）。
 */

/** 只要求带车牌的最小形状（`VehicleLite` / 任意帧元素都能套） */
export interface PlateBearing {
  plate: string;
}

/**
 * 本腿要取帧的线路集合：`[推荐线, ...并行线]` 去重保序，且**剔除空值**。
 *
 * ⚠️ 单线腿（`parallels` 为空 / 缺省）必须返回**长度为 1** 的数组 ——
 *    这是 R3 的硬约束：不给单线场景增加任何请求。
 */
export function routeSetOf(route: string, parallels?: readonly string[] | null): string[] {
  const out: string[] = [];
  const push = (x: string | null | undefined): void => {
    const v = String(x ?? "").trim();
    if (!v) return;
    if (out.includes(v)) return;
    out.push(v);
  };
  push(route);
  for (const p of parallels ?? []) push(p);
  return out;
}

/** 一条线的帧（成功才有） */
export interface RouteFrame<T extends PlateBearing> {
  route: string;
  vehicles: T[];
}

/**
 * 合并多线帧：按 `plate` 去重、**推荐线优先**，并给每辆车打上 `route` 标签。
 *
 * 去重顺序：先遍历 `/ 推荐线 /` 的帧，再遍历其余线 —— 于是同 `plate` 保留推荐线副本，
 * 且输出顺序稳定（推荐线自身顺序在前，其余线按传入顺序追加）。
 */
export function mergeFrameVehicles<T extends PlateBearing>(
  legRoute: string,
  frames: readonly RouteFrame<T>[],
): (T & { route: string })[] {
  const ordered = [
    ...frames.filter((f) => f.route === legRoute),
    ...frames.filter((f) => f.route !== legRoute),
  ];
  const seen = new Set<string>();
  const out: (T & { route: string })[] = [];
  for (const f of ordered) {
    for (const v of f.vehicles ?? []) {
      const plate = String(v?.plate ?? "").trim();
      if (!plate || seen.has(plate)) continue;
      seen.add(plate);
      out.push({ ...v, route: f.route });
    }
  }
  return out;
}

/**
 * 该车是否属于「本腿线路集合之外」。
 *
 * 供**里程类判据**决定是否采纳该车：`departedCandidatesOf` 的里程差是投影到
 * **本腿 `colored`**（推荐线形状）上算的，把并行线的车投到推荐线的折线上没有意义
 * （共线段尚可，分叉后完全失真）⇒ 跨线车**不参与**锚定/锁牌，只进候选池供人眼挑。
 *
 * ⚠️ `route` 缺省（老帧 / 单元测试手搓对象）一律**视为同线**，保持既有行为不变。
 */
export function isCrossRoute(vehicleRoute: string | null | undefined, legRoute: string): boolean {
  const v = String(vehicleRoute ?? "").trim();
  if (!v) return false;
  return v !== String(legRoute ?? "").trim();
}
