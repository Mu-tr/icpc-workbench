import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../src/db/index.ts';
import { AiProvider } from '../src/ai/provider.ts';
import {
  buildClassifyMessages,
  cleanJsonText,
  exportQueuePackage,
  importAiResults,
  parseClassifyResponse,
  runAiPass,
  validateItems,
} from '../src/knowledge/aiClassify.ts';
import { annotateProblemsL1, failedAiCount, pendingAiCount, retryFailedQueue, runRulePass } from '../src/knowledge/pipeline.ts';
import { getCoverage, initKnowledgeStore, keypointsOfProblem } from '../src/knowledge/store.ts';
import { allPoints } from '../src/knowledge/taxonomy.ts';

function tempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-ai-test-'));
}

function mockProvider(content: string): AiProvider {
  const fetchFn = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
  return new AiProvider({ enabled: true, baseURL: 'http://mock', apiKey: 'k', model: 'mock-model' }, fetchFn);
}

/** 按调用次序回放不同响应的 mock（验证纠正重试），并记录每次请求的 system 提示词 */
function scriptedProvider(contents: string[]): {
  provider: AiProvider;
  calls: () => number;
  systemPrompts: () => string[];
} {
  let i = 0;
  const systems: string[] = [];
  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    const content = contents[Math.min(i, contents.length - 1)];
    systems.push(JSON.parse(init?.body ?? '{}').messages[0].content as string);
    i += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return {
    provider: new AiProvider({ enabled: true, baseURL: 'http://mock', apiKey: 'k', model: 'mock-model' }, fetchFn),
    calls: () => i,
    systemPrompts: () => systems,
  };
}

test('提示词只含标题+难度+taxonomy，绝不含题源 tag（红线）', () => {
  const messages = buildClassifyMessages([
    { platform: 'codeforces', problemKey: '9A', title: 'A. Xor Tree', difficulty: 1900 },
  ]);
  const user = messages[1].content as string;
  assert.ok(user.includes('Xor Tree'));
  assert.ok(!user.includes('tags'));
  // taxonomy 候选清单完整
  for (const p of allPoints().slice(0, 5)) {
    assert.ok((messages[0].content as string).includes(p.code));
  }
});

test('JSON 清洗：围栏 + 解释文字均可解析（复用计划导入同策略）', () => {
  assert.equal(cleanJsonText('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(cleanJsonText('好的，结果如下：\n{"a":1}'), '{"a":1}');
  // 老格式：裸题号 problemKey（升级前导出的数据包仍需可解析）
  const items = parseClassifyResponse('```json\n{"results":[{"problemKey":"1A","codes":["dp.general"],"confidence":0.9}]}\n```');
  assert.deepEqual(items, [{ ref: '1A', codes: ['dp.general'], confidence: 0.9 }]);
  // 新格式：复合身份 id
  const byId = parseClassifyResponse('{"results":[{"id":"luogu|P1001","codes":["dp.general"],"confidence":0.9}]}');
  assert.deepEqual(byId, [{ ref: 'luogu|P1001', codes: ['dp.general'], confidence: 0.9 }]);
  assert.throws(() => parseClassifyResponse('不是 JSON'));
});

test('JSON 清洗：JSON 后追加解释文字/第二个 JSON 块（括号配对截取，防批次失败）', () => {
  // 回归：真实批跑曾因此报「Unexpected non-whitespace character after JSON」整批中止
  assert.equal(cleanJsonText('{"a":1}\n以上是标注结果。'), '{"a":1}');
  assert.equal(cleanJsonText('{"a":1}\n```\n希望对你有帮助'), '{"a":1}');
  assert.equal(cleanJsonText('{"a":"含}与\\"转义"} trailing {"b":2}'), '{"a":"含}与\\"转义"}');
  const items = parseClassifyResponse(
    '{"results":[{"problemKey":"1A","codes":["dp.general"],"confidence":0.9}]}\n以上 25 题标注完成，均采用保守策略。',
  );
  assert.deepEqual(items, [{ ref: '1A', codes: ['dp.general'], confidence: 0.9 }]);
});

test('校验：幻觉 code 丢弃、批次外标识丢弃、空 codes 落 uncertain', () => {
  const batch = [
    { platform: 'codeforces', problemKey: '7A', title: 't', difficulty: null },
    { platform: 'codeforces', problemKey: '7B', title: 't', difficulty: null },
  ];
  const v = validateItems(
    [
      { ref: '7A', codes: ['dp.general', 'dp.not-exist', '贪心'], confidence: 0.8 },
      { ref: 'ZZZ', codes: ['dp.general'], confidence: 0.8 },
    ],
    batch,
  );
  assert.equal(v.writes.length, 1);
  assert.deepEqual(v.writes[0].points.map((p) => p.code), ['dp.general']);
  assert.deepEqual(v.droppedHallucinations.map((d) => d.code), ['dp.not-exist', '贪心']);
  assert.deepEqual(v.uncertain.map((u) => u.problemKey), ['7B']);
});

test('跨平台同题号：复合身份精确落题，裸题号重名记 ambiguous 且绝不猜平台', () => {
  const batch = [
    { platform: 'luogu', problemKey: '1001', title: 'A. 洛谷题', difficulty: null },
    { platform: 'codeforces', problemKey: '1001', title: 'B. CF 题', difficulty: null },
  ];
  // 复合身份：精确落到各自平台
  const ok = validateItems([{ ref: 'luogu|1001', codes: ['dp.general'], confidence: 0.8 }], batch);
  assert.equal(ok.writes.length, 1);
  assert.equal(ok.writes[0].platform, 'luogu');
  assert.equal(ok.writes[0].problemKey, '1001');
  assert.equal(ok.ambiguous.length, 0);
  // 裸题号 + 批内重名：不写库、不猜，记 ambiguous；两题保持 pending（不出队）等待下一轮
  const amb = validateItems([{ ref: '1001', codes: ['dp.general'], confidence: 0.8 }], batch);
  assert.equal(amb.writes.length, 0);
  assert.equal(amb.ambiguous.length, 1);
  assert.deepEqual(amb.ambiguous[0].candidates.sort(), ['codeforces|1001', 'luogu|1001']);
  // 走 answered 而非 uncertain：这两题不能被标 uncertain 出队，否则永远无法被修正
  assert.deepEqual(amb.uncertain, []);
});

test('跨平台同题号端到端：importAiResults 不把知识点贴错平台', () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('luogu', '1001', 'A. 洛谷题', '[]')").run();
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '1001', 'B. CF 题', '[]')").run();
    annotateProblemsL1(db, [
      { platform: 'luogu', problemKey: '1001', title: 'A. 洛谷题' },
      { platform: 'codeforces', problemKey: '1001', title: 'B. CF 题' },
    ]);
    const r = importAiResults(db, '{"results":[{"id":"luogu|1001","codes":["dp.general"],"confidence":0.9}]}');
    assert.equal(r.annotated, 1);
    assert.equal(keypointsOfProblem(db, 'luogu', '1001').length, 1);
    assert.equal(keypointsOfProblem(db, 'codeforces', '1001').length, 0); // 关键：没有串到另一平台
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('L2 批跑：mock AI 落库 source=ai、队列出队、断点可续', async () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '8A', 'A. 无信息题', '[]')").run();
    annotateProblemsL1(db, [{ platform: 'codeforces', problemKey: '8A', title: 'A. 无信息题' }]);
    assert.equal(pendingAiCount(db), 1);

    const provider = mockProvider('{"results":[{"problemKey":"8A","codes":["math.number-theory"],"confidence":0.72}]}');
    const r = await runAiPass(db, provider);
    assert.equal(r.annotated, 1);
    assert.equal(r.remaining, 0);
    const kp = keypointsOfProblem(db, 'codeforces', '8A');
    assert.equal(kp[0].code, 'math.number-theory');
    assert.equal(kp[0].source, 'ai');
    assert.equal(pendingAiCount(db), 0);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('L2 批次失败：保持 pending 不丢题，剩余可续跑', async () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '9B', 'B. 无信息题', '[]')").run();
    annotateProblemsL1(db, [{ platform: 'codeforces', problemKey: '9B', title: 'B. 无信息题' }]);
    const failFetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const provider = new AiProvider({ enabled: true, baseURL: 'http://mock', apiKey: 'k', model: 'm' }, failFetch);
    const r = await runAiPass(db, provider);
    assert.ok(r.failedBatch);
    assert.equal(r.remaining, 1); // 仍在队列，下次续跑
    assert.equal(r.retried, 1); // 未达重试上限：推到队尾等下一轮
    assert.equal(r.gaveUp, 0);
    assert.equal(pendingAiCount(db), 1);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('L2 队列状态机：失败累计 attempts，超限转 failed 出队，可显式捞回', async () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  const readRow = () =>
    db
      .prepare("SELECT status, attempts, last_error FROM knowledge_queue WHERE platform = 'codeforces' AND problem_key = '9C'")
      .get() as { status: string; attempts: number; last_error: string | null };
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '9C', 'C. 无信息题', '[]')").run();
    annotateProblemsL1(db, [{ platform: 'codeforces', problemKey: '9C', title: 'C. 无信息题' }]);
    const failFetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    const provider = new AiProvider({ enabled: true, baseURL: 'http://mock', apiKey: 'k', model: 'm' }, failFetch);

    for (let i = 1; i <= 3; i++) {
      const r = await runAiPass(db, provider, { maxAttempts: 3 });
      assert.ok(r.failedBatch);
      const row = readRow();
      assert.equal(row.attempts, i); // 每轮失败都累计 attempts（原实现为死字段，永远是 0）
      assert.equal(row.last_error, 'network down');
      if (i < 3) {
        assert.equal(row.status, 'pending'); // 未超限：留在队列
        assert.equal(r.retried, 1);
        assert.equal(r.gaveUp, 0);
      } else {
        assert.equal(row.status, 'failed'); // 超限：出队，不再反复重试
        assert.equal(r.gaveUp, 1);
      }
    }
    assert.equal(pendingAiCount(db), 0);
    assert.equal(failedAiCount(db), 1);
    assert.equal(getCoverage(db).failed, 1); // 失败数进了覆盖率报告，用户可见

    // 显式捞回
    assert.equal(retryFailedQueue(db), 1);
    assert.equal(pendingAiCount(db), 1);
    assert.equal(readRow().attempts, 0);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('标题指纹：标题被修复后 rule 标注失效并差量重跑', () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '12A', '12A. 二分查找', '[]')").run();
    annotateProblemsL1(db, [{ platform: 'codeforces', problemKey: '12A', title: '12A. 二分查找' }]);
    const hit = db
      .prepare("SELECT annotated_title, source FROM problem_keypoints WHERE platform = 'codeforces' AND problem_key = '12A'")
      .get() as { annotated_title: string; source: string } | undefined;
    assert.ok(hit);
    assert.equal(hit.source, 'rule');
    assert.equal(hit.annotated_title, '12A. 二分查找'); // 记录标注当时的标题

    // 标题被修复成完全无关的内容（原规则不再命中）→ rerun 应清掉过期的 rule 标注
    db.prepare("UPDATE problems SET title = '12A. zzzqqq' WHERE platform = 'codeforces' AND problem_key = '12A'").run();
    const r = runRulePass(db, { rerun: true });
    assert.equal(r.scanned, 1); // 关键：标题变更本身就能把题选进差量重跑集合
    assert.equal(keypointsOfProblem(db, 'codeforces', '12A').filter((k) => k.source === 'rule').length, 0);
    assert.equal(pendingAiCount(db), 1); // 失效后重新排入 L2
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('标题指纹：标题修复后 AI 标注回队重标（无指纹的旧标注不动）', async () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('luogu', 'P8888', 'P8888 zzzqqq', '[]')").run();
    annotateProblemsL1(db, [{ platform: 'luogu', problemKey: 'P8888', title: 'P8888 zzzqqq' }]);
    const provider = mockProvider('{"results":[{"id":"luogu|P8888","codes":["dp.general"],"confidence":0.9}]}');
    await runAiPass(db, provider);
    assert.equal(pendingAiCount(db), 0);
    const aiRow = db
      .prepare("SELECT annotated_title FROM problem_keypoints WHERE platform = 'luogu' AND problem_key = 'P8888' AND source = 'ai'")
      .get() as { annotated_title: string | null };
    assert.equal(aiRow.annotated_title, 'P8888 zzzqqq');

    db.prepare("UPDATE problems SET title = 'P8888 修好了' WHERE platform = 'luogu' AND problem_key = 'P8888'").run();
    runRulePass(db, { rerun: true });
    assert.equal(pendingAiCount(db), 1); // 标题变了 → AI 标注陈旧 → 回队

    // 保守侧：没有标题指纹的旧 AI 标注不在这里被翻出来（避免升级后一次性重跑付费全量）
    db.prepare("UPDATE problem_keypoints SET annotated_title = NULL WHERE platform = 'luogu' AND problem_key = 'P8888'").run();
    db.prepare("UPDATE knowledge_queue SET status = 'done' WHERE platform = 'luogu' AND problem_key = 'P8888'").run();
    runRulePass(db, { rerun: true });
    assert.equal(pendingAiCount(db), 0);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('无 Key 导出通道：导出数据包 + 导入 AI 结果闭环', () => {  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('luogu', 'P9999', '某未标题', '[]')").run();
    annotateProblemsL1(db, [{ platform: 'luogu', problemKey: 'P9999', title: '某未标题' }]);
    const pkg = exportQueuePackage(db);
    assert.ok(pkg.includes('P9999'));
    assert.ok(pkg.includes('知识点清单'));

    const r = importAiResults(db, '{"results":[{"problemKey":"P9999","codes":["graph.shortest-path"],"confidence":0.66}]}');
    assert.equal(r.annotated, 1);
    const kp = keypointsOfProblem(db, 'luogu', 'P9999');
    assert.equal(kp[0].source, 'ai');
    assert.equal(kp[0].method, 'ai:manual-import');
    assert.equal(pendingAiCount(db), 0);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('复合身份容忍模型回抄小错：平台大小写不一、分隔符夹空格', () => {
  const batch = [
    { platform: 'luogu', problemKey: '1001', title: 't', difficulty: null },
    { platform: 'codeforces', problemKey: '1001', title: 't', difficulty: null },
  ];
  const v = validateItems(
    [
      { ref: 'Luogu|1001', codes: ['dp.general'], confidence: 0.8 },
      { ref: 'codeforces | 1001', codes: ['graph.shortest-path'], confidence: 0.7 },
    ],
    batch,
  );
  assert.equal(v.writes.length, 2);
  assert.deepEqual(
    v.writes.map((w) => `${w.platform}|${w.problemKey}`).sort(),
    ['codeforces|1001', 'luogu|1001'],
  );
});

test('L2 零进展批：带纠正信息自动重试一次，第二次正确回抄即落库', async () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('luogu', '2001', 't1', '[]')").run();
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '2001', 't2', '[]')").run();
    annotateProblemsL1(db, [
      { platform: 'luogu', problemKey: '2001', title: 't1' },
      { platform: 'codeforces', problemKey: '2001', title: 't2' },
    ]);
    assert.equal(pendingAiCount(db), 2);

    // 第一次只回裸题号（批内跨平台重名 → 整批 ambiguous），第二次带前缀正确回抄
    const bad = '{"results":[{"id":"2001","codes":["dp.general"],"confidence":0.9}]}';
    const good =
      '{"results":[{"id":"luogu|2001","codes":["dp.general"],"confidence":0.9},{"id":"codeforces|2001","codes":["graph.shortest-path"],"confidence":0.8}]}';
    const { provider, calls, systemPrompts } = scriptedProvider([bad, good]);
    const r = await runAiPass(db, provider);
    assert.equal(calls(), 2); // 恰好一次纠正重试
    assert.match(systemPrompts()[1], /重要纠正/);
    assert.equal(r.annotated, 2);
    assert.equal(r.demoted ?? 0, 0);
    assert.equal(r.stalled, undefined);
    assert.equal(pendingAiCount(db), 0);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});

test('L2 纠正重试仍失败：整批转存疑出队放行队列，不再永久卡死', async () => {
  const dataDir = tempDataDir();
  initKnowledgeStore(dataDir);
  const db = createDb(':memory:');
  try {
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('luogu', '2002', 't1', '[]')").run();
    db.prepare("INSERT INTO problems (platform, problem_key, title, tags) VALUES ('codeforces', '2002', 't2', '[]')").run();
    annotateProblemsL1(db, [
      { platform: 'luogu', problemKey: '2002', title: 't1' },
      { platform: 'codeforces', problemKey: '2002', title: 't2' },
    ]);
    // 模型屡教不改：始终只回裸题号
    const bad = '{"results":[{"id":"2002","codes":["dp.general"],"confidence":0.9}]}';
    const { provider, calls } = scriptedProvider([bad, bad]);
    const r = await runAiPass(db, provider, { maxBatches: 5 });
    assert.equal(calls(), 2); // 首次 + 一次纠正重试，不多烧
    assert.equal(r.demoted, 2);
    assert.equal(r.uncertain, 2);
    assert.equal(r.annotated, 0);
    assert.equal(r.stalled, undefined); // 不再以 stalled 中止
    assert.equal(pendingAiCount(db), 0); // 队列被放行
    const rows = db
      .prepare("SELECT status FROM knowledge_queue WHERE problem_key = '2002' ORDER BY platform")
      .all() as Array<{ status: string }>;
    assert.deepEqual(rows.map((x) => x.status), ['uncertain', 'uncertain']); // 进人工校正池
    // 绝不猜平台：没有写任何标注
    assert.equal(keypointsOfProblem(db, 'luogu', '2002').length, 0);
    assert.equal(keypointsOfProblem(db, 'codeforces', '2002').length, 0);
  } finally {
    db.close();
    initKnowledgeStore(null);
  }
});
