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
      /** 高德自报的全线距离（米）——**显示用**；与几何链可能差 1% 级（弦长 vs 弧长） */
      totalDistM: number;
      /**
       * **几何链末值**（各步 `polyline` 累加到位，米）。
       *
       * ★ 为什么必须显式下发（S5 评审阻断 ②）：中间步被丢弃时（缺 `instruction` /
       *   几何不足 2 点），`totalDistM` 仍含被丢段落、几何链不含 ⇒ 两者可差 **30%~60%**。
       *   前端算「还有 N 米」必须用 `stepsTotalM − doneM`；用 `totalDistM` 会
       *   **永远差一截到不了 0**（表现为"走到目的地还显示还有 500 米"）。
       */
      stepsTotalM: number;
      totalDurationS: number;
    }
  | { ok: false; error: string };

/**
 * 该步的**几何长度**（米，由 `cumM` 末值减首值得出）。
 *
 * ★ 前端算「本步走了多少比例」必须用它做分母，**不要用 `distM`**（评审 advisory 1）：
 *   `distM` 是高德的整数米（与实际折线有 1% 级差异），拿它做分母会让 `ratio`
 *   出现 `> 1` 或「永远差一点点到 1」的抖动。
 */
export function stepGeomM(s: Pick<WalkStep, "cumM">): number {
  if (!s.cumM?.length) return 0;
  return s.cumM[s.cumM.length - 1] - s.cumM[0];
}

/**
 * 从高德 `instruction` 文本派生转向种类。
 *
 * ── 规则（**取最后一次出现的转向词**）───────────────────────────────────
 *   高德文案的形态是「沿 X 路向东南步行 120 米，**左转**进入 Y 路」——
 *   动作发生在**这一步的末尾**。故用「最后一个匹配」而非「第一个」：
 *   若取第一个，`沿XX左转后直行…右转进入YY` 会被误判成左转。
 *
 * ── 词表（按**完整转向词**匹配，含可选的「向」前缀）──────────────────────
 *   · `掉头` ⇒ uturn（最高优先，与左右转互斥）
 *   · `向左` / `左转` / `左前方` / `左后` ⇒ left
 *   · `向右` / `右转` / `右前方` / `右后` ⇒ right
 *   · `到达` / `抵达` / `终点` ⇒ arrive（**仅末步**，见 `isLast`）
 *   · 其余（含「直行」「沿…步行」「进入…」）⇒ straight
 *
 * ⚠️ 识别不出**一律归 straight**，不抛错、不返回 null ——
 *    调用方（渲染层）只处理五种取值，多一种状态就多一种没人测的分支。
 *
 * ── ⚠️⚠️ S5 评审阻断 ①（本函数曾把「向左」判成「到达」，用户可见）────────────
 *   旧实现的**词表里有** `向左|向右`，但归类写的是 `last === "左转" || last.startsWith("左")`。
 *   `"向左"` 首字是「向」不是「左」⇒ 两个分支都不命中 ⇒ 落到兜底的 `arrive`。
 *   更糟：`向左` 在词表里排在 `左前` 之前，故 **`左前/右前` 两条永远不可达**；
 *   而高德的斜向文案几乎都写成「向左前方」⇒ **斜向行走全部误报「到达」旗**。
 *   ⇒ 现改为「正则匹配完整转向词 + 用 `includes` 归类」。**词表与归类必须同改**，
 *     只改一边就会重现这个 bug（这也是它当初能一路走到评审的原因：全仓 0 个断言）。
 *
 * @param instruction 高德原文
 * @param isLast      **是否为最后一步**（默认 `true`）。非末步时「到达/抵达/终点」归 `straight`：
 *                    高德在中途步会用「到达新馬路」这类措辞，不拦就会冒出中途到达旗。
 *                    ⚠️ 默认 `true` 是为让「单步路径 / 独立调用」保持 `到达 ⇒ arrive` 的直觉；
 *                    批量解析时**必须**显式传 `idx === steps.length - 1`。
 */
export function turnOf(instruction: string, isLast = true): WalkTurn {
  const text = typeof instruction === "string" ? instruction : "";
  // ★ 必须匹配**完整转向词**（含可选「向」前缀 + 后缀 转/前/后），
  //   否则 `向左` 只被匹配到半个词，归类又会掉进兜底分支（即上面那个 bug）。
  const re = /掉头|向?左(?:转|前方?|后方?)?|向?右(?:转|前方?|后方?)?|到达|抵达|终点/g;
  let last: string | null = null;
  for (const m of text.matchAll(re)) last = m[0];
  if (!last) return "straight";
  if (last === "掉头") return "uturn";
  if (last.includes("左")) return "left";
  if (last.includes("右")) return "right";
  return isLast ? "arrive" : "straight";
}
