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
  IconArrowsLeftRight,
  IconArrowsUpDown,
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
  IconClipboardList,
  IconClock,
  IconCurrentLocation,
  IconDownload,
  IconHome,
  IconHomeFilled,
  IconLock,
  IconMapPin,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconTrash,
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
  origin: IconCircle,
  destination: IconMapPin,
  pin: IconMapPin,
  swap: IconArrowsLeftRight,
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
  /* 数据 / 工具（旧版功能页） */
  records: IconClipboardList,
  stats: IconChartBar,
  timer: IconClock,
  trash: IconTrash,
  lock: IconLock,
  download: IconDownload,
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
