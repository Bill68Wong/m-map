#!/usr/bin/env node
/**
 * 迁移：把 108 行巴士折线换成官方 SHP 反算几何（dry-run 默认，不写库）
 *
 * 用法：
 *   node scripts/migrate-route-shapes-official.mjs                       # dry-run（默认，零写入）
 *   node scripts/migrate-route-shapes-official.mjs --backup out.json --apply   # 真写（单事务）
 *
 * ── 输入（全部只读）──────────────────────────────────────────────────────
 *   .verify/shp/ROUTE_NETWORK.{shp,dbf}      官方路网 link 几何（Macau_Grid）
 *   data/route-shapes-official-links.json    由 BUS_ROUTE_SEQ.xls 派生的 link 顺序（含来源 sha256）
 *   .verify/route-shapes-baseline.csv        验收夹具（sha256 定稿，改前必验）
 *
 * ── 三步变换（顺序不可换）────────────────────────────────────────────────
 *   ① 反 Transverse Mercator：Macau_Grid(x,y) → 经纬度（D_Macau 基准）
 *   ② 基准面平移 D_Macau → WGS84：dLon=+0.0030020 / dLat=-0.0011879（604 对同名站自标定）
 *   ③ WGS84 → GCJ-02：复用 src/lib/amap/coord.ts#wgs84ToGcj02（库内 polyline 存的就是 GCJ-02）
 *   ⚠️ 漏掉 ③ 会让换源后与 stations 整体差 615 m —— 这是本迁移最容易踩的坑。
 *
 * ── 为什么要用 5432 会话模式 ─────────────────────────────────────────────
 *   pooler 的 6543 是事务模式，多语句之间不保证同一快照，会导致「读到一半别人改了」
 *   或自检视图不一致。这里显式 new pg.Client + port 5432（覆盖 DATABASE_URL 里的端口）。
 *
 * ── 幂等 ────────────────────────────────────────────────────────────────
 *   判据不用 updated_at，而是比对新旧 polyline 字符串的 sha256。
 *   变换是纯闭式算术（无随机、无迭代），同一输入必然产出同一字符串 ⇒ 第二次跑 0 行变化。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 仓库根：由**脚本自身位置**反推，不许写死本机盘符/目录
 *   （写死过一次 `D:/Projects/.../musttoukou-pr101` ⇒ 换机器、换 clone 目录、CI 上直接跑不了，
 *    而且把个人目录结构写进了将要入库的脚本）。
 * `ROOT_FILE` 是同一位置的**目录 URL**（末尾带 `/`），供 `createRequire` / 动态 `import`
 *   使用 —— 这两者吃 URL 而不是 Windows 反斜杠路径。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_FILE = pathToFileURL(ROOT + "/").href;
const SHP_DIR = ROOT + "/.verify/shp/";
const LINKS = ROOT + "/data/route-shapes-official-links.json";
const FIXTURE = ROOT + "/.verify/route-shapes-baseline.csv";
const FIXTURE_SHA = "50aa65454f40114896b4f84fd9a798353e5197bef871454eb1a333cdf17d4926";
const REPORT = ROOT + "/.verify/route-shapes-swap-dryrun.csv";
const STALE_DAYS = 30;

const pg = createRequire(ROOT_FILE + "package.json")("pg");
const { wgs84ToGcj02, gcj02ToWgs84 } = await import(ROOT_FILE + "src/lib/amap/coord.ts");

// ── 参数 ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const bi = argv.indexOf("--backup");
const BACKUP = bi >= 0 ? argv[bi + 1] : null;
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法: node scripts/migrate-route-shapes-official.mjs [--backup <path> --apply]");
  process.exit(0);
}
if (APPLY && !BACKUP) { console.error("FATAL: --apply 必须同时给 --backup <path>（回滚靠它）"); process.exit(1); }

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const die = (m) => { console.error("FATAL: " + m); process.exit(1); };
const info = (m) => console.log("INFO : " + m);
const ok = (m) => console.log("OK   : " + m);

// ── 前置 1：夹具哈希 ────────────────────────────────────────────────────
if (!existsSync(FIXTURE)) die("夹具不存在: " + FIXTURE);
const fixtureBuf = readFileSync(FIXTURE);
const fixtureSha = sha256(fixtureBuf);
if (fixtureSha !== FIXTURE_SHA) die(`夹具 sha256 不符\n  期望 ${FIXTURE_SHA}\n  实际 ${fixtureSha}\n（夹具已定稿，禁止重新生成；不一致说明有人动过它）`);
ok(`前置1 夹具 sha256 = ${fixtureSha.slice(0, 16)}… (${fixtureBuf.length} B) 与定稿一致`);

// ── 解析夹具（用于交叉核对作用域行数）────────────────────────────────────
const fixLines = fixtureBuf.toString("utf8").trim().split(/\r?\n/);
const fixHead = fixLines[0].split(",");
const fixRows = fixLines.slice(1).map((l) => { const c = l.split(","); const o = {}; fixHead.forEach((h, i) => (o[h.trim()] = c[i])); return o; });
const fixHasOfficial = fixRows.filter((r) => String(r.has_official).trim() === "1").length;
ok(`前置1b 夹具 ${fixRows.length} 数据行 / has_official=1 的 ${fixHasOfficial} 行`);

// ── 解析 SHP / DBF（无第三方依赖）────────────────────────────────────────
function readShp(f) {
  const b = readFileSync(f); const r = []; let p = 100;
  while (p < b.length - 8) {
    const cl = b.readInt32BE(p + 4) * 2, c = p + 8, st = b.readInt32LE(c);
    if (st === 3) {
      const nP = b.readInt32LE(c + 36), nPt = b.readInt32LE(c + 40), po = c + 44 + nP * 4, pts = [];
      for (let i = 0; i < nPt; i++) pts.push([b.readDoubleLE(po + i * 16), b.readDoubleLE(po + i * 16 + 8)]);
      r.push(pts);
    } else if (st === 1) r.push([[b.readDoubleLE(c + 4), b.readDoubleLE(c + 12)]]);
    else r.push([]);
    p = c + cl;
  }
  return r;
}
function readDbf(f) {
  const b = readFileSync(f); const n = b.readUInt32LE(4), hl = b.readUInt16LE(8), rl = b.readUInt16LE(10);
  const fd = []; let p = 32;
  while (b[p] !== 0x0d && p < hl) { fd.push({ n: b.subarray(p, p + 11).toString("latin1").replace(/\0.*$/, "").trim(), l: b[p + 16] }); p += 32; }
  const o = []; let off = hl;
  for (let i = 0; i < n; i++) {
    if (off + rl > b.length) break;
    if (b[off] !== 0x2a) { const row = {}; let q = off + 1; for (const x of fd) { row[x.n] = b.subarray(q, q + x.l).toString("utf8").trim(); q += x.l; } o.push(row); }
    off += rl;
  }
  return o;
}

const shpRaw = readFileSync(SHP_DIR + "ROUTE_NETWORK.shp");
const dbfRaw = readFileSync(SHP_DIR + "ROUTE_NETWORK.dbf");
const shpSha = sha256(shpRaw), dbfSha = sha256(dbfRaw);
const linksDoc = JSON.parse(readFileSync(LINKS, "utf8"));
const expSha = linksDoc.meta.source["ROUTE_NETWORK.shp"];
if (expSha !== shpSha) die(`SHP 哈希与 links.json 记录不符\n  记录 ${expSha}\n  实际 ${shpSha}\n（官方源被换过？先重新生成 links.json）`);
ok(`前置1c 源文件哈希与 links.json 一致（shp ${shpSha.slice(0, 12)}… / dbf ${dbfSha.slice(0, 12)}…）`);

const nd = readDbf(SHP_DIR + "ROUTE_NETWORK.dbf");
const ns = readShp(SHP_DIR + "ROUTE_NETWORK.shp");
const geom = new Map();
nd.forEach((r, i) => geom.set(r.NETWORK_ID, ns[i]));

// ── 三步变换 ───────────────────────────────────────────────────────────
const A = 6378388, INVF = 297, F = 1 / INVF, E2 = 2 * F - F * F, EP2 = E2 / (1 - E2);
const FE = 20000, FN = 20000, K0 = 1;
const LON0 = (113.5364694 * Math.PI) / 180, LAT0 = (22.21239722 * Math.PI) / 180;
function mArc(p) {
  const e4 = E2 ** 2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * p
    - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * p)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * p)
    - ((35 * e6) / 3072) * Math.sin(6 * p));
}
const M0 = mArc(LAT0);
/** ① 反 Transverse Mercator（Snyder），返回 [lng, lat] 度（仍在 D_Macau 基准） */
function gridToDatum(x, y) {
  const M = M0 + (y - FN) / K0;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sP = Math.sin(p1), cP = Math.cos(p1), tP = Math.tan(p1);
  const C1 = EP2 * cP * cP, T1 = tP * tP;
  const N1 = A / Math.sqrt(1 - E2 * sP * sP);
  const R1 = (A * (1 - E2)) / Math.pow(1 - E2 * sP * sP, 1.5);
  const D = (x - FE) / (N1 * K0);
  const lat = p1 - ((N1 * tP) / R1) * (D ** 2 / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon = LON0 + (D - ((1 + 2 * T1 + C1) * D ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5) / 120) / cP;
  return [(lon * 180) / Math.PI, (lat * 180) / Math.PI];
}
/** ② 基准面平移 D_Macau → WGS84 */
const D_LON = 0.003002, D_LAT = -0.001188;
/** ①②③ 全链：Macau_Grid → GCJ-02 */
function gridToGcj(xy) {
  const v = [];
  for (const [x, y] of xy) {
    const [lng, lat] = gridToDatum(x, y);
    const g = wgs84ToGcj02({ lat: lat + D_LAT, lng: lng + D_LON });
    v.push([g.lng, g.lat]);
  }
  return v;
}
function gridToWgs(xy) {
  return xy.map(([x, y]) => { const [lng, lat] = gridToDatum(x, y); return [lng + D_LON, lat + D_LAT]; });
}

// ── 距离工具（与基线同口径：固定局部尺度 cos(22.14°)）──────────────────
const KX = 111320 * Math.cos((22.14 * Math.PI) / 180), KY = 110540;
const M = (p) => [p[0] * KX, p[1] * KY];
const dist = (a, b) => { const A2 = M(a), B2 = M(b); return Math.hypot(B2[0] - A2[0], B2[1] - A2[1]); };
const polyLen = (v) => { let s = 0; for (let i = 1; i < v.length; i++) s += dist(v[i - 1], v[i]); return s; };
function distToSeg(p, a, b) {
  const P = M(p), A2 = M(a), B2 = M(b);
  const vx = B2[0] - A2[0], vy = B2[1] - A2[1], L2 = vx * vx + vy * vy;
  if (L2 < 1e-9) return Math.hypot(P[0] - A2[0], P[1] - A2[1]);
  let t = ((P[0] - A2[0]) * vx + (P[1] - A2[1]) * vy) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(P[0] - (A2[0] + t * vx), P[1] - (A2[1] + t * vy));
}
function minDseg(p, poly) {
  if (poly.length === 1) return dist(p, poly[0]);
  let best = Infinity;
  for (let i = 1; i < poly.length; i++) { const d = distToSeg(p, poly[i - 1], poly[i]); if (d < best) best = d; }
  return best;
}

// ── 连库（只读为主；--apply 才写）────────────────────────────────────────
function envK(n) {
  for (const f of [ROOT + "/.env", ROOT + "/.env.local"]) {
    let t = ""; try { t = readFileSync(f, "utf8"); } catch { continue; }
    for (const l of t.split(/\r?\n/)) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l); if (m && m[1] === n) return m[2].trim().replace(/^["']|["']$/g, ""); }
  }
  return "";
}
const url = new URL(envK("DATABASE_URL"));
const client = new pg.Client({
  host: url.hostname, port: 5432, user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password), database: "postgres", ssl: { rejectUnauthorized: false },
});
await client.connect();
info("数据库连接：5432 会话模式单连接（非 pooler 6543 事务模式）");

const existing = (await client.query(
  `select route_code, dsat_dir, points, polyline, fetched_at
     from route_shapes order by route_code, dsat_dir`)).rows;
ok(`前置1d 库内 route_shapes ${existing.length} 行`);

/*
 * 段链覆盖对账：links.json 的组数 vs 夹具可换源行数。
 *
 * 为什么要显式对账而不是"看着差不多"：links.json 有 **111 组**，可换源只有 **108 行**。
 * 差额 3 组若被忽略，有两种截然不同的可能，后果相反：
 *   (a) 官方有链、但库里没有这一行 ⇒ 换源无从下手（无害，但要写清）；
 *   (b) 脚本按 links 全量遍历却匹配到了别的行 ⇒ **会多写行**，而我的验收门禁 C1（键集必须 117）
 *       是**事后**才红 —— 那时数据已经进库了。
 * 所以这里在写库前就对账，并且**用库里的真实行去验证差额组的理由**，不写死一句"正常情况"。
 */
{
  const linkGroups = [];
  for (const [rc, dirs] of Object.entries(linksDoc.routes ?? {})) {
    for (const [dir, spec] of Object.entries(dirs ?? {})) {
      if (Array.isArray(spec?.seqRaw) && spec.seqRaw.length) linkGroups.push(`${rc}/${dir}`);
    }
  }
  const swapKeys = new Set(
    fixRows.filter((r) => String(r.has_official).trim() === "1").map((r) => `${r.route_code}/${r.dsat_dir}`),
  );
  const extra = linkGroups.filter((k) => !swapKeys.has(k));
  const lacking = [...swapKeys].filter((k) => !linkGroups.includes(k));
  const existingKeys = new Set(existing.map((r) => `${r.route_code}/${r.dsat_dir}`));
  const extraWithRow = extra.filter((k) => existingKeys.has(k));

  ok(
    `前置1e 段链覆盖：links ${linkGroups.length} 组 / 可换源 ${swapKeys.size} 行 / 差额 ${extra.length} 组`,
  );
  if (lacking.length) {
    die(`以下可换源行在 links.json 里没有段链（换源无源可用）:\n  ${lacking.join(", ")}`);
  }
  if (extra.length) {
    console.log(`        差额 ${extra.length} 组不在换源集：${extra.join(", ")}`);
    // 逐组核理由：这些组在库里有行吗？有 ⇒ 说明"该换却没换"，是真问题，必须红。
    if (extraWithRow.length) {
      die(
        `差额组在库里有 route_shapes 行，却没有进入换源集（漏换）:\n  ${extraWithRow.join(", ")}` +
          `\n（要么基线 has_official 标错，要么筛选逻辑丢了它们）`,
      );
    }
    console.log(`        理由（运行时核过，非写死）：这些组合在 routes 表存在，但 route_shapes **无对应行**`);
    console.log(`        （从未采集几何）⇒ 没有可更新的目标行，故不参与换源；基线亦未收录。`);
  }
}

// ── 前置 3：快照陈旧度（INFO，不是失败——日历型硬门禁会永久假红）────────
const oldest = existing.reduce((m, r) => (!m || (r.fetched_at && r.fetched_at < m) ? r.fetched_at : m), null);
if (oldest) {
  const days = Math.floor((Date.now() - new Date(oldest).getTime()) / 86400000);
  const stale = existing.filter((r) => r.fetched_at && (Date.now() - new Date(r.fetched_at).getTime()) / 86400000 > STALE_DAYS).length;
  info(`前置3 快照陈旧度：最旧 fetched_at = ${new Date(oldest).toISOString().slice(0, 10)}（距今 ${days} 天）｜>${STALE_DAYS} 天的行 ${stale}/${existing.length}`);
  info(`前置3 说明：这不是失败。日历型硬门禁必然永久假红，故只记录不判红；陈旧风险已登记为 known risk。`);
  if (stale > 0) info(`前置3 提示：换源只修「几何」，不修「时效」。陈旧行需靠定期重采，换源后仍应关注。`);
} else info("前置3 快照陈旧度：fetched_at 全为空，无法判断（INFO，不判失败）");

// ── 逐行重建几何 ───────────────────────────────────────────────────────
const R = linksDoc.routes;
const byPair = new Map();
for (const r of existing) byPair.set(`${r.route_code}/${r.dsat_dir}`, r);

const rows = [];
let scope = 0, noOfficial = [], gSeamMax = 0, gSeamWorst = null;
for (const r of existing) {
  const code = r.route_code, dir = String(r.dsat_dir);
  const spec = R[code] && R[code][dir];
  const sts = (await client.query(
    `select rs.seq, s.lat, s.lng from route_stations rs join routes rt on rt.id = rs.route_id
       left join stations s on s.code = rs.station_code or s.code = split_part(rs.station_code,'/',1)
      where rt.code = $1 and rs.dsat_dir = $2 and s.lat is not null order by rs.seq`,
    [code, dir])).rows;

  const oldGcj = r.polyline.split(";").map((s2) => s2.split(",").map(Number));
  const lenBefore = polyLen(oldGcj);
  const stWgs = sts.map((s2) => [Number(s2.lng), Number(s2.lat)]);
  // before 站-线距离：把库内 GCJ 折线逆回 WGS84，再与 WGS84 站比（与 baseline 同口径）
  const oldWgs = oldGcj.map(([lng, lat]) => { const w = gcj02ToWgs84({ lat, lng }); return [w.lng, w.lat]; });
  const maxBefore = stWgs.length ? Math.max(...stWgs.map((p) => minDseg(p, oldWgs))) : null;

  if (!spec || !spec.links || !spec.links.length || sts.length < 2) {
    noOfficial.push(`${code}/${dir}` + (sts.length < 2 ? "(站数<2)" : ""));
    rows.push({
      route_code: code, dsat_dir: dir, status: "SKIP",
      points_before: r.points, points_after: "", len_before_m: lenBefore.toFixed(1), len_after_m: "",
      maxdev_before_m: maxBefore === null ? "" : maxBefore.toFixed(1), maxdev_after_m: "", changed: "no-official", sha_new: "",
    });
    continue;
  }

  scope++;
  const raw = [];
  const segs = [];
  for (const id of spec.links) { const g = geom.get(id); if (g && g.length) { segs.push({ id, pts: g }); for (const p of g) raw.push(p); } }
  // ── 结构断言：`seqRaw` 必须是 `0..n-1` 的**恒等排列**（无重复 / 无跳号 / 无越界）──
  //
  // ── 它能抓什么（真实价值，别低估）────────────────────────────────────
  //   ① 生成器自身 bug（不再按 xls SEQ 输出、出现跳号 / 重复 / 越界）。
  //   ② **xls 读入时丢了中段 / 前段行** ⇒ SEQ 变成 `0,1,2,4,…` ⇒ 本条立刻红，
  //      并打印缺哪个 SEQ。**这是本条的主要价值，不是附带。**
  //   ⚠️ ② 成立的前提是 `seqRaw` 为 xls SEQ 列的**原样拷贝**（而非按读到的行重编号）。
  //      本工件**无法直接验证**这前提（两种实现在"全部行都读到"时产出逐位相同的 seqRaw，
  //      实测 1/0：len 108 / max 107 / links 92，两边都成立）；支持"原样拷贝"的是
  //      字段命名 `seqRaw` + `meta.xls_header` 含 `SEQ` + 重编号会让本字段与长度完全冗余。
  //      要定论只能做一次受控实验：喂 SEQ 列本身带缺号的合成输入，看输出是否保留缺号
  //      （见 task #51）。**生成器若换实现，先做这个实验再信 ②。**
  //
  // ── 它抓不到什么（务必看清）────────────────────────────────────────────
  //   ① **末行丢失**：**若** `seqRaw` 为原样拷贝（见上方前提，尚未定论），
  //      本行集丢最后一行会剩 `0..n-2`，仍是合法排列 ⇒ 照样绿。
  //      （`seqRaw.len > links.len` 在 111/111 组成立，如 1/0 = 108 vs 92，
  //        但那只证明它没跟着过滤空行，**不区分**照抄与重编号。）
  //      ⚠️ 该盲区**与机制无关**：两种机制下丢末行得到的都是 `0..n-2`，一样绿。
  //   ② **生成器改为重编号**：那样任何读入丢行都会被抹平 ⇒ 也照样绿。
  //   ⇒ 末行丢失与重编号都**在本工件上不可检测**（known risk；后续单 task #51
  //     在生成器侧补 `rowsTotal` / `emptyNetworkId` 两个外部锚才能真正闭合）。
  //
  // ── 与下面 5 m 接缝哨兵的分工（别混）──────────────────────────────────
  //   5 m 那条是**间接量**，抓的是「中间某个 link 的 NETWORK_ID 变空 ⇒ 几何出现百米~公里级缺口」；
  //   在圆形地 / 回环 / 并行路段上，**顺序错未必产生距离突变**，所以它不能当顺序判据。
  //   ⇒ 两条互补：本条管 `seqRaw` 自身的形状，5 m 管链上的几何缺口。
  //
  // ⚠️ 当前数据下 `seqList` 恰为恒等排列（111/111 组）。
  //   **这既与"原样拷贝"相容，也与"重编号"相容**，故它不构成机制证据；
  //   在照抄机制下，读入丢中段行会让恒等性立刻破裂，而重编号机制下不会。
  //   ⇒ 恒绿不等于守住了什么，也不等于它无用：**覆盖面待 task #51 的受控实验定论**。
  {
    const n = spec.links.length;
    if (n === 0) die(`${code}/${dir}: 过滤空 NETWORK_ID 后没有任何 link`);
    /*
     * 校验对象是 `seqRaw`（**源侧原始 SEQ 序列**），不是 `links`：
     *   `seqRaw` = BUS_ROUTE_SEQ.xls 里该 (ROUTE_NO, DIRECTION) 的全部 SEQ 行（如 1/0 是 108 个）；
     *   `links`  = 过滤掉 NETWORK_ID 为空的行之后剩下的段（同例 92 个）。
     * 所以两者**本来就不等长**，差额 = NETWORK_ID 为空的 SEQ 行数 —— 那些是几何缺口，
     * 由下面的 5 m 接缝哨兵负责抓，不归本条管。
     *
     * ⚠️ 局部变量名用 `seqList` 而**不是** `raw`：外层 `raw` 是点坐标数组，
     *    同名不同义会让读者以为在遍历几何（本项目已因此误判过一次）。
     *
     * ⚠️ 上一版这里写的是 `spec.seq` —— 那个字段**在 links.json 里根本不存在**，
     *    于是整条断言被 `if (spec.seq && …)` 短路掉，**从来没执行过**。
     *    "写了断言"和"断言在跑"是两件事，这是本仓库第三次在这上面栽跟头。
     */
    const seqList = Array.isArray(spec.seqRaw) ? spec.seqRaw : [];
    if (seqList.length === 0) die(`${code}/${dir}: seqRaw 为空，无法校验段链完整性`);
    const seen = new Set();
    const dup = [];
    for (const s of seqList) {
      if (seen.has(s)) dup.push(s);
      seen.add(s);
    }
    const missing = [];
    for (let i = 0; i < seqList.length; i++) if (!seen.has(i)) missing.push(i);
    const outOfRange = [...seen].filter((s) => !Number.isInteger(s) || s < 0 || s >= seqList.length).sort((a, b) => a - b);
    if (missing.length || dup.length || outOfRange.length) {
      die(
        `${code}/${dir}: seqRaw 不是 0..${seqList.length - 1} 的排列（段链会少画/错位）` +
          `${missing.length ? `\n  缺 SEQ  : ${missing.join(", ")}` : ""}` +
          `${dup.length ? `\n  重复 SEQ: ${[...new Set(dup)].join(", ")}` : ""}` +
          `${outOfRange.length ? `\n  越界 SEQ: ${outOfRange.join(", ")}` : ""}` +
          `\n（两种可能：① 生成器输出的形状错了；② xls 读入时丢了中段/前段行（SEQ 出现缺号）。` +
          `⚠️ **末行丢失**不在此列——剩下 0..n-2 仍是合法排列、本条抓不到，见上方注释）`,
      );
    }
    if (n > seqList.length) die(`${code}/${dir}: links 数 ${n} > seqRaw 数 ${seqList.length}（数据被改坏）`);
  }
  // 几何缺口哨兵（**不是精度门禁**）：抓的是「中间某个 link 的 NETWORK_ID 变空」——
  // 该行仍在、SEQ 仍连续，结构断言抓不到，但链上会出现百米~公里级缺口。
  // 顺序错在 SEQ 排序下不可能发生，故这条不负责抓顺序。
  // 正常情况实测 max 0.074 m（19968 个接缝），5 m 有 67 倍余量。
  let seamMax = 0, seamWorst = null;
  for (let i = 1; i < segs.length; i++) {
    const a = segs[i - 1].pts[segs[i - 1].pts.length - 1], b = segs[i].pts[0];
    const g2 = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (g2 > seamMax) { seamMax = g2; seamWorst = [segs[i - 1].id, segs[i].id]; }
  }
  if (seamMax > gSeamMax) { gSeamMax = seamMax; gSeamWorst = `${code}/${dir} (${seamWorst[0]}→${seamWorst[1]})`; }
  if (seamMax > 5) die(`链断裂 ${code}/${dir}: link ${seamWorst[0]} → ${seamWorst[1]} 缺口 ${seamMax.toFixed(1)} m（串接顺序错或缺 link）`);
  const newWgs = gridToWgs(raw);
  const newGcj = gridToGcj(raw);
  const lenAfter = polyLen(newGcj);
  const maxAfter = Math.max(...stWgs.map((p) => minDseg(p, newWgs)));
  const newPolyline = newGcj.map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
  const same = sha256(Buffer.from(newPolyline)) === sha256(Buffer.from(r.polyline));
  rows.push({
    route_code: code, dsat_dir: dir, status: "SWAP",
    points_before: r.points, points_after: newGcj.length,
    len_before_m: lenBefore.toFixed(1), len_after_m: lenAfter.toFixed(1),
    maxdev_before_m: maxBefore === null ? "" : maxBefore.toFixed(1), maxdev_after_m: maxAfter.toFixed(1),
    changed: same ? "no(同构)" : "yes",
    sha_new: sha256(Buffer.from(newPolyline)).slice(0, 16),
    _newPolyline: newPolyline, _oldPolyline: r.polyline,
  });
}

if (scope !== fixHasOfficial) {
  const msg = `作用域行数 ${scope} != 夹具 has_official=1 的 ${fixHasOfficial}`;
  if (APPLY) die(msg);
  console.error("WARN : " + msg + "（dry-run 继续，但 --apply 会拒绝执行）");
}

// ── 报告 ───────────────────────────────────────────────────────────────
const head = ["route_code", "dsat_dir", "status", "points_before", "points_after", "len_before_m", "len_after_m", "maxdev_before_m", "maxdev_after_m", "changed", "sha_new"];
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(REPORT, [head.join(",")].concat(rows.map((x) => head.map((h) => x[h]).join(","))).join("\n") + "\n", "utf8");

const swap = rows.filter((x) => x.status === "SWAP");
const changed = swap.filter((x) => x.changed === "yes");
const longer = changed.filter((x) => Number(x.len_after_m) > Number(x.len_before_m)).length;
const shorter = changed.length - longer;
const imp = changed.map((x) => Number(x.maxdev_before_m) - Number(x.maxdev_after_m)).sort((a, b) => a - b);
const q = (f) => (imp.length ? imp[Math.min(imp.length - 1, Math.floor(f * imp.length))] : NaN);

console.log("");
console.log("── 汇总 " + "─".repeat(56));
console.log(`  库内总行数              ${existing.length}`);
console.log(`  换源作用域              ${scope}（夹具 has_official=1 = ${fixHasOfficial}）`);
console.log(`  无官方几何（不动）      ${rows.length - scope}`);
console.log(`  实际变化行              ${changed.length}`);
console.log(`  其中变长 / 变短         ${longer} / ${shorter}`);
console.log(`  maxdev 改善 p50 / p95   ${q(0.5).toFixed(1)} m / ${q(0.95).toFixed(1)} m`);
console.log(`  maxdev 换源后最大值     ${Math.max(...swap.map((x) => Number(x.maxdev_after_m))).toFixed(1)} m`);
console.log(`  maxdev 换源前最大值     ${Math.max(...swap.map((x) => Number(x.maxdev_before_m))).toFixed(1)} m`);
console.log(`  链完整性（接缝最大值）  ${gSeamMax.toFixed(3)} m @ ${gSeamWorst || "-"}　（哨兵阈值 5 m，只抓串错顺序）`);
console.log(`  报告                    ${REPORT.replace(ROOT + "/", "")}`);
if (noOfficial.length) console.log(`  未动行清单              ${noOfficial.join(", ")}`);

// ── --selftest：证明「生成是确定性的」（幂等的前提）────────────────────
if (argv.includes("--selftest")) {
  let bad = 0;
  for (const x of swap) {
    if (!x._newPolyline) continue;
    const again = (() => {
      const code = x.route_code, dir = x.dsat_dir;
      const spec = R[code] && R[code][dir];
      const raw = [];
      for (const id of spec.links) { const g = geom.get(id); if (g && g.length) for (const p of g) raw.push(p); }
      return gridToGcj(raw).map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`).join(";");
    })();
    if (again !== x._newPolyline) { bad++; console.error(`  不一致: ${x.route_code}/${x.dsat_dir}`); }
  }
  console.log("");
  console.log(bad === 0
    ? `SELFTEST: 生成确定性 OK —— ${swap.length}/${swap.length} 行二次生成与首次逐位相同`
    : `SELFTEST: FAIL —— ${bad} 行不一致`);
  console.log(`SELFTEST: 幂等判据 = sha256(new) vs sha256(库内现值)；因 new 确定，apply 后再跑必然 0 行变化`);
}

// ── --emit-postapply：产出「模拟 apply 之后」的备份形状文件 ──────────────
// 只用于与 rollback 脚本做 dry-run 互证（库内零写入）。带 _note 标明它不是真备份。
const ep = argv.indexOf("--emit-postapply");
if (ep >= 0) {
  const out = argv[ep + 1];
  if (!out) die("--emit-postapply 需要一个路径");
  const newByKey = new Map(swap.filter((x) => x._newPolyline).map((x) => [`${x.route_code}/${x.dsat_dir}`, x]));
  const doc2 = {
    _note: "TEST FIXTURE —— 不是真备份。它模拟「apply 已执行」之后的库状态（108 行是新几何、9 行保持原样），仅用于让 rollback 脚本 dry-run 互证「将还原 108 行」。",
    created_at_utc: new Date().toISOString(),
    rows_table_count: existing.length,
    rows: existing.map((r) => {
      const k = `${r.route_code}/${r.dsat_dir}`;
      const nx = newByKey.get(k);
      return nx
        ? { route_code: r.route_code, dsat_dir: r.dsat_dir, points: nx.points_after, polyline: nx._newPolyline, fetched_at: r.fetched_at }
        : { route_code: r.route_code, dsat_dir: r.dsat_dir, points: r.points, polyline: r.polyline, fetched_at: r.fetched_at };
    }),
  };
  writeFileSync(out, JSON.stringify(doc2), "utf8");
  ok(`--emit-postapply 已写出：${out}（${doc2.rows.length} 行；其中 ${newByKey.size} 行为新几何）`);
}

// ── 写库（只有 --apply 才走到这里）──────────────────────────────────────
if (!APPLY) {
  console.log("");
  info("DRY-RUN：未执行任何 UPDATE。加 --backup <path> --apply 才写库。");
  await client.end();
  process.exit(0);
}

// ── 前置 2：备份 ───────────────────────────────────────────────────────
mkdirSync(dirname(BACKUP), { recursive: true });
const backupDoc = {
  _note: "route_shapes 换源前快照，供 scripts/rollback-route-shapes-official.mjs 还原",
  created_at_utc: new Date().toISOString(),
  rows_table_count: existing.length,
  rows: existing.map((r) => ({ route_code: r.route_code, dsat_dir: r.dsat_dir, points: r.points, polyline: r.polyline, fetched_at: r.fetched_at })),
};
writeFileSync(BACKUP, JSON.stringify(backupDoc), "utf8");
const wrote = JSON.parse(readFileSync(BACKUP, "utf8"));
if (!wrote.rows || wrote.rows.length !== 117) die(`备份文件行数 ${wrote.rows ? wrote.rows.length : "?"} != 117，拒绝写库`);
ok(`前置2 备份已写出并回读校验：${BACKUP}（${wrote.rows.length} 行）`);

// ── 单事务写 ───────────────────────────────────────────────────────────
const toWrite = changed;
if (!toWrite.length) { ok("幂等：本次 0 行需要变化，不写库"); await client.end(); process.exit(0); }

try {
  await client.query("BEGIN");
  await client.query(`alter table route_shapes add column if not exists geom_source text not null default 'amap-gcj02'`);
  for (const x of toWrite) {
    const res = await client.query(
      `update route_shapes set polyline = $1, points = $2, geom_source = 'dsat-shp-20261112'
        where route_code = $3 and dsat_dir = $4
        returning route_code`,
      [x._newPolyline, Number(x.points_after), x.route_code, x.dsat_dir]);
    if (res.rowCount !== 1) throw new Error(`更新行数 ${res.rowCount}（期望 1）：${x.route_code}/${x.dsat_dir}`);
  }
  // 事务内自检：回读校验点数
  for (const x of toWrite) {
    const chk = await client.query(`select points from route_shapes where route_code=$1 and dsat_dir=$2`, [x.route_code, x.dsat_dir]);
    if (Number(chk.rows[0].points) !== Number(x.points_after)) throw new Error(`自检失败 ${x.route_code}/${x.dsat_dir}: points=${chk.rows[0].points} 期望 ${x.points_after}`);
  }
  await client.query("COMMIT");
  ok(`已提交：${toWrite.length} 行（单事务，任一行失败即整体 ROLLBACK）`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  die("写库失败已回滚：" + e.message);
}
await client.end();
