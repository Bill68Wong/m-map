/**
 * /about —— ★ v2.10.0：**308 永久重定向** 到 `/help`
 * （src/app/about/page.tsx）
 *
 * 为什么保留这一页而不是删掉：老链接、外链、以及底部导航的历史入口仍指向 `/about`；
 * 直接删除会得到 404。改用 `permanentRedirect`（HTTP **308**）让旧地址平滑落到新帮助页。
 * 原「关于」页的全部合规内容已迁入 `/help` 的「数据来源与合规」区块（并更新了两处过时口径）。
 */
import { permanentRedirect } from "next/navigation";

export const metadata = {
  title: "关于",
  description: "数据来源、计算方法与非商业声明",
};

export default function AboutPage(): never {
  permanentRedirect("/help");
}
