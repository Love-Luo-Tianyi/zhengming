/**
 * 模型调用层。三种来源共用一种调用姿势，并对"模型不肯好好输出 JSON"这件事做防御。
 *
 * 争鸣对模型的使用全部是「结构化判定」而不是「自由创作」：
 *   - 立场聚类（把 N 条回答归成 2–4 个对立阵营）
 *   - 论证生成（每阵营最强 3 条论证，必须挂回原文出处）
 *   - 回合裁判（四维打分 + 点评 + 追问）
 *   所以这里只保留 JSON 一条通道，降低解析失败面。
 */

import { settings, backendBase, effectiveMode, runtime } from './config.js?v=20260912m';

/** 同源后端的 base 是空串，所以不能靠 base 是否非空来判断后端可用性 */
function backendUsable() {
  return !!(runtime.backend && runtime.backend.ok);
}

export function llmAvailable() {
  const m = effectiveMode();
  if (m.llm === 'backend' && backendUsable()) return true;
  if (m.llm === 'byok' && settings.apiKey && settings.baseUrl) return true;
  return false;
}

export class LLMError extends Error {
  constructor(message, kind = 'llm_error') {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
  }
}

/**
 * 调一次模型。json=true 时会尽最大努力把回复解析成对象。
 */
export async function chat(messages, { json = false, temperature = 0.5, timeoutMs = 90000, maxTokens = 2000 } = {}) {
  const m = effectiveMode();
  let url;
  let headers = { 'Content-Type': 'application/json' };
  let body;

  if (m.llm === 'backend' && backendUsable()) {
    url = `${backendBase()}/api/llm/chat`;
    body = { messages, temperature, json, max_tokens: maxTokens };
  } else if (m.llm === 'byok' && settings.apiKey && settings.baseUrl) {
    url = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    headers.Authorization = `Bearer ${settings.apiKey}`;
    body = {
      model: settings.model || 'gpt-4o-mini',
      messages,
      temperature,
      max_tokens: maxTokens,
    };
  } else {
    throw new LLMError('没有可用的模型来源', 'no_llm');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new LLMError(`模型响应超时（${Math.round(timeoutMs / 1000)} 秒）`, 'timeout');
    throw new LLMError(`模型请求失败：${err.message}`, 'network');
  }
  clearTimeout(timer);

  const raw = await res.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new LLMError(`模型返回非 JSON（HTTP ${res.status}）`, 'bad_response'); }

  if (!res.ok) {
    const msg = parsed?.error?.message || parsed?.message || `HTTP ${res.status}`;
    throw new LLMError(`模型接口报错：${msg}`, 'http_error');
  }

  const text = parsed?.choices?.[0]?.message?.content
    ?? parsed?.Data?.choices?.[0]?.message?.content
    ?? parsed?.content
    ?? '';
  if (!text) throw new LLMError('模型返回了空回复', 'empty');

  return json ? parseJsonLoose(text) : text;
}

/** 模型经常给 ```json 包裹或前后加解释，这里做宽容解析 */
export function parseJsonLoose(text) {
  if (typeof text === 'object' && text) return text;
  let s = String(text).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }

  // 截取第一个 { 到最后一个 }，容忍模型在 JSON 前后写解释
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = s.slice(start, end + 1);
    try { return JSON.parse(sliced); } catch { /* 继续 */ }
    // 常见毛病：尾随逗号
    try { return JSON.parse(sliced.replace(/,\s*([\]}])/g, '$1')); } catch { /* 放弃 */ }
  }
  throw new LLMError('模型输出无法解析为 JSON', 'json_parse');
}
