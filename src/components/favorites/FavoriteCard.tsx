"use client";

/**
 * 收藏 · **组合卡**（src/components/favorites/FavoriteCard.tsx；★ v2.3.0 S2 重写 · v2.4.1 精简）
 *
 * ── 规格（08 §C.2 · ★ v2.4.1 精简后）──────────────────────────────────
 *   · 卡 = `--radius-card` 10px + **1.5px `--border-strong`** 框 + `--shadow-hard-sm`；**整卡可点**；
 *   · **卡内只留一行**：组合名（`--text-lg` 17px / 600 / 超长单行省略）。
 *     默认名即「起点 → 终点」；用户改过名则显示自定义名 —— 这正是「仅保留**一个**
 *     起终点信息」的另一层含义：**不再额外渲染图标版 OD 行**。
 *   · 停用态：名字转 `--meta`，并在下方补一行「已停用」（**排序沉底由列表页负责**）。
 *   · 右侧 ⋯ 菜单（`.fav-menu` 复用）：编辑编排 / 重命名 / 置顶 / 停用 / 删除组合。
 *
 * ── ★ v2.4.1 删掉了什么（请勿"顺手加回来"）────────────────────────────
 *   · **图标 OD 行**（origin → arrowRight → destination）—— 与名字行重复表达起终点；
 *   · **摘要行**（「N 段编排 · 最近 X 分 · 线路标签」）—— 与「点开组合即见实时方案」重复。
 *   ⚠️ 摘要行原先承载的 **FA-A.4** 约束（不得预展示易失的实时时长）随之**自然失效**：
 *      卡上已无任何时长。若将来要把时长加回卡片，**必须重新遵守 FA-A.4**（只显示快照值）。
 *
 * ── ★ 删除确认弹窗（06 §3.6 / FA-A.13，必做）──────────────────────────
 *   显示 ① **组合名** ② **影响**（将删 N 条已保存方案 · 不可恢复）③ 危险按钮在右、
 *   **默认焦点在「取消」**（防误删）、Esc = 取消、点遮罩 = 取消。
 *
 * ⚠️ 文案一律**简体**；站名/线路名保留繁体（校名「澳門科技大學」属**地名**，用繁体）。
 */
import { useEffect, useState } from "react";
import Icon from "@/components/ui/Icon";
import type { Combo } from "@/lib/favorites/types";

export interface FavoriteCardProps {
  combo: Combo;
  readOnly: boolean;
  onOpen: (combo: Combo) => void;
  /** ★ S3：打开编排编辑器（⋯ 菜单「编辑编排」） */
  onEdit: (combo: Combo) => void;
  onRename: (id: string, name: string) => void;
  onPin: (id: string, pinned: boolean) => void;
  onToggleDisabled: (id: string, disabled: boolean) => void;
  onRemove: (id: string) => void;
}

/** 组合默认名（与 `comboDefaultName` 同口径；此处内联避免再 import 一个纯函数） */
const defaultName = (c: Combo) => `${c.from.label} → ${c.to.label}`;

export default function FavoriteCard({
  combo,
  readOnly,
  onOpen,
  onEdit,
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

  // ★ v2.4.1：卡片精简后，原先为摘要行算的三个派生值（codes / latestMin / segCount）
  //   已无使用者 ⇒ 一并删除（`routeCodesOf` / `latestMinOf` 两个辅助函数亦已移除）。

  return (
    <>
      <div
        className={`fav-combo${combo.pinned ? " is-pinned" : ""}${combo.disabled ? " is-off" : ""}`}
        data-fav-id={combo.id}
      >
        <button type="button" className="fav-combo__main" onClick={() => onOpen(combo)} aria-label={`打开组合 ${combo.name}`}>
          {/**
           * ★ v2.4.1 精简（用户口径）：「每个组合卡片**仅保留一个『起点→终点』信息**与省略号工具栏」。
           *   · 原先卡上同时有**两处**起终点（下方 `__od` 图标行 + 本行文字）⇒ 重复，已删图标行；
           *   · 摘要行（N 段编排 / 最近 X 分 / 线路标签）一并删除。
           *   ⚠️ 保留**文字行**（而非图标行）是用户明确的选择 —— 它的另一层含义：
           *      若用户给组合改过名，卡上显示的就是**他自己起的名字**。
           */}
          <span className="fav-combo__name">{combo.name || defaultName(combo)}</span>
          {/* ★ 停用态：原来挂在已删的摘要行里 ⇒ **必须**在此保留可见标记，
              否则「已停用」将完全无提示（卡片与正常态一模一样，用户会以为坏掉） */}
          {combo.disabled && <span className="fav-combo__off">已停用</span>}
        </button>

        {/* ⋯ 菜单 */}
        <div className="fav-menu">
          <button
            type="button"
            className="fav-menu__btn"
            aria-label="更多操作"
            aria-expanded={menuOpen}
            onClick={(e) => {
              const next = !menuOpen;
              /**
               * ★ P2 二次修复（QA 实测驱动）：菜单 5 项约 220px 高，向下弹时若卡片靠近**视口底部**，
               *   下半截会落在**视口之外**（实测 popRect.bottom 1074 > 视口 932 ⇒ 后 3 项点不到，
               *   提高 z-index 也无效，因为点不到的是"屏幕外"而不是"被遮住"）。
               *   ⇒ 下方空间不足以容纳菜单时，给 `.fav-menu` 打 `data-up="1"`，CSS 改为 `bottom:100%` **向上弹**。
               *   用 DOM 属性而非 React state：避免新增状态与重渲染，判定发生在**打开那一刻**（就地量测）。
               */
              if (next) {
                const r = e.currentTarget.getBoundingClientRect();
                const need = 5 * 44 + 24; // 5 项 × 44 + 内边距
                const up = window.innerHeight - r.bottom < need;
                e.currentTarget.parentElement?.setAttribute("data-up", up ? "1" : "0");
              }
              setMenuOpen(next);
              setRenaming(false);
            }}
          >
            <Icon name="more" size={20} />
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
                  {/* ★ 2026-09-22：「编辑编排」→「**查看路线**」（产品口径）。
                      点进去是**路线查看页** —— 读取库里固定的路线（一行一条、**不合并**），
                      而不是旧的「编排编辑器」。⚠️「停用」功能保留不动（产品明确要求）。 */}
                  <button
                    type="button"
                    className="fav-menu__item"
                    onClick={() => {
                      setMenuOpen(false);
                      onEdit(combo);
                    }}
                    disabled={readOnly}
                  >
                    <Icon name="records" size={16} />
                    查看路线
                  </button>
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
