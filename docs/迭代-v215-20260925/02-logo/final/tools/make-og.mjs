/**
 * make-og.mjs —— M Map · OG 分享卡生成器（1200×630）
 * ---------------------------------------------------------------------------
 * 输入：final/og/og.html（自包含版式源；Token 就地钉死为「固定深底」取值）
 * 产出：final/og/og.png        （源，留存复核）
 *       public/brand/og.png    （上线资产；/brand 已在 middleware 公开前缀，免登记）
 *
 * 为什么用「真浏览器截图」而不是 sharp(librsvg) 栅格化：
 *   本卡含**中文**（Noto Sans SC）与 Barlow，librsvg 取的是**系统已装字体**，
 *   CI / 换机就会掉字形（豆腐块）。headless Chromium + Google Fonts 才能保证
 *   与线上页面**同字形、同字距**。这与 .verify/_probe-brandmark.cjs 的既有做法一致。
 * 为什么不是 next/og ImageResponse（动图）：
 *   ① 本站品牌已冻结（v2.15 定稿 + 17 项像素自检），无「随内容漂移」的需求；
 *   ② ImageResponse 无 CSS var，且默认字体无 CJK ⇒ 必须自行喂字体二进制，属额外复杂度；
 *   ③ 静态图无 edge 运行时开销。
 *   本生成器 = 「单一真源」：改 og.html 一处 → 重跑 → 图更新，等价于「不会漂移」。
 *
 * 运行：node docs/迭代-v215-20260925/02-logo/final/tools/make-og.mjs
 * 依赖：playwright-core（仓内既有探针同款路径）
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FINAL = path.resolve(__dirname, "..");
const OG_DIR = path.join(FINAL, "og");
const SRC = path.join(OG_DIR, "og.html");
const OUT_SRC = path.join(OG_DIR, "og.png");
const OUT_PUBLIC = path.resolve(FINAL, "../../../../public/brand/og.png");

const require = createRequire(import.meta.url);
const PW = path.join(
  "C:", "Users", "ASUS", ".workbuddy", "binaries", "node", "workspace", "node_modules", "playwright-core",
);
const CHROME = path.join(
  process.env.LOCALAPPDATA ?? "", "ms-playwright", "chromium-1228", "chrome-win64", "chrome.exe",
);
const { chromium } = require(PW);

const W = 1200;
const H = 630;

const browser = await chromium.launch({ headless: true, executablePath: CHROME });
try {
  const page = await browser.newPage({
    viewport: { width: W + 200, height: H + 200 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(SRC).href, { waitUntil: "networkidle", timeout: 60000 });
  // 等字体真正就绪（缺了这一步会拍到 fallback 字形）
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const fontCheck = await page.evaluate(() => ({
    barlow: document.fonts.check('700 32px "Barlow"'),
    noto: document.fonts.check('500 15px "Noto Sans SC"'),
    mono: document.fonts.check('500 14px "JetBrains Mono"'),
  }));
  const el = await page.$("#og");
  const box = await el.boundingBox();
  if (box.width !== W || box.height !== H) {
    throw new Error(`画布尺寸不对：${box.width}×${box.height}（应为 ${W}×${H}）`);
  }
  await el.screenshot({ path: OUT_SRC, type: "png" });
  fs.mkdirSync(path.dirname(OUT_PUBLIC), { recursive: true });
  fs.copyFileSync(OUT_SRC, OUT_PUBLIC);
  console.log("字体就绪：", fontCheck);
  console.log("已生成：", OUT_SRC);
  console.log("已落地：", OUT_PUBLIC);
  if (!fontCheck.barlow || !fontCheck.noto || !fontCheck.mono) {
    console.warn("[WARN] 有字体未就绪，图可能掉字形 —— 检查网络 / Google Fonts 可达性");
  }
} finally {
  await browser.close();
}
