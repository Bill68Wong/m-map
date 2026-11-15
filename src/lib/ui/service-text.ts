/**
 * 「没有车 / 不在营运时间」的文案**唯一出处**（src/lib/ui/service-text.ts，2026-11-12）
 *
 * ── 为什么必须抽出来（问题 4）────────────────────────────────────────────
 *   同一句「没有车」的文案此前**硬编码在三处**，且三处口径不同：
 *     · `src/lib/nav/detail-fold.ts`（服务端折叠栏「本站台其他线路」）
 *     · `src/components/nav/StationCard.tsx`（站点卡报站行）
 *     · `src/components/LrtEta.tsx`（轻轨：`首班前` / `今日已收车` / `暂无时刻`）
 *   ⇒ **同一状态两种说法**。本文件是唯一映射：三处共用，禁止任何调用方再各写一份 switch / 三元。
 *
 * ── 为什么口径来自 `serviceStateAt()` 而不是自己判营业时间 ────────────────
 *   `src/lib/recommend/schedule.ts#serviceStateAt` 已经是五态（`open` / `closing` /
 *   `closed` / `before_first` / `no_data`），且自带**假期感知**与**跨午夜感知**
 *   （双探针 `nowMin` / `nowMin+1440`）与末班宽限。在 UI 层另写一套「现在几点、算不算营运」
 *   必然与它漂移（两套星期/假期判定 = 两个口径）。⇒ **本文件只做映射，不做判定**。
 *
 * ── ⚠️ 双端可用（client + server）────────────────────────────────────────
 *   服务端调用方：`detail-fold.ts`（有 `Pool`，能 `loadHeadway` 得到 `HeadwayIndex`）。
 *   客户端调用方：`StationCard.tsx` / `LrtEta.tsx`（**拿不到** `HeadwayIndex`）。
 *   ⇒ 本文件**禁止 import 任何含 `pg` 的模块**：`ServiceState` 只做 `import type`
 *     （编译期擦除，不产生运行时依赖）。
 *   ⚠️ 不要为了少写一行而把本文件合并进 `schedule.ts`：那个文件运行时 import 了
 *     `headway.ts`（→ `pg`），客户端一引就把 pg 打进浏览器包。
 *
 * ── 映射表（负责人 2026-11-12 裁定，一字不得改）──────────────────────────
 *   | 状态                        | 文案（唯一字面量见 `NO_VEHICLE_TEXT`） |
 *   |-----------------------------|----------------------------------------|
 *   | `closed` / `before_first`   | offHours                               |
 *   | `after_last`（轻轨同义）    | offHours                               |
 *   | `open` / `closing`（无车）  | notDeparted                            |
 *   | `no_data` / `null`          | noData                                 |
 *
 *   ★★ 负责人原话：「统一改成『非营运时间』，而且**仅有这五个字，不加时间等**」。
 *   ⇒ offHours 那句**后面永远不接任何东西**：不拼首班/末班时刻、不拼方向名、不加括号。
 *   ⇒ 本文件因此**没有** `opts` 参数、没有 `firstClock` / `lastClock`、没有拼接分支。
 *     **不要**为了「说得更具体」把时刻加回来 —— 首末班时刻若需要展示，由各页面用
 *     **独立的 UI 元素**（例如时刻表区块）自己渲染，不属于本函数的返回值。
 */

/** 服务端五态（`schedule.ts`）—— 只取类型，不取运行时 */
import type { ServiceState } from "@/lib/recommend/schedule";

/**
 * 文案可识别的状态。
 * `after_last` = 轻轨侧（`src/lib/lrt/next-departures.ts:43`）的「今日已收车」，
 * 语义与 `closed` 同（当日服务窗口已结束）⇒ 并入同一句，避免「同一状态两种说法」。
 */
export type NoVehicleState = ServiceState | "after_last";

/**
 * 三种文案的**唯一字面量**。
 * 改文案只改这里；三处调用方都不许再出现这些字符串的字面量
 * （`scripts/test-service-text.ts` 会扫描 `src/` 断言之）。
 */
export const NO_VEHICLE_TEXT = {
  /** 不在营运窗口内（含首班前 / 已收车 / 窗口内断档）—— 负责人裁定：仅这五个字 */
  offHours: "非营运时间",
  /** 在营运窗口内、但这一趟还没发车 */
  notDeparted: "暂未发车",
  /** 无班距/时刻数据 ⇒ 不猜（保持改前文案） */
  noData: "暂无班次信息",
} as const;

/**
 * 状态 → 文案。**签名只有一个参数**（没有可选的时刻补充，见文件头裁定）。
 *
 * @param state 五态之一（或轻轨 `after_last`）；`null` / `undefined` = 调用方拿不到状态
 */
export function noVehicleText(state: NoVehicleState | null | undefined): string {
  switch (state) {
    case "before_first":
    case "closed":
    case "after_last":
      // 首班前：车还没发出来；已收车：当日窗口结束；窗口内断档：同样不在营运时间
      return NO_VEHICLE_TEXT.offHours;
    case "open":
    case "closing":
      // 在营运窗口内却没有车 ⇒ 只能是「这一趟还没发车」（不是「没班次」）
      return NO_VEHICLE_TEXT.notDeparted;
    case "no_data":
    default:
      // 没有数据就不猜：这是改前唯一正确的说法，保留
      return NO_VEHICLE_TEXT.noData;
  }
}
