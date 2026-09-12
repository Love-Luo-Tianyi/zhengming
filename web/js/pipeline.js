/**
 * 分析引擎。
 *
 * 三条能力，全部围绕一个判断：知乎最值钱的是「分歧」，不是「共识」。
 *   1. clusterStances —— 把同一话题下的回答还原成互斥的立场阵营
 *   2. debateTurn    —— 基于不同观点论据回应，并对用户草稿做四维体检
 *   3. buildReport   —— 汇总成观点体检报告
 *
 * 每一层都有「模型版」和「本地规则版」两条实现，模型不可用时不会白屏。
 */

import { chat, llmAvailable } from './llm.js?v=20260912k';

export const STANCE_COLORS = [
  { c: '#2f8bff', dim: 'rgba(47,139,255,0.14)', bd: 'rgba(47,139,255,0.36)' },
  { c: '#ffa63d', dim: 'rgba(255,166,61,0.14)', bd: 'rgba(255,166,61,0.36)' },
  { c: '#37d2c4', dim: 'rgba(55,210,196,0.14)', bd: 'rgba(55,210,196,0.36)' },
  { c: '#e567c8', dim: 'rgba(229,103,200,0.14)', bd: 'rgba(229,103,200,0.36)' },
];

export const JUDGE_DIMS = [
  { key: 'grounding', label: '依据', hint: '有没有落到具体来源、事实、数字上' },
  { key: 'relevance', label: '切题', hint: '有没有正面回应对方的核心主张' },
  { key: 'logic', label: '逻辑', hint: '有没有偷换概念、绝对化、诉诸情绪' },
  { key: 'novelty', label: '增量', hint: '有没有带来新信息，而不是复述立场' },
];

/* --------------------------------------------------------------- 工具函数 */

/** 权威度 × 赞同数的加权。权威等级是 1–4，比点赞更能反映"这个判断值不值得听"。 */
export function answerWeight(a) {
  const auth = Math.max(1, Math.min(4, Number(a.authorityLevel) || 1));
  const votes = Math.max(0, Number(a.voteUp) || 0);
  return Math.pow(auth, 1.5) * Math.log10(votes + 10 + 1);
}

export function authorityLabel(level) {
  return { 4: '超高权威', 3: '高权威', 2: '中权威', 1: '普通' }[Number(level) || 1] || '普通';
}

export function formatVotes(n) {
  const v = Number(n) || 0;
  return v >= 10000 ? `${(v / 10000).toFixed(1)} 万` : String(v);
}

/** 中文没有空格分词，2-gram 在这类场景里够用且不需要引入词典依赖 */
const STOP_GRAMS = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那', '有', '和', '与', '就',
  '都', '也', '很', '不', '会', '要', '说', '到', '对', '而', '但', '被', '把', '个', '上', '下',
  '一个', '我们', '他们', '自己', '什么', '这个', '那个', '可以', '因为', '所以', '但是', '如果',
  '其实', '已经', '还是', '不是', '没有', '这种', '这些', '问题', '时候', '一定', '可能', '需要',
]);

export function bigrams(text) {
  const clean = String(text || '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const out = [];
  for (const chunk of clean.split(/\s+/)) {
    if (!chunk) continue;
    if (/^[a-zA-Z0-9]+$/.test(chunk)) { if (chunk.length > 1) out.push(chunk.toLowerCase()); continue; }
    for (let i = 0; i < chunk.length - 1; i++) {
      const g = chunk.slice(i, i + 2);
      if (!STOP_GRAMS.has(g)) out.push(g);
    }
  }
  return out;
}

const FALLACY_MARKERS = ['必然', '肯定', '绝对', '显然', '毫无疑问', '所有人', '从来', '根本不', '永远', '就是垃圾', '可笑', '幼稚', '蠢', '弱智'];
const HEDGE_MARKERS = ['可能', '或许', '取决于', '在很大程度上', '倾向于', '在某种条件下', '不一定', '未必'];
const CAUSAL_MARKERS = ['因为', '所以', '因此', '由此', '导致', '原因在于', '这意味着', '换句话说', '反过来说', '但是', '然而', '不过'];

function countMarkers(text, list) {
  let n = 0;
  for (const m of list) if (text.includes(m)) n += 1;
  return n;
}

function sentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

/* ------------------------------------------------------- 1. 立场聚类 */

/**
 * @param {object} ctx { query, answers }
 * @returns {Promise<Analysis>}
 */
export async function clusterStances({ query, answers, precomputed }) {
  // 样本库里的话题在构建期已经用模型算过一遍，直接用，省额度也更稳
  if (precomputed) return decorate(precomputed, answers);

  if (llmAvailable()) {
    try {
      const raw = await chat(clusterPrompt(query, answers), { json: true, temperature: 0.35, maxTokens: 2400 });
      return decorate(normalizeAnalysis(raw, answers), answers);
    } catch (err) {
      console.warn('[争鸣] 模型聚类失败，退回本地规则：', err.message);
    }
  }
  return decorate(localCluster(query, answers), answers, 'local');
}

function decorate(analysis, answers, engine = 'llm') {
  const stances = (analysis.stances || []).map((s, i) => ({
    ...s,
    id: s.id || `s${i + 1}`,
    keywords: s.keywords || [],
    arguments: (s.arguments || []).map((a) => (typeof a === 'string' ? { text: a, evidenceIds: [] } : a)),
    color: STANCE_COLORS[i % STANCE_COLORS.length].c,
    dim: STANCE_COLORS[i % STANCE_COLORS.length].dim,
    bd: STANCE_COLORS[i % STANCE_COLORS.length].bd,
  }));
  const byId = new Map(answers.map((a) => [a.id, a]));
  for (const s of stances) {
    s.representatives = (s.representatives || s.evidenceIds || [])
      .map((id) => byId.get(Number(id)))
      .filter(Boolean);
    if (!s.representatives.length) {
      s.representatives = answers
        .filter((a) => (s.evidenceIds || []).includes(a.id))
        .slice(0, 3);
    }
  }
  return {
    query: analysis.query || '',
    keyline: analysis.keyline || '',
    controversy: clamp01(analysis.controversy ?? 0.5),
    stances,
    engine,
    answers,
    origin: analysis.origin,
  };
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n > 1 ? n / 100 : n));
}

function normalizeAnalysis(raw, answers) {
  const stances = Array.isArray(raw.stances) ? raw.stances : [];
  const valid = stances.filter((s) => s && s.name && (s.thesis || s.arguments));
  if (valid.length < 2) throw new Error('模型给出的阵营不足两个');
  return { ...raw, stances: valid };
}

function clusterPrompt(query, answers) {
  const list = answers.map((a) => {
    const excerpt = String(a.excerpt || '').slice(0, 320);
    return `[${a.id}] 作者：${a.author}（权威等级 ${a.authorityLevel}，赞同 ${a.voteUp}，评论 ${a.commentCount}）
标题：${a.title}
摘要：${excerpt}
${a.comments?.length ? `精选评论：${a.comments.slice(0, 2).join(' / ').slice(0, 200)}` : ''}`;
  }).join('\n\n');

  return [
    {
      role: 'system',
      content: `你是「争鸣」的立场分析引擎。你的职责不是总结共识，而是把一条知乎问题下的分歧，还原成互斥的立场阵营。

硬性要求：
1. 归纳 2 到 4 个互斥阵营。禁止用"中间派""理性看待"这类和稀泥的阵营；如果确实存在第三条路，它必须有明确、可被反对的主张。
2. 每个阵营的 arguments 必须是该阵营回答里**真实存在**的论据，不得杜撰。每条论证给出 evidenceIds（对应回答序号）。
3. 阵营名要有辨识度，4–8 个字，用"XX派/XX论/XX优先"这类有立场的说法，不要写成"观点一"。
4. 每个阵营给 2–4 个 keywords，是这场争论里最能标记该阵营立场的词（2–4 字）。
5. support 为该阵营的加权占比（权重＝权威等级^1.5 × log10(赞同数+11)），所有 support 相加为 1。
6. controversy 是分歧烈度 0–1：阵营分布越均匀、且对立双方权威度越接近，值越高。
7. keyline 用一句话点出**这场争论真正的分歧点**（不是话题本身，而是双方对什么判断不同），不超过 60 字。

只输出 JSON，结构：
{"keyline":"...","controversy":0.72,"stances":[{"name":"...","thesis":"一句话核心主张，40字内","arguments":[{"text":"不超过50字","evidenceIds":[1,3]}],"keywords":["...","..."],"support":0.42,"representatives":[1,3]}]}`,
    },
    {
      role: 'user',
      content: `话题：${query}\n\n以下是该话题下的 ${answers.length} 条回答：\n\n${list}`,
    },
  ];
}

/** 没有模型时的降级方案：用立场词表给每条回答定极性，再按极性分桶 */
function localCluster(query, answers) {
  const POS = ['值得', '应该', '支持', '机会', '优势', '必要', '看好', '可以', '重要', '有用', '红利', '提升', '效率'];
  const NEG = ['不值得', '不应该', '反对', '风险', '劣势', '没必要', '担忧', '问题', '泡沫', '焦虑', '内卷', '取代', '失业', '成本'];
  const COND = ['取决于', '看情况', '因人而异', '前提', '如果', '条件', '分情况'];

  const scored = answers.map((a) => {
    const text = `${a.title} ${a.excerpt} ${(a.comments || []).join(' ')}`;
    const pos = countMarkers(text, POS);
    const neg = countMarkers(text, NEG);
    const cond = countMarkers(text, COND);
    let polarity = pos - neg;
    if (cond >= 2) polarity *= 0.35;
    return { a, polarity, cond };
  });

  const buckets = { pro: [], con: [], mid: [] };
  for (const s of scored) {
    if (s.polarity > 0.4) buckets.pro.push(s.a);
    else if (s.polarity < -0.4) buckets.con.push(s.a);
    else buckets.mid.push(s.a);
  }

  const names = { pro: ['看好派', '主张推进的一方'], con: ['审慎派', '主张克制的一方'], mid: ['条件派', '强调前提的一方'] };
  const total = answers.reduce((sum, a) => sum + answerWeight(a), 0) || 1;

  const stances = [];
  for (const [k, list] of Object.entries(buckets)) {
    if (!list.length) continue;
    const w = list.reduce((s, a) => s + answerWeight(a), 0);
    const sig = distinctiveKeywords(list, answers).slice(0, 4);
    const args = list
      .slice()
      .sort((x, y) => answerWeight(y) - answerWeight(x))
      .flatMap((a) => sentences(a.excerpt).slice(0, 2))
      .slice(0, 3)
      .map((t) => ({ text: t.slice(0, 60), evidenceIds: [] }));
    const top = list.slice().sort((x, y) => answerWeight(y) - answerWeight(x))[0];
    stances.push({
      name: names[k][0],
      thesis: (sentences(top.excerpt)[0] || top.title || '').slice(0, 44),
      arguments: args,
      keywords: sig,
      support: +(w / total).toFixed(3),
      representatives: [top.id],
      evidenceIds: list.map((a) => a.id),
    });
  }

  // 分歧烈度：分布熵 × 权威均衡度
  const ps = stances.map((s) => s.support).filter((p) => p > 0);
  const entropy = -ps.reduce((s, p) => s + p * Math.log(p), 0) / Math.log(Math.max(ps.length, 2));
  const balance = stances.length > 1 ? 1 - Math.abs((ps[0] || 0.5) - 0.5) : 0.2;

  return {
    keyline: `这场争论的分歧不在「${query}」本身，而在双方对什么代价可以接受、什么证据算数的判断不同。`,
    controversy: +(clamp01(entropy * 0.7 + balance * 0.3)).toFixed(2),
    stances: stances.sort((a, b) => b.support - a.support),
    engine: 'local',
  };
}

/** 对比式关键词：在桶内高频、在桶外低频的 2-gram */
function distinctiveKeywords(inList, allAnswers) {
  const inSet = new Set(inList.map((a) => a.id));
  const inCount = new Map();
  const outCount = new Map();
  const bump = (map, text) => {
    for (const g of new Set(bigrams(text))) map.set(g, (map.get(g) || 0) + 1);
  };
  for (const a of allAnswers) bump(inSet.has(a.id) ? inCount : outCount, `${a.title} ${a.excerpt}`);
  const scored = [...inCount.entries()]
    .map(([g, c]) => [g, c * (c / (outCount.get(g) || 0.5))])
    .filter(([g]) => g.length >= 2)
    .sort((a, b) => b[1] - a[1]);
  return scored.map(([g]) => g).slice(0, 8);
}

/* ------------------------------------------------------- 2. 回应草稿体检 */

/**
 * @param {object} ctx { query, stances, myStance, opponentStance, history, message }
 * @returns {Promise<{reply, probe, scores, comment, engine}>}
 */
export async function debateTurn({ query, myStance, opponentStance, history, message }) {
  if (llmAvailable()) {
    try {
      const raw = await chat(debatePrompt({ query, myStance, opponentStance, history, message }),
        { json: true, temperature: 0.7, maxTokens: 1800 });
      return { ...normalizeTurn(raw), engine: 'llm' };
  } catch (err) {
      console.warn('[争鸣] 模型体检失败，退回本地规则：', err.message);
    }
  }
  return { ...localTurn({ opponentStance, history, message }), engine: 'local' };
}

function normalizeTurn(raw) {
  const s = raw.scores || {};
  const scores = {};
  for (const d of JUDGE_DIMS) scores[d.key] = clamp05(s[d.key]);
  return {
    reply: String(raw.reply || '').trim() || '（暂时没有新的回应提示，请继续补充你的论据。）',
    probe: String(raw.probe || '').trim(),
    comment: String(raw.comment || '').trim(),
    scores,
  };
}

function clamp05(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 3;
  return Math.max(0, Math.min(5, Math.round(n)));
}

function debatePrompt({ query, myStance, opponentStance, history, message }) {
  const oppArgs = opponentStance.arguments.map((a, i) => `${i + 1}. ${a.text}`).join('\n');
  const myArgs = myStance.arguments.map((a, i) => `${i + 1}. ${a.text}`).join('\n');
  const ev = opponentStance.representatives.slice(0, 3).map((r) =>
    `-《${r.title}》／${r.author}（权威等级 ${r.authorityLevel}，赞同 ${r.voteUp}）：${String(r.excerpt).slice(0, 180)}`).join('\n');
  const hist = history.slice(-6).map((h) => `${h.role === 'me' ? '用户' : '你'}：${h.content}`).join('\n') || '（刚开始）';

  return [
    {
      role: 'system',
      content: `你是「争鸣」的回应体检引擎。用户选定一个观点坐标，你基于已展示的对立阵营知乎快照论据，帮助检查回应草稿；不要模拟或冒充真实答主。

回应对象：
- 观点名称「${opponentStance.name}」：${opponentStance.thesis}
- 可引用材料只有下面这些真实论据，不要编造事实、数据或引用：
${oppArgs}

回应检查规则：
- reply：以回应对象的观点为参照，给出 2–4 句具体反馈，指出用户草稿尚未覆盖的代价或前提。不要礼貌性收尾，不要复述用户原话。
- 不要泛泛讲平衡，优先指出成立条件与证据缺口。
- probe：给用户一个需要继续核对的追问，一句话。
- 体检部分对**用户的回应草稿**打分，四个维度各 0–5 分：
  - grounding 依据：是否落到具体事实、来源、数字，而非空泛表态
  - relevance 切题：是否正面回应了你上一轮的核心主张，而不是自说自话
  - logic 逻辑：是否有绝对化（必然/肯定/所有人）、诉诸情绪、偷换概念；有因果链条与限定条件得分更高
  - novelty 增量：是否提供了新信息，而非重复已有立场
- comment：一句话点评，指出最该改进的那一个点。要具体，不要"继续加油"。

只输出 JSON：
{"reply":"...","probe":"...","scores":{"grounding":3,"relevance":4,"logic":2,"novelty":3},"comment":"..."}`,
    },
    {
      role: 'user',
      content: `话题：${query}
用户当前立场：${myStance.name}（${myStance.thesis}）
用户立场的主要论据：
${myArgs}
回应对象可引用的真实来源：
${ev}

此前回应记录：
${hist}

用户本轮回应：
${message}`,
    },
  ];
}

/** 无模型时的回答体检：可解释的规则引擎，反馈取自回应对象的真实论据 */
function localTurn({ opponentStance, history, message }) {
  const text = String(message || '');
  const myTurns = history.filter((h) => h.role === 'me').map((h) => h.content);
  const prevOpp = [...history].reverse().find((h) => h.role === 'opp');

  // 依据：是否落到具体出处/数字
  const citeHits = (text.match(/第\s*\d+|《[^》]{2,30}》|\d+(\.\d+)?\s*(%|％|万|千|亿|年|倍)/g) || []).length;
  const authorHits = opponentStance.representatives.filter((r) => text.includes(r.author)).length;
  const grounding = clamp05(1.5 + citeHits * 1.1 + authorHits * 1.4 + (text.length > 60 ? 0.7 : 0));

  // 切题：与回应对象上一条观点提示的关键 2-gram 重合度
  let relevance = 2.4;
  if (prevOpp) {
    const a = new Set(bigrams(prevOpp.content).slice(0, 60));
    const b = bigrams(text);
    const overlap = b.filter((g) => a.has(g)).length / Math.max(b.length, 1);
    relevance = clamp05(1.2 + overlap * 9);
  }

  // 逻辑：扣绝对化与情绪，奖限定与因果
  const fallacy = countMarkers(text, FALLACY_MARKERS);
  const hedge = countMarkers(text, HEDGE_MARKERS);
  const causal = countMarkers(text, CAUSAL_MARKERS);
  const logic = clamp05(2.6 + causal * 0.55 + hedge * 0.5 - fallacy * 1.05);

  // 增量：本次回应引入了多少此前没用过的词
  const prevGrams = new Set(myTurns.flatMap((t) => bigrams(t)));
  const curGrams = [...new Set(bigrams(text))];
  const fresh = curGrams.filter((g) => !prevGrams.has(g)).length / Math.max(curGrams.length, 1);
  const novelty = clamp05(1.6 + fresh * 4.2 + (text.length > 80 ? 0.6 : 0));

  const scores = { grounding, relevance, logic, novelty };

  // 回应提示：挑一条"用户最没覆盖到"的真实论据
  const unused = opponentStance.arguments.filter(
    (a) => !bigrams(text).some((g) => bigrams(a.text).includes(g)),
  );
  const pick = (unused.length ? unused : opponentStance.arguments)[0]
    || { text: opponentStance.thesis };
  const reply = `回应对象的关键提醒是：${pick.text}。请检查你的草稿是否正面覆盖了这一点。`;

  const weakest = JUDGE_DIMS.map((d) => ({ d, v: scores[d.key] })).sort((a, b) => a.v - b.v)[0];
  const comment = `本轮最该补的是「${weakest.d.label}」：${
    weakest.d.key === 'grounding' ? '目前多是判断，缺少可核验的来源或数字。'
      : weakest.d.key === 'relevance' ? '没有正面回应对方上一轮的追问。'
        : weakest.d.key === 'logic' ? '有绝对化表述，改用带条件的判断会更站得住。'
          : '基本是已有立场的复述，缺少新信息。'
  }`;

  return { reply, probe: '你如何界定这个判断的适用边界？有没有反例是你愿意承认的？', comment, scores };
}

/* ------------------------------------------------------- 3. 观点体检报告 */

export async function buildReport({ query, myStance, stances, history }) {
  const myTurns = history.filter((h) => h.role === 'me' && h.scores);
  const dims = JUDGE_DIMS.map((d) => {
    const vals = myTurns.map((t) => t.scores[d.key] || 0);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    return { ...d, value: +avg.toFixed(2) };
  });
  const total = dims.reduce((s, d) => s + d.value, 0);
  const maxTotal = dims.length * 5;

  const strongest = [...dims].sort((a, b) => b.value - a.value)[0];
  const weakest = [...dims].sort((a, b) => a.value - b.value)[0];

  // 你可能低估的一方：加权支持度最高、但不是你选的那个阵营
  const others = stances.filter((s) => s.id !== myStance.id).sort((a, b) => b.support - a.support);
  const underestimated = others[0] || null;

  // 立场互补的答主：从所有对立阵营里挑，按权威度 × 赞同数排序，同一位作者只出现一次
  const seenAuthors = new Set();
  const pool = [];
  for (const s of others) {
    for (const r of s.representatives) {
      if (seenAuthors.has(r.author)) continue;
      seenAuthors.add(r.author);
      pool.push({ ...r, stanceName: s.name, stanceColor: s.color });
    }
  }
  pool.sort((a, b) => answerWeight(b) - answerWeight(a));
  // 推荐要有信号：光靠权威等级会把"有认证但只有 6 个赞同"的答主也推出来。
  // 所以同时要求相对权重和绝对赞同量；小话题里如果这样筛空了，就退回只按权重取。
  const topWeight = pool.length ? answerWeight(pool[0]) : 0;
  const byWeight = pool.filter((a) => answerWeight(a) >= topWeight * 0.3);
  const byVotes = byWeight.filter((a) => (a.voteUp || 0) >= 30);
  const authors = (byVotes.length ? byVotes : byWeight).slice(0, 4);

  const insights = [
    {
      title: `你最强的是「${strongest.label}」`,
      body: `${strongest.hint}。你在这项上平均 ${strongest.value.toFixed(1)} 分，${
        strongest.key === 'grounding' ? '说明你习惯把判断落到具体依据上，这是最难得的。'
          : strongest.key === 'relevance' ? '说明你愿意正面接住对方的追问，而不是绕开。'
            : strongest.key === 'logic' ? '说明你的论证链条完整，很少用绝对化表述。'
              : '说明你能持续提供新信息，不是复述立场。'}`,
    },
    {
      title: `最该补的是「${weakest.label}」`,
      body: `${weakest.hint}。你在这项上平均 ${weakest.value.toFixed(1)} 分，是四维里最低的一项。${
        weakest.key === 'grounding' ? '下次发言前，先找一条可核验的来源再开口。'
          : weakest.key === 'relevance' ? '先复述对方的核心主张，确认自己没打偏。'
            : weakest.key === 'logic' ? '把"必然/一定"换成"在什么条件下"，论证会立刻变强。'
              : '试着给出一条对方没提到的信息，而不是更强的语气。'}`,
    },
  ];

  if (underestimated) {
    insights.push({
      title: `你可能低估了「${underestimated.name}」`,
      body: `这一方拿走了 ${(underestimated.support * 100).toFixed(0)}% 的加权支持——权重按权威等级^1.5 × 赞同数计算，也就是说它的支持者不是靠声量，而是靠更被认可的判断。它的核心主张是：${underestimated.thesis}`,
    });
  }

  const summary = await reportSummary({ query, myStance, dims, total, maxTotal, underestimated, myTurns }).catch(() => null);

  return {
    dims, total, maxTotal,
    turns: myTurns.length,
    citations: myTurns.reduce((s, t) => s + ((t.content.match(/第\s*\d+|《[^》]{2,30}》|\d+(\.\d+)?\s*(%|％|万|年|倍)/g) || []).length), 0),
    strongest, weakest, underestimated, authors, insights,
    summary: summary || `你选择「${myStance.name}」并完成了 ${myTurns.length} 次回应，四维合计 ${total.toFixed(1)} / ${maxTotal}。真正有价值的不是赢，而是你知道哪条成立条件与证据还需要补齐。`,
  };
}

async function reportSummary({ query, myStance, dims, total, maxTotal, underestimated, myTurns }) {
  if (!llmAvailable()) return null;
  const text = await chat([
    {
      role: 'system',
    content: '你是「争鸣」的评论员。用 2–3 句话给用户一份收尾评价：先说他回应草稿的论证风格，再说他下一步最该核对的一件事。不要客套，不要复述分数。直接输出文本，不要 JSON。',
    },
    {
      role: 'user',
      content: `话题：${query}
用户立场：${myStance.name}
四维均分：${dims.map((d) => `${d.label} ${d.value.toFixed(1)}`).join('，')}（满分 5）
总分：${total.toFixed(1)} / ${maxTotal}
回合数：${myTurns.length}
用户可能低估的阵营：${underestimated ? underestimated.name + '——' + underestimated.thesis : '无'}`,
    },
  ], { temperature: 0.6, maxTokens: 400 });
  return String(text).trim().slice(0, 400);
}

/** 生成分享海报里的一句话结论 */
export function posterLine(report, myStance) {
  return `我在「${myStance.name}」这一侧完成 ${report.turns} 次回应，依据 ${report.dims[0].value.toFixed(1)}、切题 ${report.dims[1].value.toFixed(1)}、逻辑 ${report.dims[2].value.toFixed(1)}、增量 ${report.dims[3].value.toFixed(1)}。`;
}
