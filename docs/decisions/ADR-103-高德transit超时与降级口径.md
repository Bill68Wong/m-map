# ADR-103：高德 transit 超时预算与降级口径

## Status

Accepted（2026-09-26 深夜 · team-lead Q1 裁定采纳：超时 4000ms + `acquireWithWait(transit,800ms)` + 保留一次重试 + 文案软化）

## Context

- 现象：用户「经常」看到「路网数据暂时不可用，以下为估算结果」（`RouteResultPane` L62/L19、`ComboPlans` L215），**刷新后才好**。
- 触发链（`src/lib/amap/transit.ts`）：`fetchTransitPlans` 任何失败都收敛 `{ok:false,degraded:true}` —— ① 限流器不可用 ② `rate_limited`（3 QPS 共享桶取不到令牌）③ **请求失败/超时（`TRANSIT_TIMEOUT_MS=1500`）** ④ `status!=='1'`（含 10044 配额 / 20003 无路网）⑤ `no_plan`。上层 `nav-service` 置 `degraded`/`emptyReason='amap_unavailable'`。
- 已侦察推断「疑似与 AMap JSONP 代理时段性超时同源」——**经核实不成立**：`transit` 走服务端 `AMAP_KEY` 直连 `restapi.amap.com`，**不经** `/_AMapService` 代理（代理只管高德 **JS API** 的浏览器侧服务请求）。

### 线上实测（本次）

- **直连高德 transit（本地，绕开我们的桶，N=12）**：11 OK（`infocode=10000`）/ **1 超时（1503ms，恰卡 1500ms 预算）** / **配额 10044 = 0** / **无路网 20003 = 0**；延迟 p50 246ms。
- **生产 `/api/nav`（prod 真身 iad1 → 高德，6 次 `nocache=1`）**：`transitMs` = **2973 / 7092 / 3508 / 7081 / 3739 / 3855 ms**；其中 #2 `degraded=true, transitOk=false, amapPlans=0`（两次尝试均超时）。
  - `transitMs ≈ 3000` 的结构 = **首次超时（~1500ms）+ 重试成功（~1500ms）**；`≈7000` 且失败 = **两次均超时**。
  - 生产 RTT 是本地（246ms）的 **12~28 倍** ⇒ 印证「函数真身 iad1（美东）→ 高德（中国）」跨洲延迟。

## Decision

1. **上调超时预算**：`TRANSIT_TIMEOUT_MS` 由 **1500ms → 4000ms**（可经环境变量覆盖，默认 4000）。使**首次尝试即成功**，消除「必然超时 + 重试」的翻倍耗时与偶发双超时降级。
2. **取令牌改短等**：主调用（strategy=0）由 `acquireToken`（不等待）改 **`acquireWithWait(RATE_BUCKET.transit, 800ms)`** —— 把「瞬时桶空」从「降级」改为「短等 ≤0.8s」；多策略补查（s=7/8）仍用 `acquireToken`（可失败）。
3. **保留一次重试**（`TRANSIT_RETRY_DELAY_MS` 保持 ~250–350ms）；两次均失败才降级。
4. **降级文案软化**：保留估算卡功能；把「路网数据暂时不可用」改为不引起误导的刷新提示（文案门禁核查）。
5. **观测**：保留 `.verify/probe-v330-amap-transit.mjs`；`/api/nav` 的 `stats` 暴露 `transitMs` 已有，建议增 `infocode` 便于回归统计。

## Considered Options

1. **只加重试次数**：治标——每次尝试仍按 1500ms 计，总时长继续偏高，且双超时仍可能。
2. **改部署区域到靠近中国**：Hobby 下 `preferredRegion` 不生效（真身 iad1），不可行。
3. **上调超时 + 短等取令牌（采纳）**：直击根因（超时预算 << 真实 RTT），成本最低、收益最大。

## Consequences

- 正面：降级率大幅下降（首次即成功）；请求总时长下降（不再必然「超时+重试」）；对瞬时桶空更鲁棒。
- 负面：单次请求最长等待 4s（仍在 `maxDuration=30` 内）；极端网络下超时更久才降级（可接受，UX 已有 loading）。
- 验证：修复后重跑直连探针（应 0 超时）与生产 `/api/nav` 连续 20 次统计 `degraded` 率（应显著下降）。
- 明确排除：**配额（10044）与 JS 代理**均非本现象根因。

## Related ADRs

- ADR-102（钉）· ADR-104（收藏 v3）· 文档 `docs/迭代-v330-20260926/02-技术-调研与方案.md` §2。
