#!/usr/bin/env node
/**
 * 数据体检：确认每一份快照都满足「可溯源、可运行」的硬约束。
 * 评委打开 Demo 之前，这些约束必须全部为真。
 *
 * 用法：node tools/validate-dataset.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'web', 'data', 'topics');

const problems = [];
const warns = [];
let topicCount = 0;
let answerCount = 0;
const authorSet = new Set();

function check(cond, msg) {
  if (!cond) problems.push(msg);
  return cond;
}

const indexRaw = await fs.readFile(path.join(DIR, 'index.json'), 'utf8').catch(() => null);
if (!indexRaw) {
  console.error('缺少 index.json，请先运行 node tools/build-dataset.mjs');
  process.exit(1);
}
const index = JSON.parse(indexRaw);

check(Array.isArray(index.topics) && index.topics.length > 0, 'index.json 里没有话题');
check(!!index.builtAt, 'index.json 缺少 builtAt');

for (const meta of index.topics) {
  const file = path.join(DIR, `${meta.id}.json`);
  const raw = await fs.readFile(file, 'utf8').catch(() => null);
  if (!raw) { problems.push(`${meta.id}: 索引里有但文件不存在`); continue; }

  const t = JSON.parse(raw);
  topicCount += 1;
  const tag = t.title || meta.id;

  check(t.id === meta.id, `${tag}: id 与索引不一致`);
  check(!!t.provenance?.note, `${tag}: 缺少溯源说明`);
  check(Array.isArray(t.answers) && t.answers.length >= 3, `${tag}: 回答少于 3 条`);

  const ids = new Set();
  for (const a of t.answers || []) {
    answerCount += 1;
    authorSet.add(a.author);
    check(Number.isInteger(a.id), `${tag}: 回答 id 不是整数`);
    check(!ids.has(a.id), `${tag}: 回答 id 重复 ${a.id}`);
    ids.add(a.id);
    check(!!a.author, `${tag}#${a.id}: 缺少作者`);
    check(!!a.excerpt && a.excerpt.length >= 80, `${tag}#${a.id}: 摘要过短，撑不起立场`);
    check(!!a.url && /^https:\/\/(www\.)?zhihu\.com\//.test(a.url), `${tag}#${a.id}: 原文链接不是知乎链接（${a.url}）`);
    // 匿名用户在知乎没有可访问的主页；但只要有作者主页链接，就不能是空页
    check(!/^https:\/\/(www\.)?zhihu\.com\/people\/?$/.test(a.authorUrl || ''), `${tag}#${a.id}: 作者主页链接为空页`);
    const anonymous = /匿名|知乎用户/.test(a.author);
    check(!!a.authorUrl || anonymous, `${tag}#${a.id}: 非匿名回答缺少作者主页链接`);
    check(a.authorityLevel >= 1 && a.authorityLevel <= 4, `${tag}#${a.id}: 权威等级越界 ${a.authorityLevel}`);
    check(typeof a.voteUp === 'number', `${tag}#${a.id}: 缺少赞同数`);
  }

  const an = t.analysis;
  check(!!an, `${tag}: 缺少 analysis`);
  if (!an) continue;

  check(!!an.keyline && an.keyline.length >= 10, `${tag}: 分歧点描述缺失`);
  check(an.controversy >= 0 && an.controversy <= 1, `${tag}: 分歧烈度越界 ${an.controversy}`);
  check(Array.isArray(an.stances) && an.stances.length >= 2, `${tag}: 阵营少于 2 个`);

  // 硬约束：每一条回答都必须被某个阵营认领，否则就是"分析漏了人"
  const covered = new Set();
  for (const s of an.stances || []) {
    check(!!s.name && s.name.length <= 12, `${tag}: 阵营名异常「${s.name}」`);
    check(!!s.thesis && s.thesis.length >= 8, `${tag}/${s.name}: 缺少核心主张`);
    check(Array.isArray(s.keywords) && s.keywords.length >= 2, `${tag}/${s.name}: 缺少关键词`);
    check(Array.isArray(s.arguments) && s.arguments.length >= 1, `${tag}/${s.name}: 没有论证`);
    check(Array.isArray(s.evidenceIds) && s.evidenceIds.length >= 1, `${tag}/${s.name}: 没有归属回答`);

    for (const id of s.evidenceIds || []) {
      check(ids.has(id), `${tag}/${s.name}: evidenceId ${id} 不存在`);
      covered.add(id);
    }
    for (const arg of s.arguments || []) {
      check(!!arg.text && arg.text.length >= 8, `${tag}/${s.name}: 论证文本过短`);
      check(Array.isArray(arg.evidenceIds) && arg.evidenceIds.length >= 1,
        `${tag}/${s.name}: 论证「${String(arg.text).slice(0, 20)}」没有来源，等于不可溯源`);
      for (const id of arg.evidenceIds || []) {
        check(ids.has(id), `${tag}/${s.name}: 论证指向不存在的回答 ${id}`);
        check((s.evidenceIds || []).includes(id),
          `${tag}/${s.name}: 论证引用了不属于本阵营的回答 ${id}`);
      }
    }
  }

  const missing = [...ids].filter((id) => !covered.has(id));
  check(missing.length === 0, `${tag}: 有 ${missing.length} 条回答没有被任何阵营认领（${missing.join(',')}）`);

  const supportSum = an.stances.reduce((s, x) => s + (Number(x.support) || 0), 0);
  if (Math.abs(supportSum - 1) > 0.02) warns.push(`${tag}: support 合计 ${supportSum.toFixed(3)}，偏离 1`);

  check(meta.stanceNames?.length === an.stances.length, `${tag}: 索引里的阵营名与快照不一致`);
  check(meta.answerCount === (t.answers || []).length, `${tag}: 索引回答数与快照不一致`);
}

console.log(`话题 ${topicCount} 个 · 回答 ${answerCount} 条 · 作者 ${authorSet.size} 位`);

if (warns.length) {
  console.log(`\n提醒 ${warns.length} 条：`);
  for (const w of warns) console.log(`  · ${w}`);
}

if (problems.length) {
  console.error(`\n✗ 发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

console.log('\n✓ 全部快照通过体检：回答归属完整、论证均可溯源、链接均为知乎原文。');
