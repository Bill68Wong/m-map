"use client";

/**
 * 轻轨时刻表报站卡（src/components/LrtEta.tsx）v0.15.2
 * 与巴士 LiveEta 同位置同视觉：只显示「下一班 / 再下一班」，无整日时刻表。
 * 数据链路：/api/lrt/eta（本地算）→ 一次拉取当日该站该线该方向时刻，
 *   之后客户端按绝对发车时刻（depMs）本地每秒重算倒计时——秒级不依赖网络。
 *
 * 口径（与方案一致；v0.15.2 定稿）：
 *   - 氹仔线（整分精度）：剩余 ≥60s → 「下一班 X 分钟」（floor）；<60s → 大字切换「现正到达」flash
 *   - 石排湾线/横琴线（秒级精度）：始终显示「还有 X 分 Y 秒」逐秒读秒（含 <60s 的 0 分 XX 秒）；
 *     <60s 大字上方叠加闪烁「现正到达」徽章 —— 秒数不被替换
 *   - 轻轨一律用「现正到达」；「即将进站」是巴士（DSAT 实时车距）专属文案
 *   - 滚动：超过下一班发车时刻后自动落到再下一班（同数据，无请求）
 *   - 空态：首班前/已收车/无数据 文案与 LiveEta 空态同风格
 *   - 日切（澳门 0 点）自动重新拉取（服务班别/日期已变）
 */
import RouteStack from "./RouteStack";
import Icon from "./ui/Icon";
import { useCallback, useEffect, useRef, useState } from "react";

/** 秒级读秒线路：石排湾线/横琴线（班次稀疏，倒计时需精确到秒）；
 *  氹仔线班次密仍按整分显示。码内含简/繁写法兜底匹配 */
const tickSecLine = (code: string) =>
  code.includes("石排") || code.includes("横琴") || code.includes("橫琴");

interface LrtDeparture {
  clock: string; // 'HH:MM'
  depMs: number; // 绝对毫秒时刻（D 00:00 + 偏移）
}

interface LrtEtaData {
  ok: boolean;
  error?: string;
  state: "running" | "before_first" | "after_last" | "no_data";
  lineCode: string;
  directionName: string | null;
  dayType: string;
  serviceDay: string; // 'YYYY-MM-DD'（澳门）
  firstClock: string | null;
  lastClock: string | null;
  departures: LrtDeparture[];
  serverNow: string;
}

/**
 * ★ 逐线「到站窗口」（修复包 v2.2.1-B5 / 07 §3.6 · D5）——**替换原先写死的 45s 与 <60s 阈值**。
 *
 * 判定式（2026-09-20 裁定）：**现正到达 ⇔ `depMs - pre ≤ now ≤ depMs + post`**
 *   —— ★ **闭区间（含边界）**；窗口外 → 显示「下一班 X 分钟 / 还有 X 分 Y 秒」。
 *   · 石排湾 `post` **保留 45s**（用户只提"关门时间"偏移）；
 *   · 横琴 `pre=0`（+40s 关门偏移，即窗口只在发车后才开）；
 *   · ⚠️ 窗口**只作用于到站判定与显示**，**不改** `depMs`（时刻表绝对发车时刻）。
 */
const LRT_ARRIVAL_WINDOW: Record<string, { pre: number; post: number }> = {
  "LRT-氹仔线": { pre: 30_000, post: 30_000 },
  "LRT-石排湾线": { pre: 5_000, post: 45_000 },
  "LRT-横琴线": { pre: 0, post: 40_000 },
};

/** 未知/新增线路的兜底窗口（贴近旧行为：无 pre、post = 旧 45s 留白） */
const LRT_WINDOW_FALLBACK: { pre: number; post: number } = { pre: 0, post: 45_000 };

/** 取该线的到站窗口（对简/繁「橫琴/横琴」等写法做包含式兜底匹配） */
function windowOf(lineCode: string): { pre: number; post: number } {
  const exact = LRT_ARRIVAL_WINDOW[lineCode];
  if (exact) return exact;
  const key = Object.keys(LRT_ARRIVAL_WINDOW).find((k) => {
    const bare = k.replace(/^LRT-/, "");
    return lineCode.includes(bare) || lineCode === bare;
  });
  if (key) return LRT_ARRIVAL_WINDOW[key];
  // 秒级线（石排湾/横琴的繁体写法）优先级高于整分线
  if (tickSecLine(lineCode)) return LRT_ARRIVAL_WINDOW["LRT-横琴线"];
  return LRT_WINDOW_FALLBACK;
}

/** 选「当前要展示的班次」= 第一个**窗口尚未结束**的班次（`depMs + post ≥ now`） */
function pickNext(
  dep: LrtDeparture[],
  nowMs: number,
  w: { pre: number; post: number },
): LrtDeparture | null {
  if (!dep.length) return null;
  return dep.find((d) => d.depMs + w.post >= nowMs) ?? null;
}

/** 该班是否处于「现正到达」窗口（★ 闭区间，含边界） */
function inArrivalWindow(d: LrtDeparture, nowMs: number, w: { pre: number; post: number }): boolean {
  return nowMs >= d.depMs - w.pre && nowMs <= d.depMs + w.post;
}

/** 澳门自然日 ymd（GMT+8，本地纯算） */
function macauYmd(ms: number): string {
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

export default function LrtEta({
  station,
  route,
  dest,
  refreshKey = 0,
  onRemainChange,
  routeColors,
}: {
  station: string;
  /** 本库线路码（LRT-氹仔线…）；调用方已按段解析好（effRoute 取 LRT 项） */
  route: string;
  dest?: string | null;
  /** 父级关键打点后递增 → 重新拉取（对齐 LiveEta 刷新节奏） */
  refreshKey?: number;
  /** 下一班剩余毫秒变化回调（TimerWizard 自动写 wait_snapshot 用；null=无下一班） */
  onRemainChange?: (remainMs: number | null) => void;
  /** v0.20.1：线路色（线路名标签取色） */
  routeColors?: Record<string, string>;
}) {
  const [data, setData] = useState<LrtEtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [cooldownSec, setCooldownSec] = useState(0);
  // v0.15.1：秒级读秒渲染节拍（+1 强制以最新 nowMs 重算；石排湾/横琴线「还有 X 分 Y 秒」实时滚动）
  const [, setNowTick] = useState(0);
  const reqId = useRef(0);
  const cooldownUntil = useRef(0);
  const serverOffsetMs = useRef(0);
  const lastReportedRemain = useRef<number | null>(null);

  const fetchEta = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    cooldownUntil.current = Date.now() + 10_000;
    setCooldownSec(10);
    try {
      const qs = new URLSearchParams({ station, route });
      if (dest) qs.set("dest", dest);
      const res = await fetch(`/api/lrt/eta?${qs.toString()}`, { cache: "no-store" });
      const body = (await res.json()) as LrtEtaData;
      if (id !== reqId.current) return;
      if (!res.ok || !body.ok) {
        setData({ ok: false, error: body.error ?? "获取失败", state: "no_data", lineCode: route, directionName: null, dayType: "", serviceDay: "", firstClock: null, lastClock: null, departures: [], serverNow: new Date().toISOString() });
        return;
      }
      serverOffsetMs.current = Date.parse(body.serverNow) - Date.now();
      setData(body);
    } catch {
      if (id === reqId.current) {
        setData({ ok: false, error: "网络异常", state: "no_data", lineCode: route, directionName: null, dayType: "", serviceDay: "", firstClock: null, lastClock: null, departures: [], serverNow: new Date().toISOString() });
      }
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [station, route, dest]);

  // 挂载 / 参数 / 打点刷新
  const prevKey = useRef(refreshKey);
  useEffect(() => {
    fetchEta();
  }, [fetchEta]);
  useEffect(() => {
    if (refreshKey !== prevKey.current) {
      prevKey.current = refreshKey;
      fetchEta();
    }
  }, [refreshKey, fetchEta]);

  // 冷却读秒（与 LiveEta 手感一致）
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setInterval(() => {
      const left = Math.ceil((cooldownUntil.current - Date.now()) / 1000);
      setCooldownSec(left <= 0 ? 0 : left);
    }, 500);
    return () => clearInterval(t);
  }, [cooldownSec]);

  // 本地每秒重算：下一/再下一剩余、跨班滚动、日切重拉、onRemainChange 上报
  useEffect(() => {
    if (!data) return;
    const report = () => {
      const nowMs = Date.now() + serverOffsetMs.current;
      const dep = data.departures;
      if (dep.length === 0) {
        if (lastReportedRemain.current !== null) {
          lastReportedRemain.current = null;
          onRemainChange?.(null);
        }
        return;
      }
      // ★ B5：与显示同口径 —— 逐线到站窗口（闭区间）；窗口内仍返回该班（不提前滚到下一班）
      const nxtDep = pickNext(dep, nowMs, windowOf(data.lineCode));
      if (!nxtDep) {
        if (lastReportedRemain.current !== null) {
          lastReportedRemain.current = null;
          onRemainChange?.(null);
        }
        return;
      }
      const remainMs = nxtDep.depMs - nowMs;
      if (remainMs !== lastReportedRemain.current) {
        lastReportedRemain.current = remainMs;
        onRemainChange?.(remainMs);
      }
    };
    report(); // 数据就绪立即上报一次（不等首跳）
    const tick = setInterval(() => {
      const nowMs = Date.now() + serverOffsetMs.current;
      const dep = data.departures;
      if (dep.length > 0 && dep[dep.length - 1].depMs - nowMs <= 0) {
        // 末班也已开出 → 重拉（跨日/换班表后旧数据失效）
        fetchEta();
        return;
      }
      // 澳门日切 → 重拉（班别/日期变化）
      if (data.serviceDay && macauYmd(nowMs) !== data.serviceDay) {
        fetchEta();
        return;
      }
      report();
      // v0.15.1：运行中每秒 tick 一次 → 秒级倒计时与「下一班→再下一班」到点滚动即时生效
      if (data.state === "running") setNowTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(tick);
  }, [data, fetchEta, onRemainChange]);

  const manualRefresh = () => {
    if (Date.now() < cooldownUntil.current) return;
    fetchEta();
  };

  // —— 渲染 ——
  const nowMs = data ? Date.now() + serverOffsetMs.current : 0;
  // ★ B5：逐线到站窗口（闭区间）；班次选择 = 第一个「窗口尚未结束」的班次（depMs + post ≥ now）
  const win = windowOf(data?.lineCode || route || "");
  const nxtDep = data ? pickNext(data.departures, nowMs, win) : null;
  const sndDep = (() => {
    if (!data || !nxtDep) return null;
    const i = data.departures.indexOf(nxtDep);
    return data.departures[i + 1] ?? null;
  })();
  const remainMs = nxtDep ? nxtDep.depMs - nowMs : null;
  /** ★ B5：现正到达 ⇔ `depMs - pre ≤ now ≤ depMs + post`（**闭区间，含边界**） */
  const arriving = !!nxtDep && inArrivalWindow(nxtDep, nowMs, win);
  // v0.15.1：石排湾/横琴线秒级读秒（氹仔线维持整分显示）
  const tickSec = !!data && tickSecLine(data.lineCode);
  // floor：60_000ms 整恰好 60s（1 分 0 秒）；<60s 时不会出现「0 分 60 秒」（ceil 陷阱）
  const totalSec = remainMs != null ? Math.max(0, Math.floor(remainMs / 1000)) : null;

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleTimeString("zh-CN", {
      timeZone: "Asia/Macau",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  return (
    <div className="card anim-fade-up" style={{ padding: "12px 14px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <p
          className="h-title"
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          <Icon name="lrt" size={20} /> 实时到站{" "}
          <RouteStack codes={[route]} colorOf={(c) => routeColors?.[c]} size="sm" />
        </p>
        <button
          className="btn btn--text btn--sm"
          onClick={manualRefresh}
          disabled={loading || cooldownSec > 0}
          aria-label="刷新轻轨到站"
        >
          <span className={loading ? "anim-spin" : ""} style={{ display: "inline-block" }}>
            <Icon name="refresh" size={20} />
          </span>{" "}
          {loading ? "刷新中…" : cooldownSec > 0 ? `${cooldownSec}s` : "刷新"}
        </button>
      </div>

      {!data ? (
        <p className="t-body t-muted">获取中…</p>
      ) : !data.ok ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7 }}>
          轻轨时刻暂不可用 · {data.error}
        </p>
      ) : data.state !== "running" ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7, textAlign: "center", marginTop: 4 }}>
          {data.state === "before_first" && data.firstClock
            ? `首班 ${data.firstClock} 开出${data.directionName ? ` · 往${data.directionName}` : ""}`
            : data.state === "after_last" && data.lastClock
              ? `今日已收车 · 末班 ${data.lastClock}`
              : data.state === "before_first"
                ? "尚未开出首班"
                : data.state === "after_last"
                  ? "今日已收车"
                  : "该方向暂无时刻数据"}
        </p>
      ) : !nxtDep ? (
        <p className="t-body t-muted" style={{ lineHeight: 1.7, textAlign: "center", marginTop: 4 }}>
          该方向暂无时刻数据
        </p>
      ) : (
        <div style={{ marginTop: 2 }}>
          {/* ★ B5：秒级线（石排湾/横琴）在**到站窗口内**保留秒数，上方叠加「现正到达」徽章；
              氹仔线无秒精度 → 大字由「下一班 X 分钟」切换为「现正到达」flash。
              窗口 = 逐线 `LRT_ARRIVAL_WINDOW`（★ 闭区间，含边界）—— 替换原先写死的 <60s 阈值与 45s 留白。 */}
          {tickSec && arriving && (
            <p
              className="t-accent t-strong"
              style={{
                textAlign: "center",
                margin: "0 0 2px",
                fontSize: 15,
                letterSpacing: 2,
                animation: "eta-pulse 1.2s ease-in-out infinite",
              }}
            >
              现正到达
            </p>
          )}
          {/* 下一班大数字 */}
          <p
            className={`t-accent eta-big${!tickSec && arriving ? " eta-big--flash" : ""}`}
            style={{ textAlign: "center", margin: "4px 0 0" }}
          >
            {tickSec
              ? `还有 ${Math.floor(totalSec! / 60)} 分 ${totalSec! % 60} 秒`
              : arriving
                ? "现正到达"
                : `下一班 ${Math.max(0, Math.floor((remainMs ?? 0) / 60_000))} 分钟`}
          </p>
          {/* 副行：方向 + 绝对时刻 */}
          <p
            className="t-label t-muted"
            style={{ textAlign: "center", lineHeight: 1.5, marginTop: 2 }}
          >
            {data.directionName ? `往${data.directionName} · ` : ""}
            {nxtDep.clock} 开出
          </p>
          {/* 再下一班 */}
          {sndDep && (
            <p
              className="t-label t-muted"
              style={{ textAlign: "center", lineHeight: 1.5, marginTop: 4 }}
            >
              再下一班{" "}
              {Math.max(0, Math.floor((sndDep.depMs - nowMs) / 60_000))} 分钟 · {sndDep.clock}
            </p>
          )}
        </div>
      )}

      {data?.ok && data.serverNow && (
        <p className="t-label t-muted" style={{ marginTop: 8 }}>
          更新于 {fmtTime(data.serverNow)} · 时刻表来源 澳門輕軌
        </p>
      )}
    </div>
  );
}

/**
 * ★ v1.0.0 自动选线专用：**内联轻轨报时**（不自取数据、零网络）。
 *
 * 与上方 `LrtEta` 的差别只有一个 —— 数据来源：
 *   · `LrtEta`：自己 fetch `/api/lrt/eta`（计时页用，可手动刷新）
 *   · 本组件：直接消费**服务端算好并随卡片下发的** `departuresMs` / `clocks`
 *     （`RideLegView.liveDepartures` / `liveClocks`）→ SSR 出卡后不再有任何请求；
 *     客户端只做每秒本地读秒，滚动到下一班也是纯本地（同数据）。
 *
 * 口径与 `LrtEta` **完全一致**：复用同一套 `tickSecLine` / `pickNext` / 45s 到站留白 /
 * 「还有 X 分 Y 秒」vs「下一班 X 分钟」的分线策略 —— 只是不显示卡片外壳与刷新按钮。
 */
export function LrtEtaInline({
  lineCode,
  departuresMs,
  clocks,
  state,
  directionName,
}: {
  /** 本库线路码（决定整分 / 秒级读秒） */
  lineCode: string;
  departuresMs?: number[];
  clocks?: string[];
  state?: "running" | "before_first" | "after_last" | "no_data";
  directionName?: string | null;
}) {
  const [, tick] = useState(0);
  /**
   * ★ v1.0.6：挂载门控。
   * 本组件在 render 期直接读 `Date.now()` —— 服务端渲染时读到的是**服务器时间**，
   * 客户端接管时读到的是**手机时间**，两者差 1~2 秒 → 文本必然对不上（水合告警 + 闪字）。
   * 挂载前统一渲染占位符，挂载后再交给每秒 tick 的真实读数。
   * 这不影响「每秒重算」这条口径 —— 只是把**首帧**让给占位符。
   */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const dep: LrtDeparture[] = (departuresMs ?? []).map((ms, i) => ({
    depMs: ms,
    clock: clocks?.[i] ?? "",
  }));

  if (state && state !== "running") {
    return (
      <span className="rc-live rc-live--dim">
        {state === "before_first" ? "首班前" : state === "after_last" ? "今日已收车" : "暂无时刻"}
      </span>
    );
  }
  if (!dep.length) return <span className="rc-live rc-live--dim">暂无时刻</span>;
  if (!mounted) return <span className="rc-live rc-live--dim">—</span>;

  const nowMs = Date.now();
  const w = windowOf(lineCode);
  const nxt = pickNext(dep, nowMs, w);
  const sec = tickSecLine(lineCode);
  // ★ B5：窗口内 = 「现正到达」；整日无后续班次 → 今日已收车（不再用写死的 45s 留白）
  if (!nxt) return <span className="rc-live rc-live--dim">今日已收车</span>;
  const remainMs = nxt.depMs - nowMs;
  const arriving = inArrivalWindow(nxt, nowMs, w);
  const totalSec = Math.max(0, Math.floor(remainMs / 1000));
  return (
    <span className="rc-live">
      {sec
        ? arriving
          ? "现正到达"
          : `还有 ${Math.floor(totalSec / 60)} 分 ${totalSec % 60} 秒`
        : arriving
          ? "现正到达"
          : `下一班 ${Math.max(0, Math.floor(remainMs / 60_000))} 分钟`}
      <span className="rc-live__sub">
        {directionName ? `往${directionName} · ` : ""}
        {nxt.clock} 开出
      </span>
    </span>
  );
}
