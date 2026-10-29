"use client";

/**
 * 线路走向小地图（src/components/line/LineMapPane.tsx，v3.6.0 · S6）
 *
 * ── 为什么用内联 SVG 而不是高德地图 ──────────────────────────────────────
 *   本页是**站序全景**，地图只承担「这条线大概怎么走」这一件事（设计给的高度 180px）。
 *   上高德 JS SDK 的代价是：加载 ~200KB 脚本 + 依赖 `AMAP_KEY` + 一个真实的 canvas 生命周期
 *   + 容器尺寸/层叠上下文一堆坑（项目在 `.nav-map-wrap` 上已踩过两次）。
 *   ⇒ 用 SVG 把 polyline 投影到 viewBox，**保留设计要求的双层视觉语言**
 *      （整线灰虚 + 当前方向实线彩色），但零 SDK、零 key、可服务端渲染、可单测。
 *
 * ── 坐标口径（★ 极易踩坑）──────────────────────────────────────────────
 *   `route_shapes.polyline` 是 **GCJ-02**（高德原生）——**直接画，不要再转**！
 *   转一次就是整体偏移几百米。（`/api/stations` 的站点也是 GCJ-02，两者可同图。）
 *
 * ── 降级（坑⑤）──────────────────────────────────────────────────────────
 *   100 条线路里有 **7 条没有 shape**（`26S` / `25BS` / `17S1` / `3AS` / `2AS` / `52S` / `701XS`，
 *   全是 `S` 后缀的区间/特别线，且都 `is_active=true`、会出现在搜索结果里）。
 *   `/api/route-shapes` 对它们返回 `shapes: []` + `note: "no_shape"` ⇒ **绝不白屏**：
 *   显示「暂无线路走向」+ 一个中性占位，站点列表照常展示（与 AC-46「不得留空白」同口径）。
 */
import type { LineShape } from "@/lib/line/line-shared";

export interface LineMapPaneProps {
  /** 线路码（**只用于诊断日志**：方向缺 shape 时要能定位到是哪条线） */
  routeCode?: string;
  /** 全部方向的走向（可能为空 = 无 shape 数据） */
  shapes: LineShape[];
  /** 当前方向（决定哪条画实线彩色） */
  dir: string;
  /** 线路主题色 */
  color: string;
  /** 站点坐标（GCJ-02），用于点缀；可为空 */
  stops: { lat: number | null; lng: number | null }[];
  /** 是否仍在加载走向（避免把「加载中」误显成「无数据」） */
  loading?: boolean;
}

/** `lng,lat;lng,lat` → `[[lng,lat], ...]`（非法点丢弃） */
function parsePolyline(raw: string): [number, number][] {
  const out: [number, number][] = [];
  for (const seg of raw.split(";")) {
    const [a, b] = seg.split(",");
    const lng = Number(a);
    const lat = Number(b);
    if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
  }
  return out;
}

const W = 320;
const H = 180;
const PAD = 10;

export default function LineMapPane({ routeCode, shapes, dir, color, stops, loading }: LineMapPaneProps) {
  const parsed = shapes.map((s) => ({ dir: s.dir, pts: parsePolyline(s.polyline) }));
  const all = parsed.flatMap((p) => p.pts);

  // 无走向数据 ⇒ 降级（不白屏）
  if (!all.length) {
    return (
      <div className="lp-map lp-map--empty" data-map-state={loading ? "loading" : "no_shape"}>
        <span className="lp-map__empty-text">{loading ? "走向加载中" : "暂无线路走向"}</span>
      </div>
    );
  }

  // 经纬度 → viewBox 投影（等距近似；180px 高的小图足够，不必墨卡托）
  const lngs = all.map((p) => p[0]);
  const lats = all.map((p) => p[1]);
  const [minLng, maxLng] = [Math.min(...lngs), Math.max(...lngs)];
  const [minLat, maxLat] = [Math.min(...lats), Math.max(...lats)];
  // 纬度方向：北在上 ⇒ y 取反
  const spanLng = maxLng - minLng || 1e-6;
  const spanLat = maxLat - minLat || 1e-6;
  // 等比缩放（两次取较小者），保证线路不变形
  const scale = Math.min((W - PAD * 2) / spanLng, (H - PAD * 2) / spanLat);
  const offX = (W - spanLng * scale) / 2;
  const offY = (H - spanLat * scale) / 2;
  const px = (lng: number) => offX + (lng - minLng) * scale;
  const py = (lat: number) => H - offY - (lat - minLat) * scale;

  const toD = (pts: [number, number][]) =>
    pts.map(([lng, lat], i) => `${i === 0 ? "M" : "L"}${px(lng).toFixed(1)} ${py(lat).toFixed(1)}`).join(" ");

  const dotStops = stops.filter((s) => s.lat != null && s.lng != null).slice(0, 120);

  /**
   * 当前方向要画实线的 shape。
   *
   * ── ★ 为什么需要兜底（v3.6.0 S6 评审裁决）──────────────────────────────
   *   「每个站序方向都有对应 shape」是一条 **数据不变量**（实测成立：24 条双向线都有
   *   2 条 shape、69 条单 shape 线 dir 完全对齐；`npm run check:shape-coverage` 会持续断言它）。
   *   但**数据不变量不是代码保证** —— 它会被"下次跑采集脚本只抓到一半"破坏，而破坏时
   *   **没有任何编译错误、类型错误、测试失败**；表现只是「地图少画一条线」，用户不会报 bug
   *   （他没觉得缺什么）。⇒ 这里必须兜底，且必须留**能被看见**的痕迹。
   *
   *   兜底行为：退回画**第一条** shape 当当前方向（不确定方向，但至少不空白）。
   */
  const cur = parsed.filter((p) => p.dir === dir);
  if (cur.length === 0 && parsed.length > 0) {
    // ⚠️ 用 console.error 而非 warn：这是「数据管道出问题」的信号，不是轻微异常。
    //    warn 会被当噪音过滤掉，而 S7 / 上线首周正是要靠它发现问题。
    //    日志里必须带 code + 现有 dirs 列表，否则只看到"方向 1 无 shape"不知道是哪个线路。
    console.error(
      "[line-map] 方向 %s 无对应 shape（code=%s, 现有 dirs=%s）⇒ 退回画第一条。" +
        "数据管道可能只抓到一半，请检查 fetch-route-shapes。",
      dir,
      routeCode ?? "?",
      parsed.map((p) => p.dir).join(","),
    );
  }
  const solid = cur.length > 0 ? cur : parsed.slice(0, 1);
  const gray = parsed.filter((p) => !solid.includes(p));

  return (
    <div className="lp-map" data-map-state="ok">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height="100%"
        role="img"
        aria-label="线路走向示意图"
        preserveAspectRatio="xMidYMid meet"
      >
        {/* ① 整线灰虚（**非**当前实线的那几条）—— 设计要求的双层语言底层 */}
        {gray.map((p) => (
          <path
            key={`gray-${p.dir}`}
            d={toD(p.pts)}
            fill="none"
            stroke="var(--lp-map-gray, #9aa4ae)"
            strokeWidth={2}
            strokeDasharray="4 4"
            strokeLinecap="round"
            opacity={0.75}
          />
        ))}
        {/* ② 当前方向实线彩色 —— 顶层（无对应 shape 时是兜底的第一条，见上方 cur 的注释） */}
        {solid.map((p) => (
          <path
            key={`color-${p.dir}`}
            d={toD(p.pts)}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {/* ③ 站点小点（有坐标才画；最多 120 个，防 78 站 × 复杂路径拖慢渲染） */}
        {dotStops.map((s, i) => (
          <circle
            key={`stop-${i}`}
            cx={px(s.lng!)}
            cy={py(s.lat!)}
            r={1.8}
            fill="var(--surface)"
            stroke={color}
            strokeWidth={1.4}
          />
        ))}
      </svg>
    </div>
  );
}
