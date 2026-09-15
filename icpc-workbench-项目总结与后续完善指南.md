# ICPC Workbench（ICPC 备赛工作台）· 项目总结与后续完善指南

> 整理自 Reasonix 工作台会话日志（2026-08-10 ~ 2026-08-14），供后续继续完善时快速恢复上下文。
> 整理日期：2026-08-14

---

## 1. 项目定位

**一句话**：基于刷题记录（Codeforces / AtCoder / 洛谷 / 牛客）分析弱项、由 AI 生成个性化训练计划、并提供日历打卡的**本地单用户 Web 应用**。

| 项 | 值 |
|---|---|
| 本地路径 | `C:\Users\33739\Desktop\工作台` |
| GitHub | https://github.com/ZF3373/icpc-workbench（**私有**，`master`，13 commits） |
| 技术栈 | npm workspaces monorepo：server（Node 22+ / Express / 内置 `node:sqlite`，零原生依赖）+ client（React 19 / Vite 8 / Ant Design 5）+ shared（跨端共享类型） |
| 运行方式 | `npm install && npm run dev` → server :3001 + client :5173 |
| 数据库 | `server/data/icpc.db`（首次启动自动创建；**含真实 Cookie，不入库 git**） |

---

## 2. 需求演进史（按会话顺序）

1. **初始需求**：多平台刷题导入 → 弱项分析（标签/难度/平台 AC 率）→ AI 训练计划 → 本地 Web 应用（用户选定 SQLite + AI 双通道：内置生成器 + 导出提示词无 Key 方案）。
2. **新增**：日历打卡（应用内）；**透明桌面挂件暂缓**，但 API 按日期维度预留（未来接 Electron/Tauri 零改后端）。
3. **框架搭建**（6 Phase / 36 子步骤，逐项签收）：骨架 → 平台导入层 → 弱项分析 → AI 计划 → 前端 5 页 → 收尾（测试/审查/git 基线）。
4. **增强 ①**：换账号时清空旧数据（原子事务，拉取失败绝不丢旧数据）+ 洛谷/牛客接入 Cookie 自动同步。
5. **Bug 修复 ①**："填新用户名没同步"——根因是设置页改 handle 时保留了旧账号的 `last_sync_at`，导致增量起点错误拉到 0 条。修复：改绑时重置 `last_sync_at=NULL`；`handleChanged` 判定扩展为"handle 不同**或**从未成功同步"。
6. **增强 ②**：牛客 JSON API 已下线 → 重写为**公开 HTML 表格解析**（`acm/contest/profile/{uid}/practice-coding`，匿名无需 Cookie）；洛谷未登录 302 无限重定向 → `redirect: 'manual'` + 清晰中文报错。
7. **增强 ③**：训练计划删除按钮；洛谷难度分级（0-8）映射为 CF rating 统一标尺。
8. **增强 ④**：**洛谷题目标签获取**（详见第 5 节关键情报）。
9. **收尾**：推送到 GitHub 私有仓库，完成隐私审计（真实 uid/Cookie/CSRF/数据库均未推送）。

---

## 3. 当前功能状态（全部已实现并验证）

| 模块 | 状态 | 说明 |
|---|---|---|
| Codeforces 适配器 | ✅ | 官方 API `user.status`，分页 + 增量，无需登录 |
| AtCoder 适配器 | ✅ | 社区 API `kenkoooo.com` v3 `user/submissions`（`from_second` 增量，500 条/页，页间 ≥1s），题目资源 24h 磁盘缓存 |
| 洛谷适配器 | ✅ 需 Cookie | `record/list`（仍用 `_contentOnly=1`）+ C3VK 反爬自动处理；题目信息走新 Lentille 头 |
| 牛客适配器 | ✅ | 公开 HTML 表格解析（牛客 JSON API 已下线）；无难度/标签（数据源限制） |
| 手动导入 | ✅ | JSON 表单 / CSV / 文件上传，externalId 稳定去重 |
| 同步管道 | ✅ | 增量、换账号检测+清空、Cookie/CSRF 注入、平台开关 |
| 统计/弱项/趋势 | ✅ | 按 汇总、相对自身平均 gap 弱项画像、ISO 周趋势 |
| AI 计划 | ✅ | OpenAI 兼容（DeepSeek/OpenAI/Ollama…），失败降级模板计划；导出提示词 `.md` 通道 |
| 日历打卡 | ✅ | 月视图徽标 + 当天任务列表 + 逐任务打卡/取消 |
| 前端 5 页 | ✅ | 仪表盘 / 题目管理（筛选+同步+导入）/ 计划（生成/详情/删除/打卡）/ 日历 / 设置（AI+账号+Cookie+适配器开关） |

**验证数据**（2026-08-14 前后实测）：CF `hieZF123` 5467 条、洛谷 uid `1892580` 466 条、牛客 uid `713093328` 325 条；总计 5484 次提交、3037 题、AC 率 61.1%。测试 70+ 全绿，双端 typecheck / client build / lint 0 错误。

---

## 4. 架构速览

```
server/src/
├── index.ts            # Express 入口，挂载 8 组路由
├── config.ts           # config.json + DB settings 运行时覆盖 + AI_API_KEY 环境变量
├── adapters/           # codeforces / atcoder / luogu / nowcoder + registry + sync（同步管道）
├── analysis/           # stats（聚合）/ weakness（弱项 gap）/ trend（周趋势）
├── ai/                 # provider.ts（OpenAI 兼容客户端）+ plan-prompt.md（提示词模板）
├── plans/              # planService（AI 优先→模板降级、推荐题、事务入库）
├── import/             # csv 解析（RFC4180）/ 行校验 / 事务入库 insertNormalized
├── routes/             # import / sync / stats / plans / export / problems / checkins / settings
└── db/                 # node:sqlite DatabaseSync + schema.sql（8 表，WAL，外键）
client/src/pages/       # Dashboard / Problems / Plans / Calendar / Settings（AntD）
shared/src/index.ts     # 跨端类型契约（PlatformId / NormalizedSubmission / WeaknessProfile…）
```

**核心 API**：`POST /api/sync/:platform`、`GET /api/stats[/weakness|/trend]`、`POST /api/plans/generate`、`GET /api/checkins?month=` 与 `GET /api/checkins/date/:date`（挂件预留）、`GET /api/export/plan-prompt.md`。

**数据库表**：platforms / users / platform_accounts / problems / submissions / plans / plan_tasks / checkins / settings。

---

## 5. 关键情报（踩坑记录，改动适配器前必读）

### 洛谷（保存于项目记忆，2026-08 实测）
- 题目页已迁移 **LentilleDataResponse** 管线：`_contentOnly=1` 参数**已失效**；必须用请求头 **`x-lentille-request: content-only`** + `Accept: application/json` + `Referer: /problem/{pid}` + 登录 Cookie（GET 无需 x-csrf-token）
- 响应取 `data.currentData.problem`（兼容 `data.problem` / 顶层 `problem`）；`problem.tags` 是 **tag id 数组**（如 P3373 → [42,108,523]）
- tag id → 名称：`GET /_lfe/tags`（无需登录），进程内缓存 + 失败 5 分钟退避
- `record/list` 仍用 `_contentOnly=1` 参数（DataResponse 端点不受影响）
- **C3VK 反爬**：首请求 302 回自身并下发新 C3VK（5 分钟有效），带新值重试即 200；`redirect: 'manual'` 自行处理（否则无限重定向耗尽 fetch 次数抛 `fetch failed`）
- 状态枚举（2019 改版后）：12=AC，13/14=Unaccepted→WA，2=CE，4=MLE，5=TLE，6=WA，7=RE，11/3→RE
- 难度映射：洛谷 0-8 → CF rating（**2026-09-15 已重测并改为** {1:800, 2:1000, 3:1500, 4:1800, 5:2200, 6:2400, 7:2600, 8:3400}；旧值 {1:1000…8:3000} 为拍脑袋估值，已废弃，见下方「平台难度表示」）
- UA 不能含 `python-requests`、不能以 `mozilla/` 开头

### 牛客
- JSON API 已彻底下线（旧端点 301 → HTML）；唯一可行方案：公开页 `acm/contest/profile/{uid}/practice-coding` HTML 表格（9 列：td0=submissionId、td1=题目链接、td2=状态中文、td7=语言、td8=时间），匿名可访问，分页 + 增量
- 首页空行视为结构性变化抛错（防假成功）

### 同步语义
- 换账号（handle 变化或 `last_sync_at` 为 NULL）→ 强制全量重拉 + 同事务清空旧数据；拉取失败绝不丢旧数据
- 同 handle 首次成功同步会覆盖该平台手动导入数据（以平台数据为准）
- 后台续拉：截断（`sync_truncated=1`）后按平台节奏自动续拉，默认 6 轮，可取消；详见下方「后台分批续拉」

### 平台难度表示与统一标尺（2026-09-15 实测，改动难度/适配器前必读）

**唯一真源：`shared/src/difficulty.ts`**。适配器只负责给出平台**原生原文**，统一调用 `difficultyFields()` / `toCfRating()` 得到 CF rating；代码库内**不再有第二份映射表**，平台改档只需改这一个文件。测试：`server/test/difficulty.test.ts`。

| 平台 | 原生字段 | 实测值域 | 映射到 CF rating（800–3500） | 实测依据 |
|---|---|---|---|---|
| codeforces | `problem.rating` | 800–3500，步长 100 | 原值（参考标尺） | 官方 API `problemset.problems`：11401 题 / 11102 有 rating |
| luogu | `problem.difficulty` | **0–8 共 9 档**（0 = 暂无评定） | **800/1000/1500/1800/2200/2400/2600/3400**（取实证各档中位数），0 → null | **737 对实证**：洛谷 `problem/list?type=CF`（10984 道 CF 镜像题）× CF API `problemset.problems` 按题号对齐；各档中位数 800/1000/1500/1800/2200/2400/2600/3400，并与官方公布区间自洽 |
| atcoder | kenkoooo `problem-models.json` 的 IRT `difficulty`（**无官方难度**） | −10000…4383；p50 1317；565 题 `is_experimental`、286 题无值 | 锚点**分段线性**插值，两端钳位 | **349 对实证桥**：洛谷 `type=AT` 镜像（8098 题）× kenkoooo，各洛谷档的 kenkoooo 中位数 ↔ 该档 CF 中位数 |
| nowcoder | 题库页「难度」列 | 200–3700；约 20% 为空（新题） | 原值**直接使用**并钳到 [800,3500]；`0`/空 → null | 官方出题规范直接以 CF rating 规定难度；实测恒为 100 的倍数（`parseNowcoderScore` 只认 200–4000 内 100 的倍数） |
| leetcode | `difficulty` = EASY/MEDIUM/HARD | 3 档（4443 题） | 1000/1500/2100（面试导向，启发式，无官方对照表） | GraphQL `problemsetQuestionList` 结构实测 |
| jisuanke | `difficultyType` = level1…level8 | 8 档，题量 685/675/857/297/306/294/323/124 | 与洛谷**同一张表**（档位名同源一一对应）；非 `levelN` → null | i18n 字典用洛谷档位名（中文）与 CF 称号（英文）；通过率交叉校验一致（51.3/46.6/37.2/30.4 vs 洛谷 47.9/44.3/39.1/36.0） |
| daimayuan | 题目难度 = `pdoc.difficulty`，为 0 时用 Hydro 算法 | 1–10 | 800/900/1000/1200/1400/1600/1800/2000/2200/2400 | Hydro `difficultyAlgorithm` 逐字复算：`round(10 − 13·s·acRate)`；实测与站点显示 441/466 一致（25 处差异均为站点手工设定优先） |
| qoj | **无难度字段**（UOJ 系数据模型） | — | **恒 null**，标度 `none` | 平台确无难度：不猜、不发明 |

**关键结论与陷阱**
- **AtCoder 与 CF 不是加常数**：低段差约 +550、中段约 +100、高段趋于相等 → 必须分段线性（代码里超上端是**沿最后一段斜率外推再钳位**，不是直接返回 3400）。
- **洛谷难度是官方「临时定义」**：`help.luogu.com.cn/manual/luogu/problem/difficulty` 明确标注「临时难度定义」，2026-06 已调整（新增青题「提高」，官方 CF 区间 青 ≈2000-2400 / 蓝 ≈2300-2700 / 紫 ≈2700-3100，区间互相重叠），黑题拆分（NOI / NOI+/CTS）也在计划中 → **不得把 8 写死为档数上限**；官方定稿后映射值需复核（表驱动 + `problems.difficulty_scale` 使重算成本可控）。
- 洛谷 `difficulty=0` 作为**查询参数 = 不筛选**（与缺省、越界 `9` 同义），**不能**用来筛「暂无评定」。
- 计蒜客档位名与洛谷同源，但 **level9 不存在**（实测 `difficultyType=level9` → total 0）；level8 样本仅 124 题（NOI/CTS/IOI 级），不确定性最高。
- **牛客约 20% 题目（多为新题）无难度分** → 显示「未知」；回填管线会重试但仍可能长期为空。
- **QOJ 题目难度恒为 NULL，因此不进入训练计划候选池**（候选池一直排除 `difficulty IS NULL`）。
- 映射为**近似值（±100–200）**，用于训练推荐与弱项分档足够，**不作为精确评级**。
- 原生值一并落库：`problems.native_difficulty`（原文如 `4` / `level6` / `HARD` / `1545`）+ `problems.difficulty_scale`（标度名），由 `importService` / `bankService` / `difficultyBackfill` **三条写库路径**统一写入。

### 题库拉取能力与 AtCoder 标签桥
- 各平台**能拿到什么就拿什么**：牛客解析页面算法标签（`a.tag-label[data-id]`，按 `data-problemId` 定位行——页面有 `colspan`，列索引不可靠）；力扣查询补 `nameTranslated`（**中文标签**）+ `acRate`；代码源改走 `GET /p?page=N` + `Accept: application/json`（`pdocs` 含 title/tag/nSubmit/nAccept/difficulty，难度按 Hydro 算法**本地复算**，不再依赖 HTML）；计蒜客解析行内 `problemTags`（`type=difficulty|knowledge` 双类型，难度标签与算法标签分开）；洛谷新增 `luoguTypes` 以支持拉 CF/AT 镜像；QOJ **不支持拉取题库**（`POST /api/problems/bank` 直接 400：题目列表在 Cloudflare 挑战之后且平台无难度字段）。
- **AtCoder 标签桥**（`enrichTagsFromLuogu`，默认**关**）：拉洛谷 `type=AT` 镜像（pid `AT_abc300_a` → `abc300_a`）建 `atcoder id → 洛谷标签`。**覆盖有限**：实测 250 行样本中 139 行命中 kenkoooo 题号，其中仅 **68 行**真的带标签（自定义比赛号 `AT1202Contest_a` 之类无法映射）→ 不得宣称「全覆盖」。
- 元数据回填（`POST /api/problems/backfill-difficulty`）已扩展到全平台（每平台一个 meta fetcher），目标选择从「difficulty IS NULL」扩展为「difficulty / native_difficulty 为空**或** tags 为空」；QOJ 无来源，跳过并报告。

### 计蒜客练习（题库/自由练题）提交：端点与实测结论
旧适配器**只同步比赛内提交**；2026-09-15 起补上练习提交（`settings['jisuanke.practiceSync']`，**默认开启**，只有字面量 `'false'` 才算关闭；「仅同步最近 N 天」窗口模式**不跑练习段**）。

| 用途 | 端点 | 实测结论 |
|---|---|---|
| 登录态 / uid | `GET /api/user/info` | `{uuid, name, ...}` → `studentUuid` 来源 |
| 练习预筛 | `GET /api/problems?page=N&status=` + `passed` 或 `attempted` | **status 过滤生效**：`passed` total=1、`attempted` total=0、`no-attempt` total=3594；**`statuses[]` / `statuses` 参数无效**（返回全量 3595） |
| 单题练习提交 | `GET /api/problem/submissions?problemId=34486&page=1` | `{submissions:[{hashId, language, status:"AC", time:"2026-09-13 12:37:47", usedTime, usedMemory, passedCases, totalCases}], total}`；`studentUuid` **可省**（用登录身份）；时间是**北京时间字符串**，不是 unix 时间戳（复用 `parseJisuankeTime`） |
| 参赛列表 | `GET /api/contests?page=N&hasParticipated=true` | `{contests:[{contestId,title,startTime,...}], totalContests}`（比赛段沿用） |
| 课程/课节提交 | `/api/challenge/submissions?chapterLessonId=&studentUuid=` | 存在于 SPA，**需课程上下文，本期不做**（路径已记录） |

- `problemKey` 用 **`problemIdentifier`**（如 `T1001`），与题库入库键一致 → 提交与题库行自动合并且难度/标签直接复用；题目 URL `/problem/{identifier}`。
- `externalId` = `hashId`；增量判据：某题第 1 页提交**全部已知且 `total` ≤ 已返回条数** → 1 个请求即跳过该题。
- 分批：单次处理题目数上限（默认 40 题）+ 页数上限；**续拉游标编码**：负数 = 练习题目序号，正数 = 比赛序号。
- 鉴权仍是 Cookie（`s` + `JSKUSS`），`checkAuth` 未变。

### QOJ（qoj.ac）事实
- 提交同步可用（UOJ 系接口，需完整 Cookie + 浏览器 UA，且**必须走 HTTP/1.1**：Cloudflare 对 h2 请求恒定下发托管挑战）。
- **不提供难度**：平台数据模型里没有难度字段 → `difficulty = NULL`，标度 `none`，UI 显示「平台不提供难度」。
- **不支持拉取题库**：`/problems` 恒返回 `403 cf-mitigated: challenge`（需 `cf_clearance`），即便可访问也无难度 → `POST /api/problems/bank` 对 qoj 明确拒绝（400），前端隐藏该项。
- 因难度为空，QOJ 题目**不进入训练计划候选池**。

### 后台分批续拉（`adapters/syncScheduler.ts`）
- 触发：`syncPlatform` 结束时 `truncated === true` 且触发来源为 `manual | all | retry`（**不含** `days` 窗口，也不含 `auto`——续拉自身再截断不注册，避免无限续拉），且平台未禁用、账号未变更。
- 平台节奏（间隔）：`codeforces 20s / atcoder 60s / luogu 45s / nowcoder 90s / jisuanke 90s / daimayuan 60s / leetcode 60s / qoj 90s`。
- 轮数上限：`settings['sync.autoContinueRounds']`，默认 **6**（0 = 关闭，合法范围 0–50，脏值回退默认 6）。
- 互斥/抢占：同平台同时只允许一个同步在跑；用户手动点同步会**取消该平台待执行的续拉**（抢占）。
- 每轮复查账号绑定：`handle` 与当前绑定不一致 → 直接丢弃该任务（否则旧 handle 的一轮会把用户刚做的改绑静默回滚并清空新账号数据）。
- 任一轮失败（尤其 `auth_expired` / `rate_limited`）→ 立即停止该平台续拉；**进程内实现：服务重启后续拉计划丢失**，补全游标 `backfill_page` 已持久化，用户再点一次同步即续上。
- 可取消：`POST /api/sync/auto-continue/cancel`（body `{platform}`）；可见性：`GET /api/sync/status` 每平台给出 `autoContinue: { platform, round, maxRounds, nextAt, running }`（无排期为 `null`），`sync_runs.triggered_by` 记为 `auto`。

---

## 6. 已知问题与后续完善方向

### 技术债 / 小问题
- [x] ~~`client/package.json` 未显式声明 `dayjs`~~（2026-08-14 已显式加入 dependencies）
- [x] ~~仪表盘趋势/弱项只有表格，无图表~~（2026-08-14 已引入 recharts：难度堆叠柱状图、弱项 gap 横向条形图、近 12 周提交/AC 率组合图）
- [ ] `server/config.json` 从未创建（一直用默认配置，日志每次提示）→ 若需自定义端口/DB 路径可从 `config.example.json` 复制
- [x] ~~AI 计划解析依赖模型输出严格 JSON~~（2026-08-14 `parsePlanJson` 已增强：容忍围栏、前后解释文字、尾逗号、畸形任务条目清洗、未知 kind 回退 practice）

### 洛谷/牛客数据源风险
- [ ] 洛谷基于**非官方 API**，平台改版可能随时失效（历史上已改过两次：C3VK 反爬、Lentille 迁移）→ 失效时先查请求头/结构，参考第 5 节
- [x] ~~洛谷 Cookie 会过期（约数周）→ 报"Cookie 无效或已过期"时到设置页更新~~（2026-08-14 已加**预检**：`POST /api/settings/cookies/check` + 设置页「检测 Cookie」按钮，适配器 `checkAuth` 接口请求 `/user/info` 判定登录态，302/非 JSON → 提示重新复制 Cookie；`_uid` cookie 有效期到 2026-09-09，届时需更新）
- [x] ~~牛客无难度/标签字段（数据源限制）~~（2026-09-15 已补齐：题库页可解析算法标签 + 难度分（原值即 CF 量纲）；**但约 20% 题目（多为新题）仍无难度分** → 显示「未知」，见第 5 节「平台难度表示」）
- [ ] 洛谷难度为官方「临时定义」（2026-06 已改过一版、黑题拆分在计划中）→ 官方定稿后**需要复核洛谷/计蒜客映射值**（改 `shared/src/difficulty.ts` 一处即可，原生值已落库可重算）

### 功能扩展路线（README 已规划）
- [x] ~~透明桌面挂件~~（2026-08-15 已落地 **Web 挂件**：`GET /widget` 由 Express 直接服务零依赖单页 `server/src/public/widget.html`——深色毛玻璃卡片、当天任务列表、圆形打卡按钮、连续打卡徽标、每分钟自动刷新跨天切换；浏览器实测渲染/打卡/徽标全通过。**透明置顶桌面壳**仍留后续：Electron 无边框透明窗加载该页即可，零改后端）
- [x] ~~计划编辑（当前只能生成/删除，不能改单条任务）~~（2026-08-14 已实现：`PATCH/DELETE /api/plans/tasks/:taskId` + 计划详情抽屉内的编辑弹窗/删除按钮）
- [ ] 更多平台（如 CodeChef / LibreOJ）——实现 `PlatformAdapter` 接口并在 `adapters/index.ts` 注册即可
- [x] ~~打卡提醒 / 连续打卡天数统计~~（2026-08-14 已实现连续打卡统计：`GET /api/checkins/streak` + 日历页「当前连续/最长连续/累计打卡天数」卡片；2026-08-15 已实现打卡提醒：`POST /api/settings/reminder`（enabled/time 存 settings 表）+ 设置页「打卡提醒」卡片（开关 + TimePicker，开启时请求浏览器通知授权）+ `client/src/Reminder.tsx` 全局检查器挂载于 App.tsx，应用打开期间每 30 秒检查，到点且当天有未打卡任务时发系统通知 + AntD 通知并跳转日历页；当天已标记 localStorage 去重，跨天自动重置；当天全部打卡或无任务不打扰）

---

## 7. 常用命令

```bash
cd C:/Users/33739/Desktop/工作台
npm run dev          # 双端开发（server :3001 + client :5173）
npm run dev:server   # 仅后端（tsx watch）
npm run typecheck    # 双端类型检查
npm test             # server 单元测试（node:test，70+ 用例）
npm run build        # 构建 client

# 手动触发同步（示例）
curl -X POST http://localhost:3001/api/sync/luogu -H "Content-Type: application/json" -d '{"handle":"1892580"}'
```

---

## 8. Git 与隐私

- 仓库私有；推送前已做隐私审计：`server/data/icpc.db`（真实 Cookie/CSRF/账号）、`config.json`、`.reasonix/`、真实 uid（洛谷 1892580 / 牛客 713093328 已替换为占位值）均未推送
- 本地续作流程：`git add -A && git commit -m "..." && git push`
- **注意**：`server/data/icpc.db` 含真实登录 Cookie，切勿解除 gitignore 或分享该文件
