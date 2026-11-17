/**
 * R3 同卡多线纯函数对拍（`scripts/test-ride-multiroute.ts`，2026-11-17 新建）
 *
 * ── 守什么 ────────────────────────────────────────────────────────────────
 *   R3 的根因是「并行线的车从来没进过 `list`」：`fetchFrame` 只按推荐线取帧 ⇒ 用户实际上了
 *   并行线时无牌可匹配、翻候选也翻不到。修复拆成「取哪些线」「怎么合并」「怎么判跨线」三件纯事，
 *   本文件逐条钉住它们的**契约**。
 *
 * ── 为什么每条都要写反例 ──────────────────────────────────────────────────
 *   只写「该成立时成立」，无法区分「判据正确」与「判据恒真」。本文件每条主断言旁都配一条
 *   方向相反的断言（例如单线场景既断言长度 1，也断言它**不含** `parallels` 的元素）。
 *   这是本轮反复强调的那件事：**一条从不红的判据等于没写。**
 *
 * ── 边界（本文件不覆盖什么）───────────────────────────────────────────────
 *   · `loadVehicleFrame` 是 `useRideTracking` 的模块私有函数，**不为测试重构生产代码**
 *     （`fetch`/React 副作用不在纯函数射程内），故不覆盖。
 *   · 不覆盖「某条线真的失败」的隔离行为 —— 那是调用方 `catch` 的事，本模块只处理传入的成功帧。
 *   · 不覆盖 UI 呈现（地图图标、候选列表面板）。
 *
 * ── 与生产的一致性 ────────────────────────────────────────────────────────
 *   三个函数都从 `src/lib/nav/ride-multiroute.ts` **直接 import**，测试不复制实现。
 *   （对照：`test-nav-info-consistency.ts` 里的 `deriveRow` 是复刻生产逻辑，已漂移过一次。）
 *
 * 跑法：`npm run test:ride-multiroute`
 */
import { isCrossRoute, mergeFrameVehicles, routeSetOf, type RouteFrame } from "../src/lib/nav/ride-multiroute";

interface Veh {
  plate: string;
  tag?: string;
}

const car = (plate: string, tag?: string): Veh => (tag === undefined ? { plate } : { plate, tag });

let pass = 0;
let fail = 0;
const registered: string[] = [];

function ok(id: string, label: string, cond: boolean, detail = ""): void {
  registered.push(id);
  if (cond) {
    pass++;
    console.log(`  PASS  ${id}  ${label}`);
  } else {
    fail++;
    console.error(`  FAIL  ${id}  ${label}${detail ? `  →  ${detail}` : ""}`);
  }
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main(): void {
  console.log("\n═══ R3 同卡多线：routeSetOf / mergeFrameVehicles / isCrossRoute ═══\n");

  /* ══════════════════════════════════════════════════════════════════════
   * ① routeSetOf —— 取哪些线
   * ════════════════════════════════════════════════════════════════════ */
  console.log("  ── ① routeSetOf（线路集合：去重保序 + 单线不加请求）──");
  {
    const got = routeSetOf("25", ["21A", "25X"]);
    ok(
      "A1",
      "推荐线 + 两条并行线 ⇒ 3 条，且推荐线在首位",
      eq(got, ["25", "21A", "25X"]),
      `实际 ${JSON.stringify(got)}`,
    );
    ok(
      "A2",
      "反例：并集不得把推荐线挤到后面（`got[0]` 必须是推荐线）",
      got[0] === "25" && got.indexOf("25") === 0,
      `首位是 ${JSON.stringify(got[0])}`,
    );
  }
  {
    const got = routeSetOf("25", ["25", "21A"]);
    ok(
      "A3",
      "并行线里含推荐线本身 ⇒ 去重后 2 条，不出现重复",
      eq(got, ["25", "21A"]) && new Set(got).size === got.length,
      `实际 ${JSON.stringify(got)}`,
    );
  }
  {
    /* R3 硬约束：单线腿必须仍只请求 1 条线 */
    const variants: Array<[string, string[] | null | undefined]> = [
      ["缺省（不传）", undefined],
      ["null", null],
      ["空数组", []],
    ];
    const lens = variants.map(([, p]) => routeSetOf("25", p).length);
    ok(
      "A4",
      "单线腿（缺省 / null / 空数组）⇒ 长度必须为 1（不给单线场景增加任何请求）",
      lens.every((n) => n === 1),
      `三种入参长度分别为 ${JSON.stringify(lens)}`,
    );
    ok(
      "A5",
      "反例：单线腿的结果**不得**包含任何并行线元素（含隐含的 undefined/空串）",
      routeSetOf("25", []).every((x) => x === "25") && routeSetOf("25", null).length === 1,
      `实际 ${JSON.stringify(routeSetOf("25", []))}`,
    );
  }
  {
    const got = routeSetOf("25", [" 21A ", "", "   ", "25X"]);
    ok(
      "A6",
      "空白串与前后空格必须被剔除/规整（`\" 21A \"` 不得被当成另一条线）",
      eq(got, ["25", "21A", "25X"]),
      `实际 ${JSON.stringify(got)}`,
    );
    ok(
      "A7",
      "反例：结果里不得出现带空格或空串的元素",
      got.every((x) => x === x.trim() && x !== ""),
      `实际 ${JSON.stringify(got)}`,
    );
  }
  {
    /* 额外：推荐线自身为空时，不应把空串塞进集合 */
    const got = routeSetOf("", ["21A"]);
    ok(
      "A8",
      "推荐线为空串 ⇒ 被剔除，只留并行线（不得出现空元素）",
      eq(got, ["21A"]),
      `实际 ${JSON.stringify(got)}`,
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ② mergeFrameVehicles —— 怎么合并
   * ════════════════════════════════════════════════════════════════════ */
  console.log("\n  ── ② mergeFrameVehicles（合并 + 按车牌去重 + 推荐线优先）──");
  {
    const frames: RouteFrame<Veh>[] = [
      { route: "25", vehicles: [car("AA01"), car("AA02")] },
      { route: "21A", vehicles: [car("BB01"), car("BB02")] },
    ];
    const got = mergeFrameVehicles("25", frames);
    ok(
      "B1",
      "两线各 2 台、车牌不重叠 ⇒ 合并后 4 台",
      got.length === 4,
      `实际 ${got.length} 台：${JSON.stringify(got.map((v) => v.plate))}`,
    );
    ok(
      "B2",
      "反例：4 台必须都有 route 标签，且集合是 {25, 21A}（不得丢标签或全标成一条线）",
      got.every((v) => v.route === "25" || v.route === "21A") &&
        new Set(got.map((v) => v.route)).size === 2,
      `实际标签 ${JSON.stringify(got.map((v) => v.route))}`,
    );
  }
  {
    /* 多线路共用车辆：同一车牌出现在两条线 */
    const frames: RouteFrame<Veh>[] = [
      { route: "25", vehicles: [car("SHARED", "rec")] },
      { route: "21A", vehicles: [car("SHARED", "par")] },
    ];
    const got = mergeFrameVehicles("25", frames);
    ok(
      "B3",
      "同一车牌出现在两条线 ⇒ 合并后只有 1 台（按 plate 去重）",
      got.length === 1,
      `实际 ${got.length} 台：${JSON.stringify(got.map((v) => v.plate))}`,
    );
    ok(
      "B4",
      "…且保留的是**推荐线**那条副本（route === 推荐线，tag 也是推荐线的）",
      got.length === 1 && got[0].route === "25" && got[0].tag === "rec",
      `实际 route=${JSON.stringify(got[0]?.route)} tag=${JSON.stringify(got[0]?.tag)}`,
    );
  }
  {
    /* 顺序无关：推荐线的帧排在后面，结果仍须以推荐线为准 */
    const frames: RouteFrame<Veh>[] = [
      { route: "21A", vehicles: [car("SHARED", "par")] },
      { route: "25", vehicles: [car("SHARED", "rec")] },
    ];
    const got = mergeFrameVehicles("25", frames);
    ok(
      "B5",
      "推荐线帧排在后面 ⇒ 去重结果仍取推荐线副本（不得被传入顺序决定）",
      got.length === 1 && got[0].route === "25" && got[0].tag === "rec",
      `实际 ${JSON.stringify(got)}`,
    );
    ok(
      "B6",
      "反例：结果不得因为并行线排在前就把它标成 21A",
      got.every((v) => v.route !== "21A"),
      `实际标签 ${JSON.stringify(got.map((v) => v.route))}`,
    );
  }
  {
    const frames: RouteFrame<Veh>[] = [
      { route: "25", vehicles: [] },
      { route: "21A", vehicles: [car("BB01")] },
    ];
    const got = mergeFrameVehicles("25", frames);
    ok(
      "B7",
      "某条线 vehicles 为空 ⇒ 不影响其余线，也不产生空元素",
      got.length === 1 && got[0].plate === "BB01" && got[0].route === "21A",
      `实际 ${JSON.stringify(got)}`,
    );
  }
  {
    /* 车牌空白：去重键是 trim 后的值，同一车牌只应留 1 台 */
    const frames: RouteFrame<Veh>[] = [
      { route: "25", vehicles: [car(" AA01 ")] },
      { route: "21A", vehicles: [car("AA01")] },
    ];
    const got = mergeFrameVehicles("25", frames);
    ok(
      "B8",
      "车牌仅空白不同 ⇒ 视为同一台车，只保留推荐线那份",
      got.length === 1 && got[0].route === "25",
      `实际 ${JSON.stringify(got)}`,
    );
  }

  {
    /*
     * 顺序无关性的**强形式**：整份 frames 反转后，合并结果必须逐元素相同（含顺序）。
     *
     * B5 只覆盖了「单台共用车辆」这一种情形；这条用「2 线 / 3 台 / 其中 1 台共用」的组合，
     * 断言的是**整个输出数组不变** —— 这才是"不受 frames 顺序影响"的完整命题。
     * 实现侧靠 `filter` 重排 + `seen` 去重达成本性质；若有人把重排删掉，
     * 由于输出顺序会随入参变，这条会红（B5 也会红，但 B5 只看单车，覆盖面更窄）。
     */
    const base: RouteFrame<Veh>[] = [
      { route: "25", vehicles: [car("AA01", "rec"), car("SHARED", "rec")] },
      { route: "21A", vehicles: [car("SHARED", "par"), car("BB01", "par")] },
    ];
    const reversed: RouteFrame<Veh>[] = [...base].reverse();
    const a = mergeFrameVehicles("25", base);
    const b = mergeFrameVehicles("25", reversed);
    ok(
      "B9",
      "frames 顺序反转 ⇒ 合并结果逐元素相同（顺序无关性的强形式）",
      eq(a, b) && a.length === 3,
      `正序 ${JSON.stringify(a)}；逆序 ${JSON.stringify(b)}`,
    );
    ok(
      "B10",
      "反例：两种顺序下共用车辆都必须标成推荐线，且不得出现重复车牌",
      a.every((v) => v.route === "25" || v.route === "21A") &&
        a.filter((v) => v.plate === "SHARED").every((v) => v.route === "25") &&
        new Set(a.map((v) => v.plate)).size === a.length,
      `实际 ${JSON.stringify(a.map((v) => [v.plate, v.route]))}`,
    );
  }

  /* ══════════════════════════════════════════════════════════════════════
   * ③ isCrossRoute —— 判跨线（双向）
   * ════════════════════════════════════════════════════════════════════ */
  console.log("\n  ── ③ isCrossRoute（双向 + 老帧兼容）──");
  {
    ok("C1", "不同线 ⇒ true", isCrossRoute("21A", "25") === true, `实际 ${String(isCrossRoute("21A", "25"))}`);
    ok("C2", "反例：同线 ⇒ false", isCrossRoute("25", "25") === false, `实际 ${String(isCrossRoute("25", "25"))}`);
  }
  {
    /* R3 之前的老帧没有 route 字段，必须沿用既有行为（当成同线） */
    const cases: Array<[string, string | null | undefined]> = [
      ["undefined", undefined],
      ["null", null],
      ["空串", ""],
      ["纯空格", "   "],
    ];
    const bad = cases.filter(([, v]) => isCrossRoute(v, "25") !== false);
    ok(
      "C3",
      "老帧兼容：route 为 undefined / null / 空串 / 纯空格 ⇒ 一律按同线处理（false）",
      bad.length === 0,
      `误判为跨线的入参：${bad.map(([n]) => n).join(" / ") || "（无）"}`,
    );
    ok(
      "C4",
      "反例：上述四种入参都不得被判成跨线（否则老帧会被排除出锚定/锁牌）",
      cases.every(([, v]) => isCrossRoute(v, "25") === false),
      `实际 ${JSON.stringify(cases.map(([n, v]) => [n, isCrossRoute(v, "25")]))}`,
    );
  }
  {
    ok(
      "C5",
      "两侧都带空白 ⇒ 去空白后比较（`\" 25 \"` 与 `25` 视为同线）",
      isCrossRoute(" 25 ", "25") === false,
      `实际 ${String(isCrossRoute(" 25 ", "25"))}`,
    );
  }

  /* ── 汇总 ────────────────────────────────────────────────────────────── */
  console.log(`\n═══ 合计 ${registered.length} 条：PASS ${pass} / FAIL ${fail} ═══`);
  if (registered.length !== pass + fail) {
    console.error("  FAIL  分母自证：注册数与 PASS+FAIL 不相等");
    process.exit(1);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
