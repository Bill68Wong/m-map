"use client";
/**
 * 线路名标签组（src/components/RouteStack.tsx，★ v3.2.0 回归 **v0.19.1「谷歌地图风格」**）
 *
 * ── 形态规范（v0.19.1 · 需求 13 定稿；权威 = `globals.css` 的 B2 段）──────────────
 *   · **整「段」（组）= 一个圆角外框**（`--radius-chip` 6px + `overflow:hidden`，**逐组裁剪**）；
 *   · **块** = 右倾平行四边形（`clip-path`，md 斜切 8px / sm 6px），白字 13px·700、水平垂直居中；
 *   · **块间** = 相邻块 `margin-right: -5px`（sm -4px）**咬合** ⇒ 留出 3px（sm 2px）的
 *     「/」形**负空间留白缝**（露出父级卡片底色，**不是 `/` 字符、不是黑块**）；
 *   · **首块**左端竖直 / **尾块**右端竖直 ⇒ 保留组右上/左下的完整圆角；
 *   · **单块** = 干净圆角矩形（`clip-path:none`），左右不斜切；
 *   · **段间换乘**（先后推进）→ **箭头 `→`**，两侧各留 `--space-2`(8px)，一眼看出「这是两段」；
 *   · 上限 3 条并列，第 4 条起折叠为中性尾块 `+N`（`--surface-2`/`--muted`）。
 *
 * ── 现代方案（根治历史缺陷）────────────────────────────────────────────
 *   v2.2.1 曾为支持多段换行把**顶层容器** `overflow` 改 `visible` ⇒ 容器圆角失去裁剪对象
 *   ⇒ **容器圆角碎裂**。本批把「圆角 + `overflow`」**下沉到每个 `__group`**（逐组独立裁剪）
 *   ⇒ 单段 = 连续圆角外框；多段换行时每组各自成框、组间由 `→` 分隔，互不切角。
 *
 * ── 反例（禁止）───────────────────────────────────────────────────────
 *   ❌ 用 `/` 字符表达「并列」（缝是**负空间**，不是字）；❌ 用斜缝表达「换乘」（段间必须 `→`）；
 *   ❌ 给单块加 `clip-path`；❌ 新增 `--tag-*` Token / 新形态。
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
  fold = true,
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
  /**
   * ★ R9（2026-11-20）：段内并列**是否折叠**为 `+N` 尾块。
   *
   * - `true`（**默认**）= 现有行为：段内最多 3 块，第 4 条起显示 `+N`。
   *   窄位置（推荐卡头部 / 时间线行内）必须保留，否则挤爆卡片。
   * - `false` = 全列线名，不折叠、不出 `+N`。目前**只有导航模式头部**用它
   *   （`NavDetailBody`：那里空间足够，用户明确要求"所有线路完整显示线名"）。
   *
   * ⚠️ 默认值刻意保持 `true`：所有既有调用点**零改动、零视觉变化**；
   *   新增行为只发生在显式传 `fold={false}` 的那一处。
   * ⚠️ 不折叠时若线名过多会依赖外层 `flex-wrap` 换行（`.rc-dhead__r` 已有 wrap）
   *   ⇒ 行高可能增加，属可接受代价；不要为此去动 `.rc-dhead__r` 的 `max-width`。
   */
  fold?: boolean;
}) {
  const resolve = colorOf ?? (colors ? (c: string) => colors[c] : undefined);
  /** ★ R9：段内并列上限。`fold === false` ⇒ 不设上限（全列） */
  const parallelLimit = fold ? MAX_PARALLEL : Number.POSITIVE_INFINITY;

  // 规范化：优先 segments；否则把 codes 视作单段。段内排序 = 轻轨在前 + 自然序（已有）。
  const rawSegs: RouteSegment[] = segments && segments.length ? segments : [{ codes: codes ?? [] }];
  const segs = rawSegs
    .map((s) => sortRouteOptions((s.codes ?? []).filter(Boolean) as string[]))
    .filter((s) => s.length > 0);
  if (!segs.length) return null;

  return (
    <span
      className={`route-stack${size === "sm" ? " route-stack--sm" : ""} ${className}`}
      /* ★ v3.2.0（Spec §2 / AC-89~91）：标签形状版本钩子（只读，QA 断言用） */
      data-tag-shape="v0191"
    >
      {segs.map((list, si) => (
        <Fragment key={si}>
          {/* ★ 段间 = 换乘箭头（§G.1 / §G.4）：粗一档 + muted，两侧 8px */}
          {si > 0 && (
            <span className="route-stack__arrow" aria-hidden="true">
              →
            </span>
          )}
          <span className="route-stack__group">
            {/* ★ v3.2.0（需求 13）：同段并列 = 块间 **「/」形负空间留白缝**（`margin-right:-5px`
                咬合 + `clip-path` 斜切；**不是 `/` 字符、不是黑块**）—— 详见 globals.css B2 段。 */}
            {list.slice(0, parallelLimit).map((c) => (
              <span
                key={c}
                className="route-stack__seg"
                style={{ background: resolve?.(c) || "var(--primary)" }}
                title={lineNameOf(c)}
              >
                {lineNameOf(c)}
              </span>
            ))}
            {fold && list.length > MAX_PARALLEL && (
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
