/**
 * README 版本号自动同步（`scripts/sync-readme-version.ts`，2026-11-17 新建）
 *
 * ── 这个文件解决什么 ────────────────────────────────────────────────────
 *   README 第 105 行长期手写版本号：
 *     `当前版本 **v<!-- app-version -->4.2.1<!-- /app-version -->**。`
 *   每次发版都要靠人提醒我去改 ⇒ 迟早漏，而漏了的后果是**对外文档撒谎**
 *   （README 说 v4.2.1，实际装的是别的版本）。需求原话是
 *   「有没有办法自动更新，不然我每次都要提醒你」——
 *   所以目标不是「记得改」，而是**让过期版本推不出去**。
 *
 * ── 分工（谁拦谁）────────────────────────────────────────────────────────
 *   · 本文件（`npm run docs:sync-version`）= **修**：把标记区间的数字换成
 *     `package.json` 的 `version`。幂等（同步过就一字不改）。
 *   · `scripts/test-readme-version.ts`（`npm run test:readme-version`）= **拦**：
 *     已挂进 `npm run verify` 链，不一致就整条链红。
 *   · `package.json` 的 `postversion` 钩子 = **顺手**：`npm version x.y.z`
 *     打完 tag 自动同步，不用记得。
 *   刻意**不加 `prebuild`**：Vercel 构建期也会跑 `npm run build`，
 *   在构建阶段改一个被 git 跟踪的文件既无意义（构建产物不影响仓库）
 *   又有只读 FS 风险（构建容器里写源码目录可能直接 EROFS 失败）。
 *   拦的职责由门禁承担，构建不该有副作用。
 *
 * ── 为什么「命中次数必须恰好 1」而不是「有就替换」────────────────────────
 *   0 处 = 标记被人删了/写错了，此时**默默跳过**会让版本从此永久冻结
 *   （最坏的失败形态：不报错、不更新、没人发现）。
 *   ≥2 处 = 不知道该改哪一处，猜错就是改到别的地方。
 *   两种都 `throw`，让调用方炸掉而不是猜。
 *
 * ── 为什么不吞掉 `v` 和 `**` ────────────────────────────────────────────
 *   它们在标记**外面**（`**v` + 起始标记 + 版本号 + 结束标记 + `**`）。
 *   正则只吃「起始标记 … 结束标记」这一截，替换串也只吐这一截，
 *   所以 `v` 与 `**` 天然不进入匹配区间 —— 第 5 条断言就是钉这个。
 *
 * ── 跑法 ────────────────────────────────────────────────────────────────
 *   npm run docs:sync-version            # 写入（幂等）
 *   npm run docs:sync-version -- --check # 只比对，不一致 exit 1（供 CI / 上游门禁用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根：按本文件位置推算，不依赖 cwd（谁从哪个目录调都指向同一个 README） */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README_PATH = path.join(ROOT, "README.md");
const PKG_PATH = path.join(ROOT, "package.json");

const OPEN = "<!-- app-version -->";
const CLOSE = "<!-- /app-version -->";
const REPAIR = "npm run docs:sync-version";

/**
 * 把 `content` 里唯一一处 `app-version` 标记区间的版本号换成 `version`。
 *
 * 纯函数：不读文件、不写文件、不读环境变量 ⇒ 可被单测直接喂字符串。
 * 正则在本函数**内部**构造（不是模块级带 `g` 的常量），
 * 避免 `lastIndex` 跨调用残留导致的「第一次对、第二次漏」。
 *
 * @throws 标记命中 0 处或 ≥2 处时抛错（错误文案含「标记」与实际命中数）
 */
export function applyVersion(content: string, version: string): string {
  if (!version.trim()) {
    // 空版本会写出 `**v<!-- app-version --><!-- /app-version -->**`（README 直接残废），
    // 比抛错更难发现 ⇒ 前置拦掉，而不是默默写进去。
    throw new Error("版本号为空，拒绝写入 README");
  }

  const re = new RegExp(`${OPEN}[\\s\\S]*?${CLOSE}`, "g");
  const hits = content.match(re) ?? [];
  if (hits.length !== 1) {
    throw new Error(
      `README 的 app-version 标记必须恰好命中 1 处，实际命中 ${hits.length} 处。` +
        `请确认文件里只有一对完整的「${OPEN} … ${CLOSE}」标记：` +
        `0 处会让版本永久冻结（不报错、不更新，最难发现）；≥2 处则无法判断该改哪一处（拒绝猜测）。`,
    );
  }

  // 用函数式替换而不是模板串：版本号里若出现 `$&` / `$1` 这类字符，
  // 字符串形式会被当成替换模式解析，函数形式则原样写入。
  return content.replace(re, () => `${OPEN}${version}${CLOSE}`);
}

/** 从标记区间里抽出当前写的版本号（仅用于把报错信息说得更具体） */
function readMarkedVersion(content: string): string | null {
  const m = content.match(new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`));
  return m ? m[1] : null;
}

function main(): void {
  const checkOnly = process.argv.includes("--check");

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8")) as { version?: string };
  const version = pkg.version;
  if (!version) {
    console.error(`FAIL  读不到 ${path.relative(ROOT, PKG_PATH)} 的 version 字段`);
    process.exit(1);
  }

  const before = fs.readFileSync(README_PATH, "utf8");
  const after = applyVersion(before, version);

  if (after === before) {
    // 幂等出口：同步过就一分不改（也不重写文件，连 mtime 都不动）
    console.log(`OK    README 已是 v${version}，无改动`);
    process.exit(0);
  }

  const marked = readMarkedVersion(before);

  if (checkOnly) {
    console.error(`FAIL  README 版本与 package.json 不一致`);
    console.error(`      README 标记区间 = ${marked === null ? "(读不到)" : marked}`);
    console.error(`      package.json   = ${version}`);
    console.error(`      修复：${REPAIR}`);
    process.exit(1);
  }

  fs.writeFileSync(README_PATH, after, "utf8");
  console.log(`OK    已同步 README：v${marked === null ? "?" : marked} → v${version}`);
}

// 仅在作为入口直接运行时执行（被 test-readme-version.ts import 拿纯函数时不跑）
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
