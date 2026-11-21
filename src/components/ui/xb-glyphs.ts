/**
 * 跨境实心剪影 · **路径真源**（src/components/ui/xb-glyphs.ts，2026-11-21）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────────
 *   机场 / 码头各一个实心剪影，**同时**出现在两个地方：
 *     · 大尺寸：`<Icon name="planeIcon" />` / `<Icon name="ferryIcon" />`
 *       —— `/cross-border` 页的分组头、三张码头卡、午夜空态（20px）；
 *     · 小尺寸：地图地标 pin（`XborderPinLayer.tsx`，16px 圆里 10px 的图形）。
 *   先前这两处只做了前者，地图 pin 里是**一个空 div**（视觉全靠 CSS 画圆），
 *   所以负责人真机看到的"图标没变"是对的 —— 地图上一个像素都没动。
 *
 *   ⚠️ **路径只能有一份**。这里就是那份。`Icon.tsx` 与 `XborderPinLayer.tsx` 都从这里取，
 *      谁都**不许**再抄一份 `d` 字面量：抄完之后改稿只改一处，另一处会静默留在旧形状，
 *      而这种分歧**编译不报、tsc 不报、只有真机 20px 下才看得出来**（本仓已经踩过一次：
 *      `.verify/design/icon-*.svg` 与 `Icon.tsx` 曾经各存一份描边稿）。
 *
 * ── 为什么 `tightViewBox` 与图标本体的 viewBox 不一样 ──────────────────────
 *   图标本体用 `0 0 24 24`（含四周留白，20px 下视觉约 16px，与全站图标同呼吸感）。
 *   地图 pin 的预算是死的：16px 圆 − 2×1px 边框（**实测算**，见 globals.css 那段注）
 *   ⇒ 内容盒只有 **14px**，而「图形 10px」意味着必须把那圈留白裁掉 ——
 *   24 单位画布里剪影只占 18×18.6。
 *   若不裁：10px 的 svg 里剪影只有 `10 × 18/24 = 7.5px`，在 14px 的盒里像颗芝麻。
 *   ⇒ `tightViewBox` 只服务 pin，图标本体继续用 `0 0 24 24`。
 *
 * ── 改稿纪律 ──────────────────────────────────────────────────────────────
 *   · 改 `d` ⇒ 两处同时变小，**这是设计意图**；要只改一处就是又开了一个分叉。
 *   · `fill="currentColor"` + 整枚 `stroke="none"`：`Icon.tsx` 会往下传
 *     `stroke={2}` / `strokeLinecap="butt"`，实心件里混 2px 描边在 20px 下先糊成灰边。
 *     颜色由**调用方的 `color`** 决定（图标写死项目蓝；地图 pin 由 CSS 给：
 *     **机场与码头现在都是白色**），所以这里一律 `currentColor`，**不要写死十六进制**。
 */

/** 一条路径。`evenodd` 只用于「上舱窗口镂空」（船的上舱靠它挖出两个窗）。 */
export interface XbGlyphPath {
  d: string;
  evenodd?: boolean;
}

export interface XbGlyph {
  /** 剪影路径 —— **与 `<Icon>` 输出完全同一份 `d`** */
  paths: readonly XbGlyphPath[];
  /**
   * 收紧到剪影外接框的 viewBox（**只给地图 pin 用**）。
   * 值 = `minX minY width height`，由下方各条的 bbox 注释推得，不是手调的。
   */
  tightViewBox: string;
}

/**
 * 俯视客机实心剪影（机头朝上，关于 x=12 完全对称；bbox x 3..21 / y 2.7..21.3）
 * ⇒ tight = `3 2.7 18 18.6`
 */
export const XB_GLYPH_PLANE: XbGlyph = {
  paths: [
    {
      d: "M12 2.7C12.9 2.7 13.5 3.4 13.5 4.3L13.5 9.5L21 14.3L21 16.3L13.5 14L13.5 18.5L15.6 20L15.6 21.3L12 20.3L8.4 21.3L8.4 20L10.5 18.5L10.5 14L3 16.3L3 14.3L10.5 9.5L10.5 4.3C10.5 3.4 11.1 2.7 12 2.7Z",
    },
  ],
  tightViewBox: "3 2.7 18 18.6",
};

/**
 * 客运渡轮实心剪影（侧视，船首朝右；上舱两窗镂空 evenodd；桅杆为**实心细条**）
 * bbox x 3..21 / y 3.6..20 ⇒ tight = `3 3.6 18 16.4`
 *
 * ⚠️ 四条路径的顺序就是叠放顺序，不要重排：船体在下、上舱在上，桅杆与旗最后。
 */
export const XB_GLYPH_FERRY: XbGlyph = {
  paths: [
    // 船体：直舷 + 两个 Q 圆角（圆角半径可控，不依赖 arc 的 sweep 方向）
    { d: "M3 13.8H21L19.4 17.6Q18.8 20 16.2 20H7.8Q5.2 20 4.6 17.6Z" },
    // 上舱：圆顶 + 两个窗口镂空（evenodd；20px 下窗口 ≈1.4px，读成两个亮点）
    {
      d: "M8 8.4H16A1.2 1.2 0 0 1 17.2 9.6V13.8H6.8V9.6A1.2 1.2 0 0 1 8 8.4ZM9 10.2H10.7V12.1H9ZM12.6 10.2H14.3V12.1H12.6Z",
      evenodd: true,
    },
    // 桅杆：实心细条（原稿是 1.6px 描边线 —— 实心件里混描边会先消失，只剩悬空旗子）
    { d: "M11.2 3.6H12.8V8.4H11.2Z" },
    // 旗
    { d: "M12.9 3.6H15.8L12.9 5.3Z" },
  ],
  tightViewBox: "3 3.6 18 16.4",
};

/**
 * 渲染成**纯 SVG 字符串**（给 AMap `Marker.content` 用 —— 那里只吃 HTML 串，不能挂 React）。
 *
 * @param glyph  `XB_GLYPH_PLANE` / `XB_GLYPH_FERRY`
 * @param size   边长（px）。地图 pin 传 **10**：16px 圆 − 2×1px 边框（Chrome 实测算）= 14px 内容盒，两侧各留 2px。
 *
 * ⚠️ 颜色不在这里定：路径一律 `currentColor`，由 pin 的 CSS 给（**机场与码头都是 `#fff`** ——
 *    2026-11-21 负责人裁定码头反相：蓝底白图形，两者靠**图形语义**区分而不是颜色）。
 *    这与 `<Icon>` 侧"写死项目蓝"并不矛盾 —— 那边是浅灰底上的识别符号，这边是彩色圆底上的反白图形。
 */
export function xbGlyphSvg(glyph: XbGlyph, size: number): string {
  const paths = glyph.paths
    .map((p) => `<path fill="currentColor"${p.evenodd ? ' fill-rule="evenodd"' : ""} d="${p.d}"/>`)
    .join("");
  return (
    `<svg viewBox="${glyph.tightViewBox}" width="${size}" height="${size}"` +
    ` fill="none" stroke="none" aria-hidden="true" focusable="false">${paths}</svg>`
  );
}
