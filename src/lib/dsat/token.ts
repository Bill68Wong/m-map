/**
 * DSAT token 签名（src/lib/dsat/token.ts）
 * 算法来源：由官方报站前端的行为观测推导得出（调研记录见 docs/DSAT巴士接口调研.md，该文档不入库、仅本地保留）
 *
 * 令牌由查询串摘要的分段与当前时间拼接而成（分段位置见下方实现）
 * 总长 44 字符；qs 必须与请求体参数串完全一致（含顺序）；时间为澳门时间 GMT+8
 */
import { createHash } from "crypto";

/** 取澳门时间（GMT+8）的 YYYYMMDDHHmm，与本地时区无关 */
export function macauNow(now: Date = new Date()): string {
  const t = new Date(now.getTime() + 8 * 3600 * 1000); // 平移到 GMT+8 后用 UTC 取值
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${t.getUTCFullYear()}` +
    `${p(t.getUTCMonth() + 1)}` +
    `${p(t.getUTCDate())}` +
    `${p(t.getUTCHours())}` +
    `${p(t.getUTCMinutes())}`
  );
}

/** 由参数串（URL 编码后的 qs）生成 44 位 token */
export function genToken(qs: string, now: Date = new Date()): string {
  const m = createHash("md5").update(qs, "utf8").digest("hex");
  const o = macauNow(now);
  return (
    m.slice(0, 4) +
    o.slice(0, 4) +
    m.slice(4, 12) +
    o.slice(4, 8) +
    m.slice(12, 24) +
    o.slice(8, 12) +
    m.slice(24, 32)
  );
}
