"use client";

/**
 * 巴士站点信息卡（src/components/nav/StationCard.tsx，v2.1.0；★ 修复包 v2.2.1-B4 多台站分组）
 *
 * ── 定位（产品口径 2026-09-19）─────────────────────────────────────────
 *   首页地图点击巴士站 → 浮层卡片：**站名（繁体）+ 该站所有线路的实时报站**
 *   + 「设为起点 / 设为目的地」（联动上方搜索框）。可关闭。
 *
 * ── ★ B4 多台站分组（08 §D，D7）────────────────────────────────────────
 *   一个实体站可有多个**站台分组**（数据上：主码 `T373` + 子码 `T373/1`、`T373/2`）。
 *   · 标题 = **主编号 + 站名**；副行 = 「N 个站台分组 · M 条线路」（先告诉用户"为什么分两块"）；
 *   · 每个分组 = **发丝线框 + `--radius-card`、无阴影**（不做"卡中卡"投影堆叠）；
 *   · 组头 = 子码（等宽 mono，`--meta`）+ 该组方向说明（muted）；
 *   · 报站行**归入**对应分组；分组按子码升序，组内沿用接口的报站升序；
 *   · **单分组（或无 `platform` 字段）→ 不显示分组容器与子码行** ⇒ 与旧版完全一致（向后兼容）；
 *   · 分组 >3 时第 3 组起折叠。
 *
 *   ⚠️ 08 §D.2：子码里的 `/` 是**分组号**的一部分，**绝不套线路标签的墨色组胶囊**
 *      （否则会被读成"T373 或 1 两条线"）—— 故子码只用等宽同色连写。
 *
 * ── 数据 ──────────────────────────────────────────────────────────────
 *   · 站名/坐标由调用方（NavShell，来自 `/api/stations`）传入；
 *   · 报站列表 `fetch('/api/station/eta?code=…')`（进入卡片时拉一次；含加载/失败态）；
 *     ★ `platform` 字段由 `/api/station/eta` 返回（贝洛奇 v2.3.0）——**按"可能存在"消费**。
 *
 * ── 降级 ──────────────────────────────────────────────────────────────
 *   接口失败/空 ⇒ 就地提示「暂无报站」，**不阻塞**设为起点/目的地与搜索、出发。
 *
 * ★ 站名/线路名用**繁体**，界面文案用**简体**（§6.2）。
 * ★ 报站的**站数 N** 与「**即将到站**」用 `<b>` + 青花蓝突出（与卡片报站行同款）。
 */
import { useEffect, useMemo, useState } from "react";
import RouteStack from "@/components/RouteStack";
import Icon from "@/components/ui/Icon";
import { EtaText } from "@/components/RoutePieces";

export interface StationCardStation {
  /** 主码 */
  code: string;
  /** 站名（繁体） */
  name: string;
  /** 经度（GCJ-02） */
  lng: number;
  /** 纬度（GCJ-02） */
  lat: number;
}

/** `/api/station/eta` 一条（与后端 `StationEtaItem` 对应） */
interface EtaItem {
  route: string;
  dir: string;
  /** ★ B4：本站台码（如 `T373/1`）；旧版接口可能不返回 → 缺省时退化为单分组 */
  platform?: string;
  dirLabel: string;
  stopsAway: number | null;
  etaMin: number | null;
  ok: boolean;
  /** ★ 2026-09-22：载具种类（缺省按巴士，兼容旧接口） */
  kind?: "bus" | "lrt";
  /** ★ 2026-09-22 轻轨专用：下一班发车时刻 `HH:MM` */
  nextAt?: string | null;
}

interface EtaResponse {
  code: string;
  fetchedAt: string;
  items: EtaItem[];
}

/** 站码主码归一（剥站台后缀：`T373/1` → `T373`）。
 *  ⚠️ 故意**本地内联**：`@/lib/recommend/segment-lookup` 是 server-only（含 pg），
 *     客户端组件不能 import（`poi-search.ts` 也是同样做法的本地副本）。 */
function mainCodeOf(code: string): string {
  return /^[A-Za-z]+\d+/.exec(code)?.[0] ?? code;
}

/**
 * 报站内容（简体）。
 * · 巴士：ok=false→取不到；无车→暂无在途车；0 站→即将到站；否则「还有 N 站 · 约 M 分」
 * · **轻轨**（★ 2026-09-22）：走**时刻表** ⇒ 显示「下一班 HH:MM · M 分后」；已收班 ⇒「今日已收班」
 *   ★ 其中 **石排湾线 / 横琴线** 额外显示**秒级倒计时**（用户口径：这两条班次疏，读秒才有意义）
 * ★ 站数 N 与「即将到站」由 `<EtaText>` 加粗 + 青花蓝（通勤决策的关键数字，第一眼可见）。
 */
function etaNode(it: EtaItem, nowMs: number) {
  if (it.kind === "lrt") {
    if (it.etaMin === null) return <>今日已收班</>;
    const at = it.nextAt ?? "";
    // ★ 石排湾线 / 横琴线：秒级倒计时（按 nextAt 那个**整分**算剩余秒数）
    const withSeconds = /石排湾|横琴/.test(it.route);
    if (withSeconds && it.nextAt && /^\d{1,2}:\d{2}$/.test(it.nextAt)) {
      const macau = new Date(nowMs + 8 * 3_600_000);
      const [hh, mm] = it.nextAt.split(":").map(Number);
      const target = Date.UTC(
        macau.getUTCFullYear(),
        macau.getUTCMonth(),
        macau.getUTCDate(),
        hh,
        mm,
        0,
      ) - 8 * 3_600_000;
      const left = Math.max(0, Math.round((target - nowMs) / 1000));
      const m = Math.floor(left / 60);
      const s = left % 60;
      if (left <= 0) return <EtaText text={`${at} 即将开出`} />;
      return (
        <EtaText text={`下一班 ${at} · ${m} 分 ${String(s).padStart(2, "0")} 秒后`} />
      );
    }
    return <EtaText text={it.etaMin === 0 ? `${at} 即将开出` : `下一班 ${at} · ${it.etaMin} 分后`} />;
  }
  if (!it.ok) return <>这条线路暂时取不到报站</>;
  if (it.stopsAway === null) return <>暂无在途车</>;
  return (
    <EtaText text={it.stopsAway === 0 ? "即将到站" : `还有 ${it.stopsAway} 站 · 约 ${it.etaMin ?? 0} 分`} />
  );
}

/** 分组上限：超过则折叠其余（08 §D.2） */
const MAX_GROUPS = 3;

export default function StationCard({
  station,
  colors,
  onClose,
  onSetFrom,
  onSetTo,
}: {
  station: StationCardStation;
  colors: Record<string, string>;
  onClose: () => void;
  onSetFrom: () => void;
  onSetTo: () => void;
}) {
  const [phase, setPhase] = useState<"loading" | "ready" | "failed">("loading");
  const [items, setItems] = useState<EtaItem[]>([]);
  const [showAllGroups, setShowAllGroups] = useState(false);
  /**
   * ★ 2026-09-22：秒级倒计时的时钟。
   *   **只在列表里出现「石排湾线 / 横琴线」时才起定时器**（用户口径：只给这两条读秒），
   *   否则每秒重渲染纯属浪费。
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const needSec = items.some((it) => /石排湾|横琴/.test(it.route));
    if (!needSec) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [items]);

  useEffect(() => {
    let alive = true;
    setPhase("loading");
    setItems([]);
    setShowAllGroups(false);
    fetch(`/api/station/eta?code=${encodeURIComponent(station.code)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<EtaResponse>)
      .then((j) => {
        if (!alive) return;
        setItems(Array.isArray(j.items) ? j.items : []);
        setPhase("ready");
      })
      .catch(() => {
        if (alive) setPhase("failed");
      });
    return () => {
      alive = false;
    };
  }, [station.code]);

  const main = mainCodeOf(station.code);
  /**
   * ★ 2026-09-22：**轻轨站**（主码 `LRT-` 前缀）。
   *   产品要求（用户反馈）：轻轨站**不要显示 `LRT-XXX` 这种码**，只显示繁体中文站名；
   *   巴士站保持「主码 + 站名」—— 那是用户认站的依据（`M123` / `T373`）。
   */
  const isLrt = station.code.startsWith("LRT-");

  /** 按 `platform` 聚合为站台分组；无 `platform` → 退化成「单组」（不画框、不显子码） */
  const groups = useMemo(() => {
    const map = new Map<string, { platform: string; items: EtaItem[] }>();
    for (const it of items) {
      const p = (it.platform ?? "").trim();
      const key = p || "__single__";
      if (!map.has(key)) map.set(key, { platform: p, items: [] });
      map.get(key)!.items.push(it);
    }
    // 分组按子码升序（`/1` 前 `/2` 后）；组内沿用接口的报站升序
    return [...map.values()].sort((a, b) =>
      a.platform.localeCompare(b.platform, "zh-Hant", { numeric: true }),
    );
  }, [items]);

  const multiGroup = groups.length > 1;
  const shownGroups = multiGroup && !showAllGroups ? groups.slice(0, MAX_GROUPS) : groups;
  const restGroups = groups.length - shownGroups.length;

  const lineCount = new Set(items.map((i) => `${i.route}|${i.dir}`)).size;
  const allFailed = phase === "ready" && !items.length;

  return (
    <div className="nav-station-card" role="dialog" aria-label={`站点 ${station.name}`}>
      <div className="nav-station-card__head">
        <span className="nav-station-card__name">
          {/* ★ 2026-09-22：轻轨站**不显示主码**（`LRT-SPW` 这类），只显示中文站名 */}
          {!isLrt && <span className="nav-station-card__code">{main}</span>}
          {station.name ? `${isLrt ? "" : " "}${station.name}` : ""}
        </span>
        <button className="nav-station-card__close" type="button" aria-label="关闭" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
      </div>

      {/* 副行：先告诉用户"为什么下面分了（或没分）组" */}
      {phase === "ready" && items.length > 0 && (
        <p className="nav-station-card__meta">
          {multiGroup ? `${groups.length} 个站台分组 · ` : ""}
          {lineCount} 条线路
        </p>
      )}

      <div className="nav-station-card__list">
        {phase === "loading" && <p className="t-label t-muted">读取报站中…</p>}
        {phase === "failed" && <p className="t-label t-muted">暂无报站</p>}
        {allFailed && <p className="t-label t-muted">暂无报站</p>}

        {phase === "ready" &&
          shownGroups.map((g) => {
            const rows = g.items.map((it) => (
              <div className="nav-station-card__row" key={`${it.route}-${it.dir}`}>
                <RouteStack codes={[it.route]} colorOf={(c) => colors[c] ?? null} size="sm" />
                <span className="nav-station-card__dir t-label t-muted">{it.dirLabel}</span>
                <span className="nav-station-card__eta t-label">{etaNode(it, nowMs)}</span>
              </div>
            ));
            // ★ 单分组（或无 platform）→ 不显示分组容器与子码行（向后兼容）
            if (!multiGroup) return <div key="single">{rows}</div>;
            const dirs = new Set(g.items.map((i) => i.dirLabel));
            return (
              <div className="st-group" key={g.platform || "__single__"}>
                <div className="st-group__head">
                  {/* ★ 子码连写、等宽同色；`/` 是分组号，不套线路胶囊 */}
                  <span className="st-group__code">{g.platform || main}</span>
                  {dirs.size === 1 && <span className="st-group__dir">{g.items[0].dirLabel}</span>}
                </div>
                {rows}
              </div>
            );
          })}

        {restGroups > 0 && (
          <button type="button" className="st-group__fold" onClick={() => setShowAllGroups(true)}>
            展开其余 {restGroups} 个分组
            <Icon name="caretDown" size={16} />
          </button>
        )}
      </div>

      <div className="nav-station-card__acts">
        <button className="btn btn--outline btn--sm" type="button" onClick={onSetFrom}>
          设为起点
        </button>
        <button className="btn btn--primary btn--sm" type="button" onClick={onSetTo}>
          设为目的地
        </button>
      </div>
    </div>
  );
}
