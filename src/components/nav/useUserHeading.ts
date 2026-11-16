"use client";

/**
 * 蓝点朝向的**合成层**（src/components/nav/useUserHeading.ts，★ 2026-11-15 · F3）
 *
 * ── 它解决的问题 ──────────────────────────────────────────────────────
 *   F1 给了两个零件：**传感器通道**（`useCompassHeading`，罗盘）与
 *   **降级链判定**（`lib/compass/heading.ts#pickHeadingMode`，罗盘 → GPS 行进方向 → 正北）。
 *   但没人把它们接起来 —— 于是箭头层（F2）只能拿到 `null`，永远不显示。
 *   本 hook 就是那根线：**取两条来源 → 选一条 → 输出一个 `heading`**。
 *
 * ── 为什么单独成 hook，而不是塞进 NavShell ────────────────────────────
 *   · NavShell 已经 3000 行，且它的注释里反复强调"声明顺序有坑"（hook 之间的隐式依赖）；
 *   · 选源是**纯判定**（走 `resolveHeading`），塞进宿主就无法单测；
 *   · 本 hook 的输入只有 `enabled` + `fix`，输出只有四个字段 ⇒ 宿主只负责传值。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────────
 *   ① **不自动弹权限框**：iOS 的 `requestPermission()` 必须在用户手势里，本 hook 只在
 *      调用方显式调 `requestAccess()` 时申请（宿主把它挂在「开始导航 / 开始步行」点击上）；
 *   ② **不知道就不画**：正北兜底返回 `heading: null`（理由见 `resolveHeading` 注释）；
 *   ③ **非步行态一律关掉**：`enabled=false` ⇒ 不挂传感器、不画箭头（`resolveHeading` 已封）。
 *
 * ── 观测钩子 ──────────────────────────────────────────────────────────
 *   `body[data-compass]`（F1 写，状态）· `body[data-heading-src]`（本 hook 写，`compass|course|north|off`）
 *   —— 两者都**不写角度**，与 `data-user-fix` 同一口径。
 */
import { useEffect, useRef, useState } from "react";
import {
  fixHeadingOf,
  fixSpeedOf,
  resolveHeading,
  type HeadingMode,
} from "@/lib/compass/heading";
import { compassNeedsGesture, useCompassHeading, type CompassStatus } from "./useCompassHeading";
import { takeCalibrateTicket } from "./compass-note";
import type { UserFix } from "./useUserFix";

export interface UseUserHeadingResult {
  /**
   * 要画的方向（0 = 正北，顺时针，度）；`null` = **不画**（无可用来源 / 不在步行态）。
   * 直接透传给 `NavMap.userHeading`。
   */
  heading: number | null;
  /** 当前用的是哪一路来源（供提示文案与 QA 断言） */
  mode: HeadingMode;
  /** 传感器通道状态（`listening` / `poor` / `denied` / `unsupported` / `needs_permission` / `idle`） */
  status: CompassStatus;
  /** 本机是否"必须先有一次用户手势"才能开传感器（iOS 为 true） */
  needsGesture: boolean;
  /**
   * ★ F4：本次是否该出「画 8 字校准」那句提示。
   * **每会话只发一次**（磁扰是真的会持续存在，反复提示等于把这句话变成噪音），
   * 之后的磁扰仍会降级，只是改用普通的「读数不稳」文案。
   */
  calibrateHint: boolean;
  /** 申请方向权限 —— **必须在用户手势的同步栈内调用**（返回值只表示本次是否开成功） */
  requestAccess: () => Promise<boolean>;
}

export function useUserHeading(opts: { enabled: boolean; fix: UserFix | null }): UseUserHeadingResult {
  const { enabled, fix } = opts;

  /**
   * GPS 行进方向与速度：既用于降级链选源（F3），也是磁扰判定的**佐证**（F4）。
   * ⚠️ `fusion` 对象每次渲染都是新的，但它进的是 ref（`useCompassHeading` 内部），
   *    不进任何 effect 依赖 —— 否则定位每更新一次就重挂一次传感器监听。
   */
  const courseDeg = fixHeadingOf(fix?.heading);
  const speedMps = fixSpeedOf(fix?.speed);
  const compass = useCompassHeading({ enabled, fusion: { courseDeg, speedMps } });

  /**
   * `needsGesture` 是**设备能力**，与服务端渲染无关。
   * 用 state + effect 而不是在 render 里直接读 `window`：直接读会让首帧（SSR 输出）
   * 与客户端首帧不一致，触发 hydration 警告。
   */
  const [needsGesture, setNeedsGesture] = useState(false);
  useEffect(() => {
    setNeedsGesture(compassNeedsGesture());
  }, []);

  /**
   * ★ F4：校准提示的"每会话一次"。
   * `consumedRef` 不是为了节流，而是为了**挡住 StrictMode 的双跑**：
   * 开发环境 effect 会连续跑两次，第二次若再消费一次票据就会拿到 false，
   * 于是校准提示在本地怎么都看不到（生产环境反而正常）—— 这种"只在开发坏"的
   * 差异极难发现，所以用 ref 记住"本轮已处理"。
   */
  const calibrateConsumedRef = useRef(false);
  const [calibrateHint, setCalibrateHint] = useState(false);
  useEffect(() => {
    if (!enabled || compass.disturbance !== "strong") {
      calibrateConsumedRef.current = false;
      setCalibrateHint(false);
      return;
    }
    if (calibrateConsumedRef.current) return;
    calibrateConsumedRef.current = true;
    setCalibrateHint(takeCalibrateTicket());
  }, [enabled, compass.disturbance]);

  const { mode, heading } = resolveHeading({
    enabled,
    compassHeading: compass.heading,
    quality: compass.quality,
    courseDeg,
    speedMps,
  });

  /** 观测钩子：只写"来源"，不写角度（同 `data-user-fix` 口径） */
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.body.setAttribute("data-heading-src", enabled ? mode : "off");
    return () => document.body.removeAttribute("data-heading-src");
  }, [enabled, mode]);

  return {
    heading,
    mode,
    status: compass.status,
    needsGesture,
    calibrateHint,
    requestAccess: compass.requestAccess,
  };
}
