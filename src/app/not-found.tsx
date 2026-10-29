/**
 * 全站 404 页（src/app/not-found.tsx，v3.6.0）
 *
 * ── 为什么必须有这个文件 ────────────────────────────────────────────────
 *   S6 的 `/line/[code]` 在「线路码不存在」时会调 `notFound()`。
 *   此前项目**没有** `not-found.tsx` ⇒ Next 渲染它内置的英文页
 *   「This page could not be found.」—— 而本站界面文案一律简体中文，
 *   突然蹦一句英文既跳戏，也没告诉用户"下一步该干什么"。
 *
 * ── 设计口径 ────────────────────────────────────────────────────────────
 *   · 只给一个动作：**回首页**（这也是唯一的出口，不给"重试"——
 *     404 不是可恢复错误，重试同一个 URL 还是 404）；
 *   · 不显示任何技术信息（状态码、路径）—— §AC-50d 的同类纪律：
 *     响应体/界面都不向用户暴露内部标识；
 *   · 用 `<a href="/">` 而不是 `router.back()`：用户可能是直接输 URL / 从外链进来的，
 *     后退会把他退出站点。
 *
 * ⚠️ 刻意**不**标 `"use client"`：本组件无 hooks / 事件，保持 Server Component
 *    可少发一份客户端 JS（404 页也要尽量轻）。
 */
import Link from "next/link";
import Icon from "@/components/ui/Icon";

export default function NotFound() {
  return (
    <main className="nf">
      <div className="nf__box">
        <span className="nf__mark" aria-hidden="true">
          <Icon name="help-circle" size={24} />
        </span>
        <h1 className="nf__title">找不到这个页面</h1>
        <p className="nf__body t-muted">
          链接可能已经失效，或者地址输错了。
        </p>
        <Link href="/" className="btn btn--primary btn--sm nf__act">
          回到首页
        </Link>
      </div>
    </main>
  );
}
