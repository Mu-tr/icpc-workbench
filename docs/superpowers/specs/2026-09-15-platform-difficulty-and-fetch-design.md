# 多平台题目拉取 / 难度映射（CF 标尺）/ 提交记录拉取 · 设计

> 日期：2026-09-15　状态：待评审
> 范围：8 个平台的题目元数据拉取、难度统一映射、提交记录拉取与后台分批续拉

## 1. 目标

1. **难度统一**：每个平台的**原生难度表示**都映射到 Codeforces rating 标尺（800–3500），映射有据可查（实测数据 + 官方文档），并**保留原生值**以便平台改档后重算。
2. **题目拉取补全**：各平台公开题库拉取拿到平台**真正提供**的难度与标签（当前多处丢弃）。
3. **提交记录补全**：计蒜客当前**只能同步比赛内提交**，补上「自由练题/题库」提交；其余平台保持并复用同一套元数据补齐管线。
4. **防风控**：所有平台拉取限流 + 单次上限 + 游标续拉；被截断时**后台按平台节奏自动间隔续拉**，无需用户反复点击。

## 2. 实测证据（本文所有映射的依据）

均为本次直连各平台接口/源码实测，非二手资料。采样量与陷阱一并记录。

### 2.1 各平台难度表示

| 平台 | 原生字段 | 实测值域 | 语义 | 实证依据 |
|---|---|---|---|---|
| codeforces | `problem.rating` | 800–3500，步长 100；gym/Unrated 无值 | 基准标尺 | 官方 API `problemset.problems`（11401 题 / 11102 有 rating） |
| luogu | `problem.difficulty` | **0–8 共 9 档**（0=暂无评定） | 官方枚举，`/_lfe/config` → `ProblemDifficulty` 权威给出 9 档 `{type,id,name,color}` | **737 对实证**（见 2.2） |
| atcoder | 无官方难度；kenkoooo `problem-models.json` 的 IRT `difficulty` | −10000…4383；p10 −576 / p50 1317 / p90 3108；565 题 `is_experimental`、286 题无值 | 社区模型（非官方） | **349 对实证桥**（见 2.3） |
| nowcoder | 题库页「难度」列（`<td>` 文本） | 200–3700；约 20% 题目为空（新题） | 平台自评「难度分」，与 CF rating 同量纲 | 官方出题规范直接以 CF rating 规定难度（练习赛 A 800-900 … F 2300+） |
| leetcode | `difficulty` = EASY/MEDIUM/HARD；另有 `acRate` | 3 档，4443 题 | 面试导向，非 ICPC | 结构实测（GraphQL `problemsetQuestionList`） |
| jisuanke | `difficultyType` = level1…level8 | 8 档，题量 685/675/857/297/306/294/323/124（合计 3561/3595） | 平台 i18n 字典**直接用洛谷档位名命名**（中文）与 CF 称号（英文，Newbie…Grandmaster） | 档位名 ↔ 洛谷档位 ↔ 洛谷实证列；**通过率交叉校验一致**（见 2.4） |
| daimayuan | 题库页难度列 = `pdoc.difficulty`，为 0 时用 Hydro 算法 | 1–10 | 站内相对难度（AC 率 × 提交量），非 rating | Hydro 源码 `packages/hydrooj/src/lib/difficulty.ts`：`round(10 − 13·s·acRate)`，`s` 为 nSubmit 的数值积分；实测与站点显示 **441/466 一致**（25 处差异全部因站点手工设定值优先） |
| qoj | **无难度字段**（UOJ 系数据模型无难度） | — | — | `/problems` 恒返回 `403 cf-mitigated: challenge`（需 cf_clearance）；即便可访问也无难度 |

**洛谷官方 2026-06 难度体系调整**（`help.luogu.com.cn/manual/luogu/problem/difficulty` 明确标注「此文档为临时难度定义」 + `release-note` 6 月条目）：
新增青题「提高」，并与官方 CF 区间对应：青 提高 ≈ **CF2000-2400**、蓝 提高+/省选− ≈ **CF2300-2700**、紫 省选/NOI− ≈ **CF2700-3100**（区间**互相重叠**）。

**陷阱（必须写进代码注释）**
- 洛谷 `difficulty=0` 作为**查询参数 = 不筛选**（与缺省、越界 `9` 同义），**不能**用来筛「暂无评定」。
- 洛谷难度体系**一年内已改过一次**，且黑题拆分（NOI / NOI+/CTS）已在计划中 → 不得把「8」写死为档数上限（表驱动 + 保留原生值）。
- 计蒜客难度档位名与洛谷档位名同源，但计蒜客 level9 不存在（实测 `difficultyType=level9` → total 0）。

### 2.2 洛谷 → CF rating 实证回归（737 对）

方法：洛谷 `problem/list?type=CF` 共 **10984** 道 Codeforces 镜像题（pid 形如 `CF1A`/`CF1919C`），与 CF API `problemset.problems` 的 rating 按题号对齐（采样 15 页 / 每页 50）。

| 洛谷 `difficulty` | 档名 | n | p25 | **中位** | p75 | p90 |
|---|---|---|---|---|---|---|
| 1 | 入门 | 63 | 800 | **800** | 900 | 1000 |
| 2 | 普及− | 126 | 800 | **1000** | 1200 | 1300 |
| 3 | 普及 | 119 | 1300 | **1500** | 1600 | 1700 |
| 4 | 普及+/提高− | 127 | 1700 | **1800** | 2000 | 2100 |
| 5 | 提高 | 129 | 2000 | **2200** | 2300 | 2500 |
| 6 | 提高+/省选− | 11 | 2300 | **2400** | 2800 | 2900 |
| 7 | 省选/NOI− | 96 | 2500 | **2600** | 2900 | 3000 |
| 8 | NOI/NOI+/CTS | 66 | 3200 | **3400** | 3500 | 3500 |

与官方公布的三档 CF 区间自洽（5→2200 ∈ 2000-2400；6→2400 ∈ 2300-2700；7→2600 ∈ 2700-3100 边缘）。
**采用值：800 / 1000 / 1500 / 1800 / 2200 / 2400 / 2600 / 3400（用户已确认）**。

### 2.3 AtCoder → CF rating 实证桥（349 对，分段线性）

方法：洛谷 `problem/list?type=AT` 共 **8098** 道 AtCoder 镜像题（pid `AT_abc300_a` → AtCoder id `abc300_a`），×kenkoooo `problem-models.json`：

| 洛谷档（=AtCoder 题难度档） | n | kenkoooo 中位 | 对应 CF 中位（2.2） |
|---|---|---|---|
| 1 | 82 | −386 | 800 |
| 2 | 42 | 451 | 1000 |
| 3 | 54 | 973 | 1500 |
| 4 | 46 | 1545 | 1800 |
| 5 | 42 | 2107 | 2200 |
| 6 | 7 | 2325 | 2400 |
| 7 | 34 | 2653 | 2600 |
| 8 | 42 | 3392 | 3400 |

**结论：kenkoooo 难度与 CF rating 不是简单加常数**——低段相差约 +550，中段约 +100，高段趋于相等。故采用**锚点分段线性插值**（锚点取自上表，超出两端钳到 800/3500），并在代码注释记录方法与样本量。

### 2.4 计蒜客档位 → CF rating（同源命名 + 通过率交叉校验）

计蒜客 i18n（`app.js` → `difficultyType`）：
`level1 入门/Newbie`、`level2 普及-/Pupil`、`level3 普及/Junior`、`level4 普及+/提高-/Senior`、`level5 提高/Specialist`、`level6 提高+/Expert`、`level7 省选/Master`、`level8 国赛/Grandmaster`。

`difficultyType → problemTags(type=difficulty)` 映射实测：level1→入门、level2→普及T1、level3→普及T2/T3、level4→普及T4/提高T1、level5→提高T2、level6→提高T3、level7→提高T4/省选、level8→NOI/CTS/IOI。

通过率（`passingRate` 中位）交叉校验：计蒜客 51.3/46.6/37.2/30.4 vs 洛谷同档 47.9/44.3/39.1/36.0（level1-4 量级一致）。

**采用值：直接复用洛谷档位表**（档位名一一对应）：800/1000/1500/1800/2200/2400/2600/3400。level8 样本仅 124 题且为 NOI/CTS/IOI 级，标注不确定性最高。

### 2.5 计蒜客练习提交接口（本次实测确认，用已保存 Cookie 只读验证）

| 用途 | 端点 | 实测结果 |
|---|---|---|
| 登录态/uid | `GET /api/user/info` | `{uuid, name, ...}` → `studentUuid` 来源 |
| 练题状态预筛 | `GET /api/problems?page=N&status=passed|attempted|no-attempt` | **status 过滤生效**：`passed` total=1、`attempted` total=0、`no-attempt` total=3594（`statuses[]`/`statuses` 无效，返回全量 3595） |
| 单题练习提交 | `GET /api/problem/submissions?problemId=34486&page=1` | `{"submissions":[{"hashId":"4zoBj7","language":"c++","status":"AC","time":"2026-09-13 12:37:47","usedTime":1,"usedMemory":3820,"passedCases":20,"totalCases":20,...}],"total":1}`；`studentUuid` **可省**（用登录身份）；时间为**北京时间字符串**，非 unix |
| 参赛列表 | `GET /api/contests?page=N&hasParticipated=true` | `{contests:[{contestId,title,startTime,...}], totalContests}` |
| 课程/课节（本期不做） | `/api/challenge/submissions?chapterLessonId=&studentUuid=` | 存在于 SPA，需课程上下文 |

其余 `/api` 路径清单（226 个 chunk 全量提取，共 276 条）已在本次调查中取得，作为后续扩展依据。

## 3. 设计

### 3.1 统一难度模块 `shared/src/difficulty.ts`（新增）

```ts
export type DifficultyScale =
  | 'cf-rating' | 'luogu-2026-06' | 'atcoder-kenkoooo-irt'
  | 'nowcoder-score' | 'leetcode-tier' | 'jisuanke-level-8' | 'hydro-1-10';

export const CF_RATING_MIN = 800;
export const CF_RATING_MAX = 3500;

/** 解析原生难度：返回统一标尺值 + 平台原生展示名 + 所属标度 */
export function parseNativeDifficulty(
  platform: PlatformId,
  raw: number | string | null | undefined,
): { rating: number | null; label: string | null; scale: DifficultyScale } ;

export function toCfRating(platform: PlatformId, raw: unknown): number | null;   // 钳到 [800,3500]，未知 → null
export function nativeDifficultyLabel(platform: PlatformId, raw: unknown): string | null;
export function cfRatingTitle(rating: number): { en: string; zh: string };       // Newbie…Legendary GM
export function cfRatingBand(rating: number): string;                            // 与 stats 难度分桶同口径
```

表驱动：每平台一个 `{ scale, toRating(raw), label(raw), evidence }` 条目，`evidence` 写入实测样本量与来源，便于日后重算。

各平台取值：
- **luogu**：1→800, 2→1000, 3→1500, 4→1800, 5→2200, 6→2400, 7→2600, 8→3400；`0`→null（暂无评定）。
- **jisuanke**：level1…level8 同上表（同源档位名）；非 `levelN` → null。
- **atcoder**：锚点分段线性 `[(-386,800),(451,1000),(973,1500),(1545,1800),(2107,2200),(2325,2400),(2653,2600),(3392,3400)]`，两端钳位。
- **nowcoder**：直接取值并钳到 [800,3500]；`0`/空 → null。
- **leetcode**：EASY→1000、MEDIUM→1500、HARD→2100（面试导向，启发式，注释说明；原实现 1200/1600/2100 中的 easy 偏高）。
- **daimayuan**：1→800, 2→900, 3→1000, 4→1200, 5→1400, 6→1600, 7→1800, 8→2000, 9→2200, 10→2400（Hydro 站内相对难度，启发式 ±200）。
- **codeforces**：原值。
- **qoj**：恒 null（平台无难度），注释说明原因。

### 3.2 数据模型

新增两列（`db/index.ts` 幂等迁移 + `schema.sql`）：
- `problems.native_difficulty TEXT` —— 平台原生难度原文（`4` / `level6` / `HARD` / `1500` / `7` / `1545`）
- `problems.difficulty_scale TEXT` —— 所属标度（`DifficultyScale`），用于平台改档后按标度重算

写入：`import/problemWritePolicy.ts` 的 upsert 同时写这两列（与 `difficulty` 同优先级规则）；`difficulty_source` 语义不变。
读取：`GET /api/problems`、`/page`、`/facets`、`/api/today`、复习库等返回 `nativeDifficulty` / `difficultyScale` / `difficultyLabel`（label 由模块派生）。

**映射发生在哪一层（避免两处映射）**：`NormalizedProblem` 扩展 `nativeDifficulty?: string` 与 `difficultyScale?: DifficultyScale`；
适配器**只负责给出原生原文**并**调用唯一的** `toCfRating()` 填 `difficulty`，不再自带映射表；
`importService` / `bankService` / `difficultyBackfill` 三条写库路径统一把三者写进 `problems`。这样平台改档只需改 `shared/src/difficulty.ts` 一处。

`PlatformMeta`（`shared/src/index.ts`）增加能力标记，供前端通用渲染，减少客户端硬编码：
`hasBank: boolean`（QOJ 为 false）、`difficultyScale: DifficultyScale`、`syncSources?: ('contest'|'practice')[]`（计蒜客为两者）。

### 3.3 题库拉取修正（`adapters/problemBank.ts`）

| 平台 | 改动 |
|---|---|
| luogu | 难度改用统一模块（含 0→null 语义修正）；标签仍走 `/_lfe/tags`（505 标签，忽略遗留 `type=6`）；新增 `luoguTypes?: ('P'|'B'|'CF'|'AT'|'SP'|'UVA')[]` 以支持拉 CF/AT 镜像（供 3.4 的 AtCoder 标签桥） |
| nowcoder | **解析页面已有的算法标签**（`a.tag-label[data-id]`，实测未筛选列表页即渲染；现状丢弃成 `tags: []`）；难度走统一模块；空难度 → null；按 `data-problemId` 定位行（页面存在 `colspan` 导致列索引不可靠） |
| leetcode | 查询补 `nameTranslated`（**中文标签**，直接命中知识体系）与 `acRate`；难度走统一模块；`paidOnly` 仍跳过 |
| daimayuan | 改走 `GET /p?page=N` + `Accept: application/json`（`pdocs` 含 `title/tag/nSubmit/nAccept/difficulty`），难度按 **Hydro 算法本地复算**（不再依赖 HTML 解析，抗模板改版）：`difficulty = pdoc.difficulty || round(10 − 13·s·acRate)`；标签取自 `tag` |
| jisuanke | 题库标签改为解析 `problemTags`（`type=difficulty|knowledge` 双类型 → 难度标签与算法标签分开）+ `tags` 分类字典 + `passingRate`；难度走统一模块（`difficultyType`） |
| atcoder | 难度走统一模块；**新增可选** `enrichTagsFromLuogu?: boolean`：拉洛谷 `type=AT` 镜像建 `atcoder id → 洛谷标签`，命中率与未命中数在返回中报告（默认关，实测 abc/arc/agc 页面 100% 命中、joi/past/utpc 等 0%） |
| qoj | **不提供题库拉取**（`/problems` 需 cf_clearance 且无难度）；API 返回明确说明，UI 隐藏该项 |

### 3.4 题目元数据回填扩展到全平台（`analysis/difficultyBackfill.ts`）

现状只支持洛谷/牛客。改为**每平台一个 meta fetcher**的注册表：

| 平台 | 单题元数据来源 | 限速 |
|---|---|---|
| luogu | `GET /problem/{pid}`（content-only + C3VK） | 300ms |
| nowcoder | `GET /acm/problem/list?keyword={NC id}`（keyword 模式才有标签） | 450ms，连续失败 8 次中止（风控） |
| leetcode | GraphQL `question(titleSlug){difficulty topicTags{nameTranslated} stats{acRate}}` | 250ms |
| daimayuan | `GET /p/{pid}`（JSON，`pdoc.tag` + Hydro 难度复算） | 300ms |
| jisuanke | `GET /api/problems?page=N&status=...`（题库一次性回填）或 `problemTags` 已有则跳过 | 300ms |
| atcoder | kenkoooo `resources/problems.json` + `problem-models.json`（整表，24h 缓存） | 单次 |
| codeforces | `problemset.problems`（整表） | 单次 |
| qoj | 无来源，跳过并报告 | — |

回填目标选择从「difficulty IS NULL」扩展为「difficulty IS NULL **或** native_difficulty IS NULL **或** tags 为空」（牛客/代码源为标签缺失主因），仍按来源优先级 `backfill(3)` 写入。

### 3.5 计蒜客练习提交（新增数据源，默认开启）

适配器内部两条来源：

1. **练习（新增）**
   - 预筛：`GET /api/problems?page=N&status=passed` + `status=attempted` → `(problemId, problemIdentifier, title)` 列表（服务端过滤，页数 = 用户做题数/20，天然便宜）。
   - 逐题：`GET /api/problem/submissions?problemId=X&page=N` → `{submissions, total}`。
   - `problemKey` 用 **`problemIdentifier`**（`T1001`），与题库入库键一致，提交与题库行自动合并且难度/标签直接复用；URL `/problem/{identifier}`（修正现有 `jisuankeProblemUrl` 的 fallback）。
   - `externalId` = `hashId`；`verdict` 复用 `mapJisuankeVerdict`（`status` 同 ojStatus 字典）；时间按 +08:00 解析（复用 `parseJisuankeTime`，注意该接口是 `"YYYY-MM-DD HH:MM:SS"` 字符串）。
   - **增量**：注入 `knownExternalIds`；某题 `total` ≤ 该题已知条数 → 跳过该题（1 请求），整题全已知即不产生数据；仅真正有新提交的题才逐页翻。
   - 分批：单次处理题目数上限（默认 40 题）+ 页数上限；游标 `backfillReachedPage` = 已处理到的题目序号，续拉从该处继续。
2. **比赛（保留）**：现有 `/api/contest/submissions` 路径与早停/补全语义不变。

两条来源合并返回；鉴权仍为 Cookie（`s` + `JSKUSS`），`checkAuth` 不变。
开关：`settings['jisuanke.practiceSync']`，**默认 `true`**（用户确认默认开）；关闭后仅同步比赛提交（现状行为）。

### 3.6 后台分批续拉调度器（新增 `adapters/syncScheduler.ts`）

用户要求：**点击同步后，后台间隔一段时间拉一部分；每次都是增量，减少耗时**。

- 触发：`syncPlatform` 结束时若 `truncated === true` 且触发来源为 `manual | all | retry`（不含 `days` 窗口、不含 `auto`），且平台未被禁用、账号未变更 → 注册续拉。
- 节奏（每平台独立，保守取值）：`codeforces 20s / atcoder 60s / luogu 45s / nowcoder 90s / jisuanke 90s / daimayuan 60s / leetcode 60s / qoj 90s`。
- 轮数上限：`settings['sync.autoContinueRounds']`，默认 **6**（0 = 关闭），单次用户操作触发的会话内有效。
- 互斥：同平台同时只允许一个同步在跑（既有 `sync_runs` 语义 + 内存锁）；用户手动点同步会**抢占/取消**待续拉。
- 可取消：`POST /api/sync/auto-continue` `{platform, enabled}` 与 `POST /api/sync/auto-continue/cancel` `{platform}`。
- 可见性：`GET /api/sync/status`（复用同步中心接口）增加 `autoContinue: { platform, round, maxRounds, nextAt, running }`；`sync_runs.triggered_by` 记录 `auto`，前端同步中心显示「后台续拉 第 2/6 轮 · 45 秒后」。
- 安全：任一轮失败（尤其 `auth_expired` / `rate_limited`）→ 立即停止该平台续拉并提示；服务重启后续拉计划丢失（文档说明，手动点一次同步即从游标继续）。

### 3.7 限流参数（集中为一张表，便于审计）

| 平台 | 页间/请求间隔 | 单次新增上限 | 续拉间隔 |
|---|---|---|---|
| codeforces | 500ms | 全局 `sync.maxSubmissions`（默认 500） | 20s |
| atcoder | 1000ms（社区要求 ≥1s） | 同上 | 60s |
| luogu | 300ms（题目信息批次 200ms、并发 3） | 同上 | 45s |
| nowcoder | 500ms | 同上 | 90s |
| leetcode | 300ms | 同上 | 60s |
| daimayuan | 400ms | 同上 | 60s |
| jisuanke | 400ms（练习逐题同） | 同上 + 单次题目数上限 40 | 90s |
| qoj | 1000ms | 同上 | 90s |

### 3.8 前端

- 题目页/今日/复习库难度列：显示 CF 数值，tooltip 补「平台 原值」（如 `CF 2200 · 洛谷 提高`）。
- 「拉取题库」页签：平台列表与提示更新；AtCoder 增加「用洛谷镜像补标签」开关；QOJ 显示不可用原因；计蒜客说明「练习提交默认同步」。
- 同步中心：显示后台续拉轮次与倒计时、提供「停止续拉」。

### 3.9 API 变更清单

| 接口 | 变更 |
|---|---|
| `GET /api/problems`、`/page`、`/facets` | 返回 `nativeDifficulty`、`difficultyScale`、`difficultyLabel` |
| `POST /api/problems/bank` | 新增 `atcoderTags?: boolean`、`luoguTypes?: string[]`；响应含 `unmatched` 统计 |
| `POST /api/problems/backfill-difficulty` | 覆盖全平台；响应按平台明细（新增 `atcoder/leetcode/daimayuan/jisuanke` 行） |
| `POST /api/sync/:platform` | 响应 `SyncResult` 增加 `autoContinue?: { round, maxRounds, nextAt }` |
| `GET /api/sync/status` | 增加续拉状态 |
| `POST /api/sync/auto-continue`、`/cancel` | 新增 |

## 4. 错误处理与降级

- 难度解析失败/未知 → `null`（不猜），UI 显示「难度未知」，训练计划候选池行为不变（仍排除 `difficulty IS NULL`）。
- 计蒜客练习来源失败（单题 403/无权限）→ 跳过该题并计数，不使整次同步失败；预筛接口 302 → `ManualImportRequiredError`（沿用现有文案风格）。
- Hydro 算法复算与站点值不一致时**以 pdoc.difficulty 优先**（与站点一致）。
- 洛谷改档导致档位名变化 → 表驱动 + `difficulty_scale` 记录；新增一档只需改表与标度名，不改调用方。

## 5. 测试计划

新增/扩展（`server/test`，沿用 node:test + mock fetch）：
1. `difficulty.test.ts`：各平台取值/边界/钳位/null；洛谷官方 9 档名；AtCoder 分段线性（锚点与两端钳位）；leetcode/daimayuan 表；`cfRatingTitle` 边界（800/1200/2400/3500）。
2. `problem-bank.test.ts` 扩展：牛客标签解析（含 `colspan` 行）、力扣 `nameTranslated`、代码源 JSON + Hydro 算法（用源码公式复算的用例）、计蒜客 `problemTags` 双类型、AtCoder 标签桥命中/未命中。
3. `jisuanke.test.ts` 扩展：练习预筛参数（`status=passed|attempted`）、单题提交解析（北京时间/verdict/`total` 早停）、练习 + 比赛合并、游标续拉与 `truncated` 语义。
4. `sync-scheduler.test.ts`：截断后续拉注册/取消/轮数上限/互斥/失败即停（注入假时钟）。
5. `difficulty-backfill.test.ts` 扩展：全平台 meta fetcher 与 unknown 选择条件。
6. `db` 迁移测试：老库补 `native_difficulty` / `difficulty_scale` 后幂等。

回归：`npm run typecheck`、`npm test`（server + client）、`npm run build`（client）、`npm run lint`。

## 6. 明确不做 / 风险

- **QOJ 难度**：平台确无难度字段，不猜、不发明；QOJ 题目继续 `difficulty = NULL`（因此不进入训练计划候选池，将在 UI 说明）。
- **计蒜客课程/课时提交**（`/api/challenge/submissions`）：需课程上下文，本期不做，路径已记录。
- **洛谷难度体系仍在调整**（官方自称「临时定义」，黑题拆分已宣布）：`difficulty_scale` + 表驱动使重算成本可控，但**映射值在官方定稿后需要复核**。
- **AtCoder 标签**来自洛谷镜像归属（第三方标签），命中率有限；默认关闭。
- **牛客约 20% 新题无难度分**：回填管线会重试，但仍可能长期为空。
- 难度映射为**近似**（±100~200），用于训练推荐与弱项分档足够，不作为精确评级。

## 7. 验收标准

1. 各平台入库题目的 `difficulty` 全部由 `shared/src/difficulty.ts` 单点派生；代码库内不再存在第二份平台→CF 映射表（`grep` 可证）。
2. `native_difficulty` / `difficulty_scale` 在老库启动后自动补齐，且幂等。
3. 计蒜客同步能拉到练习提交（用现有账号实测：`T1001` 的 AC 记录入库），且 30 天前数据不被重复拉取（增量）。
4. 截断时后端自动按平台节奏续拉，同步中心可见轮次/倒计时，可停止。
5. 牛客题库入库带算法标签；力扣入库带中文标签；代码源不再依赖 HTML 解析。
6. 全量测试 + 双端 typecheck + client build 通过。
