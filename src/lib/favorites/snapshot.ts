/**
 * 方案快照构造（src/lib/favorites/snapshot.ts，M Map 改版 S5）
 *
 * 从「一张方案卡」抽出**展示用**快照（`PlanSnapshot`）与**流程图结构**（`RouteSeg[]`）。
 * ★ **只存派生数值**（时长/换乘/载具文字 + 站码站名），**绝不存高德原始 polyline / 地图几何**（02 §2.3 合规）。
 *
 * ⚠️ 纯函数模块：不 import pg。
 */
import {
  legSummary,
  planFingerprint,
  type PlanSnapshot,
  type RouteSeg,
} from "./types";

/** 本地补漏方案的 planId 起点（与 `NavResultClient` 同口径） */
export const LOCAL_PLAN_BASE = 900_000;

/** 卡片最小结构（结构兼容 `RecommendCard`） */
export interface CardLike {
  planId: number;
  totalMin: number;
  walkOut: { minutes: number; toLabel?: string; estimated?: boolean };
  walkIn: { minutes: number; toLabel?: string; estimated?: boolean };
  rides: {
    route: string;
    kind?: "bus" | "lrt";
    board: string;
    alight: string;
    boardLabel: string;
    alightLabel: string;
    hops?: number | unknown[];
    parallelRoutes?: string[];
  }[];
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

/**
 * ★ v2.4.0：从卡片抽**路线流程图结构**（`RouteSeg[]`）。
 *
 * 形态（与 `ComboEditor` 的纵向流程图同构）：
 *   步行(out) → 乘车① → 换乘 → 乘车② → … → 步行(in)
 *
 * 与 `snapshotOfCard` **同源**（同一张卡），本函数额外保留「可渲染的定位信息」
 * （站码/站名/段类型/坐几站）——`PlanSnapshot.legs` 那串纯文字画不出图。
 *
 * @param originEndpoints 两端展示名（`[出发地, 目的地]`）；缺省则不产出端点伪段（由 UI 用组合的 from/to 补）
 */
export function routeSegsOfCard(card: CardLike): RouteSeg[] {
  const segs: RouteSeg[] = [];

  // 出发地 → 上车站 的步行（第一段载具的上车站 = 步行终点）
  const first = card.rides[0];
  if (first) {
    const w: RouteSeg = { kind: "walk", phase: "out", code: first.board, label: first.boardLabel };
    const m = Number(card.walkOut.minutes);
    if (Number.isFinite(m)) w.minutes = m;
    w.walkSrc = card.walkOut.estimated ? "estimate" : "measured";
    segs.push(w);
  }

  card.rides.forEach((r, i) => {
    const route = r.route;
    const routes = Array.isArray(r.parallelRoutes) && r.parallelRoutes.length ? [route, ...r.parallelRoutes] : undefined;
    const seg: RouteSeg = {
      kind: "ride",
      route,
      board: r.board,
      alight: r.alight,
      boardLabel: r.boardLabel,
      alightLabel: r.alightLabel,
    };
    if (routes) seg.routes = routes;
    if (r.kind === "lrt" || r.kind === "bus") seg.label = r.kind; // 段类型留痕（渲染按线路码取色，不依赖它）
    if (typeof r.hops === "number" && Number.isFinite(r.hops)) seg.hops = Math.max(0, Math.round(r.hops));
    else if (Array.isArray(r.hops)) seg.hops = r.hops.length;
    segs.push(seg);

    // 段间换乘（最后一段之后无换乘）
    if (i < card.rides.length - 1) {
      const next = card.rides[i + 1];
      segs.push({ kind: "transfer", code: r.alight, label: r.alightLabel });
      // 换乘落点 = 下一段上车站；若与前段下车点不同（非同场）→ 补一个步行节点
      if (next.board !== r.alight) {
        segs.push({
          kind: "walk",
          phase: "in",
          code: next.board,
          label: next.boardLabel,
          walkSrc: "estimate",
        });
      }
    }
  });

  // 下车站 → 目的地 的步行
  const last = card.rides[card.rides.length - 1];
  if (last) {
    const w: RouteSeg = { kind: "walk", phase: "in", code: last.alight, label: last.alightLabel };
    const m = Number(card.walkIn.minutes);
    if (Number.isFinite(m)) w.minutes = m;
    w.walkSrc = card.walkIn.estimated ? "estimate" : "measured";
    segs.push(w);
  }

  return segs;
}
