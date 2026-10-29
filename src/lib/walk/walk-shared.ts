/**
 * 步行分步 · 前后端共用类型与派生规则（src/lib/walk/walk-shared.ts，v3.6.0 · S5）
 *
 * ── 为什么单独成文件（type-only + 纯函数）────────────────────────────────
 *   客户端组件（`useWalkRoute` / `WalkStepList` / `WalkTurnBanner`）要**同时**知道
 *   `WalkStep` 的形状和「这一步是左转还是右转」。若它们直接从 `src/lib/amap/walking.ts`
 *   import，就会把 `process.env.AMAP_KEY`、`pg` 之类服务端依赖拖进浏览器包
 *   （项目铁律 6：client 禁 import 含 pg 的 server 模块）。
 *   ⇒ 本文件**只允许**出现 `type` 与纯函数，零 import 服务端模块。
 *
 * ── `turn` 为什么必须服务端派生 ─────────────────────────────────────────
 *   前端若要自己从 `instruction` 文本猜「左转/右转」，就和后端各有一套正则 ——
 *   两套判断迟早分叉，表现为「横幅说左转、地图箭头指右」。故**派生只发生一次**，
 *   在 `walking.ts` 里调 `turnOf()` 落进 `WalkStep.turn`，前端直接用、不得重算。
 *   （与 `track.ts` 文件头「绝不猜测」同一纪律。）
 */

/** 一次转向的种类 —— 服务端派生，前端**不得**自行从文本推断 */
export type WalkTurn = "straight" | "left" | "right" | "uturn" | "arrive";

/** 一步（= 高德 `route.paths[0].steps[i]` 的对外形态） */
export type WalkStep = {
  /** 0 起；**已剔除无效步之后的连续序号**（不是高德原始下标） */
  idx: number;
  /** 服务端派生（见 `turnOf`），前端不得猜 */
  turn: WalkTurn;
  /** 高德 `instruction` 原文（**不做简繁转换**，避免二次改写语义） */
  text: string;
  /** 补充说明（高德 `road_name`）；缺失时不渲染、不留空行 */
  sub?: string;
  /** 该步距离（整数米，显示用；取高德 `step_distance`，缺失则回退几何长度） */
  distM: number;
  /** 该步起点在**全线**的累计里程（米） */
  cumStartM: number;
  /** 该步几何（GCJ-02），≥2 点 */
  polyline: [number, number][];
  /**
   * 与 `polyline` **等长**的累计里程（米），`cumM[0] === cumStartM`。
   * 客户端二分查「我走到第几步」用它，不必再自己算 `cumDistM()`。
   */
  cumM: number[];
};

/** `GET /api/nav/walk` 的响应体 */
export type WalkRouteResp =
  | {
      ok: true;
      steps: WalkStep[];
      totalDistM: number;
      totalDurationS: number;
    }
  | { ok: false; error: string };

/**
 * 从高德 `instruction` 文本派生转向种类。
 *
 * ── 规则（**取最后一次出现的转向词**）───────────────────────────────────
 *   高德文案的形态是「沿 X 路向东南步行 120 米，**左转**进入 Y 路」——
 *   动作发生在**这一步的末尾**。故用「最后一个匹配」而非「第一个」：
 *   若取第一个，`沿XX左转后直行…右转进入YY` 会被误判成左转。
 *
 * ── 词表（覆盖高德 v5 walking 实测文案）────────────────────────────────
 *   · `掉头` ⇒ uturn（优先级最高，与左右转互斥）
 *   · `左转` / `向左` / `左前` / `左后` ⇒ left
 *   · `右转` / `向右` / `右前` / `右后` ⇒ right
 *   · `到达` / `抵达` / `终点` ⇒ arrive
 *   · 其余（含「直行」「沿…步行」「进入…」）⇒ straight
 *
 * ⚠️ 识别不出**一律归 straight**，不抛错、不返回 null ——
 *    调用方（渲染层）只处理五种取值，多一种状态就多一种没人测的分支。
 */
export function turnOf(instruction: string): WalkTurn {
  const text = typeof instruction === "string" ? instruction : "";
  const re = /掉头|左转|向左|左前|左后|右转|向右|右前|右后|到达|抵达|终点/g;
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[0];
  if (!last) return "straight";
  if (last === "掉头") return "uturn";
  if (last === "左转" || last.startsWith("左")) return "left";
  if (last === "右转" || last.startsWith("右")) return "right";
  return "arrive"; // 到达 / 抵达 / 终点
}
