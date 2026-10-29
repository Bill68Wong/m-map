/**
 * 徽章自适应字色（src/lib/ui/chip-ink.ts，v3.6.0）
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 *   线路徽章的**底色是数据**（`routes.color`，每条线不同）。同一个「白字」在
 *   深底上合格（青花蓝 `#1b4d8f`）、在浅底上却只有 1.x:1；反之「深字」在浅绿
 *   `#93d50a` 上合格、在深蓝上不合格。⇒ 字色**必须按底色算**，不能定死一个。
 *
 * ── 算法（设计 §2.4，确定性、无主观）────────────────────────────────────
 *   WCAG 相对亮度 + 4.5:1 阈值反解：
 *     · 白字达标：1.05 / (L + 0.05) ≥ 4.5  ⇒  L ≤ 0.1833   → 取 `L ≤ 0.18`
 *     · 深字达标：(L + 0.05) / (L_INK + 0.05) ≥ 4.5  ⇒  L ≥ 0.2122  → 取 `L ≥ 0.212`
 *     · **死带** `0.18 < L < 0.212`：两个方向都 < 4.5:1 ⇒ 把底色加深 14% 后必落回白字分支
 *
 *   `L_INK = 0.00819` 是 `--fg`（`#0f1720`）的相对亮度，固化成常量避免每次重算。
 *
 * ── 三级兜底（设计 §2.4 末段）───────────────────────────────────────────
 *   底色不是 6 位 hex（脏数据 / `rgb()` / 空值）⇒ 不拿它当文字底色，改用中性 chip
 *   + 一个 6×6 小圆点承载线路色。此时字色恒为 `--fg`（15.2:1，绝对安全）。
 *
 * ⚠️ 纯函数、零依赖、client/server 通用（**禁止 import `pg` 等 server 模块**）。
 */

/** `--fg` = `#0f1720` 的相对亮度（常量，见文件头） */
const L_INK = 0.00819;

/** 白字 / 深字的阈值（设计 §2.4 阈值表） */
const L_WHITE_MAX = 0.18;
const L_DARK_MIN = 0.212;

/** 死带内底色加深比例（14% ⇒ 必落回 L ≤ 0.18） */
const DEEPEN_K = 0.14;

/** `data-chip-ink` 的四种取值（QA 断言抓这个属性，不抓可见色） */
export type ChipTone = "light" | "dark" | "deepened" | "fallback";

export interface ChipInk {
  /** 字色：`#fff` 或 `var(--fg)` */
  ink: "#fff" | "var(--fg)";
  /** 实际渲染的底色（死带时是加深后的色；兜底时是 `var(--surface-2)`） */
  bg: string;
  /** 分支标记（写到 `data-chip-ink`） */
  tone: ChipTone;
  /** 兜底时为线路原值（画小圆点用）；正常分支为 `null` */
  dot: string | null;
}

/** 是否为规范的 6 位 hex（`#rrggbb`） */
function isHex6(s: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(s);
}

/** WCAG 相对亮度 */
function relLum(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * 乘性加深（等价于 `color-mix(in srgb, c 86%, #000)`，但服务端/客户端都能算 ——
 * `color-mix()` 在自定义属性里读不到 resolved 值，喂画布会静默失效，见设计「已知坑」1）。
 */
function mixBlack(hex: string, k: number): string {
  const ch = [1, 3, 5].map((i) => {
    const v = Math.round((parseInt(hex.slice(i, i + 2), 16) * (1 - k)) / 1);
    return Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  });
  return `#${ch.join("")}`;
}

/**
 * 按底色算字色。
 *
 * @param hex 线路主题色（`routes.color`，形如 `#276299`）
 */
export function chipInkOf(hex: string | null | undefined): ChipInk {
  const raw = (hex ?? "").trim();
  // 三级兜底：非 6 位 hex ⇒ 中性 chip + 小圆点承载线路色
  if (!isHex6(raw)) {
    return { ink: "var(--fg)", bg: "var(--surface-2)", tone: "fallback", dot: raw || "var(--muted)" };
  }
  const L = relLum(raw);
  if (L <= L_WHITE_MAX) return { ink: "#fff", bg: raw, tone: "light", dot: null };
  if (L >= L_DARK_MIN) return { ink: "var(--fg)", bg: raw, tone: "dark", dot: null };
  // 死带：两个方向都不达标 ⇒ 加深底色后取白字
  return { ink: "#fff", bg: mixBlack(raw, DEEPEN_K), tone: "deepened", dot: null };
}

export const CHIP_INK_TEST = { relLum, mixBlack, L_INK, L_WHITE_MAX, L_DARK_MIN, DEEPEN_K };
