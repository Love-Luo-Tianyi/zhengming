#!/usr/bin/env node
/**
 * 用知乎开放平台官方接口采集话题答料，写入 tools/raw/。
 *
 * 这是「正规路径」：拿到 Access Secret 后跑一次，就能把样本库换成实时检索的结果。
 * tools/build-dataset.mjs 读取的 raw 文件格式与本脚本输出一致，
 * 因此 采集 → 聚类 → 体检 三步可以完全脱离浏览器完成。
 *
 * 用法：
 *   ZHIHU_ACCESS_SECRET=xxx node tools/fetch-answers.mjs
 *   ZHIHU_ACCESS_SECRET=xxx node tools/fetch-answers.mjs --topic ai-programmer
 *
 * 额度提醒：知乎搜索 1000 次/天、热榜 100 次/天。本脚本对每个关键词只请求一次，
 * 结果落在 tools/raw/api/<id>.json，重复运行不会重复消耗额度（除非加 --force）。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'tools', 'raw');
const OUT = path.join(RAW, 'api');

const SECRET = process.env.ZHIHU_ACCESS_SECRET || '';
const API = 'https://developer.zhihu.com';

/** 与前端 web/data/topics/index.json 对应的话题定义 */
const TOPICS = [
  { id: 'ai-programmer', title: 'AI 会取代程序员吗', queries: ['AI 会取代程序员吗', '程序员会被AI淘汰吗'] },
  { id: 'kaoyan', title: '考研到底值不值', queries: ['考研值得吗', '读研三年值不值'] },
  { id: 'tangping', title: '年轻人该不该躺平', queries: ['如何看待年轻人躺平', '躺平是不是消极'] },
  { id: 'tiankeng', title: '生化环材真的是「天坑」吗', queries: ['生化环材 四大天坑', '生化环材专业前景'] },
  { id: 'dagong', title: '进大厂还是考公', queries: ['考公还是进大厂', '大厂和公务员怎么选'] },
  { id: 'tianfu', title: '天赋和努力哪个更重要', queries: ['天赋和努力哪个更重要', '努力能弥补天赋吗'] },
];

const only = (() => {
  const i = process.argv.indexOf('--topic');
  return i !== -1 ? process.argv[i + 1] : null;
})();
const FORCE = process.argv.includes('--force');

function stamp() {
  return String(Math.floor(Date.now() / 1000));
}

async function zhihuSearch(query, count = 10) {
  const url = `${API}/api/v1/content/zhihu_search?Query=${encodeURIComponent(query)}&Count=${Math.min(count, 10)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'X-Request-Timestamp': stamp(),
      'Content-Type': 'application/json',
    },
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new Error(`HTTP ${res.status}：返回非 JSON`);
  if (json.Code !== 0) {
    const hint = {
      20001: '鉴权失败：检查 ZHIHU_ACCESS_SECRET',
      30001: '触发频率限制：该接口有日调用上限',
      30002: '配额已用尽',
    }[json.Code];
    throw new Error(hint || `${json.Code} ${json.Message}`);
  }
  return json.Data?.Items || [];
}

/** 把开放平台返回的字段映射成 build-dataset.mjs 期望的形状 */
function normalize(item, query) {
  return {
    author: item.AuthorName || '知乎用户',
    badge: item.AuthorBadgeText || '',
    followerCount: 0,
    voteUp: Number(item.VoteUpCount || 0),
    commentCount: Number(item.CommentCount || 0),
    createdAt: null,
    authorUrl: '',
    url: String(item.Url || '').split('?')[0],
    qTitle: query,
    authority: Number(item.AuthorityLevel || 1),
    rankingScore: Number(item.RankingScore || 0),
    text: String(item.ContentText || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
    comments: (item.CommentInfoList || []).map((c) => c.Content).filter(Boolean),
  };
}

async function main() {
  if (!SECRET) {
    console.error('缺少 ZHIHU_ACCESS_SECRET。请从 https://developer.zhihu.com/profile 获取后重试。');
    process.exit(1);
  }
  await fs.mkdir(OUT, { recursive: true });

  let used = 0;
  for (const topic of TOPICS) {
    if (only && topic.id !== only) continue;
    const file = path.join(OUT, `${topic.id}.json`);

    if (!FORCE) {
      const exists = await fs.access(file).then(() => true, () => false);
      if (exists) {
        console.log(`${topic.id}: 已存在，跳过（--force 可覆盖）`);
        continue;
      }
    }

    const bag = [];
    for (const q of topic.queries) {
      try {
        const items = await zhihuSearch(q, 10);
        used += 1;
        bag.push(...items.map((it) => normalize(it, q)));
        console.log(`  「${q}」→ ${items.length} 条`);
      } catch (err) {
        console.warn(`  「${q}」失败：${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 400)); // 温和一点，避免触发风控
    }

    // 按内容去重
    const seen = new Set();
    const dedup = bag.filter((a) => {
      const k = a.url || a.text.slice(0, 40);
      if (!a.text || seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    await fs.writeFile(file, JSON.stringify(dedup, null, 1), 'utf8');
    console.log(`${topic.id}: 写入 ${dedup.length} 条 → ${path.relative(ROOT, file)}`);
  }

  console.log(`\n完成，本次消耗知乎搜索接口 ${used} 次。`);
  console.log('下一步：node tools/build-dataset.mjs（聚类） → node tools/validate-dataset.mjs（体检）');
}

main().catch((err) => { console.error('采集失败：', err.message); process.exit(1); });
