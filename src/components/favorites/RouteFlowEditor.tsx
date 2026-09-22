"use client";

/**
 * 路线流程图编辑页（src/components/favorites/RouteFlowEditor.tsx，2026-09-22 新增）
 *
 * ── 入口 ──────────────────────────────────────────────────────────────
 *   「收藏 → 组合 ⋯ → 查看路线」列表里点某张路线卡，或在列表页点「添加线路」。
 *
 * ── 能做什么（逐条对齐产品口径）────────────────────────────────────────
 *   ① **改步行**：路程（米）、速度（米/分）、速度档（1~5）三段都可改；
 *   ② **添加线路**：选上车站 + 下车站 → 系统自动补出
 *      「组合起点 → 上车站」与「下车站 → 组合终点」两段步行；
 *   ③ **添加换乘站**：在两段乘车之间插入 `transfer`；
 *   ④ **保存**：**手动保存**（不自动存）—— 保存前先调校验接口，
 *      有矛盾（如两段车之间没换乘、或该线无法顺向开到下车站）⇒ **拒绝保存并留在本页**；
 *   ⑤ **退出保护**：改动未保存时点返回 ⇒ 弹三选（不保存并退出 / 取消 / 保存）。
 *
 * ⚠️ 步行覆盖字段（`walkM`/`walkSpeed`/`walkTier`）随 `segs` 一起存进 `favorite_routes.segs`，
 *    不改动既有 `RouteFlow` 的 `walkOv` 体系（两套并存，本页以库内值为准）。
 */
import { useEffect, useMemo, useState } from "react";
import Icon from "@/components/ui/Icon";
import type { Combo } from "@/lib/favorites/types";

/** 分段（与 DB `segs` 同构 + 步行可编辑字段） */
export interface Seg {
  kind: "walk" | "ride" | "transfer" | "cross_border";
  phase?: "out" | "in";
  from?: string;
  to?: string;
  label?: string;
  route?: string;
  kind2?: "bus" | "lrt";
  board?: string;
  alight?: string;
  boardLabel?: string;
  alightLabel?: string;
  at?: string;
  /** ★ 步行可编辑：路程（米） */
  walkM?: number;
  /** ★ 步行可编辑：速度（米/分）；缺省 = 系统常速 84 */
  walkSpeed?: number;
  /** ★ 步行可编辑：速度档 1~5（越大越快）；缺省 = 常速档 3 */
  walkTier?: number;
}

export interface FavRoute {
  id: number;
  routeKey: string;
  fromSlug: string;
  toSlug: string;
  name: string;
  routeLabels: string[];
  segs: Seg[];
  source: string;
  sortOrder: number;
}

export interface RouteFlowEditorProps {
  combo: Combo;
  /** `null` = 新建 */
  route: FavRoute | null;
  fromSlug: string;
  toSlug: string;
  colors: Record<string, string>;
  /** `saved` = 是否已保存（父组件据此决定要不要重载列表） */
  onClose: (saved: boolean) => void;
}

/** 速度档文案（与全站「赶车五档」口径一致：3 = 常速） */
const TIER_LABEL: Record<number, string> = {
  1: "很慢",
  2: "偏慢",
  3: "常速",
  4: "偏快",
  5: "很快",
};

/** 站名显示（带站码） */
const showStop = (code?: string, label?: string) => label ?? code ?? "（未选）";

/** 新建时的空白骨架：出发地 → 上车站（待选）→ 下车站 → 目的地 */
function emptySegs(fromSlug: string, toSlug: string): Seg[] {
  return [
    { kind: "walk", phase: "out", from: `PLACE:${fromSlug}`, to: "", label: "组合起点" },
    { kind: "ride", route: "", kind2: "bus", board: "", alight: "" },
    { kind: "walk", phase: "in", from: "", to: `PLACE:${toSlug}`, label: "组合终点" },
  ];
}

export default function RouteFlowEditor({
  combo,
  route,
  fromSlug,
  toSlug,
  colors,
  onClose,
}: RouteFlowEditorProps) {
  const initial = useMemo<Seg[]>(
    () => (route?.segs?.length ? JSON.parse(JSON.stringify(route.segs)) : emptySegs(fromSlug, toSlug)),
    [route, fromSlug, toSlug],
  );
  const [segs, setSegs] = useState<Seg[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [showExit, setShowExit] = useState(false);
  /** 站名选择器：正在为哪一段的哪一端选站 */
  const [picker, setPicker] = useState<{ idx: number; side: "board" | "alight" } | null>(null);
  /** 正在编辑线路名的段 */
  const [routeEdit, setRouteEdit] = useState<number | null>(null);

  const patch = (idx: number, next: Partial<Seg>) => {
    setSegs((prev) => prev.map((s, i) => (i === idx ? { ...s, ...next } : s)));
    setDirty(true);
    setErrors([]);
  };

  /** 插入换乘（在某段 ride 之后） */
  function addTransfer(afterIdx: number) {
    const prev = segs[afterIdx];
    const at = prev?.alight ?? "";
    const label = prev?.alightLabel ?? at;
    setSegs((s) => [...s.slice(0, afterIdx + 1), { kind: "transfer", at, label }, ...s.slice(afterIdx + 1)]);
    setDirty(true);
    setErrors([]);
  }

  /** 删除某段 */
  function removeSeg(idx: number) {
    setSegs((s) => s.filter((_, i) => i !== idx));
    setDirty(true);
    setErrors([]);
  }

  /** 添加一段乘车（+ 其后的步行到终点） */
  function addRide() {
    setSegs((s) => {
      // 插在最后一个 ride 之后（若其后紧跟 walk(in)，插到它前面）
      const lastRide = s.map((x) => x.kind).lastIndexOf("ride");
      const at = lastRide < 0 ? 0 : lastRide + 1;
      return [...s.slice(0, at), { kind: "ride", route: "", kind2: "bus" as const, board: "", alight: "" }, ...s.slice(at)];
    });
    setDirty(true);
    setErrors([]);
  }

  /** 保存：先校验，再写库 */
  async function save(): Promise<boolean> {
    setSaving(true);
    setErrors([]);
    setWarnings([]);
    try {
      const v = await fetch("/api/fav-routes/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segs }),
      });
      const vj = (await v.json()) as { ok: boolean; errors: string[]; warnings: string[] };
      setWarnings(vj.warnings ?? []);
      if (!vj.ok) {
        setErrors(vj.errors ?? ["校验未通过"]);
        setSaving(false);
        return false;
      }
      const labels = segs.filter((s) => s.kind === "ride").map((s) => s.route ?? "");
      const key = `${fromSlug}-${toSlug}-${labels.join("-")}`.replace(/[^A-Za-z0-9\u4e00-\u9fff-]/g, "");
      const body = {
        route: {
          routeKey: route?.routeKey && route.source !== "preset" ? route.routeKey : key,
          fromSlug,
          toSlug,
          name: labels.join(" → ") || combo.name,
          routeLabels: labels,
          segs,
          sortOrder: route?.sortOrder ?? 999,
        },
      };
      const r = await fetch("/api/fav-routes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const rj = (await r.json()) as { ok: boolean; error?: string };
      if (!rj.ok) {
        setErrors([rj.error ?? "保存失败"]);
        setSaving(false);
        return false;
      }
      setDirty(false);
      setSaving(false);
      return true;
    } catch {
      setErrors(["保存失败：网络异常"]);
      setSaving(false);
      return false;
    }
  }

  /** 点返回 */
  function back() {
    if (dirty) setShowExit(true);
    else onClose(false);
  }

  // ESC 也走退出保护
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showExit) setShowExit(false);
        else back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, showExit]);

  return (
    <div className="rfe-page">
      <header className="rfe-head">
        <button type="button" className="rfe-head__back" onClick={back} aria-label="返回">
          <Icon name="back" size={20} />
        </button>
        <span className="rfe-head__title">{route ? "编辑路线" : "添加线路"}</span>
        <button type="button" className="rfe-head__save" onClick={() => void save()} disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </header>

      <div className="rfe-body">
        {errors.length > 0 && (
          <div className="rfe-alert rfe-alert--err" role="alert">
            <strong>保存失败，请先修正：</strong>
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        {warnings.length > 0 && (
          <div className="rfe-alert rfe-alert--warn" role="status">
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <ol className="rfe-flow">
          {segs.map((s, i) => (
            <li key={i} className={`rfe-seg rfe-seg--${s.kind}`}>
              {s.kind === "walk" && (
                <div className="rfe-walk">
                  <div className="rfe-walk__head">
                    <Icon name="walk" size={16} />
                    <span className="rfe-walk__title">
                      {s.phase === "out" ? "出发地 → 上车站" : "下车站 → 目的地"}
                    </span>
                    <button type="button" className="rfe-x" onClick={() => removeSeg(i)} aria-label="删除这段">
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                  <div className="rfe-walk__fields">
                    <label className="rfe-field">
                      <span className="t-label">路程</span>
                      <input
                        className="inp rfe-inp"
                        type="number"
                        min={0}
                        value={s.walkM ?? ""}
                        placeholder="米"
                        onChange={(e) => patch(i, { walkM: e.target.value === "" ? undefined : Number(e.target.value) })}
                      />
                      <span className="rfe-unit t-label">米</span>
                    </label>
                    <label className="rfe-field">
                      <span className="t-label">速度</span>
                      <input
                        className="inp rfe-inp"
                        type="number"
                        min={20}
                        max={200}
                        value={s.walkSpeed ?? ""}
                        placeholder="84"
                        onChange={(e) =>
                          patch(i, { walkSpeed: e.target.value === "" ? undefined : Number(e.target.value) })
                        }
                      />
                      <span className="rfe-unit t-label">米/分</span>
                    </label>
                    <label className="rfe-field">
                      <span className="t-label">档位</span>
                      <select
                        className="inp rfe-inp rfe-inp--sel"
                        value={s.walkTier ?? 3}
                        onChange={(e) => patch(i, { walkTier: Number(e.target.value) })}
                      >
                        {[1, 2, 3, 4, 5].map((t) => (
                          <option key={t} value={t}>
                            {t} · {TIER_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              )}

              {s.kind === "ride" && (
                <div className="rfe-ride">
                  <div className="rfe-ride__head">
                    <span className="rfe-ride__badge">{s.kind2 === "lrt" ? "轻轨" : "巴士"}</span>
                    {routeEdit === i ? (
                      <input
                        className="inp rfe-inp rfe-inp--route"
                        autoFocus
                        defaultValue={s.route ?? ""}
                        placeholder="线路名（如 26 / LRT-氹仔线）"
                        onBlur={(e) => {
                          patch(i, { route: e.target.value.trim() });
                          setRouteEdit(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                      />
                    ) : (
                      <button type="button" className="rfe-ride__route" onClick={() => setRouteEdit(i)}>
                        {s.route || "＋ 选择线路"}
                      </button>
                    )}
                    <button type="button" className="rfe-x" onClick={() => removeSeg(i)} aria-label="删除这段">
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                  <div className="rfe-ride__stops">
                    <button type="button" className="rfe-stop" onClick={() => setPicker({ idx: i, side: "board" })}>
                      <span className="rfe-stop__k t-label">上车站</span>
                      <span className="rfe-stop__v">{showStop(s.board, s.boardLabel)}</span>
                    </button>
                    <Icon name="arrowRight" size={16} />
                    <button type="button" className="rfe-stop" onClick={() => setPicker({ idx: i, side: "alight" })}>
                      <span className="rfe-stop__k t-label">下车站</span>
                      <span className="rfe-stop__v">{showStop(s.alight, s.alightLabel)}</span>
                    </button>
                  </div>
                </div>
              )}

              {s.kind === "transfer" && (
                <div className="rfe-transfer">
                  <Icon name="swap" size={16} />
                  <span>换乘 · {s.label ?? s.at ?? "（未设站）"}</span>
                  <button type="button" className="rfe-x" onClick={() => removeSeg(i)} aria-label="删除换乘">
                    <Icon name="close" size={16} />
                  </button>
                </div>
              )}

              {/* 段间动作（在 ride 之后提供「加换乘」；在 ride 前后提供「加线路」） */}
              <div className="rfe-seg__acts">
                {s.kind === "ride" && (
                  <button type="button" className="rfe-mini" onClick={() => addTransfer(i)}>
                    + 换乘
                  </button>
                )}
              </div>
            </li>
          ))}
        </ol>

        <button type="button" className="btn btn--outline btn--block btn--sm rfe-addride" onClick={addRide}>
          <Icon name="add" size={16} />
          添加线路
        </button>
      </div>

      {/* ── 站名选择器 ── */}
      {picker && (
        <StationPicker
          title={picker.side === "board" ? "选择上车站" : "选择下车站"}
          onClose={() => setPicker(null)}
          onPick={(code, label) => {
            const k = picker.side === "board" ? "board" : "alight";
            const lk = picker.side === "board" ? "boardLabel" : "alightLabel";
            patch(picker.idx, { [k]: code, [lk]: label });
            // ★ 自动补步行：首段 ride 的上车站 → walk(out).to；末段 ride 的下车站 → walk(in).from
            setSegs((prev) => {
              const next = [...prev];
              const isFirstRide = next.findIndex((x) => x.kind === "ride") === picker.idx;
              const isLastRide = next.map((x) => x.kind).lastIndexOf("ride") === picker.idx;
              if (isFirstRide && picker.side === "board") {
                const w = next.findIndex((x) => x.kind === "walk" && (x.phase ?? "out") === "out");
                if (w >= 0) next[w] = { ...next[w], to: code, label: label };
              }
              if (isLastRide && picker.side === "alight") {
                const w = next.map((x) => x.kind).lastIndexOf("walk");
                if (w >= 0 && next[w].phase === "in") next[w] = { ...next[w], from: code, label: label };
              }
              return next;
            });
            setPicker(null);
          }}
        />
      )}

      {/* ── 退出保护（三选）── */}
      {showExit && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setShowExit(false)}>
          <div className="dialog-card" role="alertdialog" aria-modal="true" aria-label="未保存的修改">
            <h3 className="dialog-card__title">有未保存的修改</h3>
            <p className="dialog-card__text">直接退出会丢掉刚才的改动。要保存吗？</p>
            <div className="dialog-card__acts">
              <button
                type="button"
                className="btn btn--text"
                onClick={() => {
                  setShowExit(false);
                  onClose(false);
                }}
              >
                不保存并退出
              </button>
              <button type="button" className="btn btn--outline" onClick={() => setShowExit(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={saving}
                onClick={async () => {
                  const ok = await save();
                  if (ok) onClose(true);
                  else setShowExit(false);
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 站名选择器（复用 `/api/poi/suggest`，只列本地站点） */
function StationPicker({
  title,
  onClose,
  onPick,
}: {
  title: string;
  onClose: () => void;
  onPick: (code: string, label: string) => void;
}) {
  const [q, setQ] = useState("");
  const [list, setList] = useState<{ code: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const s = q.trim();
    if (!s) {
      setList([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/poi/suggest?q=${encodeURIComponent(s.slice(0, 50))}&mode=type`, {
          cache: "no-store",
        });
        const j = (await r.json()) as { results?: { code?: string; name: string; kind: string }[] };
        setList(
          (j.results ?? [])
            .filter((x) => x.code && (x.kind === "station" || x.kind === "lrt_station"))
            .map((x) => ({ code: x.code as string, name: x.name })),
        );
      } catch {
        setList([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="dialog-card dialog-card--tall" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3 className="dialog-card__title">{title}</h3>
        <input
          className="inp"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="输入站名，如 石排灣 / 蓮花路停車場"
          style={{ width: "100%" }}
        />
        <div className="rfe-picker__list">
          {loading && <p className="t-label t-muted">搜索中…</p>}
          {!loading && q.trim() && list.length === 0 && <p className="t-label t-muted">没找到站点</p>}
          {list.map((s) => (
            <button
              key={s.code}
              type="button"
              className="rfe-picker__row"
              onClick={() => onPick(s.code, `${s.code} ${s.name}`.trim())}
            >
              <span className="rfe-picker__code">{s.code}</span>
              <span className="rfe-picker__name">{s.name}</span>
            </button>
          ))}
        </div>
        <div className="dialog-card__acts">
          <button type="button" className="btn btn--outline" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
