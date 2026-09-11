/** 极简 DOM 与格式化工具。刻意不引第三方库，静态站零依赖、加载快、评委打开即用。 */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(parent, ...nodes) {
  clear(parent);
  for (const n of nodes.flat()) if (n) parent.append(n);
  return parent;
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function votes(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

export function authorityBadge(level) {
  const lv = Number(level) || 1;
  const label = { 4: '超高权威', 3: '高权威', 2: '中权威', 1: '普通' }[lv];
  return h('span', { class: `badge auth-${lv}`, title: `知乎开放平台权威等级 ${lv}/4`, text: label });
}

export function sourceLink(answer) {
  return h('a', {
    class: 'badge',
    href: answer.url,
    target: '_blank',
    rel: 'noopener noreferrer',
    title: '打开知乎原文（作品中的论据均可溯源）',
    text: '查看原文 ↗',
  });
}

export function loading(text) {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), h('span', { text }));
}

export function notice(text, kind = '') {
  return h('div', { class: `notice ${kind}`.trim(), html: text });
}

/** 逐字打印：让汇报/录屏时更有"AI 在现场思考"的观感 */
export async function typewriter(el, text, { speed = 16, chunk = 2 } = {}) {
  clear(el);
  const str = String(text);
  for (let i = 0; i < str.length; i += chunk) {
    el.append(document.createTextNode(str.slice(i, i + chunk)));
    if (i % (chunk * 6) === 0) {
      el.parentElement?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    await new Promise((r) => setTimeout(r, speed));
  }
  return el;
}

export function download(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http 或无权限时的兜底
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/** 把百分比映射到极坐标，供雷达图使用 */
export function polar(cx, cy, r, angleDeg) {
  const a = (angleDeg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
