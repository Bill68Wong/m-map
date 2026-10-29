/**
 * 对外错误响应 · **固定枚举**（src/lib/http/errors.ts，v3.6.0 S2）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────────
 *   v3.5.5 及以前，若干接口把内部异常原文回给客户端（如 `api/nav/route.ts` 的
 *   `msg.slice(0,500)`、`api/fav-routes` 的 `msg.slice(0,300)`）—— 里面可能含
 *   SQL 片段、表名、连接串形态等。拆除访问口令门后全站公开，这些细节不能再外泄。
 *
 * ── 规则（硬约束）────────────────────────────────────────────────────
 *   · 4xx / 5xx 响应体的 `error` 字段**只允许**本文件 `API_ERROR` 里列出的取值；
 *   · 异常原文、堆栈、SQL、环境变量名**只进服务端日志**（`console.error`），不回客户端；
 *   · 客户端可据 `error` 枚举做分支，故取值必须是稳定契约，**不要临时加新串**。
 */

/** 对外可见的错误码（唯一合法取值集合） */
export const API_ERROR = {
  /** 没带凭据 / 凭据不对（写接口）*/
  unauthorized: "unauthorized",
  /** 带凭据但来源不被接受（跨站 / 缺 Origin）*/
  forbidden: "forbidden",
  /** 接口已下线 */
  gone: "gone",
  /** 超出限流配额（客户端应退避后重试）*/
  rate_limited: "rate_limited",
  /**
   * 请求参数 / 请求体不合法。
   * ⚠️ 「请求体超体积上限」也复用本值（状态码用 413）—— 枚举保持 ADR-106 的六值闭集，
   *    不因多一种 HTTP 状态就新增一个对外错误码（客户端按 error 分支，加值就是改契约）。
   */
  bad_request: "bad_request",
  /** 服务端或上游失败（具体原因只进日志）*/
  upstream_error: "upstream_error",
} as const;

export type ApiErrorCode = (typeof API_ERROR)[keyof typeof API_ERROR];

/** 枚举 → 默认 HTTP 状态码（调用方可覆盖） */
const DEFAULT_STATUS: Record<ApiErrorCode, number> = {
  [API_ERROR.unauthorized]: 401,
  [API_ERROR.forbidden]: 403,
  [API_ERROR.gone]: 410,
  [API_ERROR.rate_limited]: 429,
  [API_ERROR.bad_request]: 400,
  [API_ERROR.upstream_error]: 500,
};

/**
 * 构造统一错误响应：`{ ok: false, error: <固定枚举> }`。
 *
 * @param code    固定枚举之一（见 `API_ERROR`）
 * @param status  覆盖默认状态码（不传则用枚举的默认码）
 * @param headers 追加响应头（如 429 的 `Retry-After`）
 */
export function errorResponse(
  code: ApiErrorCode,
  status?: number,
  headers?: Record<string, string>,
): Response {
  // ⚠️ 动态 import 会拉长冷启动，这里用静态 JSON 响应构造（Edge 与 Node 运行时都可用）
  return new Response(JSON.stringify({ ok: false, error: code }), {
    status: status ?? DEFAULT_STATUS[code],
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // ★ v3.6.0（S2）：错误响应一律**不进 CDN / 浏览器缓存**。
      //   410 尤其必须如此 —— HTTP 语义上 410 默认**可缓存**，若被边缘节点记住，
      //   将来恢复某接口时用户会继续看到「已下线」，且我们无法远程清除。
      //   401/403/429 同理：限流窗口是秒级，缓存住就把临时状态固化了。
      "Cache-Control": "no-store",
      ...(headers ?? {}),
    },
  });
}
