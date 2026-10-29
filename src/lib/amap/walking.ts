/**
 * 高德 · **请求期**步行路径客户端（src/lib/amap/walking.ts，v3.6.0 · S5）
 *
 * ── ★★★ 与 `client.ts` 的边界（ADR-107 核心，改动前必读）─────────────────
 *   项目里有**两个**高德步行客户端，职责互斥，**禁止交叉 import**：
 *
 *     · `src/lib/amap/client.ts#walkRoute*` —— **离线专用**。文件头硬规则① 明令：
 *       「绝不在请求时调用」，只允许被 `src/lib/rebuild/**`、`scripts/**`、Cron import。
 *       它内部有 `throttle()` 串行节流 + 与坐标转换耦合，为**批量抓取**设计。
 *     · **本文件** —— **请求期专用**，是"用户在详情页点开步行"这条实时链路的**唯一入口**。
 *       用跨实例令牌桶（多实例下串行节流无效）、短超时、失败收敛为固定枚举。
 *
 *   为什么必须分成两个文件、而不是在 `client.ts` 里加个参数：
 *     ① `client.ts` 的硬规则① 是**防止"顺手在推荐链路里调一次"** 的护栏。一旦它内部
 *        能做请求期的事，这条护栏就变成纸面的 —— 而推荐链路预算是毫秒级的，多一次
 *        外部调用直接把 2s 出卡打成超时。
 *     ② 反之，若让 `rebuild/**` 改用本文件（带令牌桶 + 4s 超时），批量抓几千条会
 *        被 3 QPS 卡死，且每条都吃 4s 超时上限。
 *   ⇒ **两个文件各写各的，谁也不要 import 谁**。要改步行逻辑，先判断它属于哪一侧。
 *
 * ── 契约（架构 §3.3 伪代码 + §4.1.1 端点表）─────────────────────────────
 *   · 端点 `v5/direction/walking`，`show_fields=cost,polyline`（**不带 polyline 就没有几何**）；
 *   · 限流 `acquireWithWait(RATE_BUCKET.walking, 600)`（3 QPS 全 Key 共享，多实例靠
 *     `amap_rate_bucket` 串行化）；
 *   · 超时 **4000ms**（ADR-103：线上真身 iad1、高德在亚太，1500ms 必然超），
 *     可用 `AMAP_WALK_TIMEOUT_MS` 覆盖；
 *   · **缺 `instruction` 或缺 `polyline` 的步 ⇒ 丢弃该步，但不丢整条路径**（几何仍可画）；
 *   · **不做服务端缓存**：路径 30 分钟内确实稳定，但落库/边缘缓存会引入**第二次事故** ——
 *     澳门路网常改道，用户会被导航到旧路，而我们没有任何信号能发现"这条缓存过期了"。
 *     ⇒ 由**客户端**做 5 分钟内存缓存（同 OD），刷新即失效，风险面小得多。别"优化"掉这条。
 *   · **降级不许空白、也不许假**：失败一律固定枚举 `error`（不含高德 info / 堆栈），
 *     前端只显示「直线距离 + 固定步速估算」，**不显示假的分步**（沿用 `track.ts` 纪律）。
 */
import { haversineM, type LatLng } from "./coord";
import { acquireWithWait, RATE_BUCKET } from "./rate-limit";
import { turnOf, type WalkStep } from "@/lib/walk/walk-shared";

/** 步行路径端点（v5） */
export const WALK_ENDPOINT = "https://restapi.amap.com/v5/direction/walking";

/**
 * 请求超时（毫秒）。
 * ★ ADR-103 口径：4000ms，与 `TRANSIT_TIMEOUT_MS` 对齐；运维可用 `AMAP_WALK_TIMEOUT_MS` 覆盖。
 */
export const WALK_TIMEOUT_MS = (() => {
  const v = Number(process.env.AMAP_WALK_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : 4_000;
})();

/** 取令牌的最长等待（毫秒）—— 只等一个令牌的 1/3 QPS 周期，避免把用户卡在队里 */
export const WALK_ACQUIRE_WAIT_MS = 600;

/** 失败原因（固定枚举，直接决定 HTTP 状态码） */
export type WalkError = "rate_limited" | "no_key" | "no_path" | "upstream_error";

export type WalkingResult =
  | {
      ok: true;
      steps: WalkStep[];
      /** 高德自报全线距离（显示用） */
      totalDistM: number;
      /** **几何链末值**（各步 polyline 累加）；前端算 remainM 必须用它，见 `WalkRouteResp.stepsTotalM` */
      stepsTotalM: number;
      totalDurationS: number;
    }
  | { ok: false; error: WalkError };

/**
 * 几何链长度下限比例（S5 评审阻断 ②）：`stepsTotalM < totalDistM × 本值` ⇒ 判定有步被丢弃，直接降级。
 *
 * 0.8 的依据：正常路径的弦长/弧长差实测 ~1.4%（1662 vs 1686），远低于 20%；
 * 而"中间步缺几何"实测能到 33%~62% ⇒ 0.8 把两类彻底分开，不会误伤正常路径。
 */
const GEOM_MIN_RATIO = 0.8;

/**
 * 日调用计数告警（**本轮不建表**，进程内计数 + 阈值 warn）。
 *
 * v5 walking 每月有配额上限（个人认证池）。正常用量远不到顶，但**一旦有人写循环脚本刷**，
 * 几天就能打穿，且高德超限是**静默返回空**（表现为「步行算不出来」），事后极难归因
 * ⇒ 提前用日志给趋势信号。⚠️ 多实例下计数会被打散，**不是精确账单**（精确记账需落表）。
 */
const DAILY_WARN_AT = [1_000, 3_000] as const;
const callCounter = { day: "", n: 0, warned: new Set<number>() };

function countCall(): void {
  const day = new Date().toISOString().slice(0, 10);
  if (callCounter.day !== day) {
    callCounter.day = day;
    callCounter.n = 0;
    callCounter.warned.clear();
  }
  callCounter.n++;
  for (const at of DAILY_WARN_AT) {
    if (callCounter.n >= at && !callCounter.warned.has(at)) {
      callCounter.warned.add(at);
      console.warn(`[walking] 当日步行路径调用已达 ${at} 次（进程内计数，趋势信号非精确账单）`);
    }
  }
}

function getKey(): string {
  const k = (process.env.AMAP_KEY ?? "").trim();
  return k;
}

/** `lng,lat;lng,lat` → `[[lng,lat], ...]`（非法点丢弃；高位精度保留 6 位） */
function parsePolyline(raw: string): [number, number][] {
  const out: [number, number][] = [];
  for (const seg of raw.split(";")) {
    const [lngS, latS] = seg.split(",");
    const lng = Number(lngS);
    const lat = Number(latS);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    out.push([Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
  }
  return out;
}

/** 单步的高德原始形态（v5 walking；字段名按实测） */
interface RawStep {
  instruction?: string;
  road_name?: string | number;
  step_distance?: string | number;
  cost?: { duration?: string | number };
  polyline?: string;
}

interface RawPath {
  distance?: string | number;
  cost?: { duration?: string | number };
  steps?: RawStep[];
}

interface RawJson {
  status?: string;
  info?: string;
  infocode?: string;
  route?: { paths?: RawPath[] };
}

/**
 * 取步行分步路径（请求期）。
 *
 * @param origin 起点（**GCJ-02**，原样送高德；本文件**不做**坐标转换）
 * @param dest   终点（同上）
 */
export async function fetchWalkingSteps(origin: LatLng, dest: LatLng): Promise<WalkingResult> {
  const key = getKey();
  if (!key) {
    console.error("[walking] 缺少 AMAP_KEY，无法请求步行路径");
    return { ok: false, error: "no_key" };
  }

  // 跨实例令牌桶：3 QPS 全 Key 共享；短等 600ms，等不到即降级（不把用户卡在队列里）
  const token = await acquireWithWait(RATE_BUCKET.walking, WALK_ACQUIRE_WAIT_MS);
  if (!token.ok) return { ok: false, error: "rate_limited" };

  const qs = new URLSearchParams({
    origin: `${origin.lng.toFixed(6)},${origin.lat.toFixed(6)}`,
    destination: `${dest.lng.toFixed(6)},${dest.lat.toFixed(6)}`,
    key,
    // ★ 必须带 polyline，否则响应里没有几何（架构 §3.3 实测）
    show_fields: "cost,polyline",
  });

  countCall();

  let json: RawJson | null = null;
  try {
    const res = await fetch(`${WALK_ENDPOINT}?${qs}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(WALK_TIMEOUT_MS),
    });
    json = (await res.json()) as RawJson;
  } catch (e) {
    // 超时 / 网络 / JSON 解析：细节只进日志，对外固定枚举
    console.error("[walking] 请求失败：", (e as Error).message);
    return { ok: false, error: "upstream_error" };
  }

  const path = json?.route?.paths?.[0];
  if (json?.status !== "1" || !path) {
    // ★ advisory 2：区分「无路网」与「服务故障」—— 两者对外都是 `no_path`（六值闭集里没有更细的位置），
    //   但排查时完全不同：20003 是「这一带高德没有步行路网」（数据问题，改代码无用），
    //   10003/10005/10044 是参数/密钥/配额（配置问题），其余无 infocode 是上游真故障。
    const info = json?.info ?? "unknown";
    const infocode = json?.infocode ?? "?";
    if (infocode === "20003") {
      console.warn(`[walking] 无步行路网（高德 20003，非服务故障）：info=${info}`);
    } else {
      console.warn(`[walking] 高德返回失败（服务/配置侧）：info=${info} infocode=${infocode}`);
    }
    return { ok: false, error: "no_path" };
  }

  const rawSteps = Array.isArray(path.steps) ? path.steps : [];
  const steps: WalkStep[] = [];
  let cum = 0;

  for (const s of rawSteps) {
    const instruction = typeof s.instruction === "string" ? s.instruction.trim() : "";
    const geom = typeof s.polyline === "string" ? parsePolyline(s.polyline) : [];
    // ★ 缺 instruction 或缺几何（<2 点无法连线）⇒ 丢弃该步，但**不丢整条路径**
    if (!instruction || geom.length < 2) continue;

    // 几何累计里程（连续：下一步 cumStartM = 本步最后一点）
    const cumM: number[] = [cum];
    for (let i = 1; i < geom.length; i++) {
      const a: LatLng = { lng: geom[i - 1][0], lat: geom[i - 1][1] };
      const b: LatLng = { lng: geom[i][0], lat: geom[i][1] };
      cum += haversineM(a, b);
      cumM.push(cum);
    }
    const geomM = cumM[cumM.length - 1] - cumM[0];

    // 显示距离优先用高德 `step_distance`（与文案里的「步行 120 米」一致），缺失才回退几何
    const amapDist = Number(s.step_distance);

    const road = typeof s.road_name === "string" ? s.road_name.trim() : "";
    steps.push({
      idx: steps.length,
      // ⚠️ 占位：turn 依赖「是否最后一步」，而此处还不知道总步数 ⇒ 循环结束后统一回填（见下）
      turn: "straight",
      text: instruction,
      ...(road ? { sub: road } : {}),
      distM: Number.isFinite(amapDist) && amapDist > 0 ? Math.round(amapDist) : Math.round(geomM),
      cumStartM: Math.round(cumM[0] * 10) / 10,
      polyline: geom,
      cumM: cumM.map((m) => Math.round(m * 10) / 10),
    });
  }

  if (!steps.length) {
    // 有路径但每一步都缺必需字段 ⇒ 按"无可用分步"处理（前端走降级，不显示假分步）
    console.warn("[walking] 路径存在但无任何可用分步（缺 instruction / polyline）");
    return { ok: false, error: "no_path" };
  }

  // ★ 统一回填 turn：`arrive` 只在最后一步允许（S5 评审裁定）——
  //   高德在中途步会用「到达新馬路」这类措辞，不拦就会冒出中途到达旗。
  const lastIdx = steps.length - 1;
  for (const s of steps) s.turn = turnOf(s.text, s.idx === lastIdx);

  const amapDist = Number(path.distance);
  const amapDur = Number(path.cost?.duration);
  const totalDistM = Number.isFinite(amapDist) && amapDist > 0 ? Math.round(amapDist) : Math.round(cum);
  const stepsTotalM = Math.round(cum);

  // ★★ 闸门（S5 评审阻断 ②）：几何链比高德自报距离短 20% 以上 ⇒ 说明**有步被丢弃**
  //   （典型：中间步缺 instruction / polyline 只有 1 点）。
  //   此时画出的线会在被丢段落处出现几百米直线横穿街区，且前端「还有 N 米」永远到不了 0。
  //   ⇒ 按本项目自己的纪律「宁可少，不可假」**直接降级**为直线示意（前端走 fallback）。
  //   1.4% 级的弦长/弧长差远低于 20%，正常路径不会误伤。
  if (totalDistM > 0 && stepsTotalM < totalDistM * GEOM_MIN_RATIO) {
    console.warn(
      `[walking] 几何链显著短于高德距离（stepsTotal=${stepsTotalM}m vs 高德=${totalDistM}m，` +
        `比值 ${(stepsTotalM / totalDistM).toFixed(2)} < ${GEOM_MIN_RATIO}）⇒ 判定有步被丢弃，降级`,
    );
    return { ok: false, error: "no_path" };
  }

  return {
    ok: true,
    steps,
    totalDistM,
    stepsTotalM,
    totalDurationS: Number.isFinite(amapDur) && amapDur > 0 ? Math.round(amapDur) : 0,
  };
}
