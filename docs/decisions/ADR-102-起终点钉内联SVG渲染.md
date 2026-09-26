# ADR-102：起终点钉改用内联 SVG（marker content）渲染

## Status

Accepted（2026-09-26 深夜 · 内联 SVG 兜底方案采纳；根因以 `?diag=pin` 真机取证回填）

## Context

- 现象：起点红钉 / 终点绿钉在用户 Android（**Chrome 与微信均**）**完全不可见**；桌面正常。
- 已核实：v3.2.0 已把两 SVG 颜色改为字面量（`public/pin-destination.svg` `fill="#0b6e4f"`、`pin-origin.svg` `fill="#B4342A"`）、marker 创建代码在（`NavMap.tsx` L581/L624）、CSS 在（`globals.css` L2115/L4096）。**修复已生效但移动端仍不可见**。
- 现渲染链：`AMap.Marker({content:'<div class="nav-map__destpin">'})` → CSS `background: url("/pin-destination.svg") center/contain no-repeat` + `filter: drop-shadow(var(--destpin-shadow))`。
- 关键事实：颜色修复只解掉「`var()` 不穿透」一环；**外链文件 + CSS `background` + `drop-shadow filter` 三段仍在**，而「桌面过、移动双环境不过」指向**渲染/合成兼容**（而非 JS 逻辑）。

## Decision

钉的 marker `content` **直接内联 SVG 字符串**，不再经「外部文件 + CSS background + drop-shadow filter」。

- 两钉 SVG 字符串定义于 **`src/lib/nav/pin-svg.ts`（纯字符串模块，单一真源）**；几何沿用现有文件（`viewBox 0 0 32 42`，钉头圆心 (16,19) r9.5，钉尖 (16,40)）。
- 接入形态**保留类名**（QA 选择器不失效）：`content = '<div class="nav-map__destpin" aria-hidden="true">' + INLINE_SVG_DEST + '</div>'`。
- CSS：`.nav-map__destpin/.nav-map__originpin` **去掉 `background: url(...)`**；保留 `width/height: var(--destpin-w/h)`；`filter: drop-shadow` 降为**可选增强**（不得成为可见性的必要条件——SVG 自带白色描边外圈）。
- 裁到 `width=20 height=26`（= `--destpin-w/h`）⇒ **offset 维持 `new AMap.Pixel(-10, -26)`**；zIndex 不变（起点 110 / 终点 120）。
- 配套：新增 `?diag=pin` 实机诊断浮层（`PinDiag.tsx`，生产默认不渲染）用于取证与复验（见 `02-技术-调研与方案.md` §1.4）。

## Considered Options

1. **只删 `filter`（保留外链 SVG）**：最小改动，但若根因是外链 `background` 加载/合成，仍会失败。
2. **改 `AMap.Icon`（image 形式）**：仍需外部图片资源，未摆脱网络/兼容面。
3. **内联 SVG（采纳）**：彻底摆脱外部文件 + CSS background + filter 三段，兼容面最小、确定性最高；代价 = 少量字符串常量 + 去一段 CSS。

## Consequences

- 正面：可见性不再依赖外部资源加载与 CSS 合成细节；移动端兼容确定性大幅提升；类名/钩子/offset 不变 ⇒ 回归面小。
- 负面：SVG 字符串进 TS（需保持与设计几何同步）；`public/pin-*.svg` 降为参考（或留作他用）。
- 验证：移动视口 Playwright + Android 真机（Chrome/微信）双钉可见；`?diag=pin` 计数=1 且元素内含 `<svg>`。
- 未决：仍建议以 `?diag=pin` 真机取证**确认**根因（H1 外链/合成 或 H2 filter 或 H3 未创建），以便回写根因结论。

## Related ADRs

- ADR-101（轻轨模式判定，无关但同批编号体系）· 相关文档 `docs/迭代-v330-20260926/00-需求台账.md` §四.1 与 `02-技术-调研与方案.md` §1。
