"use client";

/**
 * 收藏页客户端（src/components/favorites/FavoritesClient.tsx；v2.3.0 S2 列表 + S3 编辑器 + S4 现场计算）
 *
 * ── 三种视图（无新路由 ⇒ 不动 middleware 白名单）──────────────────────
 *   · **列表**（默认）：组合卡 + 摘要行 + ⋯菜单（编辑编排/重命名/置顶/停用/删除）
 *   · **编辑器**（S3）：`editing` 非空 → `ComboEditor` 全屏
 *   · **方案列表**（S4）：`viewing` 非空 → `ComboPlans` 全屏（现场算多方案 + 角标 + 降级）
 *
 * ── ★ S4：点组合卡 = **现场实时算**（不再跳 `/nav`）─────────────────────
 *   07 §2：`chain/walk/tiers` 只在有自定义编排时传参；缺省 = v2.2.0 行为逐字节一致。
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import FavoriteCard from "./FavoriteCard";
import ComboEditor from "./ComboEditor";
import ComboPlans from "./ComboPlans";
import { useCombos } from "@/lib/favorites/useCombos";
import type { Combo } from "@/lib/favorites/types";

/** 排序：置顶优先 → 启用优先（停用沉底）→ 最近使用/更新 降序 */
function order(a: Combo, b: Combo): number {
  if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
  if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
  return (b.lastUsedAt ?? b.updatedAt) - (a.lastUsedAt ?? a.updatedAt);
}

export default function FavoritesClient({ colors = {} }: { colors?: Record<string, string> }) {
  const router = useRouter();
  const c = useCombos();
  const [notice, setNotice] = useState("");
  /** ★ S3：正在编辑的组合（非空 → 全屏编辑器） */
  const [editing, setEditing] = useState<Combo | null>(null);
  /** ★ S4：正在查看方案的组合（非空 → 全屏方案列表） */
  const [viewing, setViewing] = useState<Combo | null>(null);
  const combos = useMemo(() => [...c.combos].sort(order), [c.combos]);

  /** 行内轻提示（不弹模态） */
  function flash(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 2400);
  }

  // ── 首帧（SSR / 未挂载）：骨架，保证服务端与首帧输出一致（F1）──
  if (!c.mounted) {
    return (
      <div className="fav-page">
        <h1 className="fav-page__title">收藏</h1>
        <div className="fav-sk" aria-hidden="true">
          <span className="rc-sk rc-sk--line" />
          <span className="rc-sk rc-sk--line rc-sk--short" />
          <span className="rc-sk rc-sk--line" />
        </div>
        <p className="t-label t-muted" role="status">
          正在读取本机收藏…
        </p>
      </div>
    );
  }

  // ── ★ S3：编辑器全屏 ──
  if (editing) {
    const fresh = c.combos.find((x) => x.id === editing.id) ?? editing;
    return (
      <ComboEditor
        combo={fresh}
        colors={colors}
        readOnly={c.readOnly}
        onClose={() => {
          setEditing(null);
          flash("已保存编排");
        }}
      />
    );
  }

  // ── ★ S4：方案列表全屏（现场算）──
  if (viewing) {
    const fresh = c.combos.find((x) => x.id === viewing.id) ?? viewing;
    return <ComboPlans combo={fresh} colors={colors} onExit={() => setViewing(null)} />;
  }

  function open(combo: Combo) {
    if (combo.disabled) {
      flash("这条组合已停用，可在 ⋯ 里启用");
      return;
    }
    // 记录最近使用（排序 / 清理依据）
    c.update(combo.id, { lastUsedAt: Date.now() });
    // ★ S4：不再跳 /nav —— 就地**现场算多方案**（带 chain/walk/tiers）
    setViewing(combo);
  }

  return (
    <div className="fav-page">
      <h1 className="fav-page__title">收藏</h1>

      {!c.available && (
        <p className="fav-note fav-note--warn t-label" role="status">
          当前浏览器不支持本地收藏，以下为只读展示；导航功能不受影响。
        </p>
      )}
      {c.available && (
        <p className="fav-note t-label t-muted">收藏保存在本机浏览器，清除浏览器数据会一起清掉。</p>
      )}
      {notice && (
        <p className="fav-note fav-note--warn t-label" role="status">
          {notice}
        </p>
      )}

      {combos.length === 0 ? (
        <div className="fav-empty">
          <Icon name="bookmark" size={24} className="fav-empty__icon" />
          <p className="fav-empty__title">还没存过路线</p>
          <p className="fav-empty__body t-body t-muted">
            在路线结果页点书签图标收藏一条方案；或在首页选定目的地后，保存「家 → 澳科大」这样的常用路线。
          </p>
          <button type="button" className="btn btn--primary" onClick={() => router.push("/")}>
            去规划路线
          </button>
        </div>
      ) : (
        <section className="fav-group">
          <h2 className="fav-group__title">
            组合<span className="fav-group__count t-label">{combos.length} 组</span>
            <button
              type="button"
              className="btn btn--text btn--sm"
              style={{ marginLeft: "auto" }}
              onClick={() => router.push("/")}
            >
              + 新建
            </button>
          </h2>
          {combos.map((combo) => (
            <FavoriteCard
              key={combo.id}
              combo={combo}
              colors={colors}
              readOnly={c.readOnly}
              onOpen={open}
              onEdit={(x) => setEditing(x)}
              onRename={(id, name) => {
                c.update(id, { name, nameEdited: true });
                flash("已重命名");
              }}
              onPin={(id, pinned) => c.update(id, { pinned })}
              onToggleDisabled={(id, disabled) => {
                c.update(id, { disabled });
                flash(disabled ? "已停用" : "已启用");
              }}
              onRemove={(id) => {
                c.remove(id);
                flash("已删除");
              }}
            />
          ))}
        </section>
      )}
    </div>
  );
}
