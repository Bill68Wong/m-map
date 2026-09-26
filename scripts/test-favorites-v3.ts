/**
 * 收藏 v3 迁移单测（scripts/test-favorites-v3.ts，v3.3.0 · AC-111/117）
 *
 * 断言（06 §4.1）：
 *   ① v2→v3 **丢 plans**（及 chain/walk/tiers）；② **删 isDefault 预设**；③ **保留用户自建**；
 *   ④ **备份键存在**（`must.favorites.v2.backup`）；⑤ **v1/v2 键不删**（可回滚）；
 *   ⑥ v1→v3 亦可迁移；⑦ **失败回滚**：备份写失败 ⇒ 不写 v3、不删任何键、`migrationFailed`。
 *
 * 用法：npx tsx scripts/test-favorites-v3.ts
 */
import { migrateToV3, readV3, FAVORITES_KEY_V3, FAVORITES_BACKUP_KEY } from "../src/lib/favorites/v3";

type Store = Map<string, string>;

function makeWindow(store: Store) {
  return {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

/** 极简浏览器桩（`exportBackupJson` 内的 Blob/URL/document 缺失会被其自身 try/catch 吞掉） */
function installGlobals(store: Store) {
  const g = globalThis as Record<string, unknown>;
  g.window = makeWindow(store);
  g.document = { createElement: () => ({ click() {}, remove() {}, style: {} }), body: { appendChild() {} } };
  g.URL = { createObjectURL: () => "blob:test", revokeObjectURL: () => {} };
  g.Blob = class { constructor() {} };
}

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `  | ${detail}` : ""}`);
};

/** 端点工厂：**坐标随 label 变化**（否则去重键相同 ⇒ places 会被折叠成 1 条） */
const EP = (label: string) => ({ kind: "place", label, lng: 113.5 + label.length * 0.001, lat: 22.19 });

/* ── ① ~ ③ 纯函数迁移 ── */
console.log("\n迁移纯函数（migrateToV3）");
{
  const v2 = {
    schemaVersion: 2,
    combos: [
      {
        id: "u1",
        type: "combo",
        name: "家 → 科大",
        from: EP("家"),
        to: EP("科技大学"),
        query: "fromLng=1&fromLat=1&toLng=2&toLat=2",
        chain: [{ kind: "board", code: "T345" }],
        walk: { out: 3 },
        tiers: { mode: "balanced" },
        plans: [{ id: "p1", fingerprint: "fp1", snapshot: { totalMin: 22 }, createdAt: 1, updatedAt: 1 }],
        createdAt: 1000,
        updatedAt: 2000,
        pinned: true,
      },
      {
        id: "d1",
        type: "combo",
        name: "预设 关闸 → 科大",
        from: EP("关闸"),
        to: EP("科大"),
        query: "q2",
        plans: [],
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  const f = migrateToV3(v2, null);
  check("schemaVersion = 3", f.schemaVersion === 3, String(f.schemaVersion));
  check("组合数 = 1（isDefault 预设已删除）", f.combos.length === 1, `got=${f.combos.length}`);
  check("保留用户自建组合（id=u1）", f.combos[0]?.id === "u1", f.combos[0]?.id ?? "(none)");
  const c = f.combos[0] as unknown as Record<string, unknown>;
  check("丢 plans 字段", c.plans === undefined, `plans=${JSON.stringify(c.plans)}`);
  check("丢 chain/walk/tiers 字段", c.chain === undefined && c.walk === undefined && c.tiers === undefined);
  check("保留 pinned", c.pinned === true);
  check("places 由组合端点派生（家 + 科技大学）", f.places.length === 2, `got=${f.places.length}`);
  check("migratedFrom = 'v2'", f.migratedFrom === "v2", String(f.migratedFrom));
  check("组合去重（同起终点只留一条）", f.combos.length === new Set(f.combos.map((x) => x.id)).size);
}

/* ── ⑥ v1 → v3 ── */
console.log("\nv1 → v3");
{
  const v1 = {
    schemaVersion: 1,
    items: [
      { id: "i1", type: "place", from: EP("家"), to: EP("科大"), query: "q", createdAt: 1, updatedAt: 1 },
      { id: "i2", type: "plan", from: EP("家"), to: EP("科大"), query: "q", fingerprint: "fp", createdAt: 1, updatedAt: 1 },
    ],
  };
  const f = migrateToV3(null, v1);
  check("仅 v1 时 migratedFrom = 'v1'", f.migratedFrom === "v1", String(f.migratedFrom));
  check("v1 地点对端点 → places", f.places.length === 2, `got=${f.places.length}`);
  check("组合为空", f.combos.length === 0, `got=${f.combos.length}`);
}

/* ── ④ ⑤ ⑦ readV3 状态机（含 localStorage 桩） ── */
console.log("\nreadV3 状态机");

/* ④ ⑤ 正常迁移：写 v3、写备份键、v1/v2 键不删 */
{
  const store: Store = new Map();
  installGlobals(store);
  store.set(
    "must.favorites.v2",
    JSON.stringify({
      schemaVersion: 2,
      combos: [
        { id: "u1", type: "combo", name: "家 → 科大", from: EP("家"), to: EP("科大"), query: "q", plans: [], createdAt: 1, updatedAt: 1 },
        { id: "d1", type: "combo", name: "预设", from: EP("关闸"), to: EP("科大"), query: "q2", plans: [], isDefault: true, createdAt: 1, updatedAt: 1 },
      ],
    }),
  );
  store.set("must.favorites.v1", JSON.stringify({ schemaVersion: 1, items: [] }));

  const r = readV3();
  check("迁移成功标记 migrated", r.migrated === true);
  check("未标记 migrationFailed", !r.migrationFailed);
  check("返回 1 条自建组合", r.file.combos.length === 1, `got=${r.file.combos.length}`);
  check("④ 隐藏备份键已写入", store.has(FAVORITES_BACKUP_KEY));
  check("v3 键已写入", store.has(FAVORITES_KEY_V3));
  check("⑤ v2 键保留（可回滚）", store.has("must.favorites.v2"));
  check("⑤ v1 键保留", store.has("must.favorites.v1"));
  const backup = JSON.parse(store.get(FAVORITES_BACKUP_KEY) as string) as Record<string, unknown>;
  check("备份内容含 v2 全文 + ts", !!backup.v2 && typeof backup.ts === "number");

  /* 终态：再次读取走 v3（不再迁移） */
  const r2 = readV3();
  check("二次读取 = v3 终态（migrated 未置）", !r2.migrated && r2.file.combos.length === 1);
}

/* ⑦ 失败回滚：备份键写失败（配额/隐私）⇒ 不写 v3、不删任何键、migrationFailed */
{
  const store: Store = new Map();
  const v2Raw = JSON.stringify({
    schemaVersion: 2,
    combos: [{ id: "u1", type: "combo", name: "家 → 科大", from: EP("家"), to: EP("科大"), query: "q", plans: [], createdAt: 1, updatedAt: 1 }],
  });
  store.set("must.favorites.v2", v2Raw);
  const w = makeWindow(store);
  // 让「写备份键」抛错（模拟配额满）
  const origSet = w.localStorage.setItem;
  w.localStorage.setItem = (k: string, v: string) => {
    if (k === FAVORITES_BACKUP_KEY) throw new Error("QuotaExceededError");
    origSet(k, v);
  };
  const g = globalThis as Record<string, unknown>;
  g.window = w;
  g.document = { createElement: () => ({ click() {}, remove() {}, style: {} }), body: { appendChild() {} } };
  g.URL = { createObjectURL: () => "blob:test", revokeObjectURL: () => {} };
  g.Blob = class { constructor() {} };

  const r = readV3();
  check("⑦ 标记 migrationFailed", r.migrationFailed === true);
  check("⑦ 只读降级 readOnly", r.readOnly === true);
  check("⑦ **未写 v3**", !store.has(FAVORITES_KEY_V3));
  check("⑦ **未删/未改 v2 原键**", store.get("must.favorites.v2") === v2Raw);
  check("⑦ 返回空文件", r.file.combos.length === 0 && r.file.places.length === 0);
}

console.log(`\n${fail === 0 ? "✅ 全部通过" : "❌ 存在失败"}：pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
