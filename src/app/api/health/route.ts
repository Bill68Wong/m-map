/**
 * GET /api/health —— 部署健康检查 + 静态数据缓存观测（v3.6.1）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   外部（uptime 探测 / 团队成员 / 运维）**只读**判定两件事：
 *     ① 服务活着；
 *     ② `unstable_cache` 的跨实例 Data Cache **是否真的在写** ——
 *        `segment_stats` 序列化 ≈3MB 超 Next 单条 2MB 上限后，生产是
 *        `console.warn` + 静默跳过（不抛错不 500），只看日志永远发现不了。
 *        详见 `src/lib/recommend/query.ts` 的 v3.6.1 观测段。
 *
 * ── 鉴权 / 门禁 ───────────────────────────────────────────────────────
 *   公开只读（GET，无凭据、无写库）。口令门已拆除（ADR-106）；
 *   门禁脚本 `check-api-guards.ts` 只校验写方法（GET 不校验）⇒ 无需登记白名单。
 *   响应**不含任何内部信息**（无密钥状态、无连接串、无 SQL）—— AC-50d 口径。
 *
 * ── 缓存 ──────────────────────────────────────────────────────────────
 *   `Cache-Control: no-store`：这是诊断端点，缓存它等于让观测失真。
 */
import { getStaticCacheObs } from "@/lib/recommend/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const staticCache = await getStaticCacheObs();
  return Response.json(
    {
      ok: true,
      /** 当前进程静态数据的 Data Cache 状态 */
      staticCache,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
