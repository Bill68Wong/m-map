/**
 * 默认组合的**预置路线**（src/lib/favorites/route-presets.ts，v2.4.0）
 *
 * ── 来源（★ 一字不差照抄，2026-09-21）───────────────────────────────────
 *   旧版「通勤计时」的 14 个**在用**方案（DB `commute_plans` + `plan_legs`）
 *   → 按「一趟完整行程 = 一条路线」展开为 **31 条路线**（见 `.verify/聚合后路线清单.md`）。
 *   · 停用的 19 个方案 **不抄**（拍板 2026-09-21）；
 *   · **不考虑通关**（终点即口岸；`cross_border` 段直接不产出）；
 *   · 每条路线 = 一条独立路线（「到站后任选」的卡按线路拆开，下车站取各自 `route_meta.to`）。
 *
 * ── 与座区的关系 ──────────────────────────────────────────────────────
 *   `home→school` / `school→home` 的路线在 **B/C · N/O · R 三个座区组合里各放一份**
 *   （拍板 2026-09-21）——同一趟车、下同一个站，只是「走去哪栋楼」不同 ⇒ 步行耗时不同。
 *   ⇒ 本表的 `zones` 字段声明该路线适用于哪些座区。
 *
 * ⚠️ 纯模块（客户端可 import）：**不得 import 含 pg / next 的模块**。
 * ⚠️ 站码/站名一律**繁体原文**（与全站口径一致）；文案外壳用简体。
 */

/** 步行端点标记（无站码侧：出发地/目的地） */
export const PLACE_HOME = "PLACE:home";
export const PLACE_SCHOOL = "PLACE:school";
export const PLACE_HENGQIN = "PLACE:hengqin";
export const PLACE_GATE = "PLACE:gate";

/** 路线里的一个分段（与 `RouteSeg` 同构，但这里只写「骨架」字段，标注/tag 由种子补） */
export interface PresetSeg {
  kind: "walk" | "ride" | "transfer";
  /** `walk` 的行走方向：`out` = 出发地→上车站；`in` = 下车站→目的地 */
  phase?: "out" | "in";
  /** 步行端点（`PLACE:*` 或站码） */
  from?: string;
  to?: string;
  /** 展示名（留给 UI 兜底；正常由站点表回填） */
  label?: string;
  /** `ride`：线路码 */
  route?: string;
  kind2?: "bus" | "lrt";
  board?: string;
  alight?: string;
  boardLabel?: string;
  alightLabel?: string;
  hops?: number;
  /** `transfer`：换乘站码 */
  at?: string;
}

/**
 * 预置路线定义。
 * `od` = `[fromSlug, toSlug]`；`zones` = 适用座区（空 = 不区分座区，全部适用）。
 */
export interface PresetRoute {
  /** 唯一键（稳定，用于幂等） */
  key: string;
  /** 一句话名（列表展示） */
  name: string;
  /** 线路标签（`RouteStack` 用；按顺序） */
  routeLabels: string[];
  od: [string, string];
  /** 适用座区（`home→school` / `school→home` 用；其它为空数组 = 不区分） */
  zones: string[];
  segs: PresetSeg[];
}

const S = (
  kind: PresetSeg["kind"],
  o: Partial<PresetSeg> & { route?: string; board?: string; alight?: string },
): PresetSeg => ({ kind, ...o });

/** ── 去学校（home → school）：3 张卡拆成 10 条线 ── */
const HOME_SCHOOL: PresetRoute[] = [
  // 卡 1：C653 金峰南岸 六线任选 → 拆 6 条
  ...[
    ["50", "T400", "T400 路氹東/新濠天地"],
    ["26", "T374", "T374 澳門土木工程實驗室"],
    ["26A", "T367", "T367 望德聖母灣馬路/連貫公路"],
    ["25", "T363/2", "T363/2 連貫公路/威尼斯人"],
    ["21A", "T363/1", "T363/1 連貫公路/威尼斯人"],
    ["N3", "T363/1", "T363/1 連貫公路/威尼斯人"],
  ].map(([route, alight, alightLabel]) => ({
    key: `hs-c653-${route}`,
    name: `${route} 路`,
    routeLabels: [route],
    od: ["home", "school"] as [string, string],
    zones: ["B/C", "N/O", "R"],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "C653", label: "C653 金峰南岸/金譽峰" }),
      S("ride", { route, kind2: "bus", board: "C653", alight, boardLabel: "C653 金峰南岸/金譽峰", alightLabel }),
      S("walk", { phase: "in", from: alight, to: PLACE_SCHOOL, label: alightLabel }),
    ],
  })),
  // 卡 2：蝴蝶谷大馬路總站 四线任选 → 拆 4 条
  ...[
    ["51", "T429", "T429 機場大馬路/科大醫院"],
    ["51A", "T374", "T374 澳門土木工程實驗室"],
    ["51B", "T363/1", "T363/1 連貫公路/威尼斯人"],
    ["25AX", "T363/2", "T363/2 連貫公路/威尼斯人"],
  ].map(([route, alight, alightLabel]) => ({
    key: `hs-c690-${route}`,
    name: `${route} 路`,
    routeLabels: [route],
    od: ["home", "school"] as [string, string],
    zones: ["B/C", "N/O", "R"],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "C690", label: "C690 蝴蝶谷大馬路總站" }),
      S("ride", { route, kind2: "bus", board: "C690", alight, boardLabel: "C690 蝴蝶谷大馬路總站", alightLabel }),
      S("walk", { phase: "in", from: alight, to: PLACE_SCHOOL, label: alightLabel }),
    ],
  })),
  // 卡 3：轻轨 石排灣→協和醫院→科大（去）→ 1 条（含换乘）
  {
    key: "hs-lrt",
    name: "轻轨（石排灣 → 協和醫院 → 科大）",
    routeLabels: ["LRT-石排湾线", "LRT-氹仔线"],
    od: ["home", "school"],
    zones: ["B/C", "N/O", "R"],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "LRT-SPW", label: "LRT-SPW 石排灣" }),
      S("ride", { route: "LRT-石排湾线", kind2: "lrt", board: "LRT-SPW", alight: "LRT-UH", boardLabel: "石排灣", alightLabel: "協和醫院" }),
      S("transfer", { at: "LRT-UH", label: "協和醫院" }),
      S("ride", { route: "LRT-氹仔线", kind2: "lrt", board: "LRT-UH", alight: "LRT-MUST", boardLabel: "協和醫院", alightLabel: "科大" }),
      S("walk", { phase: "in", from: "LRT-MUST", to: PLACE_SCHOOL, label: "科大" }),
    ],
  },
];

/** ── 回宿舍（school → home）── */
const SCHOOL_HOME: PresetRoute[] = [
  ...[
    ["26", "T373/2", "C652", "T373/2 偉龍/科技大學", "C652 安順大廈"],
    ["51A", "T373/2", "C690/1", "T373/2 偉龍/科技大學", "C690/1 蝴蝶谷大馬路總站"],
    ["51B", "T373/2", "C690/2", "T373/2 偉龍/科技大學", "C690/2 蝴蝶谷大馬路總站"],
  ].map(([route, board, alight, boardLabel, alightLabel]) => ({
    key: `sh-t373-${route}`,
    name: `${route} 路`,
    routeLabels: [route],
    od: ["school", "home"] as [string, string],
    zones: ["B/C", "N/O", "R"],
    segs: [
      S("walk", { phase: "out", from: PLACE_SCHOOL, to: board, label: boardLabel }),
      S("ride", { route, kind2: "bus", board, alight, boardLabel, alightLabel }),
      S("walk", { phase: "in", from: alight, to: PLACE_HOME, label: alightLabel }),
    ],
  })),
  {
    key: "sh-t417-51",
    name: "51 路",
    routeLabels: ["51"],
    od: ["school", "home"],
    zones: ["B/C", "N/O", "R"],
    segs: [
      S("walk", { phase: "out", from: PLACE_SCHOOL, to: "T417", label: "T417 科大/機場貨運站" }),
      S("ride", { route: "51", kind2: "bus", board: "T417", alight: "C690/3", boardLabel: "T417 科大/機場貨運站", alightLabel: "C690/3 蝴蝶谷大馬路總站" }),
      S("walk", { phase: "in", from: "C690/3", to: PLACE_HOME, label: "C690/3 蝴蝶谷大馬路總站" }),
    ],
  },
  {
    key: "sh-lrt",
    name: "轻轨（科大 → 協和醫院 → 石排灣）",
    routeLabels: ["LRT-氹仔线", "LRT-石排湾线"],
    od: ["school", "home"],
    zones: ["B/C", "N/O", "R"],
    segs: [
      S("walk", { phase: "out", from: PLACE_SCHOOL, to: "LRT-MUST", label: "LRT-MUST 科大" }),
      S("ride", { route: "LRT-氹仔线", kind2: "lrt", board: "LRT-MUST", alight: "LRT-UH", boardLabel: "科大", alightLabel: "協和醫院" }),
      S("transfer", { at: "LRT-UH", label: "協和醫院" }),
      S("ride", { route: "LRT-石排湾线", kind2: "lrt", board: "LRT-UH", alight: "LRT-SPW", boardLabel: "協和醫院", alightLabel: "石排灣" }),
      S("walk", { phase: "in", from: "LRT-SPW", to: PLACE_HOME, label: "LRT-SPW 石排灣" }),
    ],
  },
];

/** ── 去/回關閘 ── */
const HOME_GATE: PresetRoute[] = [
  {
    key: "hg-c653-59",
    name: "59 路",
    routeLabels: ["59"],
    od: ["home", "gate"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "C653", label: "C653 金峰南岸/金譽峰" }),
      S("ride", { route: "59", kind2: "bus", board: "C653", alight: "M9/2", boardLabel: "C653 金峰南岸/金譽峰", alightLabel: "M9/2 關閘廣場" }),
      S("walk", { phase: "in", from: "M9/2", to: PLACE_GATE, label: "M9/2 關閘廣場" }),
    ],
  },
  {
    key: "hg-c653-25",
    name: "25 路",
    routeLabels: ["25"],
    od: ["home", "gate"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "C653", label: "C653 金峰南岸/金譽峰" }),
      S("ride", { route: "25", kind2: "bus", board: "C653", alight: "M1/13", boardLabel: "C653 金峰南岸/金譽峰", alightLabel: "M1/13 關閘總站" }),
      S("walk", { phase: "in", from: "M1/13", to: PLACE_GATE, label: "M1/13 關閘總站" }),
    ],
  },
  ...[
    ["51", "M9/4", "M9/4 關閘廣場"],
    ["51B", "M9/4", "M9/4 關閘廣場"],
    ["25AX", "M9/3", "M9/3 關閘廣場"],
  ].map(([route, alight, alightLabel]) => ({
    key: `hg-c690-${route}`,
    name: `${route} 路`,
    routeLabels: [route],
    od: ["home", "gate"] as [string, string],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "C690", label: "C690 蝴蝶谷大馬路總站" }),
      S("ride", { route, kind2: "bus", board: "C690", alight, boardLabel: "C690 蝴蝶谷大馬路總站", alightLabel }),
      S("walk", { phase: "in", from: alight, to: PLACE_GATE, label: alightLabel }),
    ],
  })),
];

const GATE_HOME: PresetRoute[] = [
  {
    key: "gh-m1-25",
    name: "25 路",
    routeLabels: ["25"],
    od: ["gate", "home"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_GATE, to: "M1/13", label: "M1/13 關閘總站" }),
      S("ride", { route: "25", kind2: "bus", board: "M1/13", alight: "C652", boardLabel: "M1/13 關閘總站", alightLabel: "C652 安順大廈" }),
      S("walk", { phase: "in", from: "C652", to: PLACE_HOME, label: "C652 安順大廈" }),
    ],
  },
  ...[
    ["51", "M9/4", "M9/4 關閘廣場"],
    ["51B", "M9/4", "M9/4 關閘廣場"],
    ["59", "M9/2", "M9/2 關閘廣場"],
    ["25AX", "M9/3", "M9/3 關閘廣場"],
  ].map(([route, board, boardLabel]) => ({
    key: `gh-m9-${route}`,
    name: `${route} 路`,
    routeLabels: [route],
    od: ["gate", "home"] as [string, string],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_GATE, to: board, label: boardLabel }),
      S("ride", { route, kind2: "bus", board, alight: "C690/3", boardLabel, alightLabel: "蝴蝶谷大馬路總站" }),
      S("walk", { phase: "in", from: "C690/3", to: PLACE_HOME, label: "蝴蝶谷大馬路總站" }),
    ],
  })),
];

/** ── 去/回横琴 ── */
const HOME_HENGQIN: PresetRoute[] = [
  {
    key: "hh-bus-26",
    name: "26 → 50/25B/25BS/102/701X/N6（换乘）",
    routeLabels: ["26", "50"],
    od: ["home", "hengqin"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "C653", label: "C653 金峰南岸/金譽峰" }),
      S("ride", { route: "26", kind2: "bus", board: "C653", alight: "T355/2", boardLabel: "C653 金峰南岸/金譽峰", alightLabel: "T355/2 蓮花路停車場" }),
      S("transfer", { at: "T355/2", label: "蓮花路停車場" }),
      S("ride", { route: "50", kind2: "bus", board: "T355/2", alight: "T560/4", boardLabel: "蓮花路停車場", alightLabel: "T560/4 橫琴澳方口岸" }),
      S("walk", { phase: "in", from: "T560/4", to: PLACE_HENGQIN, label: "T560/4 橫琴澳方口岸" }),
    ],
  },
  {
    key: "hh-bus-50",
    name: "50 → 50/25B/25BS/102/701X/N6（换乘）",
    routeLabels: ["50", "50"],
    od: ["home", "hengqin"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "C653", label: "C653 金峰南岸/金譽峰" }),
      S("ride", { route: "50", kind2: "bus", board: "C653", alight: "T355/2", boardLabel: "C653 金峰南岸/金譽峰", alightLabel: "T355/2 蓮花路停車場" }),
      S("transfer", { at: "T355/2", label: "蓮花路停車場" }),
      S("ride", { route: "50", kind2: "bus", board: "T355/2", alight: "T560/4", boardLabel: "蓮花路停車場", alightLabel: "T560/4 橫琴澳方口岸" }),
      S("walk", { phase: "in", from: "T560/4", to: PLACE_HENGQIN, label: "T560/4 橫琴澳方口岸" }),
    ],
  },
  {
    key: "hh-lrt",
    name: "轻轨（石排灣 → 協和醫院 → 蓮花 → 橫琴）",
    routeLabels: ["LRT-石排湾线", "LRT-氹仔线", "LRT-横琴线"],
    od: ["home", "hengqin"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HOME, to: "LRT-SPW", label: "LRT-SPW 石排灣" }),
      S("ride", { route: "LRT-石排湾线", kind2: "lrt", board: "LRT-SPW", alight: "LRT-UH", boardLabel: "石排灣", alightLabel: "協和醫院" }),
      S("transfer", { at: "LRT-UH", label: "協和醫院" }),
      S("ride", { route: "LRT-氹仔线", kind2: "lrt", board: "LRT-UH", alight: "LRT-LOT", boardLabel: "協和醫院", alightLabel: "蓮花" }),
      S("transfer", { at: "LRT-LOT", label: "蓮花" }),
      S("ride", { route: "LRT-横琴线", kind2: "lrt", board: "LRT-LOT", alight: "LRT-HQ", boardLabel: "蓮花", alightLabel: "橫琴" }),
      S("walk", { phase: "in", from: "LRT-HQ", to: PLACE_HENGQIN, label: "LRT-HQ 橫琴" }),
    ],
  },
];

const HENGQIN_HOME: PresetRoute[] = [
  {
    key: "qh-50",
    name: "50 路",
    routeLabels: ["50"],
    od: ["hengqin", "home"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HENGQIN, to: "T560/4", label: "T560/4 橫琴澳方口岸" }),
      S("ride", { route: "50", kind2: "bus", board: "T560/4", alight: "C652", boardLabel: "T560/4 橫琴澳方口岸", alightLabel: "C652 安順大廈" }),
      S("walk", { phase: "in", from: "C652", to: PLACE_HOME, label: "C652 安順大廈" }),
    ],
  },
  {
    key: "qh-lrt",
    name: "轻轨（橫琴 → 蓮花 → 協和醫院 → 石排灣）",
    routeLabels: ["LRT-横琴线", "LRT-氹仔线", "LRT-石排湾线"],
    od: ["hengqin", "home"],
    zones: [],
    segs: [
      S("walk", { phase: "out", from: PLACE_HENGQIN, to: "LRT-HQ", label: "LRT-HQ 橫琴" }),
      S("ride", { route: "LRT-横琴线", kind2: "lrt", board: "LRT-HQ", alight: "LRT-LOT", boardLabel: "橫琴", alightLabel: "蓮花" }),
      S("transfer", { at: "LRT-LOT", label: "蓮花" }),
      S("ride", { route: "LRT-氹仔线", kind2: "lrt", board: "LRT-LOT", alight: "LRT-UH", boardLabel: "蓮花", alightLabel: "協和醫院" }),
      S("transfer", { at: "LRT-UH", label: "協和醫院" }),
      S("ride", { route: "LRT-石排湾线", kind2: "lrt", board: "LRT-UH", alight: "LRT-SPW", boardLabel: "協和醫院", alightLabel: "石排灣" }),
      S("walk", { phase: "in", from: "LRT-SPW", to: PLACE_HOME, label: "LRT-SPW 石排灣" }),
    ],
  },
];

/** 全部预置路线（31 条） */
export const PRESET_ROUTES: PresetRoute[] = [
  ...HOME_SCHOOL,
  ...SCHOOL_HOME,
  ...HOME_GATE,
  ...GATE_HOME,
  ...HOME_HENGQIN,
  ...HENGQIN_HOME,
];
