/**
 * 请求体读取 + 体积上限（src/lib/http/body-limit.ts，v3.6.0 S2）
 *
 * ── 为什么要单独做 ────────────────────────────────────────────────────
 *   `POST /api/fav-routes*` 拆门后公开可写。`await req.json()` 会把**任意大小**的
 *   请求体先读进内存再解析 ⇒ 一个几 MB 的 body 就能吃掉函数内存配额。
 *   AC-50c 要求请求体 ≤ 16KB，超限必须拒绝（413），因此需要「读之前先看长度、
 *   读之后按字节复核」两道闸。
 *
 * ── 判定顺序 ──────────────────────────────────────────────────────────
 *   ① `Content-Length` 已声明且超限 ⇒ 立刻 413，**不读 body**（最省）；
 *   ② 未声明 / 声明不超限 ⇒ 读取文本后按 `Buffer.byteLength` 复核（分块传输也不放过）；
 *   ③ 解析失败 ⇒ 视为 `bad_request`（由调用方决定文案）。
 */

/** 收藏类写接口的请求体上限（字节）：AC-50c 定 16KB */
export const MAX_FAV_BODY_BYTES = 16 * 1024;

export type ReadJsonResult<T> =
  | { ok: true; value: T }
  /** `tooLarge` = 超体积上限；`invalid` = 不是合法 JSON */
  | { ok: false; reason: "tooLarge" | "invalid" };

/**
 * 读取 JSON 请求体，并强制体积上限。
 *
 * @param req      带 `headers` 与 `text()` 的请求对象
 * @param maxBytes 上限（字节），默认 16KB
 */
export async function readJsonLimited<T>(
  req: { headers: { get(name: string): string | null }; text(): Promise<string> },
  maxBytes: number = MAX_FAV_BODY_BYTES,
): Promise<ReadJsonResult<T>> {
  // ① 声明长度先挡（避免把大 body 读进内存）
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, reason: "tooLarge" };
  }

  // ② 读取后按**实际字节数**复核（Content-Length 可缺失、可撒谎）
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (Buffer.byteLength(raw, "utf8") > maxBytes) {
    return { ok: false, reason: "tooLarge" };
  }

  // ③ 解析
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
