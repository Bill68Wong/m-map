"use client";

/* eslint-disable @typescript-eslint/no-explicit-any --
 * AMap 没有随包的 TS 类型（`window.AMap` 是运行时注入的），因此 map / amap / marker
 * 一律按 `any` 处理。这不是偷懒：全仓所有图层（`TqhStationLayer` / `VehicleLayer` /
 * `TrackLayer` / `UserDotLayer`）同一个口径，第 47 行都是同一条 disable。
 * 若哪天引入 `@types/amap-js-api`，应**一起**替换这几层，不要只改一层造成两套类型。 */

/**
 * 跨境地标图层（需求 7）—— 在地图上画机场 / 码头圆点，低倍时把互相重叠的一对合成聚合点。
 *
 * ── 与既有图层的关系 ────────────────────────────────────────────────────
 *   形态与 `TqhStationLayer` / `VehicleLayer` 一致：受控组件，`map` / `amap` 由 `NavMap`
 *   在 `phase === "ready"` 后传入，卸载时 `map.remove()` 清理（**不泄漏 AMap marker**）。
 *
 * ── 为什么本层**没有**站点图层的 zoom 门 ─────────────────────────────────
 *   站点层浏览态要 zoom ≥ 15（`NavMap.tsx:87 STATION_MIN_ZOOM`），因为全澳 400+ 站点
 *   低倍会糊成一片。本层只有 4 个地标，且在低倍本身就是"地标"语义
 *   （用户先看"机场在哪"，再放大地看细节）⇒ 常显。
 *   遮挡风险由**聚合**承担（见 `xborder-pins.ts#groupXbPins`），而不是由"藏起来"承担：
 *   藏起来会让用户在低倍完全找不到机场，与需求「首页显示机场、港口」直接冲突。
 *   ⚠️ 将来若要给它加门，别照抄站点的 15 —— 那会让聚合逻辑永远触发不了
 *      （聚合只在低倍成立），等于把聚合代码变成死码。
 */

import { useEffect, useRef } from "react";
import { groupXbPins, XB_PIN_SIZE, xbPinById, type XbPinKind } from "./xborder-pins";
import { xbGlyphSvg, XB_GLYPH_FERRY, XB_GLYPH_PLANE } from "@/components/ui/xb-glyphs";

/**
 * ★ 2026-11-21：pin 内剪影的边长（px）。
 *
 * 预算：`--xb-pin-size`(16) − 2×边框。**边框按实测算**：Chrome 把 1.5px 按 1px 渲染
 * ⇒ 内容盒 **14px**（详见 globals.css `.nav-map__xbpin` 那段实测注）。
 *
 * 为什么取 **10**（2026-11-21 真 Chrome 8× 逐个截图比对 9/10/11/12 四档）：
 *   | 图形 | 单边留白 | 观察 |
 *   |---|---|---|
 *   | 9  | 2.5px | 机影偏小，16px 圆里显得空 |
 *   | **10** | **2px** | 机影三要素（机身/后掠翼/尾翼）清晰，四周仍有可见蓝边；**船的两个舷窗仍是两个独立方孔** |
 *   | 11 | 1.5px | 机头/机尾/翼尖**顶到圆边**，读成"填满"，船体下沿贴近边框 |
 *   | 12 | 1px  | 明显溢出感，不满足"留 1px 呼吸"的下限 |
 *   ⇒ 取 10：既放大了（旧的 14px pin 用 9），又保住留白。**不要再往上调**；
 *     真要更大，先调 `--xb-pin-size`（同时 `XB_PIN_SIZE` 与聚合阈值一起变），不要偷偷改这里。
 *
 * ⚠️ 这是**图形**尺寸，不是 **pin** 尺寸。pin 尺寸被聚合阈值钉死
 *   （`XB_CLUSTER_MAX_PX = XB_PIN_SIZE + XB_PIN_GAP`），改它会让聚合失效。
 */
const XB_PIN_GLYPH_PX = 10;

interface XborderPinLayerProps {
  /** AMap.Map 实例（`NavMap` 就绪后传入；未就绪传 null） */
  map: any | null;
  /** AMap 命名空间（构造 Marker / Pixel 用） */
  amap: any | null;
  /** 总开关（未就绪 / 不该显示时 false） */
  enabled: boolean;
  /**
   * ★ M4（需求 6）：本轮按图层开关**分别**控制码头 / 机场可见性。
   * `null`/缺省 = 全显示（行为与改前一致）；集合 = 只显示其中 `kind`。
   *
   * ⚠️ 刻意**不改聚合算法**：`groupXbPins(zoom)` 仍在**全量 `XB_PINS`** 上算，
   *    只在渲染前按 `kind` 过滤组内成员 —— 这样「机场+外港码头」这对在低倍的聚合
   *    仍然成立（关掉机场后自然退化为单独一个码头点，位置取**该码头自己的坐标**，
   *    不是聚合中点）。若改成「两句各传一半数据进去」，聚合会失效、点的位置也会漂。
   */
  visibleKinds?: ReadonlySet<XbPinKind> | null;
  /** 点圆点 / 聚合点 ⇒ 交回宿主开小窗（参数 = 该组包含的地标 id） */
  onPick?: (ids: string[]) => void;
  /** 观测钩子：当前已绘单元数（供验收断言；不做业务逻辑） */
  onCount?: (groups: number) => void;
}

const esc = (s: string) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export default function XborderPinLayer({ map, amap, enabled, visibleKinds = null, onPick, onCount }: XborderPinLayerProps) {
  const markersRef = useRef<any[]>([]);
  /* 回调走 ref：宿主每次渲染都会新建内联函数，直接进 effect 依赖会导致全量重建 marker */
  const pickRef = useRef(onPick);
  const countRef = useRef(onCount);
  useEffect(() => {
    pickRef.current = onPick;
  }, [onPick]);
  useEffect(() => {
    countRef.current = onCount;
  }, [onCount]);

  useEffect(() => {
    if (!enabled || !map || !amap) return;
    let cancelled = false;

    const clear = () => {
      for (const m of markersRef.current) {
        try {
          map.remove(m);
        } catch {
          /* 地图已销毁时 remove 会抛，忽略 */
        }
      }
      markersRef.current = [];
    };

    /** 按当前 zoom 重算聚合 ⇒ 重建。只有 ≤4 个 marker，重建比增量维护更不容易错。 */
    const draw = () => {
      if (cancelled) return;
      clear();
      const zoom = typeof map.getZoom === "function" ? map.getZoom() : 0;
      const groups = groupXbPins(zoom);

      for (const g of groups) {
        /* ★ M4：先在**组内**按 `kind` 过滤（聚合本身仍在全量 XB_PINS 上算，见 props 注释） */
        const pins = g.ids
          .map(xbPinById)
          .filter((p): p is NonNullable<typeof p> => !!p)
          .filter((p) => !visibleKinds || visibleKinds.has(p.kind));
        if (!pins.length) continue;

        const isCluster = pins.length > 1;
        /**
         * 语义：这是"可点的地标"，不是站点 ⇒ `role="button"` + `aria-label`。
         * 不用 `.nav-map__station`：那是站点（11/13px、圆形/方形、有 ETA 语义），
         * 复用会让「站标只有一套规格」那条门禁与视觉口径同时变模糊。
         */
        const label = isCluster
          ? `${pins.map((p) => p.name).join("与")}（聚合），查看班次`
          : `${pins[0].name}，查看班次`;
        const cls = `nav-map__xbpin${isCluster ? " nav-map__xbpin--cluster" : pins[0].kind === "airport" ? " nav-map__xbpin--air" : " nav-map__xbpin--pier"}`;
        /* 断言属性：聚合用 data-xb-cluster（值为 ids 拼串），单点用 data-xb-pin（值为 id） */
        const attr = isCluster
          ? ` data-xb-cluster="${esc(g.clusterKey ?? "")}"`
          : ` data-xb-pin="${esc(pins[0].id)}"`;
        /**
         * ★ M4：聚合**被过滤退化**成单点时，位置必须回到**该点自己的坐标** ——
         *   继续用 `g.lng/g.lat`（两点中点）会让「只开码头」时码头点漂到海上。
         */
        const pos: [number, number] = isCluster ? [g.lng, g.lat] : [pins[0].lng, pins[0].lat];

        /**
         * ★ 2026-11-21（真机验收 ①）：**pin 里现在有图形了**。
         *
         *   改前这里是一个**空 div** —— 地标只有 CSS 画的圆（`--air` 实心 accent、
         *   `--pier` 空心），所以"机场和码头图标没变"是必然的：上一版改的是
         *   `Icon.tsx`（`/cross-border` 页那套），地图这里一个像素都没动。
         *
         *   · 尺寸：`XB_PIN_GLYPH_PX = 10`。内容盒 = 16px 圆 − 2×边框；**边框按实测算**
         *     （Chrome 把 1.5px 渲染成 1px，`getComputedStyle` 与 `clientWidth` 互证）
         *     ⇒ 内容盒 **14px**，10px 图形两侧各留 2px。**不要**为了"看得更清"去放大 pin：
         *     `--xb-pin-size` 与 `XB_PIN_GAP` 之和 = 聚合阈值（`XB_CLUSTER_MAX_PX`），
         *     改尺寸会让"两圆已经撞上了却不合并"复发（见文件头与 CSS 那里两处注释）。
         *   · 图形：`xbGlyphSvg()`，与 `<Icon name="planeIcon|ferryIcon">` **同一份 `d`**
         *     （`src/components/ui/xb-glyphs.ts` 是真源，不许在这里另抄一份）。
         *   · 颜色：路径是 `currentColor`，**机场与码头都是白图形**（码头 2026-11-21 反相成蓝底白影），
         *     由 CSS 给（见 globals.css）；两者靠图形语义区分。
         *   · 聚合点**不塞图形**（22px 圆里已经有计数，再叠个剪影会读成"一个小图标"，
         *     而聚合的语义是"这里有两个地标"）。
         */
        const glyph = isCluster
          ? ""
          : xbGlyphSvg(pins[0].kind === "airport" ? XB_GLYPH_PLANE : XB_GLYPH_FERRY, XB_PIN_GLYPH_PX);

        const marker = new amap.Marker({
          position: pos,
          content: `<div class="${cls}"${attr} role="button" tabindex="-1" aria-label="${esc(label)}" title="${esc(pins.map((p) => p.name).join(" / "))}">${
            isCluster ? `<span class="nav-map__xbpin__count">${pins.length}</span>` : glyph
          }</div>`,
          /* 圆点居中：offset 取半径的相反数（与 CSS 的 --xb-pin-size 一致，见其注释） */
          offset: new amap.Pixel(-XB_PIN_SIZE / 2, -XB_PIN_SIZE / 2),
          /* 地标压在站点之上（站点未显式设 zIndex ⇒ 默认 100 段），避免被站点标盖住 */
          zIndex: 140,
          extData: { ids: g.ids },
        });
        marker.on("click", () => pickRef.current?.(g.ids));
        map.add(marker);
        markersRef.current.push(marker);
      }
      countRef.current?.(groups.length);
    };

    draw();
    /* 只监听 zoomend：聚合只随**缩放**变化，平移不改变像素间距 ⇒ moveend 无须监听 */
    map.on("zoomend", draw);

    return () => {
      cancelled = true;
      try {
        map.off("zoomend", draw);
      } catch {
        /* ignore */
      }
      clear();
    };
  }, [map, amap, enabled, visibleKinds]);

  return null;
}
