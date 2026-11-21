/**
 * 跨境地标 · 聚合阈值门禁（scripts/check-xborder-cluster.ts，2026-11-21）
 *
 * ── 为什么单开一个脚本，而不是并进 `check-xborder-ui.tsx` ─────────────────
 *   `check-xborder-ui.tsx` 管的是「跨境三块板上的图标 / 置灰 / 空态 / 表格轨道」，
 *   一行地图代码都不碰；本脚本管的是**地图 pin 的直径与聚合阈值**。
 *   两者语义无关，硬塞进去只会让那个脚本的段头变成杂物间。
 *   （更不能进 `test:platform-of`：那是导航站台坐标，毫无关系。）
 *
 * ── 守的是什么 ─────────────────────────────────────────────────────────
 *   2026-11-21 圆点 14 → 16px，聚合阈值随之 20 → 22。三个数必须**互相锁住**，
 *   否则会静默复发本批已踩过一次的病：**两圆已经撞上了却不合并** ——
 *   用户点到的"一个点"其实是两个设施，那是信息损失，不是防误点。
 *
 *   ① **常量自洽** `XB_CLUSTER_MAX_PX === XB_PIN_SIZE + XB_PIN_GAP`
 *      必须一直写成公式。历史上它是手调的魔数（20），改 pin 尺寸时忘了跟改。
 *      这条断言读的是**导出的常量值**，所以"有人把 22 硬编码进去"会当场红。
 *
 *   ② **两处同值** CSS 的 `--xb-pin-size` 与 JS 的 `XB_PIN_SIZE` 逐值相等。
 *      一个是**画**出来的直径、一个是**算阈值**的直径；不一致 = "画 16、算 14"，
 *      现象就是"看起来还差 2px 才碰上，却提前合并了"（或反之漏合并）。
 *
 *   ③ **z12 不聚合** 机场 ↔ 氹仔码头的屏幕圆心距必须**大于**阈值。
 *      ⚠️ 这条**只判方向，不判余量大小**。本仓踩过"判据写太紧 ⇒ 为了让门禁变绿
 *      去改产品代码"的亏（见 E7 那次：沿线位移 53.2m > 30m，最后是**删掉**断言
 *      而不是把阈值调到 60）。所以这里写的不是「余量 ≥ 2px」，而是「余量不为负」。
 *      余量本身**无论正负都打印**——它是读数，不是判据；它现在很薄，薄到值得每次看一眼。
 *
 * ── z12 的 22.16px 是哪来的（数字必须可复算，别当魔数抄）───────────────────
 *   两个点 = `xborder-pins.ts#XB_PINS` 的 `airport`（113.579393, 22.154770）
 *   与 `TP`（113.581164, 22.161624），**GCJ-02**，中纬 22.158197°。
 *   换算 = 地面距离 / `xbMetersPerPixel(midLat, zoom)`
 *        = 779.3m / (156543.03392·cos(midLat)/2^12) = **22.0176px**（本脚本现算，决定性口径）。
 *   2026-11-08 另用 `amap.lngLatToContainer()` 在桌面 Chrome（DPR 2）实测交叉核对得
 *   **22.16px**，与公式差 0.14px（高德投影分辨率与 `xbMetersPerPixel` 近似的差）。
 *   ⚠️ **生产判据走的是公式**（`groupXbPins` 只调 `xbMetersPerPixel`），所以
 *      真正起作用的余量是 **+0.0176px**，不是文档里那个 +0.16px。
 *      两者都为正 ⇒ z12 确实不聚合；但这意味着**再加 0.02px 就会翻面**，
 *      以后谁要放大圆点 / 放宽间隙，先看本脚本打印的余量。
 *
 *   z11（地图最小档，`setZooms([11,19])`）是唯一该聚合的档：11.0088px < 22。
 *   本脚本把它当**活性对照**（[C2]）：只有 z11 真合并，才能证明
 *   「z12 不聚合」不是因为配对清单空了 / 阈值函数没被调用而恒真。
 *
 *   纯函数 + 读 CSS 文本 ⇒ **不连库、不联网、不需要浏览器**，可进 verify。
 *
 * 运行：npx tsx scripts/check-xborder-cluster.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  groupXbPins,
  XB_CLUSTER_MAX_PX,
  XB_PIN_GAP,
  XB_PIN_SIZE,
  XB_PINS,
  xbDistanceMeters,
  xbMetersPerPixel,
} from "../src/components/map/xborder-pins";

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${msg}`);
  } else {
    fail++;
    console.error(`  FAIL  ${msg}`);
  }
}
function assertEq<T>(a: T, b: T, msg: string) {
  assert(Object.is(a, b), `${msg}（实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}）`);
}

/* ══════════════════════════════════════════════════════════════════════
 * [A] 常量自洽：阈值必须恒等于「直径 + 间隙」
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[A] 常量自洽：XB_CLUSTER_MAX_PX = XB_PIN_SIZE + XB_PIN_GAP");
console.log(`  读数 XB_PIN_SIZE=${XB_PIN_SIZE} ｜ XB_PIN_GAP=${XB_PIN_GAP} ｜ XB_CLUSTER_MAX_PX=${XB_CLUSTER_MAX_PX}`);
assertEq(
  XB_CLUSTER_MAX_PX,
  XB_PIN_SIZE + XB_PIN_GAP,
  "阈值 = 直径 + 间隙（这条钉的是「它是公式，不是手调的数字」）",
);
/* 自洽的另一半：语义上这两个量必须是正数，否则阈值会退化成一个不可能撞上的数，
   让"永远不聚合"冒充"永远分得开"——那是另一种静默失效。 */
assert(XB_PIN_SIZE > 0, "直径为正（≤0 ⇒ 阈值失去意义）");
assert(XB_PIN_GAP >= 0, "间隙非负（负间隙 = 两个圆允许互相压进去）");

/* ══════════════════════════════════════════════════════════════════════
 * [B] 两处同值：CSS 画的直径 = JS 算阈值的直径
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[B] 两处同值：`--xb-pin-size`（CSS）与 `XB_PIN_SIZE`（JS）");
const CSS_PATH = resolve(process.cwd(), "src/app/globals.css");
const CSS_TEXT = readFileSync(CSS_PATH, "utf8");

/** 取 `--xb-pin-size` 的**全部**声明值（px 数值）；没有声明 ⇒ 空数组 */
function pinSizeDecls(text: string = CSS_TEXT): number[] {
  return [...text.matchAll(/--xb-pin-size:\s*([\d.]+)px/g)].map((m) => Number(m[1]));
}
/** 取某个类选择器（必须独立成行、紧跟 `{`）的整段声明体；取不到 ⇒ null */
function ruleBody(sel: string, text: string = CSS_TEXT): string | null {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = text.match(new RegExp(`\\n${esc}\\s*\\{([^}]*)\\}`));
  return m ? m[1] : null;
}

const decls = pinSizeDecls();
console.log(`  读数 globals.css 里 \`--xb-pin-size\` 的声明值 = [${decls.join(", ")}]`);
assert(decls.length >= 1, "`--xb-pin-size` 在 globals.css 里确实有声明（取不到 ⇒ 下面的比对是空转）");
/* 允许重复声明（`@media` 里覆盖是合法写法），但**所有**值必须一致：
   两个不同值并存时，最后一条生效、前面的静默失效，那正是最难查的一类。 */
assert(
  decls.every((v) => v === XB_PIN_SIZE),
  `每一处 \`--xb-pin-size\` 都等于 XB_PIN_SIZE=${XB_PIN_SIZE}（实际 [${decls.join(", ")}]）`,
);

/* 第二重：这个 token 必须真的被 `.nav-map__xbpin` 的 width/height 用上。
   否则 token 改对了、圆点仍是硬编码的 16px ⇒ [B] 第一条会变成"检查一个死变量"。 */
const pinBody = ruleBody(".nav-map__xbpin");
assert(pinBody != null, "能在 globals.css 里取到 `.nav-map__xbpin { … }` 声明体");
assert(
  !!pinBody && /width:\s*var\(--xb-pin-size\)/.test(pinBody) && /height:\s*var\(--xb-pin-size\)/.test(pinBody),
  "`.nav-map__xbpin` 的 width/height 都走 `var(--xb-pin-size)`（不得硬编码 16px，否则 token 与实际直径脱钩）",
);

/* ══════════════════════════════════════════════════════════════════════
 * [C] z12 不聚合（只判方向，不判余量大小）
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[C] z12 不聚合：机场 ↔ 氹仔码头的屏幕圆心距 > 阈值");

const AP = XB_PINS.find((p) => p.id === "airport");
const TP = XB_PINS.find((p) => p.id === "TP");
assert(!!AP && !!TP, "XB_PINS 里同时有 `airport` 与 `TP`（缺一个 ⇒ 下面的圆心距无从谈起）");

if (AP && TP) {
  const groundM = xbDistanceMeters(AP, TP);
  const midLat = (AP.lat + TP.lat) / 2;
  /** 屏幕圆心距（px）。**走生产同一条换算**，不另写一份公式 */
  const pxAt = (zoom: number) => groundM / xbMetersPerPixel(midLat, zoom);

  const px12 = pxAt(12);
  const margin = px12 - XB_CLUSTER_MAX_PX;
  /* 读数**总是**打印（正负都打）：这条余量是本批最薄的一根线，不给数字等于没门禁 */
  console.log(
    `  读数 地面距离=${groundM.toFixed(1)}m ｜ 中纬=${midLat.toFixed(6)}°` +
      ` ｜ z12 圆心距=${px12.toFixed(4)}px ｜ 阈值=${XB_CLUSTER_MAX_PX}px` +
      ` ｜ 余量=${margin > 0 ? "+" : ""}${margin.toFixed(4)}px` +
      `（2026-11-08 AMap 实测交叉核对 22.16px ⇒ 余量 +0.16px，差 0.14px 见文件头）`,
  );

  /* ── 判据 ③-a：只判方向 ────────────────────────────────────────────────
     ⚠️ **不要把这里写成 `margin >= 2` 之类的余量门槛**：余量大小由坐标、圆点尺寸、
        间隙三者共同决定，把它写进判据等于"以后调 pin 尺寸时必须连判据一起改" ——
        本仓已经因为判据写太紧而出现过"为了让门禁变绿去改产品代码"。
        这里只问一件事：**z12 到底聚合不聚合**。 */
  assert(margin >= 0, `z12 余量不为负（实际 ${margin.toFixed(4)}px；< 0 ⇒ z12 起就开始聚合）`);

  /* ── 判据 ③-b：行为层 ──────────────────────────────────────────────────
     代码里的比较是 `pxDist <= XB_CLUSTER_MAX_PX`（**闭区间**）⇒ 余量恰好为 0 时
     仍会合并。所以"不聚合"的准确条件是 `margin > 0`，上面那条 `>= 0` 覆盖不了
     边界那一点，这里用**真的调一遍 `groupXbPins`** 补上：
     它不看数字，只看"渲染出来是 4 个点还是 3 个点"。 */
  const g12 = groupXbPins(12);
  const cluster12 = g12.filter((g) => g.clusterKey !== null);
  assertEq(cluster12.length, 0, "z12：没有任何聚合点（首屏该各自显示，负责人 2026-11-08 裁定）");
  assertEq(g12.length, XB_PINS.length, `z12：渲染单元数 = 地标数 ${XB_PINS.length}（聚合会少一个）`);
  /* 逐点核验"合并时取中点"没有偷偷发生：两个 id 必须各自带着**自己的**坐标出现在图上 */
  const apGroup = g12.find((g) => g.ids.length === 1 && g.ids[0] === "airport");
  const tpGroup = g12.find((g) => g.ids.length === 1 && g.ids[0] === "TP");
  assert(!!apGroup && !!tpGroup, "z12：`airport` 与 `TP` 各自是一个单点单元");
  assert(
    !!apGroup && apGroup.lng === AP.lng && apGroup.lat === AP.lat,
    "z12：`airport` 单元用的是它自己的坐标（不是两点中点 ⇒ 没被合并后取中）",
  );

  /* ── 活性对照 [C2]：z11 必须合并 ────────────────────────────────────────
     没有这一条，"z12 不聚合"有可能是因为配对清单空了、或阈值函数根本没被调用 ——
     那种情况下上面的断言会**恒绿**，是本仓最讨厌的假绿。 */
  const px11 = pxAt(11);
  const g11 = groupXbPins(11);
  const merged11 = g11.filter((g) => g.clusterKey !== null);
  console.log(
    `  读数 z11 圆心距=${px11.toFixed(4)}px ｜ 余量=${(px11 - XB_CLUSTER_MAX_PX).toFixed(4)}px` +
      ` ｜ 聚合点数=${merged11.length}（这是**该**聚合的档，用来证明门禁不是恒绿）`,
  );
  assertEq(merged11.length, 1, "z11（地图最小档）：机场与氹仔码头合并成 1 个聚合点（活性对照）");
  assertEq(merged11[0]?.clusterKey, "airport+TP", "z11：聚合键逐字为 `airport+TP`");
  assertEq(g11.length, XB_PINS.length - 1, `z11：渲染单元数 = 地标数 − 1`);

  /* ── 反向对照：把 z12 那根线**只是假设**压过去，行为必须跟着翻面 ─────────
     不写盘、不改 `src/`：只在断言里证明"如果阈值是 23，z12 就会聚合"，
     说明 ③-b 读的是真行为、不是某个常量快照。 */
  assert(
    px12 <= XB_CLUSTER_MAX_PX + 1,
    `反向对照：阈值若 +1px（${XB_CLUSTER_MAX_PX + 1}）则 z12 翻面为聚合 —— 证明 ③-b 有分辨力（当前 ${px12.toFixed(4)}px）`,
  );
}

console.log(`\n结果：通过 ${pass} · 失败 ${fail}`);
if (fail) {
  console.error(
    "\n❌ 跨境地标聚合门禁不符 —— 每一条 ✗ 在页面上都表现为「点到的不是想点的那个」或「两个设施被画成一个」。",
  );
  process.exit(1);
}
