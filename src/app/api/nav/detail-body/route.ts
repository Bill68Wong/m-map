/**
 * POST /api/nav/detail-body —— 路线详情「弹窗体」数据（2026-09-23 新增）
 *
 * ── 解决什么 ──────────────────────────────────────────────────────────
 *   全屏详情弹窗（主页「出发」与收藏页点卡入口）不走页面、也**不重算整条 planNav**：
 *   卡片数据前端已持有 ⇒ 本接口只把卡片解出**纵向站条**（`buildStrips`）并附上
 *   「本站台其他线路」实时报站（折叠栏）—— 因此打开详情明显更快，
 *   且**用哪张卡就显示哪张**（planId 不参与定位，从根上消除「点 51 显示 56」）。
 *
 * ── 输入 / 输出 ────────────────────────────────────────────────────────
 *   输入：JSON `{ card: RecommendCard }`（结构同 `/api/nav` 响应的 cards[] 元素）
 *   输出：`{ ok, strips, otherRoutes, foldLive, stationLabel }`
 *
 * ⚠️ 只读接口（不写库）。公开白名单由 `/api/nav` 前缀覆盖（middleware fail-closed 规则）。
 * ⚠️ `card` 仅用于**只读解算**（站序查表 + 实时报站），逐段浅校验，无注入面。
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { buildStrips } from "@/lib/nav/strips";
import { foldDataOfCard } from "@/lib/nav/detail-fold";
import { loadStatics } from "@/lib/recommend/query";
import type { RecommendCard } from "@/lib/recommend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "sin1";
export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { card?: RecommendCard };
    const card = body?.card;
    // 浅校验：必须有非空 rides，且逐条含 route / board / alight 字符串
    if (!card || !Array.isArray(card.rides) || !card.rides.length) {
      return NextResponse.json({ ok: false, error: "missing_card" }, { status: 400 });
    }
    for (const r of card.rides) {
      if (
        !r ||
        typeof r.route !== "string" ||
        typeof r.board !== "string" ||
        typeof r.alight !== "string"
      ) {
        return NextResponse.json({ ok: false, error: "bad_rides" }, { status: 400 });
      }
    }

    const pool = getPool();
    const st = await loadStatics(pool);
    const nowMs = Date.now();
    const weekday = new Date(nowMs + 8 * 3_600_000).getUTCDay();
    const strips = buildStrips(card, {
      routeIdx: st.routeIdx,
      segIdx: st.segIdx,
      nameOf: st.routeIdx.nameOf,
      weekday,
    });
    const fold = await foldDataOfCard(pool, st, card, nowMs);

    return NextResponse.json(
      {
        ok: true,
        strips,
        otherRoutes: fold.otherRoutes,
        foldLive: fold.foldLive,
        stationLabel: fold.stationLabel,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[api/nav/detail-body] 失败：", msg);
    return NextResponse.json({ ok: false, error: msg.slice(0, 200) }, { status: 500 });
  }
}
