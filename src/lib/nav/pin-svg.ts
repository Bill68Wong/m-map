/**
 * 起终点钉 · 内联 SVG 单一真源（src/lib/nav/pin-svg.ts，v3.3.0 · ADR-102 / AC-92）
 *
 * ── 为什么内联（根因）────────────────────────────────────────────────────
 *   改前：`AMap.Marker({ content: '<div class="nav-map__destpin">' })` +
 *        CSS `background: url("/pin-destination.svg") center/contain no-repeat` + `drop-shadow filter`。
 *   ⇒ 三端依赖（**外链文件加载 / CSS background 合成 / filter**）叠加。用户 Android（Chrome + 微信）
 *     **双环境均不可见**、桌面正常 ⇒ 指向**渲染/合成兼容**（非 JS 逻辑）；v3.2.0 的「颜色字面量化」
 *     只解掉「`var()` 不穿透」一环，其余三段仍在。
 *   ⇒ 本方案把 SVG **直接内联进 marker content**，彻底摆脱外链 + CSS background + filter 依赖。
 *
 * ── 几何（沿用 `public/pin-*.svg`，勿擅改）────────────────────────────────
 *   `viewBox 0 0 32 42`；钉头圆心 (16,19) r9.5；钉尖 (16,40)；两切点 (7.53,23.3)/(24.47,23.3)。
 *   渲染尺寸裁到 **20×26**（= `--destpin-w/h`）⇒ marker `offset(-10,-26)` = (-w/2, -h)
 *   令**钉尖**精确锚定坐标点（**不变**）。
 *   自绘三层：① 白色外圈（把钉从底图里"拔"出来）② 钉身（字面量色，**不随主题**）③ 钉头白点。
 *
 * ⚠️ 渲染尺寸由 `width="20" height="26"` 决定（非 viewBox 比例）⇒ 与 `.nav-map__destpin/originpin`
 *   的 `width/height: var(--destpin-w/h)` 一致（20×26）。
 */

/** 钉身几何路径（`viewBox 0 0 32 42`；白外圈与钉身共用同一条） */
const PIN_BODY_PATH = "M7.53 23.3 L16 40 L24.47 23.3 A9.5 9.5 0 1 0 7.53 23.3 Z";

/** 组装一枚钉的内联 SVG（字面量色；无 `var()` —— 内联于 marker content，无需外部变量穿透） */
function pinSvg(color: string): string {
  return (
    `<svg viewBox="0 0 32 42" width="20" height="26" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path d="${PIN_BODY_PATH}" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"/>` +
    `<path d="${PIN_BODY_PATH}" fill="${color}"/>` +
    `<circle cx="16" cy="19" r="3.8" fill="#fff"/>` +
    `</svg>`
  );
}

/** 终点钉（澳门绿 `#0b6e4f` = logo 绿 / `--brand-pin` 亮色值；**固定色，不随主题**） */
export const PIN_SVG_DEST = pinSvg("#0b6e4f");

/**
 * 起点钉（砖红 `#B4342A` = 项目 `--danger` 亮色值；「红 = 起点」直觉）。
 * ★ 硬口径（v3.3.0）：**任何场景（含「起点 = 我的位置」）起点语义均以红钉承载**，不得用蓝点替代；
 *   蓝点仅表「我的实时位置」，两者可叠（红钉 z110 立于蓝点 z128 之下）。
 */
export const PIN_SVG_ORIGIN = pinSvg("#B4342A");
