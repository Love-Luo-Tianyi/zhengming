/**
 * 争鸣 · 后端（可选部署）
 *
 * 存在的唯一理由：把密钥留在服务端。
 *   - 知乎 Access Secret 一旦放进前端就是公开的，后端可以只做转发并限流；
 *   - 模型 Key 同理，访客不需要自带 Key 也能体验完整功能；
 *   - 知乎开放平台接口已开启 CORS，所以前端不走后端也能跑通，后端是"更体面"的那条路。
 *
 * 零依赖：只用 Node 内置模块，评委拿到仓库 `node server/index.mjs` 就能起。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 8787);

const ZHIHU_SECRET = process.env.ZHIHU_ACCESS_SECRET || '';
const LLM_BASE = (process.env.ZM_LLM_BASE || '').replace(/\/+$/, '');
const LLM_KEY = process.env.ZM_LLM_KEY || '';
const LLM_MODEL = process.env.ZM_LLM_MODEL || 'gpt-4o-mini';

const ZHIHU_API = 'https://developer.zhihu.com';

/* 只放行确实需要的接口，避免后端变成万能代理 */
const ALLOWED_ZHIHU = new Set([
  '/api/v1/content/zhihu_search',
  '/api/v1/content/global_search',
  '/api/v1/content/hot_list',
  '/api/v1/user/followees',
  '/api/v1/user/followers',
  '/api/v1/user/contents',
  '/api/v1/user/favlists',
  '/api/v1/user/collections',
]);

/* 简易限流：单 IP 每分钟上限，防止 Demo 被刷爆日额度 */
const buckets = new Map();
const RATE_LIMIT = Number(process.env.ZM_RATE_LIMIT || 120);

function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { count: 0, reset: now + 60000 };
  if (now > b.reset) { b.count = 0; b.reset = now + 60000; }
  b.count += 1;
  buckets.set(ip, b);
  return b.count > RATE_LIMIT;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(s);
}

async function readBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------------ 路由 */

async function handleZhihu(req, res, url) {
  const target = url.pathname.replace(/^\/api\/zhihu/, '');
  if (!ALLOWED_ZHIHU.has(target)) return json(res, 403, { code: 403, message: '该接口未在允许列表内' });
  if (!ZHIHU_SECRET) return json(res, 503, { code: 20001, message: '服务端未配置 ZHIHU_ACCESS_SECRET' });

  const upstream = `${ZHIHU_API}${target}${url.search || ''}`;
  try {
    const r = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${ZHIHU_SECRET}`,
        'X-Request-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
    });
    const text = await r.text();
    res.writeHead(r.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    json(res, 502, { code: 90001, message: `转发知乎接口失败：${err.message}` });
  }
}

async function handleLlm(req, res) {
  if (!LLM_BASE || !LLM_KEY) return json(res, 503, { error: { message: '服务端未配置模型密钥' } });
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (err) {
    return json(res, 400, { error: { message: `请求体解析失败：${err.message}` } });
  }

  const { messages, temperature = 0.5, json: wantJson = false, max_tokens = 2048 } = payload || {};
  if (!Array.isArray(messages) || !messages.length) {
    return json(res, 400, { error: { message: 'messages 不能为空' } });
  }

  const body = {
    model: LLM_MODEL,
    messages,
    temperature,
    max_tokens: Math.min(Number(max_tokens) || 2048, 8192),
  };
  if (wantJson) body.response_format = { type: 'json_object' };

  try {
    const r = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    res.writeHead(r.status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(text);
  } catch (err) {
    json(res, 502, { error: { message: `转发模型失败：${err.message}` } });
  }
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // 防目录穿越：解析后必须仍在 web/ 内
  const full = path.resolve(path.join(WEB, rel));
  if (!full.startsWith(WEB)) return json(res, 403, { code: 403, message: 'forbidden' });

  try {
    const stat = await fs.stat(full);
    const file = stat.isDirectory() ? path.join(full, 'index.html') : full;
    const data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const etag = `W/"${data.length.toString(16)}-${stat.mtimeMs.toString(36)}"`;

    // 代码与数据每次都要校验新鲜度：Demo 期间改一版就立刻生效，评委也不会看到旧页面
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    // 单页应用：未知路径回落到 index.html
    try {
      const data = await fs.readFile(path.join(WEB, 'index.html'));
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    } catch {
      json(res, 404, { code: 404, message: 'not found' });
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (rateLimited(ip)) return json(res, 429, { code: 30001, message: '请求过于频繁，请稍后再试' });

  if (url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      name: '争鸣',
      zhihu: !!ZHIHU_SECRET,
      llm: !!(LLM_BASE && LLM_KEY),
      model: LLM_MODEL,
      time: new Date().toISOString(),
    });
  }

  if (url.pathname.startsWith('/api/zhihu/')) return handleZhihu(req, res, url);
  if (url.pathname === '/api/llm/chat') return handleLlm(req, res);
  if (url.pathname.startsWith('/api/')) return json(res, 404, { code: 404, message: 'unknown api' });

  return serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`争鸣 已启动 → http://localhost:${PORT}`);
  console.log(`  知乎密钥：${ZHIHU_SECRET ? '已配置' : '未配置（前端将使用离线快照）'}`);
  console.log(`  模型密钥：${LLM_BASE && LLM_KEY ? `已配置（${LLM_MODEL}）` : '未配置（前端将使用本地裁判）'}`);
});
