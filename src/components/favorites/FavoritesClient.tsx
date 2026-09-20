"use client";

/**
 * 收藏页客户端（src/components/favorites/FavoritesClient.tsx，M Map 改版 S5）
 *
 * ── F1 SSR 水合（02 §2.6）─────────────────────────────────────────────
 *   整体 `"use client"`；首帧渲染**加载中骨架**，`mounted` 后再读 storage
 *   （服务端与首帧输出一致 → 不报 hydration）。
 *
 * ── 分组（PRD §7.3）───────────────────────────────────────────────────
 *   **「路线方案」在前、「地点对」在后**；每组有组标题 + 计数；**不做编号**（避开 AI 脚手架味）。
 *
 * ── 空状态（PRD §7.7，文案具体可操作，禁用空洞占位）──────────────────
 *   全空 → 「还没存过路线。看到好走的，右下角收着。」+ 主按钮「去规划路线」→ `/`；
 *   单组空 → 行内空态（并给出**下一步动作**）。
 *
 * ── 回放（PRD §7.5 / 02 §2.5）────────────────────────────────────────
 *   · 地点对 → `/?${query}`（回首页预填起终点，进「可出发」态）；
 *   · 方案 → 先 `/api/nav?${query}` 重算 → 按**指纹**在返回卡中比对：
 *       命中 → 用**该卡当前 planId** 跳 `/nav/detail`；
 *       未命中 → 落 `/nav?${query}` + 顶部提示「原方案已变化，已为你重新规划」
 *                （经 `sessionStorage` 一次性传递，**不新增 URL 参数**）。
 *
 * ── 隐私模式（F2 / AC-3.7）────────────────────────────────────────────
 *   `localStorage` 不可用 → **只读降级** + 行内提示，**不阻塞**导航主流程。
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "@/components/ui/Icon";
import FavoriteCard from "./FavoriteCard";
import { touchFavorite, useFavorites } from "@/lib/favorites/useFavorites";
import { planFingerprint, type FavoriteItem, type PlanFavorite } from "@/lib/favorites/types";
import { setNavNotice } from "@/lib/nav/nav-notice";

/** `/api/nav` 返回的最小结构（仅取比对所需字段） */
interface NavApiCard {
  planId: number;
  rides: { route: string; board: string; alight: string }[];
}
interface NavApiResp {
  ok?: boolean;
  cards?: NavApiCard[];
}

/**
 * 指纹比对：**先精确相等**，再退一步「前缀包含」（PRD §7.6.2 口径）。
 * 返回命中卡的 `planId`（未命中 → null）。
 */
function matchPlan(cards: NavApiCard[], fingerprint: string): number | null {
  for (const c of cards) {
    if (planFingerprint(c.rides ?? []) === fingerprint) return c.planId;
  }
  for (const c of cards) {
    const fp = planFingerprint(c.rides ?? []);
    if (fp && (fp.startsWith(fingerprint) || fingerprint.startsWith(fp))) return c.planId;
  }
  return null;
}

export default function FavoritesClient({ colors = {} }: { colors?: Record<string, string> }) {
  const router = useRouter();
  const favs = useFavorites();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  async function open(item: FavoriteItem) {
    touchFavorite(item.id);
    // ① 地点对 → 回首页预填（不自动跳结果页）
    if (item.type === "place") {
      router.push(`/?${item.query}`);
      return;
    }
    // ② 方案 → 按当前时刻重算 → 指纹比对
    setBusyId(item.id);
    setNotice("");
    try {
      const res = await fetch(`/api/nav?${item.query}`, { cache: "no-store" });
      const json = (await res.json()) as NavApiResp;
      const cards = Array.isArray(json?.cards) ? json.cards : [];
      const planId = matchPlan(cards, (item as PlanFavorite).fingerprint);
      if (planId !== null) {
        router.push(`/nav/detail?${item.query}&plan=${planId}`);
        return;
      }
      // 未命中 → 落 /nav，并由 sessionStorage 传一次性提示（不新增 URL 参数）
      setNavNotice("原方案已变化，已为你重新规划");
      router.push(`/nav?${item.query}`);
    } catch {
      setNotice("暂时无法校验这条方案，可以稍后再试，或直接重新规划同一路线。");
    } finally {
      setBusyId(null);
    }
  }

  function remove(id: string) {
    favs.remove(id);
  }
  function rename(id: string, note: string) {
    favs.update(id, { note: note || undefined } as Partial<FavoriteItem>);
  }
  function pin(id: string, pinned: boolean) {
    favs.update(id, { pinned } as Partial<FavoriteItem>);
  }

  // ── 首帧（SSR / 未挂载）：骨架，保证服务端与首帧输出一致（F1）──
  if (!favs.mounted) {
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

  const total = favs.items.length;
  const hasPlans = favs.plans.length > 0;
  const hasPlaces = favs.places.length > 0;

  return (
    <div className="fav-page">
      <h1 className="fav-page__title">收藏</h1>

      {!favs.available && (
        <p className="fav-note fav-note--warn t-label" role="status">
          当前浏览器不支持本地收藏，以下为只读展示；导航功能不受影响。
        </p>
      )}
      {favs.available && (
        <p className="fav-note t-label t-muted">收藏保存在本机浏览器，清除浏览器数据会一起清掉。</p>
      )}
      {notice && (
        <p className="fav-note fav-note--warn t-label" role="status">
          {notice}
        </p>
      )}

      {total === 0 ? (
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
        <>
          {/* ① 路线方案（在前） */}
          <section className="fav-group">
            <h2 className="fav-group__title">
              路线方案<span className="fav-group__count t-label">{favs.plans.length} 条</span>
            </h2>
            {!hasPlans && (
              <p className="fav-group__empty t-label t-muted">
                {hasPlaces
                  ? "还没有收藏的路线方案——在路线结果页点书签图标即可存下来。"
                  : "还没有收藏的路线方案。"}
              </p>
            )}
            {favs.plans.map((p) => (
              <div key={p.id} className={busyId === p.id ? "is-busy" : undefined}>
                <FavoriteCard
                  item={p}
                  colors={colors}
                  readOnly={favs.readOnly}
                  onOpen={open}
                  onRemove={remove}
                  onRename={rename}
                  onPin={pin}
                />
              </div>
            ))}
          </section>

          {/* ② 地点对（在后） */}
          <section className="fav-group">
            <h2 className="fav-group__title">
              地点对<span className="fav-group__count t-label">{favs.places.length} 组</span>
            </h2>
            {!hasPlaces && (
              <p className="fav-group__empty t-label t-muted">
                {hasPlans
                  ? "还没有收藏的地点对——在首页选定目的地后即可保存常用路线。"
                  : "还没有收藏的地点对。"}
              </p>
            )}
            {favs.places.map((p) => (
              <FavoriteCard
                key={p.id}
                item={p}
                colors={colors}
                readOnly={favs.readOnly}
                onOpen={open}
                onRemove={remove}
                onRename={rename}
                onPin={pin}
              />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
