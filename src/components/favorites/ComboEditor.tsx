"use client";

/**
 * 收藏 · 组合编排编辑器（src/components/favorites/ComboEditor.tsx，v2.3.0 S3 · 08 §C.3）
 *
 * ── 形态：**纵向流程图**（自上而下）────────────────────────────────────
 *   出发地 → 步行① → 上车站 → ＋插入换乘 → 换乘站 → 换乘步行 → 上车站 → 下车 → 步行② → 目的地
 *
 * ── 可编辑项与默认值（06 §3.3 / 07 §2.5）────────────────────────────────
 *   · **站链**：`chain` 空 = 自动选线；显式指定上/下/换乘站后 `chain` 非空（**换乘 ≤ 3 → 段 ≤ 4**）。
 *   · **两段步行**：距离 `0–2000 m`、时长 `0–30 min`；默认 **`分钟 = 距离 ÷ 84`**（`WALK_BASE_M_PER_MIN`），
 *     可用「联动锁」解锁为**各自独立**（`link:false`）。
 *   · **五档速度**：默认 `= (84/60) ÷ SPEED_RATIO[k]` ⇒ **3.6 / 2.0 / 1.4 / 1.0 / 0.7 m/s**（档 3 = 基准）。
 *   · **五档用时**：默认 `= requiredSec(距离 ÷ 84, 档, 距离)`（★ 与模型**同一真源**：档 1 走
 *     `TIER1_SEGMENTS` 随距离衰减、含 `OVERHEAD_SEC`）。
 *
 * ── 状态表达（08 §C.3(b)，[重点]）───────────────────────────────────────
 *   **灰度 = 系统给的（自动）** / **实色 = 你定的（手改）**；手改行右侧给
 *   `手改` 标记 + **「还原为自动」**。未编排的整块用虚线（`.combo-seg--auto`）。
 *
 * ── 提交语义（08 §C.3(c)）──────────────────────────────────────────────
 *   `保存` → 写回 `updateCombo`（**不触发计算**）；`取消/返回` 且有改动 → 二次确认「放弃修改？」。
 *
 * ⚠️ 本组件**不自造口径**：档位用时一律走 `requiredSec`（单一真源），避免与卡片/详情页分叉。
 * ⚠️ 文案一律**简体**（站名/线路名保留繁体）。
 */
import { useMemo, useState } from "react";
import Icon from "@/components/ui/Icon";
import PoiSearchBox from "@/components/nav/PoiSearchBox";
import { updateCombo } from "@/lib/favorites/useCombos";
import { MAX_TRANSFERS } from "@/lib/nav/combo-params";
import type { Combo, ComboChainStep, ComboTierNumber, ComboTiers, ComboWalk, ComboWalkSeg } from "@/lib/favorites/types";
import { SPEED_RATIO, TIER_TEXT, WALK_BASE_M_PER_MIN, type CatchTier } from "@/lib/recommend/types";
import { requiredSec } from "@/lib/recommend/catch-up";
import type { NavPoint } from "@/lib/nav/types";

const TIERS: ComboTierNumber[] = [1, 2, 3, 4, 5];
/** 五档短名（分段选择器用；完整文案见 `TIER_TEXT`） */
const TIER_SHORT: Record<ComboTierNumber, string> = {
  1: "冲刺",
  2: "小跑",
  3: "正常",
  4: "慢走",
  5: "爬行",
};
/** 距离/时长范围（06 §3.3） */
const DIST_MIN = 0;
const DIST_MAX = 2000;
const MIN_MIN = 0;
const MIN_MAX = 30;

/** 档位默认速度（m/s）= 基准速度 ÷ 时间倍率 ⇒ 3.6/2.0/1.4/1.0/0.7 */
const defaultSpeed = (t: ComboTierNumber): number =>
  Math.round(((WALK_BASE_M_PER_MIN / 60) / SPEED_RATIO[t as CatchTier]) * 10) / 10;

/** 档位用时（分钟）—— ★ 与模型同一真源（`requiredSec` 返回秒） */
function tierMinutes(distanceM: number | null, t: ComboTierNumber): number {
  if (distanceM === null || distanceM <= 0) return Math.round((distanceM ?? 0) / WALK_BASE_M_PER_MIN);
  const sec = requiredSec(distanceM / WALK_BASE_M_PER_MIN, t as CatchTier, distanceM);
  return Math.round(sec / 60);
}

export interface ComboEditorProps {
  combo: Combo;
  colors: Record<string, string>;
  readOnly: boolean;
  /** 返回列表（未保存时若有改动会先行二次确认） */
  onClose: () => void;
}

export default function ComboEditor({ combo, colors, readOnly, onClose }: ComboEditorProps) {
  // ── 草稿（保存前只改本地）──
  const [name, setName] = useState(combo.name);
  const [nameEdited, setNameEdited] = useState(!!combo.nameEdited);
  const [chain, setChain] = useState<ComboChainStep[]>(combo.chain ? combo.chain.map((s) => ({ ...s })) : []);
  const [walk, setWalk] = useState<ComboWalk>({
    seg1: combo.walk?.seg1 ? { ...combo.walk.seg1 } : {},
    seg2: combo.walk?.seg2 ? { ...combo.walk.seg2 } : {},
  });
  const [tiers, setTiers] = useState<ComboTiers>({
    speedMps: { ...(combo.tiers?.speedMps ?? {}) },
    minutes: { ...(combo.tiers?.minutes ?? {}) },
  });

  const [pickAt, setPickAt] = useState<number | null>(null); // 正在为哪个 chain 节点选站
  const [dirty, setDirty] = useState(false);
  const [needConfirm, setNeedConfirm] = useState(false);
  const [msg, setMsg] = useState("");

  const touch = () => setDirty(true);

  // ── 站链操作 ──
  const transfers = Math.max(0, chain.length - 2);

  function ensureChain(): ComboChainStep[] {
    if (chain.length >= 2) return chain;
    // 首次编辑站链 → 用当前组合端点兜底成「上车/下车」两点（码留空待用户选）
    const next: ComboChainStep[] = [
      { kind: "board", code: "", label: "（选上车站）" },
      { kind: "alight", code: "", label: "（选下车站）" },
    ];
    setChain(next);
    touch();
    return next;
  }

  function insertTransfer() {
    const c = ensureChain();
    if (c.length - 1 >= MAX_TRANSFERS + 1) {
      setMsg(`最多 ${MAX_TRANSFERS} 次换乘（${MAX_TRANSFERS + 1} 段）`);
      return;
    }
    const next = [...c];
    next.splice(next.length - 1, 0, { kind: "transfer", code: "", label: "（选换乘站）" });
    setChain(next);
    touch();
  }

  function removeAt(i: number) {
    const next = chain.filter((_, k) => k !== i);
    setChain(next);
    touch();
  }

  function setStation(i: number, p: NavPoint) {
    const next = chain.map((s, k) =>
      k === i ? { ...s, code: p.code ?? "", label: p.label, lng: p.lng, lat: p.lat } : s,
    );
    setChain(next);
    setPickAt(null);
    touch();
  }

  // ── 步行段操作 ──
  function setWalkSeg(key: "seg1" | "seg2", patch: ComboWalkSeg) {
    setWalk((w) => {
      const cur = w[key] ?? {};
      const next: ComboWalkSeg = { ...cur, ...patch };
      // 联动（默认）：给了距离且未解锁 → 时长 = 距离 ÷ 84
      const linked = next.link !== false;
      if (patch.distanceM !== undefined && linked) {
        next.minutes = Math.round((patch.distanceM / WALK_BASE_M_PER_MIN) * 10) / 10;
      }
      return { ...w, [key]: next };
    });
    touch();
  }

  function clearWalkSeg(key: "seg1" | "seg2") {
    setWalk((w) => ({ ...w, [key]: {} }));
    touch();
  }

  // ── 五档操作 ──
  function setTier(kind: "speedMps" | "minutes", t: ComboTierNumber, v: number | null) {
    setTiers((x) => {
      const map = { ...(x[kind] ?? {}) };
      if (v === null) delete map[t];
      else map[t] = v;
      return { ...x, [kind]: map };
    });
    if (kind === "speedMps" && t === 3) setMsg("档 3 是全局步行基准，改动会影响其他行程的步行估算");
    touch();
  }

  // ── 预览（不请求服务端）──
  const preview = useMemo(() => {
    const segMin = (key: "seg1" | "seg2") => {
      const seg = walk[key];
      if (!seg) return null;
      if (typeof seg.minutes === "number") return seg.minutes;
      if (typeof seg.distanceM === "number" && seg.distanceM > 0) return seg.distanceM / WALK_BASE_M_PER_MIN;
      return null;
    };
    const a = segMin("seg1");
    const b = segMin("seg2");
    const walked = (a ?? 0) + (b ?? 0);
    const known = a !== null && b !== null;
    const dist1 = typeof walk.seg1?.distanceM === "number" ? walk.seg1.distanceM : null;
    return {
      segCount: chain.length >= 2 ? chain.length - 1 : 0,
      transfers,
      known,
      totalMin: known ? Math.round(walked) : null,
      dist1,
    };
  }, [walk, chain, transfers]);

  function save() {
    if (readOnly) return;
    /**
     * ★ 站链写库前置条件：**每个节点都必须选了站（`code` 非空）**。
     *   否则视为「未编排」——避免写入 **`sanitizeChain` 会整条丢弃**的半成品
     *   （真机冒烟发现：节点只有占位 label、`code` 为空时写库，下次读取会被静默剔除）。
     */
    const chainOk = chain.length >= 2 && chain.every((s) => !!s.code);
    const patch: Partial<Combo> = {
      name: name.trim() || combo.name,
      chain: chainOk ? chain : undefined,
      walk: walk.seg1 || walk.seg2 ? walk : undefined,
      tiers: tiers.speedMps || tiers.minutes ? tiers : undefined,
    };
    if (nameEdited) patch.nameEdited = true;
    const res = updateCombo(combo.id, patch);
    if (res.ok) {
      setDirty(false);
      onClose();
    } else {
      setMsg(res.reason === "unavailable" ? "当前浏览器不支持本地收藏，无法保存" : "保存失败，请稍后再试");
    }
  }

  function tryClose() {
    if (dirty) setNeedConfirm(true);
    else onClose();
  }

  /** 一行「车站」节点 */
  const StationRow = ({ i, name: roleName }: { i: number; name: string }) => {
    const s = chain[i];
    const manual = !!s?.code;
    return (
      <div className="combo-node">
        <span className="combo-flow__dot" aria-hidden="true" />
        <div className="combo-node__body">
          <div className="combo-node__head">
            <span className="combo-node__role t-label t-muted">{roleName}</span>
            {manual ? <span className="combo-state combo-state--manual t-label">手改</span> : null}
          </div>
          {pickAt === i ? (
            <PoiSearchBox
              label="选站"
              value={null}
              onChange={(p) => setStation(i, p)}
              colors={colors}
              placeholder="搜站点 / 地点"
              autoFocus
            />
          ) : (
            <button
              type="button"
              className={`combo-node__pick${manual ? " is-manual" : ""}`}
              onClick={() => {
                ensureChain();
                setPickAt(i);
              }}
            >
              <Icon name="busStop" size={16} />
              <span>{s?.label ?? "（未指定 → 自动选线）"}</span>
              <Icon name="forward" size={16} />
            </button>
          )}
        </div>
        {chain.length > 2 && i > 0 && i < chain.length - 1 && (
          <button type="button" className="combo-node__del" aria-label="删除该换乘" onClick={() => removeAt(i)}>
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
    );
  };

  /** 一个步行段 */
  const WalkSeg = ({ key: k, role }: { key: "seg1" | "seg2"; role: string }) => {
    const seg = walk[k] ?? {};
    const auto = seg.distanceM === undefined && seg.minutes === undefined;
    const linked = seg.link !== false;
    return (
      <div className={`combo-seg${auto ? " combo-seg--auto" : ""}`}>
        <div className="combo-seg__head">
          <Icon name="walk" size={16} />
          <span className="combo-seg__role">{role}</span>
          <span className={`combo-state${auto ? "" : " combo-state--manual"} t-label`}>{auto ? "自动" : "手改"}</span>
          {!auto && (
            <button type="button" className="combo-seg__reset t-label" onClick={() => clearWalkSeg(k)}>
              <Icon name="undo" size={16} />
              还原为自动
            </button>
          )}
        </div>
        <div className="combo-seg__fields">
          <label className="combo-field t-label">
            距离
            <input
              className="inp combo-field__inp"
              type="number"
              min={DIST_MIN}
              max={DIST_MAX}
              step={10}
              value={seg.distanceM ?? ""}
              placeholder="自动"
              onChange={(e) => {
                const v = e.target.value === "" ? undefined : Math.min(DIST_MAX, Math.max(DIST_MIN, Number(e.target.value)));
                setWalkSeg(k, { distanceM: v });
              }}
            />
            m
          </label>
          <label className="combo-field t-label">
            时长
            <input
              className="inp combo-field__inp"
              type="number"
              min={MIN_MIN}
              max={MIN_MAX}
              step={1}
              value={seg.minutes ?? ""}
              placeholder="自动"
              onChange={(e) => {
                const v = e.target.value === "" ? undefined : Math.min(MIN_MAX, Math.max(MIN_MIN, Number(e.target.value)));
                setWalkSeg(k, { minutes: v });
              }}
            />
            分
          </label>
          <button
            type="button"
            className={`combo-lock t-label${linked ? " is-on" : ""}`}
            aria-pressed={linked}
            title={linked ? "距离与时长联动（改距离自动改时长）" : "已解锁：距离与时长各自独立"}
            onClick={() => setWalkSeg(k, { link: !linked })}
          >
            {linked ? "联动" : "独立"}
          </button>
        </div>
      </div>
    );
  };

  /** 五档分段选择器（速度 / 用时各一行） */
  const TierPicker = ({ kind }: { kind: "speedMps" | "minutes" }) => {
    const dist = typeof walk.seg1?.distanceM === "number" ? walk.seg1.distanceM : null;
    return (
      <div className="combo-speed">
        <span className="combo-speed__title t-label t-muted">{kind === "speedMps" ? "五档速度" : "五档用时"}</span>
        <div className="combo-speed__row" role="group" aria-label={kind === "speedMps" ? "五档速度" : "五档用时"}>
          {TIERS.map((t) => {
            const overridden = tiers[kind]?.[t] !== undefined;
            const shown =
              kind === "speedMps"
                ? (tiers.speedMps?.[t] ?? defaultSpeed(t))
                : (tiers.minutes?.[t] ?? tierMinutes(dist, t));
            return (
              <button
                key={t}
                type="button"
                className={`combo-speed__cell${overridden ? " is-manual" : ""}${t === 3 ? " is-base" : ""}`}
                title={`${TIER_TEXT[t as CatchTier]}${t === 3 ? "（基准档）" : ""}`}
                onClick={() => {
                  // 点格子 = 就地微调（+ / − 步进）；「还原」用长按/双击太隐晦，改为再次点击已改格 = 还原
                  if (overridden) {
                    setTier(kind, t, null);
                    return;
                  }
                  const next =
                    kind === "speedMps"
                      ? Math.round((defaultSpeed(t) + 0.1) * 10) / 10
                      : (tierMinutes(dist, t) ?? 0) + 1;
                  setTier(kind, t, next);
                }}
              >
                <span className="combo-speed__tier">{TIER_SHORT[t]}</span>
                <span className="combo-speed__val">
                  {kind === "speedMps" ? shown.toFixed(1) : shown}
                  <em>{kind === "speedMps" ? "m/s" : "分"}</em>
                </span>
              </button>
            );
          })}
        </div>
        <p className="combo-speed__hint t-label t-muted">
          {kind === "speedMps"
            ? "灰=默认 · 实=你改过；点一次改，再点已改的格 = 还原为默认"
            : `按距离 ${dist ?? "未知"} m 派生（档 1 随距离衰减）；灰=默认 · 实=你改过`}
        </p>
      </div>
    );
  };

  return (
    <div className="fav-page">
      {/* 顶栏：返回 / 命名 / 保存 */}
      <div className="editor-bar">
        <button type="button" className="btn btn--text btn--sm" onClick={tryClose}>
          <Icon name="back" size={20} />
          返回
        </button>
        <input
          className="inp editor-bar__name"
          value={name}
          maxLength={24}
          aria-label="组合名称"
          onChange={(e) => {
            setName(e.target.value);
            setNameEdited(true);
            touch();
          }}
        />
        <button type="button" className="btn btn--primary btn--sm" disabled={readOnly} onClick={save}>
          保存
        </button>
      </div>

      {readOnly && <p className="fav-note fav-note--warn t-label">当前浏览器不支持本地收藏，编辑无法保存（只读）。</p>}
      {msg && (
        <p className="fav-note fav-note--warn t-label" role="status">
          {msg}
        </p>
      )}

      {/* ── 纵向流程图 ── */}
      <div className="combo-flow">
        <div className="combo-node combo-node--end">
          <span className="combo-flow__dot combo-flow__dot--end" aria-hidden="true" />
          <div className="combo-node__body">
            <span className="combo-node__role t-label t-muted">出发地</span>
            <span className="combo-node__label">{combo.from.label}</span>
          </div>
        </div>

        {WalkSeg({ key: "seg1", role: "步行① 出发地 → 上车站" })}

        {chain.length < 2 && (
          <button type="button" className="combo-insert" onClick={() => { ensureChain(); touch(); }}>
            <Icon name="add" size={16} />
            指定上车站 / 下车站（默认自动选线）
          </button>
        )}
        {chain.length >= 2 && StationRow({ i: 0, name: "上车站" })}

        {chain.length >= 2 &&
          chain.slice(1, -1).map((s, k) => (
            <div key={`t-${k}`}>
              <div className="combo-seg combo-seg--transfer">
                <div className="combo-seg__head">
                  <Icon name="expandVertical" size={16} />
                  <span className="combo-seg__role">换乘步行（系统按站台布局/实测）</span>
                </div>
              </div>
              {StationRow({ i: k + 1, name: "换乘站" })}
            </div>
          ))}

        {chain.length >= 2 && (
          <button
            type="button"
            className="combo-insert"
            onClick={insertTransfer}
            disabled={transfers >= MAX_TRANSFERS}
          >
            <Icon name="add" size={16} />
            {transfers >= MAX_TRANSFERS ? `最多 ${MAX_TRANSFERS} 次换乘` : "插入换乘"}
          </button>
        )}

        {chain.length >= 2 && StationRow({ i: chain.length - 1, name: "下车站" })}

        {WalkSeg({ key: "seg2", role: "步行② 下车站 → 目的地" })}

        <div className="combo-node combo-node--end">
          <span className="combo-flow__dot combo-flow__dot--end" aria-hidden="true" />
          <div className="combo-node__body">
            <span className="combo-node__role t-label t-muted">目的地</span>
            <span className="combo-node__label">{combo.to.label}</span>
          </div>
        </div>
      </div>

      {/* ── 五档（分段选择器，不用滑杆）── */}
      <section className="card" style={{ marginTop: "var(--space-4)" }}>
        {TierPicker({ kind: "speedMps" })}
        {TierPicker({ kind: "minutes" })}
      </section>

      {/* ── 预览（改一项即更新；**不请求服务端**）── */}
      <div className="editor-preview t-label t-muted">
        预览：
        {preview.segCount > 0 ? `${preview.segCount} 段` : "未编排（自动选线）"}
        {` · ${preview.transfers} 次换乘`}
        {preview.known && preview.totalMin !== null ? ` · 步行合计约 ${preview.totalMin} 分` : " · 步行含自动段（合计稍后计算）"}
      </div>

      {/* 未保存二次确认（08 §C.3(c)） */}
      {needConfirm && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setNeedConfirm(false)}>
          <div className="dialog-card" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2 className="fav-confirm__title">放弃修改？</h2>
            <p className="fav-confirm__impact">未保存的编排会丢失。</p>
            <div className="fav-confirm__acts">
              <button type="button" className="btn btn--outline" onClick={() => setNeedConfirm(false)} autoFocus>
                继续编辑
              </button>
              <button type="button" className="btn btn--danger" onClick={onClose}>
                放弃
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
