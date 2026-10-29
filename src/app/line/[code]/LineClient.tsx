"use client";

/**
 * 线路全景页 · 客户端外壳（src/app/line/[code]/LineClient.tsx，v3.6.0 · S6）
 *
 * ── 分工 ────────────────────────────────────────────────────────────────
 *   `page.tsx`（服务端）已直出**首屏站序**（省一次自我 HTTP 往返），本文件负责
 *   三件纯客户端的事：**方向切换 / 懒加载报站 / 换乘列**。
 *
 * ── ★★ 坑①：两方向**不是反转**，必须重新请求 ────────────────────────────
 *   设计文档 §2.8 原写「切换后列表顺序反转」—— **实测不成立**。以 `1` 路为例：
 *     · `dir=0` 16 站 · `dir=1` 13 站（**站数都不同**）
 *     · 共享站台码仅 **2/16**，同下标同站码 **0** 个
 *   原因：往返走**不同侧的站台**，每个方向有自己的站台码。
 *   ⇒ 切方向必须 `GET /api/route-stops?dir=X` 重新取，**禁止** `stops.reverse()`，
 *     也**禁止**假设两方向站数相同。
 *
 * ── ★★ 坑③：轻轨零请求是**前端责任** ────────────────────────────────────
 *   `/api/station/eta?code=LRT-*` 后端是**支持**的（实测 200、返回时刻表），
 *   所以「轻轨不发报站请求」只能靠 `useLazyEta` 内部 `kind === "lrt"` 直接 return。
 *   同时**渲染层仍要输出** `data-eta="none"` + 页面级「暂无实时车辆数据」提示条（AC-46）。
 *
 * ── ★★ 坑④：换乘数据只有 `/api/stations`（~103KB）───────────────────────
 *   不新增接口：**复用首页 NavMap 已用 `force-cache` 拉过的同一个 URL**
 *   （`NavMap.tsx:1089` 的 `/api/stations?include=lrt&v=2`）⇒ 浏览器缓存直接命中，
 *   实际网络成本≈0。**URL 必须与它逐字一致**（含 `v=2`），否则就是另一条缓存键。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import LineMapPane from "@/components/line/LineMapPane";
import LineStopList from "@/components/line/LineStopList";
import { useLazyEta } from "@/components/line/useLazyEta";
import {
  chipLabelOf,
  type LineShape,
  type RouteShapesResp,
  type RouteStopsResp,
  type RouteStopsOk,
  type StationsResp,
} from "@/lib/line/line-shared";
import { chipInkOf } from "@/lib/ui/chip-ink";
import { errorTextOf } from "@/lib/ui/error-text";

/** 与首页 NavMap 共用的站点大包 URL（**逐字一致**，否则缓存键不同） */
const STATIONS_URL = "/api/stations?include=lrt&v=2";

export interface LineClientProps {
  /** 服务端直出的首屏数据 */
  initial: RouteStopsOk;
}

export default function LineClient({ initial }: LineClientProps) {
  const router = useRouter();
  const [data, setData] = useState<RouteStopsOk>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [shapes, setShapes] = useState<LineShape[]>([]);
  const [mapLoading, setMapLoading] = useState(true);
  const [linesOfStation, setLinesOfStation] = useState<Map<string, string[]>>(new Map());

  const { code, kind, color, dirs, dir, label, stops } = data;
  const isLrt = kind === "lrt";
  const canRev = dirs.length > 1;
  const chip = useMemo(() => chipInkOf(color), [color]);

  /* ── 走向（线路级，与方向无关；只取一次）────────────────────────────── */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/route-shapes?code=${encodeURIComponent(code)}`, { cache: "no-store" });
        const j = (await r.json()) as RouteShapesResp;
        if (alive) setShapes(j.shapes ?? []);
      } catch {
        if (alive) setShapes([]); // 取不到 ⇒ 走降级提示，不白屏
      } finally {
        if (alive) setMapLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  /* ── 换乘列（复用 103KB 大包；force-cache 命中首页已拉过的那份）──────── */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(STATIONS_URL, { cache: "force-cache" });
        const j = (await r.json()) as StationsResp;
        if (!alive) return;
        const m = new Map<string, string[]>();
        for (const s of j.stations ?? []) {
          if (s.code && s.lines?.length) m.set(s.code, s.lines);
        }
        setLinesOfStation(m);
      } catch {
        /* 取不到 ⇒ 不显示换乘列（不阻塞站序与报站） */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ── 报站懒加载（坑②③⑤⑥ 全在 hook 内守）─────────────────────────── */
  const { etaOf, registerEl } = useLazyEta(stops, code, kind);

  /* ── 切方向：**重新请求**，绝不 reverse（坑①）──────────────────────── */
  const nextDir = dirs[(dirs.indexOf(dir) + 1) % dirs.length] ?? dir;
  const switching = useRef(false);
  const switchDir = useCallback(async () => {
    if (!canRev || switching.current) return;
    switching.current = true;
    setBusy(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ code, dir: nextDir });
      const r = await fetch(`/api/route-stops?${qs}`, { cache: "no-store" });
      if (!r.ok) throw new Error(errorTextOf("upstream_error"));
      const j = (await r.json()) as RouteStopsResp;
      if (!j.ok) throw new Error(errorTextOf(j.error));
      setData(j);
      // 设计 §2.8：切向后滚动位置回到顶部
      window.scrollTo({ top: 0, behavior: "auto" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : errorTextOf("upstream_error"));
    } finally {
      setBusy(false);
      switching.current = false;
    }
  }, [canRev, code, nextDir]);

  const dirText = label ? `往 ${label.to}` : `方向 ${dir}`;

  return (
    <div className="lp-page" data-kind={kind}>
      {/* ── 顶栏（sticky）── */}
      <header className="lp-head">
        <button className="lp-head__back" type="button" onClick={() => router.back()} aria-label="返回">
          <Icon name="back" size={20} />
        </button>
        <div className="lp-head__title">
          <span
            className="linechip"
            data-chip-ink={chip.tone}
            style={{ background: chip.bg, color: chip.ink }}
          >
            {chip.dot && <i className="linechip__dot" style={{ background: chip.dot }} aria-hidden="true" />}
            {chipLabelOf(code, kind)}
          </span>
          <span className="lp-head__sub">
            {dirText} · 共 {stops.length} 站
          </span>
        </div>
        {canRev && (
          <button
            className="lp-head__rev"
            type="button"
            onClick={() => void switchDir()}
            aria-label="切换方向"
            aria-busy={busy}
            data-busy={busy ? "1" : undefined}
          >
            <Icon name="exchange" size={20} />
          </button>
        )}
      </header>

      {/* ── 走向小图（无 shape ⇒ 降级提示，坑⑤）── */}
      <LineMapPane
        routeCode={code}
        shapes={shapes}
        dir={dir}
        color={color}
        stops={stops}
        loading={mapLoading}
      />

      {/* ── 轻轨提示条（AC-46：隐藏报站列时本提示条**仍须存在**）── */}
      {isLrt && <p className="lp-notice">暂无实时车辆数据</p>}

      {err && (
        <p className="lp-notice lp-notice--err" role="alert">
          {err}
        </p>
      )}

      {/* ── 站序 ── */}
      <LineStopList
        stops={stops}
        color={color}
        etaOf={etaOf}
        registerEl={registerEl}
        linesOfStation={linesOfStation}
        lineCode={code}
      />

      <p className="lp-foot">
        线路数据来自交通事务局，实时到站仅供参考
      </p>
    </div>
  );
}
