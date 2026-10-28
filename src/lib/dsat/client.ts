/**
 * DSAT 客户端（src/lib/dsat/client.ts）
 * 所有对 DSAT 的请求必须经此模块：统一签名、超时、熔断、日限、记账。
 * 任何组件不得绕过本模块直接 fetch DSAT。
 *
 * 接口细节见 docs/DSAT巴士接口调研.md：
 *  - POST {base}/getRouteData.html        线路站点序列
 *  - POST {base}/routestation/bus         实时车辆
 *  - POST {base}/getRouteAndCompanyList.html  全部线路
 */
import { after } from "next/server";
import { genToken } from "./token";
import { DSAT_UA } from "./ua";
import type { BusLocationsPayload, BusPositionsPayload, RouteDataPayload, DsatResult } from "./types";
import { guardDsatCall, logDsatCall } from "../risk";
import { RISK } from "../../config/risk";

const BASE = process.env.DSAT_BASE_URL || "https://bis.dsat.gov.mo:37812/macauweb";

export type DsatPurpose = "timer_grab" | "poll" | "sync" | "recommend" | "live_pos";

/**
 * `routeCode` 本地推导：**线路号右对齐补零到 5 位**（`26→00026` / `51A→0051A` / `MT1→00MT1`）。
 * ⚠️ 是 **5 位不是 6 位**（Spec §5.1，依据 `scripts/track-collect.mjs:146-153` 的 10/10 实测）。
 * ⚠️ 传错**不报错** —— 位置接口照样回 `header:"000"` 但 `data` 为空（静默丢数据）⇒ 调用方须自行判空。
 */
export function routeCodeOf(route: string): string {
  return String(route ?? "")
    .trim()
    .padStart(5, "0");
}

/** 有序参数 → 请求体（token 放请求头，不进 body；参数顺序不可变） */
function buildBody(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * ★ v1.0.5：把记账从「本次请求内 await」改成「响应发出之后再补记」。
 *
 * 动机（线上实测倒逼）：推荐一次页面加载并发 9 次 DSAT 调用，原来每次调用结束都
 *   `await logDsatCall(...)`。函数执行在 iad1（美东）、主库在 ap-southeast-1（新加坡），
 *   单次记账往返 ≈230ms；9 次虽并发，仍把实时层整体拖长约 0.25s，
 *   而**用户真正要的只是班次数据**，记账属后台统计。
 *
 * 语义变化：
 *   · 响应不再等记账 → 用户更快拿到卡片；
 *   · `after()` 由 Vercel 的 waitUntil 托管，保证响应发出后回调仍执行完
 *     （不会像裸 fire-and-forget 那样被实例冻结吞掉）；
 *   · 记账失败依旧只 console.warn，绝不影响班次结果。
 *
 * 回退路径：非请求上下文（`db/sync-routes.ts` 这类脚本直接调用本模块）里
 *   `after()` 不可用会抛错 → 退化为直接调用。脚本进程会等 event loop 清空才退出，
 *   因此日志同样能写完。
 *
 * ⚠️ 副作用（可接受）：熔断判定读的 `dsat_call_logs` 会晚 0.2~0.3s 落库。
 *    判定逻辑是「最近 N 条是否全失败」，晚一点点不影响结论正确性。
 */
function scheduleLog(entry: Parameters<typeof logDsatCall>[0]): void {
  const run = () => {
    void logDsatCall(entry).catch(() => {});
  };
  try {
    after(run);
  } catch {
    run();
  }
}

/**
 * 统一 POST：先过风控守卫，超时即失败，结果记账
 *
 * ★ v1.0.0：`purpose='recommend'`（自动选线）两处特殊处理：
 *   ① **跳过熔断判定**（仍记账）—— 推荐一次页面加载 8~16 次调用，
 *      失败几次属正常波动，不能让它熔断计时器主流程（30 分钟静默）；
 *   ② 用 `RISK.recommend.timeoutMs`（1.5s）而非计时路径的 5s。
 *
 * ★ v2.10.0：`purpose='live_pos'`（实时车辆位置·手动刷新）**照 recommend 同款处理**：
 *   ① 跳过熔断判定 —— 否则用户连点几次刷新、一旦都超时就会撞开全局熔断，
 *      把**计时器的自动车距快照一起静默 30 分钟**（副作用很阴、事后极难排查）；
 *   ② 用 `RISK.livePos.timeoutMs`（3s）—— 比计时 5s 短（刷新要快），
 *      比 recommend 1.5s 长（位置接口响应体更大、含全线站表）。
 */
async function dsatPost<T>(
  path: string,
  params: Record<string, string>,
  purpose: DsatPurpose,
  routeCode?: string,
): Promise<DsatResult<T>> {
  // ★ recommend / live_pos 只记账、不参与熔断判定（见函数头注释）
  const skipBreaker = purpose === "recommend" || purpose === "live_pos";
  if (!skipBreaker) {
    const verdict = await guardDsatCall();
    if (!verdict.allowed) {
      return {
        ok: false,
        error: `风控拦截（${verdict.reason}）：${verdict.detail}`,
        latencyMs: 0,
      };
    }
  }

  const body = buildBody(params);
  const token = genToken(body);
  const timeoutMs =
    purpose === "recommend"
      ? RISK.recommend.timeoutMs
      : purpose === "live_pos"
        ? RISK.livePos.timeoutMs
        : RISK.timerGrab.timeoutMs;

  const started = Date.now();
  let ok = false;
  let httpStatus: number | undefined;
  let error: string | undefined;
  let parsed: unknown;

  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        token, // ★ token 走请求头（与官方前端一致）
        "User-Agent": DSAT_UA, // ★ 合规自证：可识别身份 + 用途（见 ./ua.ts 与 docs/数据来源合规备忘-20260914.md）
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    httpStatus = res.status;
    if (!res.ok) {
      error = `HTTP ${res.status}`;
    } else {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as { data?: unknown; header?: string };
        if (json && typeof json === "object" && "header" in json) {
          // 信封结构：{ data: 载荷, header: 状态码 }
          if (json.header === "1200") {
            error = `接口拒绝（header 1200：token 失效或签名不匹配）`;
          } else {
            parsed = json.data;
            ok = true;
          }
        } else {
          parsed = json;
          ok = true;
        }
      } catch {
        error = `非 JSON 响应（前100字符）：${text.slice(0, 100)}`;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const latencyMs = Date.now() - started;
  // 记账（尽力而为）★ v1.0.5：改为响应后补记，不再阻塞本次请求
  scheduleLog({
    purpose,
    route_code: routeCode,
    ok,
    http_status: httpStatus,
    error,
    latency_ms: latencyMs,
  });

  if (!ok) return { ok: false, error, httpStatus, latencyMs };
  return { ok: true, data: parsed as T, latencyMs };
}

/**
 * 查某线路当前在线车辆（计时器打点时抓取用）
 * dir/routeType：方向值见 sync-routes.ts（双方向 0/1，循环线仅 0）；lang 固定 zh_tw 繁体
 */
export function getBusPositions(
  routeName: string,
  dir: string,
  purpose: DsatPurpose = "timer_grab",
): Promise<DsatResult<BusPositionsPayload>> {  return dsatPost<BusPositionsPayload>(
    "/routestation/bus",
    { action: "dy", routeName, dir, lang: "zh_tw", routeType: dir, device: "web" },
    purpose,
    routeName,
  );
}

/**
 * ★ v2.10.0 新增：查某线路**在途车辆的实时经纬度**（位置接口 `/routestation/location`）
 *
 * ── 为什么单独一个方法（不能复用 getBusPositions）──────────────────────
 *   报站接口（`/routestation/bus`）**不含坐标**，只给「挂载站 + status」；
 *   位置接口**不含站序**，只给「每辆车 lat/lng」。两者结构上互为补集
 *   （见 docs/DSAT巴士接口调研.md §2.5.7），批量实测也证明**无法合并**（§2.5.6）
 *   ⇒ 只能并行各发一趟，由调用方按 `busPlate` 合并。
 *
 * ── 参数（★ 极易踩坑，逐条照抄实测结论）────────────────────────────────
 *   · 参数名是 **`dir`（不是 `direction`）** —— 写错直接 `header:1000`；
 *   · **必须带 `routeCode`** —— 本地推导为**线路号右对齐补零到 5 位**（见 `routeCodeOf`）；
 *   · `lang` 是 **`zh-tw`（短横）** —— 注意与报站接口的 `zh_tw`（下划线）不同。
 *   · 参数顺序与 `scripts/track-collect.mjs#fetchLocation` 保持一致（token 由 body 现算，顺序即签名）。
 *
 * ⚠️ 该接口**不报错只回空**：routeCode 错 ⇒ `header:"000"` 但 `data` 为空 ⇒ 调用方须自行判空。
 */
export function getBusLocations(
  routeName: string,
  dir: string,
  purpose: DsatPurpose = "live_pos",
): Promise<DsatResult<BusLocationsPayload>> {
  return dsatPost<BusLocationsPayload>(
    "/routestation/location",
    { routeName, routeCode: routeCodeOf(routeName), dir, lang: "zh-tw", device: "web" },
    purpose,
    routeName,
  );
}

/** 查线路站点序列 */
export function getRouteData(
  routeName: string,
  dir: string,
): Promise<DsatResult<RouteDataPayload>> {
  return dsatPost<RouteDataPayload>(
    "/getRouteData.html",
    { action: "sd", routeName, dir, lang: "zh_tw", routeType: dir, device: "web" },
    "sync",
    routeName,
  );
}

/** 全部线路+公司清单 */
export function getRouteAndCompanyList(): Promise<
  DsatResult<{
    /** 公司列表（色名 Blue/Orange → 名称） */
    companyList?: { color?: string; name?: string }[];
    /** 全量线路（routeName=线路码；direction=2 为循环线标记；color=公司色名） */
    routeList?: { routeName?: string; color?: string; direction?: string; routeChange?: string }[];
  }>
> {
  return dsatPost("/getRouteAndCompanyList.html", { lang: "zh_tw", device: "web" }, "sync");
}
