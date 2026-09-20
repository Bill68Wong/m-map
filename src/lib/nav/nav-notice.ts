/**
 * `/nav` 一次性提示条（src/lib/nav/nav-notice.ts，M Map 改版 S5）
 *
 * 用途：收藏页点「方案」收藏时，若重算后**指纹未命中**（方案已调整），
 * 需要在跳转到 `/nav` 后于**顶部提示**「原方案已变化，已为你重新规划」。
 *
 * ⚠️ 为什么不用 URL 参数：02 §2.3 明确「**不新增任何 URL 参数体系**」（前端零协议变更）。
 *    用 `sessionStorage` 传递**同标签一次性**提示，跳转后由 `/nav` 客户端壳读取即清除。
 */

const KEY = "must.nav.notice";

/** 写入一次性提示（跳转前调用） */
export function setNavNotice(text: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, text);
  } catch {
    /* 隐私模式：忽略（提示丢失，不影响主流程） */
  }
}

/** 读取并**立即清除**（`/nav` 客户端壳挂载时调用） */
export function takeNavNotice(): string {
  if (typeof window === "undefined") return "";
  try {
    const v = window.sessionStorage.getItem(KEY);
    if (v) window.sessionStorage.removeItem(KEY);
    return v ?? "";
  } catch {
    return "";
  }
}
