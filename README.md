# MUST登校 · M Map

澳门通勤与全澳巴士／轻轨路线查询 PWA。
输入起点终点，给出**门到门**方案：步行 + 巴士／轻轨 + 换乘 + 实时到站，并按总时长排序。

线上：<https://musttoukou.vercel.app>（站点受口令保护）

---

## 技术栈

| 层 | 用的什么 |
|---|---|
| 前端 | Next.js 15（App Router）+ React 19 + TypeScript（strict） |
| 后端 | Next.js Route Handlers（Vercel Serverless） |
| 数据库 | Supabase（PostgreSQL）+ 行级安全（RLS） |
| 地图 | 高德 JS API 2.0（服务端代理注入安全密钥） |
| 数据源 | 澳门交通事务局（DSAT）官方报站接口 |

---

## 快速上手

> **第一次上手请看 [`docs/协作-多人开发与上线规矩.md`](docs/协作-多人开发与上线规矩.md)** ——
> 里面有完整的五步清单、凭据交付方式、数据库与发版规矩。以下只是最简版。

```bash
git clone https://github.com/Bill68Wong/musttoukou.git
cd musttoukou

# 用你自己的 GitHub 身份提交（不要用编造的邮箱）
git config user.name  "你的名字"
git config user.email "你的GitHub邮箱"

cp .env.example .env     # 填 DATABASE_URL（向负责人索取，不要提交这个文件）
npm ci
npm run dev              # → http://localhost:3000
```

### 常用命令

```bash
npm run dev            # 本地开发服务
npm run build          # 生产构建
npm run lint           # 代码风格检查（0 错误）
npx tsc --noEmit       # 类型检查（0 错误）
npm run db:backup      # 备份数据库（跑危险操作前先做）
```

> 提交 PR 前：`npx tsc --noEmit` · `npm run lint` · `npm run build` **三条都要绿**。

### ⚠️ 三条最容易踩的坑

1. **本地连的就是线上生产库**（项目只有一套库）。改数据前先说一声，跑危险脚本要显式加 `--allow-prod`
   （默认被 `scripts/db-guard.ts` 拦住）。
2. **别 fork** —— fork 出来的仓库拿不到预览部署与规则校验，直接在仓库里建分支。
3. **类型检查过 + 构建过 + 接口 200 ≠ 功能能用** —— 提交前一定要在浏览器里真的走一遍流程。

---

## 数据来源与合规

数据取自 DSAT（交通事务局）公开报站接口，本项目：

- **非商业**用途
- 注明数据来源与取得日期
- 不修改原始数据内容
- 派生值（统计、推算时长等）明确说明算法

具体说明见站内 `/about` 页。

---

## 协作

- 📖 **上手与规矩**：[`docs/协作-多人开发与上线规矩.md`](docs/协作-多人开发与上线规矩.md)
- 🌿 **分支**：`人名-短横线描述`（不要用斜杠）
- 🔀 **改动**：一律走 PR → 等平台检查通过 → Squash 合并（main 受保护，不能直推）
- 📦 **发版**：版本号与 tag 由负责人统一发，功能 PR 不要顺手改版本号
