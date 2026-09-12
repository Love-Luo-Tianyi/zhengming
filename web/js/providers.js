/**
 * 数据源：知乎开放平台（实时）与离线快照（演示）。
 *
 * 两个来源产出同一种形状的「原始答材料」：
 *   RawAnswer = { id, title, author, authorAvatar, authorUrl, authorityLevel,
 *                 voteUp, commentCount, url, excerpt, comments[], capturedAt? }
 * 这样下游的分析引擎完全不需要知道数据是从哪来的。
 */

import { settings, backendBase, effectiveMode, runtime } from './config.js?v=20260912h';

const API_BASE = 'https://developer.zhihu.com';
const CACHE_PREFIX = 'zhengming.cache.';
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟。接口有日调用上限，必须缓存。

/* ------------------------------------------------------------------ 缓存 */

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const { at, data } = JSON.parse(raw);
    if (Date.now() - at > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), data }));
  } catch { /* 超配额就算了，不阻断主流程 */ }
}

export function clearCache() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(CACHE_PREFIX))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* 同上 */ }
}

/* ------------------------------------------------------- 知乎开放平台客户端 */

export class ZhihuError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ZhihuError';
    this.code = code;
  }
}

function stamp() {
  return String(Math.floor(Date.now() / 1000));
}

/**
 * 统一的知乎接口调用。优先走后端（密钥留在服务端），否则浏览器直连（CORS 已开放）。
 */
async function zhihuGet(path, params = {}, { viaBackend = false } = {}) {
  const qs = new URLSearchParams(params).toString();
  const cacheKey = `g:${path}?${qs}`;
  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  if (viaBackend) {
    const url = `${backendBase()}/api/zhihu${path}?${qs}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json) throw new ZhihuError(json?.message || `后端返回 HTTP ${res.status}`, json?.code);
    if (json.Code !== undefined && json.Code !== 0) {
      throw new ZhihuError(json.Message || `知乎接口错误 ${json.Code}`, json.Code);
    }
    const data = json.Data !== undefined ? json.Data : json;
    cacheSet(cacheKey, data);
    return data;
  }

  if (!settings.secret) throw new ZhihuError('未配置知乎 Access Secret', 20001);
  const res = await fetch(`${API_BASE}${path}?${qs}`, {
    headers: {
      Authorization: `Bearer ${settings.secret}`,
      'X-Request-Timestamp': stamp(),
      'Content-Type': 'application/json',
    },
  });
  const json = await res.json().catch(() => null);
  if (!json) throw new ZhihuError(`知乎接口返回非 JSON（HTTP ${res.status}）`);
  if (json.Code !== 0) {
    const hint = {
      20001: '鉴权失败：Access Secret 不正确或已失效。',
      30001: '触发频率限制：该接口有日调用上限，请稍后再试或改回离线快照。',
      30002: '配额已用尽：请明天再试或改回离线快照。',
    }[json.Code];
    throw new ZhihuError(hint || (json.Message || `知乎接口错误 ${json.Code}`), json.Code);
  }
  cacheSet(cacheKey, json.Data);
  return json.Data;
}

/** 后端已经配好知乎密钥时，一律走服务端转发，密钥不进浏览器 */
function usingBackend() {
  return !!(runtime.backend && runtime.backend.ok && runtime.backend.zhihu);
}

/** 知乎搜索：返回答案/文章，带权威等级、赞同数、精选评论 */
export async function zhihuSearch(query, count = 10) {
  const data = await zhihuGet('/api/v1/content/zhihu_search',
    { Query: query, Count: String(Math.min(count, 10)) },
    { viaBackend: usingBackend() });
  return (data.Items || []).map(normalizeSearchItem);
}

/** 热榜：把握当前社区真实焦点 */
export async function hotList(limit = 30) {
  const data = await zhihuGet('/api/v1/content/hot_list',
    { Limit: String(Math.min(limit, 30)) },
    { viaBackend: usingBackend() });
  return data.Items || [];
}

/** 全网搜索：当站内样本不足时补充外部视角 */
export async function globalSearch(query, count = 10) {
  const data = await zhihuGet('/api/v1/content/global_search',
    { Query: query, Count: String(Math.min(count, 20)) },
    { viaBackend: usingBackend() });
  return (data.Items || []).map(normalizeSearchItem);
}

/** 关注流 / 关注列表：用于「立场互补的答主」推荐的真实关系校验 */
export async function followees(limit = 50) {
  return zhihuGet('/api/v1/user/followees',
    { Limit: String(Math.min(limit, 50)) }, { viaBackend: usingBackend() });
}

function normalizeSearchItem(it, i) {
  const comments = (it.CommentInfoList || []).map((c) => c.Content).filter(Boolean);
  return {
    id: i + 1,
    contentId: String(it.ContentID || ''),
    title: it.Title || '',
    author: it.AuthorName || '知乎用户',
    authorAvatar: it.AuthorAvatar || '',
    authorBadgeText: it.AuthorBadgeText || '',
    authorityLevel: Number(it.AuthorityLevel || 1),
    voteUp: Number(it.VoteUpCount || 0),
    commentCount: Number(it.CommentCount || 0),
    rankingScore: Number(it.RankingScore || 0),
    editTime: Number(it.EditTime || 0),
    url: (it.Url || '').split('?')[0] || it.Url,
    excerpt: stripTags(it.ContentText || ''),
    comments,
  };
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

/* ------------------------------------------------------------- 离线快照 */

let topicIndexCache = null;

export async function loadTopicIndex() {
  if (topicIndexCache) return topicIndexCache;
  const res = await fetch('./data/topics/index.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error('找不到样本库索引 data/topics/index.json');
  topicIndexCache = await res.json();
  return topicIndexCache;
}

/** 完整快照：既含原始答料，也含已经算好的分析结果 */
export async function loadTopic(id) {
  const hit = cacheGet(`topic:${id}`);
  if (hit) return hit;
  const res = await fetch(`./data/topics/${id}.json`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`找不到样本 ${id}`);
  const topic = await res.json();
  cacheSet(`topic:${id}`, topic);
  return topic;
}

/** 给一个自由输入，尽量在样本库里找到最接近的那个争议 */
export async function matchTopic(query) {
  const idx = await loadTopicIndex();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s，。？?！!、,.]/g, '');

  let best = null;
  let bestScore = 0;
  for (const t of idx.topics) {
    const bag = [t.title, t.query, ...(t.keywords || [])].map(norm);
    let score = 0;
    for (const b of bag) {
      if (!b) continue;
      if (b === norm(q)) score = Math.max(score, 100);
      else if (b.includes(norm(q)) || norm(q).includes(b)) score = Math.max(score, 70);
      else {
        // 字符级重合度，中文没有空格分词，这样足够了
        const set = new Set(b.split(''));
        const hit = norm(q).split('').filter((c) => set.has(c)).length;
        score = Math.max(score, (hit / Math.max(b.length, 1)) * 40);
      }
    }
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return bestScore >= 26 ? best : null;
}

/* ---------------------------------------------------------- 统一取数入口 */

/**
 * 取一批可用于立场分析的答料。
 * @returns {{ answers: RawAnswer[], origin: 'live'|'snapshot', snapshot?: object }}
 */
export async function fetchAnswers(query, { limit = 10 } = {}) {
  const mode = effectiveMode();

  if (mode.data === 'live') {
    try {
      const answers = await zhihuSearch(query, limit);
      if (answers.length >= 4) {
        return { answers, origin: 'live' };
      }
      // 站内样本太少，用全网搜索补一批
      const extra = await globalSearch(query, 10);
      if (extra.length) return { answers: [...answers, ...extra], origin: 'live' };
      if (answers.length) return { answers, origin: 'live' };
      throw new ZhihuError('知乎搜索没有返回可用结果，请换一个话题或改回离线快照。');
    } catch (err) {
      if (!(err instanceof ZhihuError)) throw err;
      // 实时失败就退回快照，Demo 不能因为配额用完就崩
      const snap = await matchTopic(query);
      if (snap) {
        const topic = await loadTopic(snap.id);
        return { answers: topic.answers, origin: 'snapshot', snapshot: topic, fallbackReason: err.message };
      }
      throw err;
    }
  }

  const snap = await matchTopic(query);
  if (!snap) {
    const e = new Error('样本库里没有这个话题');
    e.code = 'NOT_IN_LIBRARY';
    throw e;
  }
  const topic = await loadTopic(snap.id);
  return { answers: topic.answers, origin: 'snapshot', snapshot: topic };
}
