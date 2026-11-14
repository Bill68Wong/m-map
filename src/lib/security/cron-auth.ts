/**
 * Cron 端点鉴权（src/lib/security/cron-auth.ts，★ P7 / 2026-11-14）
 *
 * ── 为什么单独抽出来 ──────────────────────────────────────────────────
 *   ① **可测**：`route.ts` 不能导出 HTTP 方法以外的东西（Next App Router 的
 *      路由类型校验会红），判定逻辑留在路由里就永远只能用「起服务 + 打接口」验，
 *      而验证 401 的**反例**（带正确密钥 → 放行）会真跑一次写生产派生表的重算，
 *      没人敢在门禁里做。
 *   ② **口径只有一份**：`internal-token.ts` 是同一套东西的写接口版本，
 *      两处各写一份 `Bearer` 解析，早晚漂移。
 *
 * ── P7 改了什么（与旧实现的唯一实质差异）──────────────────────────────
 *   旧：`CRON_SECRET` 未配置时 → `NODE_ENV !== "production"` 即**放行**。
 *   新：**未配置一律拒绝**，本地也不再放行。
 *
 *   为什么必须收：本地 `npm run dev` 下 `curl localhost:3000/api/cron/rebuild`
 *   会真跑完整重算（实测 8.1s，`segment_samples_window` 扫 207,168 行），
 *   **写入生产派生表**。一条 GET 就能改写线上数据，且失败时静默成功返回 200。
 *   本地手动重算的正规入口改为 `npm run db:rebuild`（见 `scripts/rebuild-derived.ts`）。
 *
 * ── 失败原因只回服务端，不回客户端 ────────────────────────────────────
 *   `reason` 的用途是服务端日志与运维排查；响应体只给统一的 `unauthorized`。
 *   不向调用方透露「是没配密钥还是密钥不对」—— 后者等于给爆破方一个进度条。
 */

import { timingSafeEqual } from "node:crypto";

/** 鉴权失败原因（仅用于服务端日志/诊断，不直接下发） */
export type CronAuthFailure =
  /** 服务端根本没配 `CRON_SECRET`（含配成空串）⇒ 任何请求都不可能通过 */
  | "no_secret"
  /** 配了，但请求没带或不匹配 */
  | "bad_secret";

export type CronAuthResult = { ok: true } | { ok: false; reason: CronAuthFailure };

export interface CronAuthInput {
  /** `Authorization` 头原值（没有传 `null`） */
  authorization: string | null;
  /** 手动触发兼容口 `?key=`；没有传 `null` 或省略 */
  key?: string | null;
}

/**
 * 定长常量时间比较。
 *
 * 长度不同要**先返回**：`timingSafeEqual` 对不等长入参直接抛异常，
 * 包 try/catch 会让「长度不对」走异常路径、耗时与正常比较不同，
 * 等于把长度信息又漏回去。
 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * 判定一次 cron 请求是否放行。
 *
 * @param input `Authorization` 头与 `?key=` 参数（均已取值，不传 req 对象：
 *              这样本函数不依赖 Next 类型，edge/node/脚本都能测）
 * @param secret 期望密钥；默认读 `process.env.CRON_SECRET`。**显式传入仅为可测**，
 *               生产调用方不要传。
 *
 * @example
 *   checkCronAuth({ authorization: null })                    // → { ok:false, reason:"no_secret" }（本地无密钥）
 *   checkCronAuth({ authorization: "Bearer abc" }, "abc")     // → { ok:true }
 *   checkCronAuth({ authorization: "Bearer abcd" }, "abc")    // → { ok:false, reason:"bad_secret" }
 */
export function checkCronAuth(
  input: CronAuthInput,
  secret: string | undefined = process.env.CRON_SECRET,
): CronAuthResult {
  // ★ 空串等同未配置：`CRON_SECRET=` 写进 .env 是很常见的「占位」写法，
  //   若把空串当成有效密钥，`Bearer ` 就成了万能通行证。
  if (!secret) return { ok: false, reason: "no_secret" };

  if (input.authorization && safeEqual(input.authorization, `Bearer ${secret}`)) return { ok: true };
  // 兼容手动触发：`?key=<secret>`（运营用它从浏览器/curl 临时触发）。
  // ⚠️ 已弃用但不删：删了会让现有运维书签立刻失效，且它仍要求同一密钥，
  //   威胁面与 Bearer 相同（都会进访问日志）。新脚本请用 `npm run db:rebuild`。
  if (input.key && safeEqual(input.key, secret)) return { ok: true };

  return { ok: false, reason: "bad_secret" };
}
