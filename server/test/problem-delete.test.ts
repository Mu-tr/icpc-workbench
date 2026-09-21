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
  d.prepare("INSERT OR IGNORE INTO platforms (id,name,has_official_api) VALUES ('codeforces','CF',1)").run();
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (1,'codeforces','1A','T',1500,'[]')",
  ).run();
  // 重复/镜像题（issue #27 的删除对象）：同题不同 id 无法在同库出现（UNIQUE 约束），
  // 用户实际遇到的重复是跨平台镜像或误导入行 —— 这里用第二行模拟「想清掉的行」
  d.prepare(
    "INSERT INTO problems (id,platform,problem_key,title,difficulty,tags) VALUES (2,'atcoder','abc001_a','T',1000,'[]')",
  ).run();
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

test('DELETE: 连带清理提交/复习/卡点/知识点，训练计划任务仅解除引用', async () => {
  await withServer(async (base) => {
    const d = db!;
    // 从属数据：2 条提交、1 条复习、1 条卡点、1 条知识点标注、1 个引用该题的计划任务
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',1,'AC','2024-01-01T00:00:00.000Z','s1')",
    ).run();
    d.prepare(
      "INSERT INTO submissions (user_id,platform,problem_id,verdict,submitted_at,external_id) VALUES (1,'codeforces',1,'WA','2024-01-02T00:00:00.000Z','s2')",
    ).run();
    d.prepare(
      "INSERT INTO review_items (user_id,problem_id,next_due_on,note) VALUES (1,1,'2024-01-10','笔记')",
    ).run();
    d.prepare(
      "INSERT INTO submission_intents (user_id,problem_id,outcome) VALUES (1,1,'implementation')",
    ).run();
    d.prepare(
      "INSERT INTO problem_keypoints (platform,problem_key,code,confidence,source,method,taxonomy_version,pipeline_version,annotated_at) VALUES ('codeforces','1A','basic.dp',0.9,'rule','rule#r001',1,1,'2024-01-01T00:00:00.000Z')",
    ).run();
    d.prepare(
      "INSERT INTO plans (id,user_id,title,goal,start_date,end_date,source) VALUES (1,1,'p','g','2024-01-01','2024-01-31','manual')",
    ).run();
    d.prepare(
      "INSERT INTO plan_tasks (id,plan_id,task_date,title,kind,problem_id) VALUES (1,1,'2024-01-05','练 1A','practice',1)",
    ).run();

    const res = await fetch(`${base}/1`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; deletedSubmissions: number; deletedReviewItems: number };
    assert.equal(body.ok, true);
    assert.equal(body.deletedSubmissions, 2);
    assert.equal(body.deletedReviewItems, 1);

    assert.equal((d.prepare('SELECT COUNT(*) c FROM problems WHERE id = 1').get() as { c: number }).c, 0);
    assert.equal((d.prepare('SELECT COUNT(*) c FROM submissions').get() as { c: number }).c, 0);
    assert.equal((d.prepare('SELECT COUNT(*) c FROM review_items').get() as { c: number }).c, 0);
    assert.equal((d.prepare('SELECT COUNT(*) c FROM submission_intents').get() as { c: number }).c, 0);
    assert.equal(
      (d.prepare("SELECT COUNT(*) c FROM problem_keypoints WHERE platform = 'codeforces' AND problem_key = '1A'").get() as { c: number }).c,
      0,
    );
    // 任务保留，仅解除题目引用
    const task = d.prepare('SELECT title, problem_id FROM plan_tasks WHERE id = 1').get() as {
      title: string;
      problem_id: number | null;
    };
    assert.equal(task.title, '练 1A');
    assert.equal(task.problem_id, null);

    // 无关题目不受影响
    assert.equal((d.prepare('SELECT COUNT(*) c FROM problems WHERE id = 2').get() as { c: number }).c, 1);
  });
});

test('DELETE: 不存在的 id 返回 404，非法 id 返回 400', async () => {
  await withServer(async (base) => {
    const missing = await fetch(`${base}/999`, { method: 'DELETE' });
    assert.equal(missing.status, 404);

    const invalid = await fetch(`${base}/abc`, { method: 'DELETE' });
    assert.equal(invalid.status, 400);
  });
});
