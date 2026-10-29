"use client";

/**
 * 步行跟随状态机（src/components/walk/useWalkFollow.ts，v3.6.0 · S5）
 *
 * ── 状态 ──────────────────────────────────────────────────────────────
 *   `preview` → `following` → `arrived`
 *   · `preview`：详情页折叠预览，`currentIdx = -1`（全部按「未走」渲染，不判定位）；
 *   · `following`：用户显式点进来，由 GPS 帧驱动 `lib/walk/follow.ts`；
 *   · `arrived`：剩余 < 30 米（设计 §2.2）。
 *
 * ── 三件必须做对的事 ──────────────────────────────────────────────────
 *   ① **写观测钩子**：`body[data-walk-step]`（**1 起**，PM AC-04 的断言依据）
 *      与 `body[data-walk-off]`；离开 walk 态必须清空（否则残留会让 e2e 误判）。
 *   ② **偏航连续 2 帧才报**（`WALK_OFF_CONFIRM`）：单帧 GPS 漂移在澳门老城区很常见，
 *      一帧就报警会让横幅频繁黄闪。
 *   ③ **偏航/低精度只冻结，绝不回退**（AC-04）—— 回退逻辑在 `follow.ts`，
 *      本 hook 不得再做一次"平滑"，否则两处规则会打架。
 *
 * ── 与 AC-05 的关系（不震动、不响音）────────────────────────────────────
 *   偏航提示**只用视觉 + 文字**。全站至今没有音频/振动能力，
 *   单独为一个交互引入等于新开一类权限与失败模式（iOS 微信内振动还不可靠）。
 *   ⇒ 本 hook **不调用** `navigator.vibrate`，也不要后续"顺手加一个"。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  arrived,
  progressOnPath,
  WALK_OFF_CONFIRM,
  WALK_OFF_M,
  type WalkFix,
  type WalkProgress,
} from "@/lib/walk/follow";
import type { WalkStep } from "@/lib/walk/walk-shared";

export type WalkFollowPhase = "preview" | "following" | "arrived";

export interface UseWalkFollowOpts {
  steps: WalkStep[];
  stepsTotalM: number;
  /** 用户定位（GCJ-02）；null = 无定位 */
  fix: WalkFix | null;
  /** 是否已进入跟随（用户显式点击后为 true）；false = 预览态 */
  following: boolean;
  /** 目的地名称（`arrive` 态文案用） */
  destLabel?: string;
}

export interface UseWalkFollow {
  phase: WalkFollowPhase;
  /** 当前步下标（预览态 = -1） */
  currentIdx: number;
  /** 米级进度（地图切三线用；预览态 ratio=0） */
  progress: WalkProgress;
  /** 是否已确认偏航（连续 2 帧 > 50m） */
  offRoute: boolean;
  /** 偏航米数（取最近一帧，供文案「已偏离路线 50 米」） */
  offM: number;
  /** 定位不可用（精度超门限）⇒ 横幅切 `manual` 态 */
  lowAccuracy: boolean;
  /** 手动「回到路线」：清偏航标记（真正的重新取路在调用方） */
  recover: () => void;
}

/** 预览态的空进度 */
const ZERO: WalkProgress = {
  currentIdx: 0,
  doneInStepM: 0,
  ratio: 0,
  remainM: 0,
  offRouteM: null,
  lowAccuracy: false,
};

export function useWalkFollow(opts: UseWalkFollowOpts): UseWalkFollow {
  const { steps, stepsTotalM, fix, following } = opts;

  const [progress, setProgress] = useState<WalkProgress>(ZERO);
  const [offStreak, setOffStreak] = useState(0);
  const [offM, setOffM] = useState(0);
  const [arrivedNow, setArrivedNow] = useState(false);

  /** 上一帧结果（单调性 / 死区的基准） */
  const prevRef = useRef<WalkProgress | null>(null);

  /** steps 换了（重算/换段）⇒ 进度归零重来；否则会拿着旧步号套新几何 */
  const stepsKey = useMemo(
    () => `${steps.length}|${steps[0]?.text ?? ""}|${Math.round(stepsTotalM)}`,
    [steps, stepsTotalM],
  );
  useEffect(() => {
    prevRef.current = null;
    setProgress(ZERO);
    setOffStreak(0);
    setOffM(0);
    setArrivedNow(false);
  }, [stepsKey]);

  /** 每帧推进（仅 following 态；预览态不判定位，避免"没进跟随却已走 3 步"） */
  useEffect(() => {
    if (!following || !steps.length) return;
    const next = progressOnPath(steps, stepsTotalM, fix, prevRef.current);
    prevRef.current = next;
    setProgress(next);

    /* ② 偏航连续确认（只报视觉，不震动 —— AC-05） */
    const off = next.offRouteM != null && next.offRouteM > WALK_OFF_M;
    if (off) {
      setOffStreak((n) => n + 1);
      setOffM(next.offRouteM ?? 0);
    } else {
      setOffStreak(0);
    }

    /* ③ 到达判定（只进不退：一旦到达不再变回 following） */
    if (!arrivedNow && arrived(next.remainM)) setArrivedNow(true);
  }, [following, steps, stepsTotalM, fix, arrivedNow]);

  /** ⑨ 观测钩子：`body[data-walk-step]`（**1 起**）/ `body[data-walk-off]` / `data-walk-acc` */
  const offRoute = offStreak >= WALK_OFF_CONFIRM;
  useEffect(() => {
    if (!following) {
      // 离开跟随/预览 ⇒ 清干净（残留会让 e2e 误判）
      document.body.removeAttribute("data-walk-step");
      document.body.removeAttribute("data-walk-off");
      document.body.removeAttribute("data-walk-acc");
      return;
    }
    // 1 起（PM AC-04 定稿口径）；预览态由上层不挂 following ⇒ 天然为空
    document.body.setAttribute("data-walk-step", String(progress.currentIdx + 1));
    if (offRoute) document.body.setAttribute("data-walk-off", String(Math.round(offM)));
    else document.body.removeAttribute("data-walk-off");
    if (progress.lowAccuracy) document.body.setAttribute("data-walk-acc", "low");
    else document.body.removeAttribute("data-walk-acc");
  }, [following, progress.currentIdx, progress.lowAccuracy, offRoute, offM]);

  useEffect(
    () => () => {
      document.body.removeAttribute("data-walk-step");
      document.body.removeAttribute("data-walk-off");
      document.body.removeAttribute("data-walk-acc");
    },
    [],
  );

  const recover = useCallback(() => {
    setOffStreak(0);
    setOffM(0);
  }, []);

  const phase: WalkFollowPhase = arrivedNow ? "arrived" : following ? "following" : "preview";

  return {
    phase,
    currentIdx: following ? progress.currentIdx : -1,
    progress: following ? progress : { ...ZERO, remainM: stepsTotalM },
    offRoute,
    offM: Math.round(offM),
    lowAccuracy: progress.lowAccuracy,
    recover,
  };
}
