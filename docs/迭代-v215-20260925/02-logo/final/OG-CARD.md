# M Map · OG 分享卡（1200×630）· 规格与落地清单

> 作者：颜好看（UI/UX）｜日期：2026-09-25｜迭代：v2.15（品牌定稿收尾）
> 上游：`INTEGRATE.md`（品牌定稿第 5 轮）· `04-design-tokens.md`（Token 权威）
> 产出：`final/og/og.html`（版式源）· `final/og/og.png`（源图）· **`public/brand/og.png`（上线资产）**
> 生成器：`final/tools/make-og.mjs`　自检：`.verify/check-og.mjs`（16 项，全绿才可交付）

---

## 0. 两条拍板（回前端的技术选择题）

| # | 问题 | 拍板 | 理由 |
|---|---|---|---|
| **1** | 出图方式 **a 静态 PNG** vs **b `opengraph-image.tsx` 动图** | **选 a** | ① 品牌已冻结（v2.15 定稿 + 17 项像素自检），**没有**「随页面内容漂移」的需求；② ImageResponse **无 CSS var**、且默认字体**无 CJK** ⇒ 要自己喂字体二进制，复杂度高、易掉字形；③ 静态图零 edge 运行时开销。**"不会漂移"由生成器保证**：改 `og.html` 一处 → 重跑 → 图更新（与 `make-brand.mjs` 同一套模式）。 |
| **2** | 路径 **`/brand/`** vs **根级** | **`/brand/og.png`**（**非根级**） | `/brand` **已是** `PUBLIC_PREFIXES` 公开前缀 ⇒ **middleware 零改动**。符合 `INTEGRATE.md §7.3` 自定规矩「能放 `/brand/` 就放 `/brand/`」。 |

> 前端落地只需两件事：① 把本目录已生成好的 `public/brand/og.png` 纳入提交；② `layout.tsx` 补 `metadataBase` + `openGraph` + `twitter`（§5）。**不用改 middleware。**

---

## 1. 为什么用「真浏览器截图」而不是 sharp 栅格化

本卡含**中文（Noto Sans SC）**与 Barlow。sharp 底层 librsvg 取的是**系统已装字体** —— CI / 换一台机器就会掉字形（豆腐块）。用 headless Chromium + Google Fonts 才能保证**与线上页面同字形、同字距**（与仓内既有 `.verify/_probe-brandmark.cjs` 同款做法）。生成器里已加 `document.fonts.ready` + `document.fonts.check()` 三重字体就绪校验。

---

## 2. 版式规格（像素级）

```
画布 1200 × 630  ·  固定深底（分享卡永远深底，不随站点主题漂移）

┌─ 板底 --bg #111318 ────────────────────────────────────────────────┐
│   ← 64 →                                                      ← 64 →
│   ┌─ 站牌卡 --surface #1c1e24 · 1px --border 环 · r14 · 无投影 ──┐   ↑
│   │  pad 56                                                  │   │ 64
│   │  [标44] M Map                          ┌───────────────┐ │   │
│   │          澳门公交 · 实时导航             │               │ │   │
│   │                                        │   大标志       │ │   │
│   │  全澳巴士 · 轻轨                         │   232 × 232    │ │   │
│   │  这一程怎么走最快                        │   route 亮蓝   │ │   │
│   │                                        │   pin   亮绿   │ │   │
│   │  输入起点与终点，给出…（2 行）           │               │ │   │
│   │                                        └───────────────┘ │   │
│   │  musttoukou.vercel.app ● 数据来源：DSAT                   │   │
│   └──────────────────────────────────────────────────────────┘   ↓
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 取值表（全部引 Token，无裸 hex）

| 元素 | Token / 值 | 说明 |
|---|---|---|
| 板底 | `--bg` `#111318` | 深底**非纯黑**（globals 深色块） |
| 卡面 | `--surface` `#1c1e24` | 站牌卡面 |
| 卡环 | `1px --border` `rgba(226,226,233,.12)` | **仅 1px 环，无投影**（禁幽灵卡片） |
| 卡圆角 | `--radius-sheet` `14px` | Token 上限（>24px 属过度圆滑） |
| 板→卡留白 | `64px` | = `--space-10`；满足「标记四周 ≥64px」 |
| 卡内距 | `56px` | 上下左右等距 |
| 列间距 | `48px` | 文字列 ↔ 标志列 |
| 路线色（大标志 + 锁头） | `--brand-route-on-dark` `#a8c7fa` | **固定深底组**，永远亮色 |
| 钉色（大标志 + 锁头） | `--brand-pin-on-dark` `#6dd58c` | 同一组 |
| 主文本 | `--fg` `#e2e2e9` | 字标 / 主标题 |
| 次文本 | `--fg-2` `#c4c6d0` | 中文副行 / 副题 |
| 元文本 | `--meta` `#a9adb8` | 页脚 |

### 2.2 字体 / 字号 / 行高 / 字距（8 级阶跃内）

| 元素 | 字体 | 字号 | 行高 | 字距 | 字重 |
|---|---|---|---|---|---|
| 字标 `M Map` | `--font-display`（Barlow） | 32px | 32px | `-0.015em` | 700 |
| 中文副行 `澳门公交 · 实时导航` | `--font-body`（Noto Sans SC） | 15px | 21px | `+0.02em` | 500 |
| 主标题（2 行） | `--font-display` | 48px | 55px | `-0.02em` | 700 |
| 副题（2 行） | `--font-body` | 20px | 32px | `0` | 400 |
| 页脚（域名 / 来源） | `--font-mono`（JetBrains Mono） | 14px | 20px | `+0.01em` | 500 |

> 行高**一律取整数 px**（非 `1.14` 之类的倍数）——消子像素取整，保证卡面**像素级可复现**，也让自检能断言「主标题正好 2 行」。

### 2.3 白间节奏（上传实测盒模型，供还原校对）

| 元素 | 实测 (x, y, w, h) |
|---|---|
| 卡 | `64, 64, 1072, 502` |
| 文字列 | `121, 121, 678, 388` |
| 锁头块 | `121, 121, … , 59` |
| 主标题 | `121, 224, 678, 110`（2 行 × 55） |
| 副题 | `121, 351, 620, 64`（2 行 × 32） |
| 页脚 | `121, 489, 678, 20`（贴卡底 56 内距） |
| 大标志 | `847, 199, 232, 232`（卡内垂直居中） |

节奏：锁头 → **44** → 主标题 → **18** → 副题 → (弹性 74) → 页脚贴底。

---

## 3. 文案（已定，直接落）

| 位 | 值 |
|---|---|
| 字标 | `M Map` |
| 中文副行 | `澳门公交 · 实时导航` |
| 主标题 | `全澳巴士 · 轻轨` ／ `这一程怎么走最快`（两行） |
| 副题 | `输入起点与终点，给出步行 + 巴士／轻轨 + 换乘 + 实时到站的门到门方案，按总时长排序。` |
| 页脚左 | `musttoukou.vercel.app` |
| 页脚右 | `数据来源：澳门交通事务局（DSAT）` |

**刻意的三个选择（都为了避开 AI 模板味）：**

1. **中文副行放 tagline，不放中文名** —— 中文名仍**待用户拍板**（`02-logo/README.md §C`：首选「顺路」）。待定名**不能进分享卡**（会被搜到、会固化误名）。定名后改 `og.html` 一处重跑即可。
2. **副题 = 真实产品承诺**（取自 README 首段口径），不是 "Welcome to / 一站式出行" 之类填充语；并带**具体机制**（门到门 / 按总时长排序）。
3. **页脚写 DSAT 来源** —— 本项目是**非商业公众数据产品**，来源透明本身就是信任信号（站内 `/about` 同一口径）。

---

## 4. 生成与自检

```bash
# 生成（改 og.html 后重跑即全量刷新，含落地 public/brand/og.png）
node docs/迭代-v215-20260925/02-logo/final/tools/make-og.mjs

# 自检 16 项（尺寸 / 体积 / 4 处关键点落色 / 文字确实落墨 / 无紫粉簇 / 盒模型不出卡 / 主标题 2 行）
node .verify/check-og.mjs      # 期望：通过 16 / 失败 0
```

**已知产物**：`public/brand/og.png` — 1200×630 · PNG · **≈50KB**。
**middleware**：`/brand` 已在公开前缀，**无需登记**；回归确认 `node .verify/_check-middleware-public.ts`（20/20）。

---

## 5. `layout.tsx` 元数据（前端接上即可 —— 当前 openGraph / twitter **两者皆缺**）

```ts
const SITE_URL = "https://musttoukou.vercel.app"; // 与 README 线上地址一致

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL), // 必须有：相对 OG 图 URL 才会被解析成绝对地址
  title: { default: "M Map", template: "%s · M Map" },
  description: "澳门巴士 / 轻轨全澳导航：全屏地图、路线收藏与实时报站",
  manifest: "/manifest.webmanifest",
  openGraph: {
    type: "website",
    siteName: "M Map",
    locale: "zh_CN",
    url: "/",
    title: "M Map · 澳门巴士／轻轨全澳导航",
    description:
      "输入起点与终点，给出步行 + 巴士／轻轨 + 换乘 + 实时到站的门到门方案，按总时长排序。",
    images: [
      { url: "/brand/og.png", width: 1200, height: 630, alt: "M Map · 澳门巴士与轻轨全澳导航" },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "M Map · 澳门巴士／轻轨全澳导航",
    description:
      "输入起点与终点，给出步行 + 巴士／轻轨 + 换乘 + 实时到站的门到门方案，按总时长排序。",
    images: ["/brand/og.png"],
  },
  icons: {
    /* 保持现状（v2.15 六件套，勿动） */
  },
};
```

> 验收：起本地 `npm run dev` → `curl -s localhost:3000 | grep -o 'og:image[^>]*'` 应见 `/brand/og.png`；
> 线上可用 `?share=1` 或用调试器 curl 原始 HTML 核对 `<meta property="og:image">` 为绝对 URL。

---

## 6. 留档 / 未做（不阻塞交付）

| # | 事项 | 说明 |
|---|---|---|
| O1 | **真截图版变体** | 更强的、最「不像 AI」的做法是右列换成**真实 App 地图截图**（首页全屏地图）。本轮未做：线上站受口令门保护、且需真机数据。若用户要，出第二张 `og-map.png` 做 A/B。 |
| O2 | 中文名 | 定了之后改 `og.html` 的中文副行一处（或加第三行中文名）→ 重跑生成器。 |
| O3 | 深色/浅色双版 | 分享卡平台无主题，**单版深底够用**；不做双版。 |
