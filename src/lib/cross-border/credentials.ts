/**
 * 机场 FIDS 凭据读取（src/lib/cross-border/credentials.ts，★ P4 / 2026-11-14）
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────
 *   「凭据有没有配」这件事要**两处同时**知道，而两处各读一次 `process.env` 必然漂移：
 *     ① `airport/fetch.ts` —— 真去拉的时候要拿值（拿不到抛错）；
 *     ② `airport/flights/route.ts` —— 拉之前要判断，**没配就根本不该试**
 *        （试了上游必 403，每请求多打一条"采集失败"日志，还把归因带偏成"上游挂了"）。
 *   判定与取值收在这一个纯函数里，门禁脚本可以喂假 env 直接断言，不必起服务。
 *
 * ── 为什么"未配"必须在**所有环境**都算未配 ────────────────────────────
 *   旧缺陷（P4）不是"没配凭据"，而是**没配凭据的后果说错了**：接口回 503
 *   `upstream_error`，前端显示「可能是上游（政府接口）或我们的采集出了问题」。
 *   用户与运维都会去查上游，而真相是"部署方没配一个环境变量"。
 *   ⇒ 本文件只负责如实回答"有没有配"，**不看 `NODE_ENV`**：
 *     凭据缺失在任何环境都不可能拉到数据，环境差异不该影响这个事实。
 *     （对比 `lib/security/cron-auth.ts` 的 P7：那边是"未配密钥 ⇒ 一律拒绝"，
 *      同理不看 NODE_ENV；两处的共同纪律是"缺少配置不得被环境变量悄悄放过"。）
 *
 * ── 空串等同未配 ──────────────────────────────────────────────────────
 *   `.env` 里写 `AACM_APPCODE=`（占位、注释掉又手滑删 `#`）是极常见的形态。
 *   若把空串当"已配置"，路由就不短路、每请求真打一次上游，带着
 *   `Authorization: APPCODE `（空值）—— 又是一个"看起来在采集"的假象。
 *
 * ⚠️ 值本身**不得**出现在日志、错误消息或响应里（本仓库曾因凭据泄漏被封号，
 *    见 `docs/复盘-GitHub封号事故-20261028.md`）。本文件只把值交给调用方，
 *    不打印、不拼接任何含值的字符串。
 */

/** 环境变量名（写死一处，`fetch.ts` 与路由都从这里取，README/门禁也引用它） */
export const AACM_APPCODE_ENV = "AACM_APPCODE";

/** 可注入的 env 形状（`process.env` 天然满足；显式传入**仅为可测**） */
export type EnvLike = Record<string, string | undefined>;

/**
 * 读出实际可用的凭据值；未配 / 空串 / 纯空白 ⇒ `""`。
 *
 * 为什么要 `trim()`：HTTP 头里值两边多一个空格，上游会当成另一个凭据直接 401/403。
 * 环境变量里带行尾空格（Windows 编辑器、从网页复制时很常见）不该变成"配了却用不了"。
 */
export function readAacmAppcode(env: EnvLike = process.env): string {
  const raw = env[AACM_APPCODE_ENV];
  // 非字符串（某些运行时会注入 undefined）一律当未配，不做 String() 转换 ——
  // `String(undefined)` 会得到字面量 "undefined"，那是比"未配"更糟的假阳性。
  return typeof raw === "string" ? raw.trim() : "";
}

/** 是否配置了可用凭据（路由据此决定"要不要试采集"与"空结果怎么归因"） */
export function hasAacmAppcode(env: EnvLike = process.env): boolean {
  return readAacmAppcode(env) !== "";
}
