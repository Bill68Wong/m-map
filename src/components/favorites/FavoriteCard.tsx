"use client";

/**
 * 收藏 · **组合卡**（src/components/favorites/FavoriteCard.tsx；★ v2.3.0 S2 重写）
 *
 * ── 规格（08 §C.2）────────────────────────────────────────────────────
 *   · 卡 = `--radius-card` 10px + **1.5px `--border-strong`** 框 + `--shadow-hard-sm`；**整卡可点**；
 *   · 左侧 **OD 图标对**（origin → arrowRight → destination，均已注册）；
 *   · 命名 = `--text-lg` 17px / 600 / -0.005em（超长单行省略）；
 *   · 摘要行 = `--text-sm` 13px / `--muted`：「**N 段编排 · 最近 X 分 · 线路标签**」；
 *   · 右侧 ⋯ 菜单（`.fav-menu` 复用）：重命名 / 置顶 / 停用 / 删除组合。
 *   · 停用态：整体 `--meta` + 摘要显示「已停用」（**排序沉底由列表页负责**），点击提示去 ⋯ 里启用。
 *
 * ── ★ FA-A.4（关键）───────────────────────────────────────────────────
 *   **不得预展示易失的实时时长** —— 摘要里的「最近 X 分」取**已保存方案的快照**
 *   （`snapshot.totalMin`，文案标「最近」），**不是**实时重算值。
 *
 * ── ★ 删除确认弹窗（06 §3.6 / FA-A.13，必做）──────────────────────────
 *   显示 ① **组合名** ② **影响**（将删 N 条已保存方案 · 不可恢复）③ 危险按钮在右、
 *   **默认焦点在「取消」**（防误删）、Esc = 取消、点遮罩 = 取消。
 *
 * ⚠️ 文案一律**简体**；站名/线路名保留繁体。
 */
import { useEffect, useState } from "react";
import Icon from "@/components/ui/Icon";
import RouteStack from "@/components/RouteStack";
import type { Combo } from "@/lib/favorites/types";

export interface FavoriteCardProps {
  combo: Combo;
  colors: Record<string, string>;
  readOnly: boolean;
  onOpen: (combo: Combo) => void;
  onRename: (id: string, name: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onToggleDisabled: (id: string, disabled: boolean) => void;
  onRemove: (id: string) => void;
}

/** 组合默认名（与 `comboDefaultName` 同口径；此处内联避免再 import 一个纯函数） */
const defaultName = (c: Combo) => `${c.from.label} → ${c.to.label}`;

/** 摘要里的线路标签：取**最近一条已保存方案**快照的 legs 前缀 */
function routeCodesOf(c: Combo): string[] {
  const latest = [...c.plans].sort((a, b) => (b.snapshot.capturedAt ?? 0) - (a.snapshot.capturedAt ?? 0))[0];
  if (!latest) return [];
  return latest.snapshot.legs.map((l) => l.split(" ")[0]).filter(Boolean).slice(0, 3);
}

/** 最近一条已保存方案的时长（**快照值**，非实时） */
function latestMinOf(c: Combo): number | null {
  const latest = [...c.plans].sort((a, b) => (b.snapshot.capturedAt ?? 0) - (a.snapshot.capturedAt ?? 0))[0];
  return latest ? Math.round(latest.snapshot.totalMin) : null;
}

export default function FavoriteCard({
  combo,
  colors,
  readOnly,
  onOpen,
  onRename,
  onPin,
  onToggleDisabled,
  onRemove,
}: FavoriteCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(combo.name);
  const [confirming, setConfirming] = useState(false);

  // Esc 关闭确认弹窗（= 取消，06 §3.6）
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirming(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming]);

  const codes = routeCodesOf(combo);
  const latestMin = latestMinOf(combo);
  const segCount = combo.chain?.length ? combo.chain.length : 0;

  return (
    <>
      <div
        className={`fav-combo${combo.pinned ? " is-pinned" : ""}${combo.disabled ? " is-off" : ""}`}
        data-fav-id={combo.id}
      >
        <button type="button" className="fav-combo__main" onClick={() => onOpen(combo)} aria-label={`打开组合 ${combo.name}`}>
          <span className="fav-combo__name">{combo.name || defaultName(combo)}</span>
          <span className="fav-combo__od">
            <Icon name="origin" size={16} />
            <span className="fav-combo__end">{combo.from.label}</span>
            <Icon name="arrowRight" size={16} />
            <Icon name="destination" size={16} />
            <span className="fav-combo__end">{combo.to.label}</span>
          </span>
          <span className="fav-combo__summary">
            {combo.disabled ? (
              <span className="fav-combo__off">已停用</span>
            ) : (
              <>
                <span>{segCount ? `${segCount} 段编排` : "未编排"}</span>
                {/* ★ FA-A.4：这里只显示**已保存快照**的时长，且标「最近」——不是实时值 */}
                {latestMin !== null && <span>· 最近 {latestMin} 分</span>}
                {codes.length > 0 ? (
                  <RouteStack codes={codes} colors={colors} size="sm" />
                ) : (
                  <span>· 暂无保存方案</span>
                )}
              </>
            )}
          </span>
        </button>

        {/* ⋯ 菜单 */}
        <div className="fav-menu">
          <button
            type="button"
            className="fav-menu__btn"
            aria-label="更多操作"
            aria-expanded={menuOpen}
            onClick={() => {
              setMenuOpen((v) => !v);
              setRenaming(false);
            }}
          >
            <Icon name="expandVertical" size={20} />
          </button>
          {menuOpen && (
            <div className="fav-menu__pop" role="menu">
              {renaming ? (
                <form
                  className="fav-menu__rename"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = draft.trim().slice(0, 24);
                    if (v) onRename(combo.id, v);
                    setRenaming(false);
                    setMenuOpen(false);
                  }}
                >
                  <input
                    className="inp fav-menu__inp"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    maxLength={24}
                    placeholder="组合名称（≤24 字）"
                    aria-label="组合名称"
                    autoFocus
                  />
                  <button type="submit" className="btn btn--text btn--sm" disabled={readOnly}>
                    保存
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="fav-menu__item"
                    onClick={() => {
                      setDraft(combo.name);
                      setRenaming(true);
                    }}
                    disabled={readOnly}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    className="fav-menu__item"
                    onClick={() => {
                      onPin(combo.id, !combo.pinned);
                      setMenuOpen(false);
                    }}
                    disabled={readOnly}
                  >
                    {combo.pinned ? "取消置顶" : "置顶"}
                  </button>
                  <button
                    type="button"
                    className="fav-menu__item"
                    onClick={() => {
                      onToggleDisabled(combo.id, !combo.disabled);
                      setMenuOpen(false);
                    }}
                    disabled={readOnly}
                  >
                    {combo.disabled ? "启用" : "停用"}
                  </button>
                  <button
                    type="button"
                    className="fav-menu__item fav-menu__item--danger"
                    onClick={() => {
                      setMenuOpen(false);
                      setConfirming(true);
                    }}
                  >
                    删除组合
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── 删除确认弹窗（06 §3.6：真实有效 —— 组合名 + 实际影响 + 默认焦点在取消）── */}
      {confirming && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setConfirming(false)}>
          <div
            className="dialog-card"
            role="alertdialog"
            aria-modal="true"
            aria-label="删除组合确认"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="fav-confirm__title">删除组合？</h2>
            <p className="fav-confirm__name">「{combo.name || defaultName(combo)}」</p>
            <p className="fav-confirm__impact">
              {combo.plans.length > 0 ? (
                <>
                  · 其中的 <b>{combo.plans.length}</b> 条已保存方案会一起删除
                  <br />
                  · 这条组合下的收藏记录无法恢复
                </>
              ) : (
                <>· 这条组合尚未保存任何方案；删除后无法恢复</>
              )}
            </p>
            <div className="fav-confirm__acts">
              {/* ★ 危险动作在主按钮位、但**默认焦点在「取消」**（防误删） */}
              <button type="button" className="btn btn--outline" onClick={() => setConfirming(false)} autoFocus>
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={readOnly}
                onClick={() => {
                  setConfirming(false);
                  onRemove(combo.id);
                }}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
