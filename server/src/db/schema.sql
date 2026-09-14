-- ICPC Workbench schema
-- 时间统一存 UTC；submitted_at / completed_at 由应用层写入 ISO8601 字符串，
-- created_at 等默认值用 SQLite datetime('now')。

CREATE TABLE IF NOT EXISTS platforms (
  id              TEXT PRIMARY KEY,            -- codeforces / atcoder / luogu / nowcoder
  name            TEXT NOT NULL,
  has_official_api INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,             -- 本地昵称，默认 'me'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS platform_accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  platform        TEXT NOT NULL REFERENCES platforms(id),
  handle          TEXT NOT NULL,                  -- CF handle / AtCoder 用户名 / 洛谷 uid / 牛客 uid
  last_sync_at    TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  -- 上次同步因触及单次上限而提前停止（分批拉取防封号）；1=仍有更早历史待补全，下次同步进入补全模式
  sync_truncated  INTEGER NOT NULL DEFAULT 0,
  -- 补全模式续拉游标（页码型平台用）：记录已拉到的最深页，下次从此处续拉更早历史，避免从头重扫已知页
  backfill_page   INTEGER,
  UNIQUE (user_id, platform)
);

-- 同步任务历史：每次平台同步一行（成功与失败都记录），供同步中心展示与诊断导出。
-- status: ok=全部成功 / partial=部分成功（预留）/ failed=失败；error_code 为可解释分类
-- （auth_expired / rate_limited / schema_changed / manual_required / network / unknown）。
-- mode: full=换账号全量 / incremental=增量 / backfill=补全 / days=仅最近 N 天窗口。
CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  platform      TEXT NOT NULL REFERENCES platforms(id),
  handle        TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  duration_ms   INTEGER NOT NULL DEFAULT 0,
  imported      INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  waited_ms     INTEGER NOT NULL DEFAULT 0,   -- 限速等待总耗时（分页 sleep + Retry-After）
  mode          TEXT NOT NULL DEFAULT 'incremental',
  status        TEXT NOT NULL DEFAULT 'ok',
  error_code    TEXT,
  error_message TEXT,
  triggered_by  TEXT NOT NULL DEFAULT 'manual', -- manual | retry | days | all
  next_suggested_sync_at TEXT                   -- 按平台节奏推荐的下次同步时间
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_platform ON sync_runs(user_id, platform, started_at);


CREATE TABLE IF NOT EXISTS problems (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  platform    TEXT NOT NULL REFERENCES platforms(id),
  problem_key TEXT NOT NULL,                   -- 平台内唯一标识，如 1919C / abc321_a
  title       TEXT NOT NULL,
  difficulty  INTEGER,                         -- CF rating 统一标尺（洛谷分级 0-8 已映射为 rating；AtCoder 为映射分值）
  url         TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',      -- JSON 数组字符串（写入即净化：噪声标签已过滤 + 同义词已归并）
  -- 难度来源（优先级 manual > backfill > sync > bank）：决定新值能否覆盖已有值，见 import/problemWritePolicy.ts
  difficulty_source TEXT,
  UNIQUE (platform, problem_key)
);
-- 难度过滤/排序（题库页 ORDER BY difficulty、stats 难度分布）在 2 万题规模上依赖此索引
CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems(difficulty);

-- 自建知识点管线（v2）：结构化知识点标注。JSONL（dataDir/knowledge/annotations.jsonl）
-- 为源真相，本表是启动时幂等重建的查询索引。code 锚定 taxonomy.json（稳定不可改）；
-- name 为展示名（重载时按当前 taxonomy 刷新）。source: tag / rule / ai / manual，
-- manual 为人工校正，永不被管线重跑覆盖。confidence < 统计阈值（默认 0.5）的
-- 标注入库但统计端默认过滤。无 FK：表可由 JSONL 独立重建，不随 problems 重播种失效。
-- annotated_title 记录标注当时的题目标题：标题被修复（如牛客标题污染清洗）后
-- 与库内 title 不一致即视为陈旧标注，差量重跑会重新标注。
CREATE TABLE IF NOT EXISTS problem_keypoints (
  platform    TEXT NOT NULL,
  problem_key TEXT NOT NULL,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  confidence  REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  source      TEXT NOT NULL,             -- tag / rule / ai / manual
  method      TEXT NOT NULL,             -- tag / rule#rNNN / ai:<model> / manual
  taxonomy_version INTEGER NOT NULL,
  pipeline_version INTEGER NOT NULL,
  annotated_title TEXT,
  annotated_at TEXT NOT NULL,
  PRIMARY KEY (platform, problem_key, code)
);
CREATE INDEX IF NOT EXISTS idx_problem_keypoints_code ON problem_keypoints(code, confidence);

-- L2 AI 待标注队列：L1 未命中的题入队持久化，批跑中断后续跑。
-- status: pending / done / uncertain（AI 也判不出，不硬贴）/ failed（可重试）
CREATE TABLE IF NOT EXISTS knowledge_queue (
  platform    TEXT NOT NULL,
  problem_key TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (platform, problem_key)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_queue_status ON knowledge_queue(status, enqueued_at);

-- 知识点概念的统计特征（物化缓存）：按难度桶记录每个 code 的覆盖率与信息量。
-- 用途：题源标签存在「低难度题 40% 标贪心」式的膨胀（见清洗重构 spec §2.2），
-- 直接用于弱项判断会稀释信号；本表把「覆盖」与「信息量」分开：
-- 粗概念提供覆盖，informativeness 决定它在下游的权重。
-- bucket 取值与 routes/problems.ts 的 DIFFICULTY_BUCKETS 同口径（含 '未知'）。
-- informativeness 列存原始 1 - H_b(share)，下限 FLOOR 由消费端在取用时施加，
-- 这样表内可保留低于 FLOOR 的实测值，也便于复现 spec §2.2 的表格。
CREATE TABLE IF NOT EXISTS knowledge_concept_stats (
  code            TEXT NOT NULL,
  bucket          TEXT NOT NULL,
  problem_count   INTEGER NOT NULL,
  share           REAL NOT NULL,      -- 该桶内含此 code 的题数 / 该桶总题数
  informativeness REAL NOT NULL,      -- 原始 1 - H_b(share)，由消费端夹到 FLOOR
  computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, bucket)
);
CREATE INDEX IF NOT EXISTS idx_concept_stats_bucket ON knowledge_concept_stats(bucket);

-- 用户声明的卡点（意图信号）。本表是「用户弱项」判断的主证据来源：
-- 题目属性（problem_keypoints）只能说明「这题涉及什么」，且一题多标签是常态
-- （实测 75.7% 的题有 ≥2 个标签），无法归因用户到底哪个知识点不熟。
-- 本表记录用户自己的声明，因此无歧义。
-- code 允许为 NULL：表示非知识点摩擦（读题/实现/看错题），这是有效信号，不应被迫选一个知识点。
CREATE TABLE IF NOT EXISTS submission_intents (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  problem_id INTEGER NOT NULL REFERENCES problems(id),
  code       TEXT,                                  -- taxonomy code；NULL = 非知识点摩擦
  outcome    TEXT NOT NULL,                          -- cant_start / wrong_approach / implementation / slight_bug
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_intents_user_problem ON submission_intents(user_id, problem_id);

CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  platform     TEXT NOT NULL REFERENCES platforms(id),
  problem_id   INTEGER NOT NULL REFERENCES problems(id),
  verdict      TEXT NOT NULL,                  -- AC / WA / TLE / RE / MLE / CE / SKIPPED
  language     TEXT,
  submitted_at TEXT NOT NULL,                  -- ISO8601 UTC
  external_id  TEXT,                           -- 平台侧提交号（去重用）
  UNIQUE (user_id, platform, external_id)
);
CREATE INDEX IF NOT EXISTS idx_submissions_user_platform ON submissions(user_id, platform);
CREATE INDEX IF NOT EXISTS idx_submissions_problem ON submissions(problem_id);
-- 按用户取时间窗提交（能力值近 60 天窗口 / 趋势图）与按时间排序：无此索引时万级提交全表扫
CREATE INDEX IF NOT EXISTS idx_submissions_user_time ON submissions(user_id, submitted_at);

CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  goal        TEXT NOT NULL DEFAULT '',
  start_date  TEXT NOT NULL,                   -- YYYY-MM-DD
  end_date    TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'ai',      -- ai / template / manual
  raw_prompt  TEXT,                            -- AI 原始输出（可回溯）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id    INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  task_date  TEXT NOT NULL,                    -- YYYY-MM-DD（挂件按日查询预留）
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'practice', -- practice / review / topic / contest
  problem_id INTEGER REFERENCES problems(id),
  url        TEXT,                             -- 跳转链接（桌面挂件预留）
  note       TEXT,
  UNIQUE (plan_id, task_date, title)
);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_date ON plan_tasks(task_date);

CREATE TABLE IF NOT EXISTS checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  task_id      INTEGER NOT NULL REFERENCES plan_tasks(id) ON DELETE CASCADE,
  task_date    TEXT NOT NULL,                  -- 冗余存日期，便于按日/月查询（挂件预留）
  completed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id)
);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(task_date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  problem_id       INTEGER NOT NULL REFERENCES problems(id),
  stage            INTEGER NOT NULL DEFAULT 0,     -- 间隔阶梯档位 0..5（1/3/7/14/30/60 天）
  note             TEXT,
  added_at         TEXT NOT NULL DEFAULT (datetime('now')),
  last_reviewed_at TEXT,
  next_due_on      TEXT NOT NULL,                  -- YYYY-MM-DD 下次到期日
  UNIQUE (user_id, problem_id)
);
CREATE INDEX IF NOT EXISTS idx_review_items_due ON review_items(user_id, next_due_on);

CREATE TABLE IF NOT EXISTS template_progress (
  template_id TEXT NOT NULL,                        -- 内置课程模板 id
  user_id     INTEGER NOT NULL REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'todo',         -- todo / learning / mastered
  note        TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  mastered_at TEXT,
  -- 用户自己写入的模板内容（内置条目只给大纲，内容由用户填写）
  code        TEXT,
  idea        TEXT,
  complexity  TEXT,
  url         TEXT,
  PRIMARY KEY (user_id, template_id)
);

CREATE TABLE IF NOT EXISTS custom_templates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  category_key TEXT NOT NULL,                     -- 归入的课程分类 key
  name         TEXT NOT NULL,
  difficulty   INTEGER NOT NULL DEFAULT 3,        -- 1-5
  tags         TEXT NOT NULL DEFAULT '[]',        -- JSON 数组字符串
  code         TEXT NOT NULL DEFAULT '',
  idea         TEXT,
  complexity   TEXT,
  url          TEXT,                              -- 可选：模板出处 / 讲解链接
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT
);


-- 题单整理（issue #4）：导入平台题单并按知识点分类
CREATE TABLE IF NOT EXISTS problem_lists (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_suggestion  TEXT,
  ai_suggestion_at TEXT
);

CREATE TABLE IF NOT EXISTS problem_list_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id     INTEGER NOT NULL REFERENCES problem_lists(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL,
  problem_key TEXT NOT NULL,
  title       TEXT,
  url         TEXT,
  category    TEXT NOT NULL DEFAULT '未分类',
  position    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (list_id, platform, problem_key)
);
CREATE INDEX IF NOT EXISTS idx_problem_list_items_list ON problem_list_items(list_id, category, position);
