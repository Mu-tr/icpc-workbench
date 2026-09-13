# 题库清洗功能重构设计（AI 退出 · 粗粒度层 · 意图信号）

日期：2026-09-13
状态：已与用户逐节确认（§1 数据模型 / §2 粗粒度层与权重 / §3 意图与可验证性 均获通过）
关联文档：
[`../../2026-09-13-项目优化方案.md`](../../2026-09-13-项目优化方案.md)、
[`../../题目清洗工作流-标签可信度评估报告.md`](../../题目清洗工作流-标签可信度评估报告.md)、
[`../../题目清洗工作流-优化落地报告.md`](../../题目清洗工作流-优化落地报告.md)

## 背景与目标

### 触发本设计的实测结论

在一次对现有知识点管线的核查中，用本库真实数据得到四条互相印证的结论：

| # | 实测 | 含义 |
| --- | --- | --- |
| 1 | 规则层与 AI 层**零重叠**（1241 ∩ 7675 = 0） | 分层干净，但无内部交叉验证可做 |
| 2 | AI 点位占 **88.4%**（9845 / 11141），规则仅 11.6% | 标注主体是 AI，不是规则 |
| 3 | AI 标注与题源 tags 的**同族一致率 42.5%**、精确 25.5%，**50.4% 的题零匹配** | AI 在「这题考什么」上并无优势 |
| 4 | AI 置信度是**模型自报**（`aiClassify.ts` 按序号减 0.05）；规则置信度是 `rules.json` 手填常数 | 两个 `confidence` **都不是实测准确率** |

同时确认了一个此前未被记录的结构性事实：**taxonomy v2 只有 10 分类 / 122 个细粒度 code，
粗粒度兜底 code 仅 4 个**（`search.general`、`dp.general`、`string.general`、`geo.general`）。
而题源标签中最高频的一批 **在 taxonomy 里根本没有对应概念**：

```
数学 4757   模拟 3810   构造 2293   数据结构 2188   图论 1582   树上算法 1212
array 2020  brute force 2005   枚举 355   交互 341
```

### 用户提出的两条反驳（已用数据确认成立）

1. **低难度题标签严重膨胀**：CF `difficulty < 1200` 的 2299 题中，贪心 38% / 数学 39% / 模拟 45%。
   且随难度才变得有判别力（贪心 38%→21%、DP 4%→34%）。
2. **一题多标签是常态**：**75.7% 的题有 ≥2 个标签**（平均难度越高标签越多，2.13→3.16），
   单标签题仅 16.1%。因此**无法归因用户到底哪个知识点不熟**。

这两条同时否证了「用题源 tags 替代 AI」的简单方案 —— 两条来源在「一题对应哪个知识点」
这个任务上都不成立。

### 目标

把清洗模块从「一处概率性猜测」改为「可归因、可验证的证据链」：

1. **AI 退出清洗模块**（用户决策）。标注来源收敛为 `tag` / `rule` / `intent`。
2. **补齐 taxonomy 粗粒度层**，把「覆盖不足」与「信息量不足」分开处理：
   粗概念提供覆盖，**实测信息量决定权重**。
3. **采集用户意图信号**，把「用户弱项」从题目属性改为用户声明 —— 这是唯一能真正解决
   「多标签无法归因」的路径，同时解决样本量问题。
4. **可验证**：以留出集的预测力（AUC）而非标签准确率来证明弱项判断有效，
   并允许该验证证否整个方向。

### 非目标

- 不改动 `problems.tags` 的采集与写入路径（题源标签原样保留作审计）。
- 不删除 `aiClassify.ts` 文件本身，也不改 AI provider、AI 助手、课程模板等其它 AI 用法。
- 不重做 `mastery` 的 UI 呈现（仅改其数据口径）。
- 不做标签人工清洗（`clean-tags` 语义不变）。

---

## §1 数据模型与来源策略

### 1.1 核心重构：题目属性与用户弱项分离

现状 `problem_keypoints` 同时承载「题目特征」与「统计依据」，是「多标签无法归因」的**结构根因**。
本设计将其拆为两张语义清晰的表：

| 表 | 语义 | 主键 | 来源 |
| --- | --- | --- | --- |
| `problem_keypoints` | **题目属性**：这题涉及哪些知识点（多值，允许不确定） | `(platform, problem_key, code)` | `tag` / `rule` |
| `submission_intents`（新） | **用户声明**：用户在提交时自述卡在哪 | `(user_id, problem_id, created_at)` | 用户输入 |

一题多 code 从此是**正常态**，不再被压缩为单一标签。弱项判断读 `submission_intents`，
题目属性只作为**分层/聚合的维度**，不再独自承担归因职责。

### 1.2 来源定义

| source | 产出 | 性质 | confidence 语义 |
| --- | --- | --- | --- |
| `tag` | 题源 tags → 知识点 code（多标签全保留，含粗粒度） | 题目属性，含噪 | 固定 1.0，**不再表示可信度**；可信度由 §2 的 `informativeness` 表达 |
| `rule` | 标题正则命中 | 题目属性，确定性 | 保留 `rules.json` 现值（仅作规则间相对排序） |
| `intent` | 用户在题目页声明的卡点 | **用户属性，无歧义** | 固定 1.0 |
| ~~`ai`~~ | 删除（见 §1.4） | — | — |

`confidence` 字段保留以兼容既有读路径，但**明确降级为「来源内排序权重」而非概率**。
真实可靠度由 §2 的统计层单独提供。此语义变更写入 `store.ts` 注释与 spec，避免后人误读。

### 1.3 读取路径

`knowledgeTagsSql` 的三级回退改为二来源：

```
problem_keypoints（source IN ('tag','rule')，多 code 全返回）
  → 无则回退 problems.tags 原始值（保持现有行为，供审计与兜底）
```

删除 `problem_topics`（v1 遗留层）的回退分支，使读取路径只剩「知识点标注 → 题源 tags」。

**表与写入路径本次原样保留**：`problem_topics` 表、`topics/pipeline.ts`、
`POST /api/problems/topics/rebuild` 都不动。理由：它们是独立的遗留面，
删除属于优化方案 P2-7 的决策范围，与本设计「清洗口径」无关。
本设计只断开*读取*依赖，因此 `problem_topics` 将不再影响任何统计结果（可视为冻结）。
P2-7 后续若要删除它们，不会再与本设计冲突。

### 1.4 AI 标注清理

用户决策：**彻底清洗**。执行方式：

1. 物理删除 `problem_keypoints WHERE source='ai'`（实测 7675 题 / 9845 点位）。
2. **JSONL 源真相同步处理**：向 `annotations.jsonl` **追加 tombstone 行**
   （`knowledgePoints: []`、`writeSource: 'ai'`），而非物理删行。
   理由：`loadAnnotationsIntoDb` 在启动时按「题 × 来源取最后一行」重放，
   若只删库不写 tombstone，**下次启动会把 AI 标注原样复活**。这是本次迁移最容易踩的坑。
3. 迁移必须**幂等**：重复执行不产生额外变化（依据 `problem_keypoints` 是否还有 `ai` 行判断）。
4. 迁移入口：`server/src/db/index.ts` 的 `migrate()` 中加一个具名步骤 `purgeAiAnnotations(db)`，
   与既有 `mergeSlashedCfKeys` / `fixLuoguTimestamps` 同风格。

> **需要你确认的一处细化**：实测 AI 点位中有 **298 条 `method='ai:manual-import'`**
> （离线数据包导出后人工回填的通道产物）。它与纯 AI 生成（9547 条 `method='ai'`）来源不同 ——
> 前者经过人工搬运。本设计**保守处理：一并删除**（避免留下来源不清的数据），
> 若你希望保留这 298 条，请在设计评审时指出。

### 1.5 `knowledge_queue` 转为词表缺口清单

队列不再等待 AI。改为按「该题存在但映射不到任何 code 的原始 tag」聚合：

- 新增只读查询 `gapReport(db)`：返回 `tag → { 出现题数, 影响题数, 建议归属分类 }`，
  按出现题数降序。这直接指导 §2 的粗粒度层补齐。
- `knowledge_queue` 表保留（记录「哪些题尚无任何 code」），但 `status='pending'` 的语义
  从「待 AI 标注」改为「待词表覆盖」。`uncertain` 语义改为「题源标签无法映射」。
- `MAX_ATTEMPTS` / `markBatchRetry` / `retryFailedQueue` / `commitAiAnnotations` 等
  AI 批次专用逻辑一并移除（含其测试）。

---

## §2 粗粒度层与信息量权重

### 2.1 补齐 taxonomy 粗粒度层

为高频无归属标签补粗粒度 concept（归入现有 10 分类，不新增分类）：

| 新增 code | 名称 | 归入分类 | 实测题数 |
| --- | --- | --- | --- |
| `math.general` | 数学（综合） | math | 4757 |
| `misc.simulation` | 模拟 | misc | 3810 |
| `misc.construction` | 构造 | misc | 2293 |
| `ds.general` | 数据结构（综合） | ds | 2188 |
| `graph.general` | 图论（综合） | graph | 1582 |
| `tree.general` | 树上算法（综合） | tree | 1212 |
| `basic.brute-force` | 暴力枚举 | basic | 2005 |
| `misc.array` | 数组与实现 | misc | 2020 |
| `misc.counting` | 计数 | misc | 188 |
| `misc.stack` | 栈 | misc | 162 |
| `misc.interactive` | 交互 | misc | 341 |
| `basic.enumeration` | 枚举 | basic | 355 |

`taxonomy.version` 递增；`shared/src/tags.ts` 的 `TAG_SYNONYM_GROUPS` 同步补对应同义组
（`brute force` / `brute-force` / `暴力` / `暴力枚举` → `basic.brute-force` 等）。

预期效果：题源标签到 code 的可映射 token 比例从 **51.2% → 95%+**；
题目级覆盖率（至少 1 个 code）从 **73.5% → 95%+**（当前 26.5% 长尾中 3583/5066 是
「有标签但映射不上」，正是本步目标）。

### 2.2 信息量权重（治膨胀，而非删标签）

**这是本设计对用户第二条反驳的正面回答。** 粗概念占比大（数学 24.8%），
直接用于弱项会稀释信号；但删除它意味着放弃 24.8% 题目的覆盖。

解法：**覆盖率与信息量分开** —— 粗 code 提供覆盖，信息量决定它在下游的权重。

```
share(code)          = 含该 code 的题数 / 全库题数
informativeness(code) = H_b(share) / 1bit          // H_b = 二元熵
                      = -(p·log2 p + (1-p)·log2(1-p))
```

性质：`p→0.5` 时 → 1（最有区分度）；`p→0` 或 `p→1` 时 → 0（几乎无信息）。
**不做时间/难度之外的任何手工调整**，全部从数据算。

实测复现（同一公式，印证用户观察）：

| code | share | informativeness | 解读 |
| --- | --- | --- | --- |
| 数学（粗） | 24.8% | 0.19 | 低 —— 四题一遇，鉴别力弱 |
| 贪心（粗） | 24.0% | 0.21 | 低 |
| 数论 | 5.9% | 0.68 | 高 |
| 双指针 | 5.5% | 0.69 | 高 |

### 2.3 难度分层

信息量按**难度桶**分别计算（`未知` / `<1200` / `1200-1399` / `1400-1599` / `1600-1899` /
`1900-2199` / `2200+`，与 `problems.ts` 的 `DIFFICULTY_BUCKETS` 同口径），
因为膨胀是**难度相关**的：`<1200` 的贪心 share=38%（informativeness≈0.03），
`2200+` 的 DP share=34%（≈0.08），二者不可同一对待。

消费端在**同一难度桶内**比较，跨桶不混合 —— 否则难度会重新成为混淆变量。

### 2.4 计算与存储

新增 `knowledge_concept_stats` 表（物化缓存，避免每次请求全表扫）：

```
code TEXT, bucket TEXT, problem_count INTEGER, share REAL,
informativeness REAL, computed_at TEXT, PRIMARY KEY(code, bucket)
```

- 重算入口：`POST /api/knowledge/recompute-stats`（写路径：题库 upsert 后异步触发，
  与现有 L1 钩子同一模式）
- 权重下限 `FLOOR = 0.25`：避免低信息量概念权重归零后被完全静默 ——
  数学仍应出现在弱项列表里，只是排在数论之后。该常数写入代码注释并说明理由。

### 2.5 消费端改动

`analysis/weakness.ts` 的弱项打分改为按 `informativeness` 加权；
`mastery.ts`、`summary.ts` 的标签聚合同步改为多 code 口径（不再假设一题一标签）；
`planService.ts` 的推荐选题继续读题源 tags（其语义是「候选池筛选」而非弱项归因，
不在本次重构范围，但需在注释中说明这一有意保留的差异，消除现有「三套口径」的隐性分裂）。

---

## §3 意图信号采集与可验证性

### 3.1 采集

```sql
CREATE TABLE IF NOT EXISTS submission_intents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  problem_id INTEGER NOT NULL REFERENCES problems(id),
  -- 用户自述卡住的知识点 code；NULL = 非知识点摩擦（读题/实现/看错题）
  code       TEXT,
  -- 卡点性质：cant_start 完全不会 / wrong_approach 思路错 / implementation 写得出来但实现崩 / slight_bug 差一点
  outcome    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_intents_user_problem ON submission_intents(user_id, problem_id);
```

- `code` 允许 NULL 是**有意设计**：「我会做但实现崩了」是有价值的信号，不应被迫选一个知识点。
- 不对 `code` 加 taxonomy 外键（taxonomy 从 JSON 加载，非库表）；
  合法性在 API 层用 `isValidCode` 校验，与 `rules.json` 载入校验同一手段。

### 3.2 UI（最小摩擦）

`client/src/pages/Problems.tsx` 表格行内加一个「卡在哪」按钮 → 点开一个轻量 Popover
（**不是弹窗问卷**），三个选项：`完全不会` / `思路错` / `实现崩溃`；
选完可再选一个知识点（可跳过）。一次点击即 `POST` 记录。

同一交互在「今日训练」与「复习库」页面复用（这两个页面才是用户实际做题的入口），
但**本次只在题目管理页落地**，其余作为后续增量。

### 3.3 可验证性（本次交付的一部分）

新增可重复脚本 `server/scripts/validate-weakness.ts`（**非 UI 功能**）：

1. 按 `submitted_at` 取前 80% 提交拟合概念级失败率 `P(WA|code, bucket)`
2. 对后 20% 的每题预测「是否会 WA/TLE」
3. 报告 **AUC**，并给出两个基线对照：
   - **基线 A**：仅用难度桶（`bucket`）—— 若概念层打不过它，说明概念无增量价值
   - **基线 B**：随机
4. 同时输出每概念的样本数，`n < 20` 的标注为「功效不足」

**这一步允许证否方向**：若 AUC 不显著高于基线 A，则弱项判断不成立，
应在报告中明确写出并停止扩展该方向（而非调参到看起来可用）。

### 3.4 诚实的样本量约束

当前库内仅 **949 条提交 / 440 道题**，细化到 code 级每概念仅 15–130 条。
因此：

- UI 必须显示每概念的样本数，`n < 20` 时显示「样本不足，仅供参考」，
  **不给出确定性结论**
- 验证脚本的输出必须包含功效分析，不得只报一个 AUC 数字
- `submission_intents` 的价值不仅在于归因精度，更在于**它是高信息量样本**：
  一条带明确意图的失败记录，信息量远高于一条模糊的题目标签

---

## 数据流（重构后）

```
题源 tags ──(2.1 映射含粗粒度)──┐
                                ├─→ problem_keypoints (source ∈ {tag, rule})  ← 题目属性，多值
标题 ─────(规则引擎)───────────┘                    │
                                                    ▼
                              knowledge_concept_stats (share / informativeness × 难度桶)
                                                    │
用户「卡在哪」 ──→ submission_intents ──────────────┴─→ weakness（加权弱项）
                                                              │
                                                              ▼
                            validate-weakness.ts（留出集 AUC，对照仅难度基线）
```

---

## 错误处理

| 情形 | 处理 |
| --- | --- |
| taxonomy 中不存在的新 code（粗粒度层未补齐） | 映射时跳过并计入 `gapReport`，不抛错（与现有幻觉 code 拦截同策略） |
| `submission_intents.code` 非法 | API 层返回 400（`isValidCode` 校验），不写库 |
| 统计重算失败 | 记录 `computed_at` 未更新，消费端沿用上次结果并在 UI 标注「统计可能过期」 |
| AI 清理迁移中断 | 迁移在单事务内完成；JSONL 追加先于 COMMIT（沿用现有 store 事务顺序约定） |
| 验证脚本样本不足 | 明确输出「功效不足」，不输出误导性 AUC |

---

## 测试策略

| 层次 | 内容 |
| --- | --- |
| 单元 | tag→code 映射（含粗粒度、同义、未映射跳过）；`informativeness` 公式边界（p=0 / 0.5 / 1）；难度桶划分与 `problems.ts` 同口径 |
| 单元 | 二来源回退链（tag/rule 多 code 全返回、无标注回退 `p.tags`）；`problem_topics` 分支确已摘除 |
| 迁移 | `purgeAiAnnotations` 幂等性；**JSONL tombstone 后重启不复活 AI 标注**（这是最关键的一条回归） |
| 路由 | `POST /api/problems/:platform/:key/intent` 成功/非法 code/缺字段；`gapReport` 聚合正确 |
| 集成 | `weakness` 在粗/细 code 混合下的加权排序符合预期 |
| 脚本 | `validate-weakness.ts` 在合成数据上产出已知 AUC（可回归） |

既有测试中依赖 AI 链路的部分（`knowledge-ai.test.ts`、`markBatchRetry` 相关）
需改写或移除，基线为当前 **537 server + 67 client 全绿**。

---

## 版本与迁移

- `taxonomy.version` 2 → 3（新增粗粒度 code）
- `rules.json.version` 不变（规则内容未改；若补粗粒度规则则递增）
- `PIPELINE_CODE_VERSION` 递增（匹配逻辑改动）
- 数据库迁移：`purgeAiAnnotations`（具名、幂等）+ `knowledge_concept_stats` 建表
- 不新增 npm 依赖

---

## 已确认的决策

| 决策点 | 结论 |
| --- | --- |
| 方向 | A（保守修补）+ C（意图采集） |
| AI 定位 | **退出题目清洗模块** |
| 现有 AI 标注 | **彻底删除**（含 `ai:manual-import`，见 §1.4 待确认项） |
| `knowledge_queue` | 转为**词表缺口清单** |
| 粗粒度层 | 新增（覆盖与信息量分开处理） |
| 表结构 | 接受拆分（`problem_keypoints` 题目属性 + `submission_intents` 用户声明） |
| 验证 | 纳入本次交付（留出集 AUC + 基线对照） |
