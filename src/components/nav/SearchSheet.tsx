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
 *     所以按钮的 disabled 只看「是否为空 / **点搜索是否在途**」，不看「是否已有本地命中」，
 *     ★ v3.1.1 #7 起**也不看打字预测是否在途**（否则输入后立刻点会被原生 disabled 吞掉）。
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
/** 澳门行政区划词（用于地址清洗；**不含**「氹仔/路环」这类地名——它们可作为地址开头）
 * ★ 2026-09-27（用户口径）：搜索结果统一「地点名 + 地址（小字）」，不显示行政区划。 */
const MACAU_ZONE_WORDS =
  "澳门|澳門|花地玛堂区|花地瑪堂區|圣安多尼堂区|聖安多尼堂區|大堂区|大堂區|望德堂区|望德堂區|风顺堂区|風順堂區|嘉模堂区|嘉模堂區|圣方济各堂区|聖方濟各堂區|路氹填海区|路氹填海區";
const MACAU_ZONE_RE = new RegExp(`^(${MACAU_ZONE_WORDS})[·\\s]*`);

/** 地址清洗：剥离区划前缀（最多 3 层）；清洗后为空 ⇒ 返回空串（该条目不显示地址行） */
function cleanAddr(a?: string | null): string {
  if (!a) return "";
  let s = a.trim();
  for (let i = 0; i < 3 && MACAU_ZONE_RE.test(s); i++) s = s.replace(MACAU_ZONE_RE, "");
  return s.replace(/[·\s]+$/g, "");
}

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
  /**
   * ★ v3.1.1 #7（真机反馈「输入后立刻点搜索可能不成功」）：
   *   原先用单个 `loading` 同时表示「打字预测请求」与「点搜索请求」，且 **按钮 `disabled={loading||…}`**
   *   ⇒ 打字触发的 300ms 防抖请求一发出，按钮就被禁用；用户紧接着点「搜索」时
   *   **原生 disabled 吞掉 click（onClick 根本不触发）** ⇒ 看着"点了没反应"。
   *   ⇒ 拆成 `busy`（区分 type / enter）：打字预测**不禁用**按钮，只有 enter 在途才禁用。
   */
  const [busy, setBusy] = useState<null | "type" | "enter">(null);
  const loading = busy !== null;
  /** ★ 并发保护：只认最后一次请求的响应（防「打字预测」的迟到响应覆盖「点搜索」的结果） */
  const reqIdRef = useRef(0);
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
    const id = ++reqIdRef.current; // ★ v3.1.1 #7：并发保护（只认最后一次）
    setBusy(mode);
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
      // ★ 过期响应（已被更新的请求取代）⇒ **不写入 state**（避免旧结果覆盖新结果）
      if (id === reqIdRef.current) setResp(json);
      return json;
    } catch {
      if (id === reqIdRef.current) {
        setErr("搜索暂不可用，请稍后再试");
        setResp(null);
      }
      return null;
    } finally {
      if (id === reqIdRef.current) setBusy(null);
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
          {/* ★ 2026-09-22：顺序为「**出发地在上、目的地在下**」（产品口径）。
              此前是「静态行（目的地）在上、输入行（出发地）在下」，与实际填写顺序相反。 */}
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
            {/* ★ 产品要求：输入与本地站名相同/部分相同时，**搜索按钮仍可点**。
                ★ v3.1.1 #7：**打字预测在途（busy==='type'）不禁用**，只有「点搜索」在途才禁用
                  ⇒ 输入后立即可点（修「点了没反应」）。 */}
            <button
              type="button"
              className="ssheet__go"
              onClick={runSearch}
              disabled={busy === "enter" || !q.trim()}
              title="搜索站点或地点"
            >
              搜索
            </button>
          </div>

          {/* 选出发地时：下方再显示**已定的目的地**（只读） */}
          {editing === "from" && (
            <div className="ssheet__row ssheet__row--static">
              <span className="ssheet__dot ssheet__dot--to" aria-hidden="true" />
              <span className="ssheet__static-text">{otherLabel}</span>
            </div>
          )}
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
                    <span className="ssheet__main">
                      <span className="ssheet__name">{`${s.code} ${s.name}`.trim()}</span>
                    </span>
                    <span className="ssheet__dist">{s.distM} m</span>
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
            {results.map((r, i) => {
              /* ★ 2026-09-27（用户口径）：两行布局——左列「地点名（大字）+ 地址（小字）」；右侧直线距离；
                 「高德」来源标签与行政区划不再展示（地址已剥离区划前缀）。 */
              const addr = cleanAddr(r.address);
              return (
                <button key={`${r.name}-${i}`} type="button" className="ssheet__item" onClick={() => pick(r)}>
                  <span className={`ssheet__type ssheet__type--${r.kind}`}>{TYPE_LABEL[r.kind] ?? "地点"}</span>
                  <span className="ssheet__main">
                    <span className="ssheet__name">{displayName(r)}</span>
                    {addr && <span className="ssheet__addr t-muted">{addr}</span>}
                  </span>
                  {typeof r.distM === "number" && <span className="ssheet__dist">{r.distM} m</span>}
                </button>
              );
            })}

            {pending.map((p, i) => (
              <button
                key={`p-${p.name}-${i}`}
                type="button"
                className="ssheet__item ssheet__item--pending"
                onClick={() => void pickPending(p.name)}
                title="点「搜索」获取精确位置"
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
