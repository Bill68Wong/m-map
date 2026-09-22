"use client";

/**
 * 全屏搜索层（src/components/nav/SearchSheet.tsx，2026-09-22 搜索界面重构）
 *
 * ── 它取代了什么 ──────────────────────────────────────────────────────
 *   旧版是「可拖拽的底部抽屉 + 4 步引导（①选目的地 ②地图标定 ③选出发地 ④出发）」，
 *   每步高度不同、还要处理惯性吸附。新版按产品口径改为**模仿高德/谷歌地图的两态**：
 *     · **全屏**（本组件）—— 顶部输入条 + 中部结果列表，进来就是输状态；
 *     · **下半屏**（`RoutePanel`）—— 上半屏看地图，下半屏看起终点并能直接「出发」。
 *
 * ── 两段式搜索（沿用既有 `/api/poi/suggest` 口径，未改服务端）────────────
 *   · **打字**（防抖 300ms）→ `mode=type` —— **只返回巴士站/轻轨站**（本地库，0 配额、秒回）；
 *   · **点【搜索】按钮** → `mode=enter` —— **总是调高德**，结果里才会出现「地点」类；
 *   · ⚠️ 即使输入与本地站名相同/部分相同，**搜索按钮仍可点**（产品明确要求）——
 *     所以按钮的 disabled 只看「是否为空 / 是否在加载」，不看「是否已有本地命中」。
 *
 * ── 与旧 `PoiSearchBox` 的差别 ────────────────────────────────────────
 *   旧组件是「输入框 + **下拉浮层**」，适合嵌在抽屉里；
 *   新版要「**全屏 + 结果直接铺满中部**」，下拉浮层那套定位/关闭逻辑不再适用，
 *   故本组件**自带输入与列表**，但**调用完全相同的接口与参数**（口径不漂移）。
 *
 * ⚠️ 文案一律**简体**；站名/线路名保留繁体原文。
 */
import { useEffect, useRef, useState } from "react";
import Icon from "@/components/ui/Icon";
import RouteStack from "@/components/RouteStack";
import type { NavPoint, PoiKind, PoiSearchResult, PoiSuggestResponse } from "@/lib/nav/types";

const DEBOUNCE_MS = 300;

/** 结果类型徽章（简体） */
const TYPE_LABEL: Record<PoiKind, string> = {
  station: "公交站",
  lrt_station: "轻轨站",
  place: "地点",
  poi: "地点",
};

/** 巴士站显示名带站码（`M1 關閘總站`）；轻轨站/地点用原名 */
function displayName(r: PoiSearchResult): string {
  if (r.kind === "station" && r.code && !r.name.startsWith(`${r.code} `)) {
    return `${r.code} ${r.name}`;
  }
  return r.name;
}

function toNavPoint(r: PoiSearchResult): NavPoint {
  const kind: NavPoint["kind"] =
    r.kind === "station" || r.kind === "lrt_station" ? "station" : r.kind === "place" ? "place" : "poi";
  const p: NavPoint = { kind, label: displayName(r), lng: r.lng, lat: r.lat };
  if (r.code) p.code = r.code;
  return p;
}

/** 结构类型（避免依赖收藏模块） */
export interface QuickPair {
  id: string;
  from: { kind: NavPoint["kind"]; label: string; lng: number; lat: number; code?: string };
  to: { kind: NavPoint["kind"]; label: string; lng: number; lat: number; code?: string };
}

export interface SearchSheetProps {
  /** 当前在编辑哪个端点 */
  editing: "dest" | "from";
  dest: NavPoint | null;
  from: NavPoint | null;
  userPos: { lng: number; lat: number } | null;
  colors: Record<string, string>;
  quickPairs: QuickPair[];
  onPick: (p: NavPoint, which: "dest" | "from") => void;
  onPickQuick: (from: NavPoint, to: NavPoint) => void;
  /** 左上角返回（关闭全屏、回到半屏或地图） */
  onBack: () => void;
}

/** 球面距离（米）—— 与 `coord.ts#haversineM` 同口径；此处**内联**，避免客户端拉进服务端模块 */
function distMeters(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371008.8;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export default function SearchSheet({
  editing,
  dest,
  from,
  userPos,
  colors,
  quickPairs,
  onPick,
  onPickQuick,
  onBack,
}: SearchSheetProps) {
  /** 输入框内容：**正在编辑的那个**端点为空（待输入），另一个显示已选值 */
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<PoiSuggestResponse | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  /**
   * ★ 附近站点推荐（**未输入时**显示 —— 就是产品说的「中间是推荐条，只列巴士/轻轨站点」）。
   * 数据来自 `GET /api/stations`（全量巴士站，带 GCJ-02 坐标，CDN 缓存 1h）
   * ⇒ 拉一次后**本地**按距离排序取前 12，交互过程中零请求。
   * 失败静默：不影响用户输入关键字搜索。
   */
  const [nearby, setNearby] = useState<{ code: string; name: string; lng: number; lat: number; distM: number }[]>([]);

  useEffect(() => {
    if (!userPos) {
      setNearby([]);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/stations");
        const j = (await r.json()) as { stations?: { code: string; name: string; lng: number; lat: number }[] };
        const list = (j.stations ?? [])
          .map((s) => ({ code: s.code, name: s.name, lng: s.lng, lat: s.lat, distM: Math.round(distMeters(userPos, s)) }))
          .sort((a, b) => a.distM - b.distM)
          .slice(0, 12);
        if (alive) setNearby(list);
      } catch {
        /* 网络失败 ⇒ 不显示推荐（不阻塞搜索） */
      }
    })();
    return () => {
      alive = false;
    };
  }, [userPos]);

  // 进入本层 → 聚焦输入框、清空上一次的输入（**每次进入都是新的搜索意图**）
  useEffect(() => {
    setQ("");
    setResp(null);
    setErr("");
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [editing]);

  /**
   * 发起搜索。
   * @param mode      `type` = 打字阶段（只站点）· `enter` = 点搜索（含高德）
   * @param forceAmap 强制走高德（点「点搜索确认」行时用）
   * @returns 响应对象（供调用方判定/自动选中）；无关键字或失败 → null
   */
  async function query(
    keyword: string,
    mode: "type" | "enter",
    forceAmap = false,
  ): Promise<PoiSuggestResponse | null> {
    const s = keyword.trim();
    if (!s) {
      setResp(null);
      return null;
    }
    setLoading(true);
    setErr("");
    try {
      const sp = new URLSearchParams({ q: s.slice(0, 50), mode });
      if (forceAmap) sp.set("forceAmap", "1");
      if (userPos) {
        sp.set("lat", String(userPos.lat));
        sp.set("lng", String(userPos.lng));
      }
      const res = await fetch(`/api/poi/suggest?${sp.toString()}`, { cache: "no-store" });
      const json = (await res.json()) as PoiSuggestResponse;
      setResp(json);
      return json;
    } catch {
      setErr("搜索暂不可用，请稍后再试");
      setResp(null);
      return null;
    } finally {
      setLoading(false);
    }
  }

  function onInput(v: string) {
    setQ(v);
    if (timer.current) clearTimeout(timer.current);
    // ★ 打字阶段只查本地站点（0 配额）；点【搜索】才联网
    timer.current = setTimeout(() => void query(v, "type"), DEBOUNCE_MS);
  }

  function runSearch() {
    if (timer.current) clearTimeout(timer.current);
    void query(q, "enter");
  }

  function pick(r: PoiSearchResult) {
    onPick(toNavPoint(r), editing);
  }

  /** 「点搜索确认」行：本地命中但无坐标 ⇒ 强制走高德拿坐标后自动选中第一条 */
  async function pickPending(name: string) {
    setQ(name);
    const json = await query(name, "enter", true);
    const top = json?.results?.[0];
    if (top) pick(top);
    else setErr("这条地点暂时确认不到坐标 · 换个说法试试");
  }

  const results = resp?.results ?? [];
  const pending = resp?.pending ?? [];
  const hint = resp?.hintText;
  /** 另一个端点（非编辑中的那个）—— 用于双输入条时显示 */
  const other = editing === "from" ? dest : from;
  const otherLabel = other?.label ?? (editing === "from" ? "（未选）" : "我的位置");

  return (
    <section className="ssheet" role="dialog" aria-modal="true" aria-label="搜索地点">
      <header className="ssheet__top">
        <button type="button" className="ssheet__back" onClick={onBack} aria-label="返回">
          <Icon name="back" size={20} />
        </button>

        <div className="ssheet__fields">
          {/* 选出发地时：**两行**（上行出发地=编辑中，下行目的地=已定，只读展示） */}
          {editing === "from" && (
            <div className="ssheet__row ssheet__row--static">
              <span className="ssheet__dot ssheet__dot--to" aria-hidden="true" />
              <span className="ssheet__static-text">{otherLabel}</span>
            </div>
          )}

          <div className="ssheet__row ssheet__row--input">
            <span
              className={`ssheet__dot${editing === "from" ? " ssheet__dot--from" : " ssheet__dot--to"}`}
              aria-hidden="true"
            />
            <input
              ref={inputRef}
              className="ssheet__inp"
              value={q}
              onChange={(e) => onInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runSearch();
                }
              }}
              placeholder={editing === "from" ? "输入出发地" : "去哪儿？"}
              aria-label={editing === "from" ? "出发地" : "目的地"}
              inputMode="search"
            />
            {loading && <span className="ssheet__spin" aria-label="搜索中" />}
            {/* ★ 产品要求：输入与本地站名相同/部分相同时，**搜索按钮仍可点** */}
            <button
              type="button"
              className="ssheet__go"
              onClick={runSearch}
              disabled={loading || !q.trim()}
              title="搜索（本地优先，必要时联网）"
            >
              搜索
            </button>
          </div>
        </div>
      </header>

      <div className="ssheet__body">
        {/* ── 尚未输入：推荐（只站点 / 常用地点对）── */}
        {!q.trim() && (
          <>
            {/* ★ 附近站点推荐 —— 产品口径：「中间是推荐条（巴士轻轨站点，无其他）」 */}
            {nearby.length > 0 && (
              <div className="ssheet__sect">
                <p className="ssheet__sect-title t-label">附近站点</p>
                {nearby.map((s) => (
                  <button
                    key={s.code}
                    type="button"
                    className="ssheet__item"
                    onClick={() =>
                      onPick(
                        { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code },
                        editing,
                      )
                    }
                  >
                    <span className="ssheet__type ssheet__type--station">公交站</span>
                    <span className="ssheet__name">{`${s.code} ${s.name}`.trim()}</span>
                    <span className="ssheet__meta t-muted">{s.distM} m</span>
                  </button>
                ))}
              </div>
            )}
            {quickPairs.length > 0 && (
              <div className="ssheet__sect">
                <p className="ssheet__sect-title t-label">常用</p>
                {quickPairs.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className="ssheet__pair"
                    onClick={() =>
                      onPickQuick(
                        { kind: f.from.kind, label: f.from.label, lng: f.from.lng, lat: f.from.lat, code: f.from.code },
                        { kind: f.to.kind, label: f.to.label, lng: f.to.lng, lat: f.to.lat, code: f.to.code },
                      )
                    }
                  >
                    <Icon name="origin" size={16} />
                    <span className="ssheet__pair-from">{f.from.label}</span>
                    <Icon name="arrowRight" size={16} />
                    <Icon name="destination" size={16} />
                    <span className="ssheet__pair-to">{f.to.label}</span>
                  </button>
                ))}
              </div>
            )}
            <p className="ssheet__tip t-label t-muted">
              输入关键字会列出巴士站 / 轻轨站；想找具体地点，点右侧「搜索」。
            </p>
          </>
        )}

        {/* ── 已输入：结果列表 ── */}
        {q.trim() && (
          <div className="ssheet__list">
            {results.map((r, i) => (
              <button key={`${r.name}-${i}`} type="button" className="ssheet__item" onClick={() => pick(r)}>
                <span className={`ssheet__type ssheet__type--${r.kind}`}>{TYPE_LABEL[r.kind] ?? "地点"}</span>
                <span className="ssheet__name">{displayName(r)}</span>
                {r.source !== "local" && <span className="ssheet__badge">来自高德</span>}
                {(r.district || r.address) && <span className="ssheet__meta t-muted">{r.district || r.address}</span>}
                {typeof r.distM === "number" && <span className="ssheet__meta t-muted">{r.distM} m</span>}
              </button>
            ))}

            {pending.map((p, i) => (
              <button
                key={`p-${p.name}-${i}`}
                type="button"
                className="ssheet__item ssheet__item--pending"
                onClick={() => void pickPending(p.name)}
                title="点「搜索」用高德确认坐标"
              >
                <span className={`ssheet__type ssheet__type--${p.targetKind}`}>
                  {TYPE_LABEL[p.targetKind as PoiKind] ?? "站点"}
                </span>
                {p.targetKind === "route" ? (
                  <RouteStack codes={[p.name]} colorOf={(c) => colors?.[c] ?? null} />
                ) : (
                  <span className="ssheet__name">{p.name}</span>
                )}
                <span className="ssheet__badge ssheet__badge--soft">点搜索确认</span>
              </button>
            ))}

            {!loading && !results.length && !pending.length && (
              <p className="ssheet__empty t-muted">{hint ?? (err || "找不到这个地点 · 试试换个说法")}</p>
            )}
            {!!results.length && hint && <p className="ssheet__empty t-muted">{hint}</p>}
          </div>
        )}
      </div>
    </section>
  );
}
