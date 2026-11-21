"use client";

/**
 * 地图长断线自愈（R8）—— **判定与预算的纯逻辑**（src/components/nav/map-recover.ts，2026-11-21）
 *
 * ── 这个文件只放三样东西 ──────────────────────────────────────────────────────
 *   ① 常量（全部来自需求原文，改之前先看对应条款）；
 *   ② `probeMap()` —— 「对象是否还活着」的**探针**（只读 DOM，不改任何东西）；
 *   ③ 预算与裁决的纯函数（`readBudget` / `canAutoRebuild` / `afterSoftAction`）。
 *   真正的 DOM 操作（destroy / new AMap.Map / resize / setZoom）留在 `NavMap.tsx`，
 *   因为那部分无法纯化，硬塞进来只会让"可测的那半"被不可测的那半污染。
 *
 * ── 判据的可靠性分级（R8-A，按需求给的顺序，不改）──────────────────────────────
 *   硬证据：① `webglcontextlost` 已收到且 `GL_LOST_GRACE_MS` 内无 `webglcontextrestored`
 *           ② canvas 不存在，或 `canvas.width/height === 0`
 *   只决定"何时去探"：③ `visibilitychange` 的 `hiddenDur`（**不参与"是否失效"判定**）
 *   自愈动作：④ `resize()` + `setZoom(getZoom())` ⇒ +300ms / +600ms 两次探针；
 *            两次都干净 ⇒ **不动实例**（只记 `soft`）；任一命中 ①② ⇒ 升级重建。
 *
 * ── ⚠️ ④ 不是"修一下试试"：它是**唯一能拿到观察的手段**（三层分工，别混着读）────────
 *   有人会问："`probeMap()` 的最后一个 return 是 `ok`（未知 ⇒ 绿），这不就是 blocklist 吗？"
 *   答案要分三层看，**混在一起才会得出"blocklist 也可以"的错误结论**：
 *
 *   Ⅰ **探针输出层 = 事实枚举**：`ok | no-container | no-canvas | zero-size | gl-lost`。
 *      这是一个**封闭集**（我们只区分这五种事实）⇒ 这一层**确实是 allowlist**：值列全了，
 *      新增一种事实就必须同时改类型、改映射、加用例。
 *   Ⅱ **事实 ⇒ 该不该重建**：这一层**不放在探针里**，交给 `afterSoftAction()` + 预算。
 *      为什么不放：AMap 的失败方式**不封闭**（我们想不完），把判断塞进探针就等于让
 *      "想不到的形态"直接决定要不要烧配额。
 *   Ⅲ **"地图是好的"无法正面证明**（R8-B 禁掉了所有正向信号：`phase==="ready"` /
 *      `mapRef!=null` / `getZoom()` 可读 / 像素采样）。⇒ 只能用一个**主动动作**
 *      （`resize()` + `setZoom(getZoom())`）去换一次"它还像不像活着"的观察。
 *
 *   ⇒ 所以 ④ 是 Ⅰ/Ⅱ 之间那道缝的补丁：**它不修，它取样。** 删掉它不会让判据更保守，
 *     只会让 R8-A① 承认的那条漏报彻底失去发现机会。
 *   ⇒ **补丁本身必须可见**：探针结论一律落 `data-map-probe` / `-reason` / `-n`
 *     （见 `NavMap.tsx` 的 `markProbe`）。否则"探了但判无事"与"根本没探"同形，
 *     补偿机制自己是哑的，等于没补 —— 这条是 data-engineer 评审时指出的真实缺口。
 *   ⇒ 推论（本模块立场）：**门禁怕假绿，运行时怕假红**。门禁（人在环、红=改代码）默认红；
 *     运行时动作（红=烧配额/重载地图/打扰用户）默认不动，**但必须配主动探测 + 落痕**。
 *     `afterSoftAction()` 里 `no-hard-evidence ⇒ none`、`no-container ⇒ none` 即此体现。
 *
 * ── 一律**不得单独**作为失效判据（R8-B，逐条抄录，别在这里"补充"新招）────────────
 *   `phase === "ready"`（故障时仍 ready）· `mapRef.current != null` · `map.getZoom()` 可读 ·
 *   `navigator.onLine` / `online` 事件 · 用户主观"看到白图" · 任何纯时间阈值。
 *   ⇒ 所以本文件里**没有任何** "过了 N 秒就认为坏了" 的函数。
 *
 * ── 两条禁令（R8-C）──────────────────────────────────────────────────────────
 *   ① 容器 / canvas **0 尺寸不重建**：新实例一样是 0 尺寸，只多烧一轮瓦片；
 *      正确处置 = 走布局修复 + 提示（`layout` 动作）。
 *   ② **不用像素采样**判定：WebGL 未开 `preserveDrawingBuffer` 时 `toDataURL()` 恒返空白
 *      ⇒ 假阴性 ⇒ 误重建。所以本文件里**没有**任何 canvas 取像素的代码。
 *
 * ── 观测钩子**契约**（一旦验收脚本开始读，改名 = 改接口；改前先改这张表）──────────
 *   名字                  | 取值域                                              | 谁写
 *   ----------------------|-----------------------------------------------------|------------------
 *   `data-map-probe`      | `ok`/`no-container`/`no-canvas`/`zero-size`/`gl-lost`| `NavMap.markProbe`
 *   `data-map-probe-reason`| **见下「reason 取值域」**                            | 同上（与 probe 成对写）
 *   `data-map-probe-n`    | 非负整数 = **「出了结论」的次数**（`gl-grace` 不计）   | 同上
 *   `data-map-probe-skip` | `short-hidden` / `cooldown`（探到后**自动摘除**）      | `NavMap.run`
 *   `data-map-probe-skip-at` | epoch ms；最近一次被跳过的时间（与 `-probe-at` 比先后） | 同上
 *   `data-map-diag`       | `zoom=<n|->;canvas=<n>;ctx=ok|unknown|lost;size=WxH`  | `NavMap.writeMapDiag`
 *   `data-map-gl`         | `lost` / `restored`（**只反映事件**，不等价于失效）    | WebGL 监听
 *   `data-map-recover`    | `soft` / `layout` / `rebuild` / `degrade`            | `NavMap.markRecover`
 *   `data-map-rebuild-count` | 非负整数 = 当前滑窗内已自动重建次数                | 同上
 *
 *   **reason 取值域** = `afterSoftAction()` 返回的 `reason` **全集**（本文件唯一真源），
 *   目前含 `soft-fixed` / `zero-size` / `relost-after-rebuild` / `budget` / `gap` /
 *   `cooldown` / `no-hard-evidence` / `hard-evidence`，以及 `settle()` 自加的 `gl-grace`
 *   与 `gl-grace-retry`（宽限期到点后的那次补探）。
 *   ⚠️ **透传，不另建词表**：将来新增一个 reason，这里只需加一行说明，**不需要**改任何白名单 /
 *      枚举 / 断言 —— 读的人按「非空即原因已知」处理即可。
 *   ⚠️ 全部**只写不读**：任何逻辑都不得回读这些属性（否则又造出"看着对其实假"的判据）。
 *   ⚠️ `probe` 与 `diag` **必须是两个属性**（team-lead 2026-11-21 定）：前者只在恢复路径写、
 *      后者每次地图移动写，合并会互相覆盖 —— 用户报障时往往刚拖过地图，现场快照会被顶掉。
 *
 *   ── 三值读法（**不存在 ≠ 健康**，team-lead 已采为对账标准）────────────────────
 *     `-probe` 必须按三值读：`不存在` / `ok` / `非 ok`。
 *       · 不存在 ⇒ **未知**（本次挂载从没探过）；
 *       · 只有显式 `ok` 才是"这一次探针认为正常"；
 *       · 非 ok ⇒ 有结论且异常。
 *     `-probe` 与 `-skip` 语义**正交**，并存是正常态：
 *       · `-probe` + `-skip` ⇒ 最近一次结论仍在，只是后续探针被跳过；
 *       · 只有 `-skip` 无 `-probe` ⇒ 从未出过结论（入口把尝试全拦了，需解释）。
 *
 *   ── 三个时间基准，**各自不可互推** ──────────────────────────────────────────
 *     ① `-probe*` / `-skip*` = **本次挂载**（纯内存，刷新即消失）；
 *     ② `-probe` 的**结论内容**可能早于**当前地图实例** —— 重建路径**有意不清**
 *        （"上次 gl-lost → 随后重建"正是最有用的诊断故事）。判归属用
 *        `-recover` 的动作值 + `-recover-at`：`recover=rebuild ∧ probeAt < recoverAt`
 *        ⇒ 该结论属于旧实例；`soft`/`layout` **不换实例**，不适用此判据；
 *     ③ `data-map-rebuild-count` = **本会话滑窗**（`sessionStorage`，刷新保留）。
 *     ⇒ 刷新后读到「`rebuild-count=2` / `probe-n=0`」是**正常态**，不是矛盾。
 *
 *   ── 示例（把上面几条串起来的现场；比参数说明省事，读验收先看这两行）─────────────
 *     ① **首帧即 gl 丢失、未到 30s 宽限**：
 *        `-probe=gl-lost -reason=gl-grace -n=0 -skip=(无)`
 *        有结论但 `n=0` 是**合法**的（`n` 只数"出结论"的次数，`gl-grace` 不计）。
 *     ② **重建之后最常见的现场**（比 ① 常见得多，也最容易被误读成"还在丢上下文"）：
 *        ```
 *        -recover=rebuild   -recover-at=T1
 *        -probe=gl-lost     -probe-at=T0   (< T1)   ← 旧实例的结论
 *        -skip=cooldown     -skip-at=T2    (> T1)   ← 当前实例被 30s 静默期挡了一次
 *        ```
 *        读法：**结论是旧的、当前实例还没被探过、最近一次尝试被冷却挡了**。
 *        之所以必然如此：`rebuild` 后 `bumpBudget` 把 `lastAt=now`，下一次 `visible`
 *        一定落进 30s 冷却 ⇒ 先撞上 `markProbeSkip("cooldown")`。
 *        **只看 `-probe` 会把这一格误判成"重建没修好"** —— 这是 `-skip-at` 与
 *        `-recover-at` 必须**成对**存在的理由：单有任一个都读不出这行。
 *
 *   ── 一个**有意不做**的扩展（留档，免得后人重新发明）───────────────────────────
 *     曾有提议加 `-attempts` / `-skips` 计数器来判断"跳过比例"。**不做**，理由是凑不出
 *     闭合等式：一次 `run()` 尝试有三种去向 ——
 *       `attempts = n（出结论） + g（gl-grace 观察） + skips（被跳过）`
 *     而 `g` 因"不污染 `-n`"的设计**没有计数器** ⇒ 只做两个计数器最紧也只能写
 *     `attempts ≥ n + skips`（**恒真、永远不红**，等于没约束），而它更会诱导后人写
 *     `attempts - skips == n` 这种**看起来闭合、实际漏了 g** 的断言 —— 比没有仪表更坏。
 *     ⇒ 要做就 `attempts` / `skips` / `graces` **三件一起做**；只做半套即是"没有分母的阈值"。
 */

/* ══════════════════════════════════════════════════════════════════════════
   一、常量（R8-D 预算）
   ⚠️ 高德 JS API 2.0 的配额口径**本地无文档**（R8-F 明确标【待确认】）⇒ 全部按最坏情况
      （按地图加载/瓦片计次）取值，宁可少重建也不要把配额烧穿。
   ══════════════════════════════════════════════════════════════════════════ */

/** 同一滑窗内最多**自动**重建次数（第 3 次起只给占位 + 人工按钮） */
export const REBUILD_MAX = 2;
/** 两次自动重建的最小间隔（10 分钟） */
export const REBUILD_MIN_GAP_MS = 10 * 60_000;
/**
 * 重建后的**全静默**冷却：这期间**连探针都不跑**。
 * ⚠️ 与 `REBUILD_MIN_GAP_MS` 不是同一件事、也不能合并：
 *    · 前者管"两次重建之间至少隔多久"（防连坐）；
 *    · 本常量管"刚重建完别去打扰它"（新实例还在拉瓦片，此时 resize/setZoom 只会帮倒忙）。
 */
export const REBUILD_COOLDOWN_MS = 30_000;
/** `contextlost` 之后等 `restored` 的宽限期；超时仍未恢复 = 硬证据 */
export const GL_LOST_GRACE_MS = 30_000;
/** 后台驻留多久才值得去探（只决定"何时探"，不决定"是否失效"——见 R8-A③） */
export const HIDDEN_MIN_MS = 60_000;
/** 重建后多久内又 `contextlost` ⇒ **停自动**、降级占位（不再试第 3 次） */
export const POST_REBUILD_RELOST_MS = 60_000;
/** 预算滑窗长度（30 分钟） */
export const BUDGET_WINDOW_MS = 30 * 60_000;
/** 轻修后的两个探点（ms，相对轻修发起时刻） */
export const SOFT_PROBE_MS = [300, 600] as const;

/**
 * sessionStorage 键。
 * ★ 为什么一定要落盘而不是内存计数：内存计数会被**用户手动刷新**清零，
 *   而刷新本身已经花掉一次地图加载（= 配额已经付过一次）⇒ 内存计数等于"刷新即可无限重试"，
 *   正好绕过整个预算。
 */
export const BUDGET_KEY = "mmap.mapRebuild";

/* ══════════════════════════════════════════════════════════════════════════
   二、探针（R8-A ①②）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 探针结论。**顺序即优先级**（见 `probeMap` 里的返回顺序）：
 *   `zero-size` 必须**先于** `gl-lost` 返回 —— 因为 0 尺寸是"禁止重建"的硬禁令（R8-C①），
 *   而 gl-lost 是"可以重建"的证据；两者同时成立时，取禁令。
 */
export type ProbeKind = "ok" | "no-container" | "no-canvas" | "zero-size" | "gl-lost";

/**
 * 「地图是不是还活着」的探针 —— **只读 DOM**。
 *
 * @param container `.nav-map__canvas`（`new AMap.Map()` 的宿主，canvas 都是它的子节点）
 * @param glLost    调用方维护的 WebGL 上下文标记（`contextlost` 已收且宽限期内未见 `restored`）
 *
 * ⚠️ 不要在这里加 `map.getZoom() != null` 之类的"可用性"判断：R8-B 明确它是**无效信号**
 *    （实例坏掉时这些读值照样正常返回）。本函数只认 DOM 事实。
 */
export function probeMap(container: HTMLElement | null, glLost: boolean): ProbeKind {
  if (!container) return "no-container";
  let list: HTMLCanvasElement[] = [];
  try {
    list = Array.from(container.querySelectorAll("canvas"));
  } catch {
    return "no-container";
  }
  if (list.length === 0) return "no-canvas";
  // ② 任一张 canvas 的绘制缓冲为 0 ⇒ 硬事实，且**禁止重建**（R8-C①）
  for (const c of list) {
    if (!c.width || !c.height) return "zero-size";
  }
  // ① 上下文丢了且未恢复（调用方已按 GL_LOST_GRACE_MS 判过期）
  if (glLost) return "gl-lost";
  return "ok";
}

/** 是否"必须重建"级别的硬证据（`zero-size` 单独处理，因为它禁止重建） */
export function isHardEvidence(p: ProbeKind): boolean {
  return p === "no-canvas" || p === "gl-lost";
}

/** 0 尺寸（R8-C①：**不许重建**，只能修布局 + 提示） */
export function isZeroSize(p: ProbeKind): boolean {
  return p === "zero-size";
}

/* ══════════════════════════════════════════════════════════════════════════
   三、预算（R8-D）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 会话预算。
 * ⚠️ 字段比需求文字多一个 `lastAt`：需求写的是 `{count, windowStart}`，但同一段里还要求
 *    「两次 ≥10 分钟」与「重建后 30s 冷却」—— 没有时间戳这两条**无法实现**。
 *    故扩展一个字段；读旧数据时缺 `lastAt` 按 `null` 处理（向后兼容，不做数据迁移）。
 */
export interface Budget {
  count: number;
  windowStart: number;
  lastAt: number | null;
}

export function emptyBudget(now: number): Budget {
  return { count: 0, windowStart: now, lastAt: null };
}

/**
 * 把任意来源的值规范成合法 `Budget`，并**处理滑窗**：
 *   · 类型不对 / 缺字段 ⇒ 当 0 次（空预算）；
 *   · `windowStart` 早于 `BUDGET_WINDOW_MS` ⇒ 归零重开窗口，但**保留 `lastAt`**
 *     （冷却判定跨窗口仍然有效，否则"刚重建完就跨窗"会让冷却失效）。
 */
export function normalizeBudget(raw: unknown, now: number): Budget {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<Budget>;
  const count = typeof o.count === "number" && Number.isFinite(o.count) && o.count > 0 ? Math.floor(o.count) : 0;
  const windowStart =
    typeof o.windowStart === "number" && Number.isFinite(o.windowStart) && o.windowStart > 0 ? o.windowStart : now;
  const lastAt = typeof o.lastAt === "number" && Number.isFinite(o.lastAt) && o.lastAt > 0 ? o.lastAt : null;
  if (now - windowStart >= BUDGET_WINDOW_MS) return { count: 0, windowStart: now, lastAt };
  return { count, windowStart, lastAt };
}

/** 读预算（`sessionStorage` 不可用 ⇒ 空预算，绝不让存储异常打断地图） */
export function readBudget(now: number): Budget {
  try {
    if (typeof window === "undefined") return emptyBudget(now);
    const s = window.sessionStorage.getItem(BUDGET_KEY);
    if (!s) return emptyBudget(now);
    return normalizeBudget(JSON.parse(s), now);
  } catch {
    return emptyBudget(now);
  }
}

/** 写预算（异常吞掉：写不进去最多是"这次不算数"，比崩掉好） */
export function writeBudget(b: Budget): void {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(BUDGET_KEY, JSON.stringify(b));
  } catch {
    /* sessionStorage 满 / 隐私模式 ⇒ 放弃记账，不阻塞恢复流程 */
  }
}

/** 记一次「已自动重建」并落盘 */
export function bumpBudget(b: Budget, now: number): Budget {
  const next: Budget = { count: b.count + 1, windowStart: b.windowStart, lastAt: now };
  writeBudget(next);
  return next;
}

/**
 * 重建后的全静默期（这期间连探针都不跑）。
 * 注意 `>=` 边界：恰好 30000ms 视为已过冷却（避免"多等一帧"的错觉）。
 */
export function inCooldown(b: Budget, now: number): boolean {
  return b.lastAt != null && now - b.lastAt < REBUILD_COOLDOWN_MS;
}

export type GateReason = "budget" | "gap" | "cooldown";

/**
 * 能不能**自动**重建。
 * 三条独立闸门，任一不过 ⇒ 不再自动重建（`degrade` 到占位 + 人工按钮）：
 *   · `budget`   —— 本滑窗已用满 `REBUILD_MAX` 次；
 *   · `gap`      —— 距上次重建不足 `REBUILD_MIN_GAP_MS`；
 *   · `cooldown` —— 距上次重建不足 `REBUILD_COOLDOWN_MS`（被 `gap` 蕴含，单独列出只为
 *                   让日志能说清是哪一条挡的；将来若把 gap 调小到比 cooldown 还短，这条就活了）。
 */
export function canAutoRebuild(b: Budget, now: number): { ok: true } | { ok: false; reason: GateReason } {
  if (b.count >= REBUILD_MAX) return { ok: false, reason: "budget" };
  if (b.lastAt != null) {
    if (now - b.lastAt < REBUILD_MIN_GAP_MS) return { ok: false, reason: "gap" };
    if (now - b.lastAt < REBUILD_COOLDOWN_MS) return { ok: false, reason: "cooldown" };
  }
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
   四、裁决（R8-A④ + C① + D「60s 内复发即停」）
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 轻修之后要做什么。
 * `none` 之外的每个动作都对应一个**明确后果**，不要在这里加"再试一次"的模糊档：
 *   · `none`    —— 轻修已自愈（两次探针都干净）⇒ **不动实例**，只记 `data-map-recover="soft"`；
 *   · `layout`  —— 0 尺寸（R8-C①）⇒ 只做 resize + 提示，**绝不重建**；
 *   · `degrade` —— 预算用尽 / 10 分钟内已重建过 / 重建后 60s 内又丢上下文 ⇒ 停自动、给占位；
 *   · `rebuild` —— 硬证据 + 闸门全过。
 */
export type RecoverAction = "none" | "layout" | "degrade" | "rebuild";

export interface Verdict {
  action: RecoverAction;
  /** 人类可读的原因（写进 `data-map-recover-src`，只用于排障，不参与任何逻辑） */
  reason: string;
}

/**
 * @param probe  轻修后**第二次**探针的结论（+600ms 那次；用最后一次代表"修完还活着吗"）
 * @param b      当前预算（**已** `normalizeBudget` 过）
 * @param now    当前时间戳
 */
export function afterSoftAction(probe: ProbeKind, b: Budget, now: number): Verdict {
  if (probe === "ok") return { action: "none", reason: "soft-fixed" };
  if (isZeroSize(probe)) return { action: "layout", reason: "zero-size" };
  // ★ R8-D 末句：重建后 60s 内又 contextlost ⇒ 停自动（新实例一上手就丢上下文 = 环境问题，
  //   再重建只是烧配额）
  if (probe === "gl-lost" && b.lastAt != null && now - b.lastAt <= POST_REBUILD_RELOST_MS) {
    return { action: "degrade", reason: "relost-after-rebuild" };
  }
  if (!isHardEvidence(probe)) return { action: "none", reason: "no-hard-evidence" };
  const gate = canAutoRebuild(b, now);
  if (!gate.ok) return { action: "degrade", reason: gate.reason };
  return { action: "rebuild", reason: "hard-evidence" };
}

/**
 * 触发入口的准入（R8-D 前半句）。
 *
 * 三条同时成立才值得去探：**入口合法** × **驻留够久** × **有硬证据**。
 * `online` 一律不触发（B 里点名过：它只说明网络，且页面隐藏时也会触发）。
 *
 * ⚠️ `hiddenMs === null`（`hiddenAt` 缺失）按**放行**处理 —— 这是对 R8-A③ 的落地：
 *   ③ 明确「hiddenDur 只决定何时去探，不决定是否失效」，而它同时说明部分机型
 *   `resume` 先到、`visibilitychange` 迟到 14s，`hiddenAt` **可能根本不存在**。
 *   若把"缺失"判成"不足 60s"，恰好会在最该自愈的机型上**永久不自愈**（静默失效）。
 *   ⇒ 缺失 = 未知 = 不拦；真正拦住重复动作的是预算与冷却，不是这个时长。
 */
export function shouldProbe(trigger: "visible" | "pageshow", hiddenMs: number | null): boolean {
  if (trigger !== "visible" && trigger !== "pageshow") return false;
  if (hiddenMs === null) return true;
  return hiddenMs >= HIDDEN_MIN_MS;
}
