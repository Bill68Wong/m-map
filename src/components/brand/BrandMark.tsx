/**
 * M Map 品牌标志 · 内联 SVG（src/components/brand/BrandMark.tsx，v2.15.0 定稿）
 *
 * ── 为什么内联，而不是 `<img src="/brand/mark.svg">` ──────────────────────
 *   `mark.svg` 的描边/填充走的是 `var(--brand-route)` / `var(--brand-pin)`，
 *   而 **CSS 自定义属性不会穿透外部 SVG 文档**：用 `<img>` 引入时，SVG 文档内
 *   解析不到页面 `:root` 的品牌 Token ⇒ 退化为文件内兜底值（恒为浅色青花蓝）。
 *   后果：深色主题下标志不换亮蓝/亮绿，与「一个文件管两套主题」的定稿诉求相悖。
 *   内联后本 SVG 属于当前文档，`tokens-brand.css`（见 globals.css 末尾）里随
 *   `prefers-color-scheme` 切换的 `--brand-route/--brand-pin` 正常级联 ⇒ 自动换色。
 *   色值一律取自 Token，组件内**不出现任何硬编码颜色**（仅镂空 mask 的 #fff/#000）。
 *
 * ── 取色为什么绑 CSS class，而不是 `stroke="var(--brand-route)"` 表现属性 ──
 *   已用 headless Chromium 实测（`.verify/_probe-var-presentation.cjs`）：Chromium
 *   能解析颜色类表现属性里的 `var()`；但 SVG **表现属性**里的 `var()` 各引擎支持
 *   不一致（w3c/svgwg#1031，2025-11：Chromium 对长度类表现属性不支持，颜色类亦无
 *   统一保证）⇒ 为跨 Firefox / WebKit / Chromium 稳，颜色统一由 `.brand-mark__*`
 *   的 CSS 声明绑定（CSS 中的 `var()` 全平台可用），见 globals.css 同名规则。
 *
 * ── 几何（与 public/brand/mark.svg 同源 · 第五轮定稿「短钉 · 两站 · 无缝」）──
 *   路线 `M12 48 L12 16 L30 34 L48 16`，描边 6.5 圆头圆角；左端两站环（起笔点 / 折点），
 *   右端路线直连澳门绿终点钉。站点环内 + 钉帽白点用 `<mask>` 真镂空（不依赖底色）。
 *
 * ⚠️ 纯展示（无事件）；mask 用 `useId()` 生成唯一 id，避免同页多次渲染 id 冲突。
 */
"use client";

import { useId } from "react";

export interface BrandMarkProps {
  /** 边长（px），默认 20（与 .nav-brand__mark 一致） */
  size?: number;
  /** 透传到 `<svg>` 的类名（尺寸可交由 CSS 控制） */
  className?: string;
}

export default function BrandMark({ size = 20, className }: BrandMarkProps) {
  const maskId = `mm-brand-hole-${useId().replace(/:/g, "")}`;

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="1.15 0.85 60 60"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect x="0" y="0" width="64" height="64" fill="#fff" />
          <circle cx="12" cy="48" r="3.9" fill="#000" />
          <circle cx="30" cy="34" r="3.9" fill="#000" />
          <circle cx="48" cy="16" r="2.7" fill="#000" />
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        <path
          className="brand-mark__route"
          d="M12 48 L12 16 L30 34 L48 16"
          fill="none"
          strokeWidth="6.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          className="brand-mark__pin"
          d="M40.29 18.13 L48 46 L55.71 18.13 A8 8 0 1 0 40.29 18.13 Z"
        />
      </g>
      <circle className="brand-mark__route" cx="12" cy="48" r="4.6" fill="none" strokeWidth="2.2" />
      <circle className="brand-mark__route" cx="30" cy="34" r="4.6" fill="none" strokeWidth="2.2" />
    </svg>
  );
}
