/**
 * 同源判定（src/lib/security/same-origin.ts，v3.6.0 S2）
 *
 * ── 用途 ──────────────────────────────────────────────────────────────
 *   拆除访问口令门后，`/api/fav-routes*` 仍保持**公开可写**（无账号体系，不硬造认证）。
 *   为挡住「别的网站替用户写数据」这类滥用，写请求必须能证明**来自本站页面**：
 *   `Origin`（POST 必带）或 `Referer` 的 host 必须等于本站 host，否则 403。
 *
 * ── 判定口径（AC-50c）────────────────────────────────────────────────
 *   · 缺 `Origin` 且缺 `Referer` ⇒ **拒绝**（不是「无法判断就放行」——那是 fail-open）；
 *   · `Origin: null`（沙箱 iframe / file://）⇒ 拒绝；
 *   · 多域名部署（`macaomap.vercel.app` + `musttoukou.vercel.app`）⇒ 每个请求的 host 即自身域名，
 *     故只需与**本请求的 host** 比对，不需要维护域名清单。
 *
 * ⚠️ 本文件只做纯字符串比较，**不访问数据库**，可安全用于 Edge 中间件。
 */

/** `x-forwarded-host` 可能是逗号列表（多级代理），取第一段 */
function firstHostOf(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim().toLowerCase();
  return first ? first : null;
}

/** 取 URL 字符串的 host（非法 URL ⇒ null） */
function hostOfUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * 该请求是否来自本站页面？
 *
 * @param req 请求（只要用到 `headers` 与 `nextUrl`，Edge/Node 通用）
 */
export function isSameOrigin(req: {
  headers: { get(name: string): string | null };
  nextUrl: { host: string };
}): boolean {
  // 本站 host 候选：转发头（生产代理）→ Host → 请求 URL 自身
  const own = new Set<string>();
  const forwarded = firstHostOf(req.headers.get("x-forwarded-host"));
  const host = firstHostOf(req.headers.get("host"));
  const urlHost = (req.nextUrl.host || "").toLowerCase();
  if (forwarded) own.add(forwarded);
  if (host) own.add(host);
  if (urlHost) own.add(urlHost);

  // 来源 host：Origin 优先（POST 由浏览器强制带），无则退回 Referer
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  const srcHost = hostOfUrl(source);
  if (!srcHost) return false;
  return own.has(srcHost);
}
