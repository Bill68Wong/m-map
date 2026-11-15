/**
 * 朝向降级链门禁（scripts/test-compass-fallback.ts · ★ F3 / 2026-11-15）
 *
 * ── 它守的是什么 ──────────────────────────────────────────────────────
 *   F2 把箭头画出来了，但"画什么角度"由 F3 决定。这一段最容易错的地方，
 *   **全都在真机上"看起来没错"**，只有断言能抓住：
 *     ① **0° 不是"没有值"**：正北行进是合法航向，用 `if (!heading)` 判空会在正北失效；
 *     ② **静止时的航向是噪声**：`coords.heading` 在站着不动时给 null 或乱跳，
 *        必须靠速度门限挡掉，否则人一停箭头就自己转；
 *     ③ **"不知道"不许画成"朝北"**：正北兜底若返回 0，屏幕上就是一个恒朝北的箭头
 *        —— 用户会读成"我正朝北"。这是 P6 同款错误的复发（把不知道说成知道）；
 *     ④ **权限抛错 ≠ 用户拒绝**：Safari 在非手势栈里 throw，此时用户没看到对话框，
 *        记成"拒绝"会让正确动作（去设置里允许）被永久禁掉；
 *     ⑤ **接线漏了等于没做**：`UserFix` 丢了 `heading/speed`、宿主忘了调 `requestAccess`，
 *        代码全对但箭头永远不出现 —— 这类"沉默失效"只能靠静态钉子守住。
 *
 * ── 怎么测（不联网、不连库、不需要浏览器）──────────────────────────────
 *   · 取值口径 / 选源 / 文案：直接调用纯函数（`lib/compass/heading.ts`、`compass-note.ts`）；
 *   · 接线：读源码做文本钉子（**先剥注释**，本项目已两次被自己的注释骗过）。
 *
 * 跑法：`npm run test:compass-fallback`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fixHeadingOf, fixSpeedOf, resolveHeading, pickHeadingMode } from "../src/lib/compass/heading";
import {
  noteOfHeading,
  NOTE_HEADING_COURSE,
  NOTE_HEADING_ENABLE,
  NOTE_HEADING_NORTH,
  NOTE_HEADING_POOR,
} from "../src/components/nav/compass-note";

let pass = 0;
let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${detail ? `  — ${detail}` : ""}`);
}

const root = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
/**
 * 去掉整行注释与块注释。
 * ⚠️ 三个门禁脚本都栽过同一件事：注释里写着旧行为/反例，直接 grep 原文会把说明当代码。
 */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join("\n");

/* ══════════════════════════════════════════════════════════════════════
 * ① `coords.heading` 的取值口径
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ① fixHeadingOf：什么算『有方向』 ═══\n");

ok(fixHeadingOf(null) === null, "null ⇒ 没有（规范值：未知）");
ok(fixHeadingOf(undefined) === null, "undefined ⇒ 没有");
ok(fixHeadingOf(Number.NaN) === null, "NaN ⇒ 没有（部分 Android WebView 会给）");
ok(fixHeadingOf(Number.POSITIVE_INFINITY) === null, "Infinity ⇒ 没有");
ok(fixHeadingOf("90") === null, "字符串 '90' ⇒ 没有（不做隐式转换）");
ok(fixHeadingOf(-1) === null, "−1 ⇒ 没有（部分机型用负数表示未知）");
ok(fixHeadingOf(-0.5) === null, "−0.5 ⇒ 没有");
ok(fixHeadingOf(0) === 0, "★ 0 ⇒ 0（正北是**合法**方向，不能当空值）");
ok(fixHeadingOf(45) === 45, "45 ⇒ 45");
ok(fixHeadingOf(359.9) === 359.9, "小数原样保留（不做取整，平滑器自己处理）");
ok(fixHeadingOf(360) === 0, "360 ⇒ 0（归一化）");
ok(fixHeadingOf(720) === 0, "720 ⇒ 0");
ok(fixHeadingOf(-90) === null, "−90 ⇒ 没有（负角一律视为未知，不折成 270）");

/* ══════════════════════════════════════════════════════════════════════
 * ② `coords.speed` 的取值口径
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ② fixSpeedOf：速度口径 ═══\n");

ok(fixSpeedOf(null) === null, "null ⇒ 没有");
ok(fixSpeedOf(Number.NaN) === null, "NaN ⇒ 没有");
ok(fixSpeedOf(-1) === null, "−1 ⇒ 没有（负数物理上不存在，常被用作未知哨兵）");
ok(fixSpeedOf(0) === 0, "0 ⇒ 0（站着不动是**合法**读数，不是空值）");
ok(fixSpeedOf(1.5) === 1.5, "1.5 m/s ⇒ 1.5");

/* ══════════════════════════════════════════════════════════════════════
 * ③ 选源：罗盘 → 行进方向 → 正北
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ③ resolveHeading：画哪个角度 ═══\n");

const RH = resolveHeading;
const base = { enabled: true, compassHeading: null as number | null, quality: "invalid" as const, courseDeg: null as number | null, speedMps: null as number | null };

ok(RH({ ...base, enabled: false, compassHeading: 90, quality: "ok" }).heading === null, "非步行态：即使罗盘有值也**不画**");
ok(RH({ ...base, enabled: false }).mode === "north", "非步行态：来源记 north（观测钩子读它）");

{
  const r = RH({ ...base, compassHeading: 123, quality: "ok" });
  ok(r.mode === "compass", "罗盘 ok ⇒ 用罗盘");
  ok(r.heading === 123, "罗盘 ok ⇒ 角度就是罗盘值");
}
{
  const r = RH({ ...base, compassHeading: 123, quality: "ok", courseDeg: 250, speedMps: 3 });
  ok(r.mode === "compass" && r.heading === 123, "罗盘 ok 时**优先于**行进方向（行进方向只是替补）");
}
{
  const r = RH({ ...base, compassHeading: 200, quality: "poor", courseDeg: 30, speedMps: 2 });
  ok(r.mode === "course" && r.heading === 30, "罗盘 poor + 行进中 ⇒ 用行进方向");
}
{
  const r = RH({ ...base, compassHeading: null, quality: "invalid", courseDeg: 30, speedMps: 0.4 });
  ok(r.mode === "north" && r.heading === null, "★ 行进方向但速度 0.4 < 1.2 ⇒ **不画**（静止航向是噪声）");
}
{
  const r = RH({ ...base, courseDeg: 10, speedMps: null });
  ok(r.mode === "north" && r.heading === null, "有航向但不知道速度 ⇒ 不画（不敢假定在走）");
}
{
  const r = RH({ ...base, courseDeg: 0, speedMps: 2 });
  ok(r.mode === "course" && r.heading === 0, "★ 正北行进（航向 0）⇒ 画 0，不是『没有』");
}
{
  const r = RH({ ...base });
  ok(r.mode === "north" && r.heading === null, "★ 全无来源 ⇒ north 且 heading 为 null（**绝不返回 0**）");
}
{
  const r = RH({ ...base, compassHeading: 88, quality: "invalid" });
  ok(r.heading === null, "罗盘质量 invalid ⇒ 不画（有读数但不可信，等于没有）");
}
{
  /** 与 `pickHeadingMode` 的既有契约必须一致（两层不能各说一套） */
  const cases = [
    { compassHeading: 12, quality: "ok" as const, courseDeg: null, speedMps: null },
    { compassHeading: null, quality: "invalid" as const, courseDeg: 90, speedMps: 5 },
    { compassHeading: null, quality: "invalid" as const, courseDeg: null, speedMps: null },
  ];
  const same = cases.every(
    (c) => pickHeadingMode(c) === RH({ ...base, ...c }).mode,
  );
  ok(same, "resolveHeading 的 mode 与 pickHeadingMode 完全一致（不另立一套口径）");
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 提示文案：四种"为什么"要说得不一样
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ④ noteOfHeading：步行面板那一行小字 ═══\n");

const noteBase = { enabled: true, mode: "north" as const, status: "idle" as const, needsGesture: false };

ok(noteOfHeading({ ...noteBase, enabled: false }) === null, "非步行态 ⇒ 不出字");
ok(
  noteOfHeading({ ...noteBase, status: "listening", mode: "compass" }) === null,
  "罗盘正常 ⇒ 不出字（不加噪音）",
);
{
  const n = noteOfHeading({ ...noteBase, needsGesture: true, status: "idle" });
  ok(!!n && n.action === "enable", "iOS 未授权 ⇒ 给可点入口（action=enable）");
  ok(!!n && n.text === NOTE_HEADING_ENABLE, "iOS 未授权 ⇒ 文案 = 开启提示");
}
{
  const n = noteOfHeading({ ...noteBase, needsGesture: true, status: "needs_permission" });
  ok(!!n && n.action === "enable", "手势栈失败 ⇒ 仍给可点入口（不是死路）");
}
{
  const n = noteOfHeading({ ...noteBase, status: "denied" });
  ok(!!n && n.action === null, "被拒绝 ⇒ 只说明、**不再给入口**（不反复申请）");
  ok(!!n && n.text === NOTE_HEADING_NORTH, "被拒绝 ⇒ 文案 = 按正北");
}
ok(
  !!noteOfHeading({ ...noteBase, status: "unsupported" })?.text.includes("正北"),
  "无传感器 ⇒ 说明按正北",
);
{
  const n = noteOfHeading({ ...noteBase, status: "poor", mode: "north" });
  ok(!!n && n.text === NOTE_HEADING_POOR, "质量差 ⇒ 说「读数不稳」，不是「没有」");
  ok(!!n && n.text.includes("正北"), "质量差 ⇒ 同时说清正在用正北兜底");
}
{
  const n = noteOfHeading({ ...noteBase, status: "listening", mode: "course" });
  ok(!!n && n.text === NOTE_HEADING_COURSE, "用行进方向 ⇒ 必须解释（它是「往哪走」不是「朝哪看」）");
  ok(!!n && n.text.includes("行进方向"), "用行进方向 ⇒ 文案点到「行进方向」");
}
{
  /**
   * ★ 2026-11-15 浏览器实测抓到的自相矛盾（第一版判定顺序写反了）：
   *   箭头跟着行进方向转，下面却写「方向暂时读不到 · 按正北」。
   *   ⇒ 判据必须以「箭头现在在用什么」优先，传感器状态其次。
   */
  const n = noteOfHeading({ ...noteBase, status: "unsupported", mode: "course" });
  ok(
    !!n && n.text === NOTE_HEADING_COURSE,
    "★ 用行进方向时，即使罗盘 unsupported 也只能说「行进方向」（不许说「读不到」）",
  );
  const n2 = noteOfHeading({ ...noteBase, status: "denied", mode: "course" });
  ok(!!n2 && n2.text === NOTE_HEADING_COURSE, "被拒绝但仍在用行进方向 ⇒ 还是说「行进方向」");
}
{
  const all = [NOTE_HEADING_ENABLE, NOTE_HEADING_NORTH, NOTE_HEADING_POOR, NOTE_HEADING_COURSE];
  ok(new Set(all).size === 4, "四条文案互不相同（避免四种原因说成同一句）");
  const banned = ["失败", "异常", "错误", "系统", "未知", "N/A"];
  ok(
    !all.some((t) => banned.some((w) => t.includes(w))),
    "文案不含甩锅/无信息词（失败 / 异常 / 错误 / 系统 / 未知）",
  );
  ok(all.every((t) => t.length >= 6 && t.length <= 24), "文案长度在 6~24 字（一行放得下）");
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 静态钉子：接线漏了 = 功能静默失效
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n═══ ⑤ 接线钉子（源码）═══\n");

const useFixCode = codeOnly(read("src/components/nav/useUserFix.ts"));
ok(/heading:\s*fixHeadingOf\(c\.heading\)/.test(useFixCode), "useUserFix 把 coords.heading 收敛后带出（不是丢弃）");
ok(/speed:\s*fixSpeedOf\(c\.speed\)/.test(useFixCode), "useUserFix 把 coords.speed 收敛后带出");
ok(/heading\?:\s*number\s*\|\s*null/.test(read("src/components/nav/useUserFix.ts")), "UserFix 的 heading 是可选字段（乘车投影点没有方向）");

const compassCode = codeOnly(read("src/components/nav/useCompassHeading.ts"));
ok(
  (compassCode.match(/requestPermission\(\)/g) ?? []).length === 1,
  "requestPermission() 在整个 hook 里只有一处调用（就是 requestAccess，没有第三方偷偷申请）",
);
ok(
  compassCode.indexOf("requestPermission()") > compassCode.indexOf("const requestAccess"),
  "那一处调用必须在 requestAccess 内（写在外面 = 自动弹框）",
);
ok(!/catch\s*\{[\s\S]{0,160}setStatus\("denied"\)/.test(compassCode), "★ 申请抛错不再记成『用户拒绝』");
ok(/setStatus\("needs_permission"\)/.test(compassCode), "申请抛错记 needs_permission（仍可再试一次）");
ok(/grantedInSession/.test(compassCode), "已授权过本会话 ⇒ 允许自动开始（不必每次都要手势）");
ok(
  /mustGesture\s*&&\s*!grantedInSession\)\s*return;/.test(compassCode),
  "有 requestPermission 且未授权 ⇒ 自动路径**必须收手**（不在无手势时申请）",
);

const shellCode = codeOnly(read("src/components/nav/NavShell.tsx"));
ok(/userHeading=\{headingR\.heading\}/.test(shellCode), "NavShell 把朝向传给 NavMap（不传 = 箭头永远不出现）");
ok(/useUserHeading\(\{\s*enabled:\s*headingOn/.test(shellCode), "NavShell 用合成 hook 取朝向");
ok(
  /headingOn\s*=\s*walkActive\s*\|\|\s*!!walkOnly/.test(shellCode) && /enabled:\s*headingOn/.test(shellCode),
  "只在步行态开传感器（坐车时白烧电没有意义）",
);
ok(
  /onStart:[\s\S]{0,200}requestHeadingAccess\(\)/.test(shellCode),
  "『开始导航』在用户手势里申请方向权限（iOS 唯一可行时机）",
);
ok(
  /const startWalkOnly[\s\S]{0,400}requestHeadingAccess\(\)/.test(shellCode),
  "『开始步行』同样在手势里申请",
);
ok(/requestHeadingAccess\s*=\s*headingR\.requestAccess/.test(shellCode), "requestAccess 被单独取出（否则两个回调每帧重建）");
ok(/onEnableHeading=\{/.test(shellCode), "步行面板的『点此开启』接回宿主");

const paneCode = codeOnly(read("src/components/walk/WalkOnlyPane.tsx"));
ok(/data-heading-note="enable"/.test(paneCode), "可点入口在 DOM 上可观测（QA 能区分出的是按钮还是文字）");
ok(/headingNote\.action === "enable"/.test(paneCode), "只有 action=enable 才渲染成按钮");
ok(!/requestPermission|DeviceOrientationEvent/.test(paneCode), "面板自己**不碰**传感器 API（权限只由 hook 管）");

const sheetCode = codeOnly(read("src/components/nav/RouteSheet.tsx"));
ok(/headingNote=\{walkOnly\.headingNote/.test(sheetCode), "RouteSheet 把说明透传给步行面板");
ok(/onEnableHeading=\{onEnableHeading\}/.test(sheetCode), "RouteSheet 透传开启回调");

const userHeadingCode = codeOnly(read("src/components/nav/useUserHeading.ts"));
ok(!/requestPermission/.test(userHeadingCode), "合成层不直接碰权限 API（只在 useCompassHeading 里）");
ok(/data-heading-src/.test(userHeadingCode), "来源写进观测钩子 data-heading-src（只写来源、不写角度）");
ok(!/setInterval/.test(userHeadingCode), "不额外起定时器（传感器事件驱动）");

/* ══════════════════════════════════════════════════════════════════════ */
console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 有失败"}：pass=${pass} fail=${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
