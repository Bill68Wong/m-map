/**
 * make-preview.mjs —— 生成「品牌定稿总览页」final/preview.html
 *  - 把各 SVG 资产**内联**进页面（这样 SVG 里的 var(--token) 能解析到站点 Token）
 *  - 页定位＝**品牌定稿总览（随生成器同步至现行资产）**：
 *      A 节（标志 / lockup / 六件套）引用**现行白底资产** app-icon-white/ +
 *      现役 lockup*.svg，随 make-brand.mjs 重跑同步；
 *      B（四底色候选，指 app-icon/color-candidates/）/ C（中文名提案）
 *      两节为**第五轮提案原貌**，属历史探索，非上线资产。定案见 INTEGRATE.md §8。
 * 运行：node docs/迭代-v215-20260925/02-logo/final/tools/make-preview.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const svg = (p) => fs.readFileSync(p, "utf8").replace(/<\?xml[^>]*\?>\s*/g, "");
/** 内联时把 id 前缀改写，避免多份 SVG 的 mask id 冲突 */
const inline = (p, prefix) =>
  svg(p)
    .replace(/\sid="([^"]+)"/g, (m, id) => ` id="${prefix}-${id}"`)
    .replace(/url\(#([^)]+)\)/g, (m, id) => `url(#${prefix}-${id})`);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ── B · 四底色候选 ───────────────────────────────────────────────────────── */
const CANDIDATES = [
  {
    key: "white",
    name: "① 白 / 浅底（站牌白 + 描边）",
    badge: "站牌语言",
    bg: "#fff",
    ink: "#0f1720",
    plate: "#ffffff",
    plateEdge: "#1b4d8f",
    routeOn: "#1b4d8f",
    routeBg: "#ffffff",
    pinOn: "#0b6e4f",
    pinBg: "#ffffff",
    pro: "与 App 内 `.nav-brand` 站牌白底＋青花蓝描边完全同源，品牌语言最连贯；白底让双色最纯，印刷/文档/浅色壁纸都稳。",
    con: "在浅色壁纸或浏览器浅色标签条上「没有边」，16px favicon 靠那圈蓝框撑辨识度，蓝框一细就发虚；白底图标天生缺「App 的实体感」。",
  },
  {
    key: "blue",
    name: "② 青花蓝底（推荐）",
    badge: "品牌主色",
    bg: "#1b4d8f",
    ink: "#ffffff",
    plate: "#1b4d8f",
    plateEdge: "rgba(255,255,255,.35)",
    routeOn: "#ffffff",
    routeBg: "#1b4d8f",
    pinOn: "#6dd58c",
    pinBg: "#1b4d8f",
    pro: "主色即底色，「站牌蓝」= 品牌记忆点；白路线在蓝底上 8.38:1，明暗对比最强，16px 仍一眼读出 M；绿色终点钉在蓝底上 4.61:1，双色语义完整保留。",
    con: "蓝色图标在系统里很常见（多款出行 App 都是蓝），独特性要靠 M 字形本身扛；深蓝壁纸上会「吃掉」一点边界。",
  },
  {
    key: "green",
    name: "③ 澳门绿底",
    badge: "在地色",
    bg: "#0b6e4f",
    ink: "#ffffff",
    plate: "#0b6e4f",
    plateEdge: "rgba(255,255,255,.35)",
    routeOn: "#ffffff",
    routeBg: "#0b6e4f",
    pinOn: "#f0b429",
    pinBg: "#0b6e4f",
    pro: "「澳门绿」最有在地感，和路牌/公园/轻轨视觉相亲；白路线 6.25:1 达标，气质稳、不刺眼。",
    con: "绿底把绿钉「吃掉」了 —— 终点钉必须换成琥珀金，等于**丢掉「绿＝到达」的品牌语义**（金钉 3.36:1 也只是勉强过图形门槛）；双色系统的记忆点被削弱。",
  },
  {
    key: "dark",
    name: "④ 深色底",
    badge: "深色模式",
    bg: "#111318",
    ink: "#e2e2e9",
    plate: "#111318",
    plateEdge: "rgba(255,255,255,.14)",
    routeOn: "#a8c7fa",
    routeBg: "#111318",
    pinOn: "#6dd58c",
    pinBg: "#111318",
    pro: "与深色 Token（`--accent #a8c7fa` / `--brand-green #6dd58c`）逐一对应，双色对比 10.8:1 / 10.2:1 全场最高；深夜通勤场景气质最好。",
    con: "黑底图标在深色壁纸 / 深色 Dock 上会「糊」成一个方块，辨识度反而最低；作为唯一图标太赌，只适合做深色模式备选。",
  },
];

/* ── C · 中文名提案 ───────────────────────────────────────────────────────── */
const NAMES = [
  {
    n: "顺路",
    pinyin: "shùn lù",
    type: "意象 · 承诺",
    rhythm: "去声 + 去声，两拍落地，短促好叫",
    idea: "把「路线」和「顺利」压进一个词：地图上是一条路，体感上是「一路顺」。",
    mood: "温润、日常、不炫技 —— 像一个用过十年的本地词，不是新造的品牌腔。",
    logo: "M 本身就是「一条路」；两站环是它的节拍，收笔那枚钉就是「顺到了」。",
    mmap: "M Map 是「图」（系统 / 能力），顺路是「用」（体感 / 承诺）；对外 M Map，对内顺路。",
    risk: "通用词，检索不占优；建议组合检索「顺路 M Map」。",
  },
  {
    n: "到站",
    pinyin: "dào zhàn",
    type: "写实 · 公交原生",
    rhythm: "去声 + 去声，干脆、通知感强",
    idea: "公交/轻轨里最原生的一句话 —— 报站、终点站、到站提醒，全在这个词里。",
    mood: "朴素、准确、有一点点报站广播的安心感；最不像「营销起名」。",
    logo: "钉＝终点＝「到站」，字面同义；两站环就是「站」，标志即名字。",
    mmap: "与 M Map 的关系最弱（无 M 音），靠副题「澳门巴士 · 实时导航」搭桥。",
    risk: "偏「公交」不偏「导航」，品牌想象空间偏窄；「到站」也更像一句提示而非名字。",
  },
  {
    n: "一路",
    pinyin: "yí lù",
    type: "意象 · 一笔到底",
    rhythm: "阴平 + 去声，舒展，适合做长一点的语气",
    idea: "「一路」既是「整条路线」，也是「一路顺风」的祝福；「一笔到底」正好是 logo 的握笔逻辑。",
    mood: "柔和、耐心、陪伴感；两个字留白多，好在图标/启动页上排字。",
    logo: "标志就是「一笔到底、收笔即钉」—— 把这句话缩成两个字。",
    mmap: "「一路 · M Map」做双行 lockup 很顺；英文 M Map 保留 M 的字母资产。",
    risk: "与「一路通」「一路发」等词容易混；单独出现语义偏虚。",
  },
  {
    n: "过海",
    pinyin: "guò hǎi",
    type: "在地 · 通勤现实",
    rhythm: "去声 + 上声，先压后扬，有画面",
    idea: "澳门人把「去氹仔/路环」叫过海 —— 每天跨越西湾/友谊大桥的通勤，就是这个产品的日常。",
    mood: "极在地、有故事、有一点浪漫；一听就知道「这是给澳门人的」。",
    logo: "路线从起点出发、跨过去、钉在对岸 —— 与「过桥 → 到达」的动作完全同构。",
    mmap: "需加副题才能接上 M Map；主名与英文名是「场景 ↔ 系统」的关系。",
    risk: "对非澳门用户（含大部分内地生）没有直接含义；也不覆盖「半岛内短途」。",
  },
  {
    n: "带路",
    pinyin: "dài lù",
    type: "拟人 · 本地朋友",
    rhythm: "去声 + 去声，动词起头，有服务姿态",
    idea: "不是冷冰冰的「导航」，而是「有个人在前面带你走」；把工具拟人成一个熟路的本地同学。",
    mood: "热情、可靠、有温度，和澳科大社群气质贴。",
    logo: "整条 M 就是「带路的那条线」，钉子落下的地方就是「带到」。",
    mmap: "「带路 · M Map」，中英同为动作+名词结构，气质一致。",
    risk: "「带路」在特定语境有负面联想，品牌公关需注意；也略口语。",
  },
  {
    n: "M 到",
    pinyin: "em dào",
    type: "双语口令 · 与 M Map 同源",
    rhythm: "单音节字母 + 去声，极短，像一声提示音",
    idea: "把品牌首字母当名字：M 到了。可读作「M 到」=「到达」，也可读作「em 到」= 一个现代极简代号。",
    mood: "年轻、利落、有科技感；和 Barlow 的字标极搭。",
    logo: "M 收笔即到达，钉一落 =「到」；名字就是标志的动作描述。",
    mmap: "与 M Map 共享 M，是最紧的母子品牌关系；「M 到 / M Map」并排读像一套系统。",
    risk: "过于极简，语义要靠品牌自己教会用户；中文母语者第一眼可能读不懂。",
  },
  {
    n: "澳图",
    pinyin: "ào tú",
    type: "写实 · 地图原生",
    rhythm: "去声 + 阳平，稳，像产品名",
    idea: "澳门 + 图（Map）：延续「XX 地图」的品类认知，又用一个字把范围钉死在澳门。",
    mood: "正式、可靠、工具感强；像一张随身带的地图。",
    logo: "钉在地图上的钉 —— 名字说的就是标志在做的事。",
    mmap: "「澳图 M Map」中英对读，品类一致（Map / 图），最好记的一对。",
    risk: "与「奥图」同音，易被误听/误搜；品类词做品牌，差异化不足。",
  },
];

const CURRENT = {
  name: "MUST登校",
  good: [
    "精准打中核心用户自我认同 —— 澳科大学生一看就懂「这是给我的」。",
    "「登校」有画面感：每日上学的那个动作，比「通勤」有温度。",
    "M 与 M Map 首字母共用，母子品牌关系天然成立。",
  ],
  bad: [
    "**把品牌绑死在两件事上**：澳科大（MUST）+ 上学（登校）。产品已经扩到「全澳导航 + 通勤 + 实时报站」，非 MUST 用户（其他高校、本地居民、游客）会觉得「这不是给我的」。",
    "**不是产品名，是活动名**：中文缩写 + 动作的构词，读起来像迎新活动/班会口号，缺少「工具类产品」的稳感。",
    "**中英不对位**：对外英文是 M Map（地图品类），中文是 MUST登校（校园场景），两套语义各说各话，lockup 里容易打架。",
    "覆盖面越广，这个名字的**获客损耗越大** —— 非科大的澳门通勤者第一眼就被筛掉了。",
  ],
  verdict:
    "**不建议直接删除，建议「降级为场景名」**：主品牌换成面向全澳的 2 字名（推荐「顺路」，备选「到站」/「M 到」），把「MUST登校」保留为**面向澳科大的活动/落地页副题**（迎新季地推、校园卡片、社团合作）。这样既保住核心用户的亲切感，又不挡非科大学生的门。",
};

/* ── 页面 ─────────────────────────────────────────────────────────────────── */
const mark = inline(path.join(ROOT, "mark.svg"), "m1");
const markThemeDark = inline(path.join(ROOT, "mark.svg"), "m1b");
const markDark = inline(path.join(ROOT, "mark-dark.svg"), "m2");
const markMono = inline(path.join(ROOT, "mark-mono.svg"), "m3");
const lock = inline(path.join(ROOT, "lockup.svg"), "l1");
const lockDark = inline(path.join(ROOT, "lockup-dark.svg"), "l2");
const at = (s, size) => s.replace('width="60" height="60"', `width="${size}" height="${size}"`);

const iconList = [
  ["icon-16.png", "16", "favicon（预圆角）", "icon-16.svg"],
  ["icon-32.png", "32", "favicon 2×", "icon-32.svg"],
  ["apple-touch-icon-180.png", "180", "apple-touch（满幅方角）", "apple-touch-icon-180.svg"],
  ["icon-192.png", "192", "PWA any", "icon-192.svg"],
  ["icon-512.png", "512", "PWA any", "icon-512.svg"],
  ["maskable-512.png", "512", "maskable（安全区 80%）", "maskable-512.svg"],
];

const iconCards = iconList
  .map(
    ([png, size, note, svgFile]) => `<figure class="iconCard">
      <div class="iconCard__img"><img src="./app-icon-white/${png}" alt="M Map 图标 ${size}px" width="${Math.min(
        Number(size),
        192
      )}"></div>
      <figcaption>
        <b class="mono">${size}px</b>
        <span>${note}</span>
        <code class="mono">app-icon-white/${svgFile}</code>
      </figcaption>
    </figure>`
  )
  .join("");

const candidateCards = CANDIDATES.map(
  (c) => `<article class="cand" style="--c-bg:${c.bg};--c-ink:${c.ink};--c-edge:${c.plateEdge};--c-route:${c.routeOn};--c-pin:${c.pinOn}">
    <div class="cand__stage">
      <img class="cand__512" src="./app-icon/color-candidates/${c.key}-icon-512.png" alt="${esc(
    c.name
  )} 512 效果">
      <div class="cand__mini">
        <img src="./app-icon/color-candidates/${c.key}-icon-192.png" alt="" width="72">
        <img src="./app-icon/color-candidates/${c.key}-icon-32.png" alt="" width="32">
        <img src="./app-icon/color-candidates/${c.key}-icon-16.png" alt="" width="16">
      </div>
    </div>
    <h3>${esc(c.name)} <span class="tag">${esc(c.badge)}</span></h3>
    <p class="cand__metric mono">
      路线/底 ${c.routeOn} on ${c.routeBg} = ${ratioOf(c.routeOn, c.routeBg)}　·　钉/底 ${c.pinOn} on ${
    c.pinBg
  } = ${ratioOf(c.pinOn, c.pinBg)}
    </p>
    <p class="cand__pro"><b>优点</b>${esc(c.pro)}</p>
    <p class="cand__con"><b>代价</b>${esc(c.con)}</p>
  </article>`
).join("");

const nameRows = NAMES.map(
  (x) => `<tr>
    <th scope="row"><b>${esc(x.n)}</b><span class="mono py">${esc(x.pinyin)}</span></th>
    <td><span class="tag">${esc(x.type)}</span></td>
    <td><b>构思</b>${esc(x.idea)}</td>
    <td><b>读音节奏</b>${esc(x.rhythm)}<br><b>气质</b>${esc(x.mood)}</td>
    <td><b>与标志（路线 M → 钉）</b>${esc(x.logo)}<br><b>与 M Map</b>${esc(x.mmap)}</td>
    <td class="risk">${esc(x.risk)}</td>
  </tr>`
).join("");

const html = `<!doctype html>
<html lang="zh-Hans">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>M Map · 品牌定稿总览（第五轮几何 → 第六轮白底定稿）— v3.0.0</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
  /* 与 src/app/globals.css 同源（此处仅作预览样本，不新增任何硬编码设计值） */
  :root{
    --bg:#f2f4f0; --surface:#fff; --surface-2:#eaece7;
    --fg:#0f1720; --fg-2:#3a424e; --muted:#5a6472; --meta:#6e7684;
    --border:#dcdcdf; --border-2:#c7cbd1; --border-strong:#1b4d8f;
    --accent:#1b4d8f; --accent-deep:#16406f; --accent-soft:#e6ecf6;
    --accent-dk:#a8c7fa; --brand-green:#0b6e4f; --brand-green-dk:#6dd58c;
    --plate-dark:#14161c;
    /* 品牌标志专用 Token（与 final/tokens-brand.css 逐字同源）
       注：本预览页是纯浅色文档页，故**故意不**加 prefers-color-scheme 分支 ——
       真实站点里 --brand-route/--brand-pin 会随主题切换（见 tokens-brand.css）。
       第二格用就地覆盖的方式演示「同一个 mark.svg 进深色主题 → 自动变亮」。 */
    --brand-route:#1b4d8f; --brand-pin:#0b6e4f; --brand-fg:#0f1720; --brand-muted:#5a6472;
    --brand-route-on-dark:#a8c7fa; --brand-pin-on-dark:#6dd58c;
    --brand-fg-on-dark:#e2e2e9; --brand-muted-on-dark:#c4c6d0;
    --font-display:"Barlow","Noto Sans SC",system-ui,-apple-system,"PingFang SC",sans-serif;
    --font-body:"Barlow","Noto Sans SC",system-ui,-apple-system,"PingFang SC",sans-serif;
    --font-mono:"JetBrains Mono","Barlow",ui-monospace,monospace;
    --radius-chip:6px; --radius-card:10px; --radius-sheet:14px;
    --tracking-label:.09em; --tracking-display:-.02em; --tracking-title:-.01em;
    --shadow-hard:3px 3px 0 0 var(--border-strong);
    --shadow-hard-sm:2px 2px 0 0 var(--border-strong);
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0; background:var(--bg); color:var(--fg);
    font-family:var(--font-body); font-size:15px; line-height:1.55; letter-spacing:0;
  }
  .mono{font-family:var(--font-mono); font-variant-numeric:tabular-nums; letter-spacing:.01em}
  .wrap{max-width:1080px; margin:0 auto; padding:40px 24px 80px}
  header.page{border-bottom:1px solid var(--border-2); padding-bottom:20px; margin-bottom:8px}
  .kicker{
    font-family:var(--font-mono); font-size:11px; letter-spacing:var(--tracking-label);
    text-transform:uppercase; color:var(--meta); margin:0 0 10px
  }
  .sync{
    font-size:12.5px; line-height:1.55; color:var(--fg-2); background:var(--accent-soft);
    border:1px solid var(--border); border-radius:var(--radius-chip);
    padding:8px 12px; margin:0 0 14px; max-width:78ch
  }
  .sync b{color:var(--accent-deep)}
  h1{font-family:var(--font-display); font-size:34px; line-height:1.1; letter-spacing:var(--tracking-display); margin:0 0 10px; font-weight:700}
  h1 small{display:block; font-size:15px; font-weight:500; letter-spacing:0; color:var(--muted); margin-top:8px}
  h2{font-family:var(--font-display); font-size:22px; letter-spacing:var(--tracking-title); margin:0 0 6px; font-weight:700}
  h3{font-size:15px; font-weight:600; margin:0 0 8px}
  section{margin-top:44px; padding-top:32px; border-top:1px solid var(--border)}
  .secNo{font-family:var(--font-mono); font-size:11px; letter-spacing:var(--tracking-label); color:var(--border-strong); text-transform:uppercase}
  .lead{color:var(--fg-2); margin:0 0 20px; max-width:74ch}
  .grid2{display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px}
  .grid3{display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px}
  .plate{
    background:var(--surface); border:var(--frame,1.5px) solid var(--border); border-radius:var(--radius-card);
    padding:20px; display:flex; flex-direction:column; gap:12px; align-items:flex-start
  }
  .plate--frame{border-color:var(--border-strong)}
  .plate--dark{background:var(--plate-dark); border-color:var(--plate-dark); color:#e2e2e9}
  .plate--mono{background:linear-gradient(0deg,#fff,#fff)}
  .plate__cap{font-size:12px; color:var(--muted); letter-spacing:.02em}
  .plate--dark .plate__cap{color:#c4c6d0}
  .markBox img,.markBox svg{display:block}
  figure{margin:0}
  .checks{list-style:none; margin:0; padding:0; display:flex; flex-wrap:wrap; gap:6px}
  .checks li{
    font-family:var(--font-mono); font-size:11px; color:var(--fg-2);
    border:1px solid var(--border-2); border-radius:var(--radius-chip); padding:3px 7px; background:var(--surface)
  }
  .iconCard{background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-card); padding:16px; display:flex; flex-direction:column; gap:12px}
  .iconCard__img{display:flex; align-items:center; justify-content:center; min-height:120px;
    background-image:linear-gradient(45deg,#e9ebe6 25%,transparent 25%),linear-gradient(-45deg,#e9ebe6 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e9ebe6 75%),linear-gradient(-45deg,transparent 75%,#e9ebe6 75%);
    background-size:12px 12px; background-position:0 0,0 6px,6px -6px,-6px 0; border-radius:var(--radius-chip)}
  .iconCard img{display:block}
  .iconCard figcaption{display:flex; flex-direction:column; gap:2px; font-size:12px; color:var(--muted)}
  .iconCard figcaption b{color:var(--fg); font-size:13px}
  .iconCard code{font-size:11px; color:var(--meta)}
  .realSize{display:flex; align-items:flex-end; gap:16px; padding:16px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-card)}
  .realSize img{display:block; image-rendering:auto}
  .maskWrap{position:relative; display:inline-block}
  .maskWrap::after{
    content:""; position:absolute; inset:0; margin:auto; width:80%; height:80%; border-radius:50%;
    border:1.5px dashed rgba(255,255,255,.75); pointer-events:none
  }
  .cand{background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-card); padding:20px; display:flex; flex-direction:column; gap:10px}
  .cand__stage{display:flex; align-items:flex-end; gap:14px; background:var(--surface-2); border-radius:var(--radius-chip); padding:14px; min-height:180px}
  .cand__512{display:block; width:150px; height:150px}
  .cand__mini{display:flex; align-items:flex-end; gap:8px}
  .cand__mini img{display:block}
  .cand__metric{font-size:11px; color:var(--meta); margin:0; line-height:1.5}
  .cand p{margin:0; font-size:13px; color:var(--fg-2)}
  .cand p b{display:block; font-family:var(--font-mono); font-size:11px; letter-spacing:var(--tracking-label); text-transform:uppercase; color:var(--meta); margin-bottom:3px}
  .cand__con b{color:var(--border-strong)}
  .tag{display:inline-block; font-family:var(--font-mono); font-size:10px; letter-spacing:var(--tracking-label); text-transform:uppercase;
    border:1px solid var(--border-2); border-radius:999px; padding:2px 7px; color:var(--muted); vertical-align:middle}
  .rec{background:var(--plate-dark); color:#e2e2e9; border-radius:var(--radius-card); padding:20px; margin-top:16px}
  .rec h3{color:#fff}
  .rec p{margin:0 0 8px; color:#d0d6e0; font-size:14px}
  .rec b{color:#fff}
  table{border-collapse:collapse; width:100%; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius-card); overflow:hidden}
  caption{text-align:left; font-size:12px; color:var(--muted); padding:0 0 8px}
  th,td{border-bottom:1px solid var(--border); padding:12px; text-align:left; vertical-align:top; font-size:13px; color:var(--fg-2)}
  thead th{background:var(--accent-soft); color:var(--accent-deep); font-family:var(--font-mono); font-size:11px; letter-spacing:var(--tracking-label); text-transform:uppercase}
  tbody th{background:#fbfcfb; white-space:nowrap; color:var(--fg)}
  tbody th b{display:block; font-size:17px; letter-spacing:var(--tracking-title)}
  td b{display:block; font-family:var(--font-mono); font-size:10px; letter-spacing:var(--tracking-label); text-transform:uppercase; color:var(--meta); margin-bottom:2px}
  .py{font-size:11px; color:var(--meta)}
  .risk{font-size:12px; color:var(--fg-2)}
  .verdictGrid{display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin-top:16px}
  .vList{background:var(--surface); border:1px solid var(--border); border-left:none; border-radius:var(--radius-card); padding:18px}
  .vList h4{margin:0 0 10px; font-family:var(--font-mono); font-size:11px; letter-spacing:var(--tracking-label); text-transform:uppercase; color:var(--meta)}
  .vList ul{margin:0; padding-left:18px; display:flex; flex-direction:column; gap:8px; font-size:13px; color:var(--fg-2)}
  .vList--good{border-color:var(--brand-green)}
  .vList--bad{border-color:var(--border-strong)}
  .vList--bad strong{color:var(--fg)}
  .files{font-size:12px; color:var(--fg-2)}
  .files ul{padding-left:18px; margin:8px 0 0; display:flex; flex-direction:column; gap:4px}
  code{font-family:var(--font-mono); background:var(--surface-2); border-radius:4px; padding:1px 5px; font-size:12px}
  footer{margin-top:56px; padding-top:20px; border-top:1px solid var(--border-2); font-size:12px; color:var(--meta)}
  @media (max-width:820px){
    .grid2,.grid3,.verdictGrid{grid-template-columns:1fr}
    table{display:block; overflow-x:auto; white-space:nowrap}
    h1{font-size:26px}
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="page">
    <p class="kicker">M Map · v3.0.0 · 定稿总览 · 资产随生成器同步至现行（第六轮白底）</p>
    <p class="sync"><b>同步说明：</b>本页 A 节（标志 / lockup / 六件套）随 <code>make-brand.mjs</code> 同步至 <b>现行白底版本</b>（第六轮：白底「站牌」六件套 + lockup「澳搭車」）；<b>B 节（四底色候选）/ C 节（中文名提案）为第五轮提案原貌</b>，属历史探索、非上线资产。定案见 <code>INTEGRATE.md §8</code>。</p>
    <h1>品牌定稿总览
      <small>几何定稿于第五轮「短钉 · 两站 · 无缝」（用户第四轮拍板组合 4-2）；现行资产为第六轮白底版——六件套与 lockup 均以本页所列为准。</small>
    </h1>
    <ul class="checks">
      <li>DESIGN_VARIANCE 6</li><li>MOTION_INTENSITY 2</li><li>VISUAL_DENSITY 4</li>
      <li>寄存器 Brand</li><li>零 emoji</li><li>零紫粉渐变</li><li>颜色全走 Token</li>
    </ul>
  </header>

  <section id="r5-mark">
    <p class="secNo">A-1</p>
    <h2>标志本体 · 三版</h2>
    <p class="lead">同一份几何四种摆法。几何＝第四轮 4-2 的<b>逐字节原样</b>，只做了「内容居中」的 viewBox 包装（左右余量 5.15 / 上下 7.15，完全对称）。站点环与钉帽白点改为<b>真镂空</b>（SVG mask）—— 三种底色下都不会露白圈，也不再依赖底色。</p>
    <p class="lead"><b>颜色不借用 <code>--accent</code></b>（借用会出事：深底版若写 <code>var(--accent, …)</code>，在浅色主题页面里会被解析成青花蓝，深底版当场失效）。改走两组品牌专用 Token：<code>--brand-route / --brand-pin / --brand-fg / --brand-muted</code>（<b>随主题</b>切换，见 <code>tokens-brand.css</code>）与 <code>--brand-*-on-dark</code>（<b>固定深底</b>，永远亮色）。</p>
    <div class="grid2">
      <div class="plate plate--frame markBox">
        <div style="width:120px;height:120px">${at(mark, 120)}</div>
        <span class="plate__cap">mark.svg · 浅色主题（--brand-route / --brand-pin）</span>
      </div>
      <div class="plate plate--dark markBox" style="--brand-route:#a8c7fa;--brand-pin:#6dd58c">
        <div style="width:120px;height:120px">${at(markThemeDark, 120)}</div>
        <span class="plate__cap">mark.svg · <b>同一个文件</b>放进深色主题 → 自动变亮蓝 / 亮绿（随主题）</span>
      </div>
      <div class="plate plate--dark markBox">
        <div style="width:120px;height:120px">${at(markDark, 120)}</div>
        <span class="plate__cap">mark-dark.svg · 固定深底（--brand-route-on-dark / --brand-pin-on-dark，不受主题影响）</span>
      </div>
      <div class="plate plate--mono markBox">
        <div style="width:120px;height:120px;color:var(--accent-deep)">${at(markMono, 120)}</div>
        <span class="plate__cap">mark-mono.svg · currentColor（此处给 --accent-deep；印章 / 烫印 / 单色印刷）</span>
      </div>
    </div>
  </section>

  <section id="r5-lockup">
    <p class="secNo">A-2</p>
    <h2>横排 lockup</h2>
    <p class="lead">左标志 + 右双行字标：上行 <b>M Map</b>（Barlow 700 / 30 / -0.015em，<code>textLength=80</code> 锁宽，缺字体也不撑破视框），下行中文名（Noto Sans SC 500 / 15 / 0.02em）。中文名已定「澳搭車」（2026-09-25 定稿），本页两格随现役 <code>lockup.svg</code> 同步。视框 156×64，右侧留 10 单位余量。浅/深两版同样走品牌 Token（深版用固定深底色，不随主题漂移）。</p>
    <div class="grid2">
      <div class="plate plate--frame">${lock}</div>
      <div class="plate plate--dark">${lockDark}</div>
    </div>
  </section>

  <section id="r5-icons">
    <p class="secNo">A-3</p>
    <h2>App 图标 / favicon 全套</h2>
    <p class="lead">六件套一次出齐。圆角与安全区按平台规矩分开：<b>favicon 与 PWA-any 预圆角</b>（浏览器/安装面板不给遮罩），<b>apple-touch 与 maskable 满幅方角</b>（由系统自己切形状）；maskable 内容压在中央 80% 安全圆内（最大对角半径 179.8–179.9px（断言/探针两口径）/ 可用 204.8px）。</p>
    <div class="grid3">${iconCards}</div>
    <div style="margin-top:16px" class="grid2">
      <div class="realSize">
        <span class="mono" style="font-size:11px;color:var(--meta);align-self:center">真实尺寸</span>
        <img src="./app-icon-white/icon-16.png" width="16" height="16" alt="16px">
        <img src="./app-icon-white/icon-32.png" width="32" height="32" alt="32px">
        <img src="./app-icon-white/icon-192.png" width="48" height="48" alt="缩小到 48px 看">
      </div>
      <div class="realSize">
        <span class="mono" style="font-size:11px;color:var(--meta);align-self:center">maskable 安全区</span>
        <span class="maskWrap"><img src="./app-icon-white/maskable-512.png" width="140" height="140" alt="maskable 512"></span>
        <span style="font-size:12px;color:var(--muted);align-self:center">虚线＝80% 安全圆：任何系统切形都不会切到 M 与钉</span>
      </div>
    </div>
  </section>

  <section id="r5-colors">
    <p class="secNo">B</p>
    <h2>App 图标底色怎么定？四个候选</h2>
    <p class="lead">用户问「现在做的是白底，图标颜色怎么安排」。四个候选都用<b>同一枚定稿 mark</b>，只换底与配色；每格给 512 效果 + 192/32/16 三档缩略 + 对比度实测 + 一句话优劣。门槛：图形类 ≥3:1，正文类 ≥4.5:1。</p>
    <div class="grid2">${candidateCards}</div>
    <div class="rec">
      <h3>推荐：② 青花蓝底（主）+ ④ 深色底（深色模式备选）+ ① 白底（App 内 / 印刷 / 分享卡）</h3>
      <p><b>为什么是 ②：</b>① 白路线 / 蓝底 <b>8.38:1</b> 是四个候选里最高的图形对比，16px favicon 仍能一眼读出 M；② 蓝＝「站牌蓝」＝品牌主色，图标即品牌记忆点；③ 绿钉在蓝底上 <b>4.61:1</b> 达标 ⇒ <b>品牌双色语义完整保留</b>（这是 ③ 澳门绿底做不到的：绿底会把绿钉吃掉，只好换成金钉，等于放弃「绿＝到达」）。</p>
      <p><b>②的代价与对冲：</b>蓝色图标在出行品类里很常见，独特性靠 M 字形自己扛 —— 所以图标里<b>不留任何文字与装饰</b>，只放 mark，让「路线 M + 终点钉」的剪影成为唯一识别符。</p>
      <p><b>落地策略：</b>站点只登记 <b>②</b> 一套（manifest / apple-touch / favicon 全部指向它）；<b>①</b> 用作 App 内品牌位与分享卡（与 <code>.nav-brand</code> 站牌同源）；<b>④</b> 保留为深色模式 PWA 备选，暂不上线。切换底色＝改 <code>make-brand.mjs</code> 里 <code>PALETTES</code> 一行后重跑。</p>
    </div>
  </section>

  <section id="r5-names">
    <p class="secNo">C</p>
    <h2>中文名提案（7 选 1）</h2>
    <p class="lead">约束：① 面向「澳门通勤 + 全澳导航」，不能把品牌锁死在单一学校/单一人群；② 核心用户是澳科大（MUST）学生 —— <b>大部分是内地生</b>，所以纯粤语词（如「过海」「到埗」）虽有在地感，但要计入理解成本；③ 要与「路线 M → 终点钉」的标志和英文名 M Map 有呼应；④ 2 字优先（好叫、好排、icon 下不挤）。</p>
    <table>
      <caption>读音节奏 / 气质 / 与标志和 M Map 的呼应 / 风险，逐项列明。</caption>
      <thead>
        <tr><th>候选</th><th>类型</th><th>构思 · 来源</th><th>读音节奏 · 气质</th><th>与标志 / 与 M Map</th><th>风险</th></tr>
      </thead>
      <tbody>${nameRows}</tbody>
    </table>

    <h2 style="margin-top:36px">旧名「MUST登校」评估（第五轮）</h2>
    <p class="lead">结论先说：<b>不删除，降级为「场景名」</b>。</p>
    <div class="verdictGrid">
      <div class="vList vList--good">
        <h4>保留它的理由</h4>
        <ul>${CURRENT.good.map((g) => `<li>${g}</li>`).join("")}</ul>
      </div>
      <div class="vList vList--bad">
        <h4>不能当主名的理由</h4>
        <ul>${CURRENT.bad.map((b) => `<li>${b.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</li>`).join("")}</ul>
      </div>
    </div>
    <div class="rec" style="background:var(--accent-deep)">
      <h3>最终建议</h3>
      <p>${CURRENT.verdict.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")}</p>
      <p style="margin-bottom:0"><b>主名首选「顺路」</b>（温润、通用、与「路线」同源，中英组合「顺路 · M Map」稳）；<b>次选「到站」</b>（公交原生、最直白）或 <b>「M 到」</b>（与 M Map 同源、最年轻）。锁名已于第六轮落地为「澳搭車」—— <code>final/lockup.svg</code> / <code>lockup-dark.svg</code> 同路径覆盖。</p>
    </div>
  </section>

  <footer>
    <p>产出目录：<code>docs/迭代-v215-20260925/02-logo/final/</code>　·　资产生成器：<code>final/tools/make-brand.mjs</code>　·　像素自检：<code>.verify/check-public-icons.mjs</code></p>
    <p>本页为评审样本，颜色与 src/app/globals.css 同源；「四底色候选」为探索性配色（若选定需登记为 Token）。</p>
  </footer>
</div>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, "preview.html"), html, "utf8");
console.log("[OK] preview.html 已生成：", path.join(ROOT, "preview.html"), `(${(html.length / 1024).toFixed(1)} KB)`);

/* ── WCAG 对比度（画布内联版） ────────────────────────────────────────────── */
function ratioOf(a, b) {
  const hex = (h) => {
    h = h.replace("#", "");
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  };
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = (h) => {
    const [r, g, b] = hex(h).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return ((x + 0.05) / (y + 0.05)).toFixed(2) + ":1";
}
