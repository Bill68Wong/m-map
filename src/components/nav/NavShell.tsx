"use client";

/**
 * 首页导航壳（src/components/nav/NavShell.tsx）
 *
 * ── 2026-09-22 搜索界面重构（模仿高德/谷歌地图的两态交互）─────────────────
 *
 *  **旧版**：可拖拽底部抽屉 + 4 步引导（①选目的地 ②地图标定 ③选出发地 ④出发），
 *            每步高度不同、带惯性吸附。
 *  **新版**：**两态** ——
 *
 *    ┌─ S0 全屏地图 ────────────────────────────────┐
 *    │  顶部只有搜索框「去哪儿？」                    │
 *    └───────────────────────────────────────────────┘
 *              ↓ 点搜索框
 *    ┌─ S1 全屏搜索（`SearchSheet`）───────────────┐
 *    │  输入条 + 结果列表（打字=站点 / 搜索=含高德）  │
 *    └───────────────────────────────────────────────┘
 *              ↓ 选中地点
 *    ┌─ S2 半屏（`RoutePanel`）────────────────────┐
 *    │  上半屏：地图，**该地点居上半屏正中**         │
 *    │  下半屏：出发地（默认我的位置）/ 目的地 + 出发 │
 *    └───────────────────────────────────────────────┘
 *              ↓ 点「出发地」行
 *    ┌─ S3 全屏搜索（两行输入条：出发地 / 目的地）──┐
 *    └───────────────────────────────────────────────┘
 *              ↓ 选中出发地
 *    ┌─ S4 半屏 ───────────────────────────────────┐
 *    │  上半屏：地图，**两点都在视野内**（自动适配） │
 *    │  下半屏：两地 + 出发 → `/nav`                │
 *    └───────────────────────────────────────────────┘
 *
 * ── 铁律（沿用）───────────────────────────────────────────────────────
 *   · ★ **不记忆**出发点（产品 R5）；收藏是**用户显式意图**，故允许；
 *   · 「出发」→ 组 `/nav` URL（★ 坐标 **GCJ-02**）；
 *   · 地图失败**不阻塞**：搜索与出发照常；
 *   · ★ 弹窗是**覆盖层**（盖住地图），不是新页面 —— 避免整页加载的等待感。
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import NavMap from "./NavMap";
import RouteLinesSheet, { type RouteLineItem } from "./RouteLinesSheet";
import RoutePanel from "./RoutePanel";
import SearchSheet, { type QuickPair } from "./SearchSheet";
import StationCard, { type StationCardStation } from "./StationCard";
import { queryOf } from "./StepSheet";
import { useCombos } from "@/lib/favorites/useCombos";
import type { NavPoint } from "@/lib/nav/types";

const MY_LOCATION = "我的位置";

export interface NavShellProps {
  jsKey: string;
  colors?: Record<string, string>;
  /** 由「地点对收藏」带入的起点（收藏页回放用） */
  initialFrom?: NavPoint | null;
  /** 由「地点对收藏」带入的目的地 */
  initialTo?: NavPoint | null;
}

/** 弹层状态：关闭（全屏地图）/ 全屏（搜索）/ 半屏（起终点面板） */
type SheetState = "closed" | "full" | "half";

export default function NavShell({ jsKey, colors = {}, initialFrom = null, initialTo = null }: NavShellProps) {
  const router = useRouter();
  /** 定位点（GCJ-02）；null = 尚未定位/定位失败 */
  const [userPos, setUserPos] = useState<{ lng: number; lat: number } | null>(null);
  const [from, setFrom] = useState<NavPoint | null>(initialFrom);
  const [to, setTo] = useState<NavPoint | null>(initialTo);
  const [station, setStation] = useState<StationCardStation | null>(null);
  const [picking, setPicking] = useState(false);
  /** 重新定位触发计数（右上定位按钮） */
  const [locateTick, setLocateTick] = useState(0);

  /** ★ 弹层状态（带 initialTo 时直接进「半屏」= 可出发态，与旧版一致） */
  const [sheet, setSheet] = useState<SheetState>(initialTo ? "half" : "closed");
  /** 全屏态正在编辑哪个端点 */
  const [editing, setEditing] = useState<"dest" | "from">("dest");
  /**
   * 取景触发计数：状态变化时 +1，使 `NavMap` 重新取景。
   * ⚠️ 用计数而不是依赖对象本身 —— 同一模式连续触发（如两次都选「目的地」）也要生效。
   */
  const [viewTick, setViewTick] = useState(0);

  /**
   * ★ 2026-09-22 新增：**路线查看模式**。
   *   · `lineSheet`：是否展开「公共交通路线」全屏选择弹窗；
   *   · `pickedLine`：当前正在查看的线路（非空 ⇒ 地图画该线 + 底部显示主题色标签）。
   *   用户口径：选线路后弹窗关闭回地图，底部中间出现标签 + 叉，点叉退出。
   */
  const [lineSheet, setLineSheet] = useState(false);
  const [pickedLine, setPickedLine] = useState<RouteLineItem | null>(null);

  const favs = useCombos();

  const onLocate = useCallback((pos: { lng: number; lat: number } | null) => setUserPos(pos), []);
  const onStationClick = useCallback((s: StationCardStation) => setStation(s), []);
  const onMapClick = useCallback(() => setStation(null), []);

  const myLocation: NavPoint | null = userPos
    ? { kind: "gps", label: MY_LOCATION, lng: userPos.lng, lat: userPos.lat }
    : null;
  const fromPoint = from ?? myLocation;
  const canGo = !!fromPoint && !!to;

  /**
   * 视口指令（交给 `NavMap`）：
   *   · 半屏 + 只有目的地 → `dest-center-top`（该点居**上半屏正中**）
   *   · 半屏 + 起终点都有 → `fit-two`（两点都在视野内）
   *   · 全屏搜索 / 全屏地图 → `none`（弹窗盖住地图，取景无意义）
   */
  const viewMode: "dest-center-top" | "fit-two" | "none" =
    sheet === "half" ? (from ? "fit-two" : to ? "dest-center-top" : "none") : "none";

  /** 打开全屏搜索 */
  function openSearch(which: "dest" | "from") {
    setEditing(which);
    setSheet("full");
  }

  /** 全屏返回：**回到半屏**（若有目的地）否则回全屏地图 */
  function backFromSearch() {
    setSheet(to ? "half" : "closed");
    setViewTick((t) => t + 1);
  }

  /** 选中某个端点 */
  function pickPoint(p: NavPoint, which: "dest" | "from") {
    if (which === "dest") setTo(p);
    else setFrom(p);
    setSheet("half");
    setViewTick((t) => t + 1);
  }

  function go() {
    if (!fromPoint || !to) return;
    setPicking(true);
    router.push(`/nav?${queryOf(fromPoint, to)}`);
  }

  /** 常用 = **收藏组合**（排除已停用），按最近使用取前 3 */
  const quickPairs: QuickPair[] = favs.mounted
    ? [...favs.combos]
        .filter((c) => !c.disabled)
        .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
        .slice(0, 3)
        .map((c) => ({ id: c.id, from: c.from, to: c.to }))
    : [];

  return (
    <section className="nav-shell nav-shell--full">
      <div className="nav-map-wrap">
        <NavMap
          jsKey={jsKey}
          className="nav-map--full"
          dest={to ? { lng: to.lng, lat: to.lat, label: to.label } : null}
          origin={from ? { lng: from.lng, lat: from.lat, label: from.label } : null}
          view={{ mode: viewMode, tick: viewTick }}
          locateTick={locateTick}
          onLocate={onLocate}
          onStationClick={onStationClick}
          onMapClick={onMapClick}
          /* ★ 2026-09-22：路线查看模式（非空 ⇒ 画该线路 + 本线站点高亮 + 自动装下整条线） */
          routeLine={pickedLine}
        />

        {/* 品牌栏：品牌字标 + （路线模式下）主题色标签 + 右侧按钮组（路线选择 / 定位） */}
        <div className="nav-brandbar">
          <span className="nav-brand">M Map</span>

          {/* ★ 2026-09-22：路线查看模式的**退出标签**（产品口径：只显示线路名 + 叉） */}
          {pickedLine && (
            <span className="nav-linechip" style={{ background: pickedLine.color }}>
              <span className="nav-linechip__text">{pickedLine.label}</span>
              <button
                type="button"
                className="nav-linechip__x"
                aria-label={`退出路线查看（${pickedLine.label}）`}
                title="退出路线查看"
                onClick={() => setPickedLine(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          )}

          <div className="nav-brandbar__acts">
            {/* ★ 2026-09-22：公共交通路线选择（在定位按钮**上方**） */}
            <button
              type="button"
              className="nav-locate"
              aria-label="公共交通路线"
              title="公共交通路线"
              onClick={() => setLineSheet(true)}
            >
              <Icon name="records" size={20} />
            </button>
            <button
              type="button"
              className="nav-locate"
              aria-label="定位到我的位置"
              title="定位到我的位置"
              onClick={() => setLocateTick((t) => t + 1)}
            >
              <Icon name="locate" size={20} />
            </button>
          </div>
        </div>

        {/* ★ 2026-09-22：公共交通路线全屏选择弹窗 */}
        {lineSheet && (
          <RouteLinesSheet
            onPick={(l) => {
              setPickedLine(l);
              setLineSheet(false);
            }}
            onClose={() => setLineSheet(false)}
          />
        )}

        {/* 顶置搜索条 —— **只在「非全屏搜索」时出现**（全屏时由 SearchSheet 自己的输入条接管） */}
        {sheet !== "full" && (
          <button
            type="button"
            className="nav-searchbar"
            onClick={() => openSearch("dest")}
            aria-label={to ? `已选目的地 ${to.label}，点击修改` : "选择目的地"}
          >
            <Icon name="search" size={20} />
            <span className={`nav-searchbar__text${to ? "" : " nav-searchbar__text--ph"}`}>
              {to ? to.label : "去哪儿？"}
            </span>
            {sheet === "half" && to && (
              <span className="nav-searchbar__tag t-label">
                <Icon name="destination" size={16} />
                已选
              </span>
            )}
          </button>
        )}

        {/* 带入收藏提示条（半屏可出发态才显示，避免与全屏搜索抢注意力） */}
        {initialTo && sheet === "half" && !from && (
          <div className="nav-banner t-label" role="status">
            已带入收藏：{initialFrom?.label ?? MY_LOCATION} → {initialTo.label}
          </div>
        )}

        {station && (
          <StationCard
            station={station}
            colors={colors}
            onClose={() => setStation(null)}
            onSetFrom={() => {
              setFrom(stationToNavPoint(station));
              setStation(null);
              setSheet("half");
              setViewTick((t) => t + 1);
            }}
            onSetTo={() => {
              setTo(stationToNavPoint(station));
              setStation(null);
              setSheet("half");
              setViewTick((t) => t + 1);
            }}
          />
        )}
      </div>

      {/* ── 全屏搜索层 ── */}
      {sheet === "full" && (
        <SearchSheet
          editing={editing}
          dest={to}
          from={from}
          userPos={userPos}
          colors={colors}
          quickPairs={quickPairs}
          onPick={pickPoint}
          onPickQuick={(f, t) => {
            setFrom(f);
            setTo(t);
            setSheet("half");
            setViewTick((n) => n + 1);
          }}
          onBack={backFromSearch}
        />
      )}

      {/* ── 下半屏起终点面板 ── */}
      {sheet === "half" && (
        <RoutePanel
          dest={to}
          from={from}
          userPos={userPos}
          canGo={canGo}
          going={picking}
          query={fromPoint && to ? queryOf(fromPoint, to) : ""}
          onGo={go}
          onTapFrom={() => openSearch("from")}
          onTapDest={() => openSearch("dest")}
        />
      )}
    </section>
  );
}

/** 站点 → NavPoint（`kind='station'`，label 带站码，与 POI 搜索口径一致） */
function stationToNavPoint(s: StationCardStation): NavPoint {
  return { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code };
}
