/**
 * 从 curriculum.ts 生成 knowledge/taxonomy.json（一次性内容生成脚本）。
 * taxonomy.json 是版本化的静态文件：生成后入库独立演化，改动需手动 bump version。
 * 运行：npx tsx scripts/gen-taxonomy.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRICULUM } from '../src/templates/curriculum.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '../src/knowledge/taxonomy.json');

/** 模板 id 前缀 → taxonomy 大类 key（仅 str 特殊，其余前缀与大类 key 一致） */
const PREFIX_TO_CATEGORY: Record<string, string> = { str: 'string' };

interface TaxonomyPoint {
  code: string;
  /** 展示名（短名：去掉模板名中的括号补充说明，与标签词表对齐） */
  name: string;
  /** 模板课程全名（掌握度地图/课程联动展示用） */
  fullName?: string;
  templateIds?: string[];
}

/** 模板名 → 短展示名：去掉「（…）」补充说明（如 线段树（区间加 + 区间求和，懒标记）→ 线段树） */
function shortName(full: string): string {
  return full.split('（')[0].trim();
}

interface TaxonomyCategory {
  key: string;
  name: string;
  points: TaxonomyPoint[];
}

const categories: TaxonomyCategory[] = CURRICULUM.map((cat) => ({
  key: cat.key,
  name: cat.name,
  points: cat.templates.map((t) => {
    const [prefix, ...rest] = t.id.split('-');
    const catKey = PREFIX_TO_CATEGORY[prefix] ?? prefix;
    if (catKey !== cat.key) {
      throw new Error(`模板 ${t.id} 前缀 ${prefix} 与大类 ${cat.key} 不一致`);
    }
    return { code: `${cat.key}.${rest.join('-')}`, name: shortName(t.name), fullName: t.name, templateIds: [t.id] };
  }),
}));

// 无对应课程的综合知识点（高信号标题词的兜底归类，避免硬贴到具体模板上）。
// code 只增不改语义；后续若补课程再挂 templateIds。
const EXTRAS: Record<string, TaxonomyPoint[]> = {
  search: [{ code: 'search.general', name: '搜索', fullName: '搜索（综合）' }],
  dp: [{ code: 'dp.general', name: '动态规划', fullName: '动态规划（综合）' }],
  graph: [{ code: 'graph.shortest-path', name: '最短路' }],
  math: [
    { code: 'math.number-theory', name: '数论' },
    { code: 'math.combinatorics', name: '组合计数' },
  ],
  string: [{ code: 'string.general', name: '字符串', fullName: '字符串（综合）' }],
  geo: [{ code: 'geo.general', name: '计算几何', fullName: '计算几何（综合）' }],
  misc: [{ code: 'misc.sorting', name: '排序' }],
};

for (const cat of categories) {
  for (const extra of EXTRAS[cat.key] ?? []) {
    cat.points.push(extra);
  }
}

const taxonomy = { version: 2, categories };
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(taxonomy, null, 2)}\n`);

const total = categories.reduce((n, c) => n + c.points.length, 0);
console.log(`taxonomy.json written: ${categories.length} categories, ${total} codes -> ${OUT_PATH}`);
