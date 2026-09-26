"use client";
/**
 * 线路名标签组（src/components/RouteStack.tsx，v0.19.1；★ 修复包 v2.2.1-B2 增「分段 / 并列」）
 *
 * ── 形态规范（★ v2.4.1 定案，用户直接定义；权威 = `globals.css` L3209-3301）────────
 *   · **单码** → 主题色实心**圆角矩形**（`--radius-chip` = 6px；白字；12px/700；`--hairline-inset` 细内描边）
 *   · **段内并列**（同站上、同站下，任选其一）→ 各码仍是各自主题色块，相邻侧各切一条**互相平行的斜边**
 *     （`--slash-cut: 7px`）+ 负 `margin-right: -4px`（`--slash-bite`）咬合 ⇒ 中间形成**等宽空白斜间隙**
 *     （视觉缝宽 3px），**缝里露的是卡片背景色**（白卡 ⇒ 白缝）—— **不是 `/` 字符、不是墨底胶囊**；
 *     首块左端竖直 / 末块右端竖直；上限 3 条，第 4 条起折叠为 `+N`（`--muted`）
 *   · **段间换乘**（先后推进）→ **箭头 `→`**，两侧各留 `--space-2`(8px)，一眼看出「这是两段」
 *   · **复合** `A/B → C/D` = 上面两者的组合（两个多码组 + 一个箭头），无新增视觉语汇
 *
 * ── 反例（禁止）───────────────────────────────────────────────────────
 *   ❌ 用斜杠 `/` 表达「并列」，或用斜缝表达「换乘」（段间必须用箭头 `→`）
 *   ❌ 给单码加 `clip-path`（单码恒为干净圆角矩形）；❌ 新增 `--tag-*` Token / 新形态
 *
 * ── 上限 ──────────────────────────────────────────────────────────────
 *   单段内并列 **≤3 条**，第 4 条起折叠为 `+N`（防组过宽撑破头部容器）
 */
import { Fragment } from "react";
import { lineNameOf, sortRouteOptions } from "@/lib/route-label";

/** 单段内并列上限（03 §G.4） */
const MAX_PARALLEL = 3;

/** 一个"段"：段内可有多条并行可选线路 */
export interface RouteSegment {
  codes: (string | null | undefined)[];
}

export default function RouteStack({
  codes,
  segments,
  colorOf,
  colors,
  size = "md",
  className = "",
}: {
  /** 旧入参：**单段**线路码（同段并列）；与 `segments` 二选一（给了 `segments` 以它为准） */
  codes?: (string | null | undefined)[];
  /** ★ B2：**分段结构** —— 段内并列用 `/`、段间换乘用 `→` */
  segments?: RouteSegment[];
  /**
   * 线路码 → 主题色（缺省用主色）。
   * ⚠️ **只允许在 Client Component 之间传**（函数不可跨 RSC 边界序列化）。
   */
  colorOf?: (code: string) => string | null | undefined;
  /**
   * ★ 可序列化的「线路码 → 色」表。
   * **Server Component 必须用本 prop**（不能传 `colorOf` 函数，否则 RSC 序列化报错 ✗）。
   * 二者同时给时**以 `colorOf` 优先**（客户端内部函数更精确）。
   */
  colors?: Record<string, string> | null;
  size?: "sm" | "md";
  className?: string;
}) {
  const resolve = colorOf ?? (colors ? (c: string) => colors[c] : undefined);

  // 规范化：优先 segments；否则把 codes 视作单段。段内排序 = 轻轨在前 + 自然序（已有）。
  const rawSegs: RouteSegment[] = segments && segments.length ? segments : [{ codes: codes ?? [] }];
  const segs = rawSegs
    .map((s) => sortRouteOptions((s.codes ?? []).filter(Boolean) as string[]))
    .filter((s) => s.length > 0);
  if (!segs.length) return null;

  return (
    <span className={`route-stack${size === "sm" ? " route-stack--sm" : ""} ${className}`}>
      {segs.map((list, si) => (
        <Fragment key={si}>
          {/* ★ 段间 = 换乘箭头（§G.1 / §G.4）：粗一档 + muted，两侧 8px */}
          {si > 0 && (
            <span className="route-stack__arrow" aria-hidden="true">
              →
            </span>
          )}
          <span className={`route-stack__group${list.length > 1 ? " route-stack__group--multi" : ""}`}>
            {list.slice(0, MAX_PARALLEL).map((c) => (
              <span
                key={c}
                className="route-stack__seg"
                style={{ background: resolve?.(c) || "var(--primary)" }}
                title={lineNameOf(c)}
              >
                {lineNameOf(c)}
              </span>
            ))}
            {list.length > MAX_PARALLEL && (
              <span
                className="route-stack__more"
                title={list.slice(MAX_PARALLEL).map(lineNameOf).join(" / ")}
              >
                +{list.length - MAX_PARALLEL}
              </span>
            )}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
