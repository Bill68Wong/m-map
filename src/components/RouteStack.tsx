"use client";
/**
 * 线路名标签组（src/components/RouteStack.tsx，v0.19.1；★ 修复包 v2.2.1-B2 增「分段 / 并列」）
 *
 * ── 形态规范（03-设计方向 §G.1~G.4，用户直接定义）──────────────────────
 *   · **单码** → 主题色实心**圆角矩形**（radius 6px；白字；12–13px/700）
 *   · **段内并列**（同站上、同站下，任选其一）→ 各码仍是各自主题色圆角矩形，
 *     中间用**白斜杠 `/`** 分隔，**整体套一个墨色组胶囊承底**（§G.2 解法 A）——
 *     白斜杠落在墨色底上，**在任意背景上都清晰可见**（白卡上也成立）
 *   · **段间换乘**（先后推进）→ **箭头 `→`**，两侧留 `--space-2`(8px)，
 *     一眼看出"这是两段"而不是一条长组
 *   · **复合** `A/B → C/D` = 上面两者的组合（两个组胶囊 + 一个箭头），无新增视觉语汇
 *
 * ── 反例（§G.3，禁止）─────────────────────────────────────────────────
 *   ❌ 斜切梯形（旧 `clip-path: polygon(...)`）→ 组胶囊内**强制 `clip-path: none`**
 *   ❌ 多码写成 `25/MT4` 无间距（斜杠左右须各留 1–3px）
 *   ❌ 用斜杠表达"换乘"（斜杠=并列，箭头=先后，语义不同）
 *
 * ── 上限（§G.4）───────────────────────────────────────────────────────
 *   单段内并列 **≤3 条**，第 3 条起折叠为 `+N`（防胶囊过宽撑破 `.rc-head`）
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
