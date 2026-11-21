/**
 * 「按码直取线路」的停运闸（src/lib/routes/active-gate.ts，2026-11-21）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   三个接口按**线路码**直取数据，此前都不看 `routes.is_active`：
 *     · `GET  /api/route-shapes?code=`      —— 走向折线
 *     · `GET  /api/route-vehicles?code=`    —— 在途车辆
 *     · `POST /api/nav/detail-body`（`card.rides[].route`）—— 逐段几何
 *   一处停运，三个入口各自继续当作「在线线路」回答。
 *
 *   **这不是假想风险，库里就有一例**：`36` 已停运（`routes.is_active = false`），
 *   而 `route_shapes` 里属于 `36/0` 的残留几何行还在 ——
 *   `scripts/test-route-shapes-gate.ts` 的 `DATA_GAP` 注释里已经把这个事实写死了：
 *   「它是停运线路（`routes.is_active=false`）的残留几何行」。也就是说
 *   `/api/route-shapes?code=36` 过去会**正常返回一条线的走向**，前端照画不误。
 *   ⇒ 闸必须加在 SQL 上（`AND is_active`），不是加在前端。
 *
 * ── ★ 为什么是 404，而不是 200 + 空结果 ───────────────────────────────────
 *   这是本文件唯一需要背下来的判断，三个接口共用同一条理由：
 *
 *   1) **404 与 5xx 是两个不同的用户动作。** 本仓早就把这条契约立在了
 *      `src/app/line/[code]/LineClient.tsx:152`：
 *        「404 = 该方向不存在（或线路已停运）⇒ **不可恢复**，与『服务故障』分开报」
 *      前端据此做分支 —— 404 → 空态「找不到这条线路」；其它 → 「稍后再试」+ 重试按钮。
 *      回 200 空结果会把「线路停运」伪装成「这次没取到」，用户点重试永远重试同一个死局。
 *
 *   2) **空结果是可修复状态，停运不是。** 本仓有一条现成的对照：
 *      `route-shapes` 的 `note: "no_shape"` 会配 `max-age=60`（短缓存），理由写在
 *      `route.ts:45-49`：「空结果是**可修复状态**（跑一次 `fetch:route-shapes` 就有）」。
 *      停运线路的空结果**永远补不回来**，把它塞进同一条 200 通路，等于让运维去追一个
 *      不存在的采集缺口。⇒ 「没数据」回 200 + 短缓存；「这条线没了」回 404。
 *
 *   3) **回空数组冒充成功会在前端淹掉真相。** `route-shapes` 的三个消费方
 *      （`LineClient` / `useRouteOverview` / `NavMap`）都是 `const j = await r.json()`
 *      后直接 `j.shapes ?? []`，**不看 `r.ok`**。若回 200 + `shapes: []`，停运线路会表现为
 *      「地图少画一条线」—— 没人会报 bug（用户不觉得自己缺了什么）；
 *      而回 404 + `shapes: []`，至少状态码这一层是诚实的，能被日志与将来的客户端分支看见。
 *
 *   ⚠️ 反面同样成立：**库查询失败（未知）不得判 404**。把一次连接抖动报成「线路已停运」，
 *      等于把可恢复故障标成不可恢复 —— 见 `activeGateOf` 的三值口径。
 *
 * ── 为什么判据要单独一个文件 ──────────────────────────────────────────────
 *   · `route.ts` 里**不允许** `export` 辅助函数（Next 的 `.next/types` 导出白名单会让
 *     `next build` 直接失败，而 `tsc --noEmit` 抓不到 —— 本项目踩过一次）；
 *   · 「停运 ⇒ 404」若只体现为三处 `if (!row) return 404`，断言就只能锁字符串
 *     （"源码里有 404"），而**锁不住语义**：把 `AND is_active` 删掉，字符串锁照样绿。
 *   ⇒ 抽出纯函数，让「停运 ⇒ absent」与「查询失败 ⇒ unknown」这两个**互斥的结论**
 *     可以在无数据库环境下被直接断言（见 `scripts/test-active-route-gate.ts`）。
 *
 * 纯函数、零依赖、可在任意环境单测。
 */

/** 三值裁决 —— **`unknown` 与 `absent` 必须分开**（见文件头反面那条） */
export type ActiveGate =
  /** 请求的每条线路都查到了在线行 */
  | "ok"
  /** 至少一条查不到（停运或不存在）⇒ 调用方回 404 */
  | "absent"
  /** 库查询失败 ⇒ **结论未知**，调用方按各自既有口径降级，**不得**回 404 */
  | "unknown";

/**
 * 请求的线路码里，哪些**没有**在线行。
 *
 * @param requested 请求涉及的线路码（可重复、可乱序；内部去重）
 * @param found     库里**查到的在线行**的 `code`（只问「有没有这一行」，
 *                  与 `color` / `company` 等列是否为空**无关** ——
 *                  一条在线但没配色的线路不该被当成停运）
 * @returns 缺失的线路码，**按 `requested` 首次出现顺序**（便于日志直接对照请求）
 */
export function missingActiveCodes(
  requested: readonly string[],
  found: readonly string[],
): string[] {
  const have = new Set(found);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of requested) {
    if (have.has(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

/**
 * 批量码的裁决（`detail-body` 用；单码接口直接用 `rows[0]` 存在性即可）。
 *
 * @param requested 请求涉及的线路码
 * @param found     `null` = **该查询失败了**（不是"查到 0 条"）；数组 = 查询成功的结果
 */
export function activeGateOf(
  requested: readonly string[],
  found: readonly string[] | null,
): ActiveGate {
  // ⚠️ 顺序不能反：`null` 必须先于「缺失判定」被拦下。
  //    写成 `missingActiveCodes(requested, found ?? []).length ? "absent" : "ok"` 会让
  //    一次库抖动把所有线路判成停运 ⇒ 详情弹窗对全员 404。这条由脚本 C4 反向守住。
  if (found === null) return "unknown";
  if (!requested.length) return "ok";
  return missingActiveCodes(requested, found).length ? "absent" : "ok";
}
