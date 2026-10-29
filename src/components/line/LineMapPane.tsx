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

export default function LineMapPane({ shapes, dir, color, stops, loading }: LineMapPaneProps) {
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
        {/* ① 整线灰虚（其余方向）—— 设计要求的双层语言底层 */}
        {parsed
          .filter((p) => p.dir !== dir)
          .map((p) => (
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
        {/* ② 当前方向实线彩色 —— 顶层 */}
        {parsed
          .filter((p) => p.dir === dir)
          .map((p) => (
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
