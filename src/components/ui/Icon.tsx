/**
 * 全站唯一图标出口（src/components/ui/Icon.tsx，M Map 改版 S6）
 *
 * ── 为什么自研包装（Spec §7 工程方案锁定）────────────────────────────
 *   全站**只从 `<Icon>` 出图标** —— 单一入口、单一风格真源：
 *     · 内部**固定** `stroke={2}` / `strokeLinecap="butt"` / `strokeLinejoin="miter"`
 *       （方向 A「站牌」= 2px 方头方角）；
 *     · `size` 限**联合类型** `16 | 20 | 24` 三档，**不得混用**（§8）；
 *     · 24 viewBox、`fill="none"`、`stroke="currentColor"`（随文字色）。
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
  IconGauge,
  IconHome,
  IconHomeFilled,
  IconInfoCircleFilled,
  IconListDetails,
  IconLock,
  IconMapPin,
  IconPlayerPlay,
  IconRefresh,
  IconRoute2,
  IconSearch,
  IconTrash,
  IconArrowBackUp,
  IconDots,
  IconGripVertical,
  IconPencil,
  IconPinned,
  IconPlus,
  IconTrain,
  IconWalk,
  IconX,
} from "@tabler/icons-react";

/** ★ 仅此三档，不得混用（§8） */
export type IconSize = 16 | 20 | 24;

/** 语义名 → Tabler 图标组件（唯一映射表） */
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
     · `info-circle`（到站横幅「i」· **安全级元素，图标须完整**）→ `IconInfoCircleFilled`
       （原 `IconInfoCircle` 的 i 点 = 零长度段 `h.01`；实心版以**镂空**呈现 i ⇒ 完整可见）
     · `list` → `IconListDetails`（原 `IconList` 的项目符号 = 零长度段 ×3）
     ⚠️ 所有选择：Tabler **同库 3.47.0**（不混库），size/stroke 风格不变。 */
  "help-circle": IconBook,
  "info-circle": IconInfoCircleFilled,
  list: IconListDetails,
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
