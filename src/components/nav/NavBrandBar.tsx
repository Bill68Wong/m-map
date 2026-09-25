"use client";

/**
 * 地图品牌栏（src/components/nav/NavBrandBar.tsx，2026-09-25 从 NavShell 拆出 · 07 §5.3）
 *
 * 三栏网格：左=空 · 中=换向键 + 线路标签 · 右=竖排按钮组（刷新 / 公共交通路线 / 定位 / M Map）。
 * 纯展示：数据与回调由 `NavShell` 下发。
 */
import Link from "next/link";
import BrandMark from "@/components/brand/BrandMark";
import Icon from "@/components/ui/Icon";
import RefreshButton from "./RefreshButton";

export interface NavBrandBarProps {
  /** 当前查看的线路（null = 未进入路线查看模式） */
  picked: { label: string; color: string; kind: "bus" | "lrt" } | null;
  canReverse: boolean;
  cooldownSec: number;
  onReverse: () => void;
  onExitLine: () => void;
  onRefresh: () => void;
  onOpenLines: () => void;
  onLocate: () => void;
}

export default function NavBrandBar({
  picked,
  canReverse,
  cooldownSec,
  onReverse,
  onExitLine,
  onRefresh,
  onOpenLines,
  onLocate,
}: NavBrandBarProps) {
  return (
    <div className="nav-brandbar">
      <span className="nav-brandbar__left" aria-hidden="true" />

      <div className="nav-brandbar__mid">
        {picked && canReverse && (
          <button
            type="button"
            className="nav-rev"
            aria-label="切换行驶方向"
            title="切换行驶方向"
            onClick={onReverse}
          >
            <Icon name="exchange" size={20} />
          </button>
        )}
        {picked && (
          <span className="nav-linechip" style={{ background: picked.color }}>
            <span className="nav-linechip__text">{picked.label}</span>
            <button
              type="button"
              className="nav-linechip__x"
              aria-label={`退出路线查看（${picked.label}）`}
              title="退出路线查看"
              onClick={onExitLine}
            >
              <Icon name="close" size={16} />
            </button>
          </span>
        )}
      </div>

      {/* 右栏：竖排按钮组（刷新 → 公共交通路线 → 定位 → M Map） */}
      <div className="nav-brandbar__acts">
        {picked?.kind === "bus" && (
          <RefreshButton cooling={cooldownSec > 0} seconds={cooldownSec} onRefresh={onRefresh} />
        )}
        <button
          type="button"
          className="nav-locate"
          aria-label="公共交通路线"
          title="公共交通路线"
          onClick={onOpenLines}
        >
          <Icon name="records" size={20} />
        </button>
        <button
          type="button"
          className="nav-locate"
          aria-label="定位到我的位置"
          title="定位到我的位置"
          onClick={onLocate}
        >
          <Icon name="locate" size={20} />
        </button>
        {/* 品牌位（★ v2.15.0）：标志 + 字标。标志走内联 SVG ⇒ var(--brand-route/pin)
            随 prefers-color-scheme 自动换亮蓝/亮绿（详见 BrandMark.tsx 头注）。 */}
        <Link href="/help" className="nav-brand" aria-label="M Map · 帮助与合规说明">
          <BrandMark className="nav-brand__mark" size={20} />
          {"M Map"}
        </Link>
      </div>
    </div>
  );
}
