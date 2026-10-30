# M Map v3.6.0 · 设计规格与 Token 增量

> 生成：2026-10-29 ｜ 设计：颜好看 ｜ 基线：v3.5.6（线上）+ `src/app/globals.css`（现行 Token 全量）
> 定位：**既有系统上的扩展**，不重做视觉体系。原则 `只增不改`：现有 Token 一个不动，新需求只增新条目。
> 三轴刻度（继承，非新设）：`DESIGN_VARIANCE=3` / `MOTION_INTENSITY=3` / `VISUAL_DENSITY=6`
> —— 这是地图工具界面（Product Register：设计服务产品），不以"独特"为标杆，以"赢得熟悉感"为标杆。
> 图标库：`@tabler/icons-react@3.47.0`（已锁定，见 `src/components/ui/Icon.tsx`）；尺寸仅 16 / 20 / 24px，`stroke=2`、`linecap=butt`。
> 禁止：emoji 作功能图标 · 紫→粉渐变 · 侧条纹（`border-left` 强调）· 渐变文字 · 装饰性毛玻璃 · 组件内裸 hex（除 `#fff` / `#000`）。

---

## 0. 三个存量事实（决定本次做法的边界）

| 事实 | 位置 | 对设计的影响 |
|---|---|---|
| 地图线是 **AMap 画布**绘制，拿不到 `var()` | `nav-map-overview.ts` 顶部注释 | 地图相关色必须是 **Token 里的具体色值**，运行时 `readToken()` 读 resolved 值 |
| AMap 2.0 `Polyline` **支持** `strokeStyle:"dashed"` + `strokeDasharray` + `lineCap:"round"` | 同上（现役 `[2,14]` 即圆点虚线） | 圆点虚线**不需要 canvas 自绘**，纯参数即可 |
| 现有分档为 5 档，`TIER_TEXT` 文案已冻结 | `src/lib/recommend/types.ts:155` | 新增档位只能叫 **档 0**，不得重排 1~5（避免动到后台判定与既有断言） |

现有 5 档文案（原文照抄，不改）：`1 全力冲刺有机会赶上` · `2 小跑能赶上` · `3 正常走能赶上` · `4 慢慢走能赶上` · `5 爬过去都能赶上`。

---

## 1. Token 增量（5 组 · 共 39 条；另有 1 组刻意 0 条）

> 全部追加到 `src/app/globals.css` 末尾新段（沿用既有「v X.Y 追加 Token」分段体例），
> 并同步一份到 `docs/迭代-v360-20261029/03-tokens-delta.css`。
> 层级标注：**C** = C-extension（项目专属扩展），**B** = B-slot（别名），**A2** = 有默认值的结构层。

### 1.1 地图 · 步行圆点虚线（C）

```css
:root {
  /* ── 地图·步行三种路（画布需具体色值 ⇒ 同 --map-line-* 模式，禁 color-mix）──
     注意：刻意**深色模式保持与浅色同值**：AMap 底图恒为浅色瓦片（本项目未接深色地图样式），
        线色若随主题抬亮，在浅瓦片上反而更看不清。此为「与 --map-line-* 不同」的显式例外，
        代码内需保留本段注释，避免后人"顺手统一"。 */
  --map-walk-done: #8c93a0;   /* 已走 = 与 --map-line-passed 同值（视觉同族） */
  --map-walk-ahead: #0b6e4f;  /* 未走 / 当前 = --brand-green 同值（项目绿） */

  /* 圆点节奏（字符串，供 split(" ") 解析成 strokeDasharray） */
  --map-walk-dash: 0.5 12;    /* 点心距 = 0.5+12 = 12.5px；配 w6 ⇒ 单点实长 6.5、点间缝 6.0
                                 ⇒ 缝 ≈ 1 个点径（谷歌步行的手感）；配 w5 同样成立（缝 5.5） */

  /* 线宽 / 不透明度（三通道区分，不只靠颜色） */
  --map-walk-w-done: 5;
  --map-walk-w-ahead: 5;
  --map-walk-w-now: 7;
  --map-walk-op-done: 0.85;
  --map-walk-op-ahead: 0.55;
  --map-walk-op-now: 1;

  /* 层级（严格插进既有 z 表：灰虚 68 < 步行三态 69/70/73 < 灰实 74 < 站点 90） */
  --map-z-walk-done: 69;
  --map-z-walk-ahead: 70;
  --map-z-walk-now: 73;

  /* 相机跟随的视野呼吸边距 —— 注意：**必须是可 parseFloat 的纯 px**。
     AMap 相机只吃数字（`setFitView(null, true, [g,g,g,g])`），前端按
     `parseFloat(readToken("--map-fit-gap"))` 直接取用。禁 calc() / clamp() / rem ——
     写成算式会让前端只能在 JS 里再造一份常量（违反「颜色间距全走 Token」P0 口径）。 */
  --map-fit-gap: 24px;
}
```

**为什么 `0.5 12` 会画成"圆点"**：`lineCap:"round"` 会在每段 dash 两端各补 `strokeWeight/2` 的半圆。dash 长度 0.5 + 两端各 3（=6/2）⇒ 单点实长 6.5、高 6 ⇒ 肉眼是一个圆点（略呈胶囊，这正是 Google 步行导航的观感，不是纯数学圆）。`--map-dash-array: 2 14`（既有非乘车灰虚线）用同机制，本项目已有实证。

### 1.2 步行分步卡片（C / B）

```css
:root {
  /* 三态墨色（色阶，不用 opacity —— 半透明在 --surface-2 上会脏） */
  --walk-now-ink: var(--fg);            /* 当前步：主文案 */
  --walk-now-bg: var(--brand-green-soft);
  --walk-now-mark: var(--brand-green);  /* 图标 / 圆盘 / 距离 */
  --walk-ahead-ink: var(--fg-2);        /* 未走：主文案 */
  --walk-ahead-mark: var(--muted);      /* 未走：图标 / 距离 */
  --walk-done-ink: var(--meta);         /* 已走：整行（含距离）—— 4.58:1 on --surface 达标 */
  --walk-done-mark: var(--meta);
  /* 注意：已走行若落在 --surface-2 底上（如嵌在 .combo-seg 内），--walk-done-ink 须覆写为 --muted
     （--meta on #eaece7 仅 3.85:1，不达 AA；--muted 为 5.04:1） */

  /* 结构 */
  --walk-rail: var(--border-2);          /* 竖向引导线（未走） */
  --walk-rail-done: var(--map-line-passed);
  --walk-step-min-h: 44px;               /* 触摸目标下限（列表项可点） */
  --walk-icon-box: 24px;                 /* 转向图标盒（--icon-lg） */
  --walk-turn-w: 2px;                    /* 竖向引导线宽 */

  /* 偏航提示（走错路 = 需纠正，非错误；用"慢色"族以避开 --warn 的对比度坑） */
  --walk-off-bg: var(--slow-soft);
  --walk-off-ink: var(--slow-ink);       /* #8a6400 on #fbf1d6 = 4.78:1 达标 */

  /* 顶部跟随横幅（AC-02「地图上方」；站牌语言 = 2px 描边 + 同色硬投影，同 .nav-searchbar） */
  --walkturn-w: 2px;                     /* 描边（= --frame-w-emph，登记别名便于主题化） */
  --walkturn-shadow: 3px 3px 0 0 var(--brand-green); /* 投影与描边**同色**，形成站牌厚度感；深色下随 --brand-green 自动换 */
  --walkturn-h: 64px;                    /* 最小高；落位公式依赖它，改多行须同步上调 */
  --walkturn-z: 92;                      /* > 车卡 90，< 下车横幅 94 */
}
```

> **为何偏航不用 `--warn`**：`--warn`(#a85e00) 在 `--warn-soft`(#f7ebdb) 上仅 **4.19:1**（不达 AA）。
> 现有的 `.nav-alarm` 就踩在这条线上；本次不去改它（只增不改），但**新组件一律避开**，改用 `--slow-*`（4.78:1）。

### 1.3 线路搜索标签（C）

```css
:root {
  /* 自适应字色（算法见 §2.4；实际取值由 chipInkOf() 运行时算，此处仅登记两端） */
  --chip-ink-light: #ffffff;   /* 深底 ⇒ 白字 */
  --chip-ink-dark: var(--fg);  /* 浅底 ⇒ 深字 */
  --chip-ring: inset 0 0 0 1px rgba(255, 255, 255, 0.22); /* 深底细内描边，把暗色标签从卡底"拎"出来（沿用 .route-chip 现役做法） */
  --chip-ring-dark: inset 0 0 0 1px rgba(15, 23, 32, 0.18); /* 浅底 + 深字时改用暗内描边 */
}
```

### 1.4 速度分档 · 新增档 0（B）

```css
:root {
  /* 档 0「大概率赶不上」：六档中**唯一的实心底**（其余五档都是浅底 + 深字）。
     颜色定案 = 实心红（--danger）。理由：与档 1 的浅红同族、色相梯度单调，见下表。 */
  --tier0-bg: var(--danger);   /* 浅色 #b4342a */
  --tier0-fg: #ffffff;         /* 6.06:1 达标 */
}
@media (prefers-color-scheme: dark) {
  :root {
    --tier0-bg: var(--danger);   /* 深色下 --danger = #ffb4ab（亮红） */
    --tier0-fg: #000000;         /* 12.37:1 达标（白字在此底上仅 1.70:1，必须反黑） */
  }
}
```

**为什么用实心红（不是琥珀）—— 色相梯度必须单调**

现存六档（`globals.css:1506-1509` 等）的色相序列是：

```
档1 浅红底 --error-container  →  档2 蓝  →  档3 绿  →  档4 浅绿  →  档5 中性
```

档 0 压在**浅红**之上，所以它只能是**更重的红**。若换琥珀，色相严重度就变成「浅红(1) > 琥珀(0)」的**非单调**序列 —— 用户会把"浅红"读得比"琥珀"更急，而档 0 才是"基本没戏"那一档。**颜色排序与语义排序必须同向**，这是硬约束。

**「红已被占用」的担忧用形态通道解决，不换色相（写死三条，不得混用）**

| 用途 | 形态 | Token / 类 |
|---|---|---|
| 删除确认 | **描边红**（透明底 + 红边框） | `.btn--danger` |
| 到站 | **脉动红**（底 + 呼吸动画） | `--track-alight-now` |
| **档 0** | **实心红块 + 白字**（六档里唯一实心） | `--tier0-bg` / `--tier0-fg` |

三者形态互不混淆（描边 / 脉动 / 实心），同屏也不会看错。**红的层级由形态保住，不靠"另开一个色相"绕开。**

**与另外两条既有色语义的边界**

| 约束 | 落地方式 |
|---|---|
| 不能用绿（项目里绿 = 「更快 / 能赶上」） | 用红族，与 `--brand-green` 无任何色相关系 |
| 必须与慢色 `--slow-ink #8a6400` 区分 | 天然分离（红 vs 琥珀，色相不同）；且慢色永远是**文字色**、档 0 是**实心底 + 白字**，两者也不同屏 |
| 必须与档 1~5 区分 | **实心 vs 浅底**这一条通道就够了 —— 六档里只它一个实心，不看色相也认得出"这不是同一量级的紧张" |

> **Backlog / 备选（不采用）**：曾评估「实心琥珀（`var(--warn)`）+ 白字」方案（4.92:1）。否决原因 = 上文的**色相非单调**：会让档 0 在色相上弱于档 1。「红被占用」这一原始顾虑改用形态通道解决后，琥珀方案没有剩余优势。**不在代码里留两套并存的开关注释**。

### 1.5 刷新按钮三态（0 条新增，全部复用）

`idle / busy / cooling` 三态**不需要新 Token** —— 现役 `--accent` / `--muted` / `--shadow-hard` / `--focus-ring` / `--dur-*` 已足够。
新增的只有 **状态语义**（`data-state`）与一条动画复用（`anim-spin`，现有 800ms linear）。
> 「能不增就不增」是本项目的 Token 纪律：每多一条 Token 就多一个漂移点。

### 1.6 提示层级替代（C）

```css
:root {
  /* 「已带入收藏」横幅删除后的轻量提示（无底色 / 无边框 / 不 fixed / 不遮地图） */
  --hintline-ink: var(--meta);   /* 4.58:1 on --surface 达标 */
  --hintline-h: 20px;
}
```

### 1.7 深色模式补值（必须同步写，否则新组件在深色下裸奔）

| Token | 浅色 | 深色（`prefers-color-scheme: dark`） | 理由 |
|---|---|---|---|
| `--map-walk-done` | `#8c93a0` | **同值** | 底图不随主题变暗（见 §1.1 注释） |
| `--map-walk-ahead` | `#0b6e4f` | **同值** | 同上 |
| `--walk-now-bg` | `var(--brand-green-soft)` | 自动（深色 = `#00391b`） | 别名，无需覆写 |
| `--walk-now-mark` | `var(--brand-green)` | 自动（深色 = `#6dd58c`） | 别名 |
| `--tier0-bg` / `--tier0-fg` | `--danger` 实心红 + 白字（6.06:1） | 亮红 `#ffb4ab` + **黑字**（12.37:1；白字在此底仅 1.70:1，必须反黑） | 深色 `--danger` 变亮红，必须反向，见 §1.4 |
| `--walkturn-shadow` | `var(--brand-green)` 同色硬影 | 自动（`#6dd58c`） | 别名 |
| `--map-fit-gap` | `24px` | `24px` | 相机常量，不随主题变 |

---

## 2. 界面规格

### 2.1 场景 A · 路线详情页的步行段预览（静态，不跟随）

**位置**：`NavDetailBody` 现有「步行 5 分 → 新馬路」行（`.rc-row--walk`）**右侧**加一个**文字入口**，点开在该行下方插入步骤列表。

> 入口必须是**文字「步行指引」**（AC-01），不能只给一个图标键 —— 一个孤零零的 chevron 无法让用户预判"点开会发生什么"，而且 4 个汉字正好把这个动作说清楚。

**结构**

```
.rc-row--walk                                    ← 现有行，文案不动
  ├ .rc-dot.rc-dot--walk                          (Icon walk / 16px / 20px 盒)
  ├ .rc-text   「步行 5 分 → 新馬路」              ← 现状
  └ .walkseg__toggle  (button, min-h 44px, 右侧)
      「步行指引」+ Icon caretDown 16px
      aria-expanded / aria-controls="walkseg-{id}"

.rc-walklist  (id=walkseg-{id})                   ← 新增：展开后插入，紧随该行
  ├ .walklist__sk                                 ← AC-08a：预取未命中时的骨架（见下）
  └ .walkstep  × N
      ├ .walkstep__mark     转向图标 20px（--icon-md）
      ├ .walkstep__body
      │   ├ .walkstep__txt   指令文案（--text-md / 1.45）
      │   └ .walkstep__sub   地标补充（--text-xs / --text-2xs，可选）
      └ .walkstep__dist      「180 米」（tabular-nums）
```

**`.walkseg__toggle` 规格**

| 项 | 值 |
|---|---|
| 形态 | 文字按钮（无边框无底色），`min-height: 44px`、`padding: 0 var(--space-2)` |
| 位置 | **紧随步行文案之后**（`margin-left: var(--space-2)`），**不推到行末** —— 行末在长文案（「步行 12 分 → 議事亭前地 → 玫瑰聖母堂」）时会把入口挤到很远处，与文字失去关联 |
| 文字 | 「步行指引」`var(--text-sm)` 13px / `--fw-emphasize` / `var(--accent)` |
| 图标 | `caretDown` 16px，gap 4px，展开时 `rotate(180deg)`（`--dur-base`） |
| 可点态 | `:focus-visible` → `box-shadow: var(--focus-ring)`；`:active` → `filter: var(--state-active)` |
| 无 steps 时 | **不渲染**该入口（不出现"点了没东西"的死按钮） |

**AC-08a · 展开瞬间的骨架态（关键：不能撑高、不能闪）**

预取命中（≤200ms）→ 直接出列表，**不出现骨架**。预取未命中：

- 用 detail-body 已有的 `walkOut.minutes` / `distanceM` 先渲染**首行摘要**（「共 6 段 · 约 5 分钟 · 430 米」，`--muted`）；
- 其下留 **2 行**固定 44px 的占位：`background: var(--surface-2)`、`border-radius: var(--radius-chip)`、无动画（**不用 shimmer** —— 200ms 内就换掉了，闪一下反而更乱）；
- steps 到位后**原位替换**，不改变容器总高（占位 2 行 = 实数据前 2 行的高度）。
- 降级（AC-08 / 无路网）：占位换成一行文字「暂无详细步行指引」，同时保留距离与时长（不出现空白地图、不出现永久加载）。

**排版与间距**（4px 网格，只用现役 `--space-*`）

| 元素 | 值 |
|---|---|
| 行最小高 | `var(--walk-step-min-h)` = 44px（含 12px 上下内距） |
| 行横向内距 | 左 `calc(var(--walk-icon-box) + var(--space-3))` = 36px（缩进到与 `.rc-text` 文字左缘对齐：20 圆点 + 9 gap ≈ 29px，取 36 是为了同时容纳转向图标 24px 盒 + 12 间距） |
| 图标盒 | 24×24，图标 20px，距文字 `var(--space-2)` = 8px |
| 指令文案 | `var(--text-md)` 15px / `--leading-body` 1.55 / 颜色见三态 |
| 距离 | `var(--text-sm)` 13px / `--font-mono` 关（用 body）/ `font-variant-numeric: tabular-nums` |
| 行分隔 | 无边框；靠 24px 竖向引导线（`.walkstep__rail`，`--walk-turn-w` = 2px）串起来 |
| 引导线几何 | `position:absolute; left:11px; top:20px; bottom:-20px` —— **行高会随文案变成 44/58/76px，不能用固定长度**。`top:20px` = 本行图标中心（下内距 8 + 图标盒 24/2）；`bottom:-20px` 伸进下一行 20px = 下一行图标中心 ⇒ 两段**严丝合缝**，视觉上是一条连续的线（已在预览里按 4 倍缩放逐行量过几何）。最后一行不画。 |
| 列表上距 | `var(--space-1)` = 4px；下距 `var(--space-2)` = 8px |
| 注意：当前步**不得改内距** | 若给当前步行加 `padding-left`，它的图标会比其他行右移一格（视觉上"歪"）；高亮只用 `background`，几何一律不动 |

**三态矩阵**

| 状态 | 触发 | 图标 | 指令文案 | 距离 | 行底 | 附加 | 结构标记 |
|---|---|---|---|---|---|---|---|
| **当前步** | `i === currentIdx` | `--walk-now-mark`（绿）· 20px | `--walk-now-ink`（`--fg`）· `--fw-emphasize`(600) | `--walk-now-mark` · 600 | `--walk-now-bg`（绿浅）· 圆角 `--radius-chip` | 引导线（本行起）改 `--walk-now-mark` | `aria-current="step"` `data-walk-state="now"` |
| **已走** | `i < currentIdx` | `--walk-done-mark`（`--meta`）· 20px | `--walk-done-ink` · `--fw-read`(400) | `--walk-done-ink` | 透明 | 行尾 `Icon check` 16px（`--walk-done-mark`），引导线 `--walk-rail-done` | `data-walk-state="done"` |
| **未走** | `i > currentIdx` | `--walk-ahead-mark`（`--muted`）· 20px | `--walk-ahead-ink`（`--fg-2`）· 400 | `--walk-ahead-mark` | 透明 | 引导线 `--walk-rail` | `data-walk-state="ahead"` |

> 三态**三条独立通道**：色阶（绿 → 深灰 → 中灰）+ 字重（600 → 400）+ 背景（有 → 无 → 无）+ 行尾 check（有/无）。
> 不靠单一颜色，色觉障碍用户靠字重 + check 也能分辨（WCAG 1.4.1）。
>
> **场景 A 的 `currentIdx` 恒为 -1**（静态预览，无定位）⇒ 全部按「未走」渲染，只有场景 B 才出现当前步。这是刻意的：详情页是"看未来"，不是"看进度"。

**展开/收起交互**

- 默认**折叠**（不抢主线；详情页首屏信息密度已经是 6/10）。
- 点击 `chevron-down` → 展开，图标 `rotate(180deg)`，`--dur-base` 200ms `--ease-standard`。
- `prefers-reduced-motion: reduce` → 不旋转（图标 `display` 切换）。
- 展开态**不记忆**（退出详情即复位）—— 记住它会让第二次进入的首屏不可预测。

### 2.2 场景 B · 步行跟随（`body[data-nav-phase="walk"]`）

**两条表面，各司其职**（按 AC-02 的「地图上方」裁定，**不再把当前步塞进面板** —— 同一句话在两处出现是噪音）

```
① 顶部跟随横幅 .walkturn         fixed，压在地图上（不占面板） → 「现在往哪走 / 还有多远」
② 面板 .route-sheet（half 档）   步骤列表                     → 「整段怎么走」
```

#### ① `.walkturn` 顶部跟随横幅

```
.walkturn  (position:fixed; top: calc(var(--space-3) + var(--safe-top));
            left/right: var(--space-4); min-height: var(--walkturn-h); z-index: var(--walkturn-z))
  ├ .walkturn__mark    图标 24px
  ├ .walkturn__body    flex:1, min-width:0
  │   ├ .walkturn__txt   指令「右转进入亞美打利庇盧大馬路」
  │   │                  --text-lg 17px / --fw-emphasize / 行高 1.3 / 最多 2 行（-webkit-line-clamp:2）
  │   └ .walkturn__sub   途经补充（可选）--text-2xs / --muted
  └ .walkturn__dist    「120 米」--text-xl 20px / --fw-announce / tabular-nums
```

**视觉规格**

| 项 | 值 |
|---|---|
| 底色 | `var(--surface)` |
| 描边 | `var(--walkturn-w)`（2px）`solid var(--brand-green)` |
| 投影 | `var(--walkturn-shadow)` = `3px 3px 0 0 var(--brand-green)` —— **与描边同色**，厚度感与 `.nav-searchbar`（2px 蓝边 + `--shadow-hard` 蓝影）同构，不生造新语言 |
| 内距 | `var(--space-2) var(--space-3)` |
| 圆角 | `var(--radius-card)` 10px |
| 距离列 | 右对齐、`white-space: nowrap`、最小宽 72px（避免「9 米」「120 米」「1.1 公里」三种长度抖动） |
| 出现条件 | **仅 `body[data-sheet="open"]`** —— 面板打开时顶部搜索条已淡出（现役 `body[data-sheet="open"] .nav-searchbar`），二者同槽，不同时出现 |
| 无障碍 | 整条 `role="status" aria-live="polite"`；**指令文字必须成句可读**（不得只有箭头图标，PM §7 无障碍硬要求）；文字 ≥16px（本规格 17px） |

**四态（一条横幅承担，绝不叠两条）**

| `data-state` | 场景 | 底色/描边 | 图标 | 左文案 | 右区 |
|---|---|---|---|---|---|
| `turn`（默认） | 正常跟随 | `--surface` / `--brand-green` | 转向图标（直行/左/右/掉头）| 本步指令 | 「120 米」绿 20px/700 |
| `off` | 偏离 > 50 米（AC-05） | `--walk-off-bg` / `--walk-off-ink` | `alertTriangle` | 「已偏离路线 50 米」 | 「回到路线」文字按钮（36px 高 + 伪元素撑到 44） |
| `arrive` | 最后一步完成（AC-13） | `--walk-now-bg` / `--brand-green` | `walkArrive`（旗） | 「已到达 議事亭前地」 | 无 |
| `manual` | 定位不可用（AC-11） | `--surface-2` / `--border-2` | `infoCircle` | 「定位不可用，无法跟随」 | 「重试」文字按钮 |

- **不脉动**：全屏只允许 `--track-alight-now` 一处脉动（下车是秒级安全事件，偏航不是）。
- **投影只属于 `turn` 态**：`off / arrive / manual` 一律 `box-shadow: none` —— 同色硬影在这里表达"**正在跟随**"（站牌被立起来），异常态撤影 = 自动降权。这样四态共用一套几何，权重差异不用再加别的通道。
- 偏航超过 60 秒仍未回线 → 文案改「已重新规划路线」，3 秒后自动消失并回 `turn`。
- 「回到路线」= 重新居中 + 高亮路线上最近点（AC-05 动作口径，实现由架构定）。

#### ② 面板侧（`.route-sheet`）

| 项 | 值 |
|---|---|
| 档位 | 进入 walk 时落 **`half`**（必须露出地图看脚下）；用户可上拖 `full` 看完整步骤；**禁 `peek`**（peek 会丢掉当前步） |
| `.walkseg` | 自动展开，只渲染 **当前步 + 后续 2 步**（≤3 行）；已走压成一行 `.walkseg__done`「已完成 4 步」（`Icon check` 16px + `--text-xs`，44px 命中区，点开看全量） |
| 步进动效 | 不做滑动（走路看屏，动效越长越危险）；只做 `--dur-instant`(90ms) 的 `opacity` 交叉 |
| 收尾 | 距终点 < 30 米时列表整体淡出（200ms），只留横幅的「即将到达」 |
| 超长步行（AC-09，> 2500 米） | 列表顶部一条 `--slow-soft` 提示块「该段步行较远，请确认是否改乘」；**不自动进入 walk 态** |
| 手动兜底（AC-11） | 列表底部两个 44px 文字按钮「上一步 / 下一步」，仅 `data-state="manual"` 或用户手动模式下出现 |
| 观测钩子 | `body[data-walk-step]`（1 起，架构已定稿）+ `.walkstep[data-walk-state]` |
| **列表与地图是两套进度** | 列表按**步级**（`currentStepIdx` 切 `data-walk-state`）；地图按**米级**（`ratio = doneInStepM / step.distM` 切 `nowPath`）。**不要用一个索引推两处** —— 一步 180 米走 3 分钟，步级粒度中途零反馈（详见 §2.3 细节 5） |
| 弧线/直线 | 只用 `step.polyline` 原样；**不做平滑、不做贝塞尔拟合**（走的是真实步道，不是示意图） |

**地图路径跟随**（视觉要求，相机计算由架构师定）

- 视野 = 当前步折线的 bounds + `--map-fit-gap`（**24px 纯数值**，`parseFloat` 直取）；
- 到步末 15% 时**提前**把下一步并入视野（避免"走到头才跳"）；
- 相机移动 `animate: true` 且 ≤ 300ms —— 与面板 `--sheet-dur-open` 同量级，制造"整体在动"的错觉而非地图单独跑；
- `prefers-reduced-motion: reduce` → **不做位移动画**，改分段跳转（PM §7 无障碍硬要求）。

### 2.3 地图三种路（**三条独立 Polyline**，AMap 参数表）

> **口径（架构锁定 · 主理人要求两份文档字段名与语义一致）**：地图上是**三条各自独立的 `AMap.Polyline`**，不是"同一条折线切三份"。字段名一律 `donePath` / `nowPath` / `aheadPath`，**不得出现 `walked` / `remaining` / `pathDone` 之类别名**。

| 几何 | 语义 | Token | `strokeWeight` | `strokeOpacity` | `strokeDasharray` | `zIndex` |
|---|---|---|---|---|---|---|
| `donePath` | 已走过的整段（**累积、单调增长**） | `--map-walk-done` | 5 | 0.85 | `[0.5, 12]` | 69 |
| `aheadPath` | 后续步（尚未开始） | `--map-walk-ahead` | 5 | 0.55 | `[0.5, 12]` | 70 |
| `nowPath` | 当前步**剩余**部分 | `--map-walk-ahead` | **7** | **1** | `[0.5, 12]` | 73 |

公共参数：`strokeColor` 读 `readToken()` resolved 值 · `strokeStyle:"dashed"` · `lineJoin:"round"` · `lineCap:"round"` · `showDir:true`（仅 `nowPath`）。

**切分规则（重要，别写反）**

- `nowPath` = 当前步折线按 `ratio`（`doneInStepM / step.distM`）切成的前半 + 后半中的**后半**（还没走的那截）；
- `donePath` **不参与任何切分** —— 它是每帧把"当前位置投影点"追加到末尾得到的**独立累积线**，**偏航重算后不清空、不重置**（长度单调不减，已追加顶点永不删除、永不回退）；
- ⇒ `donePath` 与 `nowPath`/`aheadPath` **可能几何不同源**（重算后路径变了）。"灰线与新绿线接续但不完全共线"是**正确行为，不是 bug** —— 灰线是用户真实走过的轨迹，不该跟着新路径重画。这也顺带消掉了我原本担心的"重算后走过的路又变绿"。

**六个细节**

1. `lineCap:"round"` 是"圆点"的**唯一**来源，缺了就是普通短虚线（会被误读成施工路段）。
2. 已走/后续 **weight 同为 5**，靠 `opacity` 0.85 vs 0.55 与色相区分；当前步加到 7 —— 三态是「灰实心感 → 绿淡 → 绿实」，不看颜色也能看出谁在前。
3. 起终点用现役 marker：起点红钉 / 终点绿钉（`pin-svg.ts`），**不新增步行端点样式**（同一趟里两套端点 = 认知负担）。
4. 蓝点（用户位置）z=128，永远压在线之上；**步行线不得高于 74**（否则会盖住公交段灰实线），更不得插到 128/130 之上。
5. **两套进度不要混用**：列表的 `data-walk-state` 是**步级**（`done/now/ahead`，索引切分）；地图的三条线是**米级**（`ratio` 切分）。**不能用同一个 `currentIdx` 去推导地图几何** —— 一步 180 米走 3 分钟，步级粒度中途没有任何反馈。
6. **与乘车彩段（72）的关系**：`nowPath` 73 > 彩段 72，即"步行→乘车过渡的 1~2 秒里步行线压在乘车线之上"。这是**刻意**的 —— 不变式是「**当前动作的图层永远高于其它路径**」。这与"偏航重算"无关（重算是同一条步行线内部的事，靠 §2.3 的 `donePath` 独立累积解决，不需要动 z）。
   - 若走查认为过渡期刺眼：**不要改 z**，改为"进入 riding 时三条步行线 `0ms` 全部移除（不做淡出）"，把共存窗口直接消掉。

### 2.4 线路搜索结果（分区结构 + 主题色徽章）

**口径变更（AC-40 定稿）**：不是"每行一个「巴士线路」字样"，而是**分区**——分区标题只在区头出现一次，每行给「主题色徽章 + 方向名 + 副标题」。

```
.ssheet__sect                           ← 已有容器（现役 padding 12/14/4）
  ├ .ssheet__sect-title  「巴士线路」      ← 分区标题：11px / --fw-announce / 0.09em / --muted
  │                        复用现役 .nav-fold-group-label 的排版（勿新造）
  └ .line-result  × N                    ← 56px 行，整行可点
      ├ .linechip                       线路编号徽章（底色 = 线路主题色，字色 chipInkOf 算）
      ├ .line-result__main
      │   ├ .line-result__name          「往 關閘總站」（方向即名字，避免与徽章重复编号）
      │   └ .line-result__sub           「查看全线站点」← AC-40 必需，承担"点了会跳页"的预告
      └ Icon forward 16px / --meta      可跳转指示

.ssheet__sect--place                    ← 第二区（地点/站点）：标题上方 1px --border 分隔
  └ .ssheet__sect-title  「地点 / 站点」
```

**分区排序与分隔**

- 线路区在**最前**，地点区在后（AC-40 保留用户原话的排序）；
- 两区之间：`.ssheet__sect--place { border-top: 1px solid var(--border); margin-top: var(--space-2); }`
- **无线路命中 → 整个线路区不渲染**（AC-43：不留空标题、不报错）；
- 同时命中 → 两区**并存**（AC-44：不得互相覆盖或合并成一条）。

**`.linechip`（徽章）规格**

| 项 | 值 |
|---|---|
| 内容 | 线路编号原文：`25` / `26A` / `51A` / `N1`；轻轨**去掉 `LRT-` 前缀只留中文名**（`氹仔線` / `石排灣線` / `橫琴線`） |
| 字号 | `var(--text-2xs)` 11px / `--fw-announce` 700 / 字距 `0.02em` / `white-space: nowrap` |
| 内距 | `3px 8px`；最小高度 22px（内容 2~3 字，需比类型徽章略大才压得住行） |
| 圆角 | `var(--radius-chip)` 6px（**不是胶囊** —— 全站 chip 已收敛到 6px） |
| 最小宽 | 34px（2 字与 4 字徽章对齐，避免行首参差） |
| 底色 | 该线路主题色（`/api/route-lines` 的 `color`，即 `routes.color`） |
| 字色 | `chipInkOf()` 计算（算法见下） |
| 内描边 | 深底 → `--chip-ring`；浅底深字 → `--chip-ring-dark` |

**`.line-result` 行规格**

| 项 | 值 |
|---|---|
| 高度 | 56px（`min-height`，触摸目标 ≥44 达标） |
| 布局 | `flex; align-items:center; gap: var(--space-2)` |
| **徽章列** | 徽章归一到 **72px 宽、内容居中** ⇒ 所有行的名称左缘**对齐**（2 字的 `25` 与 4 字的 `石排灣線` 不会让名字忽左忽右）。72 是按最长的 `石排灣線`（4 字 × 11px + 内距）量出来的，不必再放宽 |
| 名字 | `var(--text-md)` 15px / `--fw-emphasize` / `--fg`（方向文案较长，允许单行 ellipsis） |
| 副标题 | `var(--text-2xs)` 11px / `--muted` / 行高 1.2，与名字间距 2px |
| 触觉 | `:active` → `background: var(--surface-2)`；`:focus-visible` → `--focus-ring` |

> 三重区分（分区标题 + 主题色徽章 + 副标题「查看全线站点」）+ 点击**打开线路视图（首页右栏，URL 不变）**而非填起终点（AC-41），是这次压住"输入 25 以为选了地点"的**四件事一起做**，不是靠调序。

**对比度决策算法（确定性，无主观）**

```ts
// 建议落点：src/lib/ui/chip-ink.ts（纯函数，client/server 通用，不 import pg）
// #0f1720 (--fg) 的相对亮度是常量 0.00819，此处固化为常量，避免每次重算
const L_INK = 0.00819;

function relLum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 返回 { ink, bg }：ink = '#fff' | 'var(--fg)'，bg = 实际要渲染的底色 */
export function chipInkOf(hex: string): { ink: "#fff" | "var(--fg)"; bg: string } {
  const L = relLum(hex);
  // ① 白字达标：1.05 / (L + 0.05) ≥ 4.5  ⇒  L ≤ 0.1833
  if (L <= 0.18) return { ink: "#fff", bg: hex };
  // ② 深字达标：(L + 0.05) / (0.00819 + 0.05) ≥ 4.5  ⇒  L ≥ 0.2122
  if (L >= 0.212) return { ink: "var(--fg)", bg: hex };
  // ③ 死带 0.18 < L < 0.212：两个方向都 < 4.5:1 ⇒ 底色加深 14% 后必落回 ①
  return { ink: "#fff", bg: mixBlack(hex, 0.14) };
}

/** 乘性加深（等价于 color-mix(in srgb, c 86%, #000)，但服务端/客户端都能算） */
function mixBlack(hex: string, k: number): string { /* 每通道 × (1-k)，四舍五入 */ }
```

**阈值表（判定依据，写死在注释里防漂移）**

| 底色亮度 L | 字色 | 4.5:1 边界 |
|---|---|---|
| `L ≤ 0.183` | 白 `#fff` | 恰好 4.5 时 L = 0.1833 |
| `0.183 < L < 0.212` | **死带** → 底色加深 14% → 白字 | 两向最优仅 4.25:1（L≈0.197），必须改底色 |
| `L ≥ 0.212` | `var(--fg)` | 恰好 4.5 时 L = 0.2122 |

**兜底（第三级，极少触发）**：若该线路色**非 6 位 hex**（数据脏、带 `rgb()`、空值）→ 渲染中性 chip：
`background: var(--surface-2)` + `color: var(--fg)` + 前置 6×6 圆点（`background: 线路原值或 --muted`）。
此时线路色只出现在圆点上，不承担文字底色职责（15.2:1，绝对安全）。

**深色模式**：底色是**数据**（线路色），不随主题变；只有内描边切换。

### 2.5 速度分档（六档完整顺序）

| 档 | 文案（`TIER_TEXT`） | 底色 | 字色 | 对比度 | 出现位置 |
|---|---|---|---|---|---|
| **0** | **大概率赶不上** | `--tier0-bg`（`--danger` **实心红**） | `--tier0-fg`（白） | 6.06:1 | **仅详情页**（绝不出现在推荐列表） |
| 1 | 全力冲刺有机会赶上 | `--error-container` | `--on-error-container` | 现役 | 两处 |
| 2 | 小跑能赶上 | `--primary-container` | `--on-primary-container` | 现役 | 两处 |
| 3 | 正常走能赶上 | `--ok-container` | `--on-ok-container` | 现役 | 两处 |
| 4 | 慢慢走能赶上 | `--tier-4` | `--on-ok-container` | 现役 | 两处 |
| 5 | 爬过去都能赶上 | `--tier-5` | `--on-surface-var` | 现役 | 两处 |

**顺序逻辑**：0（赶不上·**实心红**）> 1（冲刺·浅红）> 2（小跑·蓝）> 3（正常·绿）> 4（慢走·浅绿）> 5（极慢·中性）。

两条通道**同向叠加**，不是二选一：
- **色相梯度单调**：档 1 本就是浅红（`--error-container`），档 0 用更重的红 ⇒ 色相严重度与语义严重度同向，不会出现"浅红读起来比档 0 更急"的倒挂；
- **形态通道再上一层**：六档里只有档 0 是**实心 + 白字**，其余五档都是浅底 + 深字 ⇒ 不看色相也认得出"这不是同一量级的紧张"，色觉障碍用户同样成立。

**红的三条形态分工（写死，不得混用）**：删除确认 = **描边红** ｜ 到站 = **脉动红** ｜ 档 0 = **实心红块 + 白字**。三者形态互不混淆，所以"红被占用"不构成冲突。

**规格**

| 项 | 值 |
|---|---|
| 尺寸 | `padding: 2px 8px`；六档统一 `var(--text-xs)` 13px（**档 0 不缩字号**） |
| 宽度余量 | 按 **7 字**预留：7 × 13 = 91px + 内距 16 = **107px**。当前文案 6 字实占 94px，余 13px 供将来微调。**档 0 自身不设 `min-width`**（设成 107px 会在 6 字时留 1 字空白，看起来像没居中）；由外层 `.rc-dhead__r` 的 `max-width: 56%` 保证不换行、不截断 |
| 换行 | `white-space: nowrap`，**永不截断、永不换行**（AC-35） |
| 字重 | `--fw-announce` 700（档 0）／ 600（1~5） |
| 圆角 | `var(--radius-chip)` 6px |
| 图标 | **档 0 不加图标** —— 六档里只有它带图标会破坏徽章形态一致性；且「大概率赶不上」六个字已把话说尽，图标只会抢宽度 |
| 位置 | 详情页：`.rc-dhead` 下方第一行右侧（现役 `TierBadge` 槽位，与五档**完全同一位置**，AC-35）；推荐卡：**永不渲染** |
| 可点性 | **不可点、无 hover、无跳转、不弹任何东西**（AC-37 硬要求）。实现上直接用 `<span>`，不加 `cursor:pointer`、不加 `role="button"` |
| **边界（主理人裁决）** | 档 0 **只影响标签渲染**，**不得改变任何按钮的可用性** —— 详情页的「开始导航 / 就坐这条」等主按钮一律照常可用。用户口径是"只给这个标签，不做任何其他推荐"，禁用主按钮属**额外行为**，已从本规格剔除 |

**内容约束**

- 主文案固定为 **「大概率赶不上」（6 个汉字）**，逐字照写，不换词、不缩写（AC-35 已收口：曾出现的"5 字"系口误，规格现无字数指标，仅要求"不截断、不换行"；宽度按 7 字预留）。
  - 「大概率」三字承载的是「档 0 = 连冲刺都赶不上」的**判定**语义，不是"可能赶不上"——不得替换为「多半」等概率词。
- 有该班时刻时的变体：「大概率赶不上 18:42 那班」（同徽章，`white-space: nowrap`，不加图标）。
- 语义不复述：不开 `role`，纯文本随卡片可读；不写「注意」「警告」等元词。
- **实现门禁**：`TierBadge` 增加 `scope: "detail" | "list"`，`tier===0 && scope==="list"` 时 `return null` 并 `console.warn`（开发期暴露误用；生产静默）。设计侧是**组件级拦截**，不靠"记得别在列表传 0"。

### 2.6 刷新按钮三态

| 态 | `data-state` | 外观 | 交互 |
|---|---|---|---|
| **可点** | `idle` | 白底 + `1.5px solid var(--accent)` + `box-shadow: var(--shadow-hard)`；图标 `--accent` 20px | 可点；`aria-label="刷新"` |
| **正在刷新** | `busy` | 同上（**保留**描边与硬投影 —— 它不是"不可用"，是"正在工作"）；图标 `--accent` + `anim-spin` 800ms linear infinite；**不显示秒数** | `aria-busy="true"`，`aria-disabled="true"`，点击无效 |
| **冷却中** | `cooling` | `border-color: transparent` + 撤投影；**图标 `opacity: 0`（完全隐去）**；中心 `--font-mono` 13px 600 秒数 `--muted`；外圈 `conic-gradient` 进度环（`--cd-p` 100→0） | `aria-disabled="true"`；冷却开始**播报一次**「10 秒后可再次刷新」，不逐秒 |

> **为什么图标从 `.25` 改成 `0`**：现役实现是图标淡到 0.25 后把秒数压在中心。但 20px 图标与 13px 数字**几何重叠**（都在 44px 圆的正中），真机实测读起来像"糊了一层油"。冷却态的唯一信息是**还剩几秒**，图标此刻是纯噪音 ⇒ 隐去。这是本批唯一的既有视觉修正，改动量 1 行 CSS。

**冷却作用域（口径以架构锁定版为准）**

- 判定源 = `refreshScope: "bus" | "lrt"`，由 hook 输出：**当前追踪腿的 `kind`**（`legs[legIndex].kind`）；无追踪态时取 `card.rides[0].kind`。
- `"lrt"` ⇒ `data-cooldown="off"`，**永不进 `cooling`**（点了就 `busy` → 回 `idle`，无倒计时）；`aria-label` 固定「刷新」。
- `"bus"` ⇒ 正常 10 秒冷却。
- **禁用** `rides.every(r => r.kind === "lrt")`（我原稿的写法，已被架构推翻，此处更正）：多腿方案（巴士→轻轨）在第二腿时当前腿是轻轨，此时刷巴士数据无意义（`fetchFrame` 对非 bus 腿直接 return），应判 off；而 `every(lrt)` 会判成"有巴士" ⇒ 给了一个**刷不出任何东西的冷却**。判定必须跟"当前在看哪条腿"走。
- 视觉上不给"这个不冷却"的额外标记 —— **不必解释机制**，用户只会感受到"点了就响应"。

**实现纪律（架构要求，会卡体感）**

- 冷却状态**只允许存在于 `RefreshButton` / `NavTrackBar` 的局部作用域**，**禁止提升为任何全局 loading/busy 变量**。一旦全局化，步行进度会看起来"卡住"，用户会以为定位坏了。
- 冷却**不作用于**：① 定位刷新（`useUserFix` 自有 1.5/3/10s 节拍）② 步行进度推进（GPS 帧驱动）③ 步行重算（自有 3s 独立冷却）。

**`prefers-reduced-motion`**

- `busy`：不旋转（`is-spin` 动画置 none），改图标 `opacity` 1 → .55 → 1（1.6s，与 `--track-pulse-dur` 同值，全站唯一脉动节奏复用）；
- `cooling`：进度环按秒**跳变**（`transition: none`），秒数照常更新。

### 2.7 「已带入收藏」横幅：删除

**现状**：`.nav-banner`（`position: fixed; top: 120px`）显示「已带入收藏：A → B」，与搜索条并列挂在 `.nav-map-wrap` 外。

**判断**：这条信息 **100% 冗余** ——
1. 目的地已在 `.nav-searchbar__text` 显示；
2. 出发地已在起点面板 `.rpanel__value` 显示；
3. 它是 `fixed` 浮层，会压在**地图手势区**上（与 `pointer-events` 相关的老问题同源）。

**结论：直接删除，不做替代。** 这是最轻的处理 —— 用"更轻的提示"仍然是"多一条提示"。

**若产品坚持要保留"这是从收藏来的"这一层上下文**，用第三级方案（成本从低到高）：

| 方案 | 形态 | 代价 |
|---|---|---|
| **A（推荐）** | 不保留。出发地值本身已说明（「我的位置」vs「殷皇子大馬路」） | 0 |
| **B** | `.nav-hintline`：**流内**一行，无底色无边框，`var(--text-2xs)` 11px `--hintline-ink`，贴在面板顶部第一行之后，8 秒后 `opacity` 0 消失（不 fixed、不吃事件） | +1 行 DOM |
| **C（不推荐）** | 搜索条内右侧 chip「收藏路线」 | 与「收藏地点」chip 争同一槽位，两个 chip 会挤掉站名 |

**保留 `.nav-banner` 类本身**（还服务「车辆位置暂时不可用」「已收藏地点」两处瞬时反馈），只删「已带入收藏」这一个 `div`。

### 2.8 线路站点全景页（AC-41 / AC-42 / AC-42a / AC-42b / AC-46）

**定位**：线路站点全景页（**不是**旧 `/routes`）。回答三个问题：这条线**怎么走**、**有哪些站**、**车到哪了**。
**入口（2026-10-30 AC-41 变更后）**：① 主入口＝在**首页右栏**打开，点击搜索结果**不跳页、URL 不变**；② 次入口＝`/line/[code]` **深链**，直接访问仍打开同一视图。两入口呈现**同一内容、同一套报站加载口径**，本节结构对二者通用。

**结构（自上而下）**

```
.lp-page                                ← 全屏页（复用 .rv-page 的骨架语义：--bg 底 + sticky 头）
  ├ .lp-head   (sticky top, z 5, --surface 底 + 下 1px --border)
  │   ├ [返回] 34×34（Icon back）              ← 命中区用伪元素撑到 44
  │   ├ .lp-head__title
  │   │   ├ .linechip  「25」                  ← 与搜索结果**同一个组件**，主题色 + chipInkOf 字色
  │   │   └ .lp-head__sub 「往 關閘總站 · 共 32 站」 --text-2xs --muted
  │   └ .lp-head__rev  44×44（Icon exchange）   ← 方向切换（AC-42），双向线才显示
  ├ .lp-map   (高 180px, 圆角 --radius-card, 内缩 --space-4)
  │     线路走向：整线**灰虚** + 当前方向**实线彩色**（复用现役路线查看模式的双层语言，
  │     不新造；见 nav-map-overview.ts 的 68/72 两层）
  ├ .lp-notice  （按需）「暂无实时车辆数据」    ← AC-46；轻轨线 / 无车辆数据时出现
  └ .lp-list   纵向站点列表（可滚动，独立于 .lp-map）
        └ .lp-stop × N
            ├ .lp-stop__rail   线路色竖线 3px（复用 .navstrip__seg 的几何）
            ├ .lp-stop__dot    9px 空心圆（线路色描边）／首末站实心
            ├ .lp-stop__body
            │   ├ .lp-stop__name   站名（繁体原文）--text-md
            │   └ .lp-stop__xfer   「换乘 3 路、25 路」--text-2xs --meta（可选，最多列 3 条）
            └ .lp-stop__eta    报站区（三态，见下）固定最小宽 96px，右对齐
```

**站点列表规格**

| 项 | 值 |
|---|---|
| 行高 | `min-height: 56px`（站名 + 报站两行；单行时也保持 56 保证滚动节奏稳定） |
| 竖线 | `left: 15px; width: 3px; background: 线路色`；首站从圆点起、末站到圆点止（同 `.navstrip__seg` 的首末裁剪做法） |
| 圆点 | 9×9，`border: 2px solid 线路色`，`background: var(--surface)`；首末站改实心 + 11×11 |
| 序号 | **不显示** —— 90 余站每行带序号会让列表变成表格；顺序靠竖线串联 + 首末站标记表达 |
| 站名 | `var(--text-md)` 15px / `--fw-emphasize`（首末站）/ 400（中间站）/ `--fg`；单行 ellipsis |
| 方向切换 | 头部 44×44；`aria-label="切换方向"`；切换后**列表顺序反转 + 重新对齐该方向报站**（AC-42），滚动位置回到顶部 |
| 轻轨线 | 头部徽章用轻轨线自身配色；`LRT-` 前缀不显示 |

**`.lp-stop__eta` 报站区三态（AC-42a 懒加载口径）**

| 态 | 触发 | 视觉 | 结构标记 |
|---|---|---|---|
| **未加载** | 该站不在「视口 ±1 屏」内，或尚未请求回来 | **留空**（不画骨架、不画省略号），容器保持 16px 高 —— 空 2 秒比闪一个骨架好，且**绝不撑高**（避免滚动跳动） | `data-eta="idle"` |
| **有数据** | 巴士线 + 该站有在途车 | 「还有 3 站 · 约 2 分钟」`--text-xs` 13px / `--fg-2` / 数字 600 + `tabular-nums`；两段之间用 `·` 分隔 | `data-eta="on"` |
| **无数据** | 巴士线但该站无车 · 或轻轨线（AC-46 恒走此态） | 「—」`--text-xs` / `--meta` / 右对齐 | `data-eta="none"` |

- **不给未加载态做骨架屏**（PM 明确）：占位与真数据高度一致（都是 16px 一行），出现/替换时列表零跳动。
- 轻轨线：页面级 `.lp-notice`（`--surface-2` 底 / `--muted` 字 / 12px / `padding 8px 12px` / 圆角 `--radius-chip`）说明「暂无实时车辆数据」，同时每站走 `none` 态。
  - 若走查认为 90 个「—」是噪音：**一行 CSS 即可整列隐藏**（`.lp-page[data-kind="lrt"] .lp-stop__eta{display:none}`），列宽不变、不影响对齐。我按 PM 要求默认展示，把开关做在数据属性上。
  - 必须守住的边界（AC-42a / AC-46 分两层验收）：
    - **隐藏的是样式，不是属性**。`display:none` 之下 `data-eta="none"` 仍须照常输出到 DOM —— 渲染层断言抓属性，不抓可见性。禁止用"不渲染这个 span"来实现隐藏。
    - 页面级提示条「暂无实时车辆数据」**在隐藏列时仍然必须存在**（AC-46）—— 不能连提示一起藏，那样用户只会觉得"这页没加载好"。
    - **网络层是另一层断言**（AC-42a）：轻轨线对 `/api/station/eta` 的请求数必须为 **0**，与界面渲染无关。两者不要混成一条用例。

**加载与降级**

- 首屏只渲染头部 + 地图 + 前若干站；报站随滚动按「视口内 ±1 屏、并发 ≤3、按站 60s 缓存」加载（AC-42a），**页面不做整页 loading**（AC-42b）。
- 全线 90 站**不得**一次性并发请求 —— 设计上体现为：**未加载态是默认态**，列表滚到哪才填哪。
- 失败：该站落到 `idle` 并停止重试（不显示错误图标 —— 单站报站失败不值得占用视觉注意力）。

### 2.9 新增图标清单（6 项语义 → 落点）

> 项目图标出口唯一：`src/components/ui/Icon.tsx`（`@tabler/icons-react@3.47.0`，MIT，锁死）。尺寸仅 16/20/24，`stroke=2`、`linecap=butt`、`linejoin=miter`。**新增一律在同库内选，不引第二个图标库、不用 emoji。**

| PM 语义 | registry 名（建议） | Tabler 组件 | 状态 | 用在哪 |
|---|---|---|---|---|
| 步行小人 | `walk` | `IconWalk` | **已有，直接复用** | 步行段行首、`.walkseg__toggle` 左侧 |
| 直行箭头 | `walkStraight` | `IconArrowUp` | 新增 | `.walkstep__mark`、`.walkturn__mark` |
| 左转箭头 | `walkTurnLeft` | `IconCornerUpLeft` | 新增 | 同上 |
| 右转箭头 | `walkTurnRight` | `IconCornerUpRight` | 新增 | 同上 |
| 到达旗帜 | `walkArrive` | `IconFlag2` | 新增 | `.walkturn[data-walk-turn="arrive"]`、末步 `.walkstep__mark` |
| （补）掉头 | `walkUTurn` | `IconArrowBackUp` | 新增 | U 型掉头步。**不复用现有 `undo`** —— 同组件但语义是"撤销"，同名会诱导误用 |
| 线路标签底色块 | **不是图标** | — | — | 见下 |

**关于「线路标签底色块」**：它不是图标，是 **CSS 背景色**（数据 `routes.color` + `chipInkOf()` 算字色），已落在 §2.4 `.linechip`。
若 PM 的原意是"线路**类型**图标"（巴士 / 轻轨的区分），则**复用既有** `bus` / `lrt`（两者都已在 registry 里），无需新增。
→ 请产品在验收时按这个理解核对，我不会为一个纯色块造一个 SVG。

**新增图标的验收门禁**：必须过项目既有的 `.verify/audit-icon-dots.mjs`（判据 = **零长度段**：在 `linecap:butt` 下 `M12 9h.01` 这类段不渲染，点会丢）。上面 5 个 Tabler 组件均为纯 path/圆，无零长度段，通过。**禁**用 emoji、禁用文字符号（`→` `↑` 等）充当图标。

**`turn` enum → 图标的唯一映射（架构派生，前端只读，不得从文案再猜）**

| `step.turn` | 图标 | 说明 |
|---|---|---|
| `straight` | `walkStraight` | 直行 |
| `left` | `walkTurnLeft` | 左转 |
| `right` | `walkTurnRight` | 右转 |
| `uturn` | `walkUTurn` | 掉头 |
| `arrive` | `walkArrive` | 到达（末步） |

**关于「向左前方 / 向右前方 / 靠左 / 靠右」→ 统一归 `straight`：设计侧接受，不加 `slight_*`**

理由（我这边算过账）：
- 图标只是**辅助**（`aria-hidden`），信息的真源是**文案**——文案里已经写着「向左前方」，信息一点没丢；
- 若硬映射成 `left`/`right`，一个 90° 的左转箭头配"向左前方"的文字，会让人预期"要拐进一条街"，**落差比"直行箭头"更大**；
- 多两个图标要多两个 registry 条目 + 两套门禁核对，收益与成本不成比例。

**但留一个一行可切的逃生口**：若真机走查出现"文案说向左前方、图标却是直行"被误读的情况，**不要新画图标**，改为该步**隐藏图标、只留文字**（`.walkstep__mark` 保留 24px 空占位，几何不变、不破坏对齐）。判定钩子用 `data-turn="straight"` + 文案含「左/右」即可筛出这批样本。

### 2.10 `data-nav-phase="walk"` 的 CSS 就位（架构待确认项）

新阶段加进既有四值（`off|recommend|detail|riding`）后，必须逐条确认既有规则命中，否则会出现"步行时底导又冒出来"。

| 既有规则 | 现状选择器 | walk 态处置 |
|---|---|---|
| 底导隐藏 | `body[data-nav-phase="riding"] .bottom-nav{display:none}` | **扩成两值**：`body[data-nav-phase="riding"] .bottom-nav, body[data-nav-phase="walk"] .bottom-nav{display:none}`。理由：walk 是**导航会话**，不是浏览态，底部三个 Tab（首页/收藏/帮助）此刻都是噪音 |
| 品牌栏右列隐藏 | `body[data-nav-phase]:not([data-nav-phase="off"]) .nav-brandbar__acts{display:none}` | **不要新增** —— `:not([off])` 已自动覆盖 `walk`，多写一条就是冗余且会与主规则打架 |
| 定位 FAB | `.nav-locate-fab`（无 phase 条件） | **不新增规则，保留**。walk 态它是"用户手动拖开地图后回到跟随"的唯一入口，删了就没法回来 |
| 搜索条 | `body[data-sheet="open"] .nav-searchbar{opacity:0}` | 无需改。`.walkturn` 与搜索条**同槽**（`top: calc(--space-3 + --safe-top)`），靠"只在此 sheet 打开时渲染 walkturn"避让 |
| 面板档位 | `data-detent` | walk 进入时强制 `half`；允许 `full`；**禁止 `peek`** |

**一句话答复架构**：只需改**一条**既有选择器（底导），其余零改动；`walk` **不复用 `detail` 的规则**，而是与 `riding` 同族（都是"导航会话"），差别只在"底导隐藏"这一条上完全一致。

---

## 3. 多态矩阵（前端实现对照表）

### 3.1 步行分步的三态

| 维度 | 已走 `done` | 当前步 `now` | 未走 `ahead` |
|---|---|---|---|
| 图标色 | `--walk-done-mark` | `--walk-now-mark` | `--walk-ahead-mark` |
| 文字色 | `--walk-done-ink` | `--walk-now-ink` | `--walk-ahead-ink` |
| 字重 | 400 | 600 | 400 |
| 行底 | 透明 | `--walk-now-bg` | 透明 |
| 引导线 | `--walk-rail-done` | `--walk-now-mark` | `--walk-rail` |
| 行尾标记 | `check` 16px | 无 | 无 |
| 地图几何 | `donePath` 灰圆点 w5 op.85 | `nowPath` 绿圆点 **w7** op.1 | `aheadPath` 绿圆点 w5 op.55 |
| 可点 | 否（仅查看） | 否 | 否 |
| ARIA | `data-walk-state="done"` | `aria-current="step"` | `data-walk-state="ahead"` |

### 3.2 刷新三态 × 冷却开关

| 组合 | 结果 |
|---|---|
| `idle` + `cooldown=on` | 可点 |
| `busy` + `cooldown=on` | 转，点无效 |
| `cooling` + `cooldown=on` | 倒计时环 |
| `idle` + `cooldown=off`（纯轻轨） | 可点 |
| `busy` + `cooldown=off` | 转，点无效 |
| `cooling` + `cooldown=off` | **非法组合** → 强制回落 `idle`（组件内断言） |

### 3.3 速度分档 × 出现位置

| 档 | 推荐列表 | 详情页 | 说明 |
|---|---|---|---|
| 0 | **禁止** | 允许 | 组件层拦截（`scope`） |
| 1~5 | 允许 | 允许 | 现状 |

### 3.4 线路徽章 × 对比度分支

| 线路色 L | 字色 | 底色 | 内描边 |
|---|---|---|---|
| ≤ 0.18 | `--chip-ink-light` | 线路原色 | `--chip-ring` |
| ≥ 0.212 | `--chip-ink-dark` | 线路原色 | `--chip-ring-dark` |
| 死带 | 白 | 原色 × 0.86 | `--chip-ring` |
| 数据非法 | `--fg` | `--surface-2` | 无（6px 色点替代） |

### 3.5 顶部跟随横幅 × 四态

| `data-walk-turn` | 底色 | 描边/影 | 图标 | 左文案 | 右区 | ARIA |
|---|---|---|---|---|---|---|
| `turn` | `--surface` | `--brand-green` | 转向图标 24px | 本步指令 17px/600 | 距离 20px/700 绿 | `role=status` |
| `off` | `--walk-off-bg` | `--walk-off-ink` | `alertTriangle` | 「已偏离路线 50 米」 | 「回到路线」36px 文字按钮 | `role=status` |
| `arrive` | `--walk-now-bg` | `--brand-green` | `walkArrive` 旗 | 「已到达 {站名}」 | 无 | `role=status` |
| `manual` | `--surface-2` | `--border-2` | `infoCircle` | 「定位不可用，无法跟随」 | 「重试」36px | `role=status` |

### 3.6 全景页报站 × 三态

| `data-eta` | 触发 | 视觉 | 高度 |
|---|---|---|---|
| `idle` | 不在视口 ±1 屏 / 请求未回 | **留空**（无骨架、无省略号） | 16px（固定） |
| `on` | 巴士线 + 该站有车 | 「还有 3 站 · 约 2 分钟」`--fg-2` | 16px |
| `none` | 巴士线无车 / **轻轨线恒此态** | 「—」`--meta` 右对齐 | 16px |

> 三态同高 ⇒ 由 `idle` 跳到 `on` 时列表**零跳动**（这是"不做骨架屏"能成立的前提）。

### 3.7 搜索结果 × 分区

| 命中情况 | 线路区 | 地点/站点区 |
|---|---|---|
| 只有线路 | 渲染 | 不渲染（不留空标题） |
| 只有地点 | **不渲染**（AC-43，不留空标题、不报错） | 渲染 |
| 两者都有 | 渲染（在上） | 渲染（在下，上方 1px 分隔线） |

---

## 4. 无障碍与深色模式

**对比度（全部实测算式，非估计）**

| 组合 | 比值 | 结论 |
|---|---|---|
| `--walk-done-ink`(#6e7684) on `--surface`(#fff) | 4.58:1 | 达标 |
| `--walk-done-ink` on `--surface-2`(#eaece7) | 3.85:1 | 不达标 → 该场景改 `--muted`（5.04:1） |
| `--walk-ahead-ink`(#3a424e) on `#fff` | 10.15:1 | 达标 |
| `--walk-now-ink`(#0f1720) on `--walk-now-bg`(#dcebe2) | 15.6:1 | 达标 |
| `--walk-now-mark`(#0b6e4f) on `#fff` | 6.26:1 | 达标 |
| `--walk-off-ink`(#8a6400) on `--walk-off-bg`(#fbf1d6) | 4.78:1 | 达标 |
| `--tier0-fg`(#fff) on `--tier0-bg`(#b4342a) | **6.06:1** | 达标（深色为 #000 on #ffb4ab = **12.37:1**；白字在深色底上仅 1.70:1，故深色必须反黑） |
| `--tier0-fg`(#000) on 浅色 `#b4342a`（若误配黑字） | 3.47:1 | **不达标** → 浅色必须白字，这是 `--tier0-fg` 不能在深/浅共用同一值的原因 |
| `--walkturn` 指令 `--fg`(#0f1720) on `--surface`(#fff) | 18.1:1 | 达标（17px ≥ 16px，PM §7） |
| `.line-result__sub` `--muted`(#5a6472) on `#fff` | 6.0:1 | 达标（11px 小字也过 AA） |
| `.lp-stop__eta`「—」`--meta`(#6e7684) on `#fff` | 4.58:1 | 达标 |
| `--hintline-ink`(#6e7684) on `#fff` | 4.58:1 | 达标 |
| `--meta`(#a9adb8) on 深色 `--surface`(#1c1e24) | ≈6.9:1 | 达标 |

**键盘与读屏**

- 展开键 / 回到路线 / 刷新键全部是原生 `<button>`，可 Tab 聚焦；`:focus-visible` 用 `box-shadow: var(--focus-ring)`（全站唯一焦点表达，不得自定义）。
- 步行列表是**只读信息**，不用 `<ul role="list">` 之外的交互语义；当前步用 `aria-current="step"`（HTML 标准值，读屏会读"当前步骤"）。
- 偏航提示 `role="status" aria-live="polite"`（不是 `assertive`：走错路不必打断读屏正在读的内容）。
- 刷新键冷却：**只播报一次**，不逐秒（逐秒播报会让读屏变成秒表）。
- 地图不可访问：所有步行信息**必须在 DOM 里完整存在**（地图只是增强，不是信息唯一载体）—— 这也是"步骤列表不能只画在 canvas 上"的原因。
- **跟随横幅（PM §7 硬要求）**：当前步指令文字 `var(--text-lg)` = **17px ≥ 16px**；转向**必须给文字**（「右转进入……」），箭头图标只是辅助，`aria-hidden`；整条 `role="status"`。
- **速度徽章档 0 不可点**：不加 `role="button"`、不加 `cursor:pointer`、不加 `tabindex` —— 读屏与键盘都不应把它当交互元素（AC-37）。

**触摸目标**

- 「步行指引」文字入口 `min-height: 44px`（不是 20px 的图标键）；
- 已走折叠行「已完成 4 步」44px 高；
- 「回到路线」视觉 36px 高 + `::after { inset: -4px -6px }` 撑到 44（沿用 `.btn--sm` 的现役做法）；
- `.line-result` 56px、`.lp-stop` 56px、`.lp-head__rev` 44×44。

**动效**

- 全部 ≤ 300ms；无弹跳曲线；无 > 1 秒动画。
- `prefers-reduced-motion` 全覆盖：展开箭头改 `display` 切换、`busy` 改透明度呼吸、**地图跟随改分段跳转（不做位移补间）**（PM §7 硬要求）。

**深色模式**

- 新组件全部走 `var()`，别名自动跟随（`--brand-green` → `#6dd58c` 等）；
- 唯二显式覆写：`--tier0-bg/fg`（反向：深色 `--danger` 是亮红 `#ffb4ab` ⇒ 必须配**黑字** 12.37:1；白字在此底仅 1.70:1）、`--map-walk-*`（**刻意保持同值**，理由见 §1.1）；
- 深色下线路徽章内描边沿用现役 `.route-chip` 的 `rgba(255,255,255,.22)`。

---

## 5. 交给前端的实现要点

**数据契约（真源 = 架构文档 `02-架构 §3.3 / §4.4`；本节只列"设计消费哪些"，字段名/类型/单位一律照真源，不改不别名）**

| 字段 | 来源 | 设计消费在哪 |
|---|---|---|
| `WalkStep.idx` / `.turn` / `.text` / `.sub?` / `.distM` | `GET /api/nav/walk` | 步骤行的图标 / 指令 / 地标补充 / 距离（`sub` 缺失则**不渲染该行、不留空行**） |
| `WalkStep.polyline` / `.cumStartM` / `.cumM[]` | 同上 | `nowPath` / `aheadPath` 绘制；`cumM[]` 二分定位当前步（**服务端已算好，前端只读，不重算累计里程**） |
| `currentStepIdx` | `useWalkFollow` | 列表 `data-walk-state`（步级） |
| `ratio`（0~1）/ `doneInStepM` | `useWalkFollow` | `nowPath` 切分（米级）+ 横幅「还有 N 米」 |
| `donePath: [number,number][]` | `useWalkFollow` | 灰线，**独立累积、重算不清空**（§2.3） |
| `offRoute: { meters } \| null` | `useWalkFollow` | 横幅 `off` 态「已偏离路线 N 米」 |
| `refreshScope: "bus" \| "lrt"` | hook | `data-cooldown`（§2.6） |

> 抖动处理（单调不减 + 1.5m 死区 + `accuracy > 150m` 冻结）属架构实现，设计侧只需保证：**「还有 N 米」允许暂时不变，但绝不回跳** —— 数字往回走比数字不动更让人怀疑定位坏了。

**建议组件切分**（不强制，但要保持"一个信息块一个组件"）

```
src/components/nav/WalkSteps.tsx       ← .walkseg + .walkstep（三态）+ 骨架 + 手动步进
src/components/nav/WalkTurnBanner.tsx  ← .walkturn（turn / off / arrive / manual 四态）
src/components/ui/LineChip.tsx         ← .linechip（含 chipInkOf；搜索结果与全景页共用）
src/components/line/LinePage.tsx       ← .lp-page 全景页骨架
src/components/line/LineStopRow.tsx    ← .lp-stop（含 .lp-stop__eta 三态）
src/lib/ui/chip-ink.ts                 ← 对比度纯函数
```

> 原 `WalkNow.tsx` / `WalkOffRoute.tsx` **已合并**进 `WalkTurnBanner`：AC-02 要求"当前步在地图上方"，一条横幅承担四个状态，不再有两个浮层抢同一块屏幕顶边。

**观测钩子（QA 用，沿用项目 `data-*` 习惯）**

| 钩子 | 取值 | 用途 |
|---|---|---|
| `data-walk-state` | `done` / `now` / `ahead` | 断言步骤三态（AC-04/AC-14） |
| `data-walk-steps` | 数字 | 断言步骤数与接口 steps 条数一致（禁硬编码，铁律 24） |
| `data-walk-step`（挂在 `body`） | 1 起序号 | 架构已定稿，AC-04/AC-14 主钩子 |
| `data-walk-turn` | `turn` / `off` / `arrive` / `manual` | 断言顶部横幅四态（AC-05/AC-11/AC-13） |
| `data-tier` | `0`~`5` | 断言档位（含"档 0 不出现在列表"，AC-36） |
| `data-chip-ink` | `light` / `dark` / `deepened` / `fallback` | 断言对比度分支命中 |
| `data-refresh-state` | `idle` / `busy` / `cooling` | 断言刷新三态 |
| `data-cooldown` | `on` / `off` | 断言"冷却仅巴士" |
| `data-eta`（挂在 `.lp-stop`） | `idle` / `on` / `none` | 断言全景页报站三态（AC-42a/AC-46） |
| `data-kind`（挂在 `.lp-page`） | `bus` / `lrt` | 断言轻轨零报站请求（AC-42a） |

**已知坑（从项目记忆/代码注释继承）**

1. 地图色必须是 Token 里的**具体色值**，运行时 `readToken()` 读；`color-mix()` 在自定义属性里读不到 resolved 值（会拿到字面量，喂画布静默失效）。
2. `readToken` 参考 `nav-map-fit.ts`；不要在 `Polyline` 里直接写 hex。
3. 面板/浮层必须挂在 `.nav-map-wrap` **之外**（wrap 是层叠上下文，挂进去永远低于底部 chrome）。
4. 本项目**无全局 `box-sizing` 重置**（只在 `*` 里设了 margin/padding）⇒ 需要精确高度的地方（如 `.walkstep` 的 44px）必须显式 `box-sizing: border-box`，否则是内容盒高度。
5. 新增的高频 DSAT 调用 purpose 要排除熔断判定；步行指引不涉及 DSAT，但**若复用 `/api/nav/*` 子路径**，注意 `middleware.ts` 的 `PUBLIC_PREFIXES` 是 fail-closed。
6. `prefers-reduced-motion` 下 `is-spin` 必须显式关（现役 `.route-sheet__iconbtn` 已有先例，照抄）。

---

## 6. 本次明确不做（防止范围蔓延）

- 不做深色地图样式（AMap 无内置深色瓦片，接第三方样式属新工程，不进 v3.6.0）。
- 不改既有 5 档文案与色阶（只在其前插档 0）。
- 不改 `.route-stack`（平行四边形切角）—— 线路搜索结果标签是**新组件**，不复用也不替换它。
- 不重排 z-index 表（步行三态插在 69/70/73，全表其余不动）。
- **不给偏航做音效/震动**（主理人已裁决：偏航只做视觉——文案 + 颜色 + 「回到路线」按钮；全站至今无音频/振动能力，属新增面，本轮不做）。`WalkStep` 也**不预留**任何震动/音频/语音字段。

---

## 7. 自检

- [x] 零 emoji（全文与预览均为内联 SVG 图标；`.verify` 正则扫描 `emoji_hits=0`）
- [x] 零紫→粉渐变（本项目主色青花蓝 `#1b4d8f` + 澳门绿 `#0b6e4f`，无 Indigo/Pink）
- [x] 零硬编码色（组件内全 `var()`；唯一例外 `#fff` / `#000`，用于档 0 与深色反向）
- [x] 间距全 4px 整数倍（`--space-1`~`--space-6`）
- [x] 三态不靠单一颜色（色阶 + 字重 + 背景 + check 四通道）
- [x] 对比度逐条算式列出，不足者已给替代值（`--meta` → `--muted`）
- [x] `prefers-reduced-motion` 全覆盖（含**地图跟随改分段跳转**，PM §7）
- [x] 触摸目标 44×44（含伪元素外扩写法）
- [x] 无侧条纹强调、无渐变文字、无幽灵卡（1px 边框 + 大模糊同现）
- [x] 文案全部真实站名（殷皇子大馬路 / 亞美打利庇盧大馬路（新馬路）/ 議事亭前地 / 關閘總站 / 氹仔碼頭），无占位
- [x] **档 0 不可点**：无 `role="button"` / 无 `cursor:pointer` / 无 `tabindex`（AC-37）
- [x] **转向必须给文字**，箭头仅辅助且 `aria-hidden`（PM §7）
- [x] **报站三态同高 16px**，`idle` 不用骨架屏 ⇒ 列表零跳动（AC-42b / PM 明确）
- [x] **地图层级未越界**：步行 69/70/73 < 灰实 74 < 站点 90 < 钉 110/120 < 蓝点 128 < 车辆 130（R6）
- [x] `--map-fit-gap: 24px` 为**纯 px 数值**，`parseFloat` 可直取（架构硬要求）

---

## 8. 变更记录（本轮按 PM / 架构反馈的修订）

| # | 位置 | 改动 | 触发 |
|---|---|---|---|
| 1 | §2.2 | 当前步从"面板内大卡 `.walknow`"改为**顶部固定横幅 `.walkturn`**（地图上方），偏航提示并入横幅成为 `off` 态，不再叠两条 | AC-02「地图上方」+ 单浮层原则 |
| 2 | §2.1 | 入口从 44×44 图标键改为**文字按钮「步行指引」**；新增 AC-08a 展开骨架态（2 行固定 44px、无 shimmer、原位替换） | AC-01 / AC-08a |
| 3 | §1.4 / §2.5 | 档 0 由实心红改为琥珀（`--warn`）；去掉图标；确认文案 6 字 ~~（此项已被 #17 推翻，见下）~~ | AC-37「不用绿、琥珀类」（当时的 PM 口径） |
| 4 | §2.4 | 从"每行类型徽章"改为**分区结构**：分区标题 + 行内主题色徽章（线路编号）+ 副标题「查看全线站点」 | AC-40 口径微调 |
| 5 | §2.8（新） | 新增线路站点全景页规格 + 报站三态 | AC-42 / 42a / 42b / 46 |
| 6 | §2.9（新） | 6 项图标语义落点（4~5 新增 + 复用）；指出「线路标签底色块」不是图标 | PM 申请图标 |
| 7 | §2.10（新） | `data-nav-phase="walk"` 的 CSS 就位清单：只改 1 条选择器 | 架构提问 2 |
| 8 | §1.1 | 新增 `--map-fit-gap: 24px`（纯 px） | 架构提问 1 |
| 9 | §2.3 | 补「当前动作图层优先」不变式，确认步行 73 > 彩段 72 可接受 | 架构提问 3 |

### 第二批（架构契约锁定后）

| # | 位置 | 改动 | 触发 |
|---|---|---|---|
| 10 | §2.3 | 从"一条折线切三份"改为**三条独立 Polyline**：`donePath`（累积灰 z69）/ `aheadPath`（z70）/ `nowPath`（z73）；写明"重算不清空、灰线与新绿线不共线是正确行为" | 架构 §4 最终口径 |
| 11 | §2.3 细节 5 | 新增"列表按步级、地图按米级，两套进度不可互相推导" | 架构决策点 1 |
| 12 | §2.6 | 冷却判定从 `rides.every(lrt)` 改为 `refreshScope`（当前追踪腿 kind）；补"冷却禁止全局化"的纪律 | 架构决策点 3 |
| 13 | §2.9 | 新增 `turn` enum → 图标唯一映射表；明确「向左前方/靠左」统一归 `straight`（不加 `slight_*`），并给"隐藏图标只留文字"的一行逃生口 | 架构派生规则 |
| 14 | §2.5 | 新增边界：档 0 **只影响标签**，不得改变任何按钮可用性 | 主理人裁决 |
| 15 | §5 | 新增「数据契约消费表」；补「数字允许不变但绝不回跳」的抖动约束 | 架构 §3.3 锁定版 |
| 16 | §6 | 音效/震动改为**已裁决不做**（非"需评估"） | 主理人裁决 |
| 17 | §1.4 / §2.5 | 档 0 定案**实心红**（`--danger` + 白字 6.06:1）；琥珀方案移入 Backlog 并注明否决原因；删除原「一行回退开关」 | 主理人终裁 + 产品核代码（档 1 本是浅红底 ⇒ 琥珀会造成色相非单调） |
| 18 | §2.5 | 宽度按 **7 字**预留（107px），档 0 自身不设 `min-width`；`white-space: nowrap` 不截断不换行 | 主理人验收要求 |
