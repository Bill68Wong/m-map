# M Map · 品牌定稿落地清单（第五轮）

> **第六轮已置换线上图标（蓝底 → 白底）与中文名（→ 澳搭車）。**
> 落地 App 图标 / `icon.svg` / `lockup` 时请**以 §8 为准**；下方 §1 的 `app-icon/`（蓝底）与旧中文名清单
> **已降级为「蓝底存档 / 生成器说明」**，不要再照它上线上图标。`mark*.svg` / `tokens-brand.css` / `og.png` 仍以 §1 为准。

- 定稿组合：**短钉 · 两站 · 无缝**（= 第四轮 4-2）
- 资产目录：`docs/迭代-v215-20260925/02-logo/final/`
- 生成器：`node docs/迭代-v215-20260925/02-logo/final/tools/make-brand.mjs`（改色 / 换中文名后重跑即全量刷新）
- 像素自检：`node .verify/check-public-icons.mjs`（25 项，全绿才可落地）

---

## 1. 资产 → 目标路径（一条命令搞定）

```bash
# ① App 图标 / favicon（6 件套）
cp docs/迭代-v215-20260925/02-logo/final/app-icon/icon-16.png            public/icon-16.png
cp docs/迭代-v215-20260925/02-logo/final/app-icon/icon-32.png            public/icon-32.png
cp docs/迭代-v215-20260925/02-logo/final/app-icon/apple-touch-icon-180.png public/apple-touch-icon.png
cp docs/迭代-v215-20260925/02-logo/final/app-icon/icon-192.png           public/icon-192.png
cp docs/迭代-v215-20260925/02-logo/final/app-icon/icon-512.png           public/icon-512.png
cp docs/迭代-v215-20260925/02-logo/final/app-icon/maskable-512.png       public/icon-maskable-512.png
# ② 矢量 favicon（替换旧的站牌方块 icon.svg）
cp docs/迭代-v215-20260925/02-logo/final/app-icon/icon-192.svg           public/icon.svg
# ③ 品牌标志（App 内 / 分享卡 / 关于页 / 文档）
mkdir -p public/brand
cp docs/迭代-v215-20260925/02-logo/final/mark.svg          public/brand/mark.svg
cp docs/迭代-v215-20260925/02-logo/final/mark-dark.svg     public/brand/mark-dark.svg
cp docs/迭代-v215-20260925/02-logo/final/mark-mono.svg     public/brand/mark-mono.svg
cp docs/迭代-v215-20260925/02-logo/final/lockup.svg        public/brand/lockup.svg
cp docs/迭代-v215-20260925/02-logo/final/lockup-dark.svg   public/brand/lockup-dark.svg
# ④ 品牌 Token（只增不改，追加到 src/app/globals.css 末尾）
cat docs/迭代-v215-20260925/02-logo/final/tokens-brand.css >> src/app/globals.css
```

| 源文件 | 目标 | 用途 | 说明 |
|---|---|---|---|
| `app-icon/icon-16.png` / `icon-32.png` | `public/icon-16.png` / `icon-32.png` | 浏览器标签 favicon | **预圆角 20%**（浏览器不额外切形） |
| `app-icon/apple-touch-icon-180.png` | `public/apple-touch-icon.png` | iOS 主屏 / Safari 收藏 | **满幅方角**，由 iOS 自己切圆角 |
| `app-icon/icon-192.png` / `icon-512.png` | `public/icon-192.png` / `icon-512.png` | PWA any | 预圆角 20% |
| `app-icon/maskable-512.png` | `public/icon-maskable-512.png` | PWA maskable | 满幅方角 + 内容压在 **80% 安全圆**内（最大对角半径 181 / 可用 205） |
| `app-icon/icon-192.svg` | `public/icon.svg` | 矢量 favicon | 覆盖旧站牌方块图标 |
| `tokens-brand.css` | **追加**到 `src/app/globals.css` 末尾 | 品牌 Token 登记 | **只增不改**；不追加也能渲染（走 SVG 内兜底值），但会失去「标志随深浅主题自动换色」 |
| `mark*.svg` / `lockup*.svg` | `public/brand/*` | App 内品牌位 / 分享卡 / 关于页 / 文档 | 见 §4 |
| `app-icon/icon-square-512.png` | （可选）`public/og-icon-512.png` | 需要自带形状的位（OG、分享卡） | 满幅方角 |

> ### 为什么标志不用 `var(--accent)`
> 本轮内联实测踩到的坑：`mark-dark.svg` 若写 `var(--accent, #a8c7fa)`，放进**浅色主题**页面时 `--accent` 会解析成 `#1b4d8f` ⇒ **深底版被染成浅色，整份资产失效**。故拆成两组语义明确的品牌 Token：
> - `--brand-route / --brand-pin / --brand-fg / --brand-muted` —— **随主题**（`tokens-brand.css` 里跟 `prefers-color-scheme` 切；未登记时兜底＝浅色值）
> - `--brand-route-on-dark / --brand-pin-on-dark / --brand-fg-on-dark / --brand-muted-on-dark` —— **固定深底**，永远亮色，不受主题影响
>
> 效果：`mark.svg` 内联进深色主题页面**自动变亮蓝/亮绿**（同一个文件，不用换图）；`mark-dark.svg` 放在任何主题里都保持亮色（用在固定深色底上）。见 `preview.html` §A-1 第二格实测。

> 底座色一律为 **② 青花蓝 `--accent #1b4d8f`**（推荐，理由见 02-logo/preview.html §B）。
> 若用户最终改选其它底色：改 `make-brand.mjs` 里 `buildSet(PALETTES.xxx, ICON_DIR)` 一处 → 重跑 → 重跑上表命令。
>
> **alpha 处理**（细节但会踩）：`apple-touch-icon` / `maskable` / `square-512` 三件是**满幅不透明底**，导出时已 `flatten + removeAlpha`（3 通道，无 alpha）—— 部分 PWA 校验器会对「图标含透明」报警。`icon-16/32/192/512`（预圆角）**保留 alpha**（圆角外必须透明）。

---

## 2. `src/app/layout.tsx` — 引用点

**现状（L10）**：`icons: { icon: "/icon.svg" }`

**改为**：

```ts
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
```

> `viewport.themeColor`（L31-34）**不用改**：已与 manifest 的 `background_color` 同源（浅 `#F2F4F0` / 深 `#111318`）。

---

## 3. `public/manifest.webmanifest` — 完整替换

```json
{
  "name": "M Map",
  "short_name": "M Map",
  "description": "澳门巴士 / 轻轨全澳导航：全屏地图、路线收藏与实时报站",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#F2F4F0",
  "theme_color": "#F2F4F0",
  "lang": "zh-CN",
  "icons": [
    { "src": "/icon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" },
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

> 关键点：**`maskable` 必须与 `any` 分开声明**。同一个 512 当 maskable 用会被安卓切掉四个角（内容占比 64% > 安全区），这也是本次单独出 `maskable-512` 的原因。

---

## 4. App 内品牌位（可选增强）

现状 `src/components/nav/NavBrandBar.tsx:90` 的品牌位是一块**纯文字**站牌（`.nav-brand`：白底 + 青花蓝框 + 文字 `M Map`）。
定稿后建议升级为「**标志 + 字标**」站牌，与 App 图标同源：

> **实际落地（2026-09-25）**：走的**内联**路线 —— 新增 `src/components/brand/BrandMark.tsx`（几何与本目录 `mark.svg` 同源，
> 颜色绑 CSS class、mask id 用 `useId()`），`NavBrandBar` 品牌位＝「标志 20px + gap 6px + 字标 M Map」。
> 下文 `<img>` 写法**保留为备选**（仅当需要纯静态、不参与主题换色时使用）；理由见 §4 末「深浅主题」与 §7.2。

```tsx
<Link href="/help" className="nav-brand" aria-label="M Map · 帮助与合规说明">
  {/* 标志用 <img> 引静态资产即可，尺寸受 .nav-brand__mark 控制 */}
  <img className="nav-brand__mark" src="/brand/mark.svg" alt="" width={20} height={20} aria-hidden="true" />
  M Map
</Link>
```

配套 CSS（追加，勿改既有 `.nav-brand` 规则）：

```css
.nav-brand { gap: 6px; }               /* 图标与字标间距 */
.nav-brand__mark { display: block; width: 20px; height: 20px; flex: none; }
```

- **深浅主题**：按 §1 追加了 `tokens-brand.css` 后 ——
  - **内联**（推荐，见上）：`mark.svg` 的 `var(--brand-route/--brand-pin)` 会**跟着主题自动换色**（深色下变亮蓝 `#a8c7fa` / 亮绿 `#6dd58c`），一个文件管两套主题，零额外请求、零换图。
  - 用 `<img>` 引外部 SVG：CSS 变量**不会穿透**（外部文档隔离），此时改用两条：
    ```css
    .nav-brand__mark { content: url("/brand/mark.svg"); }
    @media (prefers-color-scheme: dark) { .nav-brand__mark { content: url("/brand/mark-dark.svg"); } }
    ```
  - 固定深色底（页脚、启动页、分享卡）：直接用 `lockup-dark.svg` / `mark-dark.svg`，其 `--brand-*-on-dark` 永远亮色，**不**随主题漂移。
- 分享卡 / 关于页 / 帮助页页眉建议直接用 `lockup.svg`（含中文名那行）。

---

## 5. 落地自检（前端做完请跑一遍）

| # | 检查 | 期望 |
|---|---|---|
| 1 | `node .verify/check-public-icons.mjs` | `通过 25 / 失败 0` |
| 2 | 浏览器标签图标 | 显示蓝色圆角方块内的 M + 钉（**空标签页首帧不能闪旧图标** → 清 CDN 缓存 / 换文件名最稳） |
| 3 | `chrome://settings/apps` 或 DevTools → Application → Manifest | 4 条 icons 全部 `Loaded`，无 `maskable` 警告 |
| 4 | 添加到主屏（iOS 模拟 / 安卓） | 图标不被切角、M 与钉完整 |
| 5 | 深色模式切换 | 品牌位标志换亮蓝/亮绿（内联 `mark.svg` + 追加了 `tokens-brand.css` 时自动生效） |
| 6 | 16px 观感 | 站点环在 16px 下**会自然退场**（环外径仅 2.5px，糊成描边的一部分），只留下 M 骨架 + 钉 —— 这是预期行为，与第四轮「两站比三站稳、16px 最稳」的选择一致。若仍嫌糊：把 `make-brand.mjs` 里 `icon-16` 的 `ratio` 由 `0.68` 调到 `0.72` 重跑（已验证不会碰到 20% 圆角） |
| 7 | `npx tsc --noEmit` | 通过 |

> 注意（已踩过的坑）：`apple-touch-icon` **不要预圆角**（iOS 会二次切角，边缘出现白圈）；`maskable` **不要预圆角**（安卓遮罩会露出圆角外的透明底）。

---

## 6. 资产清单（final/）

```
final/
├─ mark.svg                标志 · 透明底 · 浅色（--accent / --brand-green）
├─ mark-dark.svg           标志 · 透明底 · 深色（#a8c7fa / #6dd58c）
├─ mark-mono.svg           标志 · 单色 currentColor（印章 / 烫印 / 印刷）
├─ lockup.svg              横排 · 浅色（标志 + M Map + 中文名「澳搭車」）
├─ lockup-dark.svg         横排 · 深色
├─ tokens-brand.css        品牌专用 Token（只增不改，追加到 globals.css 末尾）
├─ preview.html            定稿总览页（A 资产 + B 图标四底色 + C 中文名）
├─ INTEGRATE.md            本文件（落地清单）
├─ app-icon/
│  ├─ icon-16.{svg,png}            16   favicon（预圆角）
│  ├─ icon-32.{svg,png}            32   favicon 2×
│  ├─ apple-touch-icon-180.{svg,png} 180 apple-touch（满幅方角）
│  ├─ icon-192.{svg,png}           192  PWA any
│  ├─ icon-512.{svg,png}           512  PWA any
│  ├─ maskable-512.{svg,png}       512  PWA maskable（80% 安全区）
│  ├─ icon-square-512.{svg,png}    512  满幅方角（OG / 分享卡，可选）
│  └─ color-candidates/            B · 四底色 × 六档（white / blue / green / dark）
└─ tools/
   ├─ make-brand.mjs         ▲ 资产生成器（改一处色板即可全量重出）
   ├─ make-preview.mjs       ▲ 总览页生成器
   └─ contrast-report.txt    对比度核算输出
```

### 关键几何（任何人复核时可直接对上第四轮）

| 项 | 值 |
|---|---|
| 路线 | `M12 48 L12 16 L30 34 L48 16`，描边 6.5，圆头圆角连接 |
| 站点环 | `(12,48)` 起笔点 · `(30,34)` 中折点，r 4.6 / 描边 2.2 |
| 终点钉 | 钉尖 `(48,46)`（短钉），钉帽圆 `(48,16) r 8` |
| 接口 | 路线右端**直连钉帽**（无缝） |
| viewBox | `1.15 0.85 60 60`（内容居中，左右余量 5.15 / 上下 7.15，完全对称） |
| 镂空 | 站点环内 + 钉帽白点用 SVG `<mask>` 真镂空（不依赖底色） |

---

## 7. 跨端与运维须知（v2.15 前端落地后回执 · 设计师记录 2026-09-25）

> 本节是**落地回执**：前端按 §1→§4 执行完毕，并把两条会影响「以后」的坑回传；此处固化，避免下一轮重踩。

### 7.1 落地确认（独立复核过）

| 项 | 结论 | 复核方式 |
|---|---|---|
| 12 件资产与 `final/` 源一致 | 通过 · 逐个 md5 相同 | 设计师独立复跑 md5sum（非听信回执） |
| §1 追加 Token / §2 layout / §3 manifest | 通过 · 已落地 | `src/app/globals.css` 末尾、`layout.tsx`、`manifest.webmanifest` |
| 像素自检 | 通过 · **25 / 失败 0** | `node .verify/check-public-icons.mjs`（设计师独立复跑） |
| App 内品牌位实现方式 | 内联组件 `src/components/brand/BrandMark.tsx`（**不是** `<img>`） | 见 §4 注 + 下方 7.2 |

### 7.2 【坑一】`var()` 写在 SVG **表现属性**里，跨引擎不统一

- **现状**：`public/brand/*.svg`（mark / mark-dark / mark-mono / lockup / lockup-dark）的颜色写成
  `stroke="var(--brand-route, #1b4d8f)"` / `fill="var(--brand-pin-on-dark, #6dd58c)"` —— 即**表现属性**形式。
- **实测**（`.verify/_probe-var-presentation.cjs`，headless Chromium）：Chromium **能**解析**颜色类**表现属性里的 `var()`；
  但 [w3c/svgwg#1031](https://github.com/w3c/svgwg/issues/1031)（2025-11）确认表现属性里的 `var()` **各引擎行为不统一**
  （长度类 Chromium 明确不支持；颜色类亦无统一保证，Firefox / WebKit 支持）。
- **何时会出问题**：把 **文件级 SVG 内联**进页面（想吃到主题 Token）时，某些引擎可能**不换色**。
- **何时没问题**（= 当前用法）：
  - 作为 `<img>` / `content:url()` 引入 → 外部文档隔离，本就取文件内**兜底值**（浅底场景正确）；深底请改用 `-dark` 版。
  - App 内品牌位走 `BrandMark.tsx` 内联 → 已改用 **CSS class**绑定颜色（`.brand-mark__route / .brand-mark__pin`，见 `globals.css`），**全平台可用**，不受本坑影响。
- **结论（本轮不改文件）**：文件 SVG 的两种真实用法（`<img>` / `-dark` 版）都正确，且「内联」场景已由 `BrandMark.tsx` 接管；
  改动会牵动已 md5 验证的 12 件资产 + 25 项自检，收益为 0。**故保持现状，仅标记。**
- **未来若真要「把文件 SVG 内联进页面」**：把颜色从表现属性搬到文件内 `<style>` 的 CSS 声明（名字要带命名空间防全局污染），例：
  ```svg
  <style>
    .mm-route { stroke: var(--brand-route, #1b4d8f); }
    .mm-pin   { fill:   var(--brand-pin,   #0b6e4f); }
  </style>
  <path class="mm-route" d="M12 48 L12 16 L30 34 L48 16" fill="none" stroke-width="6.5"/>
  ```
  （改 `tools/make-brand.mjs` 的 `writeMark()` / `lockup()` 一处 → 重跑 → 重跑 §1 的 `cp` → 重跑 §5 自检。）
  【注意】 **勿改 app-icon**：`iconSvg()` 用的是字面色值（`p.route`/`p.pin`），要交给 sharp 栅格化，**不能**改成 `var()`。

### 7.3 【坑二】fail-closed 中间件会拦 `public/` 根级静态资源

- `src/middleware.ts` 是**默认拒绝**：仅白名单路径公开，其余在**配了 `ACCESS_PASSWORD` 的生产环境**被 307 到 `/login`；
  **本地开发放行 ⇒ 完全看不见**（本轮真机才暴露：图标全裂、PWA 装不上）。
- 规则：
  - `public/brand/**` → 走 `PUBLIC_PREFIXES` 的 `/brand` 前缀，**免登记**（以后往 `/brand/` 加分享卡 / 关于页资产不用改 middleware）。
  - **`public/` 根目录新增任何文件** → 必须同步加入 `PUBLIC_FILES`（精确路径），**否则线上 307 坏图**。
- 本轮已补：6 件套图标 + `/pin-destination.svg` + `/pin-destination-mono.svg` → `PUBLIC_FILES`；`/brand` → `PUBLIC_PREFIXES`。
  （顺带修掉一处**既有**漏登：`/pin-destination.svg` 自 v2.15「终点钉 SVQ 化」起在生产就是坏图。）
- 回归脚本：`.verify/_check-middleware-public.ts`（真调用 `middleware()`）→ 通过 20 / 失败 0。
- **设计师自用清单**：以后出「放到 `public/` 根」的资产（如 OG 图、分享卡 PNG），交付时必须写明**目标路径 + 是否根级**，
  根级的一律提醒前端加白名单；能放 `/brand/` 就放 `/brand/`。

---

## 8. 第六轮 · 白底置换 + 中文名定稿 + 多场景清单（设计师 · 2026-09-25）

### 8.0 本轮改了三件事

| # | 变更 | 交付物 |
|---|---|---|
| ① | 线上 6 件套 **蓝底 → 白底「站牌」** | `app-icon-white/{icon-16,icon-32,apple-touch-icon-180,icon-192,icon-512,maskable-512}.{png,svg}` |
| ② | 横排中文名 **MUST登校 → 澳搭車**（英文名仍 `M Map`） | `lockup.svg` / `lockup-dark.svg`（同路径覆盖） |
| ③ | 「变体 → 目标路径 → 用途 → 是否根级」清单 | 本节 §8.4 |

**未动**（已 md5 复核一字未变）：`app-icon/`（蓝底第五轮存档，14 件）、`mark.svg` / `mark-dark.svg` / `mark-mono.svg`、`tokens-brand.css`、`og/`。
`mark*.svg` **不含中文名**，故中文名只落在 `lockup*.svg` 一处，与前端预判一致。

### 8.1 白底色板（口径）

| 元素 | 值 | 说明 |
|---|---|---|
| 牌面（底） | `#FFFFFF` | 白底「站牌」牌面 |
| 牌框（描边） | `#1B4D8F` | **白底系列新增的「站牌框」**——见 §8.2 为什么必须有 |
| 路线 + 站点环 | `#1B4D8F` | 青花蓝 |
| 终点钉 | `#0B6E4F` | 澳门绿 |
| 站点内部 / 钉帽白点 | `#FFFFFF` | SVG `<mask>` **真镂空**，露出牌面（非画上去的白） |

对比度自检（WCAG 图形类门槛 ≥3:1）：**路线/白底 8.38:1、钉/白底 6.25:1**（蓝底对应 8.38 / 4.61）——
白底反而把「澳门绿钉」的对比度从 4.61 抬到 6.25，**这一轮没有引入可访问性回退**。

> 牌框为何是「必须有」而不是装饰：白牌面在浅色桌面/白色标签栏上与背景**同色**，没有描边时整个图标会读成「空白/缺图」。
> 青花蓝牌框给白牌面一条明确边界，也是站内 `.nav-brand`（白底 + 青花蓝框）的同一套语言。

### 8.2 两处「按平台差异」的牌框处理（本轮关键，请勿改回贴边）

1. **`maskable-512`：牌框内缩**（名义边长 56% 画布；**含描边外沿实测 59.4%** = 304/512，左右各留 104px 白圈）
   - 原因：安卓自适应图标遮罩会裁掉画布外缘。**贴边牌框实测会碎成 4 段**（用圆形遮罩模拟复现，
     证据脚本 `.verify/_cmp-maskable.mjs` 的 V3 输出）。
   - 内缩后「牌框描边最外对角半径」= **179.8px（断言口径）／179.9px（探针口径）** —— 差异源于**非白阈值**
     （断言 `>236` / 探针 `>245`），**均 ≤ 可用 204.8px**（余量 25px，与第五轮蓝底 maskable 的
     「181 / 205」同口径），标志同步收到 `ratio 0.46` 以在牌框内留 16.7px 呼吸。
     （复测脚本：`.verify/_probe-maskable-frame.mjs`（阈值 `>245` ⇒ maxR=179.9）；断言口径 `>236` ⇒ 179.8
     见 `check-public-icons.mjs` / `check-brand-r6.mjs`；源与线上 md5 一致。）
   - 代价：**maskable 的牌框占 59.4% 画布（名义 56%）**（其余 5 件是满幅）——这是遮罩安全的必然结果，不是疏忽。
     几何上「白底 + 牌框满幅」无解：牌框角点半径≈362 > 安全圆 204.8，必被遮罩切段；想满幅只能换**纯色底**（见备选 B）。
   - 若 team-lead 要求「6 件完全同规格」，两个一行开关（`tools/make-brand.mjs` → 重跑 → 重跑 §1 的 `cp`）：
     - 备选 A：maskable **去掉牌框**（白底 + 标志 0.52，= 第五轮蓝底 maskable 的几何仅换底色）；
     - 备选 B：maskable **保持第五轮蓝底**（安卓端最醒目、青花蓝本就是品牌主色）。

2. **`apple-touch-icon-180`：牌框圆角对齐 iOS 22.37%**
   - 原因：iOS 会给主屏图标切 22.37% 圆角。牌框若是方角，四角会被 iOS 裁掉（出现「缺角的框」）。
   - 处理：牌框圆角取 **24% 牌框宽**（≈ iOS 半径按描边内缩后的值），与 iOS 遮罩同心、不打架。

### 8.3 白底像素采样期望值（直接用于改 `.verify/check-public-icons.mjs`）

**icon-192.png** —— 坐标换算式 `M(x,y)=[round(18.984+x*2.47243), round(19.725+y*2.47243)]`
（**与第五轮完全同式，坐标不用改**，只换期望色）：

| 采样点 | 期望 | 说明 |
|---|---|---|
| `M(12,32)` | `#1B4D8F` | 路线左竖中段 |
| `M(12,48)` | `#FFFFFF` | 站点①内部（镂空生效） |
| `M(12,43.4)` | `#1B4D8F` | 站点①环（上半圈） |
| `M(48,16)` | `#FFFFFF` | 钉帽白点（镂空生效） |
| `M(48,30)` | `#0B6E4F` | 钉身 |
| `(96,4)` | `#1B4D8F` | **牌框（顶边内）**——蓝底该格也是 `#1B4D8F`（那是底蓝），白底是「牌框蓝」，同值不同因 |
| `(96,8)` | `#FFFFFF` | 牌面（牌框内侧） |
| `(2,2)` | `#000000`，且 `a≈0` | 预圆角外 = 透明 |
| `(150,150)` | `#FFFFFF` | 右下空白 = 白底 |

**maskable-512.png**：

| 采样点 | 期望 | 说明 |
|---|---|---|
| `(6,6)` / `(505,505)` | `#FFFFFF` | 四角 = 纯白（牌框未顶边） |
| `(256,20)` | `#FFFFFF` | 顶中 20px = 白（牌框已内缩） |
| `(256,104)` | `#1B4D8F` | 牌框（内缩后） |
| 全图断言 | 非纯白像素到中心距离 **≤ 204.8** | 实测 maxR = **179.8**（断言口径 `>236`）／**179.9**（探针口径 `>245`）|

**apple-touch-icon-180.png**：

| 采样点 | 期望 | 说明 |
|---|---|---|
| `(1,1)` | `#FFFFFF`，`a=255` | 满幅不透明白角（未预圆角） |
| `(90,3)` | `#1B4D8F` | 牌框顶中 |

**通道口径**（防 PWA 校验器报「图标含透明」）：

| 文件 | 通道 | 四角 |
|---|---|---|
| `icon-16/32/192/512` | **4ch（含 alpha）** | 预圆角外透明 |
| `apple-touch-icon-180` / `maskable-512` | **3ch（无 alpha）** | 满幅不透明 |

### 8.4 多场景资产清单（变体 → 目标路径 → 用途 → 是否根级）

| 变体（源） | 目标路径 | 用途 | 是否根级 |
|---|---|---|---|
| `app-icon-white/icon-16.png` | `public/icon-16.png` | 浏览器标签 favicon | **是**（已在 `PUBLIC_FILES`） |
| `app-icon-white/icon-32.png` | `public/icon-32.png` | favicon 2× | **是**（已登记） |
| `app-icon-white/icon-192.svg` | `public/icon.svg` | 矢量 favicon（覆盖旧站牌方块） | **是**（已登记） |
| `app-icon-white/apple-touch-icon-180.png` | `public/apple-touch-icon.png` | iOS 主屏 / Safari 收藏 | **是**（已登记） |
| `app-icon-white/icon-192.png` | `public/icon-192.png` | PWA `any` | **是**（已登记） |
| `app-icon-white/icon-512.png` | `public/icon-512.png` | PWA `any` | **是**（已登记） |
| `app-icon-white/maskable-512.png` | `public/icon-maskable-512.png` | PWA `maskable` | **是**（已登记） |
| `lockup.svg` / `lockup-dark.svg` | `public/brand/lockup.svg` · `lockup-dark.svg` | App 内品牌位 / 关于页 / 分享卡 | 否（`/brand` 免登记） |
| `og/og.png`（**本轮未动**） | `public/brand/og.png` | OG 分享卡 1200×630 | 否（`/brand` 免登记） |

**浅底 / 方形变体：本轮不需要上线**，理由逐条：

| 需求 | 结论 | 理由 |
|---|---|---|
| OG 分享卡浅底版 | **不出** | 分享卡平台无主题，单版深底（`og.png`）够用；见 `OG-CARD.md §6 O3` |
| 方形社交卡 / OG 方形变体 | **不出** | 目前没有方形分享位的需求；若将来要，出 `app-icon-white/icon-square-512.png`（满幅方角）→ 落 **`/brand/icon-square-512.png`**（非根级、免登记，别放 `public/` 根） |
| PWA 方形 | **不需要** | `maskable-512` 已覆盖安卓自适应；`icon-512`（预圆角）覆盖 `any` |

> 一句话给前端的规矩：**能落 `/brand/` 就落 `/brand/`**；凡是要落 `public/` 根的新文件，必须先加 `PUBLIC_FILES`。

### 8.5 本轮自检（设计师独立跑）

```bash
node docs/迭代-v215-20260925/02-logo/final/tools/make-brand.mjs   # 重出全量（改色/改名后重跑）
node .verify/check-brand-r6.mjs                                  # 期望：通过 31 / 失败 0
```

`check-brand-r6.mjs` 覆盖：白底六件套逐点取样、镂空、预圆角/满幅与通道、maskable 安全圆（逐像素求 maxR）、
16px 生存性、lockup 中文名断言（含「澳搭車」且无「MUST登校」）、白底对比度。

> **计数口径沿革（防「17」与现役打架）**：像素自检脚本在第五轮校验的是**源目录 `final/app-icon/`**（**17 项**）；
> 第六轮改为校验**已上线 `public/`**（多拦「拷错 / 漏拷 / 拷了旧版本」一类事故）并更名 `check-public-icons.mjs`，项数扩为 **25 项**。
> 故本套文档凡「像素自检」计数一律写 **25**（源目录级深检 `check-brand-r6.mjs` 另计 31 项）；文中出现「17」处，仅指第五轮历史值。

### 8.6 本轮资产 md5（供落地后核对）

```
b6d3900126a4b4fdf8c4e767b2c65362  app-icon-white/apple-touch-icon-180.png
f859a7d27da593b24e1e7fd8362b7667  app-icon-white/icon-16.png
6c2a47525f9e2415d5c5860e2fe35085  app-icon-white/icon-192.png
8e5efff3e65d69bff5eb132148a83690  app-icon-white/icon-32.png
d94e54352fe0f1714722388d1dcae0a1  app-icon-white/icon-512.png
3b52350f38f55f03740b0261b2eb6568  app-icon-white/maskable-512.png
262025cfa883deb0f0939a6ab582a162  lockup.svg
2ac51285f66e669d6e9c57200ca796d5  lockup-dark.svg
```

### 8.7 开放项裁决：maskable 牌框「内缩 vs 满幅」**不统一**（设计师 · 2026-09-25 第七轮）

前端转来开放项「maskable 内缩 56% vs 其余 5 件满幅，是否统一规格」（该 **56% 为名义边长**；**含描边外沿为 59.4%**，口径见 §8.2），裁决如下（已报 team-lead）：

**结论：维持现状，不统一。** 6 个文件不是「同一张图的 6 个尺寸」，而是两种角色：
- `icon-16/32/192/512` + `apple-touch` —— **原样展示**（浏览器 / iOS 直接渲染图上形状）⇒ 牌框**必须满幅**。
- `maskable` —— **交给安卓遮罩切形的底图** ⇒ 牌框**必须内缩**；满幅会被圆形遮罩切成 4 段（`.verify/_cmp-maskable.mjs` V3 复现）。

**否决的备选**（`tools/make-brand.mjs` 一行开关可出，本轮不出）：
- 备选 A（去牌框·白底）：白底无框 ⇒ 浅色壁纸上形状消失，成为全套唯一「无边界」图标。**否决。**
- 备选 B（maskable 保留第五轮蓝底满幅）：安卓端最醒目，但把蓝底混回白底体系。**仅当「安卓识别度 > 跨端色彩一致」被明确优先时才用。**

**几何证明（白底品牌下内缩是唯一解，非折衷）**：牌框外沿若贴画布边，角点半径≈362 > 安全圆 204.8，必被遮罩切段；想满幅只能改用**纯色底**。故「白底 + 牌框」的组合里，内缩是唯一可行解。

**复测产物**（随 `check-public-icons` / `check-brand-r6` 一起跑）：`.verify/_probe-maskable-frame.mjs`（源/线上 md5 一致、牌框外沿 59.4%、maxR 179.9（探针口径 `>245`；断言口径 `>236` 得 179.8）、白圈 104px）、`.verify/_probe-channels.mjs`（3ch/4ch 通道口径逐条达标）。
