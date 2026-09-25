/**
 * make-brand.mjs —— M Map 品牌「定稿」资产生成器（第五轮）
 * ---------------------------------------------------------------------------
 * 输入：第四轮用户拍板的几何 —— 「短钉 · 两站 · 无缝」（logo-r4-2st-join.svg）
 *      几何**逐字节未改**（只做刚体平移 / 缩放包装），保证与已批准的形状一致。
 * 产出：
 *   · mark.svg / mark-dark.svg / mark-mono.svg          （标志本体三版）
 *   · lockup.svg / lockup-dark.svg                      （横排：标志 + 字标 M Map + 中文名「澳搭車」）
 *   · app-icon/{icon-16,icon-32,apple-touch-icon-180,icon-192,icon-512,maskable-512}.{svg,png}   （蓝底 · 第五轮存档）
 *   · app-icon-white/{同上 6 件}.{svg,png}               （白底「站牌」· 第六轮上线件）
 *   · app-icon/icon-rounded-512.png                     （额外：App 内展示 / OG 用）
 *   · app-icon/color-candidates/*.{svg,png}             （B · 四种底色候选 512 效果）
 * 运行：node docs/迭代-v215-20260925/02-logo/final/tools/make-brand.mjs
 * 依赖：sharp（项目 node_modules 已装）
 *
 * 注意：颜色一律走 `var(--token, #兜底)`：兜底值仅在「脱离站点、独立打开文件」时生效。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // final/
const ICON_DIR = path.join(ROOT, "app-icon");
const CAND_DIR = path.join(ICON_DIR, "color-candidates");
const WHITE_DIR = path.join(ROOT, "app-icon-white"); // 第六轮：白底「站牌」六件套（替换线上图标）
fs.mkdirSync(ICON_DIR, { recursive: true });
fs.mkdirSync(CAND_DIR, { recursive: true });
fs.mkdirSync(WHITE_DIR, { recursive: true });

const require = createRequire(import.meta.url);
const sharp = require("sharp");

/* ═══════════════════════════════════════════════════════════════════════════
   1. 几何常量 —— 全部来自第四轮 4-2（短钉 · 两站 · 无缝），一字未动
   ═══════════════════════════════════════════════════════════════════════════ */
const G = {
  route: "M12 48 L12 16 L30 34 L48 16", // 青花蓝路线走成 M，右端直连钉帽（无缝）
  pin: "M40.29 18.13 L48 46 L55.71 18.13 A8 8 0 1 0 40.29 18.13 Z", // 短钉，钉尖 y=46
  stations: [
    [12, 48], // ① 起笔点
    [30, 34], // ③ 中间折点（换乘）
  ],
  dot: [48, 16], // 钉帽圆心
  stroke: 6.5, // 路线描边
  ringR: 4.6, // 站点环外半径
  ringW: 2.2, // 站点环描边
  holeR: 3.9, // 站点「挖空」半径（> stroke/2=3.25，让路线干净地断在环内）
  dotR: 2.7, // 钉帽白点（挖空）
  // 内容外框（含描边）—— 供居中换算；viewBox 见 box
  content: { x0: 6.3, y0: 8, x1: 56, y1: 53.7, cx: 31.15, cy: 30.85, w: 49.7, h: 45.7 },
  box: "1.15 0.85 60 60", // 内容居中的正方 viewBox（左右余量 5.15 / 上下 7.15，完全对称）
  unit: 64, // 挖空 mask 的坐标域
};

/* ═══════════════════════════════════════════════════════════════════════════
   2. 品牌色板 —— 走**品牌专用 Token**（不借用 --accent / --fg）
   ───────────────────────────────────────────────────────────────────────────
   为什么不用 --accent：
     mark-dark.svg 若写 var(--accent, #a8c7fa)，在**浅色主题页面**里 --accent 会解析成
     #1b4d8f ⇒ 深底版被染成浅色，视觉失效（本轮首次内联时已复现该 bug）。
   故拆成两组、语义明确：
     · 随主题：--brand-route / --brand-pin / --brand-fg / --brand-muted
               （在 tokens-brand.css 里跟随深浅主题切换；未登记时兜底＝浅色值）
     · 固定深底：--brand-*-on-dark  —— 永远亮色，不受主题影响
   ═══════════════════════════════════════════════════════════════════════════ */
const C = {
  routeLight: "var(--brand-route, #1b4d8f)", // 青花蓝
  routeDark: "var(--brand-route-on-dark, #a8c7fa)", // 亮蓝（固定深底）
  pinLight: "var(--brand-pin, #0b6e4f)", // 澳门绿
  pinDark: "var(--brand-pin-on-dark, #6dd58c)", // 亮绿（固定深底）
  fgLight: "var(--brand-fg, #0f1720)",
  fgDark: "var(--brand-fg-on-dark, #e2e2e9)",
  mutedLight: "var(--brand-muted, #5a6472)",
  mutedDark: "var(--brand-muted-on-dark, #c4c6d0)",
};

/* ═══════════════════════════════════════════════════════════════════════════
   3. 片段构造
   ═══════════════════════════════════════════════════════════════════════════ */
function holeMask(id, { stations = G.stations, dot = G.dot } = {}) {
  return `<defs>
    <mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${G.unit}" height="${G.unit}">
      <rect x="0" y="0" width="${G.unit}" height="${G.unit}" fill="#fff"/>
      ${stations.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${G.holeR}" fill="#000"/>`).join("")}
      <circle cx="${dot[0]}" cy="${dot[1]}" r="${G.dotR}" fill="#000"/>
    </mask>
  </defs>`;
}

/** 标志本体（可指定 id / 三色 / 是否挖空 / viewBox） */
function markBody(id, { route, pin, ring, box = G.box, size = null }) {
  const rings = G.stations
    .map(
      ([x, y]) =>
        `<circle cx="${x}" cy="${y}" r="${G.ringR}" fill="none" stroke="${ring}" stroke-width="${G.ringW}"/>`
    )
    .join("");
  const canvas =
    box === G.box ? G.unit : Math.max(G.unit, Number(box.split(" ")[2]) || G.unit);
  return {
    defs: holeMask(id),
    inner: `<g mask="url(#${id})">
      <path d="${G.route}" fill="none" stroke="${route}" stroke-width="${G.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${G.pin}" fill="${pin}"/>
    </g>
    ${rings}`,
    size,
    canvas,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. 标志三版 + 横排
   ═══════════════════════════════════════════════════════════════════════════ */
function writeMark(file, { id, route, pin, ring, label, title, desc }) {
  const b = markBody(id, { route, pin, ring });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${G.box}" width="60" height="60" role="img" aria-label="${label}">
  <title>${title}</title>
  <desc>${desc}</desc>
  ${b.defs}
  ${b.inner}
</svg>
`;
  fs.writeFileSync(path.join(ROOT, file), svg, "utf8");
  return svg;
}

const GEO_NOTE = "几何＝第四轮 4-2『短钉 · 两站 · 无缝』；左端两站环＝起笔点/折点，右端路线直连澳门绿终点钉。";

writeMark("mark.svg", {
  id: "mm-hole-mark",
  route: C.routeLight,
  pin: C.pinLight,
  ring: C.routeLight,
  label: "M Map 标志",
  title: "M Map · 标志（定稿 · 浅底）",
  desc: `青花蓝路线走成字母 M。${GEO_NOTE}`,
});

writeMark("mark-dark.svg", {
  id: "mm-hole-mark-dark",
  route: C.routeDark,
  pin: C.pinDark,
  ring: C.routeDark,
  label: "M Map 标志（深色底）",
  title: "M Map · 标志（定稿 · 深底）",
  desc: `深色场景版：青花蓝→亮蓝 #a8c7fa，澳门绿→亮绿 #6dd58c。${GEO_NOTE}`,
});

writeMark("mark-mono.svg", {
  id: "mm-hole-mark-mono",
  route: "currentColor",
  pin: "currentColor",
  ring: "currentColor",
  label: "M Map 标志（单色）",
  title: "M Map · 标志（定稿 · 单色）",
  desc: `单色版：全部 currentColor，站点环与钉帽白点以镂空呈现，任意底色可用（印章 / 烫印 / 印刷）。${GEO_NOTE}`,
});

/* ── 品牌专用 Token（只增不改；追加到 src/app/globals.css 末尾） ───────────── */
fs.writeFileSync(
  path.join(ROOT, "tokens-brand.css"),
  `/* ============================================================================
   M Map · 品牌标志专用 Token（第五轮）——「只增不改」，不动任何既有 Token
   落点：src/app/globals.css 末尾
   用途：让 public/brand/*.svg 里的 var() 有真值；未登记时 SVG 内兜底值仍可独立渲染。
   ────────────────────────────────────────────────────────────────────────── */
:root {
  /* 随主题（默认＝浅色值） */
  --brand-route: #1b4d8f;  /* 青花蓝 · 路线 */
  --brand-pin:   #0b6e4f;  /* 澳门绿 · 终点钉 */
  --brand-fg:    #0f1720;  /* 横排字标主色 */
  --brand-muted: #5a6472;  /* 横排中文名副色 */

  /* 固定深底（永远亮色，**不**随主题切换）—— 供 mark-dark.svg / lockup-dark.svg 使用 */
  --brand-route-on-dark: #a8c7fa;
  --brand-pin-on-dark:   #6dd58c;
  --brand-fg-on-dark:    #e2e2e9;
  --brand-muted-on-dark: #c4c6d0;
}

@media (prefers-color-scheme: dark) {
  :root {
    --brand-route: #a8c7fa;
    --brand-pin:   #6dd58c;
    --brand-fg:    #e2e2e9;
    --brand-muted: #c4c6d0;
  }
}
`,
  "utf8"
);

/* ── 横排 lockup ─────────────────────────────────────────────────────────────
   中文名定稿（第六轮）：**澳搭車**（用户/team-lead 拍板）。只动本函数 cn 一处即可换名；
   mark*.svg 不含中文名，不受影响。 */
function lockup({ file, holeId, route, pin, fg, muted, label, title, cn = "澳搭車" }) {
  const b = markBody(holeId, { route, pin, ring: route });
  // 英文行用 textLength="80" 锁宽 → 字体缺失时也不会撑破视框（自然宽 79.94 ≈ 80）
  // viewBox 宽 = 66(起笔) + 80(英文) + 10(余量) = 156
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 156 64" width="156" height="64" role="img" aria-label="${label}">
  <title>${title}</title>
  <desc>横排组合：标志 + 英文名 M Map + 中文名「澳搭車」。</desc>
  ${b.defs}
  <g transform="translate(4 8) scale(0.75)">
    ${b.inner}
  </g>
  <text x="66" y="31" font-family="var(--font-display, &quot;Barlow&quot;, &quot;Noto Sans SC&quot;, sans-serif)"
        font-size="30" font-weight="700" letter-spacing="-0.015em" textLength="80" lengthAdjust="spacing"
        fill="${fg}">M Map</text>
  <text x="66" y="52" font-family="&quot;Noto Sans SC&quot;, var(--font-body, sans-serif)"
        font-size="15" font-weight="500" letter-spacing="0.02em" fill="${muted}">${cn}</text>
</svg>
`;
  fs.writeFileSync(path.join(ROOT, file), svg, "utf8");
  return svg;
}

lockup({
  file: "lockup.svg",
  holeId: "mm-hole-lockup",
  route: C.routeLight,
  pin: C.pinLight,
  fg: C.fgLight,
  muted: C.mutedLight,
  label: "M Map 澳搭車 横排标志",
  title: "M Map · 澳搭車 · 横排组合（浅底）",
});
lockup({
  file: "lockup-dark.svg",
  holeId: "mm-hole-lockup-dark",
  route: C.routeDark,
  pin: C.pinDark,
  fg: C.fgDark,
  muted: C.mutedDark,
  label: "M Map 澳搭車 横排标志（深色底）",
  title: "M Map · 澳搭車 · 横排组合（深底）",
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. App 图标 / favicon
   ═══════════════════════════════════════════════════════════════════════════ */
const PALETTES = {
  white: {
    key: "white",
    name: "白/浅底（站牌）",
    bg: "#ffffff",
    frame: "#1b4d8f",
    route: "#1b4d8f",
    pin: "#0b6e4f",
    ring: "#1b4d8f",
    badge: "#f2f4f0",
  },
  blue: {
    key: "blue",
    name: "青花蓝底",
    bg: "#1b4d8f",
    frame: null,
    route: "#ffffff",
    pin: "#6dd58c",
    ring: "#ffffff",
    badge: "#1b4d8f",
  },
  green: {
    key: "green",
    name: "澳门绿底",
    bg: "#0b6e4f",
    frame: null,
    route: "#ffffff",
    pin: "#f0b429",
    ring: "#ffffff",
    badge: "#0b6e4f",
  },
  dark: {
    key: "dark",
    name: "深色底",
    bg: "#111318",
    frame: null,
    route: "#a8c7fa",
    pin: "#6dd58c",
    ring: "#a8c7fa",
    badge: "#111318",
  },
};

/**
 * 生成一枚 App 图标 SVG
 * @param S        画布边长（px）
 * @param p        色板
 * @param opts.ratio  标志最大边占画布比（普通 0.64 / 收藏格 0.68 / maskable 0.52）
 * @param opts.rounded  是否预圆角（favicon / PWA any 用 true；apple-touch / maskable 用 false）
 * @param opts.maskable
 */
function iconSvg(S, p, opts = {}) {
  const ratio = opts.ratio ?? (opts.maskable ? 0.52 : 0.64);
  const rounded = opts.rounded ?? false;
  const rx = rounded ? S * 0.2 : 0;
  const k = (ratio * S) / G.content.w;
  const tx = S / 2 - G.content.cx * k;
  const ty = S / 2 - G.content.cy * k;
  const id = `mm-hole-icon-${p.key}-${S}${opts.maskable ? "m" : ""}${rounded ? "r" : ""}`;

  // ① 站牌描边（仅白底系列）：一圈青花蓝「牌框」
  //    · 默认：贴着牌面内缘（预圆角件随自身圆角走；满幅件为方框）
  //    · frameInsetRatio：把牌框整体内缩到「遮罩安全区」内。
  //      maskable 必须用 —— 安卓自适应图标遮罩会裁掉画布外缘，贴边牌框会被裁成
  //      4 段碎线（本轮已按几何推算 + 现有 white-maskable 候选复现该风险）。
  //    · frameRadiusRatio：牌框圆角按「牌框自身宽度」的比例给。
  //      apple-touch 用来对齐 iOS 的 22.37% 圆角遮罩，否则牌框四角会被 iOS 裁掉。
  let frame = "";
  if (p.frame) {
    const fw = Math.max(1.5, S * 0.035);
    const inset = Math.max(fw / 2, opts.frameInsetRatio != null ? S * opts.frameInsetRatio : fw / 2);
    const fw2 = S - 2 * inset; // 牌框外接宽度
    const rxFrame =
      opts.frameRadiusRatio != null
        ? Math.max(0, fw2 * opts.frameRadiusRatio - fw / 2)
        : Math.max(0, rx - fw / 2);
    frame = `<rect x="${inset.toFixed(3)}" y="${inset.toFixed(3)}" width="${fw2.toFixed(3)}" height="${fw2.toFixed(3)}"
        rx="${rxFrame.toFixed(3)}" fill="none" stroke="${p.frame}" stroke-width="${fw}"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img"
     aria-label="M Map App 图标（${p.name}）">
  <title>M Map · App 图标 ${S}px · ${p.name}</title>
  ${holeMask(id)}
  <rect x="0" y="0" width="${S}" height="${S}" rx="${rx}" fill="${p.bg}"/>
  ${frame}
  <g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${k.toFixed(5)})">
    <g mask="url(#${id})">
      <path d="${G.route}" fill="none" stroke="${p.route}" stroke-width="${G.stroke}" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${G.pin}" fill="${p.pin}"/>
    </g>
    ${G.stations
      .map(
        ([x, y]) =>
          `<circle cx="${x}" cy="${y}" r="${G.ringR}" fill="none" stroke="${p.ring}" stroke-width="${G.ringW}"/>`
      )
      .join("")}
  </g>
</svg>
`;
}

/** 用 sharp 把 SVG 栅格化：先按 4× 渲染再降采样（小尺寸更锐）
 *  opaque=true（满幅方角图标）→ 去 alpha 通道，避免 PWA 校验器报「图标含透明」 */
async function rasterize(svg, S, outFile, opaque = false) {
  const big = svg.replace(`width="${S}" height="${S}"`, `width="${S * 4}" height="${S * 4}"`);
  let pipe = sharp(Buffer.from(big), { density: 72 }).resize(S, S, { fit: "contain" });
  if (opaque) pipe = pipe.flatten({ background: "#fff" }).removeAlpha();
  await pipe.png({ compressionLevel: 9 }).toFile(outFile);
}

const ICON_SET = [
  { file: "icon-16", S: 16, ratio: 0.68, rounded: true },
  { file: "icon-32", S: 32, ratio: 0.68, rounded: true },
  // apple-touch：满幅方角，由 iOS 自己切 22.37% 圆角 ⇒ 牌框圆角必须对齐该值，否则四角被裁
  { file: "apple-touch-icon-180", S: 180, ratio: 0.66, rounded: false, frameRadiusRatio: 0.24 },
  { file: "icon-192", S: 192, ratio: 0.64, rounded: true },
  { file: "icon-512", S: 512, ratio: 0.64, rounded: true },
  // maskable：满幅方角 + 内容压 80% 安全圆。牌框内缩到名义 56% 画布、圆角 30% 牌框宽，
  //   使「牌框描边最外对角半径」= 179.8px（断言口径 >236）/ 179.9px（探针口径 >245），
  //   差异源于非白阈值，均 ≤ 可用 204.8px（余量 25px，与第五轮蓝底 maskable 的 181/205 同口径）。
  //   两种「不内缩」前提都不够稳（前提不同、各有一数）：
  //     ① 牌框外沿贴画布边（满幅锐角）：角点半径 = 256√2 ≈ 362 > 安全圆 204.8 ⇒ 必被遮罩切段；
  //     ② 名义 56% 但保留锐角：角点半径 ≈ 204.4，贴住安全圆 204.8（仅余 0.4px）。
  {
    file: "maskable-512",
    S: 512,
    ratio: 0.52,
    rounded: false,
    maskable: true,
    frameInsetRatio: 0.22,
    frameRadiusRatio: 0.3,
  },
];

async function buildSet(p, dir, nameOf = (f) => f, set = ICON_SET) {
  for (const it of set) {
    const svg = iconSvg(it.S, p, it);
    const base = nameOf(it.file);
    fs.writeFileSync(path.join(dir, `${base}.svg`), svg, "utf8");
    await rasterize(svg, it.S, path.join(dir, `${base}.png`), it.rounded === false);
  }
}

/* 第六轮白底专用：几何与蓝底同源，唯一差异 —— maskable 的牌框内缩到 56% 画布，
   标志缩到 0.46（蓝底 0.52）以在牌框内留出 16.7px 呼吸（否则标志会贴住牌框内缘）。 */
const WHITE_ICON_SET = ICON_SET.map((it) =>
  it.file === "maskable-512" ? { ...it, ratio: 0.46 } : { ...it }
);

/* 定稿默认色 = 推荐 ② 青花蓝底 */
await buildSet(PALETTES.blue, ICON_DIR);

/* 额外：满幅方角 512（App 内展示 / 分享卡 / OG / 需要自带形状的位） */
{
  const svg = iconSvg(512, PALETTES.blue, { ratio: 0.6, rounded: false });
  fs.writeFileSync(path.join(ICON_DIR, "icon-square-512.svg"), svg, "utf8");
  await rasterize(svg, 512, path.join(ICON_DIR, "icon-square-512.png"), true);
}

/* ── 第六轮：白底「站牌」六件套（app-icon-white/，文件名不带色板前缀）─────────
   用途：替换线上 public/ 根级 6 件套。白牌面 + 青花蓝牌框 + 青花蓝路线/站点环 + 澳门绿钉。
   几何与蓝底完全同源（同 ICON_SET，只换色板 + 牌框按遮罩安全区处理），故 25 项像素自检
   的坐标换算 M() 一字不改即可复用到白底（见 .verify/check-brand-r6.mjs）。
   ⚠️ 蓝底 app-icon/ 输出**不受影响**（PALETTES.blue.frame === null，牌框分支整段跳过）。 */
await buildSet(PALETTES.white, WHITE_DIR, (f) => f, WHITE_ICON_SET);

/* B · 四底色候选（512 效果）——白底候选与上线件同规格（走 WHITE_ICON_SET） */
for (const p of Object.values(PALETTES)) {
  await buildSet(p, CAND_DIR, (f) => `${p.key}-${f}`, p.key === "white" ? WHITE_ICON_SET : ICON_SET);
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. 对比度自检（WCAG 2.1）
   ═══════════════════════════════════════════════════════════════════════════ */
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
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

const rows = [];
for (const p of Object.values(PALETTES)) {
  rows.push(
    `${p.name.padEnd(14, "　")} 路线 ${p.route} / 底 ${p.bg} = ${ratio(p.route, p.bg).toFixed(2)}:1` +
      `　·　钉 ${p.pin} / 底 ${p.bg} = ${ratio(p.pin, p.bg).toFixed(2)}:1`
  );
}
const report = [
  "M Map · App 图标底色候选 · 对比度自检（图形类门槛 ≥3:1，正文类 ≥4.5:1）",
  "-".repeat(72),
  ...rows,
].join("\n");
fs.writeFileSync(path.join(ROOT, "tools", "contrast-report.txt"), report + "\n", "utf8");
console.log(report);
console.log("\n[OK] 资产已生成：", ROOT);
