/**
 * 全站唯一图标出口（src/components/ui/Icon.tsx，M Map 改版 S6）
 *
 * ── 为什么自研包装（Spec §7 工程方案锁定）────────────────────────────
 *   全站**只从 `<Icon>` 出图标** —— 单一入口、单一风格真源。
 *
 *   ── 两套语汇，不是一套（★ 2026-11-21 改口，别再写成"全站 fill=none"）──────
 *     ① **线性**（多数）：`fill="none"` + `stroke="currentColor"` + `stroke={2}` +
 *        `strokeLinecap="butt"` / `strokeLinejoin="miter"`（方向 A「站牌」= 2px 方头方角）。
 *        24 viewBox；`size` 限 `16 | 20 | 24` 三档，**不得混用**（§8）。
 *     ② **实心**（少数，例外）：`fill="currentColor"` + `stroke="none"`。
 *        现值清单：Tabler Filled 族 `homeFilled` / `bookmarkFilled` / `bookFilled` /
 *        `crossBorderFilledIcon`（组件自带 fill），以及**项目内联**的
 *        `IconPlaneSolid` / `IconFerrySolid`（R1 接线，见下方注释）。
 *        ⚠️ 实心件**不参与**线性语汇（不画 stroke），所以"stroke=2 方头"对它无意义；
 *           `check-xborder-ui.tsx` 用 `filled: true` 分支单独断言这一族。
 *   ⚠️ 上一版这里写的是「全站 fill="none"」——**那句话在写下的当天就是假的**
 *      （4 个 Tabler Filled 语义名早于它存在）。这类"文档与代码说两件事"是本仓明令要清的，
 *      所以在此改口而不是留着。
 *   风格不依赖「CSS 继承的偶然性」（另在 globals.css 加 `.mm-icon` 兜底）。
 *
 * ── 图标库 ────────────────────────────────────────────────────────────
 *   `@tabler/icons-react@3.47.0`（MIT · Spec §4 锁定）。**全项目不混用其它库**。
 *   ⚠️ 已源码核对：`createReactComponent` 把 `strokeLinecap/Join` 写在其默认属性里，
 *      再把调用方 `...rest` spread 在其后 ⇒ **props 覆盖生效**（双路径验证的第二条）。
 *
 * ⚠️ 纯展示（无 hooks / 事件）；标 `"use client"` 以兼容 Server Component 引用
 *    （`@tabler/icons-react` 内部用 `forwardRef`，标为客户端组件是 Next.js 的标准安全做法）。
 */
"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  IconArrowForwardUp,
  IconArrowRight,
  IconArrowsExchange,
  IconArrowsLeftRight,
  IconArrowsUpDown,
  IconBook,
  IconBookFilled,
  IconBookmark,
  IconBookmarkFilled,
  IconBus,
  IconBusStop,
  IconChartBar,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircle,
  IconCircleCheck,
  IconClipboardText,
  IconClock,
  IconCurrentLocation,
  IconDownload,
  /* ★ 2026-11-07（跨境交通）：港口分组 / 卡片 + 机场分组 / 卡片
     ⚠️ 2026-11-21（R1 接线）：`IconFerry` / `IconPlane` 已**移出本文件的导入** ——
        这两个语义名改由项目内联的实心剪影承担（见文件下方 `IconFerrySolid` / `IconPlaneSolid`）。
        留着导入就是死导入（会过 eslint 的 no-unused-vars，且让人以为还在用 Tabler 线描）。 */
  IconWorld,
  IconWorldFilled,
  IconGauge,
  IconHome,
  IconHomeFilled,
  IconListDetails,
  IconLock,
  IconMapPin,
  IconPlayerPlay,
  IconRefresh,
  IconRoute2,
  IconSearch,
  /* ★ R5/R6（2026-11-21）：图层键图标 —— Tabler 同库 3.47.0 */
  IconStack2,
  IconTrash,
  IconArrowBackUp,
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowUp,
  IconDots,
  IconFlag,
  IconGripVertical,
  IconPencil,
  IconPinned,
  IconPlus,
  IconTrain,
  IconWalk,
  IconX,
} from "@tabler/icons-react";
/* ★ 2026-11-21：跨境实心剪影的**路径真源**（地图 pin 与本文件共用同一份 `d`） */
import { XB_GLYPH_FERRY, XB_GLYPH_PLANE } from "./xb-glyphs";

/** ★ 仅此三档，不得混用（§8） */
export type IconSize = 16 | 20 | 24;

/**
 * ★ v3.3.0（AC-109 · 设计师裁决「方案 B」）：**修正版线性 info**。
 *
 * 与 Tabler `IconInfoCircle` **逐字同几何**（外圈 + i 的竖笔 + i 的点），**唯一差异**：
 * 把 Tabler 的**零长度段**点（`M12 9h.01`）改为 `<circle r=1 fill="currentColor">`。
 *
 * 为什么不用 `strokeLinecap="round"` 修那条 path：本项目图标门禁
 * `.verify/audit-icon-dots.mjs` 的判据正是「**零长度段**」（butt cap 下不渲染 ⇒ 点丢失）。
 * 用 `<circle>` 实现圆点 ⇒ 该图标**天然零长度段 = 0**，门禁**无需为它开特例**（门禁强度不被削弱），
 * 视觉上与 Tabler 的 round-cap 圆点**完全一致**（半径 = strokeWidth / 2 = 1）。
 */
function IconInfoCircleLinear({
  size = 20,
  stroke = 2,
  className,
  ...rest
}: {
  size?: number;
  stroke?: number;
  className?: string;
  [k: string]: unknown;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      className={`mm-icon${className ? ` ${className}` : ""}`}
      {...rest}
    >
      <path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" />
      <path d="M11 12h1v4h1" />
      <circle cx="12" cy="9" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * ══════════════════════════════════════════════════════════════════════════
 * ★ R1（2026-11-21 接线）：跨境交通的**实心剪影**两个图标（机场 / 码头）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 为什么不是 Tabler 线描 ────────────────────────────────────────────────
 *   `IconPlane`（俯视机）在 20px/2px 下机身净宽只剩 ~1px ⇒ 与两翼糊成「十」字；
 *   `IconFerry`（船体 + 上舱 + 斜桅三条独立线）在 20px 下舱与船体间隙也糊成一坨。
 *   实心剪影的边界由**轮廓**承担、不靠笔画间隙 ⇒ 16px 仍可辨（稿子见 `.verify/design/`）。
 *
 * ── 三条硬纪律（改之前必读）──────────────────────────────────────────────
 *   ① **颜色写死项目蓝** `XB_ICON_BLUE`，**不跟随 `currentColor`**：
 *      两个使用点的父级颜色是浅灰（空态 `--border-2`）与深灰（卡片 `--fg-2`），跟随就会变灰，
 *      而跨境图标是"识别符号"、不是正文。与 `.nav-map__toilet` 写死 `#0b6e4f` 同一条口径：
 *      **品牌/数据色不随主题翻转**。
 *   ② **整枚 `stroke="none"`**：实心件里混一根 1.6px 线描，16px 下那根线会先消失
 *      （剩一个悬浮旗子 = 噪点）⇒ 码头稿原有的"描边桅杆"已改为**实心细条**。
 *   ③ `fill="currentColor"` / `stroke="none"` 必须写在 `{...rest}` **之后**：
 *      `<Icon>` 会往下传 `stroke={2}`、`strokeLinecap="butt"`，写在 spread 前面会被盖掉，
 *      结果是"实心件里多出一圈 2px 描边"——编译不报错、20px 下才看得出来。
 *
 * ⚠️ 这两个组件**不参与**全站"stroke=2 / butt cap"的线性语汇；`check-xborder-ui.tsx` 的
 *    `filled: true` 分支就是按这一点断言的（它断言 `fill="currentColor"` + `stroke="none"`）。
 */

/** 跨境识别符号的固定色（= `--accent` 的具体值）。改色改这一处。 */
const XB_ICON_BLUE = "#1B4D8F";

/**
 * ★ 2026-11-21：**路径搬到了 `xb-glyphs.ts`**（地图 pin 也要用同一份，见那里文件头）。
 *   本文件只负责「大尺寸 + 写死项目蓝」这一层外观，**不再持有任何 `d` 字面量** ——
 *   两处各存一份路径就是分叉的开始，而分叉编译不报、只有真机 20px 下看得出来。
 *   ⚠️ 下面两个组件的**输出必须保持原样**：`check-xborder-ui.tsx` 断言
 *      `fill="currentColor"` + `stroke="none"`，换 ViewBox 或改写 fill 位置都会让它红。
 */

/** 俯视客机实心剪影（机头朝上，关于 x=12 完全对称；bbox x 3..21 / y 2.7..21.3） */
function IconPlaneSolid({ size = 20, className, ...rest }: { size?: number; className?: string; [k: string]: unknown }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...rest}
      fill="none"
      stroke="none"
      style={{ color: XB_ICON_BLUE }}
      className={`mm-icon${className ? ` ${className}` : ""}`}
    >
      {XB_GLYPH_PLANE.paths.map((p) => (
        <path key={p.d} fill="currentColor" {...(p.evenodd ? { fillRule: "evenodd" as const } : {})} d={p.d} />
      ))}
    </svg>
  );
}

/** 客运渡轮实心剪影（侧视，船首朝右；上舱两窗镂空 evenodd；桅杆为**实心细条**） */
function IconFerrySolid({ size = 20, className, ...rest }: { size?: number; className?: string; [k: string]: unknown }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      {...rest}
      fill="none"
      stroke="none"
      style={{ color: XB_ICON_BLUE }}
      className={`mm-icon${className ? ` ${className}` : ""}`}
    >
      {XB_GLYPH_FERRY.paths.map((p) => (
        <path key={p.d} fill="currentColor" {...(p.evenodd ? { fillRule: "evenodd" as const } : {})} d={p.d} />
      ))}
    </svg>
  );
}

/**
 * 语义名 → 图标组件（唯一映射表）。
 * ★ 项目内联件 3 个：`IconInfoCircleLinear`（线性修正版）、`IconPlaneSolid` / `IconFerrySolid`
 *   （R1 实心剪影）。内联件的共同约束见各自上方注释 —— 尤其"fill/stroke 写在 `{...rest}` 之后"。
 */
const REGISTRY: Record<string, any> = {
  /* 导航 / 主流程 */
  search: IconSearch,
  locate: IconCurrentLocation,
  home: IconHome,
  homeFilled: IconHomeFilled,
  bookmark: IconBookmark,
  bookmarkFilled: IconBookmarkFilled,
  /* ★ v3.3.0（AC-109）：/help 底导图标 —— 由「问号圆圈」改「手册」（Tabler 同库线性/实心对，
     隐喻更贴切「使用指南 + 合规说明」；且**零长度段 = 0**）。 */
  book: IconBook,
  bookFilled: IconBookFilled,
  origin: IconCircle,
  destination: IconMapPin,
  pin: IconMapPin,
  swap: IconArrowsLeftRight,
  /* ★ v2.10.0（实时巴士）：换向（区别于 swap —— swap 语义是起终点互换） */
  exchange: IconArrowsExchange,
  /* 载具 / 步行 */
  walk: IconWalk,
  bus: IconBus,
  /** 轻轨（Tabler 3.47 无 Tram，用 Train —— 语义即「轨道交通」） */
  lrt: IconTrain,
  busStop: IconBusStop,
  /* 动作 / 状态 */
  back: IconChevronLeft,
  forward: IconChevronRight,
  close: IconX,
  check: IconCheck,
  arrive: IconCircleCheck,
  play: IconPlayerPlay,
  refresh: IconRefresh,
  skip: IconArrowForwardUp,
  arrowRight: IconArrowRight,
  caretDown: IconChevronDown,
  caretUp: IconChevronUp,
  expandVertical: IconArrowsUpDown,
  /* 数据 / 工具（旧版功能页）
     ★ v3.3.0（AC-109）：`records` 原用 `IconClipboardList` —— 其**项目符号 = 零长度段**（`l.01 0`），
        在 `strokeLinecap="butt"`（本项目固定）下不渲染 ⇒ 图标「缺项目符号」。改 `IconClipboardText`：
        同语义（清单/记录）、**无零长度段**（06 §1.11「改用无零长度段的等价图标」）。 */
  records: IconClipboardText,
  stats: IconChartBar,
  timer: IconClock,
  trash: IconTrash,
  lock: IconLock,
  download: IconDownload,
  /* ★ S3（08 §C.6 图标增补）：组合卡 / 编排编辑器用（Tabler 同库，stroke=2 方头方角不变） */
  add: IconPlus,
  edit: IconPencil,
  more: IconDots,
  dragHandle: IconGripVertical,
  pinTop: IconPinned,
  undo: IconArrowBackUp,
  /* ★ v2.10.0（实时巴士 + 帮助页）：车辆信息卡 / 帮助页 / FAQ 用（Tabler 同库，stroke=2 不变） */
  gauge: IconGauge,
  "route-2": IconRoute2,
  /* ★ v3.3.0（AC-109）· 零长度段根治（butt cap 下「点」不渲染）：
     · `help-circle`（帮助页分区图标）→ `IconBook`（与底导 help 语义统一；零长度段 0）
     · `info-circle`（到站横幅「i」· **安全级元素，图标须完整**）→ `IconInfoCircleLinear`
       （**项目内联 · 方案 B**：保持全站**线性**语汇，仅把零长度段的点改为 `<circle>` ⇒ 完整可见）
     · `list` → `IconListDetails`（原 `IconList` 的项目符号 = 零长度段 ×3）
     ⚠️ 除内联件外均为 Tabler **同库 3.47.0**（不混库），size/stroke 风格不变。 */
  "help-circle": IconBook,
  "info-circle": IconInfoCircleLinear,
  list: IconListDetails,
  /* ── ★ v3.6.0 S5（步行导航）：转向 / 到达 / 偏航 ────────────────────────
     · 转向四态与 `WalkTurn`（`lib/walk/walk-shared.ts`）一一对应 ——
       **不得**在组件里另用字符箭头（「←」「→」）代替，否则视觉与描边风格两端分裂；
     · `uturn` 复用 `undo`（IconArrowBackUp 的几何就是回转箭头）；
     · 全部 Tabler 3.47.0 同库、stroke=2 方头方角、**零长度段 = 0**（过 audit-icon-dots 门禁）。 */
  turnStraight: IconArrowUp,
  turnLeft: IconArrowLeft,
  turnRight: IconArrowRight,
  /** 到达旗（设计 §2.2 `walkArrive`） */
  walkArrive: IconFlag,
  /** 偏航警示（设计 §2.2 `alertTriangle`） */
  alertTriangle: IconAlertTriangle,
  /* ── ★ 2026-11-07（跨境交通 · 设计稿 05 §7.2 图标清单）───────────────────
     4 个语义名，全部 Tabler **同库 3.47.0**（不混库）、stroke=2 方头方角：
       · `crossBorderIcon` / `crossBorderFilledIcon`：底导第 4 个 tab（地球；实心变体 =
         选中态的第二通道，与 home/bookmark/book 的「切实心」惯例一致）；
       · `ferryIcon`：客运港口分组头 + 三张码头卡（內港 / 外港 / 氹仔 同形 ——
         设计稿 §7.2 明确「三码头靠 11px 地名标签区分，图形级区分在 16/20px 不可行」）；
       · `planeIcon`：机场分组头 + 机场卡 + 午夜空态。
     ⚠️ 设计稿**刻意不用** `IconPlaneDeparture`：它由「机身弧 + 跑道横线」两条路径组成，
        20px/2px 下整体读成船体，与 `IconFerry`（上舱 + 下横线）几乎同形（实测放大 4 倍
        仍无法区分）。同理不用 `IconMoonStars` / `IconAlertTriangle` 做空态（两者含
        **零长度段**，在 `strokeLinecap="butt"` 下点/收尾不渲染，见 `.verify/audit-icon-dots.mjs`）。
     ⚠️ 这 4 个名字若拼错，`Icon` 会**静默 `return null`**（不报错、只是没有图标）
        ⇒ 断言脚本 `scripts/check-xborder-ui.tsx` 逐名渲染并断言产出的 `<svg>` 非空。 */
  crossBorderIcon: IconWorld,
  crossBorderFilledIcon: IconWorldFilled,
  /* ★ R1（2026-11-21）：改为**项目内联实心剪影**（原 Tabler 线描 20px 下糊成一坨） */
  ferryIcon: IconFerrySolid,
  planeIcon: IconPlaneSolid,
  /* ── ★ R5/R6（2026-11-21）：**图层键**图标 ────────────────────────────────
     语义名 `layers` = Tabler `IconStack2`（三层叠板；同库 3.47.0、stroke=2 方头方角）。
     · 为什么换掉原来的 `pin`：地图针「图钉」表达不了「图层」，还会与站点点位混淆；
     · **零长度段 = 0**（三条 path 全是实线折线，无 `.01` 点）⇒ 直接过
       `.verify/audit-icon-dots.mjs`，**不需要**任何内联件或门禁特例；
     · 该图标由「页面级浮动键」`.nav-layer-btn` 消费（见 `NavShell.tsx` / `globals.css`）。 */
  layers: IconStack2,
};

export type IconName = keyof typeof REGISTRY;

export interface IconProps {
  /** 语义名（见 REGISTRY；未知名 → 不渲染） */
  name: IconName | string;
  /** 尺寸（★ 仅 16 / 20 / 24） */
  size?: IconSize;
  className?: string;
  /** 无障碍名（给了则不再标 aria-hidden） */
  "aria-label"?: string;
  /** 其余原样透传到 `<svg>` */
  [key: string]: unknown;
}

export default function Icon({ name, size = 20, className, ...rest }: IconProps) {
  const Cmp = REGISTRY[name as string];
  if (!Cmp) return null;
  const labeled = !!rest["aria-label"];
  return (
    <Cmp
      size={size}
      stroke={2}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      className={`mm-icon${className ? ` ${className}` : ""}`}
      aria-hidden={labeled ? undefined : true}
      focusable={false}
      {...rest}
    />
  );
}
