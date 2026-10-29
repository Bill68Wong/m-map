"use client";

/**
 * 站序列表（src/components/line/LineStopList.tsx，v3.6.0 · S6）
 *
 * ── 职责边界 ────────────────────────────────────────────────────────────
 *   只负责「把站序渲染成 <ol>」，报站数据由 `useLazyEta` 提供、换乘信息由调用方
 *   算好传进来。保持本文件在 100 行内，方便单看「列表结构」而不被网络逻辑淹没。
 *
 * ── 序号为什么不显示 ────────────────────────────────────────────────────
 *   设计 §2.8：90 余站每行带序号会让列表变成表格。顺序靠**竖线串联 + 首末站实心**表达。
 *
 * ── 首末站判定 ──────────────────────────────────────────────────────────
 *   `index === 0 || index === total - 1` —— 前端自算，**不需要接口给标记**。
 *   （26 路这类环线首末同站，两端都是实心，视觉上正好表达「绕回来了」。）
 */
import LineStopRow from "./LineStopRow";
import type { EtaState } from "./useLazyEta";
import { mainOf, type LineStop } from "@/lib/line/line-shared";

export interface LineStopListProps {
  stops: LineStop[];
  color: string;
  /** 取某站报站三态 */
  etaOf: (code: string) => EtaState;
  /** 登记 DOM（懒加载用） */
  registerEl: (code: string, el: HTMLElement | null) => void;
  /** 主码 → 该站停靠的全部线路码（用于算换乘）；未加载完时为空 Map */
  linesOfStation: Map<string, string[]>;
  /** 本线线路码（算换乘时排除自己） */
  lineCode: string;
}

/** 换乘列最多显示的线路条数（设计 §2.8：最多列 3 条） */
const MAX_XFER = 3;

export default function LineStopList({
  stops,
  color,
  etaOf,
  registerEl,
  linesOfStation,
  lineCode,
}: LineStopListProps) {
  return (
    <ol className="lp-list">
      {stops.map((stop, i) => {
        // 换乘 = 该主码停靠的线路里去掉本线，最多 3 条
        const all = linesOfStation.get(mainOf(stop.code)) ?? [];
        const xfer = all.filter((l) => l !== lineCode).slice(0, MAX_XFER);
        return (
          <LineStopRow
            key={`${stop.seq}-${stop.code}`}
            stop={stop}
            index={i}
            total={stops.length}
            color={color}
            eta={etaOf(stop.code)}
            xfer={xfer}
            registerEl={registerEl}
          />
        );
      })}
    </ol>
  );
}
