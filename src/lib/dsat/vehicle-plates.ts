/**
 * 车牌 ↔ 车队编号 ↔ 车型 的落库层（src/lib/dsat/vehicle-plates.ts）
 *
 * ── 它解决什么 ────────────────────────────────────────────────────────
 *   DSAT 报站接口（`routestation/bus`）与位置接口（`routestation/location`）
 *   **同一次响应里就白送** `busPlate` + `busCode`（+ `busType`）。这一对应关系
 *   以前只在内存里活一次就丢了 —— 本模块把它**顺手**持久化到 `vehicle_plates`，
 *   入口问题「看到一个车牌，它是什么车」才有答案。
 *
 * ── 为什么 `plate` 是主键（不是 `bus_code`）────────────────────────────
 *   界面入口是「见到车牌 → 问车是什么」，plate 才是查询键。一车一牌一编号，plate 唯一。
 *   `bus_code` 只建普通索引（按编号反查/统计用）。
 *
 * ── 写入语义（★ 静默降级防线）──────────────────────────────────────────
 *   全部字段走 `ON CONFLICT DO UPDATE ... COALESCE(EXCLUDED.x, 表.x)`：
 *   新车批次查不到型号时 `model*` 传 NULL，**不能**把已标定好的行冲成 NULL。
 *   这是今天已经踩过的同类坑（「新车覆盖老标定」属无声数据退化，事后极难发现）。
 *
 * ── 不阻塞、不抛错 ────────────────────────────────────────────────────
 *   `recordVehiclePlatesAsync` 面向请求链路：用 `after()` 在响应发出后再写，
 *   任何失败只 `console.warn`。车辆位置接口的可用性绝不受本模块影响。
 *
 * ── ★ 报「分布 / 占比 / 台数」的硬规矩（2026-10-30 立的）──────────────────
 *   本表**行数会随采集持续增长**（上线数小时即 514 → 532），任何"某类占 X%"的数字
 *   都会**过几天就对不上**。因此对外报数必须遵守五条，否则会误导下游决策：
 *
 *   ① **只贴脚本原样输出，不转述、不重排、不凭印象填。**
 *      反面教训（真实发生过）：把脚本输出的「长度4 = 66 台」写成「78 台」，
 *      下游据此算出「占 3.4%」并用它论证设计取舍，实际占比 12.6%（差 3.7 倍）。
 *      数字错不可怕，**被拿去做决策**才可怕 —— 而错的源头往往只是"没照抄输出"。
 *   ② **必须带日期与样本量**，写成「约 12.6%（2026-10-30，532 台）」，
 *      绝不写成固定值。需求方会把百分比当常量用，标注口径是唯一防线。
 *   ③ **论证不要依赖精确百分比**：用"约 1/8""绝大多数""少数"这类**抗漂移**表述，
 *      除非你能保证样本固定。反例：用"3.4%"论证设计取舍（实为 12.6%），
 *      结论虽对但论证崩了 —— 一旦被人查出错，连正确结论都会被连坐怀疑。
 *   ④ **给下游用于取舍的比例，必须同时给分子/分母，且多组数据要逐项对齐比分子，不能只核"总和自洽"。**
 *      原因（今天真实发生的三组数，全部同批 526）：
 *        · 脚本真值   长度4 = 66 / 长度5 = 460  （和 526）
 *        · 我写错的   长度4 = 78 / 长度5 = 448  （和 526）← 分子凭空填，未照抄输出
 *        · 设计侧算的 长度4 = 18 / 长度5 = 508  （和 526）← 分类漏了 HE01-HE12 共 49 台
 *      ⇒ **三组"总和"全都自洽（都是 526），所以求和校验一个错都抓不出来。**
 *        唯一破绽是同一分类的分子：66 / 78 / 18 三个数互不相同 —— **必须逐项对齐才露馅**。
 *      ⇒ 结论：**绝对数 + 两组横向比同项 = 可校验**；
 *        **只核总和、只给百分比、或只给单组绝对数，均不可校验**
 *        （单组绝对数没有"另一组的同项"可比，孤立看永远自洽）。
 *   ⑤ **转述他人的比例时，必须连分母一起转**：写「99.6%（743 车次，2026-10-30）」
 *      而不是「99.6%」。比例脱了分母就没有意义，且会随样本增长失效。
 *      这类错误不只发生在**给数据的人**身上，也发生在**转述者**身上
 *      —— 实例：把「99.7%」写进验收判据时未带分母，分母从 362 涨到 743 后该值已失真。
 *      ④ 约束供数方，⑤ 约束转述方：**同一条纪律的两个角色，缺一仍会失真。**
 *
 *   ★ 一句话记住：**数字要精确到可复核，论证要模糊到不失效。**
 *     （①②④⑤ 管"可复核"：照抄、标口径、分子分母逐项对齐、连分母转述；③ 管"不失效"：别押在精确值上。）
 *
 *   （`plate` 的「恒 6 字符」是例外——那是 `normalizePlate` 的**输入约束**保证，
 *    不随行数变化，可当常量引用。）
 */
import { after } from "next/server";
import type { Pool } from "pg";
import { getPool } from "@/lib/db";
import { companyOf, modelOf, type Company } from "./vehicle-models";

/** 一行的入库形态（model* 四列由 `modelOf` 填充，可能全为 null） */
export interface PlateRow {
  plate: string;
  bus_code: string | null;
  company: Company | null;
  bus_type: string | null;
  model: string | null;
  model_category: string | null;
  model_source: string | null;
  model_confidence: string | null;
}

/** 采集侧的原始输入（来自 DSAT 两个接口的合并结果） */
export interface PlateInput {
  plate: string;
  busCode?: string | null;
  busType?: string | null;
}

/** 每批 upsert 的行数：9 参数/行 ⇒ 200 行 = 1800 参数，远低于 PG 上限 65535 */
const BATCH = 200;

/**
 * 车牌归一：大写 + 去全部空白。
 * 只做这两件事 —— 不猜分隔符、不去连字符（改写车牌会造出库里不存在的键）。
 */
export function normalizePlate(raw: string | null | undefined): string | null {
  const s = String(raw ?? "")
    .toUpperCase()
    .replace(/\s+/g, "");
  return s === "" ? null : s;
}

/** busType 归一：只认 DSAT 的 '1'/'2'，其余一律 null（不把脏值写进库） */
function normalizeBusType(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim();
  return s === "1" || s === "2" ? s : null;
}

/**
 * 原始输入 → 入库行。车牌非法（空）返回 null，由调用方丢弃。
 * 型号查不到时 model* 全为 null —— 交给 SQL 的 COALESCE 保住旧值。
 */
export function buildPlateRow(input: PlateInput): PlateRow | null {
  const plate = normalizePlate(input.plate);
  if (!plate) return null;

  const busCodeRaw = String(input.busCode ?? "").trim().toUpperCase().replace(/\s+/g, "");
  const bus_code = busCodeRaw === "" ? null : busCodeRaw;
  const info = bus_code ? modelOf(bus_code) : null;

  return {
    plate,
    bus_code,
    // 运营商优先由编号前缀判定；无编号时留空（不按车牌段猜 —— 澳门车牌段与公司无稳定对应）
    company: bus_code ? companyOf(bus_code) : null,
    bus_type: normalizeBusType(input.busType),
    model: info?.model ?? null,
    model_category: info?.category ?? null,
    model_source: info?.source ?? null,
    model_confidence: info?.confidence ?? null,
  };
}

/**
 * 批量 upsert（单条 SQL 多行 VALUES，避免 N 次往返）。
 *
 * @param pool 连接池。脚本侧**必须**显式传入自己的 Pool —— 否则本模块会退回
 *   `getPool()`（它按 `DATABASE_URL_LOCAL || DATABASE_URL` 解析），一旦 .env 同时
 *   配了两个库，就会出现「脚本读 A 库、写 B 库」这种最难排查的分裂。
 * @returns 实际写入/更新的行数
 */
export async function upsertVehiclePlates(rows: PlateRow[], pool: Pool = getPool()): Promise<number> {
  if (rows.length === 0) return 0;
  let written = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];

    chunk.forEach((r, idx) => {
      const b = idx * 9;
      tuples.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9}, now())`);
      values.push(
        r.plate,
        r.bus_code,
        r.company,
        r.bus_type,
        r.model,
        r.model_category,
        r.model_source,
        r.model_confidence,
        // 有型号才记标定时间；无型号的观察只更新 last_seen_at
        r.model ? new Date() : null,
      );
    });

    const res = await pool.query(
      `INSERT INTO vehicle_plates
         (plate, bus_code, company, bus_type, model, model_category,
          model_source, model_confidence, calibrated_at, last_seen_at)
       VALUES ${tuples.join(",")}
       ON CONFLICT (plate) DO UPDATE SET
         bus_code         = COALESCE(EXCLUDED.bus_code,         vehicle_plates.bus_code),
         bus_type         = COALESCE(EXCLUDED.bus_type,         vehicle_plates.bus_type),
         company          = COALESCE(EXCLUDED.company,          vehicle_plates.company),
         model            = COALESCE(EXCLUDED.model,            vehicle_plates.model),
         model_category   = COALESCE(EXCLUDED.model_category,   vehicle_plates.model_category),
         model_source     = COALESCE(EXCLUDED.model_source,     vehicle_plates.model_source),
         model_confidence = COALESCE(EXCLUDED.model_confidence, vehicle_plates.model_confidence),
         calibrated_at    = COALESCE(EXCLUDED.calibrated_at,    vehicle_plates.calibrated_at),
         last_seen_at     = now()`,
      values,
    );
    written += res.rowCount ?? 0;
  }

  return written;
}

/**
 * 请求链路用的即发即忘入口（`/api/route-vehicles` 调用）。
 * 用 `after()` 保证响应发出后仍写完；非请求上下文（脚本）退回直接执行。
 * **绝不抛错**：采集失败不能影响车辆位置返回。
 */
export function recordVehiclePlatesAsync(inputs: PlateInput[]): void {
  if (inputs.length === 0) return;
  const run = () => {
    try {
      const rows = inputs
        .map((x) => buildPlateRow(x))
        .filter((r): r is PlateRow => r !== null);
      void upsertVehiclePlates(rows).catch((e: unknown) => {
        console.warn("[vehicle-plates] 落库失败（忽略）：", (e as Error).message);
      });
    } catch (e) {
      console.warn("[vehicle-plates] 组装失败（忽略）：", (e as Error).message);
    }
  };
  try {
    after(run);
  } catch {
    run();
  }
}
