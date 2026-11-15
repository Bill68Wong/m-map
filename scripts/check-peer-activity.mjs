#!/usr/bin/env node
/**
 * 推送前「合作者动态」检查（scripts/check-peer-activity.mjs）
 *
 * 目的：补上「推送前完全看不到远端已有别人 open PR」的缺口（2026-11-13 事故）。
 *       11-13 00:01 有合作者开了 PR #96，00:13 我们又开了 PR #97，两者改同一文件同一行，
 *       直到事后才发现。本脚本在推送前查询远端协作状态并给出判定。
 *
 * 与 review-push.mjs 的分工（刻意不合并）：
 *   - review-push.mjs       = 纯本地、离线可用：文件分类 / 敏感扫描 / 必要性清单。
 *   - check-peer-activity   = 需要网络：远端 main 是否前进、是否有别人 open PR、文件是否重叠。
 *   两者在 .githooks/pre-push 里串联，退出码取最严（BLOCK > CONFIRM > PASS）。
 *
 * 退出码（与 review-push.mjs 对齐）：
 *   0 = PASS（放行）
 *   1 = BLOCK（一律拒绝，PUSH_APPROVED 也不解锁）
 *   2 = CONFIRM（须人工确认，PUSH_APPROVED=1 才放行）
 *
 * 判定规则（注意 2026-11-13 实测过的 Rebase-and-merge 特例）：
 *   · 先算 behind = git rev-list --count HEAD..origin/main；
 *     behind > 0 **再**用 `git diff --quiet HEAD origin/main` 兜底。
 *     GitHub 用 Rebase and merge 后，本地提交与远端 SHA 不同但内容逐字相同，
 *     此时 behind 会是 1；只看提交数会误判「落后」。diff 为空 ⇒ 视为已同步。
 *   · 远端 main 已前进、但本地对象库里根本没有那个提交 ⇒ BLOCK（需先 fetch）。
 *   · 存在非本人 open PR 且与本批改动文件有交集 ⇒ CONFIRM，并列出交集文件。
 *   · 「待推送文件」= `git diff --name-only origin/main...HEAD`（三点：本分支引入的改动，
 *     与 PR 内容一致）。**当 diffEmpty === true（内容已等价）时置空** —— 此时本分支没有要
 *     推送的内容；不置空会把历史差异误当成本批改动，与他人 PR 产生假交集。
 *     ⚠️ 不能改成两点 `git diff HEAD origin/main`：两点在「别人刚往 main 推了新文件」时会把
 *     别人的文件也算进来，制造新的误报。只有「内容已等价」这一种情况置空，才既准确又安全。
 *   · API 调用失败（401/403/404/5xx/超时/无凭据）⇒ CONFIRM（未验证，不静默 PASS）。
 *   · 网络不可达（DNS/ECONNREFUSED 等）⇒ 仅警告并 PASS（推送本身也需要网络）。
 *
 * 凭据：通过 `git credential fill` 从凭据管理器读取，仅在进程内存中使用；
 *       不打印、不落盘、不进 argv、不使用 `curl -H`、不开启 verbose。
 *
 * 开关：PEER_CHECK_SKIP=1 跳过检查（打印醒目警告、写入报告、退出码 0）。
 * 报告：.verify/peer-activity-latest.md（该目录已 gitignore，不入库）。
 *
 * 自测：node scripts/check-peer-activity.mjs --self-test
 *       纯注入、不依赖网络与 git 状态；8 条用例全过才继续。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import https from "node:https";

const REPO = "Bill68Wong/m-map";
const REPORT = ".verify/peer-activity-latest.md";
const REQ_TIMEOUT_MS = 8000;
const TOTAL_BUDGET_MS = 20000;

const short = (s) => (typeof s === "string" ? s.slice(0, 8) : String(s));

/* ══════════════════════════════════════════════════════════════════════
 * 一、纯函数判定（可注入，供 --self-test 使用；不触碰网络与 git）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * @param {object} x
 * @param {boolean} x.skip                  PEER_CHECK_SKIP=1
 * @param {boolean} x.apiFailed             API 调用是否失败
 * @param {boolean} [x.apiUnreachable]      失败原因是否为「网络不可达」
 * @param {string}  [x.apiError]            失败描述（不含凭据）
 * @param {number}  x.behind                git rev-list --count HEAD..origin/main
 * @param {boolean} x.diffEmpty             git diff --quiet HEAD origin/main 是否为 0
 * @param {string}  x.localOriginMainSha    本地 origin/main
 * @param {string}  x.remoteMainSha         远端 main（API）
 * @param {boolean} x.remoteMainExistsLocally 本地对象库是否已有 remoteMainSha 那个提交
 * @param {string}  x.myLogin               当前账号（API /user）
 * @param {Array}   x.openPrs               [{ number, author, title, files: string[] }]
 * @param {string[]} x.myFiles              本批改动文件（origin/main...HEAD，三点）
 * @returns {{code:number, verdict:string, reasons:string[], intersects:Array, peers:Array, pendingFiles:string[], unverified:boolean, skipped:boolean}}
 */
export function decide(x) {
  const reasons = [];
  const intersects = [];
  const peers = (x.openPrs || []).filter((p) => p && p.author !== x.myLogin);
  // 待推送文件：三点 diff 的语义 = 本分支引入的改动；内容已等价（diffEmpty）时置空。
  // 见文件头「不能改成两点」的理由。
  const pendingFiles = x.diffEmpty ? [] : (x.myFiles || []);

  // S8：显式跳过
  if (x.skip) {
    return {
      code: 0,
      verdict: "PASS",
      reasons: ["PEER_CHECK_SKIP=1：已人工确认跳过合作者动态检查（本次未验证远端协作状态）"],
      intersects,
      peers,
      pendingFiles,
      unverified: true,
      skipped: true,
    };
  }

  // S7 / 网络不可达
  if (x.apiFailed) {
    if (x.apiUnreachable) {
      return {
        code: 0,
        verdict: "PASS",
        reasons: ["网络不可达，无法查询远端协作状态（不阻断推送）：" + (x.apiError || "unknown")],
        intersects,
        peers,
        pendingFiles,
        unverified: true,
        skipped: false,
      };
    }
    return {
      code: 2,
      verdict: "CONFIRM",
      reasons: ["GitHub API 调用失败，远端协作状态未验证：" + (x.apiError || "unknown")],
      intersects,
      peers,
      pendingFiles,
      unverified: true,
      skipped: false,
    };
  }

  // BLOCK：本地落后且内容确有差异
  const blocking = [];
  if (Number(x.behind) > 0 && !x.diffEmpty) {
    blocking.push(
      "本地落后远端主线 " + x.behind + " 个提交，且 git diff HEAD origin/main 非空（内容确有差异）",
    );
  }
  if (x.localOriginMainSha !== x.remoteMainSha && !x.remoteMainExistsLocally) {
    blocking.push(
      "远端 main 已前进到 " + short(x.remoteMainSha) +
        "，但本地对象库中没有该提交（本地 origin/main=" + short(x.localOriginMainSha) + "，需先 git fetch）",
    );
  }
  if (blocking.length) {
    return { code: 1, verdict: "BLOCK", reasons: blocking, intersects, peers, pendingFiles, unverified: false, skipped: false };
  }

  // 特例说明：SHA 不同但内容一致
  if (Number(x.behind) > 0 && x.diffEmpty) {
    reasons.push(
      "本地与 origin/main 的 SHA 不同（behind=" + x.behind + "），但内容逐字一致（diff 为空）⇒ 视为已同步",
    );
  }

  // CONFIRM：非本人 open PR 且文件有交集
  const mine = new Set(pendingFiles);
  for (const p of peers) {
    const inter = (p.files || []).filter((f) => mine.has(f));
    if (inter.length) {
      intersects.push({ pr: p.number, author: p.author, title: p.title, files: inter });
    }
  }
  if (intersects.length) {
    const names = intersects.map((i) => "#" + i.pr + "(" + i.author + ")").join("、");
    reasons.push("存在非本人 open PR 且与本批改动文件有交集：" + names);
    return { code: 2, verdict: "CONFIRM", reasons, intersects, peers, pendingFiles, unverified: false, skipped: false };
  }

  // PASS
  if (x.diffEmpty) {
    reasons.push("本分支改动内容已在 origin/main 中，本次无待推送内容");
  }
  if (peers.length) {
    reasons.push(
      "存在 " + peers.length + " 个非本人 open PR，但与待推送文件无交集（不阻断）：" +
        peers.map((p) => "#" + p.number + "(" + p.author + ")").join("、"),
    );
  } else {
    reasons.push("无其他 open PR");
  }
  return { code: 0, verdict: "PASS", reasons, intersects, peers, pendingFiles, unverified: false, skipped: false };
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、自测（纯注入，不依赖网络与 git）
 * ══════════════════════════════════════════════════════════════════════ */

const SELF_CASES = [
  {
    name: "S1 同步且无他人 PR",
    input: { behind: 0, diffEmpty: false, localOriginMainSha: "aaaa", remoteMainSha: "aaaa", remoteMainExistsLocally: true, myLogin: "me", openPrs: [], myFiles: ["a.ts"] },
    expect: 0,
  },
  {
    name: "S2 behind=1 但内容一致（Rebase-and-merge 特例）",
    input: { behind: 1, diffEmpty: true, localOriginMainSha: "bbbb", remoteMainSha: "bbbb", remoteMainExistsLocally: true, myLogin: "me", openPrs: [], myFiles: ["a.ts"] },
    expect: 0,
    expectPending: 0,
  },
  {
    name: "S3 behind=1 且内容有差异",
    input: { behind: 1, diffEmpty: false, localOriginMainSha: "cccc", remoteMainSha: "cccc", remoteMainExistsLocally: true, myLogin: "me", openPrs: [], myFiles: ["a.ts"] },
    expect: 1,
  },
  {
    name: "S4 远端 main 前进且本地无该提交",
    input: { behind: 2, diffEmpty: true, localOriginMainSha: "dddd", remoteMainSha: "eeee", remoteMainExistsLocally: false, myLogin: "me", openPrs: [], myFiles: ["a.ts"] },
    expect: 1,
  },
  {
    name: "S5 他人 PR 文件有交集",
    input: { behind: 0, diffEmpty: false, localOriginMainSha: "ffff", remoteMainSha: "ffff", remoteMainExistsLocally: true, myLogin: "me", openPrs: [{ number: 96, author: "peer", title: "feat", files: ["package.json", "src/x.ts"] }], myFiles: ["package.json", "b.ts"] },
    expect: 2,
    expectIntersect: ["package.json"],
    expectPending: 2,
  },
  {
    name: "S6 他人 PR 文件无交集",
    input: { behind: 0, diffEmpty: false, localOriginMainSha: "gggg", remoteMainSha: "gggg", remoteMainExistsLocally: true, myLogin: "me", openPrs: [{ number: 96, author: "peer", title: "feat", files: ["src/z.ts"] }], myFiles: ["a.ts"] },
    expect: 0,
  },
  {
    name: "S7 API 失败（非网络不可达）",
    input: { behind: 0, diffEmpty: false, apiFailed: true, apiUnreachable: false, apiError: "HTTP 403", localOriginMainSha: "hhhh", remoteMainSha: "hhhh", remoteMainExistsLocally: true, myLogin: "me", openPrs: [], myFiles: ["a.ts"] },
    expect: 2,
  },
  {
    name: "S8 PEER_CHECK_SKIP=1",
    input: { skip: true, behind: 0, diffEmpty: false, localOriginMainSha: "iiii", remoteMainSha: "iiii", remoteMainExistsLocally: true, myLogin: "me", openPrs: [], myFiles: ["a.ts"] },
    expect: 0,
    expectSkipped: true,
  },
];

export function selfTest() {
  console.log("═══ check-peer-activity 自测（8 条）═══");
  let pass = 0;
  let fail = 0;
  for (const c of SELF_CASES) {
    const r = decide(c.input);
    const codeOk = r.code === c.expect;
    let extraOk = true;
    const notes = [];
    if (c.expectIntersect) {
      const got = r.intersects.flatMap((i) => i.files);
      const same = c.expectIntersect.length === got.length && c.expectIntersect.every((f) => got.includes(f));
      if (!same) {
        extraOk = false;
        notes.push("交集文件=" + JSON.stringify(got) + " 期望=" + JSON.stringify(c.expectIntersect));
      } else {
        notes.push("交集=" + got.join(","));
      }
    }
    if (c.expectSkipped && !r.skipped) {
      extraOk = false;
      notes.push("skipped 标记缺失");
    }
    if (typeof c.expectPending === "number") {
      if (r.pendingFiles.length !== c.expectPending) {
        extraOk = false;
        notes.push("待推送文件数=" + r.pendingFiles.length + " 期望=" + c.expectPending);
      } else {
        notes.push("待推送=" + r.pendingFiles.length);
      }
    }
    const ok = codeOk && extraOk;
    if (ok) pass++;
    else fail++;
    console.log(
      (ok ? "  PASS  " : "  FAIL  ") + c.name +
        "  期望 exit=" + c.expect + " 实际=" + r.code + "(" + r.verdict + ")" +
        (notes.length ? "  " + notes.join("；") : ""),
    );
    if (!ok) {
      for (const reason of r.reasons) console.log("        reason: " + reason);
    }
  }
  console.log("");
  console.log("═══ 合计 8 条：PASS " + pass + " / FAIL " + fail + " ═══");
  if (fail) {
    console.error("\n自测失败 —— 判定逻辑与预期不符，不可用于推送门禁。");
    process.exit(1);
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、真实环境：本地数据 + GitHub 只读 API
 * ══════════════════════════════════════════════════════════════════════ */

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts });
}

function gitTry(args, opts = {}) {
  try {
    return { ok: true, out: git(args, opts) };
  } catch (e) {
    return { ok: false, out: "", err: e };
  }
}

function readCredential() {
  try {
    const raw = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
      timeout: 8000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" },
    });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const find = (k) => {
      const l = lines.find((x) => x.startsWith(k + "="));
      return l === undefined ? null : l.slice(k.length + 1);
    };
    return find("password");
  } catch {
    return null;
  }
}

const UNREACHABLE = new Set(["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET"]);

function makeClient(token, deadline) {
  return function request(path) {
    return new Promise((resolve) => {
      const remain = deadline - Date.now();
      if (remain <= 1000) {
        resolve({ ok: false, unreachable: false, error: "总耗时预算已用尽", body: "" });
        return;
      }
      const timeout = Math.min(REQ_TIMEOUT_MS, remain);
      const req = https.request(
        {
          hostname: "api.github.com",
          path,
          method: "GET",
          headers: {
            "User-Agent": "m-map-peer-check",
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: "Bearer " + token,
          },
        },
        (res) => {
          let s = "";
          res.setEncoding("utf8");
          res.on("data", (d) => { s += d; });
          res.on("end", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ ok: true, status: res.statusCode, body: s });
            } else {
              resolve({ ok: false, status: res.statusCode, unreachable: false, error: "HTTP " + res.statusCode, body: s });
            }
          });
        },
      );
      req.on("error", (e) => {
        const code = e && e.code ? e.code : "REQUEST_FAILED";
        resolve({ ok: false, unreachable: UNREACHABLE.has(code), error: code, body: "" });
      });
      req.setTimeout(timeout, () => {
        req.destroy();
        resolve({ ok: false, unreachable: false, error: "TIMEOUT", body: "" });
      });
      req.end();
    });
  };
}

function writeReport(md) {
  mkdirSync(dirname(join(process.cwd(), REPORT)), { recursive: true });
  writeFileSync(join(process.cwd(), REPORT), md, "utf8");
}

async function main() {
  const startedAt = new Date();
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const skip = process.env.PEER_CHECK_SKIP === "1";

  // ── 本地数据 ──────────────────────────────────────────────
  const head = gitTry(["rev-parse", "HEAD"]).out.trim();
  const localOriginMain = gitTry(["rev-parse", "origin/main"]).out.trim();
  const behindRes = gitTry(["rev-list", "--count", "HEAD..origin/main"]);
  const behind = behindRes.ok ? Number(behindRes.out.trim()) || 0 : 0;
  const diffQuiet = gitTry(["diff", "--quiet", "HEAD", "origin/main"]);
  const diffEmpty = diffQuiet.ok; // exit 0 ⇒ 无差异
  const myFilesRes = gitTry(["diff", "--name-only", "origin/main...HEAD"]);
  const myFiles = myFilesRes.ok ? myFilesRes.out.split("\n").map((s) => s.trim()).filter(Boolean) : [];

  let myLogin = "(unknown)";
  let remoteMainSha = "";
  let remoteMainExistsLocally = false;
  let openPrs = [];
  let apiFailed = false;
  let apiUnreachable = false;
  let apiError = "";

  if (!skip) {
    const token = readCredential();
    if (!token) {
      apiFailed = true;
      apiError = "无法从凭据管理器取得凭据";
    } else {
      const request = makeClient(token, deadline);
      const me = await request("/user");
      if (!me.ok) {
        apiFailed = true;
        apiUnreachable = me.unreachable;
        apiError = me.error;
      } else {
        try {
          myLogin = JSON.parse(me.body).login || "(unknown)";
        } catch {
          myLogin = "(unknown)";
        }
        const ref = await request("/repos/" + REPO + "/git/ref/heads/main");
        if (!ref.ok) {
          apiFailed = true;
          apiUnreachable = ref.unreachable;
          apiError = ref.error;
        } else {
          try {
            remoteMainSha = JSON.parse(ref.body).object.sha || "";
          } catch {
            remoteMainSha = "";
          }
          remoteMainExistsLocally = remoteMainSha
            ? gitTry(["cat-file", "-e", remoteMainSha + "^{commit}"]).ok
            : false;

          const prs = await request("/repos/" + REPO + "/pulls?state=open&per_page=100");
          if (!prs.ok) {
            apiFailed = true;
            apiUnreachable = prs.unreachable;
            apiError = prs.error;
          } else {
            let list = [];
            try {
              list = JSON.parse(prs.body);
            } catch {
              list = [];
            }
            for (const p of list) {
              const author = (p.user && p.user.login) || "(unknown)";
              let files = [];
              if (author !== myLogin) {
                const fr = await request("/repos/" + REPO + "/pulls/" + p.number + "/files?per_page=100");
                if (fr.ok) {
                  try {
                    files = JSON.parse(fr.body).map((f) => f.filename);
                  } catch {
                    files = [];
                  }
                } else {
                  // 单个 PR 文件查询失败：降级为「文件未知」，交由 CONFIRM 兜底
                  apiFailed = true;
                  apiUnreachable = fr.unreachable;
                  apiError = "PR #" + p.number + " files: " + fr.error;
                  files = [];
                }
              }
              openPrs.push({ number: p.number, author, title: p.title || "", files });
            }
          }
        }
      }
    }
  }

  const result = decide({
    skip,
    apiFailed,
    apiUnreachable,
    apiError,
    behind,
    diffEmpty,
    localOriginMainSha: localOriginMain,
    remoteMainSha: remoteMainSha || localOriginMain,
    remoteMainExistsLocally,
    myLogin,
    openPrs,
    myFiles,
  });

  // ── 控制台摘要 ────────────────────────────────────────────
  console.log("═══ 推送前合作者动态检查（check-peer-activity）═══");
  if (skip) {
    console.log("!!! 警告：PEER_CHECK_SKIP=1 —— 已人工确认跳过，本次未验证远端协作状态 !!!");
  }
  console.log("当前账号    : " + myLogin);
  console.log("远端 main   : " + (remoteMainSha ? short(remoteMainSha) : "(未取得)"));
  console.log("本地 origin : " + (localOriginMain ? short(localOriginMain) : "(未取得)"));
  console.log("behind      : " + behind + "  内容等价(diffEmpty)=" + diffEmpty);
  console.log("待推送文件数: " + result.pendingFiles.length);
  if (openPrs.length === 0) {
    console.log("open PR     : 无");
  } else {
    for (const p of openPrs) {
      const mine = p.author === myLogin ? "（本人）" : "";
      console.log("open PR     : #" + p.number + " " + p.author + mine + " 「" + p.title + "」 files=" + p.files.length);
    }
  }
  for (const i of result.intersects) {
    console.log("  交集 #" + i.pr + " -> " + i.files.join(", "));
  }
  console.log("判定        : " + result.verdict + "（exit " + result.code + "）");
  for (const r of result.reasons) console.log("  理由      : " + r);

  // ── 报告 ──────────────────────────────────────────────────
  const lines = [];
  lines.push("# 推送前合作者动态检查报告");
  lines.push("");
  lines.push("- 生成时间：" + startedAt.toISOString());
  lines.push("- 当前账号：" + myLogin);
  lines.push("- 远端 main SHA：" + (remoteMainSha || "(未取得)"));
  lines.push("- 本地 origin/main：" + (localOriginMain || "(未取得)"));
  lines.push("- behind：" + behind + "　内容等价(diffEmpty)：" + diffEmpty);
  lines.push("- 待推送文件数：" + result.pendingFiles.length);
  if (diffEmpty) {
    lines.push("- 说明：本分支改动内容已在 origin/main 中，本次无待推送内容（三点 diff 的历史差异不计入待推送）");
  }
  if (result.pendingFiles.length) {
    lines.push("");
    lines.push("## 待推送文件");
    lines.push("");
    for (const f of result.pendingFiles) lines.push("- `" + f + "`");
  }
  lines.push("");
  lines.push("## open PR");
  lines.push("");
  if (openPrs.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| PR | 作者 | 标题 | 文件数 | 与待推送交集 |");
    lines.push("|---|---|---|---|---|");
    for (const p of openPrs) {
      const inter = result.intersects.find((i) => i.pr === p.number);
      lines.push(
        "| #" + p.number + " | " + p.author + (p.author === myLogin ? "（本人）" : "") + " | " +
          String(p.title).replace(/[\\|]/g, (c) => "\\" + c) + " | " + p.files.length + " | " +
          (inter ? inter.files.join("<br>") : "无") + " |",
      );
    }
  }
  if (result.intersects.length) {
    lines.push("");
    lines.push("## 交集明细");
    lines.push("");
    for (const i of result.intersects) {
      lines.push("- #" + i.pr + "（" + i.author + "）「" + i.title + "」");
      for (const f of i.files) lines.push("  - `" + f + "`");
    }
  }
  lines.push("");
  lines.push("## 判定");
  lines.push("");
  lines.push("**" + result.verdict + "（exit " + result.code + "）**");
  lines.push("");
  for (const r of result.reasons) lines.push("- " + r);
  if (result.unverified) {
    lines.push("");
    lines.push("> 注意：本次**未验证**远端协作状态（见上方理由）。");
  }
  writeReport(lines.join("\n") + "\n");

  console.log("");
  console.log("（报告已写入 " + REPORT + "）");
  process.exit(result.code);
}

if (process.argv.includes("--self-test")) {
  selfTest();
  process.exit(0);
}

if (!existsSync(".git")) {
  console.error("未在仓库根目录运行（找不到 .git）。");
  process.exit(1);
}

main().catch((e) => {
  // 任何未预期异常都不得让 pre-push 卡死；降级为 CONFIRM 并由人工确认。
  console.error("[check-peer-activity] 未预期异常：" + String(e && e.message ? e.message : e));
  console.error("降级为 CONFIRM：远端协作状态未验证。");
  process.exit(2);
});
