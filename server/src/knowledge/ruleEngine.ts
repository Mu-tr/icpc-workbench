/**
 * L1 规则分类器：只用题目标题做确定性匹配，不读取题源 tags。
 * - 规则表 rules.json 按优先级排列，支持多命中（一题多知识点）
 * - negative 命中则跳过该规则（消除「差分约束 → 前缀和」类误配）
 * - 同 code 多规则命中保留最高置信度；method 记录 rule#rNNN 可溯源
 * - 规则表是代码不是数据：改动即 bump rules.json version 与 PIPELINE_VERSION
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidCode } from './taxonomy.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.join(__dirname, 'rules.json');

export interface RuleDef {
  id: string;
  pattern: string;
  negative?: string;
  code: string;
  confidence: number;
}

interface CompiledRule extends RuleDef {
  re: RegExp;
  negativeRe?: RegExp;
}

export interface RuleMatch {
  code: string;
  confidence: number;
  /** 溯源：rule#rNNN */
  method: string;
  /** 命中的规则 id 列表（审计用） */
  ruleIds: string[];
}

let cache: CompiledRule[] | null = null;
let jsonOverride: string | null = null;

/** SEA 单文件分发时由入口注入 JSON 文本（不再读磁盘）；传 null 恢复磁盘读取 */
export function setRulesJson(json: string | null): void {
  jsonOverride = json;
  cache = null;
  versionCache = null;
}

function readRulesFile(): { version: number; rules: RuleDef[] } {
  return JSON.parse(jsonOverride ?? fs.readFileSync(RULES_PATH, 'utf8')) as { version: number; rules: RuleDef[] };
}

export function loadRules(): CompiledRule[] {
  if (cache) return cache;
  const file = readRulesFile();
  const compiled: CompiledRule[] = [];
  for (const r of file.rules) {
    if (!isValidCode(r.code)) {
      throw new Error(`rules.json ${r.id}: code ${r.code} 不存在于 taxonomy.json`);
    }
    compiled.push({
      ...r,
      re: new RegExp(r.pattern, 'i'),
      ...(r.negative ? { negativeRe: new RegExp(r.negative, 'i') } : {}),
    });
  }
  cache = compiled;
  return compiled;
}

let versionCache: number | null = null;

/** 规则表版本（rules.json version 字段），用于管线版本联动与审计。缓存避免每轮重跑反复读盘 */
export function rulesVersion(): number {
  if (versionCache === null) versionCache = readRulesFile().version;
  return versionCache;
}

/** 测试专用：注入自定义规则并重置缓存 */
export function setRulesForTest(rules: RuleDef[] | null): void {
  cache = rules === null
    ? null
    : rules.map((r) => ({
        ...r,
        re: new RegExp(r.pattern, 'i'),
        ...(r.negative ? { negativeRe: new RegExp(r.negative, 'i') } : {}),
      }));
}

/**
 * 标题分类：返回命中的知识点（多命中保留，按置信度降序）。
 * 同 code 多次命中合并：置信度取最高，ruleIds 全记录。
 */
export function classifyTitle(title: string, rules: CompiledRule[] = loadRules()): RuleMatch[] {
  const byCode = new Map<string, RuleMatch>();
  for (const rule of rules) {
    if (!rule.re.test(title)) continue;
    if (rule.negativeRe?.test(title)) continue;
    const existing = byCode.get(rule.code);
    if (existing) {
      existing.ruleIds.push(rule.id);
      if (rule.confidence > existing.confidence) {
        existing.confidence = rule.confidence;
        existing.method = `rule#${rule.id}`;
      }
    } else {
      byCode.set(rule.code, {
        code: rule.code,
        confidence: rule.confidence,
        method: `rule#${rule.id}`,
        ruleIds: [rule.id],
      });
    }
  }
  return [...byCode.values()].sort((a, b) => b.confidence - a.confidence);
}
