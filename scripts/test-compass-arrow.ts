/**
 * 朝向箭头门禁（scripts/test-compass-arrow.ts · ★ F2 / 2026-11-14）
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 *   箭头看起来"就是转个角度"，但有四个坑只能靠推理和断言守住，肉眼在真机上极难分辨：
 *     ① **跨正北倒转**：CSS `rotate()` 按数值线性解释，`359° → 1°` 会倒退 358°（箭头反向绕一圈）。
 *        必须把朝向接成**不回绕的连续角度**（359 → 361，只走 +2°）。
 *     ② **箭头带跑蓝点**：`.user-dot` 的 `transform` 是 AMap 的锚点偏移，位置平滑也长在那上面；
 *        箭头若复用同一个 transform，一转头蓝点就跟着位移。
 *     ③ **静止时抖**：传感器 50~60Hz，站着不动也会抖 0.0x°；"位移 0"只能靠**不写 DOM**保证。
 *     ④ **没有朝向时改变了旧观感**：`heading=null` 必须与旧版逐像素一致 ⇒ 箭头层 `display:none`。
 *
 * ── 怎么测（不联网、不连库、不需要浏览器）──────────────────────────────
 *   · 角度数学：直接断言 `nextArrowDeg`（跨 0° 的最短弧累加）；
 *   · DOM 行为：用 ~30 行 `document.createElement` 假实现，跑**真代码** `buildContent()` /
 *     `writeArrowDeg()`，断言子节点顺序与 `style.transform` 的真实取值；
 *   · 样式与接线：读 `globals.css` 与组件源码做文本钉子（剥整行注释后判定）。
 *
 * 跑法：`npm run test:compass-arrow`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { nextArrowDeg, HEADING_DEADBAND_DEG, normalizeDeg } from "../src/lib/compass/heading";
import {
  ARROW_CLASS,
  ARROW_EPS_DEG,
  arrowOf,
  buildContent,
  writeArrowDeg,
  writeArrowOff,
} from "../src/components/nav/UserDotLayer";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${detail ? `  — ${detail}` : ""}`);
}

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/** 去掉整行注释（本项目注释里大量写着旧行为，直接 grep 原文会把说明当成代码） */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");

/* ══════════════════════════════════════════════════════════════════════
 * ① 连续角度：跨 0° 不许回绕
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ① nextArrowDeg：跨正北只走最短弧 ═══\n");

ok(nextArrowDeg(null, 0) === 0, "首帧：0° ⇒ 0");
ok(nextArrowDeg(null, 359) === 359, "首帧：359° ⇒ 359（不归一化到 -1）");
ok(nextArrowDeg(null, 720) === 0, "首帧：720° ⇒ 0（内部归一化）");
ok(nextArrowDeg(null, -90) === 270, "首帧：-90° ⇒ 270（等价朝向）");
ok(nextArrowDeg(359, 1) === 361, "359 → 1 得 361（**不是 1**；否则箭头倒退 358°）");
ok(nextArrowDeg(1, 359) === -1, "1 → 359 得 -1（向左 -2°，不是 +358°）");
ok(nextArrowDeg(0, 180) === 180, "0 → 180 得 180（正对面，两方向等价时取正）");
ok(nextArrowDeg(360, 0) === 360, "360 → 0 保持 360（连续值不回绕到 0）");
const nanCase = nextArrowDeg(123, Number.NaN);
ok(nanCase === 123, "NaN 输入保持上一值（不把箭头甩到 0°）", `→ ${nanCase}`);

/* 原地转一整圈：36 步，每步 +10°，必须**单调递增**且最终 360（不是 0） */
{
  let cont: number | null = null;
  const seq: number[] = [];
  for (let i = 0; i <= 36; i++) {
    cont = nextArrowDeg(cont, i * 10);
    seq.push(cont);
  }
  const monotonic = seq.every((v, i) => i === 0 || v > seq[i - 1]);
  const maxJump = Math.max(...seq.map((v, i) => (i === 0 ? 0 : Math.abs(v - seq[i - 1]))));
  ok(monotonic, "顺时针整圈：36 步角度单调递增（无回绕）", `首 ${seq[0]} / 末 ${seq[36]}`);
  ok(Math.abs(seq[36] - 360) < 1e-9, "顺时针整圈：末值 = 360（若为 0 就是回绕了）", `→ ${seq[36]}`);
  ok(maxJump <= 10 + 1e-9, "相邻两步增量 ≤ 10°（没有某一帧突然跳 350°）", `最大 ${maxJump}`);
}

/* 反向整圈：36 步，每步 -10° ⇒ 单调递减到 -360 */
{
  let cont: number | null = null;
  const seq: number[] = [];
  for (let i = 0; i <= 36; i++) {
    cont = nextArrowDeg(cont, normalizeDeg(-i * 10));
    seq.push(cont);
  }
  const monotonic = seq.every((v, i) => i === 0 || v < seq[i - 1]);
  ok(monotonic, "逆时针整圈：角度单调递减（同一套逻辑双向成立）", `首 ${seq[0]} / 末 ${seq[36]}`);
  ok(Math.abs(seq[36] + 360) < 1e-9, "逆时针整圈：末值 = -360", `→ ${seq[36]}`);
}

/* 死区常量：必须远小于 1°，否则会把真实的小幅转身吃掉 */
ok(ARROW_EPS_DEG > 0, "死区常量为正（否则每帧都写 DOM，静止时会抖）");
ok(ARROW_EPS_DEG < 1, "死区常量 < 1°（否则会吞掉真实转身）", `${ARROW_EPS_DEG}°`);
ok(ARROW_EPS_DEG < HEADING_DEADBAND_DEG, "箭头死区小于平滑器死区（层次：平滑器先消噪，箭头再省写）");

/* ══════════════════════════════════════════════════════════════════════
 * ② DOM：子节点顺序 + 只写箭头层
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ② 蓝点 DOM：箭头是独立一层、默认不渲染 ═══\n");

/** 极简 DOM 假实现：只覆盖 buildContent / arrowOf / writeArrow* 用到的几个 API */
class StubEl {
  tagName: string;
  className = "";
  title = "";
  style: Record<string, string> = {};
  children: StubEl[] = [];
  attrs: Record<string, string> = {};
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  appendChild(c: StubEl) {
    this.children.push(c);
    return c;
  }
  querySelector(sel: string) {
    const cls = sel.startsWith(".") ? sel.slice(1) : sel;
    const hit = (n: StubEl): StubEl | null => {
      if (n.className.split(/\s+/).includes(cls)) return n;
      for (const c of n.children) {
        const r = hit(c);
        if (r) return r;
      }
      return null;
    };
    for (const c of this.children) {
      const r = hit(c);
      if (r) return r;
    }
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).document = { createElement: (tag: string) => new StubEl(tag) };

const wrap = buildContent() as unknown as StubEl;
const kinds = wrap.children.map((c) => c.className);
ok(kinds.join(",") === ["user-dot__ring", "user-dot__ping", ARROW_CLASS, "user-dot__core"].join(","),
  "子节点顺序 = ring → ping → arrow → core（箭头在 core 之下）", kinds.join(","));
ok(wrap.className === "user-dot", "wrap 类名仍是 user-dot");
ok(wrap.style.transform === undefined, "wrap 上没有写 transform（锚点偏移归 AMap 管，不许抢）");

const arrow = arrowOf(wrap as unknown as HTMLElement) as unknown as StubEl | null;
ok(!!arrow, "arrowOf 能取到箭头层");
ok(arrow?.getAttribute("data-on") === "0", "箭头默认 data-on=0（没有朝向 ⇒ 不渲染，与旧版逐像素一致）");
ok(arrow?.style.transform === undefined, "箭头初始没有 transform（不是「先转好再隐藏」）");

writeArrowDeg(arrow as unknown as HTMLElement, 361);
ok(arrow?.style.transform === "rotate(361.0deg)", "writeArrowDeg 写 rotate(361.0deg)（保留一位小数）", arrow?.style.transform);
ok(arrow?.getAttribute("data-on") === "1", "writeArrowDeg 同时把 data-on 置 1");
ok(wrap.style.transform === undefined, "写箭头后 wrap 的 transform 仍是空的（不复用、不串味）");

writeArrowOff(arrow as unknown as HTMLElement);
ok(arrow?.getAttribute("data-on") === "0", "writeArrowOff 把 data-on 置 0");
ok(arrow?.style.transform === "rotate(361.0deg)", "关闭时不清 transform（下次开只需改 data-on，省一次写）");

/* 整圈 DOM 序列：把上面的数学结果真写进 DOM，确认没有一步跳变 */
{
  let cont: number | null = null;
  const written: number[] = [];
  for (let i = 0; i <= 36; i++) {
    cont = nextArrowDeg(cont, i * 10);
    writeArrowDeg(arrow as unknown as HTMLElement, cont);
    written.push(Number(/rotate\((-?[\d.]+)deg\)/.exec(arrow!.style.transform)?.[1] ?? "NaN"));
  }
  const maxJump = Math.max(...written.map((v, i) => (i === 0 ? 0 : Math.abs(v - written[i - 1]))));
  ok(maxJump <= 10.1, "写进 DOM 的整圈序列无跳变（最大步进 ≤10.1°）", `最大 ${maxJump}`);
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 组件接线：独立 effect、只依赖 heading、只碰箭头
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ③ 组件接线（静态钉子）═══\n");

const DOT = "src/components/nav/UserDotLayer.tsx";
const dotCode = codeOnly(read(DOT));
const navCode = codeOnly(read("src/components/nav/NavMap.tsx"));

ok(/heading\?:\s*number\s*\|\s*null/.test(dotCode), "UserDotLayer 有 heading?: number | null");
ok(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?nextArrowDeg\(contRef\.current,\s*heading\)[\s\S]*?\},\s*\[heading\]\);/.test(dotCode),
  "朝向更新在**独立 effect** 里，且依赖只有 [heading]（不与位置 effect 混跑）");
ok(/\[enabled,\s*map,\s*amap,\s*fix,\s*smoothMs\]\);/.test(dotCode),
  "位置 effect 的依赖没被 heading 污染（否则每帧朝向都会打断 rAF 插值）");
const transformWrites = dotCode.match(/style\.transform/g) ?? [];
ok(transformWrites.length === 1, "源码里只有一处写 style.transform（= 箭头层），没有第二处去改蓝点", `共 ${transformWrites.length} 处`);
ok(/arrow\.style\.transform/.test(dotCode), "那一处写的是 arrow 元素（不是 wrap / content）");
ok(!/wrap\.style/.test(dotCode), "wrap 的 style 在源码里根本没被碰过");
ok(/writeArrowOff\(arrow\)/.test(dotCode), "heading 为空时走 writeArrowOff（关掉，而不是画个指北的箭头）");
ok(/Math\.abs\(next - prev\) < ARROW_EPS_DEG/.test(dotCode), "死区判定存在（静止时不写 DOM）");

ok(/userHeading\?:\s*number\s*\|\s*null/.test(navCode), "NavMap 新增 userHeading?: number | null");
ok(/heading=\{userHeading\}/.test(navCode), "NavMap 把 userHeading 透传给 UserDotLayer 的 heading");
ok(!/useCompassHeading/.test(navCode), "NavMap **不**自己读传感器（取值是 F3 的职责，本层只透传）");

/* ══════════════════════════════════════════════════════════════════════
 * ④ 样式：绕心旋转、不吃点击、减动效只去缓动
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ④ 样式 ═══\n");

/**
 * 读 CSS 时**先把注释整段剥掉**再判定。
 *
 * 为什么必须：本规则的注释里明确写着"**不能**用 `margin:auto`"，
 * 不剥注释时「不得用 margin:auto」这条断言会命中自己的说明文字 ⇒ 永远红。
 * 同一类坑本项目已踩过两次（源码判据被注释骗、CSS 判据被注释骗），
 * 所以这里在**入口**统一处理，而不是逐条断言各自小心。
 */
const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
/** 取一个 CSS 规则块（第一次出现；本项目同名规则只定义一次） */
function cssBlock(sel: string): string {
  const i = css.indexOf(sel + " {");
  if (i < 0) return "";
  const j = css.indexOf("}", i);
  return j < 0 ? "" : css.slice(i, j);
}
const arrowCss = cssBlock(".user-dot__arrow");
const offCss = cssBlock('.user-dot__arrow[data-on="0"]');

ok(!!arrowCss, "globals.css 有 .user-dot__arrow 规则");
ok(/transform-origin:\s*50%\s+50%/.test(arrowCss), "显式写 transform-origin: 50% 50%（绕自身中心转，不画圈）");
ok(/pointer-events:\s*none/.test(arrowCss), "pointer-events: none（箭头不抢地图点击）");
/* 居中方式：**必须** 50% + 负 margin（= 尺寸的一半），不能用 margin:auto。
   原因（2026-11-14 浏览器实测）：子元素 26px 比父容器 16px 大时，`inset:0 + margin:auto`
   的横向 auto 会被解成 0 ⇒ 箭头中心相对蓝点偏移 (5, 0)px。
   这里不写死 26/13，而是从 CSS 里**读出**尺寸再算，改尺寸忘了改 margin 就会红。 */
{
  const m = /width:\s*(\d+)px/.exec(arrowCss);
  const size = m ? Number(m[1]) : NaN;
  const half = size / 2;
  ok(Number.isFinite(size) && size > 16, "箭头尺寸大于容器 16px（否则尖端露不出来）", `${size}px`);
  ok(/left:\s*50%/.test(arrowCss) && /top:\s*50%/.test(arrowCss), "居中基准是 left/top: 50%");
  const mg = /margin:\s*(-\d+)px\s+0\s+0\s+(-?\d+)px/.exec(arrowCss);
  ok(!!mg, "用负 margin 定位（不是 inset:0 + margin:auto）", mg ? mg[0] : arrowCss.match(/margin:[^;]*/)?.[0] ?? "缺失");
  ok(
    !!mg && Number(mg[1]) === -half && Number(mg[2]) === -half,
    `负 margin = 尺寸的一半（-${half}px；对不上就会偏心）`,
    mg ? `${mg[1]} / ${mg[2]}` : "解析失败",
  );
  ok(!/margin:\s*auto/.test(arrowCss), "**不得**用 margin:auto 居中（大尺寸子元素会被解成 0，实测偏 5px）");
}
ok(/transition:\s*transform/.test(arrowCss), "有 transform 过渡（帧间顺滑）");
ok(!!offCss && /display:\s*none/.test(offCss), "data-on=\"0\" ⇒ display:none（真不渲染，不是靠透明度）");

const rmBlock = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
ok(/\.user-dot__arrow\s*\{[^}]*transition:\s*none/.test(rmBlock),
  "减动效下取消箭头缓动（朝向是信息，必须保留）");

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 门禁接线
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ⑤ 门禁接线 ═══\n");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
ok(
  typeof pkg.scripts["test:compass-arrow"] === "string" && pkg.scripts.verify.includes("test:compass-arrow"),
  "`test:compass-arrow` 已接入 verify（否则等于没人跑）",
);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
