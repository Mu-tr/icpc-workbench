# 题库清洗功能重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把知识点清洗模块从「一处概率性猜测」（AI 占 88.4% 点位）改为「可归因、可验证的证据链」——AI 退出，来源收敛为 tag/rule/intent，补齐 taxonomy 粗粒度层并按实测信息量加权，新增用户意图信号，并用留出集 AUC 证明弱项判断有效。

**Architecture:** 三层分工——① `problem_keypoints` 只存**题目属性**（可读来源集合 `('tag','rule','manual')`，一题多 code 为正常态）；② `knowledge_concept_stats` 按难度桶物化每个概念的占比与二元熵信息量，供下游加权；③ 新增 `submission_intents` 存**用户声明**的卡点，使弱项判断不再依赖对题目的归因。AI 链路（`aiClassify.ts` 的 L2 批次、队列重试语义）从清洗链路摘除。

**Tech Stack:** Node 22 + `node:sqlite`（零原生依赖）、Express、TypeScript（tsx 运行）、`node:test` + `node:assert/strict`、React 19 + Vite + Ant Design 5、npm workspaces。

**Spec:** `docs/superpowers/specs/2026-09-13-knowledge-cleaning-redesign.md`

## Global Constraints

- 测试基线：**559 server + 67 client 全绿**（`npm test`；559 为 Task 1/2 完成后的实测值，随每个任务递增）。每个任务结束时测试必须保持全绿。
- 代码风格：既有文件用分号 + 单引号（server），client 用无分号风格；沿用 `commonjs`→ESM `node:` 前缀导入。
- 数据库迁移必须**幂等**：重复打开同一库不产生额外变化（`server/src/db/index.ts` 的 `migrate()` 既有约定）。
- **JSONL 是源真相**：任何对 `problem_keypoints` 的删除都必须在同一事务窗口内向 `data/knowledge/annotations.jsonl` 追加 tombstone 行（`knowledgePoints: []`），且 **append 先于 COMMIT**。只删库不写 tombstone 会导致下次启动重放复活数据。
- 不新增 npm 依赖。
- 所有 taxonomy code 必须存在于 `server/src/knowledge/taxonomy.json`；写库前用 `isValidCode` 校验，非法 code 跳过并计入 gap 报告，**不抛错**。
- **`problem_keypoints` 的「可读来源集合」只有一个权威定义**：`('tag','rule','manual')`。
  禁止在任何读取/统计/验证 SQL 里**漏掉其中的任何一项**（尤其别把 `manual` 落下）——
  那会静默丢弃人工校正，使 UI 上的人工校正失效
  （Task 3 的实现阶段正是踩了这个坑，见其 review 的 F17）。
  `manual` 必须始终可读：`setManualKeypoints` 会先删该题全部行再只写 manual 行，
  读取端若漏掉它就会回退到原始 `p.tags`，等于丢弃用户显式校正。
  该集合若日后变化（例如新增来源），**必须同时更新本行与全部引用处**。
- `confidence` 字段降级为「来源内排序权重」，**不再表示概率**。不得在任何新代码里把它当可信度使用。
- 权重下限 `FLOOR = 0.25`（见 Task 5、Task 6）。
- 每个任务一次 commit，提交信息用 `feat(knowledge):` / `refactor(knowledge):` / `test(knowledge):` 前缀。

---

### Task 1: taxonomy 粗粒度层与同义组

**Files:**
- Modify: `server/src/knowledge/taxonomy.json`（`version` 2→3，往 `points` 数组补 12 个 code）
- Modify: `shared/src/tags.ts`（`TAG_SYNONYM_GROUPS` 补 12 个含 `code` 的同义组）
- Test: `server/test/knowledge-taxonomy.test.ts`（新建）

**Interfaces:**
- Consumes: 无（本任务是一切的基础）
- Produces: 12 个新的合法 taxonomy code，供 Task 2 的映射使用：
  `math.general`、`misc.simulation`、`misc.construction`、`ds.general`、`graph.general`、`tree.general`、`basic.brute-force`、`misc.array`、`misc.counting`、`misc.stack`、`misc.interactive`、`basic.enumeration`

- [ ] **Step 1: 写失败测试**

新建 `server/test/knowledge-taxonomy.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTaxonomy, isValidCode, allPoints } from '../src/knowledge/taxonomy.ts';
import { codeOfTag } from '../../shared/src/index.ts';

/** 本次新增的粗粒度概念：为高频无归属题源标签提供落点 */
const NEW_COARSE_CODES = [
  'math.general', 'misc.simulation', 'misc.construction', 'ds.general',
  'graph.general', 'tree.general', 'basic.brute-force', 'misc.array',
  'misc.counting', 'misc.stack', 'misc.interactive', 'basic.enumeration',
] as const;

test('粗粒度 code 全部存在于 taxonomy 且合法', () => {
  const tax = loadTaxonomy();
  assert.equal(tax.version, 3);
  for (const code of NEW_COARSE_CODES) {
    assert.ok(isValidCode(code), `${code} 应在 taxonomy 中`);
  }
});

test('粗粒度 name 唯一（不得与既有细粒度概念重名）', () => {
  const names = allPoints().map((p) => p.name);
  assert.equal(new Set(names).size, names.length, 'taxonomy 内存在重名知识点');
});

test('高频题源标签能映射到粗粒度 code', () => {
  const cases: Array<[string, string]> = [
    ['数学', 'math.general'],
    ['模拟', 'misc.simulation'],
    ['构造', 'misc.construction'],
    ['数据结构', 'ds.general'],
    ['图论', 'graph.general'],
    ['树上算法', 'tree.general'],
    ['brute force', 'basic.brute-force'],
    ['array', 'misc.array'],
    ['counting', 'misc.counting'],
    ['stack', 'misc.stack'],
    ['交互', 'misc.interactive'],
    ['枚举', 'basic.enumeration'],
  ];
  for (const [tag, code] of cases) {
    assert.equal(codeOfTag(tag), code, `${tag} 应映射到 ${code}`);
  }
});

test('粗粒度同义组覆盖常见中英变体', () => {
  for (const tag of ['数学', '数论与组合数学', 'mathematics', 'math']) {
    assert.equal(codeOfTag(tag), 'math.general', `${tag} 应归入数学粗类`);
  }
  for (const tag of ['brute force', 'brute-force', '暴力', '暴力枚举']) {
    assert.equal(codeOfTag(tag), 'basic.brute-force', `${tag} 应归入暴力枚举`);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx tsx --test test/knowledge-taxonomy.test.ts`
Expected: FAIL —— `tax.version` 期望 3 实得 2；`isValidCode('math.general')` 为 false；`codeOfTag('数学')` 为 undefined。

- [ ] **Step 3: 在 taxonomy.json 补 12 个 point**

把 `"version": 2` 改为 `"version": 3`。然后按分类把下列对象插入对应 `category.points` 数组尾部（`templateIds` 留空数组——粗粒度概念不挂课程模板）：

| 归入分类 key | 要插入的 point |
| --- | --- |
| `math` | `{"code":"math.general","name":"数学（综合）","fullName":"数学（综合，未细分）","templateIds":[]}` |
| `misc` | `{"code":"misc.simulation","name":"模拟","fullName":"模拟（按题意逐步实现）","templateIds":[]}` |
| `misc` | `{"code":"misc.construction","name":"构造","fullName":"构造（构造性证明/方案）","templateIds":[]}` |
| `ds` | `{"code":"ds.general","name":"数据结构（综合）","fullName":"数据结构（综合，未细分）","templateIds":[]}` |
| `graph` | `{"code":"graph.general","name":"图论（综合）","fullName":"图论（综合，未细分）","templateIds":[]}` |
| `tree` | `{"code":"tree.general","name":"树上算法（综合）","fullName":"树上算法（综合，未细分）","templateIds":[]}` |
| `basic` | `{"code":"basic.brute-force","name":"暴力枚举","fullName":"暴力枚举（穷举所有候选）","templateIds":[]}` |
| `misc` | `{"code":"misc.array","name":"数组与实现","fullName":"数组与实现细节","templateIds":[]}` |
| `misc` | `{"code":"misc.counting","name":"计数","fullName":"计数（方案数/统计）","templateIds":[]}` |
| `misc` | `{"code":"misc.stack","name":"栈","fullName":"栈（含括号匹配/表达式）","templateIds":[]}` |
| `misc` | `{"code":"misc.interactive","name":"交互","fullName":"交互题","templateIds":[]}` |
| `basic` | `{"code":"basic.enumeration","name":"枚举","fullName":"枚举（含子集/排列枚举）","templateIds":[]}` |

- [ ] **Step 4: 在 tags.ts 补同义组**

在 `TAG_SYNONYM_GROUPS` 数组末尾（`{ name: '交互', ... }` 之后）追加。注意必须带上 `code`，否则 `codeOfTag` 返回 undefined：

```ts
  // ---------- 粗粒度层（为高频但无法细分的题源标签提供落点，见清洗重构 spec §2.1） ----------
  { name: '数学（综合）', code: 'math.general', tags: ['数学（综合）', '数学', 'mathematics', 'math', 'maths'] },
  { name: '模拟', code: 'misc.simulation', tags: ['模拟', 'simulation', 'implement', 'implementation'] },
  { name: '构造', code: 'misc.construction', tags: ['构造', '构造题', 'constructive', 'constructive algorithms', 'construction'] },
  { name: '数据结构（综合）', code: 'ds.general', tags: ['数据结构（综合）', '数据结构', 'data structures', 'data structure'] },
  { name: '图论（综合）', code: 'graph.general', tags: ['图论（综合）', '图论', 'graphs', 'graph'] },
  { name: '树上算法（综合）', code: 'tree.general', tags: ['树上算法（综合）', '树上算法', 'trees', 'tree'] },
  { name: '暴力枚举', code: 'basic.brute-force', tags: ['暴力枚举', '暴力', 'brute force', 'brute-force', 'bruteforce'] },
  { name: '数组与实现', code: 'misc.array', tags: ['数组与实现', 'array', 'arrays'] },
  { name: '计数', code: 'misc.counting', tags: ['计数', 'counting', 'count'] },
  { name: '栈', code: 'misc.stack', tags: ['栈', 'stack', 'stacks'] },
  { name: '交互', code: 'misc.interactive', tags: ['交互', '交互题', 'interactive', 'interactive problem'] },
  { name: '枚举', code: 'basic.enumeration', tags: ['枚举', 'enumeration', 'enumerate'] },
```

> **注意**：`{ name: '交互', tags: [...] }`（无 code）在本文件约 180 行**已存在**。Step 3 给 `交互` 赋予了 `misc.interactive`。因此必须**修改既有那一组**加上 `code: 'misc.interactive'`，而**不是**新增第二组 —— 否则 `GROUP_BY_NAME` 里同名组会互相覆盖，`codeOfTag('交互')` 结果不确定。修改既有行为：
> ```ts
> { name: '交互', code: 'misc.interactive', tags: ['交互', '交互题', 'interactive', 'interactive problem'] },
> ```
> 并从上面追加的清单里删掉重复的「交互」那一行。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd server && npx tsx --test test/knowledge-taxonomy.test.ts`
Expected: PASS（4 个测试全绿）

- [ ] **Step 6: 跑全量测试确认无回归**

Run: `cd "D:\01-代码项目\工作台" && npm test`
Expected: 538 server + 67 client 全绿。若 `server/test/tags.test.ts` 因新增同义组而断言数量失败，更新该断言的实际期望值（而非放宽断言）。

- [ ] **Step 7: Commit**

```bash
git add server/src/knowledge/taxonomy.json shared/src/tags.ts server/test/knowledge-taxonomy.test.ts
git commit -m "feat(knowledge): taxonomy 补 12 个粗粒度概念与同义组（v2→v3）"
```

---

### Task 2: 题源标签 → 知识点 code 映射

**Files:**
- Create: `server/src/knowledge/tagAnnotate.ts`
- Modify: `server/src/knowledge/pipeline.ts`（在 `annotateProblemsL1` 内并联 tag 来源）
- Test: `server/test/knowledge-tag-annotate.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的粗粒度 code 与 `codeOfTag`（来自 `shared/src/index.ts`）
- Produces:
  - `tagsToCodes(rawTags: string[]): string[]` —— 去重、保序、过滤非法 code
  - `annotateProblemsFromTags(db, rows, opts): { scanned: number; annotated: number; unmappedTags: string[] }`
  - `interface TagRow { platform: string; problemKey: string; tags: string }`

- [ ] **Step 1: 写失败测试**

新建 `server/test/knowledge-tag-annotate.test.ts`：

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { tagsToCodes, annotateProblemsFromTags } from '../src/knowledge/tagAnnotate.ts';

let db: Db;
beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

test('tagsToCodes: 映射已知标签、归并别名、跳过无法映射的噪声', () => {
  assert.deepEqual(tagsToCodes(['二分查找']), ['basic.binary-search']);
  // dp 与 动态规划 归并到同一 code，去重后只留一个
  assert.deepEqual(tagsToCodes(['dp', '动态规划']), ['dp.general']);
  // 无法映射的标签被跳过，但不影响其它标签
  assert.deepEqual(tagsToCodes(['数学', '某不存在的标签']), ['math.general']);
  assert.deepEqual(tagsToCodes([]), []);
});

test('tagsToCodes: 多标签全部保留（不压缩为单一标签）', () => {
  const codes = tagsToCodes(['贪心', '动态规划', '排序']);
  assert.equal(codes.length, 3);
  assert.ok(codes.includes('basic.greedy'));
  assert.ok(codes.includes('dp.general'));
  assert.ok(codes.includes('misc.sorting'));
});

test('annotateProblemsFromTags: 落库为 source=tag，且不改写已有 rule 标注', () => {
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','1A','T',1500,'[]')").run();
  const r = annotateProblemsFromTags(db, [
    { platform: 'codeforces', problemKey: '1A', tags: JSON.stringify(['贪心', '排序']) },
  ], { dataDir: null });
  assert.equal(r.scanned, 1);
  assert.equal(r.annotated, 1);
  const rows = db.prepare(
    "SELECT code, source FROM problem_keypoints WHERE platform='codeforces' AND problem_key='1A' ORDER BY code",
  ).all() as Array<{ code: string; source: string }>;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.source === 'tag'));
});

test('annotateProblemsFromTags: 无法映射的标签进 unmappedTags 供缺口报告', () => {
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','2B','T',1500,'[]')").run();
  const r = annotateProblemsFromTags(db, [
    { platform: 'codeforces', problemKey: '2B', tags: JSON.stringify(['这是未收录标签']) },
  ], { dataDir: null });
  assert.equal(r.annotated, 0);
  assert.deepEqual(r.unmappedTags, ['这是未收录标签']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd server && npx tsx --test test/knowledge-tag-annotate.test.ts`
Expected: FAIL —— `Cannot find module '../src/knowledge/tagAnnotate.ts'`

- [ ] **Step 3: 实现 tagAnnotate.ts**

```ts
/**
 * 题源标签 → 知识点 code（source='tag'）。
 *
 * 与 L1 规则层并列：规则读标题（确定性），本层读题源标签（人工维护、含噪）。
 * 两者都只产出**题目属性**，多 code 是正常态，不再压缩为单一标签
 * （见 docs/superpowers/specs/2026-09-13-knowledge-cleaning-redesign.md §1）。
 *
 * 注意：本层不做任何「可信度」判断。题源标签的膨胀问题（低难度题 40% 标贪心）
 * 由 knowledge_concept_stats 的信息量权重在下游处理，不在此处过滤。
 */
import type { Db } from '../db/index.ts';
import { codeOfTag } from '../../../shared/src/index.ts';
import { isValidCode } from './taxonomy.ts';
import { appendAnnotations, effectiveDataDir, writeAnnotationsToDb, type AnnotationWrite } from './store.ts';

export interface TagRow {
  platform: string;
  problemKey: string;
  /** problems.tags 的 JSON 数组字符串 */
  tags: string;
}

/** 原始标签数组 → 去重且保序的合法 code 列表 */
export function tagsToCodes(rawTags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tag of rawTags) {
    const code = codeOfTag(tag);
    if (code === undefined || !isValidCode(code)) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export interface TagAnnotateResult {
  scanned: number;
  annotated: number;
  /** 本批无法映射到任何 code 的原始标签（去重） */
  unmappedTags: string[];
}

/**
 * 批量为题目写入 tag 来源标注。
 * 已有人工标注（source='manual'）的题整题跳过（人工置顶）；
 * 已有 tag 标注的题跳过（增量语义）。
 */
export function annotateProblemsFromTags(
  db: Db,
  rows: TagRow[],
  opts: { dataDir?: string | null } = {},
): TagAnnotateResult {
  const hasManual = db.prepare(
    "SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'manual' LIMIT 1",
  );
  const hasTag = db.prepare(
    "SELECT 1 FROM problem_keypoints WHERE platform = ? AND problem_key = ? AND source = 'tag' LIMIT 1",
  );

  const writes: AnnotationWrite[] = [];
  const unmapped = new Set<string>();
  let scanned = 0;

  for (const row of rows) {
    if (hasManual.get(row.platform, row.problemKey)) continue;
    if (hasTag.get(row.platform, row.problemKey)) continue;
    scanned += 1;

    let raw: string[] = [];
    try {
      const parsed = JSON.parse(row.tags) as unknown;
      if (Array.isArray(parsed)) raw = parsed.filter((t): t is string => typeof t === 'string');
    } catch {
      raw = [];
    }

    const codes = tagsToCodes(raw);
    if (codes.length === 0) {
      for (const t of raw) if (codeOfTag(t) === undefined) unmapped.add(t);
      continue;
    }
    // 落库 confidence 固定 1：本字段已降级为「来源内排序权重」，不再是可信度
    writes.push({
      platform: row.platform,
      problemKey: row.problemKey,
      source: 'tag',
      points: codes.map((code) => ({ code, confidence: 1, method: 'tag' })),
    });
  }

  const result = writeAnnotationsToDb(db, writes);
  const dataDir = effectiveDataDir(opts.dataDir);
  if (dataDir) appendAnnotations(dataDir, result.lines);
  return { scanned, annotated: result.written, unmappedTags: [...unmapped] };
}
```

> **实现前必读（已核实）**：`store.ts` 的 `writeAnnotationsToDb` **不自带事务** —— 它只做 `delSameSource` + `insert` 并返回 JSONL 行，事务由调用方负责（`annotateProblemsL1` 就是这么做的）。
> 因此 `annotateProblemsFromTags` 必须自行包裹：
> ```ts
>   db.exec('BEGIN');
>   try {
>     const result = writeAnnotationsToDb(db, writes);
>     const dataDir = effectiveDataDir(opts.dataDir);
>     if (dataDir) appendAnnotations(dataDir, result.lines);  // 源真相：append 必须在 COMMIT 之前
>     db.exec('COMMIT');
>     return { scanned, annotated: result.written, unmappedTags: [...unmapped] };
>   } catch (e) {
>     db.exec('ROLLBACK');
>     throw e;
>   }
> ```
> 另外 `writeAnnotationsToDb` 会对每个 write **先 `DELETE ... AND source = ?` 再插入**（重跑语义）。
> 这在 `source='tag'` 下是正确且幂等的（同题同源旧行整体替换）。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd server && npx tsx --test test/knowledge-tag-annotate.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 并联进 L1 钩子**

在 `server/src/knowledge/pipeline.ts` 的 `annotateProblemsL1` 中，于现有 `writeAnnotationsToDb(db, writes)` 调用之后、`appendAnnotations` 之前，并联 tag 标注。**输入需要 tags 字段**，因此把 `ProblemRow` 扩为可选 `tags?: string`，并在 `runRulePass` 的两个 SELECT 里补 `p.tags`：

```ts
interface ProblemRow {
  platform: string;
  problem_key: string;
  title: string;
  /** 题源标签 JSON（tag 来源标注用；缺省视为无标签） */
  tags?: string;
}
```

在 `annotateProblemsL1` 内、`const result = writeAnnotationsToDb(db, writes);` 之前插入：

```ts
    // tag 来源与 rule 来源并联：两者互相独立（rule 已有标注的题仍可能有 tag 标注）
    const tagWrites = rows
      .filter((r) => r.tags !== undefined && r.tags !== '[]')
      .map((r) => ({ platform: r.platform, problemKey: r.problemKey, tags: r.tags! }));
    const tagResult = annotateProblemsFromTags(db, tagWrites, { dataDir: null });
```

> 传入 `{ dataDir: null }`：JSONL 只在外层 `appendAnnotations` 统一追加，避免同一事务窗口内追加两次。
> 相应地 `annotateProblemsFromTags` 返回的 `unmappedTags` 暂时丢弃（Task 10 的缺口报告改为直接查库聚合，不依赖这里的返回值）。`L1RunResult` 增加 `tagAnnotated: number` 字段并把 `tagResult.annotated` 填入。

- [ ] **Step 6: 跑全量测试**

Run: `cd "D:\01-代码项目\工作台" && npm test`
Expected: 全绿。既有 `server/test/knowledge-rules.test.ts` 若因 `L1RunResult` 新字段而断言失败，补上 `tagAnnotated` 期望值。

- [ ] **Step 7: Commit**

```bash
git add server/src/knowledge/tagAnnotate.ts server/src/knowledge/pipeline.ts server/test/knowledge-tag-annotate.test.ts
git commit -m "feat(knowledge): 题源标签 → 知识点 code 映射并联进 L1 钩子"
```

---

### Task 3: 读取路径改为二来源（摘除 AI 与 v1 分支）

**Files:**
- Modify: `server/src/knowledge/store.ts`（`knowledgeTagsSql` / `problemKeypointsCte` / `knowledgeTagsJoinSql` / `knowledgeTagsExpr`）
- Test: `server/test/knowledge-store.test.ts`（既有文件，追加用例）

**Interfaces:**
- Consumes: Task 2 产生的 `source='tag'` 标注
- Produces: 四个导出函数**签名不变**（`knowledgeTagsSql(db): string`、`problemKeypointsCte(db): string`、`knowledgeTagsJoinSql(): string`、`knowledgeTagsCoalesceSql(): string`、`knowledgeTagsExpr(): string`），保证 `stats.ts:72`、`reviews.ts:44`、`today.ts:38`、`problems.ts` 5 处 CTE 调用无需改动。

- [ ] **Step 1: 写失败测试**

在 `server/test/knowledge-store.test.ts` 追加：

```ts
test('读取路径只认 tag/rule，忽略 ai 与 v1 problem_topics', () => {
  const db = createDb(':memory:');
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (1,'codeforces','1A','T',1500,'[\"题源标签\"]')").run();
  // v1 遗留层有数据，但不得再被读取
  db.prepare("INSERT INTO problem_topics (problem_id,topic_id,confidence,method,pipeline_version) VALUES (1,'v1主题',1,'manual','x')").run();
  // ai 标注存在，也不得再被读取
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','1A','basic.greedy','贪心',1,'ai','ai',1,1,'2026-01-01')`).run();
  const row = db.prepare(`SELECT ${knowledgeTagsSql(db)} FROM problems p WHERE p.id = 1`).get() as { tags: string };
  // 无 tag/rule 标注 → 回退到题源 tags（既不是 v1 主题，也不是 ai 标注）
  assert.deepEqual(JSON.parse(row.tags), ['题源标签']);
  db.close();
});

test('tag 与 rule 标注并存时全部返回（多 code 不压缩）', () => {
  const db = createDb(':memory:');
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (2,'codeforces','2B','T',1500,'[]')").run();
  const ins = db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','2B',?,?,1,?,'x',1,1,'2026-01-01')`);
  ins.run('basic.greedy', '贪心', 'tag');
  ins.run('dp.general', '动态规划', 'rule');
  const row = db.prepare(`SELECT ${knowledgeTagsSql(db)} FROM problems p WHERE p.id = 2`).get() as { tags: string };
  assert.deepEqual(JSON.parse(row.tags).sort(), ['dp.general', 'basic.greedy'].sort());
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/knowledge-store.test.ts`
Expected: FAIL —— 第一个测试实际拿到 `["v1主题"]` 或 `["贪心"]`（取决于 v1 分支顺序），第二个测试只拿到两个中的一部分。

- [ ] **Step 3: 改 store.ts 的四个函数**

替换 `knowledgeTagsSql`（保留函数签名）：

```ts
/**
 * 知识点读取路径（**唯一实现**，调用处的题目表别名必须是 p）。
 *
 * 二来源：problem_keypoints 中 source IN ('tag','rule','manual') 的标注，按 code 去重后聚合；
 * 无标注则回退题源 tags（已净化的原始值，供审计与兜底）。
 *
 * 已摘除两个分支（清洗重构 spec §1.3）：
 * - `source='ai'`：AI 已退出清洗模块，不再参与任何统计
 * - `problem_topics`（v1 遗留层）：表仍在（写入路径未动），但不再被读取
 *
 * confidence 不再作为可信度门槛（该字段已降级为来源内排序权重）；
 * 因此本函数不再读取知识库阈值设置。
 */
export function knowledgeTagsSql(_db: Db): string {
  return (
    'CASE WHEN EXISTS (SELECT 1 FROM problem_keypoints pk WHERE pk.platform = p.platform ' +
    "AND pk.problem_key = p.problem_key AND pk.source IN ('tag','rule','manual')) " +
    'THEN (SELECT json_group_array(pk2.name) FROM problem_keypoints pk2 WHERE pk2.platform = p.platform ' +
    "AND pk2.problem_key = p.problem_key AND pk2.source IN ('tag','rule','manual')) " +
    'ELSE p.tags END AS tags'
  );
}
```

把 `problemKeypointsCte` 改为只聚合两来源、只建 `pk`（删掉 `pt` CTE）：

```ts
/**
 * knowledgeTagsSql 同一口径的 CTE 版本：把标注侧预聚合成按题一行的小派生表，
 * 再由调用方 LEFT JOIN —— 避免标量子查询逐行重跑（题库 2 万题时的主要开销）。
 * 用法：`WITH ${problemKeypointsCte(db)} SELECT ... ${knowledgeTagsCoalesceSql()} FROM problems p ${knowledgeTagsJoinSql()}`
 */
export function problemKeypointsCte(_db: Db): string {
  return (
    "pk AS (SELECT platform, problem_key, json_group_array(name) AS tags FROM problem_keypoints " +
    "WHERE source IN ('tag','rule','manual') GROUP BY platform, problem_key)"
  );
}

/** problemKeypointsCte 对应的 FROM 附加子句 */
export function knowledgeTagsJoinSql(): string {
  return 'LEFT JOIN pk ON pk.platform = p.platform AND pk.problem_key = p.problem_key';
}

/**
 * 二来源回退的 tags 列（配合 knowledgeTagsJoinSql 使用），别名必须为 p。
 * ⚠️ 仅返回题源 tags 回退值 —— pk 侧的名称数组在调用方需另行透传，
 * 本函数保留 `AS tags` 形态以兼容既有 problems.ts 用法。
 */
export function knowledgeTagsCoalesceSql(): string {
  return `${knowledgeTagsExpr()} AS tags`;
}

/** 同上但**不带 AS 别名**：供 json_each(...) 等需要表达式的场景使用 */
export function knowledgeTagsExpr(): string {
  return 'COALESCE(pk.tags, p.tags)';
}
```

> **重要**：`pk.tags` 是名称数组（`json_group_array(name)`），`p.tags` 是题源原始标签——两者**语义不同但都是「标签字符串数组」**，这正是既有实现的既有行为（原 `knowledgeTagsSql` 也是返回 name 数组或原始 tags），保持不动。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && npx tsx --test test/knowledge-store.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全量测试**

Run: `cd "D:\01-代码项目\工作台" && npm test`
Expected: 全绿。若 `server/test/mastery.test.ts` / `analysis.test.ts` 因口径变化失败，**逐个核对是测试期望过时还是实现有错**——若属前者，按新口径（不再有 v1/ai 分支）更新期望值。

- [ ] **Step 6: Commit**

```bash
git add server/src/knowledge/store.ts server/test/knowledge-store.test.ts
git commit -m "refactor(knowledge): 读取路径收敛为 tag/rule 二来源，摘除 ai 与 v1 分支"
```

---

### Task 4: 清理 AI 标注的幂等迁移

**Files:**
- Modify: `server/src/db/index.ts`（`migrate()` 内新增 `purgeAiAnnotations(db)`）
- Modify: `server/src/knowledge/store.ts`（新增 `readLatestSnapshots`，仅测试用）
- Modify: `server/test/knowledge-ai.test.ts` → **删除该文件**（它测的是已被摘除的 AI 链路）
- Test: `server/test/knowledge-purge-ai.test.ts`（新建）

**Interfaces:**
- Consumes: Task 3 已使 `ai` 标注不再被读取
- Produces: `purgeAiAnnotations(db: Db, opts?: { dataDir?: string | null }): { deleted: number; tombstones: number }`（从 `db/index.ts` 导出以便测试单独调用）

- [ ] **Step 1: 写失败测试**

新建 `server/test/knowledge-purge-ai.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';
import { purgeAiAnnotations } from '../src/db/index.ts';
import { loadAnnotationsIntoDb, annotationsPath } from '../src/knowledge/store.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'purge-ai-'));
}

function seedAi(db: ReturnType<typeof createDb>, key: string): void {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT OR IGNORE INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,'T',1500,'[]')").run(key);
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,'basic.greedy','贪心',0.8,'ai','ai',1,1,'2026-01-01')`).run(key);
}

test('purgeAiAnnotations: 删除全部 ai 点位（含 ai:manual-import）', () => {
  const db = createDb(':memory:');
  seedAi(db, '1A');
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','1A','misc.sorting','排序',0.9,'ai','ai:manual-import',1,1,'2026-01-01')`).run();
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','1A','dp.general','动态规划',0.9,'rule','rule#r001',1,1,'2026-01-01')`).run();

  const r = purgeAiAnnotations(db, { dataDir: null });
  assert.equal(r.deleted, 2, '两条 ai 点位都应删除');
  const left = db.prepare("SELECT source FROM problem_keypoints WHERE platform='codeforces' AND problem_key='1A'").all() as Array<{ source: string }>;
  assert.deepEqual(left.map((x) => x.source), ['rule'], 'rule 标注必须保留');
  db.close();
});

test('purgeAiAnnotations: 幂等 —— 重复执行不再产生变化', () => {
  const db = createDb(':memory:');
  seedAi(db, '2B');
  const first = purgeAiAnnotations(db, { dataDir: null });
  assert.equal(first.deleted, 1);
  const second = purgeAiAnnotations(db, { dataDir: null });
  assert.equal(second.deleted, 0);
  assert.equal(second.tombstones, 0);
  db.close();
});

test('purgeAiAnnotations: 写 JSONL tombstone 后重放不再复活 ai 标注', () => {
  const dir = tmpDir();
  const db = createDb(':memory:');
  seedAi(db, '3C');
  const r = purgeAiAnnotations(db, { dataDir: dir });
  assert.equal(r.tombstones, 1);

  // 模拟重启：新建库（schema 自带迁移会再次 purge，故先确认 JSONL 重放结果）
  const db2 = createDb(':memory:');
  seedAi(db2, '3C');
  db2.prepare("DELETE FROM problem_keypoints WHERE source='ai'").run();
  const loaded = loadAnnotationsIntoDb(db2, dir);
  assert.equal(loaded.inserted, 0, 'JSONL 里的 ai tombstone 不应让任何标注复活');
  const rows = db2.prepare("SELECT COUNT(*) AS c FROM problem_keypoints WHERE source='ai'").get() as { c: number };
  assert.equal(rows.c, 0);
  db2.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/knowledge-purge-ai.test.ts`
Expected: FAIL —— `purgeAiAnnotations` 未导出（`SyntaxError: The requested module does not provide an export named 'purgeAiAnnotations'`）

- [ ] **Step 3: 实现 purgeAiAnnotations**

在 `server/src/db/index.ts` 顶部补导入（注意 `store.ts` 已 import `db/index.ts` 的 `Db` 类型，**类型循环不构成运行时循环**，但为安全起见在这里只做函数内动态 import 也可；优先直接静态 import，若 `npx tsx` 运行时报 circular initialization 错，则改为函数内 `await import` 并让函数变成 async）：

```ts
import { appendAnnotations, effectiveDataDir, initKnowledgeStore, tombstoneLine } from '../knowledge/store.ts';
```

在 `migrate(db)` 末尾（`fixLuoguTimestamps(db)` 之后）加一行：

```ts
  // v0.6: AI 退出知识点清洗模块 —— 清理历史 AI 标注（幂等）
  purgeAiAnnotations(db);
```

并在同文件实现：

```ts
/**
 * v0.6 迁移：AI 退出知识点清洗模块，删除全部 source='ai' 的标注。
 *
 * ⚠️ 必须同时向 JSONL 源真相追加 tombstone 行：loadAnnotationsIntoDb 在启动时按
 * 「题 × 来源取最后一行」重放，只删库不写 tombstone 会让 AI 标注在下次启动复活。
 *
 * 返回删除的点位数与写入的 tombstone 行数（供测试与日志）。
 */
export function purgeAiAnnotations(
  db: Db,
  opts: { dataDir?: string | null } = {},
): { deleted: number; tombstones: number } {
  const rows = db
    .prepare("SELECT DISTINCT platform, problem_key FROM problem_keypoints WHERE source = 'ai'")
    .all() as unknown as Array<{ platform: string; problem_key: string }>;
  if (rows.length === 0) return { deleted: 0, tombstones: 0 };

  db.exec('BEGIN');
  try {
    const info = db.prepare("DELETE FROM problem_keypoints WHERE source = 'ai'").run();
    const dataDir = opts.dataDir === undefined ? effectiveDataDir() : opts.dataDir;
    if (dataDir) {
      appendAnnotations(dataDir, rows.map((r) => tombstoneLine(r.platform, r.problem_key, 'ai')));
    }
    db.exec('COMMIT');
    return { deleted: Number(info.changes ?? 0), tombstones: dataDir ? rows.length : 0 };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
```

> **注意**：`tombstoneLine` 内部调用 `loadTaxonomy().version` 与 `CURRENT_PIPELINE_VERSION`。在 `createDb` → `migrate` 的时序下，`setCurrentPipelineVersion` 已由 `pipeline.ts` 模块加载时设定，但 `migrate` 可能在 `pipeline.ts` 被 import 之前运行。若报 `CURRENT_PIPELINE_VERSION` 未初始化或 taxonomy 读取失败，**回退方案**：把 purge 从 `migrate()` 移出，改在 `server/src/index.ts` 的 `initKnowledgeStore(config.dataDir)` 之后显式调用一次 `purgeAiAnnotations(db, { dataDir: config.dataDir })`。两种放置都必须保证幂等与 tombstone 写入。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && npx tsx --test test/knowledge-purge-ai.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 5: 删除已失效的 AI 测试文件**

Run: `git rm server/test/knowledge-ai.test.ts`
理由：它测试 `runAiPass` / 队列重试 / `importAiResults` 等已被摘除的链路。**Task 9 会补回等价的 tag 映射测试覆盖**，不保留失效断言。

- [ ] **Step 6: 跑全量测试**

Run: `cd "D:\01-代码项目\工作台" && npm test`
Expected: 全绿（测试总数会因删除 `knowledge-ai.test.ts` 而下降，这是预期的）。

- [ ] **Step 7: Commit**

```bash
git add server/src/db/index.ts server/src/knowledge/store.ts server/test/knowledge-purge-ai.test.ts
git rm --cached server/test/knowledge-ai.test.ts 2>/dev/null || true
git commit -m "feat(knowledge): AI 标注清理迁移（幂等 + JSONL tombstone 防复活）"
```

---

### Task 5: 概念统计与信息量权重计算

**Files:**
- Create: `server/src/knowledge/conceptStats.ts`
- Modify: `server/src/db/schema.sql`（新增 `knowledge_concept_stats` 表）
- Test: `server/test/knowledge-concept-stats.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `tag` 标注、Task 1 的粗粒度 code
- Produces:
  - `informativeness(p: number): number` —— 二元熵归一化到 [0,1]
  - `INFORMATIVENESS_FLOOR = 0.25`
  - `recomputeConceptStats(db: Db): number` —— 重算并落库，返回写入行数
  - `conceptStatsFor(db: Db, bucket: string): Map<string, number>` —— 取某难度桶的 code → informativeness
  - `informativenessFor(db: Db, bucket: string, code: string): number` —— 单点查询，缺省返回 1

- [ ] **Step 1: 写失败测试**

新建 `server/test/knowledge-concept-stats.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db/index.ts';
import {
  informativeness, INFORMATIVENESS_FLOOR, recomputeConceptStats, conceptStatsFor, informativenessFor,
} from '../src/knowledge/conceptStats.ts';

test('informativeness: 二元熵形态 —— p=0.5 最高、p→0/1 趋零、并夹到下限', () => {
  assert.equal(informativeness(0.5), 1);
  assert.equal(informativeness(1), 0);
  assert.equal(informativeness(0), 0);
  // 24.8%（数学粗类实测占比）应显著低于 0.5
  const math = informativeness(0.248);
  assert.ok(math > 0 && math < 0.2, `数学粗类信息量应接近 0，实得 ${math}`);
  // 5.9%（数论）明显高于粗类
  assert.ok(informativeness(0.059) > math, '细粒度概念信息量应高于粗类');
  // 下限夹取
  assert.equal(Math.max(INFORMATIVENESS_FLOOR, informativeness(0.01)), INFORMATIVENESS_FLOOR);
});

test('recomputeConceptStats: 按难度桶物化占比与信息量', () => {
  const db = createDb(':memory:');
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  const insP = db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,'T',?,'[]')");
  for (let i = 0; i < 4; i += 1) insP.run(`P${i}`, 1500);
  const insK = db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,?,'n',1,'tag','tag',1,1,'2026-01-01')`);
  // 贪心覆盖 3/4 = 0.75（低信息量），排序覆盖 1/4 = 0.25
  insK.run('P0', 'basic.greedy'); insK.run('P1', 'basic.greedy'); insK.run('P2', 'basic.greedy');
  insK.run('P3', 'misc.sorting');

  const written = recomputeConceptStats(db);
  assert.ok(written >= 2);
  const stats = conceptStatsFor(db, '1400-1599');
  assert.ok((stats.get('basic.greedy') ?? 1) < (stats.get('misc.sorting') ?? 0),
    '覆盖 75% 的贪心信息量应低于覆盖 25% 的排序');
  assert.equal(informativenessFor(db, '1400-1599', 'basic.greedy'), Math.max(INFORMATIVENESS_FLOOR, stats.get('basic.greedy')!));
  // 未知 code 缺省权重 1（不过度惩罚未统计到的概念）
  assert.equal(informativenessFor(db, '1400-1599', '不存在的code'), 1);
  db.close();
});

test('recomputeConceptStats: 按难度桶分层 —— 同一 code 在不同桶得到不同信息量', () => {
  // spec §2.3：膨胀是难度相关的。同一「贪心」在低难度桶占比高（低信息量）、
  // 在 2200+ 桶占比低（较高信息量），两个桶必须分别统计，不可混算。
  const db = createDb(':memory:');
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  const insP = db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,? ,?,'[]')");
  const insK = db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,'basic.greedy','贪心',1,'tag','tag',1,1,'2026-01-01')`);
  // <1200 桶：4 题里 3 题标贪心（占比 0.75 → 低信息量）
  for (let i = 0; i < 4; i += 1) {
    insP.run(`L${i}`, `T${i}`, 900);
    if (i < 3) insK.run(`L${i}`);
  }
  // 2200+ 桶：4 题里 1 题标贪心（占比 0.25 → 较高信息量）
  for (let i = 0; i < 4; i += 1) {
    insP.run(`H${i}`, `T${i}`, 2400);
    if (i === 0) insK.run(`H${i}`);
  }
  recomputeConceptStats(db);

  const low = conceptStatsFor(db, '<1200').get('basic.greedy');
  const high = conceptStatsFor(db, '2200+').get('basic.greedy');
  assert.ok(low !== undefined && high !== undefined, '两个桶都应有贪心的统计');
  assert.ok(low! < high!, `低难度桶信息量(${low}) 应低于高难度桶(${high})`);
  // 分层验证：两桶的 share 分别按各自桶内总题数计算（都是 4 题）
  const rows = db.prepare(
    "SELECT bucket, problem_count, share FROM knowledge_concept_stats WHERE code='basic.greedy' ORDER BY bucket",
  ).all() as Array<{ bucket: string; problem_count: number; share: number }>;
  assert.equal(rows.length, 2, '应只有两个桶有统计，不能混算成一个');
  assert.ok(rows.every((r) => r.share === 0.75 || r.share === 0.25));
  db.close();
});

test('recomputeConceptStats: 重复执行幂等（同结果不重复膨胀）', () => {
  const db = createDb(':memory:');
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','P0','T',1500,'[]')").run();
  db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces','P0','misc.sorting','n',1,'tag','tag',1,1,'2026-01-01')`).run();
  recomputeConceptStats(db);
  const a = db.prepare('SELECT COUNT(*) AS c FROM knowledge_concept_stats').get() as { c: number };
  recomputeConceptStats(db);
  const b = db.prepare('SELECT COUNT(*) AS c FROM knowledge_concept_stats').get() as { c: number };
  assert.equal(a.c, b.c);
  db.close();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/knowledge-concept-stats.test.ts`
Expected: FAIL —— `Cannot find module '../src/knowledge/conceptStats.ts'`

- [ ] **Step 3: 建表**

在 `server/src/db/schema.sql` 的 `knowledge_queue` 定义之后追加：

```sql
-- 知识点概念的统计特征（物化缓存）：按难度桶记录每个 code 的覆盖率与信息量。
-- 用途：题源标签存在「低难度题 40% 标贪心」式的膨胀（见清洗重构 spec §2.2），
-- 直接用于弱项判断会稀释信号；本表把「覆盖」与「信息量」分开：
-- 粗概念提供覆盖，informativeness 决定它在下游的权重。
-- bucket 取值与 routes/problems.ts 的 DIFFICULTY_BUCKETS 同口径（含 '未知'）。
CREATE TABLE IF NOT EXISTS knowledge_concept_stats (
  code            TEXT NOT NULL,
  bucket          TEXT NOT NULL,
  problem_count   INTEGER NOT NULL,
  share           REAL NOT NULL,      -- 该桶内含此 code 的题数 / 该桶总题数
  informativeness REAL NOT NULL,      -- 二元熵归一化后夹到 [0.25, 1]
  computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, bucket)
);
CREATE INDEX IF NOT EXISTS idx_concept_stats_bucket ON knowledge_concept_stats(bucket);
```

> `CREATE TABLE IF NOT EXISTS` 在每次 `createDb` 都会执行，因此**老库自动获得该表**，无需额外迁移步骤。

- [ ] **Step 4: 实现 conceptStats.ts**

```ts
/**
 * 知识点概念的统计特征：覆盖率与信息量（清洗重构 spec §2.2–2.4）。
 *
 * 为什么需要它：题源标签在低难度区间严重膨胀 —— CF difficulty<1200 的题里
 * 贪心 38% / 数学 39% / 模拟 45%（实测），这类标签几乎不含判别信息；
 * 而数论 5.9% / 双指针 5.5% 则很有区分度。
 *
 * 解法不是删掉膨胀标签（那会放弃它们覆盖的题），而是按实测信息量给它们降权：
 *   informativeness(p) = H_binary(p) / 1bit = -(p·log2 p + (1-p)·log2(1-p))
 * p→0.5 得 1（最有区分度），p→0 或 1 得 0（几乎无信息）。
 * 权重下限 FLOOR 保证低信息量概念仍出现在弱项列表里（只是排在后面），不被完全静默。
 */
import type { Db } from '../db/index.ts';

export const INFORMATIVENESS_FLOOR = 0.25;

/**
 * 二元熵归一化到 [0,1] 后夹到下限。
 * @param p 该概念在库内（或某难度桶内）的占比，取值 [0,1]
 */
export function informativeness(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return INFORMATIVENESS_FLOOR;
  const h = -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
  return Math.max(INFORMATIVENESS_FLOOR, Math.min(1, h));
}

/** 难度桶（与 routes/problems.ts 的 DIFFICULTY_BUCKETS 同口径） */
function bucketOf(difficulty: number | null): string {
  if (difficulty === null) return '未知';
  if (difficulty < 1200) return '<1200';
  if (difficulty < 1400) return '1200-1399';
  if (difficulty < 1600) return '1400-1599';
  if (difficulty < 1900) return '1600-1899';
  if (difficulty < 2200) return '1900-2199';
  return '2200+';
}

/**
 * 重算并物化全部 (code × bucket) 统计。幂等：同一数据重复执行结果一致。
 * @returns 写入的行数
 */
export function recomputeConceptStats(db: Db): number {
  const rows = db
    .prepare(
      `SELECT p.id, p.difficulty, pk.code
         FROM problems p JOIN problem_keypoints pk
           ON pk.platform = p.platform AND pk.problem_key = p.problem_key
        WHERE pk.source IN ('tag','rule','manual')`,
    )
    .all() as unknown as Array<{ id: number; difficulty: number | null; code: string }>;

  // 每题在同一桶内对一个 code 只计一次
  const totalByBucket = new Map<string, number>();
  const codeByBucket = new Map<string, Set<number>>();
  const allProblems = db
    .prepare('SELECT id, difficulty FROM problems')
    .all() as unknown as Array<{ id: number; difficulty: number | null }>;
  for (const p of allProblems) {
    const b = bucketOf(p.difficulty);
    totalByBucket.set(b, (totalByBucket.get(b) ?? 0) + 1);
  }
  for (const r of rows) {
    const b = bucketOf(r.difficulty);
    const key = `${b}\u0000${r.code}`;
    const set = codeByBucket.get(key) ?? new Set<number>();
    set.add(r.id);
    codeByBucket.set(key, set);
  }

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM knowledge_concept_stats');
    const ins = db.prepare(
      `INSERT INTO knowledge_concept_stats (code, bucket, problem_count, share, informativeness)
       VALUES (?, ?, ?, ?, ?)`,
    );
    let written = 0;
    for (const [key, ids] of codeByBucket) {
      const [bucket, code] = key.split('\u0000');
      const total = totalByBucket.get(bucket) ?? 0;
      if (total === 0) continue;
      const share = ids.size / total;
      ins.run(code, bucket, ids.size, share, informativeness(share));
      written += 1;
    }
    db.exec('COMMIT');
    return written;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** 某难度桶的 code → informativeness；用于批量加权 */
export function conceptStatsFor(db: Db, bucket: string): Map<string, number> {
  const rows = db
    .prepare('SELECT code, informativeness FROM knowledge_concept_stats WHERE bucket = ?')
    .all(bucket) as unknown as Array<{ code: string; informativeness: number }>;
  return new Map(rows.map((r) => [r.code, r.informativeness]));
}

/** 单点权重查询：统计缺失时返回 1（不惩罚未统计到的概念） */
export function informativenessFor(db: Db, bucket: string, code: string): number {
  const row = db
    .prepare('SELECT informativeness FROM knowledge_concept_stats WHERE bucket = ? AND code = ?')
    .get(bucket, code) as { informativeness: number } | undefined;
  return row?.informativeness ?? 1;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd server && npx tsx --test test/knowledge-concept-stats.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 6: 加重算端点**

在 `server/src/routes/knowledge.ts` 补一个端点（放在 `/coverage` 附近）：

```ts
  // POST /api/knowledge/recompute-stats → 重算概念统计（覆盖率与信息量）
  // 题库 upsert 后由写入路径异步触发；此处供手动修复与 UI 刷新
  r.post('/recompute-stats', (_req, res) => {
    const written = recomputeConceptStats(db);
    res.json({ ok: true, concepts: written, computedAt: new Date().toISOString() });
  });
```

并在该文件补 import：`import { recomputeConceptStats } from '../knowledge/conceptStats.ts';`

- [ ] **Step 7: 跑全量测试 + Commit**

Run: `cd "D:\01-代码项目\工作台" && npm test`
Expected: 全绿

```bash
git add server/src/knowledge/conceptStats.ts server/src/db/schema.sql server/src/routes/knowledge.ts server/test/knowledge-concept-stats.test.ts
git commit -m "feat(knowledge): 概念统计与信息量权重（二元熵 × 难度桶）"
```

---

### Task 6: 弱项画像按信息量加权

**Files:**
- Modify: `server/src/analysis/weakness.ts`
- Modify: `shared/src/index.ts`（`WeaknessItem` 增加 `rank` 字段）
- Test: `server/test/weakness-weight.test.ts`（新建）

**Interfaces:**
- Consumes: Task 5 的 `informativenessFor` / `INFORMATIVENESS_FLOOR`
- Produces: `WeaknessItem` 新字段 `rank: number`（= `gap × weight`，用于排序）；`gap` 语义不变（保留原始可观测差值）

- [ ] **Step 1: 写失败测试**

新建 `server/test/weakness-weight.test.ts`：

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { computeWeakness } from '../src/analysis/weakness.ts';
import { recomputeConceptStats } from '../src/knowledge/conceptStats.ts';

let db: Db;
beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

/** 造 n 道同难度题，每题一个 code，按 acEvery 决定是否 AC */
function seed(n: number, code: string, acEvery: number): void {
  db.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  const insP = db.prepare("INSERT OR IGNORE INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces',?,? ,1500,'[]')");
  const insK = db.prepare(`INSERT OR IGNORE INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,?,'n',1,'tag','tag',1,1,'2026-01-01')`);
  const insS = db.prepare("INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at) VALUES (1,'codeforces',?,?,?)");
  for (let i = 0; i < n; i += 1) {
    const key = `${code}-${i}`;
    insP.run(key, `T ${key}`);
    const pid = (db.prepare('SELECT id FROM problems WHERE problem_key = ?').get(key) as { id: number }).id;
    insK.run(key, code);
    insS.run(pid, i % acEvery === 0 ? 'AC' : 'WA', `2026-01-0${(i % 9) + 1}T00:00:00.000Z`);
  }
}

test('低信息量概念即使 gap 更大也排在细粒度概念之后', () => {
  // 粗类（覆盖 30 题中的 20 题 → 占比高 → 低信息量），全错 → gap 最大
  seed(20, 'math.general', 1);   // 全 WA
  // 细类（仅 5 题 → 低占比 → 高信息量），全错
  seed(5, 'math.number-theory', 1);
  // 另造一批 AC 撑起总体 AC 率
  seed(5, 'dp.general', 1);
  db.prepare("UPDATE submissions SET verdict='AC' WHERE problem_id IN (SELECT id FROM problems WHERE problem_key LIKE 'dp.general-%')").run();
  recomputeConceptStats(db);

  const profile = computeWeakness(db, 1, { minAttempts: 3, topN: 10 });
  const coarse = profile.items.find((i) => i.tag === '数学（综合）');
  const fine = profile.items.find((i) => i.tag === '数论');
  assert.ok(coarse && fine, `两个概念都应在结果里，实得 ${profile.items.map((i) => i.tag).join(',')}`);
  assert.ok((coarse.rank) < (fine.rank), `粗类 rank(${coarse.rank}) 应低于细类 rank(${fine.rank})`);
  // gap 仍报告原始可观测差值，不被权重改写
  assert.ok(typeof coarse.gap === 'number');
});

test('低信息量概念不会被完全静默（受 FLOOR 保护仍有正 rank）', () => {
  seed(30, 'math.general', 1);
  recomputeConceptStats(db);
  const profile = computeWeakness(db, 1, { minAttempts: 3, topN: 10 });
  const coarse = profile.items.find((i) => i.tag === '数学（综合）');
  assert.ok(coarse, '粗类概念应仍出现在列表里');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/weakness-weight.test.ts`
Expected: FAIL —— `coarse.rank` 为 undefined，断言 `undefined < undefined` 失败。

- [ ] **Step 3: 给 WeaknessItem 加 rank 字段**

在 `shared/src/index.ts` 找到 `interface WeaknessItem`，加入：

```ts
  /**
   * 排序得分 = gap × 概念信息量权重（见 knowledge/conceptStats.ts）。
   * 低信息量的膨胀标签（如低难度题的「数学」覆盖 24.8%）被降权后排到后面；
   * gap 本身保持不变，仍是原始可观测的 AC 率差值。
   */
  rank: number;
```

- [ ] **Step 4: 改 computeWeakness 计算 rank**

在 `server/src/analysis/weakness.ts` 补 import：

```ts
import { bucketForDifficulty as _bucket } from './stats.ts'; // 已存在则复用
import { informativenessFor } from '../knowledge/conceptStats.ts';
import { codeOfTag } from '../../../shared/src/index.ts';
```

把 `items` 的构造改为（在既有 `.map` 里补 rank，并改用 rank 排序）：

```ts
  const items: WeaknessItem[] = [...tagMap.entries()]
    .map(([tag, s]) => {
      const acRate = rate(s.attempts, s.ac);
      const gap = round2(avgAcRate - acRate);
      // 该 tag 对应的概念 code（粗类标签如「数学（综合）」也能取到）；
      // 取不到 code 时权重按 1 处理（不惩罚未纳入 taxonomy 的标签）
      const code = codeOfTag(tag);
      const weight = code === undefined ? 1 : averageWeightForCode(db, userId, code);
      return {
        tag,
        attempts: s.attempts,
        ac: s.ac,
        acRate,
        avgAcRate,
        gap,
        rank: round2(gap * weight),
        solved: solvedByTag.get(tag)?.size ?? 0,
      };
    })
    .filter((i) => i.attempts >= minAttempts)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, topN);
```

并在同文件加一个私有辅助（同一 code 可能横跨多个难度桶，按该用户在各桶的尝试量加权平均）：

```ts
/**
 * 同一概念横跨多个难度桶时，按用户在**各桶的尝试数**加权平均其信息量权重。
 * 只用到该用户实际做过的题所在桶，避免把用户从未接触的难度区间的膨胀也计入。
 */
function averageWeightForCode(db: Db, userId: number, code: string): number {
  const rows = db
    .prepare(
      `SELECT p.difficulty AS difficulty, COUNT(*) AS attempts
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = ?
        GROUP BY p.difficulty`,
    )
    .all(userId) as unknown as Array<{ difficulty: number | null; attempts: number }>;
  let total = 0;
  let weighted = 0;
  for (const r of rows) {
    const w = informativenessFor(db, _bucket(r.difficulty), code);
    total += r.attempts;
    weighted += r.attempts * w;
  }
  return total === 0 ? 1 : weighted / total;
}
```

- [ ] **Step 5: 运行确认通过**

Run: `cd server && npx tsx --test test/weakness-weight.test.ts`
Expected: PASS（2 个测试）

- [ ] **Step 6: 跑全量测试**

Run: `cd "D:\01-代码项目\工作台" && npm test`
Expected: 全绿。`WeaknessItem` 新增必填字段 `rank` 会导致 client 侧类型报错——同步更新 `client/src/types.ts` 中对应的弱项类型（若它复制了该接口），并在 client 使用处补字段。跑 `npm run typecheck` 确认无 TS 错误。

- [ ] **Step 7: Commit**

```bash
git add server/src/analysis/weakness.ts shared/src/index.ts server/test/weakness-weight.test.ts client/src/types.ts
git commit -m "feat(knowledge): 弱项排序按概念信息量加权（gap 保留原始值）"
```

---

### Task 7: submission_intents 表与 API

**Files:**
- Modify: `server/src/db/schema.sql`（新增表）
- Modify: `server/src/routes/problems.ts`（新增 intent 端点）
- Test: `server/test/submission-intents.test.ts`（新建）

**Interfaces:**
- Consumes: 无（独立新表）
- Produces:
  - SQL 表 `submission_intents(id, user_id, problem_id, code, outcome, created_at)`
  - `type IntentOutcome = 'cant_start' | 'wrong_approach' | 'implementation' | 'slight_bug'`
  - `POST /api/problems/:platform/:key/intent` body `{ outcome: IntentOutcome, code?: string }` → `{ ok: true, id: number }`
  - `GET /api/problems/:platform/:key/intents` → `{ items: Array<{ code: string | null; outcome: string; createdAt: string }> }`

- [ ] **Step 1: 写失败测试**

新建 `server/test/submission-intents.test.ts`：

```ts
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createDb, type Db } from '../src/db/index.ts';
import { problemsRoutes } from '../src/routes/problems.ts';

let db: Db | undefined;
afterEach(() => { db?.close(); db = undefined; });

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const d = createDb(':memory:');
  db = d;
  d.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  d.prepare("INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (1,'codeforces','1A','T',1500,'[]')").run();
  const app = express();
  app.use(express.json());
  app.use('/api/problems', problemsRoutes(d));
  const srv = app.listen(0);
  await new Promise<void>((r) => srv.once('listening', r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/problems`);
  } finally {
    srv.close();
  }
}

test('POST intent: 记录用户声明的卡点（code 可空）', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'wrong_approach', code: 'basic.greedy' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; id: number };
    assert.equal(body.ok, true);
    assert.ok(body.id > 0);

    // code 省略 = 非知识点摩擦（「我会做但实现崩了」），也应成功
    const res2 = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'implementation' }),
    });
    assert.equal(res2.status, 200);
  });
});

test('POST intent: 非法 outcome 或非法 code 返回 400 且不写库', async () => {
  await withServer(async (base) => {
    const bad1 = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: '不知道怎么选' }),
    });
    assert.equal(bad1.status, 400);

    const bad2 = await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'cant_start', code: '不存在的code' }),
    });
    assert.equal(bad2.status, 400);

    const { c } = db!.prepare('SELECT COUNT(*) AS c FROM submission_intents').get() as { c: number };
    assert.equal(c, 0, '非法请求不应写库');
  });
});

test('GET intents: 返回该题的全部声明，按时间倒序', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'cant_start', code: 'basic.greedy' }),
    });
    await fetch(`${base}/codeforces/1A/intent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome: 'slight_bug' }),
    });
    const res = await fetch(`${base}/codeforces/1A/intents`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: Array<{ code: string | null; outcome: string }> };
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].outcome, 'slight_bug', '最新的在前');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/submission-intents.test.ts`
Expected: FAIL —— 404（路由不存在）与 `no such table: submission_intents`。

- [ ] **Step 3: 建表**

在 `server/src/db/schema.sql` 的 `knowledge_concept_stats` 之后追加：

```sql
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
```

- [ ] **Step 4: 加路由**

在 `server/src/routes/problems.ts` 的 `problemsRoutes` 内、`return r;` 之前插入。先补 import：

```ts
import { isValidCode } from '../knowledge/taxonomy.ts';
```

```ts
  /** 合法的卡点性质（与 client 的选项一一对应） */
  const INTENT_OUTCOMES = new Set(['cant_start', 'wrong_approach', 'implementation', 'slight_bug']);

  // POST /api/problems/:platform/:key/intent
  // body: { outcome: 'cant_start'|'wrong_approach'|'implementation'|'slight_bug', code?: string }
  // 记录用户自述的卡点。code 可省略（= 非知识点摩擦）。
  r.post('/:platform/:key/intent', (req, res) => {
    const { platform, key } = req.params;
    if (!PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    const outcome = req.body?.outcome;
    if (typeof outcome !== 'string' || !INTENT_OUTCOMES.has(outcome)) {
      return res.status(400).json({ error: 'outcome 需为 cant_start / wrong_approach / implementation / slight_bug' });
    }
    const rawCode = req.body?.code;
    if (rawCode !== undefined && rawCode !== null && rawCode !== '') {
      if (typeof rawCode !== 'string' || !isValidCode(rawCode)) {
        return res.status(400).json({ error: `code 非法: ${String(rawCode)}` });
      }
    }
    const code = typeof rawCode === 'string' && rawCode !== '' ? rawCode : null;

    const problem = db
      .prepare('SELECT id FROM problems WHERE platform = ? AND problem_key = ?')
      .get(platform, key) as { id: number } | undefined;
    if (!problem) return res.status(404).json({ error: '题目不存在：请先同步或导入该题' });

    const info = db
      .prepare('INSERT INTO submission_intents (user_id, problem_id, code, outcome) VALUES (?, ?, ?, ?)')
      .run(DEFAULT_USER_ID, problem.id, code, outcome);
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  // GET /api/problems/:platform/:key/intents → 该题的卡点记录（时间倒序）
  r.get('/:platform/:key/intents', (req, res) => {
    const { platform, key } = req.params;
    const rows = db
      .prepare(
        `SELECT i.code, i.outcome, i.created_at AS createdAt
           FROM submission_intents i JOIN problems p ON p.id = i.problem_id
          WHERE i.user_id = ? AND p.platform = ? AND p.problem_key = ?
          ORDER BY i.created_at DESC, i.id DESC`,
      )
      .all(DEFAULT_USER_ID, platform, key);
    res.json({ items: rows });
  });
```

> **路由顺序警告**：`problems.ts` 已有 `r.get('/:id')` 之类的既有路由吗？没有——现有路由是 `/`、`/page`、`/facets`、`/bank`、`/clean-tags`、`/topics/rebuild`、`/backfill-difficulty`。新路由 `/:platform/:key/intent` 是三段路径，与既有任何路由都不冲突。但**必须放在 `/page`、`/facets` 之后**，否则 `/:platform/:key/...` 可能抢先匹配（本例段数不同，实际不冲突，仍建议靠后放置以策安全）。

- [ ] **Step 5: 运行确认通过**

Run: `cd server && npx tsx --test test/submission-intents.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 6: 跑全量测试 + Commit**

Run: `cd "D:\01-代码项目\工作台" && npm test`
Expected: 全绿

```bash
git add server/src/db/schema.sql server/src/routes/problems.ts server/test/submission-intents.test.ts
git commit -m "feat(knowledge): submission_intents 表与卡点记录 API"
```

---

### Task 8: 题目页「卡在哪」入口

**Files:**
- Create: `client/src/components/IntentPopover.tsx`
- Modify: `client/src/pages/Problems.tsx`（表格「操作」列加入该组件）
- Test: `client/test/intentOptions.test.ts`（新建，测纯逻辑）

**Interfaces:**
- Consumes: Task 7 的 `POST /api/problems/:platform/:key/intent`
- Produces:
  - `export const INTENT_OPTIONS: ReadonlyArray<{ value: IntentOutcome; label: string; hint: string }>`
  - `export type IntentOutcome = 'cant_start' | 'wrong_approach' | 'implementation' | 'slight_bug'`
  - 组件 `<IntentPopover platform={string} problemKey={string} codes={string[]} onDone={() => void} />`

- [ ] **Step 1: 写失败测试（纯逻辑，避免依赖 DOM 测试框架）**

新建 `client/test/intentOptions.test.ts`：

```ts
/**
 * 卡点选项的纯逻辑测试。选项本身是 UI 契约的一部分：
 * value 必须与服务端 INTENT_OUTCOMES 白名单逐字一致，否则点击会被 400 拒绝。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { INTENT_OPTIONS, type IntentOutcome } from '../src/components/IntentPopover.tsx'

/** 与服务端 routes/problems.ts 的 INTENT_OUTCOMES 保持一致 */
const SERVER_ALLOWED: readonly string[] = ['cant_start', 'wrong_approach', 'implementation', 'slight_bug']

describe('INTENT_OPTIONS', () => {
  it('value 集合与服务端白名单完全一致', () => {
    assert.deepEqual(
      INTENT_OPTIONS.map((o) => o.value).sort(),
      [...SERVER_ALLOWED].sort(),
    )
  })

  it('每项都有非空中文标签与提示', () => {
    for (const o of INTENT_OPTIONS) {
      assert.ok(o.label.trim().length > 0, `${o.value} 缺 label`)
      assert.ok(o.hint.trim().length > 0, `${o.value} 缺 hint`)
    }
  })

  it('label 不重复（用户能区分选项）', () => {
    const labels = INTENT_OPTIONS.map((o) => o.label)
    assert.equal(new Set(labels).size, labels.length)
  })

  it('类型 IntentOutcome 覆盖全部 value', () => {
    const values: IntentOutcome[] = INTENT_OPTIONS.map((o) => o.value)
    assert.equal(values.length, 4)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd client && npx tsx --test test/intentOptions.test.ts`
Expected: FAIL —— `Cannot find module '../src/components/IntentPopover.tsx'`

- [ ] **Step 3: 实现 IntentPopover.tsx**

```tsx
/**
 * 「卡在哪」入口：用户在题目页一次性声明卡点，写入 submission_intents。
 *
 * 为什么需要它：题源标签一题多标签是常态（实测 75.7% 的题有 ≥2 个标签），
 * 且低难度题的标签严重膨胀（贪心/数学各占 ~40%），因此从题目反推「用户哪个知识点不熟」
 * 是无解的。用户自己声明是唯一无歧义的归因来源。
 *
 * 交互刻意做到最小摩擦：Popover + 一次点击即写入，不做弹窗问卷。
 */
import { useState } from 'react'
import { Button, Popover, Space, Typography, Select } from 'antd'
import { post } from '../api'

export type IntentOutcome = 'cant_start' | 'wrong_approach' | 'implementation' | 'slight_bug'

export const INTENT_OPTIONS: ReadonlyArray<{ value: IntentOutcome; label: string; hint: string }> = [
  { value: 'cant_start', label: '完全不会', hint: '不知道从哪下手，看题解才懂' },
  { value: 'wrong_approach', label: '思路错', hint: '方向想错了，或漏了情况' },
  { value: 'implementation', label: '实现崩溃', hint: '知道怎么做，但写不出来/调不通' },
  { value: 'slight_bug', label: '差一点', hint: '思路对，小 bug 或边界没处理' },
]

interface Props {
  platform: string
  problemKey: string
  /** 该题的知识点 code 候选（可留空 = 不指定知识点） */
  codes?: string[]
  /** 写入成功回调（通常用于刷新当前页） */
  onDone?: () => void
  /** 成功提示回调（沿用调用方的 AntdApp.useApp() 实例，避免脱离 ConfigProvider） */
  onSuccess?: (msg: string) => void
  onError?: (msg: string) => void
}

export default function IntentPopover({ platform, problemKey, codes = [], onDone, onSuccess, onError }: Props) {
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<IntentOutcome>('wrong_approach')
  const [code, setCode] = useState<string | undefined>()
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      await post(`/api/problems/${encodeURIComponent(platform)}/${encodeURIComponent(problemKey)}/intent`, {
        outcome,
        ...(code ? { code } : {}),
      })
      onSuccess?.('已记录卡点，弱项判断会据此更准')
      setOpen(false)
      onDone?.()
    } catch (e) {
      onError?.((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const content = (
    <Space direction="vertical" size={8} style={{ width: 240 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        这题卡在哪？（一次点击即可，不必填完整）
      </Typography.Text>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {INTENT_OPTIONS.map((o) => (
          <Button
            key={o.value}
            size="small"
            block
            type={outcome === o.value ? 'primary' : 'default'}
            onClick={() => setOutcome(o.value)}
            title={o.hint}
          >
            {o.label}
          </Button>
        ))}
      </Space>
      <Select
        allowClear
        size="small"
        style={{ width: '100%' }}
        placeholder="哪个知识点？（可跳过）"
        value={code}
        onChange={setCode}
        options={codes.map((c) => ({ value: c, label: c }))}
      />
      <Button type="primary" size="small" block loading={saving} onClick={() => void submit()}>
        记录
      </Button>
    </Space>
  )

  return (
    <Popover content={content} title="卡在哪" trigger="click" open={open} onOpenChange={setOpen}>
      <Button size="small" type="text">卡在哪</Button>
    </Popover>
  )
}
```

- [ ] **Step 4: 运行确认通过**

Run: `cd client && npx tsx --test test/intentOptions.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 接入 Problems.tsx 操作列**

在 `client/src/pages/Problems.tsx` 的操作列（`cols` 定义里 `title: '操作'` 那一项）的 `Space` 内加入：

```tsx
          <Tooltip title="记录你卡在哪，用于弱项判断">
            <span>
              <IntentPopover
                platform={r.platform}
                problemKey={r.problem_key}
                codes={r.tags}
                onSuccess={(m) => message.success(m)}
                onError={(m) => message.error(m)}
              />
            </span>
          </Tooltip>
```

并补 import：`import IntentPopover from '../components/IntentPopover'`

> 用 `<span>` 包裹：antd `Tooltip` 需要子元素能接受 ref，`Popover` 内部已有 Button，包一层 span 可避免 ref 警告。

- [ ] **Step 6: typecheck + lint + 测试**

Run: `cd "D:\01-代码项目\工作台" && npm run typecheck && npm run lint -w client && npm test`
Expected: typecheck 无错；lint **0 errors**（`IntentPopover.tsx` 不得引入新的 warning——它只导出组件与常量，注意 `INTENT_OPTIONS` 与 `IntentOutcome` 从 `.tsx` 导出会触发 `react(only-export-components)`。**若触发，把 `INTENT_OPTIONS` 与 `IntentOutcome` 移到 `client/src/intentOptions.ts`，由组件 re-import**，这与 Task 1 里 `DIFFICULTY_BUCKETS` 移入 `problemFilter.ts` 的处理一致）；测试全绿。

- [ ] **Step 7: 手工验证交互（必须做，不能只靠单测）**

Run: `cd "D:\01-代码项目\工作台" && npm run dev`
打开 `http://localhost:5173/problems`，在任一题行点「卡在哪」→ 选「思路错」→ 记录。
Expected: 出现成功提示；`sqlite` 中 `submission_intents` 多出一行。
验证 SQL：`SELECT * FROM submission_intents ORDER BY id DESC LIMIT 3;`

- [ ] **Step 8: Commit**

```bash
git add client/src/components/IntentPopover.tsx client/src/intentOptions.ts client/src/pages/Problems.tsx client/test/intentOptions.test.ts
git commit -m "feat(knowledge): 题目页「卡在哪」意图采集入口"
```

---

### Task 9: 队列转词表缺口清单 + 摘除已死管线

**Files:**
- Modify: `server/src/knowledge/pipeline.ts`（删除 AI 批次逻辑；新增 `gapReport`）
- Modify: `server/src/routes/knowledge.ts`（`/build` 去掉 L2；新增 `/gaps`；删 AI import 与 `/retry-failed`）
- **Delete: `server/src/knowledge/aiClassify.ts`（467 行）+ `server/test/knowledge-ai.test.ts`（374 行）**
- **Delete: `server/src/topics/pipeline.ts`（64 行）+ `server/test/topics-pipeline.test.ts` + `problem_topics` 表**
- **Modify: `server/src/routes/problems.ts`（删 `topics/rebuild` 端点与其 import）**
- Modify: `server/src/db/schema.sql`（删 `problem_topics` 表与 `idx_problem_topics_topic`）
- Modify: `server/test/knowledge-store.test.ts`（改掉对 `problem_topics` 的断言，见 Step 6）
- Test: `server/test/knowledge-gaps.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `unmappedTags` 逻辑（改为直接查库聚合）
- Produces:
  - `gapReport(db: Db, opts?: { limit?: number }): { gaps: Array<{ tag: string; problems: number }>; uncovered: number }`
  - `GET /api/knowledge/gaps` → 上述结构
- 移除导出：`pendingAiCount`、`markBatchRetry`、`retryFailedQueue`、`failedAiCount`、`commitAiAnnotations`、`fetchAiBatch`、`markQueueStatus`、`MAX_ATTEMPTS`

**为什么本任务额外删这些（控制器裁定 — 请勿省略）**

用户决策「AI 退出题目清洗模块」后，实测确认这两块已无任何生产用途：

| 删除对象 | 生产引用 | 判定依据 |
| --- | --- | --- |
| `aiClassify.ts` + 其测试 | **仅** `routes/knowledge.ts:19` 的 import，而本任务正要删掉那三个端点 | 计划原先写「保留作离线导出通道」——该通道（导出题目包 → 外部 AI 标注 → 回填）**做的就是「让 AI 清洗知识点」这件事本身**，与用户决策矛盾，故理据不成立。删除后清洗链路再无 AI。 |
| `topics/pipeline.ts` + `problem_topics` 表 + `/api/problems/topics/rebuild` | `problems.ts:12` 的 import 与 `:412` 的端点 | Task 3 已把该表从读取路径摘除 → **写入不再影响任何统计**。留着一张在写、没人读的表 + 一个端点属纯负债。（原先记作「留给优化方案 P2-7 单独决策」，现并入本任务一次做完，避免二次改动同批文件。） |

**迁移后的实测投影支持这些删除**：tag ∪ rule 覆盖 17,163 / 19,144 题（**89.7%**），101/134 个 taxonomy code 仍有命中 —— 即核心管线（`tagAnnotate` / `ruleEngine` / `store` / `pipeline` / `taxonomy`）**确有价值，不得删**；上述两块与该结论无关。

- [ ] **Step 1: 写失败测试**

新建 `server/test/knowledge-gaps.test.ts`：

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { gapReport } from '../src/knowledge/pipeline.ts';

let db: Db;
beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

test('gapReport: 聚合无法映射的原始标签，按影响题数降序', () => {
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  const ins = db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)');
  // 未收录标签甲 影响 2 题；乙 影响 1 题；已收录的「贪心」不应出现
  ins.run('codeforces', 'A', 'T', JSON.stringify(['未收录甲', '贪心']));
  ins.run('codeforces', 'B', 'T', JSON.stringify(['未收录甲']));
  ins.run('codeforces', 'C', 'T', JSON.stringify(['未收录乙']));

  const r = gapReport(db);
  assert.deepEqual(r.gaps.map((g) => g.tag), ['未收录甲', '未收录乙']);
  assert.equal(r.gaps[0].problems, 2);
  assert.equal(r.gaps[1].problems, 1);
});

test('gapReport: 已收录标签即使占比很低也不进缺口清单', () => {
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)')
    .run('codeforces', 'A', 'T', JSON.stringify(['数学', '数论']));
  const r = gapReport(db);
  assert.deepEqual(r.gaps, [], '全是已收录标签时不应有缺口');
});

test('gapReport: uncovered 统计完全无 code 的题数', () => {
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)')
    .run('codeforces', 'A', 'T', JSON.stringify(['未收录甲']));
  db.prepare('INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES (?,?,?,1500,?)')
    .run('codeforces', 'B', 'T', JSON.stringify(['贪心']));
  const r = gapReport(db);
  assert.equal(r.uncovered, 1, '只有 A 无任何可映射 code');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/knowledge-gaps.test.ts`
Expected: FAIL —— `does not provide an export named 'gapReport'`

- [ ] **Step 3: 实现 gapReport 并删除 AI 批次逻辑**

在 `server/src/knowledge/pipeline.ts`：

1. 删除 `pendingAiCount`、`fetchAiBatch`、`markQueueStatus`、`MAX_ATTEMPTS`、`markBatchRetry`、`retryFailedQueue`、`failedAiCount`、`commitAiAnnotations` 这 8 个导出及其注释块。
2. 追加 `gapReport`：

```ts
/**
 * 词表缺口报告（替代原「待 AI 标注队列」的用途）。
 *
 * AI 退出清洗模块后，未覆盖的题不再等待模型，而是成为**词表缺口**：
 * 这些题的题源标签存在，但映射不到任何 taxonomy code。
 * 补齐 shared/src/tags.ts 的同义组是唯一能真正提升覆盖率的手段（零 AI 成本）。
 */
export interface GapReport {
  /** 无法映射的原始标签 → 影响的题数（降序） */
  gaps: Array<{ tag: string; problems: number }>;
  /** 完全没有可用 code 的题数（题源标签也映射不上、规则也未命中） */
  uncovered: number;
}

export function gapReport(db: Db, opts: { limit?: number } = {}): GapReport {
  const limit = opts.limit ?? 100;

  const uncovered = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM problems p
          WHERE NOT EXISTS (
            SELECT 1 FROM problem_keypoints k
             WHERE k.platform = p.platform AND k.problem_key = p.problem_key
               AND k.source IN ('tag','rule','manual'))`,
      )
      .get() as { c: number }
  ).c;

  // 未覆盖题的全部原始标签拉回内存聚合（用 codeOfTag 判定是否可映射）
  const rows = db
    .prepare(
      `SELECT p.tags AS tags FROM problems p
        WHERE NOT EXISTS (
          SELECT 1 FROM problem_keypoints k
           WHERE k.platform = p.platform AND k.problem_key = p.problem_key
             AND k.source IN ('tag','rule','manual'))`,
    )
    .all() as unknown as Array<{ tags: string }>;

  const byTag = new Map<string, number>();
  for (const r of rows) {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(r.tags) as unknown;
      if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === 'string');
    } catch { tags = []; }
    for (const t of new Set(tags)) {
      if (codeOfTag(t) !== undefined) continue;
      byTag.set(t, (byTag.get(t) ?? 0) + 1);
    }
  }

  const gaps = [...byTag.entries()]
    .map(([tag, problems]) => ({ tag, problems }))
    .sort((a, b) => b.problems - a.problems || a.tag.localeCompare(b.tag))
    .slice(0, limit);

  return { gaps, uncovered };
}
```

3. 在文件顶部补 import：`import { codeOfTag } from '../../../shared/src/index.ts';`

> `annotateProblemsFromTags`（Task 2）产出的 `unmappedTags` 返回值仍保留（单测在用），只是缺口报告不依赖它。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && npx tsx --test test/knowledge-gaps.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 5: 改 routes/knowledge.ts**

1. import 行改为：`import { PIPELINE_CODE_VERSION, PIPELINE_VERSION, gapReport, runRulePass } from '../knowledge/pipeline.ts';`
2. import 行删除：`import { exportQueuePackage, importAiResults, runAiPass } from '../knowledge/aiClassify.ts';`
3. `/build` 端点简化为只跑 L1（`mode` 参数保留但忽略 `l2` 与 `all` 的差异）：

```ts
  // POST /api/knowledge/build  body: { rerun?: boolean }
  // 跑 L1：规则批跑（增量或版本差量重跑）+ 题源标签映射。
  // AI 已退出清洗模块，故不再有 L2 分支；未覆盖的题进「词表缺口」报告（GET /gaps）。
  r.post('/build', asyncHandler(async (req, res) => {
    const rerun = req.body?.rerun === true;
    const result = { ok: true, l1: runRulePass(db, { rerun }) };
    res.json({ ...result, coverage: getCoverage(db) });
  }));
```

4. 新增 `/gaps` 端点：

```ts
  // GET /api/knowledge/gaps → 词表缺口报告（补 tags.ts 同义组是提升覆盖率的唯一手段）
  r.get('/gaps', (req, res) => {
    const limit = Number(req.query.limit);
    res.json(gapReport(db, Number.isInteger(limit) ? { limit: Math.min(500, Math.max(1, limit)) } : {}));
  });
```

5. 删除 `/retry-failed` 端点（第 185 行附近，`retryFailedQueue` 已移除）。

- [ ] **Step 6: 跑全量测试 + typecheck**

Run: `cd "D:\01-代码项目\工作台" && npm run typecheck && npm test`
Expected: 全绿。若有 client 代码调用被删除的端点（`/api/knowledge/build` 的 `mode: 'l2'`、`/retry-failed`），同步改掉：`client/src/pages/Problems.tsx` 的 `runFullPipeline` 与 `retryFailed` 函数需相应简化或移除。

- [ ] **Step 6b: 删除已死管线（aiClassify 与 v1 topics）**

**6b-1 删 `aiClassify.ts` 与其测试**

```bash
git rm server/src/knowledge/aiClassify.ts server/test/knowledge-ai.test.ts
```

删前确认已无其他引用：`grep -rn "aiClassify" server/src server/test` 应只剩 0 处（Step 5 已删掉 `routes/knowledge.ts:19` 的 import）。
若 `shared/src/index.ts` 中有仅为该模块服务的类型（如导出队列包结构），一并删除并在报告中列出。

**6b-2 删 v1 topics 层**

```bash
git rm server/src/topics/pipeline.ts server/test/topics-pipeline.test.ts
```

然后：
1. `routes/problems.ts`：删 `import { rebuildTopicAnnotations } from '../topics/pipeline.ts';`（`:12`）与整个 `POST /api/problems/topics/rebuild` 端点（`:407-412` 附近）。
2. `schema.sql`：删 `problem_topics` 表定义与其索引 `idx_problem_topics_topic`。
   ⚠️ **`CREATE TABLE IF NOT EXISTS` 的既有库不会自动丢表** —— 但本表的**写入与读取路径已全部删除**，遗留的库内空表不影响任何行为。本计划**不加** `DROP TABLE`（无收益且不可逆）；若要物理清理需另议。
3. `store.ts:377` 的注释仍写「`problem_topics`（v1 遗留层）：表仍在（写入路径未动），但不再被读取」—— 改为说明该层已被彻底移除。

**6b-3 改掉 `knowledge-store.test.ts` 里对 `problem_topics` 的断言**

现状：`knowledge-store.test.ts:187` 与 `:253` 会 `INSERT INTO problem_topics ...`，用于证明「读取路径忽略 v1 层」。表删除后这些 INSERT 会失败。

**不要把这两条断言删掉了事** —— 它们验证的是「读取路径不读 v1」。改为：
- 删掉 `INSERT INTO problem_topics` 行；
- 把该测试的**意图**保留为一句注释 + 断言现有语义（读取只认 `tag/rule/manual`，无标注则回退 `p.tags`）；
- 在报告中明确写出「此断言随该层被移除而失去对象，已改写为…」，**不要静默削弱**。

**6b-4 验证删除是彻底的**

```bash
grep -rn "problem_topics\|rebuildTopicAnnotations\|aiClassify\|runAiPass\|importAiResults\|exportQueuePackage" server/src server/test shared/src
```
Expected: **0 处命中**（`docs/` 与历史计划文档除外）。若有残留，说明还有引用未清，修掉再继续。

- [ ] **Step 7: Commit**

```bash
git add -A server/src server/test shared/src client/src
git commit -m "refactor(knowledge): 队列转词表缺口清单，摘除已死的 AI 分类与 v1 topics 层"
```

---

### Task 10: 弱项预测力验证脚本

**Files:**
- Create: `server/scripts/validate-weakness.ts`
- Test: `server/test/validate-weakness.test.ts`（新建，测纯函数）

**Interfaces:**
- Consumes: Task 5/6 的概念统计与加权
- Produces:
  - `auc(scores: number[], labels: boolean[]): number` —— 纯函数，Mann-Whitney U 实现
  - `splitByTime<T extends { submittedAt: string }>(rows: T[], trainRatio: number): { train: T[]; test: T[] }`
  - 脚本输出：概念层 AUC、仅难度桶基线 AUC、随机基线 0.5、每概念样本数与功效告警

- [ ] **Step 1: 写失败测试**

新建 `server/test/validate-weakness.test.ts`：

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auc, splitByTime } from '../scripts/validate-weakness.ts';

test('auc: 完美排序为 1，完全反向为 0，无信息为 0.5', () => {
  assert.equal(auc([3, 2, 1], [true, true, false]), 1);
  assert.equal(auc([1, 2, 3], [true, true, false]), 0);
  // 正负样本得分分布相同 → 0.5
  assert.equal(auc([1, 2], [true, false]), 0.5);
});

test('auc: 处理并列得分（半计）', () => {
  // 一个正样本与一个负样本同分 → 各计 0.5
  assert.equal(auc([1, 1], [true, false]), 0.5);
});

test('auc: 空或单类返回 0.5 而非抛错', () => {
  assert.equal(auc([], []), 0.5);
  assert.equal(auc([1, 2], [true, true]), 0.5);
});

test('splitByTime: 按时间切分且不丢样本', () => {
  const rows = [
    { submittedAt: '2026-01-01T00:00:00.000Z', id: 1 },
    { submittedAt: '2026-01-02T00:00:00.000Z', id: 2 },
    { submittedAt: '2026-01-03T00:00:00.000Z', id: 3 },
    { submittedAt: '2026-01-04T00:00:00.000Z', id: 4 },
  ];
  const { train, test: testSet } = splitByTime(rows, 0.5);
  assert.equal(train.length + testSet.length, 4);
  assert.ok(train.every((r) => r.submittedAt <= testSet[0].submittedAt), '训练集必须全部早于测试集');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/validate-weakness.test.ts`
Expected: FAIL —— `Cannot find module '../scripts/validate-weakness.ts'`

- [ ] **Step 3: 实现脚本**

```ts
/**
 * 弱项判断的预测力验证（清洗重构 spec §3.3）。
 *
 * 目的：证明（或证否）「概念级弱项」比「仅看难度」更有预测力。
 * 方法：按时间切分提交，用前 80% 拟合 P(WA | code, bucket)，预测后 20% 的失败，
 * 报告 AUC 并对照「仅用难度桶」的基线。
 *
 * ⚠️ 允许证否：若概念层 AUC 不显著高于难度基线，说明概念无增量价值，
 * 应在输出里明确写出结论并停止扩展该方向，而不是调参到看起来可用。
 *
 * 用法：cd server && npx tsx scripts/validate-weakness.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from '../src/db/index.ts';

/** 得分 → 是否为正样本的 AUC（Mann-Whitney U，tie 计 0.5） */
export function auc(scores: number[], labels: boolean[]): number {
  if (scores.length !== labels.length) throw new Error('scores 与 labels 长度不一致');
  const pos: number[] = [];
  const neg: number[] = [];
  for (let i = 0; i < scores.length; i += 1) (labels[i] ? pos : neg).push(scores[i]);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let wins = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1;
      else if (p === n) wins += 0.5;
    }
  }
  return wins / (pos.length * neg.length);
}

/** 按时间升序切分为 train/test 两段（保证 train 全部早于 test） */
export function splitByTime<T extends { submittedAt: string }>(
  rows: T[],
  trainRatio: number,
): { train: T[]; test: T[] } {
  const sorted = [...rows].sort((a, b) => (a.submittedAt < b.submittedAt ? -1 : a.submittedAt > b.submittedAt ? 1 : 0));
  const cut = Math.floor(sorted.length * trainRatio);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

interface SubRow {
  problemId: number;
  verdict: string;
  submittedAt: string;
  difficulty: number | null;
}

function bucketOf(d: number | null): string {
  if (d === null) return '未知';
  if (d < 1200) return '<1200';
  if (d < 1400) return '1200-1399';
  if (d < 1600) return '1400-1599';
  if (d < 1900) return '1600-1899';
  if (d < 2200) return '1900-2199';
  return '2200+';
}

function main(): void {
  const db = createDb(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'icpc.db'));
  const subs = db
    .prepare(
      `SELECT s.problem_id AS problemId, s.verdict, s.submitted_at AS submittedAt, p.difficulty
         FROM submissions s JOIN problems p ON p.id = s.problem_id
        WHERE s.user_id = 1`,
    )
    .all() as unknown as SubRow[];

  console.log(`提交样本: ${subs.length} 条`);
  if (subs.length < 50) {
    console.log('⚠️  样本过少（<50），本验证无统计功效，结论不可用。');
    console.log('    这也正是为什么需要 submission_intents：带明确意图的样本信息量远高于模糊的题目标签。');
    db.close();
    return;
  }

  // 每题的知识点 code
  const kpRows = db
    .prepare("SELECT problem_id AS problemId, code FROM problem_keypoints WHERE source IN ('tag','rule','manual')")
    .all() as unknown as Array<{ problemId: number; code: string }>;
  const codesByProblem = new Map<number, string[]>();
  for (const k of kpRows) {
    const a = codesByProblem.get(k.problemId) ?? [];
    a.push(k.code);
    codesByProblem.set(k.problemId, a);
  }

  const { train, test: testSet } = splitByTime(subs, 0.8);
  const isFail = (v: string): boolean => v !== 'AC';

  // 概念层：按 (code, bucket) 统计训练集失败率
  const stat = new Map<string, { n: number; fail: number }>();
  const bucketStat = new Map<string, { n: number; fail: number }>();
  const bump = (m: Map<string, { n: number; fail: number }>, k: string, fail: boolean): void => {
    const e = m.get(k) ?? { n: 0, fail: 0 };
    e.n += 1;
    if (fail) e.fail += 1;
    m.set(k, e);
  };
  for (const s of train) {
    const b = bucketOf(s.difficulty);
    const f = isFail(s.verdict);
    bump(bucketStat, b, f);
    for (const c of codesByProblem.get(s.problemId) ?? []) bump(stat, `${c}\u0000${b}`, f);
  }
  const globalFail =
    train.length === 0 ? 0.5 : train.filter((s) => isFail(s.verdict)).length / train.length;

  // 预测
  const conceptScores: number[] = [];
  const bucketScores: number[] = [];
  const labels: boolean[] = [];
  let codesCovered = 0;
  for (const s of testSet) {
    const b = bucketOf(s.difficulty);
    const codes = codesByProblem.get(s.problemId) ?? [];
    let score = globalFail;
    if (codes.length > 0) {
      codesCovered += 1;
      // 多 code 取失败率最高者：任一知识点薄弱即可能失败
      const rates = codes.map((c) => {
        const e = stat.get(`${c}\u0000${b}`);
        return e && e.n > 0 ? e.fail / e.n : globalFail;
      });
      score = Math.max(...rates);
    }
    conceptScores.push(score);
    const be = bucketStat.get(b);
    bucketScores.push(be && be.n > 0 ? be.fail / be.n : globalFail);
    labels.push(isFail(s.verdict));
  }

  const aConcept = auc(conceptScores, labels);
  const aBucket = auc(bucketScores, labels);
  const posRate = labels.filter(Boolean).length / Math.max(1, labels.length);

  console.log(`\n=== 验证结果 ===`);
  console.log(`  训练/测试: ${train.length} / ${testSet.length}（按时间切分）`);
  console.log(`  测试集失败率: ${(posRate * 100).toFixed(1)}%`);
  console.log(`  测试集中有知识点 code 的题: ${codesCovered} / ${testSet.length}`);
  console.log(`\n  AUC（概念 × 难度）: ${aConcept.toFixed(3)}`);
  console.log(`  AUC（仅难度桶）    : ${aBucket.toFixed(3)}   ← 基线`);
  console.log(`  AUC（随机）        : 0.500`);
  console.log(`\n  增量: ${(aConcept - aBucket >= 0 ? '+' : '')}${(aConcept - aBucket).toFixed(3)}`);

  if (testSet.length < 100) {
    console.log(`\n⚠️  测试集仅 ${testSet.length} 条，AUC 置信区间极宽，以上数字不足以支撑结论。`);
  }
  if (aConcept <= aBucket) {
    console.log(`\n❌ 结论：概念层未跑赢「仅看难度」基线。`);
    console.log(`   按 spec §3.3 的约定，这表明题目级概念标签对预测失败无增量价值——`);
    console.log(`   应停止扩展该方向，转而依靠 submission_intents 的用户声明。`);
  } else {
    console.log(`\n✅ 结论：概念层优于难度基线，弱项判断具备增量价值。`);
  }

  // 每概念样本数（功效提示）
  console.log(`\n=== 各 (code × bucket) 训练样本数（<20 视为功效不足） ===`);
  const sorted = [...stat.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20);
  for (const [k, e] of sorted) {
    const [code, b] = k.split('\u0000');
    const flag = e.n < 20 ? '  ⚠️ 功效不足' : '';
    console.log(`  ${code.padEnd(26)} ${b.padEnd(11)} n=${String(e.n).padStart(4)}  失败率=${((e.fail / e.n) * 100).toFixed(0)}%${flag}`);
  }
  db.close();
}

// 仅在被直接执行时跑（被测试 import 时不触发）
if (process.argv[1] && process.argv[1].endsWith('validate-weakness.ts')) main();
```

- [ ] **Step 4: 运行确认通过**

Run: `cd server && npx tsx --test test/validate-weakness.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 在真实库上跑一次并记录结果**

Run: `cd server && npx tsx scripts/validate-weakness.ts`
Expected: 输出 AUC 与基线对照。**当前库仅 949 条提交，脚本应打印「测试集仅 N 条，置信区间极宽」的告警** —— 这符合 spec §3.4 的诚实约束。把输出贴进 commit message。

- [ ] **Step 6: Commit**

```bash
git add server/scripts/validate-weakness.ts server/test/validate-weakness.test.ts
git commit -m "feat(knowledge): 弱项预测力验证脚本（AUC + 仅难度基线对照）"
```

---

### Task 11: 消费端口径同步与文档

**Files:**
- Modify: `server/src/analysis/mastery.ts`（确认多 code 口径正确）
- Modify: `server/src/plans/planService.ts`（补注释说明有意保留的差异）
- Modify: `server/src/routes/knowledge.ts`（`getCoverage` 的语义随 AI 退出调整）
- Modify: `server/src/knowledge/store.ts`（`getCoverage` 去掉 AI 相关计数）
- Modify: `README.md`、`README.en.md`（API 一览补 `/api/knowledge/gaps`、`/recompute-stats`、intent 端点）
- Test: `server/test/knowledge-coverage.test.ts`（新建）

**Interfaces:**
- Consumes: 前 10 个任务的全部产出
- Produces: `KnowledgeCoverage` 去掉 `bySource.ai` 的误导性呈现（字段保留但含义改为 tag/rule/manual 三来源）

- [ ] **Step 1: 写失败测试**

新建 `server/test/knowledge-coverage.test.ts`：

```ts
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, type Db } from '../src/db/index.ts';
import { getCoverage } from '../src/knowledge/store.ts';

let db: Db;
beforeEach(() => { db = createDb(':memory:'); });
afterEach(() => { db.close(); });

test('getCoverage: 不计入 ai 标注（AI 已退出清洗模块）', () => {
  db.prepare("INSERT INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','A','T',1500,'[]')").run();
  db.prepare("INSERT INTO problems (platform,problem_key,title,difficulty,tags) VALUES ('codeforces','B','T',1500,'[]')").run();
  const ins = db.prepare(`INSERT INTO problem_keypoints
    (platform,problem_key,code,name,confidence,source,method,taxonomy_version,pipeline_version,annotated_at)
    VALUES ('codeforces',?,?,'n',1,?,'x',1,1,'2026-01-01')`);
  ins.run('A', 'basic.greedy', 'tag');
  ins.run('B', 'basic.greedy', 'ai');   // 不应计入
  const cov = getCoverage(db);
  assert.equal(cov.total, 2);
  assert.equal(cov.annotated, 1, '只有 tag 那题算已标注');
  assert.equal(cov.bySource.ai ?? 0, 0);
  assert.equal(cov.bySource.tag, 1);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd server && npx tsx --test test/knowledge-coverage.test.ts`
Expected: FAIL —— `annotated` 实得 2（ai 被计入），`bySource.ai` 实得 1。

- [ ] **Step 3: 改 getCoverage**

`server/src/knowledge/store.ts` 的 `getCoverage`：把所有 `problem_keypoints` 查询加上 `AND source IN ('tag','rule','manual')`；`bySource` 的初始化改为 `{ tag: 0, rule: 0, manual: 0 }`；删除 `pending`/`retrying`/`failed` 三个队列相关字段（队列已转缺口清单，见 Task 9），或保留 `pending` 但语义改为「未覆盖题数」。**同时更新 `shared/src/index.ts` 的 `KnowledgeCoverage` 接口**，删掉不再产出的字段。

- [ ] **Step 4: 运行确认通过**

Run: `cd server && npx tsx --test test/knowledge-coverage.test.ts`
Expected: PASS

- [ ] **Step 5: 补 planService 注释（消除隐性口径分裂）**

在 `server/src/plans/planService.ts` 的 `recommendProblems` / `recommendProblemsByWeakTag` / `practicePool` 三个函数上方各加一行说明：

```ts
// 口径说明（有意保留的差异）：本函数读 p.tags（题源原始标签）而非知识点标注。
// 原因是它做的是「候选池筛选」（需要尽量宽地捞出可练的题），
// 而弱项判断读知识点标注——与 analysis/weakness.ts 的口径不同是刻意的，
// 见 docs/superpowers/specs/2026-09-13-knowledge-cleaning-redesign.md §2.5。
```

- [ ] **Step 6: 更新 README（中英同步）**

在 `README.md` 的 API 一览中，删除已移除的端点并补新增端点：

```
GET  /api/knowledge/gaps           # 词表缺口报告（无法映射的题源标签 → 影响题数）
POST /api/knowledge/recompute-stats # 重算概念统计（覆盖率与信息量）
POST /api/problems/:platform/:key/intent   # 记录用户声明的卡点（body: outcome, code?）
GET  /api/problems/:platform/:key/intents  # 该题的卡点记录
```

同时删除 `/api/knowledge/retry-failed`，并把 `POST /api/knowledge/build` 的描述从「L1 + L2」改为「L1（规则 + 题源标签映射）」。
`README.en.md` 同步同样改动（英文描述）。

- [ ] **Step 7: 跑全量测试 + typecheck + lint + Commit**

Run: `cd "D:\01-代码项目\工作台" && npm run typecheck && npm run lint && npm test`
Expected: 全部通过

```bash
git add -A
git commit -m "docs(knowledge): 消费端口径同步与 README 更新（中英）"
```

---

## 完成标准

全部 11 个任务完成后，必须同时满足：

- [ ] `npm run typecheck` 无错误
- [ ] `npm run lint` **0 errors**（client 既有 11 个 warning 不增加）
- [ ] `npm test` 全绿（server 测试数会因本任务删除 `knowledge-ai.test.ts` 而下降，但其覆盖的映射逻辑已由 Task 2/9 的新测试补回）
- [ ] `GET /api/knowledge/coverage` 的 `bySource.ai` 为 0，且 `annotated` 不包含任何 `source='ai'` 行
- [ ] `SELECT COUNT(*) FROM problem_keypoints WHERE source='ai'` 为 **0**
- [ ] 重启服务后该计数仍为 0（证明 JSONL tombstone 生效，AI 标注未复活）
- [ ] `GET /api/knowledge/gaps` 返回非空缺口清单（当前库应有约 3,583 题受未收录标签影响）
- [ ] 题目页「卡在哪」可一键写入并在 `submission_intents` 中查到
- [ ] `npx tsx server/scripts/validate-weakness.ts` 能运行并输出 AUC + 基线对照 + 样本量告警

## 已知不做（YAGNI）

- 不补 `misc.simulation` 之外的更多细粒度拆分（如把「数学」拆成数论/组合/概率）——先看粗粒度层把覆盖率推到多少再决定
- 不做意图采集的历史回溯（不能补记过去的提交）
- 不在「今日训练」/「复习库」页加「卡在哪」入口（Task 8 只在题目管理页落地，其余作为后续增量）
- ~~不删除 `aiClassify.ts` 文件与 `problem_topics` 表~~ → **已于 2026-09-13 改为在 Task 9 一并删除**（见 Task 9 的「为什么本任务额外删这些」）。原判断「保留作离线导出通道」理据不成立：该通道做的就是让 AI 清洗知识点本身，与用户「AI 退出清洗模块」的决策矛盾；`problem_topics` 则因 Task 3 摘除读取后已成纯负债。
- 不做 `DROP TABLE problem_topics` 的物理清理（老库会留下该空表；写入/读取路径已全删，不影响行为；物理删表不可逆且无收益）
- 不补 `tagAnnotate` 的「同义组细化」——先看 89.7% 覆盖率稳定后，再按 `GET /api/knowledge/gaps` 的缺口排行决定补哪些词表
