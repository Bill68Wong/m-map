"use client";

/**
 * 收藏页客户端（src/components/favorites/FavoritesClient.tsx，v3.3.0 · ADR-104 / 03 §3）
 *
 * ── 结构（v3）────────────────────────────────────────────────────────
 *   · **列表**：`组合（上） / 地点（下）`（`ComboPlans` 降为纯列表）· 56px 扁卡；
 *   · **编辑组合弹层**（03 §3.2 原案）：两行端点 `起点 [当前值 ▸ 改]` / `终点 [当前值 ▸ 改]` ——
 *     **各自跳搜索选择器重选**（复用既有全屏搜索层 `SearchSheet`），也可一键取「**我的位置**」；
 *     改名 + 「保存」/「取消」；**只改这一对起终点，不动其他组合**。
 *     地点卡则为「重命名」弹层（地点是单点，无起终点可改）。
 *   · **回放**（AC-116）：点组合 = 首页式**实时规划**（`?from…&to…`）；
 *                       点地点 = 首页式**选点**（`?to…`，起点默认「我的位置」，**不自动规划**）；
 *   · **备份**：v2→v3 迁移的一次性提示 + 可再次下载隐藏备份键内容（AC-111）。
 *
 * ── 五态（03 §3.8）───────────────────────────────────────────────────
 *   Loading（骨架）/ Empty（整体 + 分区引导）/ Populated / Edge（超长名省略、只读、迁移失败）。
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import SearchSheet from "@/components/nav/SearchSheet";
import { useUserFix } from "@/components/nav/useUserFix";
import FavoritesList, { type ComboAction, type PlaceAction } from "./ComboPlans";
import { useCombos, type ComboV3, type PlaceV3 } from "@/lib/favorites/useCombos";
import { FAVORITES_BACKUP_KEY, hasBackupKey } from "@/lib/favorites/v3";
import { endpointOf, type FavoriteEndpoint } from "@/lib/favorites/types";
import type { NavPoint } from "@/lib/nav/types";

/** 迁移备份提示（一次性；沿用既有 `PRUNE_NOTICE_KEY` 机制） */
const BACKUP_NOTICE_KEY = "must.fav.backupNotice";

/** 端点 → URL 参数（与 `nav-params.parseNavParams` 同键名） */
function putEndpoint(sp: URLSearchParams, side: "from" | "to", e: FavoriteEndpoint): void {
  sp.set(`${side}Lng`, String(e.lng));
  sp.set(`${side}Lat`, String(e.lat));
  sp.set(`${side}Label`, e.label);
  sp.set(`${side}Kind`, e.kind);
  if (e.code) sp.set(`${side}Code`, e.code);
}

/** 端点 → NavPoint（喂给搜索层做「当前值」展示） */
function toNavPoint(e: FavoriteEndpoint | null): NavPoint | null {
  if (!e) return null;
  const p: NavPoint = { kind: e.kind, label: e.label, lng: e.lng, lat: e.lat };
  if (e.code) p.code = e.code;
  return p;
}

/** 「我的位置」端点（与导航层同口径：`kind='gps'`） */
const MY_LOCATION_LABEL = "我的位置";

export default function FavoritesClient() {
  const router = useRouter();
  const { mounted, combos, places, readOnly, migrationFailed, updateCombo, removeCombo, updatePlace, removePlace } =
    useCombos();

  /** 编辑弹层（组合：改名 + 重选起终点；地点：改名） */
  const [editCombo, setEditCombo] = useState<ComboV3 | null>(null);
  const [editPlace, setEditPlace] = useState<PlaceV3 | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  /** 起终点**草稿**（保存前不落库 ⇒ 「取消」即丢弃） */
  const [draftFrom, setDraftFrom] = useState<FavoriteEndpoint | null>(null);
  const [draftTo, setDraftTo] = useState<FavoriteEndpoint | null>(null);
  /** 正在为哪个端点选点（非空 ⇒ 叠加搜索层） */
  const [pickFor, setPickFor] = useState<"from" | "to" | null>(null);
  /** GPS（仅弹层/选点期启用，避免开页即弹权限） */
  const userFix = useUserFix({ enabled: !!editCombo || !!pickFor, intervalMs: 10_000, maximumAge: 60_000 });
  /** 迁移备份提示（一次性） */
  const [notice, setNotice] = useState(false);

  const emptyAll = combos.length === 0 && places.length === 0;

  useEffect(() => {
    if (!mounted) return;
    try {
      if (hasBackupKey() && !window.localStorage.getItem(BACKUP_NOTICE_KEY)) setNotice(true);
    } catch {
      /* ignore */
    }
  }, [mounted]);

  const dismissNotice = () => {
    setNotice(false);
    try {
      window.localStorage.setItem(BACKUP_NOTICE_KEY, "1");
    } catch {
      /* ignore */
    }
  };

  /* ── 回放（AC-116）── */
  const openCombo = (c: ComboV3) => {
    if (c.disabled) return; // 停用不参与「点卡即算」
    const sp = new URLSearchParams();
    putEndpoint(sp, "from", c.from);
    putEndpoint(sp, "to", c.to);
    router.push(`/?${sp.toString()}`);
  };
  const openPlace = (p: PlaceV3) => {
    const sp = new URLSearchParams();
    putEndpoint(sp, "to", p.endpoint); // 仅目的地 ⇒ 起点默认「我的位置」、停在可出发态
    router.push(`/?${sp.toString()}`);
  };

  /* ── 编辑弹层开合 ── */
  const openEditCombo = (c: ComboV3) => {
    setEditCombo(c);
    setEditPlace(null);
    setNameDraft(c.name);
    setDraftFrom(c.from);
    setDraftTo(c.to);
    setPickFor(null);
  };
  const openRenamePlace = (p: PlaceV3) => {
    setEditPlace(p);
    setEditCombo(null);
    setNameDraft(p.name ?? p.endpoint.label);
    setPickFor(null);
  };
  const closeSheet = () => {
    setEditCombo(null);
    setEditPlace(null);
    setPickFor(null);
  };

  /* ── ⋯ 菜单动作 ── */
  const onComboAction = (c: ComboV3, a: ComboAction) => {
    if (a === "pin") updateCombo(c.id, { pinned: !c.pinned });
    else if (a === "disable") updateCombo(c.id, { disabled: !c.disabled });
    else if (a === "delete") removeCombo(c.id);
    else openEditCombo(c);
  };
  const onPlaceAction = (p: PlaceV3, a: PlaceAction) => {
    if (a === "delete") removePlace(p.id);
    else openRenamePlace(p);
  };

  /* ── 端点重选（03 §3.2）：搜索层选点回填 / 一键「我的位置」 ── */
  const fillEndpoint = (which: "from" | "to" | "dest", e: FavoriteEndpoint) => {
    if (which === "dest" || which === "to") setDraftTo(e);
    else setDraftFrom(e);
    setPickFor(null);
  };
  const applyMyLocation = (which: "from" | "to") => {
    const f = userFix.fix;
    if (!f) {
      userFix.start(); // 冷启动：立即申请；到位后用户再点一次即可
      return;
    }
    fillEndpoint(which, { kind: "gps", label: MY_LOCATION_LABEL, lng: f.lng, lat: f.lat });
  };
  const swapDraft = () => {
    setDraftFrom(draftTo);
    setDraftTo(draftFrom);
  };

  /* ── 保存 ── */
  const saveCombo = () => {
    if (!editCombo) return;
    const from = draftFrom ?? editCombo.from;
    const to = draftTo ?? editCombo.to;
    const name = nameDraft.trim().slice(0, 40) || `${from.label} → ${to.label}`;
    updateCombo(editCombo.id, { name, from, to });
    closeSheet();
  };
  const savePlace = () => {
    if (!editPlace) return;
    const name = nameDraft.trim().slice(0, 40);
    updatePlace(editPlace.id, { name: name || undefined });
    closeSheet();
  };

  /** 再下载一次迁移备份（隐藏键内容） */
  const downloadBackup = () => {
    try {
      const raw = window.localStorage.getItem(FAVORITES_BACKUP_KEY);
      if (!raw) return;
      const blob = new Blob([raw], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `must-favorites-v2-backup-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch {
      /* ignore */
    }
  };

  const sheetTitle = useMemo(
    () => (editCombo ? "编辑起点终点" : editPlace ? "重命名地点" : ""),
    [editCombo, editPlace],
  );

  /* ── Loading（F1 水合守卫）── */
  if (!mounted) {
    return (
      <div className="fav-page">
        <span className="fav-sk" />
        <p className="t-label t-muted">正在读取本机收藏…</p>
      </div>
    );
  }

  return (
    <div className="fav-page">
      {/* Edge ②：只读（本机存储不可用） */}
      {readOnly && (
        <p className="fav-note fav-note--warn t-label" role="status">
          当前浏览器不支持本地收藏（隐私模式？）—— 收藏功能暂不可用。
        </p>
      )}
      {/* Edge ③：迁移失败（旧数据完好） */}
      {migrationFailed && (
        <p className="fav-note fav-note--warn t-label" role="status">
          旧收藏的升级没完成（原数据完好未动）。稍后重试即可。
        </p>
      )}
      {/* 备份提示（一次性） */}
      {notice && (
        <p className="fav-note t-label" role="status">
          旧版收藏已升级为「组合 + 地点」。原数据已备份，可
          <button type="button" className="btn btn--text btn--sm" onClick={downloadBackup}>
            下载备份
          </button>
          <button type="button" className="btn btn--text btn--sm" onClick={dismissNotice}>
            知道了
          </button>
        </p>
      )}

      {/* Empty（整体） */}
      {emptyAll ? (
        <div className="fav-empty">
          <span className="fav-empty__icon" aria-hidden="true">
            <Icon name="bookmark" size={24} />
          </span>
          <p className="h-title">还没有收藏</p>
          <p className="t-body t-muted">把常走的一对起终点存成「组合」，或把常去的地点单独存下来。</p>
          <button type="button" className="btn btn--primary btn--block" onClick={() => router.push("/")}>
            去规划路线
          </button>
        </div>
      ) : (
        <FavoritesList
          combos={combos}
          places={places}
          readOnly={readOnly}
          onOpenCombo={openCombo}
          onOpenPlace={openPlace}
          onEditCombo={openEditCombo}
          onComboAction={onComboAction}
          onPlaceAction={onPlaceAction}
        />
      )}

      {/* ── 编辑弹层（起终点重选 + 改名；地点仅改名）── */}
      {(editCombo || editPlace) && !pickFor && (
        <div className="fav-sheet" role="dialog" aria-modal="true" aria-label={sheetTitle}>
          <div className="fav-sheet__scrim" onClick={closeSheet} />
          <div className="fav-sheet__panel">
            <p className="h-title">{sheetTitle}</p>

            {editCombo && (
              <>
                <p className="fav-sheet__tip t-label t-muted">
                  只改这一对起终点（其他组合不受影响）。
                </p>
                {/* 两行可编辑端点（03 §3.2）：各自跳搜索重选；也可取「我的位置」 */}
                <div className="fav-sheet__row">
                  <span className="fav-sheet__k t-label">起点</span>
                  <span className="fav-sheet__v">{draftFrom?.label ?? "—"}</span>
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => setPickFor("from")}
                    aria-label={`修改起点，当前为 ${draftFrom?.label ?? "空"}`}
                  >
                    修改
                  </button>
                  <button
                    type="button"
                    className="btn btn--text btn--sm"
                    onClick={() => applyMyLocation("from")}
                    aria-label="起点改为我的位置"
                  >
                    我的位置
                  </button>
                </div>
                <div className="fav-sheet__row">
                  <span className="fav-sheet__k t-label">终点</span>
                  <span className="fav-sheet__v">{draftTo?.label ?? "—"}</span>
                  <button
                    type="button"
                    className="btn btn--outline btn--sm"
                    onClick={() => setPickFor("to")}
                    aria-label={`修改终点，当前为 ${draftTo?.label ?? "空"}`}
                  >
                    修改
                  </button>
                  <button
                    type="button"
                    className="btn btn--text btn--sm"
                    onClick={() => applyMyLocation("to")}
                    aria-label="终点改为我的位置"
                  >
                    我的位置
                  </button>
                </div>
                <button type="button" className="btn btn--text btn--sm fav-sheet__swap" onClick={swapDraft}>
                  互换起终点
                </button>
              </>
            )}

            <label className="fav-sheet__field">
              <span className="t-label t-muted">名称</span>
              <input
                type="text"
                value={nameDraft}
                maxLength={40}
                onChange={(e) => setNameDraft(e.target.value)}
                aria-label={editCombo ? "组合名称" : "地点名称"}
              />
            </label>
            <div className="fav-sheet__acts">
              <button type="button" className="btn btn--outline btn--sm" onClick={closeSheet}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => (editCombo ? saveCombo() : savePlace())}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 搜索选择器（复用既有全屏搜索层；选完回填草稿 ⇒ 回到本弹层）── */}
      {pickFor && (editCombo || editPlace) && (
        <SearchSheet
          editing={pickFor === "to" ? "dest" : "from"}
          dest={toNavPoint(draftTo)}
          from={toNavPoint(draftFrom)}
          userPos={userFix.fix ? { lng: userFix.fix.lng, lat: userFix.fix.lat } : null}
          colors={{}}
          quickPairs={[]}
          onPick={(p, which) => fillEndpoint(which, endpointOf(p))}
          onPickQuick={(f, t) => {
            setDraftFrom(endpointOf(f));
            setDraftTo(endpointOf(t));
            setPickFor(null);
          }}
          onBack={() => setPickFor(null)}
        />
      )}
    </div>
  );
}
