/**
 * 轻轨发车查询（src/lib/lrt/next-departures.ts，v1.0.0）
 *
 * 从 `/api/lrt/eta/route.ts` **抽取**的核心逻辑（v1.0.0 只为自动选线复用，口径零变更）：
 *   站序推方向 → lrt_api_stations 换 api 站/方向码 → 当日班别 + 昨日跨午夜续班
 *   → next/nextN → 空态枚举（首班前/收车/无数据）。
 *
 * ⚠️ 输入一律**本库码**（`LRT-氹仔线` / `LRT-MUST`）；motransportinfo 的 route_no / api_id
 *    只在服务端内部出现。换乘站目标台码常属他线，勿拿他线码反推（项目教训）。
 * ⚠️ 不依赖 DSAT；日期/假期基准均 GMT+8 本地判定。
 */
import type { Pool } from "pg";
import {
  type BiasIndex,
  type BiasLineRow,
  type BiasStationRow,
  buildBiasIndex,
  emptyBiasIndex,
  fixDeparture,
} from "./apply-bias";
import { type DayType, dayTypeOf, macauNowParts, shiftYmd } from "./day-type";
import { type LrtTimetableMinutes, hhmmOf, hhmmOfMinutes, rowCandidateSec, rowOffsetsOf } from "./eta";
import { LRT_LINE_TO_ROUTE_NO, destLabelOf, directionOfTravel, isLrtLineCode, isLrtStationCode } from "./map";
import { LRT_PATTERN_ROUTE_NO, deriveStationPatterns, lrtPatternKey } from "./pattern";

const DAY_MS = 86_400_000;

export interface LrtDepartureRow {
  /** 'HH:MM'（**已叠偏差**的实际发车时钟） */
  clock: string;
  /** 绝对毫秒（服务日 D 00:00 + 偏移；可跨午夜；**已叠偏差**） */
  depMs: number;
  /** ★ v3.2.0：true = 本班有秒级偏差数据（氹仔线模式命中 / 石排湾·横琴线路级） */
  secPrecise?: boolean;
  /** ★ v3.2.0：氹仔线命中的站间模式串（未命中/非氹仔线 = null） */
  pattern?: string | null;
  /** ★ v3.2.0：本班实际叠加的偏差（秒）；未命中 = 0 */
  biasSec?: number;
}

export interface LrtDeparturesOk {
  ok: true;
  state: "running" | "before_first" | "after_last" | "no_data";
  stationCode: string;
  lineCode: string;
  routeNo: string;
  dir: string;
  directionCode: string;
  directionName: string;
  dayType: DayType;
  serviceDay: string;
  firstClock: string | null;
  lastClock: string | null;
  departures: LrtDepartureRow[];
  serverNow: string;
}

export interface LrtDeparturesErr {
  ok: false;
  error: string;
  /** HTTP 语义状态（400 = 参数错；500 = 数据缺失） */
  status: number;
}

export type LrtDeparturesResult = LrtDeparturesOk | LrtDeparturesErr;

/**
 * ★ v1.0.0（性能修复）：轻轨**预载上下文**。
 *
 * ── 为什么必须有 ────────────────────────────────────────────────────
 * `queryLrtDepartures` 原本要 **6 次串行 DB 往返**（站序 → api 码 ×2 → 假期 ×2 → 时刻表 ×2）。
 * 线上实测：Vercel 函数跑在 **iad1（美东）**，主库在 **ap-southeast-1（新加坡）**
 * → 单次往返 ~230ms → 合计 >1.2s ⇒ **每个轻轨桶都恒定超时** ⇒ 轻轨方案全被剔除
 * （点首页卡从 5 张掉到 4 张）。根因不是轻轨算法，是**跨洲 DB 往返被串行放大**。
 *
 * ── 修法 ────────────────────────────────────────────────────────────
 * 轻轨的数据全是**极小静态表**（13 个站的 api 映射 · 假期表 · 3 条线全量时刻行 ≈ 数百行）→
 * 折进 `loadStatics` **已有的并行窗口**（+3 条查询、**零额外 RTT**），
 * 之后每个轻轨桶 **0 次 DB 往返**（纯内存）。
 * 站序直接复用已加载的 `RouteIndex.dirStops`（不再单独查 `route_stations`）。
 *
 * ⚠️ 不传 `pre` → 完全走旧 DB 路径 → `/api/lrt/eta` 行为不变（向后兼容）。
 */
export interface LrtPreload {
  /** `${lineCode}|${dsatDir}` → 有序本库站码（来自 RouteIndex.dirStops，已是 seq 序） */
  dirStops: Map<string, string[]>;
  /** 本库站码 → motransportinfo api_id */
  apiIdOf: Map<string, string>;
  /** 本库站码 → 站名（终点站名展示用） */
  nameOf: Map<string, string>;
  /** 法定假期集合（'YYYY-MM-DD'） */
  holidays: Set<string>;
  /** `${apiStation}|${routeNo}|${apiDir}|${dayType}` → 时刻行 */
  tt: Map<string, LrtTimetableMinutes>;
  /**
   * ★ v3.2.0（ADR-101 方案 C）：`${api_station}|${route_no}|${direction}|${day_type}|${dep_min}` → 模式。
   *   **内存派生、0 额外 DB 往返**（由 `buildLrtPreload` 调 `deriveStationPatterns` 生成）。
   */
  patterns: Map<string, string>;
  /**
   * ★ v3.2.0：偏差索引（逐站/逐模式 + 线路级兜底）。
   *   同折进预载（小静态表）⇒ 推荐链路的 pre 路径**零额外往返**即可读秒。
   *   ⚠️ 新表不存在时为空索引 ⇒ 全量回落分钟级（不抛错）。
   */
  bias: BiasIndex;
}

/** 预载时刻表的键（构建方与查询方必须一致） */
export function lrtTtKey(
  apiStation: string,
  routeNo: string,
  apiDir: string,
  dayType: DayType,
): string {
  return `${apiStation}|${routeNo}|${apiDir}|${dayType}`;
}

/**
 * 纯函数构建预载上下文（**不做任何 DB 访问** —— 查询由调用方并行发出后喂进来）。
 * @param dirStopsAll 全量站序索引（`RouteIndex.dirStops`）—— 本函数只挑 `LRT-*` 的键
 */
export function buildLrtPreload(args: {
  apiRows: { db_code: string; api_id: string; name_tc: string | null }[];
  holidayRows: { d: string }[];
  ttRows: (LrtTimetableMinutes & {
    api_station: string;
    route_no: string;
    direction: string;
    day_type: string;
  })[];
  dirStopsAll: Map<string, string[]>;
  /** ★ v3.2.0：`lrt_station_biases` 全量行（小表）；缺省 = 空（回落分钟级） */
  biasRows?: BiasStationRow[];
  /** ★ v3.2.0：`lrt_route_params` 行（线路级兜底）；缺省 = 空 */
  lineParamRows?: BiasLineRow[];
}): LrtPreload {
  const dirStops = new Map<string, string[]>();
  for (const [k, v] of args.dirStopsAll) if (k.startsWith("LRT-")) dirStops.set(k, v);

  const apiIdOf = new Map<string, string>();
  const nameOf = new Map<string, string>();
  for (const r of args.apiRows) {
    apiIdOf.set(r.db_code, r.api_id);
    if (r.name_tc) nameOf.set(r.db_code, r.name_tc);
  }

  const holidays = new Set<string>();
  for (const r of args.holidayRows) holidays.add(String(r.d).slice(0, 10));

  const tt = new Map<string, LrtTimetableMinutes>();
  for (const r of args.ttRows) {
    tt.set(lrtTtKey(r.api_station, r.route_no, r.direction, r.day_type as DayType), {
      first_min: r.first_min,
      last_min: r.last_min,
      minutes: r.minutes,
    });
  }

  // ★ v3.2.0：模式映射在**内存派生**（同一纯函数，零额外 DB 往返）；偏差索引折进本结构
  const patterns = deriveStationPatterns(args.ttRows);
  const bias = buildBiasIndex(args.biasRows ?? [], args.lineParamRows ?? []);

  return { dirStops, apiIdOf, nameOf, holidays, tt, patterns, bias };
}

export interface LrtDeparturesInput {
  /** 本库站码（LRT-*） */
  station: string;
  /** 本库线路码（LRT-*线） */
  route: string;
  /** 目的地本库站码（可省；给了就能推方向） */
  dest?: string | null;
  /** 本段方向（dest 推不出时用） */
  dir?: string | null;
  /** 返回班次数上限（默认 2 —— 与既有 /api/lrt/eta 完全一致；推荐层传更多） */
  take?: number;
  /**
   * ★ v1.0.0：时间基准注入（默认 `Date.now()`）。
   * 用途：① 探针在**收班时段**用假时间验证白天行为（深夜无法验证「出卡」，
   *       但可以证明同一份时刻表在 08:00 会给出正常班次）；
   *      ② 未来「按计划出发时间规划」的接口预留。
   * ⚠️ 不传 = 完全走旧路径，`/api/lrt/eta` 行为字节级不变。
   */
  nowMs?: number;
  /**
   * ★ v1.0.0：预载上下文（见 `LrtPreload`）。给了 → **0 次 DB 往返**（纯内存）；
   * 不给 → 走原 6 次串行查询（`/api/lrt/eta` 旧路径）。
   */
  pre?: LrtPreload;
}

/** 后续第 n 班（严格晚于 atMs 的最近一班） */
export function nextAfter(departures: LrtDepartureRow[], atMs: number): LrtDepartureRow | null {
  return departures.find((d) => d.depMs > atMs) ?? null;
}

/**
 * ★ v3.2.0：**旧 DB 路径**（无 `pre`，即 `/api/lrt/eta`）的偏差 + 模式小查询。
 *
 * 与预载路径**共用同一纯函数**（`buildBiasIndex` / `fixDeparture`）⇒ 两路由 depMs 同源（AC-67）。
 * ⚠️ 表尚未建/查询失败 → 返回空索引 + 空模式表 ⇒ 全量回落分钟级，**不抛错**
 *    （保证代码与数据可分先后上线）。
 */
async function loadBiasAndPatterns(
  pool: Pool,
  apiStation: string,
  routeNo: string,
  directionApi: string,
): Promise<{ biasIndex: BiasIndex; patterns: Map<string, string> }> {
  const empty = Promise.resolve({ rows: [] as unknown[] });
  const [bs, lp, pr] = await Promise.all([
    pool
      .query(
        `SELECT route_code, direction, pattern, api_station, dep_bias_sec
           FROM lrt_station_biases WHERE api_station = $1`,
        [apiStation],
      )
      .catch(() => empty),
    pool.query(`SELECT route_code, dep_bias_sec FROM lrt_route_params`).catch(() => empty),
    routeNo === LRT_PATTERN_ROUTE_NO
      ? pool
          .query(
            `SELECT day_type, dep_min, pattern FROM lrt_station_patterns
              WHERE api_station = $1 AND route_no = $2 AND direction = $3`,
            [apiStation, routeNo, directionApi],
          )
          .catch(() => empty)
      : empty,
  ]);

  const biasIndex = (bs.rows.length || lp.rows.length)
    ? buildBiasIndex(bs.rows as BiasStationRow[], lp.rows as BiasLineRow[])
    : emptyBiasIndex();

  const patterns = new Map<string, string>();
  for (const r of pr.rows as { day_type: string; dep_min: number; pattern: string }[]) {
    patterns.set(`${r.day_type}|${r.dep_min}`, r.pattern);
  }
  return { biasIndex, patterns };
}

/**
 * 查某站某线的后续发车时刻。
 * @returns ok:false 时 `status` 给出 HTTP 语义（400/500），调用方直接透传
 */
export async function queryLrtDepartures(
  pool: Pool,
  input: LrtDeparturesInput,
): Promise<LrtDeparturesResult> {
  const station = input.station?.trim() ?? "";
  const route = input.route?.trim() ?? "";
  const dest = input.dest?.trim() || null;
  const dirParam = input.dir?.trim() || null;
  const take = Math.max(1, Math.min(20, input.take ?? 2));

  if (!isLrtStationCode(station)) {
    return { ok: false, error: "参数 station 须为本库轻轨站码（LRT-*）", status: 400 };
  }
  if (!isLrtLineCode(route) || !LRT_LINE_TO_ROUTE_NO[route]) {
    return { ok: false, error: "参数 route 须为本库轻轨线路码（LRT-*线）", status: 400 };
  }
  if (dest && !isLrtStationCode(dest)) {
    return { ok: false, error: "参数 dest 须为本库轻轨站码（LRT-*）", status: 400 };
  }
  if (!dest && !dirParam) {
    return { ok: false, error: "缺少 dest 或 dir", status: 400 };
  }
  const routeNo = LRT_LINE_TO_ROUTE_NO[route];
  const pre = input.pre ?? null;

  try {
    // 1) 线路站序（本库码，按 dsat_dir 分组）→ 乘车方向 & 终点站
    //    ⚠️ pre 存在时从内存索引取（键 `${lineCode}|${dsatDir}`）—— 0 次 DB 往返
    const dirStops: Record<string, string[]> = {};
    if (pre) {
      const prefix = `${route}|`;
      for (const [k, v] of pre.dirStops) {
        if (k.startsWith(prefix)) dirStops[k.slice(prefix.length)] = v;
      }
    } else {
      const stopsRes = await pool.query(
        `SELECT rs.dsat_dir, rs.station_code
         FROM route_stations rs
         JOIN routes r ON r.id = rs.route_id
         WHERE r.code = $1 AND r.kind = 'lrt'
         ORDER BY rs.dsat_dir, rs.seq`,
        [route],
      );
      for (const row of stopsRes.rows as { dsat_dir: string; station_code: string }[]) {
        (dirStops[row.dsat_dir] ??= []).push(row.station_code);
      }
    }
    const dirs = Object.keys(dirStops);
    if (dirs.length === 0) {
      return { ok: false, error: "线路站序缺失（route_stations 未同步？）", status: 500 };
    }
    const dir = dest ? directionOfTravel(dirStops, station, dest, dirParam ?? "0") : (dirParam ?? "0");
    const terminusDb = dirStops[dir]?.[(dirStops[dir]?.length ?? 0) - 1];
    if (!terminusDb) {
      return { ok: false, error: `方向 ${dir} 无站序`, status: 500 };
    }

    // 2) 上车站 & 方向终点 → motransportinfo 站码（API 码只在服务端内部）
    let stationApi: string | undefined;
    let termRow: { api_id?: string; name_tc?: string } | undefined;
    if (pre) {
      stationApi = pre.apiIdOf.get(station);
      termRow = { api_id: pre.apiIdOf.get(terminusDb), name_tc: pre.nameOf.get(terminusDb) };
    } else {
      const stRes = await pool.query(`SELECT api_id FROM lrt_api_stations WHERE db_code = $1`, [station]);
      const termRes = await pool.query(`SELECT api_id, name_tc FROM lrt_api_stations WHERE db_code = $1`, [
        terminusDb,
      ]);
      stationApi = (stRes.rows[0] as { api_id?: string } | undefined)?.api_id;
      termRow = termRes.rows[0] as { api_id?: string; name_tc?: string } | undefined;
    }
    if (!stationApi || !termRow?.api_id) {
      return { ok: false, error: "站点映射缺失（lrt_api_stations）", status: 500 };
    }
    const directionApi = termRow.api_id;
    const directionName = destLabelOf(termRow.name_tc);

    // 3) 班别：今日 + 昨日（昨日仅用于跨午夜续班，班别各自按日判定）
    const nowMsRef = input.nowMs ?? Date.now();
    const now = macauNowParts(new Date(nowMsRef));
    const prevYmd = shiftYmd(now.ymd, -1);
    const prevWeekday = new Date(`${prevYmd}T00:00:00Z`).getUTCDay();
    let dayType: DayType;
    let prevDayType: DayType;
    if (pre) {
      dayType = dayTypeOf(now.weekday, pre.holidays.has(now.ymd));
      prevDayType = dayTypeOf(prevWeekday, pre.holidays.has(prevYmd));
    } else {
      const holRes = await pool.query(`SELECT 1 FROM lrt_holidays WHERE holiday_date = $1`, [now.ymd]);
      dayType = dayTypeOf(now.weekday, (holRes.rowCount ?? 0) > 0);
      const prevHol = await pool.query(`SELECT 1 FROM lrt_holidays WHERE holiday_date = $1`, [prevYmd]);
      prevDayType = dayTypeOf(prevWeekday, (prevHol.rowCount ?? 0) > 0);
    }

    // 4) 时刻行（今日 + 昨日跨午夜续班）
    let todayRow: LrtTimetableMinutes | undefined;
    let prevRow: LrtTimetableMinutes | undefined;
    if (pre) {
      todayRow = pre.tt.get(lrtTtKey(stationApi, routeNo, directionApi, dayType));
      prevRow = pre.tt.get(lrtTtKey(stationApi, routeNo, directionApi, prevDayType));
    } else {
      const rowSql = `SELECT first_min, last_min, minutes FROM lrt_timetables
                      WHERE api_station = $1 AND route_no = $2 AND direction = $3 AND day_type = $4`;
      const [todayRes, prevRes] = await Promise.all([
        pool.query(rowSql, [stationApi, routeNo, directionApi, dayType]),
        pool.query(rowSql, [stationApi, routeNo, directionApi, prevDayType]),
      ]);
      todayRow = todayRes.rows[0] as LrtTimetableMinutes | undefined;
      prevRow = prevRes.rows[0] as LrtTimetableMinutes | undefined;
    }

    // ★ v3.2.0：偏差索引 + 模式查表函数（pre 走内存；无 pre 走小查询，新表不存在 → 空索引不抛错）
    let biasIndex: BiasIndex;
    let patternLookup: (dt: DayType, depMin: number) => string | null;
    if (pre) {
      biasIndex = pre.bias;
      patternLookup = (dt, dm) =>
        routeNo === LRT_PATTERN_ROUTE_NO
          ? (pre.patterns.get(lrtPatternKey(stationApi, routeNo, directionApi, dt, dm)) ?? null)
          : null;
    } else {
      const loaded = await loadBiasAndPatterns(pool, stationApi, routeNo, directionApi);
      biasIndex = loaded.biasIndex;
      patternLookup = (dt, dm) => loaded.patterns.get(`${dt}|${dm}`) ?? null;
    }

    // 5) 合并候选（「服务日 D 00:00 起分钟偏移」单轴）→ 逐班叠加偏差 → 取后续 n 班
    //    ★ v3.2.0：候选带**原始 depMin**（模式查表键）与**所属班别**（今日/昨日行各异）；
    //      由 `fixDeparture` 统一产出 depMs/biasSec/secPrecise ⇒ 两路由 depMs 同源（AC-67）。
    const nowMs = nowMsRef;
    const dayStartUtcMs = nowMs - ((nowMs + 8 * 3_600_000) % DAY_MS); // 澳门今日 00:00
    // ★ v3.3.0（修 v3.2.0 回归）：候选须带**其所属服务日的 00:00**（`dayStartMs`）——
    //   昨日行的跨午夜续班（offset ≥ 1440）= **昨日** 00:00 + offset*60 ⇒ 落在**今日凌晨**；
    //   旧写法对昨/今两行同用「今日 00:00」⇒ 该班被**整整推迟一天**（state 由表定秒判为 running，
    //   而 departures 却给次日晨班 —— QA 于澳门 00:07 复现的「次日首班被当成 running」即此：
    //   昨日 24:09/24:15 的末班被算成「次日 00:09/00:15」而挤出 departures）。
    //   模式查表键仍用**原始** `depMin`（与 `lrt_station_patterns.dep_min` 同轴）。
    const cands: { depMin: number; dayStartMs: number; dayType: DayType }[] = [];
    if (todayRow) for (const o of rowOffsetsOf(todayRow.minutes)) cands.push({ depMin: o, dayStartMs: dayStartUtcMs, dayType });
    if (prevRow)
      for (const o of rowOffsetsOf(prevRow.minutes))
        if (o >= 1440) cands.push({ depMin: o, dayStartMs: dayStartUtcMs - DAY_MS, dayType: prevDayType });

    const selected: { tableSec: number; fix: ReturnType<typeof fixDeparture> }[] = [];
    for (const c of cands) {
      const fix = fixDeparture({
        lineCode: route,
        routeNo,
        directionApi,
        apiStation: stationApi,
        dayType: c.dayType,
        tableMin: c.depMin,
        dayStartMs: c.dayStartMs,
        pattern: patternLookup(c.dayType, c.depMin),
        biasIndex,
      });
      if (fix.depMs > nowMs) selected.push({ tableSec: c.depMin * 60, fix });
    }
    selected.sort((a, b) => a.fix.depMs - b.fix.depMs);

    const departures: LrtDepartureRow[] = [];
    for (const x of selected) {
      // 同分重复（叠加偏差后）自动折叠
      if (departures.length && x.fix.depMs === departures[departures.length - 1].depMs) continue;
      departures.push({
        clock: hhmmOf(x.tableSec + x.fix.biasSec),
        depMs: x.fix.depMs,
        secPrecise: x.fix.secPrecise,
        pattern: x.fix.pattern,
        biasSec: x.fix.biasSec,
      });
      if (departures.length >= take) break;
    }

    // 6) 空态判定
    // ★ v1.0.2 修正判定顺序：候选只取「今日 00:00 起」这条轴上的班次，**不跨日**。
    //   所以「今日首班还没到点」时，departures 里装的是**今天早上**的首班 → 旧的「先判非空」
    //   会直接给出 running，使 `before_first` 沦为**永远走不到的死代码**
    //   （而前端 `LrtEta.tsx:274` 明明实现了「首班 06:30 開出 · 往X」文案）。
    //   线上实测后果：凌晨 00:13 查石排湾线，state=running 且下一班 = 06:30 →
    //   卡片显示「还有 372 分」，门到门总用时被算成 399 分并**挤进推荐前 5**。
    //   正确优先级：① 昨日跨午夜续班仍有车 → running ② 今日首班前 → before_first
    //              ③ 今日还有后续班次 → running ④ 今日已收车 → after_last
    const prevRunning = prevRow ? rowCandidateSec(prevRow, true).some((s) => s > now.daySec) : false;
    let state: LrtDeparturesOk["state"] = "no_data";
    if (prevRunning) state = "running";
    else if (todayRow && now.daySec < todayRow.first_min * 60) state = "before_first";
    else if (departures.length > 0) state = "running";
    else if (todayRow) state = "after_last";

    return {
      ok: true,
      state,
      stationCode: station,
      lineCode: route,
      routeNo,
      dir,
      directionCode: directionApi,
      directionName,
      dayType,
      serviceDay: now.ymd,
      firstClock: todayRow ? hhmmOfMinutes(todayRow.first_min) : null,
      lastClock: todayRow ? hhmmOfMinutes(todayRow.last_min) : null,
      departures,
      serverNow: new Date(nowMs).toISOString(),
    };
  } catch (err) {
    console.error("[lrt/next-departures] 查询失败：", (err as Error).message);
    return { ok: false, error: "时刻表查询失败", status: 500 };
  }
}
