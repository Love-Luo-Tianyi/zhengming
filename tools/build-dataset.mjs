#!/usr/bin/env node
/**
 * 构建期管线：把 tools/raw/ 下采集的真实知乎回答，加工成 web/data/topics/ 下的快照。
 *
 * 为什么要构建期算一遍立场聚类？
 *   1. Demo 必须在评委打开的那一秒就能用，不能等模型；
 *   2. 开放平台接口有日调用上限，构建期固化可以省额度；
 *   3. 立场聚类的结果是"可复现"的——同一个话题每次打开看到同样的阵营，便于路演讲解。
 *
 * 用法：
 *   node tools/build-dataset.mjs                 # 有模型时用模型聚类
 *   node tools/build-dataset.mjs --engine local  # 强制用本地规则引擎
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const RAW = path.join(ROOT, 'tools', 'raw');
const OUT = path.join(ROOT, 'web', 'data', 'topics');

const LLM_BASE = process.env.ZM_LLM_BASE || 'https://api.a6api.com/v1';
const LLM_KEY = process.env.ZM_LLM_KEY || '';
const LLM_MODEL = process.env.ZM_LLM_MODEL || 'glm-5.3';

const FORCE_LOCAL = process.argv.includes('--engine') && process.argv.includes('local');

/* ------------------------------------------------------------------ 话题表 */

const TOPICS = [
  {
    id: 'ai-programmer',
    title: 'AI 会取代程序员吗',
    query: 'AI 会取代程序员吗',
    category: '职业与未来',
    keywords: ['AI', '程序员', '失业', '就业', '替代', 'ChatGPT', '编程'],
    sources: ['ai.json'],
  },
  {
    id: 'kaoyan',
    title: '考研到底值不值',
    query: '现在这个社会真的有必要考研吗',
    category: '升学与选择',
    keywords: ['考研', '读研', '学历', '就业', '二战', '研究生'],
    sources: ['kaoyan.json'],
  },
  {
    id: 'tangping',
    title: '年轻人该不该躺平',
    query: '如何看待年轻人躺平这一现象',
    category: '社会现象',
    keywords: ['躺平', '内卷', '努力', '奋斗', '年轻人', '佛系'],
    sources: ['tangping.json'],
  },
  {
    id: 'tiankeng',
    title: '生化环材真的是「天坑」吗',
    query: '如何看待国内把生化环材专业称为四大天坑',
    category: '专业选择',
    keywords: ['生化环材', '天坑', '四大天坑', '专业', '劝退', '化学', '材料', '生物'],
    sources: ['batch3.json'],
    filter: (a) => /天坑|生化环材/.test(a.qTitle),
  },
  {
    id: 'dagong',
    title: '进大厂还是考公',
    query: '考公进体制和进互联网大厂应该选哪个',
    category: '职业与未来',
    keywords: ['考公', '大厂', '公务员', '体制', '编制', '互联网'],
    sources: ['batch3.json'],
    filter: (a) => /考公|大厂|公务员/.test(a.qTitle),
  },
  {
    id: 'tianfu',
    title: '天赋和努力哪个更重要',
    query: '天赋和努力哪个更重要',
    category: '成长与自我',
    keywords: ['天赋', '努力', '成长', '上限', '普通人', '智商'],
    sources: ['tianfu.json'],
  },
];

/* ---------------------------------------------------------------- 权重与工具 */

/** 与前端 pipeline.js 保持同一套权重公式，保证构建期与运行期结果一致 */
function answerWeight(a) {
  const auth = Math.max(1, Math.min(4, authFromAnswer(a)));
  return Math.pow(auth, 1.5) * Math.log10(Math.max(0, a.voteUp || 0) + 10 + 1);
}

/** 开放平台返回的是 1–4 的权威等级；这里用可核验的站内信号做等价映射 */
function authFromAnswer(a) {
  const badges = ['优秀回答者', '新知答主', '答主', '话题优秀回答者'];
  const text = `${a.badge || ''}`;
  if (badges.some((b) => text.includes(b))) return 4;
  if (text.length > 0) return 3;          // 有认证标（学位/公司/职称等）
  if ((a.voteUp || 0) >= 1000) return 3;  // 高赞本身就是社区认可的强信号
  if ((a.voteUp || 0) >= 100) return 2;
  return 1;
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

/* ------------------------------------------------------------------ 模型调用 */

async function callLLM(messages, { maxTokens = 4096, temperature = 0.35 } = {}) {
  if (!LLM_KEY) throw new Error('未提供 ZM_LLM_KEY');
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
    body: JSON.stringify({ model: LLM_MODEL, messages, temperature, max_tokens: maxTokens }),
  });
  const raw = await res.text();
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error(`模型返回非 JSON：${raw.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`模型报错：${j?.error?.message || res.status}`);
  const text = j?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('模型返回空内容');
  return text;
}

function parseJsonLoose(text) {
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch { /* 继续 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    const sliced = s.slice(a, b + 1);
    try { return JSON.parse(sliced); } catch { /* 继续 */ }
    try { return JSON.parse(sliced.replace(/,\s*([\]}])/g, '$1')); } catch { /* 放弃 */ }
  }
  throw new Error('无法解析模型 JSON');
}

function clusterPrompt(title, answers) {
  const list = answers.map((a) => `[${a.id}] 作者：${a.author}（权威 ${authFromAnswer(a)}，赞同 ${a.voteUp}，评论 ${a.commentCount}）
标题：${a.title}
正文：${String(a.excerpt || '').slice(0, 760)}`).join('\n\n');

  return [
    {
      role: 'system',
      content: `你是「争鸣」的立场分析引擎。职责不是总结共识，而是把一条知乎问题下的分歧还原成互斥的立场阵营。

硬性要求：
1. 归纳 2–4 个互斥阵营。禁止"中间派""理性看待"这类和稀泥说法；第三条路必须有明确、可被反对的主张。
2. **必须把每一条回答都归入某一个阵营**，在 members 里列出该阵营包含的全部回答序号，不许遗漏任何回答序号。
3. 阵营名 4–8 字，要有立场辨识度（如"效率优先派"），不要写"观点一"。
4. thesis 是该阵营的核心主张，40 字内，必须是这个阵营真正在主张的东西（不是话题复述）。
5. arguments 给 2–4 条，每条 ≤ 50 字，且**必须忠实于 members 中某条回答的原文意思**，并在 evidenceIds 里给出它来自哪几个回答序号。不确定来源的论证宁可不写。
6. keywords 给 3–5 个 2–4 字的词，标记该阵营立场。
7. keyline 一句话点出**真正的分歧点**（双方对什么判断不同，而非话题本身），不超过 60 字。
8. controversy 为分歧烈度 0–1：阵营分布越均匀、对立双方权威度越接近，值越高。

只输出 JSON：
{"keyline":"...","controversy":0.72,"stances":[{"name":"...","thesis":"...","members":[1,3,7],"arguments":[{"text":"...","evidenceIds":[1,3]}],"keywords":["..."]}]}`,
    },
    { role: 'user', content: `话题：${title}\n\n以下是 ${answers.length} 条回答：\n\n${list}` },
  ];
}

/**
 * 把模型输出变成可核验的结构：
 *   - members 必须覆盖全部回答序号，缺的按关键词相似度补，多的剔除
 *   - support 由真实权重算出，不采信模型自报的数字
 *   - 论据的 evidenceIds 必须落在本阵营内，否则丢弃该条论据
 */
function reconcile(parsed, answers) {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const allIds = answers.map((a) => a.id);
  let stances = (parsed.stances || []).filter((s) => s?.name && s?.thesis).slice(0, 4);
  if (stances.length < 2) return null;

  const assigned = new Map(); // answerId -> stanceIndex
  stances.forEach((s, i) => {
    for (const id of (s.members || [])) {
      const n = Number(id);
      if (byId.has(n) && !assigned.has(n)) assigned.set(n, i);
    }
  });

  // 模型漏掉的回答：归到与其最相似的那个阵营
  const missing = allIds.filter((id) => !assigned.has(id));
  for (const id of missing) {
    const a = byId.get(id);
    const grams = new Set(bigrams(`${a.title} ${a.excerpt}`));
    let bestIdx = 0;
    let bestHit = -1;
    stances.forEach((s, i) => {
      const pool = stances[i].__grams || (stances[i].__grams = new Set(
        (s.members || []).filter((m) => byId.has(Number(m)))
          .flatMap((m) => [...new Set(bigrams(`${byId.get(Number(m)).title} ${byId.get(Number(m)).excerpt}`))]),
      ));
      const hit = [...grams].filter((g) => pool.has(g)).length;
      if (hit > bestHit) { bestHit = hit; bestIdx = i; }
    });
    assigned.set(id, bestIdx);
  }

  const total = answers.reduce((s, a) => s + answerWeight(a), 0) || 1;

  stances = stances.map((s, i) => {
    const members = allIds.filter((id) => assigned.get(id) === i);
    const weight = members.reduce((sum, id) => sum + answerWeight(byId.get(id)), 0);
    const ordered = members.slice().sort((x, y) => answerWeight(byId.get(y)) - answerWeight(byId.get(x)));
    const memberSet = new Set(members);

    const args = (s.arguments || [])
      .map((a) => ({
        text: String(a?.text || '').slice(0, 70),
        evidenceIds: (a?.evidenceIds || []).map(Number).filter((id) => memberSet.has(id)),
      }))
      .filter((a) => a.text && a.evidenceIds.length)
      .slice(0, 4);

    return {
      name: String(s.name).slice(0, 12),
      thesis: String(s.thesis).slice(0, 60),
      keywords: (s.keywords || []).map((k) => String(k).slice(0, 6)).slice(0, 5),
      arguments: args,
      support: +(weight / total).toFixed(3),
      representatives: ordered.slice(0, 3),
      evidenceIds: ordered,
      __grams: undefined,
    };
  }).filter((s) => s.evidenceIds.length);

  if (stances.length < 2) return null;

  // 归一化 support（剔除空阵营后可能有微小误差）
  const sum = stances.reduce((acc, s) => acc + s.support, 0) || 1;
  stances.forEach((s) => { s.support = +(s.support / sum).toFixed(3); });

  return { keyline: parsed.keyline, controversy: clamp01(parsed.controversy), stances };
}

/* ---------------------------------------------------------- 本地规则聚类（降级） */

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '就', '都', '也', '很', '不', '会', '要', '说', '到', '对', '而', '但', '被', '把', '个', '上', '下', '一个', '我们', '他们', '自己', '什么', '这个', '那个', '可以', '因为', '所以', '但是', '如果', '其实', '已经', '还是', '不是', '没有', '这种', '这些', '问题', '时候', '一定', '可能', '需要']);

function bigrams(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const out = [];
  for (const chunk of clean.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[a-zA-Z0-9]+$/.test(chunk)) { if (chunk.length > 1) out.push(chunk.toLowerCase()); continue; }
    for (let i = 0; i < chunk.length - 1; i++) {
      const g = chunk.slice(i, i + 2);
      if (!STOP.has(g)) out.push(g);
    }
  }
  return out;
}

function sentences(t) {
  return String(t || '').split(/[。！？!?；;\n]+/).map((s) => s.trim()).filter((s) => s.length >= 8);
}

function countMarkers(text, list) {
  let n = 0;
  for (const m of list) if (text.includes(m)) n += 1;
  return n;
}

function localCluster(title, answers) {
  const POS = ['值得', '应该', '支持', '机会', '优势', '必要', '看好', '有用', '红利', '提升', '效率', '重要'];
  const NEG = ['不值得', '不应该', '反对', '风险', '劣势', '没必要', '担忧', '泡沫', '焦虑', '内卷', '取代', '失业', '成本', '劝退'];
  const COND = ['取决于', '看情况', '因人而异', '前提', '如果', '条件', '分情况'];

  const buckets = { pro: [], con: [], mid: [] };
  for (const a of answers) {
    const text = `${a.title} ${a.excerpt}`;
    const cond = countMarkers(text, COND);
    let pol = countMarkers(text, POS) - countMarkers(text, NEG);
    if (cond >= 2) pol *= 0.35;
    if (pol > 0.4) buckets.pro.push(a);
    else if (pol < -0.4) buckets.con.push(a);
    else buckets.mid.push(a);
  }

  const names = { pro: '看好派', con: '审慎派', mid: '条件派' };
  const all = answers;
  const total = all.reduce((s, a) => s + answerWeight(a), 0) || 1;

  const inSet = (list) => new Set(list.map((a) => a.id));
  const kw = (list) => {
    const mine = inSet(list);
    const inside = new Map();
    const outside = new Map();
    for (const a of all) {
      const target = mine.has(a.id) ? inside : outside;
      for (const g of new Set(bigrams(`${a.title} ${a.excerpt}`))) target.set(g, (target.get(g) || 0) + 1);
    }
    return [...inside.entries()]
      .map(([g, c]) => [g, c * (c / (outside.get(g) || 0.5))])
      .sort((x, y) => y[1] - x[1]).slice(0, 5).map(([g]) => g);
  };

  const stances = [];
  for (const [k, list] of Object.entries(buckets)) {
    if (list.length < 1) continue;
    const w = list.reduce((s, a) => s + answerWeight(a), 0);
    const sorted = list.slice().sort((x, y) => answerWeight(y) - answerWeight(x));
    stances.push({
      name: names[k],
      thesis: (sentences(sorted[0].excerpt)[0] || sorted[0].title).slice(0, 44),
      arguments: sorted.flatMap((a) => sentences(a.excerpt).slice(0, 2)).slice(0, 3)
        .map((t) => ({ text: t.slice(0, 60), evidenceIds: [sorted[0].id] })),
      keywords: kw(list),
      support: +(w / total).toFixed(3),
      representatives: sorted.slice(0, 3).map((a) => a.id),
      evidenceIds: list.map((a) => a.id),
    });
  }

  const ps = stances.map((s) => s.support);
  const entropy = ps.length > 1 ? -ps.reduce((s, p) => s + p * Math.log(p), 0) / Math.log(ps.length) : 0.3;
  const balance = 1 - Math.abs((ps[0] || 0.5) - 0.5);

  return {
    keyline: `这场争论的分歧不在「${title}」本身，而在双方对什么代价可以接受、什么证据算数的判断不同。`,
    controversy: +clamp01(entropy * 0.7 + balance * 0.3).toFixed(2),
    stances: stances.sort((a, b) => b.support - a.support),
  };
}

/* -------------------------------------------------------------------- 主流程 */

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const index = { builtAt: new Date().toISOString().slice(0, 10), topics: [] };

  for (const topic of TOPICS) {
    console.log(`\n=== ${topic.id} · ${topic.title} ===`);

    let raw = [];
    for (const file of topic.sources) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(RAW, file), 'utf8'));
        raw.push(...data);
      } catch (err) {
        console.warn(`  跳过 ${file}：${err.message}`);
      }
    }
    if (topic.filter) raw = raw.filter(topic.filter);
    if (!raw.length) { console.warn('  没有可用回答，跳过'); continue; }

    // 去重 + 过滤：太短的回答撑不起立场
    const seen = new Set();
    const answers = [];
    for (const a of raw) {
      const key = (a.url || a.text.slice(0, 40));
      if (seen.has(key)) continue;
      if (String(a.text || '').length < 120) continue;
      seen.add(key);
      answers.push({ ...a, id: answers.length + 1 });
    }
    // 按加权排序，保留最能代表各立场的
    answers.sort((x, y) => answerWeight(y) - answerWeight(x));
    answers.length = Math.min(answers.length, 10);
    answers.forEach((a, i) => { a.id = i + 1; });

    console.log(`  ${answers.length} 条回答（去重后）`);

    const normalized = answers.map((a) => ({
      id: a.id,
      title: (a.qTitle || '').slice(0, 80),
      author: a.author,
      // 匿名用户在知乎没有主页，采集到的是裸 /people/ 空页，统一清空，避免出现点不开的死链
      authorUrl: /^https?:\/\/(www\.)?zhihu\.com\/people\/?$/.test(a.authorUrl || '') ? '' : (a.authorUrl || ''),
      authorBadgeText: a.badge || '',
      authorityLevel: authFromAnswer(a),
      voteUp: a.voteUp,
      commentCount: a.commentCount,
      createdAt: a.createdAt,
      url: a.url,
      excerpt: String(a.text).slice(0, 2000),
      comments: [],
    }));

    let analysis;
    let engine = 'local';
    if (!FORCE_LOCAL && LLM_KEY) {
      // 模型偶尔会输出超长或截断，重试三次再降级，尽量让每个话题都拿到模型结果
      for (let attempt = 1; attempt <= 3 && !analysis; attempt++) {
        try {
          const text = await callLLM(clusterPrompt(topic.title, normalized));
          const parsed = parseJsonLoose(text);
          const reconciled = reconcile(parsed, normalized);
          if (reconciled) {
            analysis = reconciled;
            engine = `llm:${LLM_MODEL}`;
          } else {
            console.warn(`  第 ${attempt} 次结果无法归一（阵营不足或归属为空）`);
          }
        } catch (err) {
          console.warn(`  模型聚类第 ${attempt} 次失败：${err.message}`);
        }
      }
      if (!analysis) console.warn('  改用本地规则引擎');
    } else if (!FORCE_LOCAL) {
      console.warn('  未提供 ZM_LLM_KEY，使用本地规则引擎');
    }
    if (!analysis) analysis = localCluster(topic.title, normalized);

    // localCluster 也需要归一化一下 support（模型路径已在内部分配好）
    if (engine === 'local') {
      const sum = analysis.stances.reduce((s, x) => s + (Number(x.support) || 0), 0);
      if (sum > 0) {
        for (const s of analysis.stances) s.support = +((Number(s.support) || 0) / sum).toFixed(3);
      } else {
        const even = +(1 / analysis.stances.length).toFixed(3);
        for (const s of analysis.stances) s.support = even;
      }
      for (const s of analysis.stances) {
        if (!s.representatives?.length) s.representatives = (s.evidenceIds || []).slice(0, 3);
        s.evidenceIds = s.evidenceIds || s.representatives || [];
      }
    }

    const snapshot = {
      id: topic.id,
      title: topic.title,
      query: topic.query,
      category: topic.category,
      keywords: topic.keywords,
      capturedAt: new Date().toISOString().slice(0, 10),
      engine,
      provenance: {
        note: '本快照的回答标题、正文摘要、作者、赞同数、评论数与原文链接，均采集自知乎公开问答页面；立场聚类为构建期计算结果。',
        sourcePages: [...new Set(answers.map((a) => a.qTitle))],
      },
      answers: normalized,
      analysis: {
        query: topic.title,
        keyline: analysis.keyline,
        controversy: analysis.controversy,
        stances: analysis.stances,
      },
    };

    await fs.writeFile(path.join(OUT, `${topic.id}.json`), JSON.stringify(snapshot, null, 1), 'utf8');
    console.log(`  ✓ ${analysis.stances.length} 个阵营 · ${engine} · 分歧烈度 ${analysis.controversy}`);

    index.topics.push({
      id: topic.id,
      title: topic.title,
      query: topic.query,
      category: topic.category,
      keywords: topic.keywords,
      controversy: analysis.controversy,
      answerCount: normalized.length,
      stanceNames: analysis.stances.map((s) => s.name),
      capturedAt: snapshot.capturedAt,
    });
  }

  await fs.writeFile(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1), 'utf8');
  console.log(`\n完成：${index.topics.length} 个话题 → ${OUT}`);
}

main().catch((err) => { console.error('构建失败：', err); process.exit(1); });
