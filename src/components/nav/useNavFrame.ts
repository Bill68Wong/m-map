"use client";

/**
 * 取景指令 hook（src/components/nav/useNavFrame.ts，2026-09-25 · v2.14 · 07 §5.3 / AC-17）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   旧实现把取景意图做成 `view` 的可变对象，依赖 `snap`（面板档位）⇒ **换档/拖动会重取景**。
 *   本 hook 改为**显式指令**：只有 `pickPoint / go / openDetail / contextClose` 等**显式意图**
 *   才调用 `frame()`（tick 自增）；拖面板**不调用** ⇒ 拖动与落定后地图不动。
 *
 * ── 落定后仅被遮挡时微调 ──────────────────────────────────────────────
 *   `reframeOnSettle(slotTopPx)`：只在「上次为 fit-box 且新槽比上次更靠下（更遮挡）」时，
 *   用同一 box 重新取景一次；否则**不动**。
 *
 * ⚠️ NavMap 侧仍自算 fit（禁 `setBounds`/`setFitView`）——本 hook 只负责「何时下令」。
 */
import { useCallback, useRef, useState } from "react";

export type FrameMode = "dest-center-top" | "fit-two" | "fit-box" | "none";

export interface FrameBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface FrameCmd {
  mode: FrameMode;
  box?: FrameBox;
  slotTopPx?: number;
}

/** 交给 `NavMap` 的 `view` prop（含 tick：同模式连续触发也生效） */
export interface FrameView extends FrameCmd {
  tick: number;
}

export interface UseNavFrame {
  /** 传给 `NavMap` 的 `view` */
  view: FrameView;
  /** 显式下令取景（pickPoint / go / openDetail / contextClose） */
  frame: (c: FrameCmd) => void;
  /** 面板档位落定后：仅被遮挡时微调（拖动中不调用） */
  reframeOnSettle: (slotTopPx: number) => void;
}

export function useNavFrame(): UseNavFrame {
  const [view, setView] = useState<FrameView>({ mode: "none", tick: 0 });
  const tickRef = useRef(0);
  const lastRef = useRef<FrameCmd | null>(null);

  const frame = useCallback((c: FrameCmd) => {
    lastRef.current = c;
    tickRef.current += 1;
    setView({ ...c, tick: tickRef.current });
  }, []);

  const reframeOnSettle = useCallback(
    (slotTopPx: number) => {
      const last = lastRef.current;
      if (!last || last.mode !== "fit-box" || !last.box) return;
      // 仅「新槽更靠下（面板更高 ⇒ 更遮挡）」时才微调；否则不动（拖动/落定后地图保持）
      if (last.slotTopPx != null && slotTopPx <= last.slotTopPx + 4) return;
      frame({ ...last, slotTopPx });
    },
    [frame],
  );

  return { view, frame, reframeOnSettle };
}
