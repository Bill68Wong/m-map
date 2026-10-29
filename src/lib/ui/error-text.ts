/**
 * 接口错误码 → 用户可读文案（src/lib/ui/error-text.ts，v3.6.0 · S2）
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────────
 *   v3.6.0 起，服务端不再把异常原文回吐给客户端（原来会回显 SQL / 表名 / 连接错误），
 *   一律换成人机无关的固定枚举（`lib/http/errors.ts` 的六值闭集）。
 *   但客户端若直接 `setErr(j.error)`，用户屏幕上就会出现 `upstream_error` 这种英文标识，
 *   既看不懂，也会撞文案门禁 `.verify/check-ui-copy.mjs`（禁用内部字段名）。
 *   ⇒ 所有渲染接口错误的界面，必须先过本函数。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────
 *   · **纯函数**（无副作用、无 React、无网络），可在任意环境单测；
 *   · **未知值一律回落通用文案**，绝不把原始 code 上屏（含开发模式，避免养成依赖）；
 *   · 文案是「简体中文 + 不暴露技术细节」，与项目 UI 语言一致。
 */

import { API_ERROR } from "@/lib/http/errors";

/** 六个固定枚举 → 用户文案。键必须与 `API_ERROR` 完全一致（tsc 会校验） */
const TEXT: Record<string, string> = {
  [API_ERROR.unauthorized]: "没有权限访问",
  [API_ERROR.forbidden]: "请求来源不被允许",
  [API_ERROR.gone]: "这个功能已经下线",
  [API_ERROR.rate_limited]: "请求太频繁了，稍等一下再试",
  [API_ERROR.bad_request]: "请求参数有问题",
  [API_ERROR.upstream_error]: "服务暂时不可用，稍后再试",
};

/** 未知错误码/空值的统一回落（比逐场景写兜底更不容易漏） */
const FALLBACK = "出了点问题，稍后再试";

/**
 * ★ **域内错误码**（不属 HTTP 六值闭集，但同样会到达界面）
 *
 * `route_changed` 来自 `lib/recommend/card.ts` 的业务分支（班次已变、算不出详情），
 * 它有自己更具体的说明句；放进同一张表，避免调用方各写一遍三元表达式而漏掉回落。
 * ⚠️ 新增域内码请只加在这里，**不要**往 `API_ERROR` 里塞（那是对外 HTTP 契约）。
 */
const DOMAIN_TEXT: Record<string, string> = {
  route_changed: "这条路线现在的班次变了，暂时算不出来",
};

/**
 * 把接口返回的 `error` 值翻成用户可读文案。
 *
 * @param code 服务端返回的 `error` 字段（可能是枚举、域内码、历史文案、undefined）
 * @returns 用户可读的中文文案；**永远不返回原始 code**
 */
export function errorTextOf(code?: string | null): string {
  if (!code) return FALLBACK;
  return TEXT[code] ?? DOMAIN_TEXT[code] ?? FALLBACK;
}
