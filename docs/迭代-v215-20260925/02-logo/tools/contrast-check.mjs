/**
 * 慢速色（黄）候选 — WCAG 对比度核算
 * 运行：node docs/迭代-v215-20260925/02-logo/tools/contrast-check.mjs
 *
 * 背景：
 *  · `.nav-plan-sub__delta.is-slow` / `.fold-plan__delta.is-slow` 是 **13px / 字重 700 的文字**
 *    ⇒ 未达「大文本」门槛（≥18.66px 或 ≥24px），必须满足 **AA 4.5:1**。
 *  · 会出现文字的表面：`--surface` #ffffff（卡片）、`--surface-2` #eaece7（次表面/内嵌块）。
 *  · 对照：快速色 `--brand-green` #0b6e4f 必须在同一表面里「视觉重量相当」，否则一快一慢会一跳一跳。
 */
const srgb = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};
const lum = (hex) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
};
const ratio = (fg, bg) => {
  const a = lum(fg), b = lum(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

const SURFACES = [
  ["--surface", "#ffffff"],
  ["--surface-2", "#eaece7"],
  ["--bg", "#f2f4f0"],
];

const FGS = [
  ["绿·快速色（基准）  --brand-green", "#0b6e4f"],
  ["现·慢速色 --warn", "#a85e00"],
  ["候选1 深琥珀金", "#8a6400"],
  ["候选1b 琥珀金(略亮)", "#96700a"],
  ["候选2 DarkGoldenrod", "#b8860b"],
  ["候选2b 芥末金", "#a17f00"],
  ["参考 Tailwind amber-700", "#b7791f"],
  ["参考 Tailwind amber-800", "#92400e"],
];

const AA = 4.5;
const pad = (s, n) => String(s).padEnd(n, " ");
console.log("\n对比度核算（WCAG 2.1 AA 正文文字门槛 = 4.5:1）\n");
console.log(pad("前景色", 34) + SURFACES.map((s) => pad(s[0], 16)).join(""));
console.log("-".repeat(34 + 16 * SURFACES.length));
for (const [name, fg] of FGS) {
  const cells = SURFACES.map(([, bg]) => {
    const r = ratio(fg, bg);
    const mark = r >= AA ? "PASS" : "fail";
    return pad(`${r.toFixed(2)}:1 ${mark}`, 16);
  });
  console.log(pad(name, 34) + cells.join(""));
}
console.log("");

/* ── 候选2：明黄。只作「圆点 / 徽标底 / 描边」，不作正文文字 ──
   ① 作为**图形元素**（圆点/描边）与相邻表面需 ≥3:1（WCAG 1.4.11 非文本对比）；
   ② 作为**徽标底**时，压在上面的深色字需 ≥4.5:1。 */
console.log("\n候选2 · 明黄（仅图形 / 徽标底，不作正文文字）\n");
const BRIGHT = ["#e3a008", "#f0b429", "#eab308", "#f5c518"];
console.log(pad("明黄", 14) + pad("vs #fff(图形3:1)", 20) + pad("vs --surface-2", 18));
console.log("-".repeat(52));
for (const y of BRIGHT) {
  const a = ratio(y, "#ffffff");
  const b = ratio(y, "#eaece7");
  console.log(
    pad(y, 14) +
      pad(`${a.toFixed(2)}:1 ${a >= 3 ? "OK" : "low"}`, 20) +
      pad(`${b.toFixed(2)}:1 ${b >= 3 ? "OK" : "low"}`, 18),
  );
}
console.log("\n明黄底 + 深色字（徽标形态）\n");
const INKS = [
  ["#3a2c00 深琥珀字", "#3a2c00"],
  ["#5a4300 琥珀字", "#5a4300"],
  ["--fg #0f1720", "#0f1720"],
];
console.log(pad("字色", 22) + pad("压 #e3a008", 16) + pad("压 #f5c518", 16));
console.log("-".repeat(54));
for (const [name, ink] of INKS) {
  console.log(
    pad(name, 22) +
      pad(`${ratio(ink, "#e3a008").toFixed(2)}:1`, 16) +
      pad(`${ratio(ink, "#f5c518").toFixed(2)}:1`, 16),
  );
}
console.log("");

/* ── 深色模式（globals.css §深色：--bg #111318 / --surface #1c1e24 / --surface-2 #2a2d34） ── */
console.log("\n深色模式核算（前景需在深底上 ≥4.5:1）\n");
const DARK_SURFACES = [
  ["--surface", "#1c1e24"],
  ["--surface-2", "#2a2d34"],
  ["--bg", "#111318"],
];
const DARK_FGS = [
  ["深色·绿（基准） --brand-green", "#6dd58c"],
  ["深色·现 --warn", "#f3c27a"],
  ["候选1 深色派生 琥珀", "#e3b341"],
  ["候选1b 深色派生 亮金", "#f0c542"],
];
console.log(pad("前景色", 34) + DARK_SURFACES.map((s) => pad(s[0], 16)).join(""));
console.log("-".repeat(34 + 16 * DARK_SURFACES.length));
for (const [name, fg] of DARK_FGS) {
  const cells = DARK_SURFACES.map(([, bg]) => {
    const r = ratio(fg, bg);
    return pad(`${r.toFixed(2)}:1 ${r >= AA ? "PASS" : "fail"}`, 16);
  });
  console.log(pad(name, 34) + cells.join(""));
}
console.log("");
