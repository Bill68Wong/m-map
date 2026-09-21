"use client";

/**
 * 默认组合种子注入器（src/components/favorites/ComboSeeder.tsx，v2.3.0 · 07 §1.4）
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *   默认组合的**端点坐标只能服务端取**（`place_coords` JOIN `places`，pg + GCJ 转换），
 *   而收藏落在 **客户端 `localStorage`** ⇒ 由 server component（`/favorites`）
 *   先把坐标取好、作为可序列化 props 下发，本组件在挂载时**注入一次**（幂等）。
 *
 * ── 幂等（FA-A.2 / 07 §1.4）──────────────────────────────────────────
 *   仅当 `seedVersion < SEED_VERSION` 时补「**同名不存在**」的默认组合，然后置位；
 *   用户删掉的默认组合**不再复活**（`seedVersion` 已置位）。PWA 反复打开不会重复注入。
 *
 * ── 座区（07 §1.4 裁定：不写死）──────────────────────────────────────
 *   澳门科技大学端点有多档座区 ⇒ 本组件读客户端 `must.zone`（与 `ZonePicker` **同一键**）
 *   再交给 `buildDefaultComboSeeds` 选行；读不到则走 `zone=null` 行 / 首行。
 *   ★ v2.4.0：三座区**各建一对**（不再按当前座区过滤），故共 10 个默认组合。
 *
 * ── ★ v2.4.0：清理旧空壳的**透明告知** ─────────────────────────────────
 *   `seedDefaultCombos` 会顺手清掉旧版遗留的空壳组合（v2.3.x 的 6 个）。
 *   清除用户数据**必须可解释** ⇒ 把条数写进 `sessionStorage`，
 *   由 `FavoritesClient` 读到后 flash 一句「已整理 N 个旧版组合」并立刻删掉该键
 *   （**只提示一次**，刷新不再出现；`sessionStorage` 关标签页即失效）。
 *
 * 渲染 `null`（纯副作用，无 UI）。
 */
import { useEffect } from "react";
import { seedDefaultCombos } from "@/lib/favorites/useCombos";
import { PRUNE_NOTICE_KEY } from "@/lib/favorites/types";
import type { SeedPlaceCoord } from "@/lib/favorites/presets";

/** 与 `ZonePicker` 共用的座区键（此处**不 import** 组件，避免把 ZonePicker 拖进本页） */
const ZONE_KEY = "must.zone";

export default function ComboSeeder({ coords }: { coords: SeedPlaceCoord[] }) {
  useEffect(() => {
    if (!coords.length) return;
    let zone: string | null = null;
    try {
      zone = window.localStorage.getItem(ZONE_KEY);
    } catch {
      zone = null; // 隐私模式 → 用 zone=null 行 / 首行兜底
    }
    const { pruned } = seedDefaultCombos(coords, zone);
    // 清理过用户的旧组合 → 留一句一次性提示（读侧负责删除，保证只出现一次）
    if (pruned > 0) {
      try {
        window.sessionStorage.setItem(PRUNE_NOTICE_KEY, String(pruned));
      } catch {
        /* 隐私模式：提示丢失可接受，不影响数据正确性 */
      }
    }
    // coords 由服务端下发（同一请求内稳定）→ 只跑一次
  }, [coords]);

  return null;
}
