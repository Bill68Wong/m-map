import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "M Map", template: "%s · M Map" },
  description: "澳门巴士 / 轻轨全澳导航：全屏地图、路线收藏与实时报站",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /**
   * ★ v2.4.1：**禁止整页缩放**（用户 2026-09-21 拍板：「理论上仅地图区域允许缩放」）。
   *
   * ⚠️ 此处**推翻了 v1.1.7 的决定**。原决定（见 `docs` 与 git 历史）是：站内有 12px 小字，
   *    光线差或年长用户读不到却放不大，违反 WCAG 1.4.4 的缩放要求，故放开到 5 倍。
   *    用户重新权衡后选择「交互稳定优先」，因为整页可缩放带来两个实际困扰：
   *      ① **搜索框聚焦时页面自动放大**（输入框字号 < 16px 触发浏览器行为）；
   *      ② 路线页滑动时**双指易误触发**缩放。
   *    **补偿（已落地）**：站内最小字号由 11px 提到 13px（见 `--text-xs`），
   *      降低对「放大读小字」的依赖。
   *    ⚠️ 地图自身的手势缩放**不受影响** —— 高德 JS API 自行监听 touch 事件处理缩放，
   *      与 viewport 的 `user-scalable` 无关。
   */
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F2F4F0" },
    { media: "(prefers-color-scheme: dark)", color: "#111318" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
