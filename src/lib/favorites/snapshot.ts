/**
 * 方案快照构造（src/lib/favorites/snapshot.ts，M Map 改版 S5）
 *
 * 从「一张方案卡」抽出**展示用**快照（`PlanSnapshot`）。
 * ★ **只存派生数值**（时长/换乘/载具文字），**绝不存高德原始 polyline / 地图几何**（02 §2.3 合规）。
 *
 * ⚠️ 纯函数模块：不 import pg。
 */
import { legSummary, planFingerprint, type PlanSnapshot } from "./types";

/** 本地补漏方案的 planId 起点（与 `NavResultClient` 同口径） */
export const LOCAL_PLAN_BASE = 900_000;

/** 卡片最小结构（结构兼容 `RecommendCard`） */
export interface CardLike {
  planId: number;
  totalMin: number;
  walkOut: { minutes: number };
  walkIn: { minutes: number };
  rides: { route: string; board: string; alight: string; boardLabel: string; alightLabel: string }[];
  transfers: unknown[];
}

/**
 * 造快照。`capturedAt` = 采集时刻（用于「保存于 MM-DD」展示与排序/清理，**不触发任何自动行为**）。
 * `fingerprint` 与 `PlanFavorite.fingerprint` **同一算法**（快照自洽）。
 */
export function snapshotOfCard(card: CardLike, localPlanBase = LOCAL_PLAN_BASE): PlanSnapshot {
  const walkMin = Math.round((card.walkOut.minutes + card.walkIn.minutes) * 10) / 10;
  return {
    capturedAt: Date.now(),
    fingerprint: planFingerprint(card.rides),
    totalMin: card.totalMin,
    walkMin,
    transfers: card.transfers.length,
    legs: legSummary(card.rides),
    origin: card.planId >= localPlanBase ? "local" : "amap",
  };
}
