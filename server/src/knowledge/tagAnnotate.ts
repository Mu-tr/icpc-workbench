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
import {
  appendAnnotations,
  effectiveDataDir,
  writeAnnotationsToDb,
  type AnnotationWrite,
  type JsonlLine,
} from './store.ts';

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
  /**
   * 本批写入的 JSONL 行。
   * 调用方传 `dataDir: null`（L1 钩子即如此：JSONL 由外层统一在 COMMIT 前追加，
   * 避免同一事务窗口内追加两次）时，必须自行把本字段一并追加，否则 tag 标注
   * 只存在于库里、不在源真相里，下次启动重建即整体丢失。
   */
  lines: JsonlLine[];
}

/** 解析 problems.tags（JSON 数组字符串）；损坏或非数组视为无标签 */
function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((t): t is string => typeof t === 'string');
  } catch {
    return [];
  }
  return [];
}

/**
 * 当前是否已处于事务中。
 * node:sqlite 的 `DatabaseSync.isTransaction`（Node ≥ 22.13 / 23.3）直接可用；
 * 更早版本没有该属性，退化为「试开一次事务」探测：BEGIN 失败即说明外层已持有事务。
 */
function inTransaction(db: Db): boolean {
  if (typeof db.isTransaction === 'boolean') return db.isTransaction;
  try {
    db.exec('BEGIN');
    db.exec('ROLLBACK');
    return false;
  } catch {
    return true;
  }
}

/**
 * 批量为题目写入 tag 来源标注。
 * 已有人工标注（source='manual'）的题整题跳过（人工置顶）；
 * 已有 tag 标注的题跳过（增量语义）。
 * 其它来源已占用的 code 跳过：`problem_keypoints` 主键是 `(platform, problem_key, code)`，
 * 不含 source —— 同一 code 只允许一行。rule/manual/ai 已认领的 code 由它们保留
 * （与 `loadAnnotationsIntoDb` 重放时的来源优先级 rule > tag 一致），本层只补空缺，
 * 否则重复插入会触发 UNIQUE 约束、把整个 L1 批事务回滚。
 *
 * 事务：本函数自带事务（BEGIN → 写库 → append JSONL → COMMIT，异常 ROLLBACK）。
 * 若调用方已持有事务（L1 钩子），改用 SAVEPOINT 参与外层事务，不自行提交。
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
  const takenCodes = db.prepare(
    'SELECT code FROM problem_keypoints WHERE platform = ? AND problem_key = ?',
  );

  const writes: AnnotationWrite[] = [];
  const unmapped = new Set<string>();
  let scanned = 0;

  for (const row of rows) {
    if (hasManual.get(row.platform, row.problemKey)) continue;
    if (hasTag.get(row.platform, row.problemKey)) continue;
    scanned += 1;

    const raw = parseTags(row.tags);
    const codes = tagsToCodes(raw);
    if (codes.length === 0) {
      for (const t of raw) if (codeOfTag(t) === undefined) unmapped.add(t);
      continue;
    }
    // 已被其它来源占用的 code 不再写本层（见函数注释：主键不含 source）
    const taken = new Set((takenCodes.all(row.platform, row.problemKey) as Array<{ code: string }>).map((x) => x.code));
    const fresh = codes.filter((code) => !taken.has(code));
    if (fresh.length === 0) continue;

    // 落库 confidence 固定 1：本字段已降级为「来源内排序权重」，不再是可信度
    writes.push({
      platform: row.platform,
      problemKey: row.problemKey,
      source: 'tag',
      points: fresh.map((code) => ({ code, confidence: 1, method: 'tag' })),
    });
  }

  const nested = inTransaction(db);
  if (nested) db.exec('SAVEPOINT tag_annotate');
  else db.exec('BEGIN');
  try {
    const result = writeAnnotationsToDb(db, writes);
    const dataDir = effectiveDataDir(opts.dataDir);
    // 源真相：JSONL 追加必须先于 COMMIT
    if (dataDir) appendAnnotations(dataDir, result.lines);
    if (nested) db.exec('RELEASE tag_annotate');
    else db.exec('COMMIT');
    return { scanned, annotated: result.written, unmappedTags: [...unmapped], lines: result.lines };
  } catch (e) {
    if (nested) {
      db.exec('ROLLBACK TO tag_annotate');
      db.exec('RELEASE tag_annotate');
    } else {
      db.exec('ROLLBACK');
    }
    throw e;
  }
}
