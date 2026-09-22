"use client";

/**
 * 底部主导航（src/components/BottomNav.tsx，M Map 改版 S4）
 *
 * ── 结构（PRD §9 / 设计 E.1；★ v2.10.0 增第 3 个 tab）──────────────
 *   三个 Tab：**首页**（`/`）· **路线收藏**（`/favorites`）· **帮助**（`/help`）。
 *   · 高 `var(--tabbar-h)` + `env(safe-area-inset-bottom)`；顶边 1px 发丝线；**不透明底**（不用毛玻璃）；
 *   · 选中态：**双通道** —— ① 图标切**实心变体** ② 文字加粗；再叠**青花蓝**（不只靠颜色，利于色盲）；
 *   · 命中区：每 tab 半屏宽、高 ≥48px；
 *   · 收藏 tab 有内容时右下角一个 6px 强调色圆点（**不写数字**，避免「红点焦虑」）。
 *
 * ── 挂载策略（ADR-003）────────────────────────────────────────────────
 *   **页级组件**，只挂在首页 / 收藏页（`/about` 亦挂）；**不挂全局布局**
 *   （挂全局会波及 `/commute`、`/nav` 等旧页 → 大面积回归）。
 *
 * ⚠️ SSR 首帧 `useCombos` 恒为空 → 收藏圆点首帧不渲染（`mounted` 守卫，防 hydration 失败）。
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon, { type IconName } from "@/components/ui/Icon";
import { useCombos } from "@/lib/favorites/useCombos";

interface TabDef {
  key: "home" | "favorites" | "help";
  href: string;
  label: string;
  /** 未选态图标（线性） */
  icon: IconName;
  /** 选中态图标（实心变体 —— 第二通道） */
  iconOn: IconName;
  match: (p: string) => boolean;
}

const TABS: TabDef[] = [
  {
    key: "home",
    href: "/",
    label: "首页",
    icon: "home",
    iconOn: "homeFilled",
    // 首页高亮：`/` 与 `/nav` 系（结果/详情归属首页）
    match: (p) => p === "/" || p.startsWith("/nav"),
  },
  {
    key: "favorites",
    href: "/favorites",
    label: "路线收藏",
    icon: "bookmark",
    iconOn: "bookmarkFilled",
    match: (p) => p.startsWith("/favorites"),
  },
  {
    // ★ v2.10.0：第 3 个 tab「帮助」（`/help`；旧 `/about` 已 308 重定向到此）
    key: "help",
    href: "/help",
    label: "帮助",
    icon: "help-circle",
    iconOn: "help-circle",
    match: (p) => p.startsWith("/help") || p.startsWith("/about"),
  },
];

export default function BottomNav() {
  const pathname = usePathname();
  const favs = useCombos();
  const hasFav = favs.mounted && favs.combos.length > 0;

  return (
    <nav className="bottom-nav" aria-label="主导航">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.key}
            href={t.href}
            className={`bottom-nav__tab${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="bottom-nav__icon">
              <Icon name={active ? t.iconOn : t.icon} size={24} />
              {t.key === "favorites" && hasFav && <span className="bottom-nav__dot" aria-hidden="true" />}
            </span>
            <span className="bottom-nav__label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
