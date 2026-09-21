"use client";

/**
 * 首页导航壳（src/components/nav/NavShell.tsx，M Map 改版 S2 重构）
 *
 * ── 组成（设计 D.1 / PRD §8 状态机）───────────────────────────────────
 *   · **全屏地图**（`fixed`，底部让出底部导航带以保留高德 Logo/审图号）；
 *   · 顶部浮层：品牌字标 `M Map`（16px/600，**不是大标题**）+ 右上定位按钮；
 *   · 顶置**目的地**搜索条（白底 + 1.5px 青花蓝描边 + 3px 硬投影）→ 点开分步弹层；
 *   · 分步弹层（`StepSheet`）：选目的地 → 地图标定 → 选出发地 → 出发；
 *   · 站点信息卡（点地图巴士站）。
 *
 * ── 铁律 ──────────────────────────────────────────────────────────────
 *   · ★ **不记忆**出发点（不用 localStorage，产品 R5）；收藏是**用户显式意图**，故允许（02 §2.1）；
 *   · 「出发」→ 组 `/nav` URL（★ 坐标 **GCJ-02**）；
 *   · 地图失败**不阻塞**：搜索与出发照常（§Q7）。
 */
import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import NavMap from "./NavMap";
import StepSheet, { queryOf } from "./StepSheet";
import StationCard, { type StationCardStation } from "./StationCard";
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

/** 地图中心读取器（`StepSheet` 第 2 步「用这个点」用） */
type CenterProbe = () => { lng: number; lat: number } | null;

export default function NavShell({ jsKey, colors = {}, initialFrom = null, initialTo = null }: NavShellProps) {
  const router = useRouter();
  /** 定位点（GCJ-02）；null = 尚未定位/定位失败 */
  const [userPos, setUserPos] = useState<{ lng: number; lat: number } | null>(null);
  const [from, setFrom] = useState<NavPoint | null>(initialFrom);
  const [to, setTo] = useState<NavPoint | null>(initialTo);
  const [picking, setPicking] = useState(false);
  const [station, setStation] = useState<StationCardStation | null>(null);
  /** 分步状态：1 选目的地 · 2 确认位置 · 3 选出发地 · 4 出发 */
  const [step, setStep] = useState<1 | 2 | 3 | 4>(initialTo ? 3 : 1);
  const [sheetOpen, setSheetOpen] = useState(!!initialTo);
  /** 重新定位触发计数（右上定位按钮） */
  const [locateTick, setLocateTick] = useState(0);
  const centerProbeRef = useRef<CenterProbe | null>(null);
  const favs = useCombos();

  const onLocate = useCallback((pos: { lng: number; lat: number } | null) => setUserPos(pos), []);
  const onStationClick = useCallback((s: StationCardStation) => setStation(s), []);
  const onMapClick = useCallback(() => setStation(null), []);
  const onMapReady = useCallback((probe: CenterProbe) => {
    centerProbeRef.current = probe;
  }, []);

  const myLocation: NavPoint | null = userPos
    ? { kind: "gps", label: MY_LOCATION, lng: userPos.lng, lat: userPos.lat }
    : null;
  const fromPoint = from ?? myLocation;
  const canGo = !!fromPoint && !!to;

  /** 进入下一步（仅在有目的地时） */
  function goStep(n: 1 | 2 | 3 | 4) {
    setStep(n);
    setSheetOpen(true);
  }

  function pickDest(p: NavPoint) {
    setTo(p);
    goStep(2); // ★「地图标定」是进入 S1 的标志
  }

  function clearDest() {
    setTo(null);
    goStep(1);
  }

  function useMapCenter() {
    const c = centerProbeRef.current?.();
    if (c && to) setTo({ ...to, lng: c.lng, lat: c.lat });
    goStep(3);
  }

  function useMyLocation() {
    if (myLocation) setFrom(null); // 省一次？—— 显式意图：置回「我的位置」
    goStep(4);
  }

  function go() {
    if (!fromPoint || !to) return;
    setPicking(true);
    router.push(`/nav?${queryOf(fromPoint, to)}`);
  }

  /** ★ S2：常用 = **收藏组合**（排除已停用），按最近使用取前 3 */
  const quickPairs = favs.mounted
    ? [...favs.combos]
        .filter((c) => !c.disabled)
        .sort((a, b) => (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt))
        .slice(0, 3)
    : [];

  return (
    <section className="nav-shell nav-shell--full">
      <div className="nav-map-wrap">
        <NavMap
          jsKey={jsKey}
          className="nav-map--full"
          dest={to ? { lng: to.lng, lat: to.lat, label: to.label } : null}
          locateTick={locateTick}
          onLocate={onLocate}
          onStationClick={onStationClick}
          onMapClick={onMapClick}
          onMapReady={onMapReady}
        />

        {/* 品牌栏：品牌字标 + 定位按钮
            ★ v2.4.1：从地图**上方**移到地图**下方**（用户要求「首页地图上方仅保留搜索框」）。
              DOM 仍留在 `.nav-map-wrap` 内（它需要压在地图上），靠 CSS 把定位方向由 top 改为 bottom。
              ⚠️ 类名同步由 `.nav-top` 改为 `.nav-brandbar` —— 旧名说的是「在顶部」，
                 与它现在的位置矛盾，不改会误导后续维护。 */}
        <div className="nav-brandbar">
          <span className="nav-brand">M Map</span>
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

        {/* 顶置目的地搜索条 → 打开分步弹层 */}
        <button
          type="button"
          className="nav-searchbar"
          onClick={() => goStep(to ? 3 : 1)}
          aria-label={to ? `已选目的地 ${to.label}，点击修改` : "选择目的地"}
        >
          <Icon name="search" size={20} />
          <span className={`nav-searchbar__text${to ? "" : " nav-searchbar__text--ph"}`}>
            {to ? to.label : "去哪儿？"}
          </span>
          {step > 1 && to && (
            <span className="nav-searchbar__tag t-label">
              <Icon name="destination" size={16} />
              已选
            </span>
          )}
        </button>

        {/* 带入收藏提示条（PRD §7.5 可选） */}
        {initialTo && (
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
              goStep(4);
            }}
            onSetTo={() => {
              pickDest(stationToNavPoint(station));
              setStation(null);
            }}
          />
        )}
      </div>

      {sheetOpen && (
        <>
          <button
            type="button"
            className="step-sheet__scrim"
            aria-label="收起规划面板"
            onClick={() => setSheetOpen(false)}
          />
          <StepSheet
            step={step}
            dest={to}
            from={from}
            userPos={userPos}
            colors={colors}
            quickPairs={quickPairs}
            onPickDest={pickDest}
            onClearDest={clearDest}
            onPickFrom={(p) => {
              setFrom(p);
              goStep(4);
            }}
            onUseMyLocation={useMyLocation}
            onUseMapCenter={useMapCenter}
            onBack={() => goStep((Math.max(1, step - 1) as 1 | 2 | 3 | 4))}
            onGo={go}
            going={picking}
            canGo={canGo}
            /* ★ B6：下拖超阈值 / Esc → 关闭弹层（弹层自己不做状态机，只上报） */
            onDismiss={() => setSheetOpen(false)}
          />
        </>
      )}
    </section>
  );
}

/** 站点 → NavPoint（`kind='station'`，label 带站码，与 POI 搜索框口径一致） */
function stationToNavPoint(s: StationCardStation): NavPoint {
  return { kind: "station", label: `${s.code} ${s.name}`.trim(), lng: s.lng, lat: s.lat, code: s.code };
}
