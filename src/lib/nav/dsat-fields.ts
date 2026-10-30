/**
 * DSAT 原始字段归一工具（src/lib/nav/dsat-fields.ts）
 *
 * ── 为什么单独成文件 ──────────────────────────────────────────────────
 *   `/api/route-vehicles` 与 `/api/station/eta` 两个路由都需要同一批
 *   「DSAT 原始值 → 本地可用值」的归一函数。原先各自内联了一份（`withTimeout`
 *   与 `stripCodePrefix` 两处实现逐字相同），既占行数也容易改一处漏一处。
 *   本文件是这些纯函数的单一出处，**无副作用、无业务逻辑**，可安全复用。
 *
 * ⚠️ 本文件只做**值层面的归一**（字符串/数字/超时），不涉及业务判定。
 *    站码语义（方向、站序、主码）属于业务，留在各自路由里。
 */

/** 超时包装：到点即拒（调用方按「无数据」处理） */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** 数值归一：空串 / null / 非有限数 → null（DSAT 的坐标、旧版 speed 都用它） */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 站码归一：`T373/1` → `T373`（去站台后缀，与全站口径一致） */
export function mainCode(raw: string): string {
  return /^[A-Za-z]+\d+/.exec(String(raw ?? ""))?.[0] ?? String(raw ?? "");
}

/** 剥掉站名里的「站码前缀」（`C653 金峰南岸` → `金峰南岸`） */
export function stripCodePrefix(raw: string): string {
  return String(raw ?? "").replace(/^[A-Za-z]+\d+(?:\/\d+)?\s+/, "");
}
