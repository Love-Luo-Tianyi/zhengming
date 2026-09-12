/** 首页：一句话说清产品主张，然后立刻让用户动手。 */

import { h, mount, loading, notice } from '../dom.js?v=20260912';

const QUICK = [
  'AI 会取代程序员吗',
  '考研到底值不值',
  '年轻人该不该躺平',
  '该不该劝退生化环材',
  '天赋和努力哪个更重要',
];

/**
 * 渲染首页。刻意做成幂等的：只往既有容器里灌内容，不替换带 id 的节点，
 * 这样反复调用（切回首页、保存设置后刷新）都不会破坏绑定。
 */
export function renderHome(container, { onPick, onAnalyze, onFreeform }) {
  const grid = container.querySelector('#topicGrid');
  const libraryHint = container.querySelector('#libraryHint');
  const quick = container.querySelector('#quickTopics');
  const input = container.querySelector('#topicInput');
  const btn = container.querySelector('#btnAnalyze');
  if (!grid || !quick || !input || !btn) return { focusInput: () => {} };

  const submit = () => {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    onAnalyze(q);
  };

  // 事件每次重绑：元素是复用的，不重绑会累积旧闭包
  const bound = btn.dataset.zmBound === '1';
  if (!bound) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    btn.addEventListener('click', submit);
    btn.dataset.zmBound = '1';
  }
  btn.onclick = submit;

  mount(quick,
    QUICK.map((q) => h('button', { class: 'chip', onclick: () => onAnalyze(q) }, q)),
    h('button', {
      class: 'chip',
      onclick: onFreeform,
      title: '库里没有你想要的话题时，用自己的知乎密钥检索站内真实回答',
    }, '+ 用实时知乎数据查别的'));

  mount(grid, loading('正在载入争议样本库…'));
  if (libraryHint) libraryHint.textContent = '';

  (async () => {
    const { loadTopicIndex } = await import('../providers.js?v=20260912');
    try {
      const index = await loadTopicIndex();
      if (libraryHint) {
        libraryHint.textContent = `${index.topics.length} 个话题 · 均基于知乎站内真实回答构建 · 点开即用`;
      }
      mount(grid, index.topics.map((t) => card(t, onPick)));
    } catch (err) {
      mount(grid, notice(
        `样本库载入失败：${err.message}<br />你仍然可以直接在上方输入话题，或点「用实时知乎数据查别的」。`,
        'err'));
      if (libraryHint) libraryHint.textContent = '';
    }
  })();

  return { focusInput: () => input.focus() };
}

function card(t, onPick) {
  const pct = Math.round((t.controversy || 0.5) * 100);
  return h('button', { class: 'topic-card', onclick: () => onPick(t.id) },
    h('div', { class: 'topic-card-meta' },
      h('span', { text: t.category || '社区争议' }),
      h('span', { text: '·' }),
      h('span', { text: `${t.answerCount || 0} 条高赞回答` }),
      t.capturedAt ? h('span', { text: '·' }, h('span', { text: `快照 ${t.capturedAt}` })) : null),
    h('h3', { text: t.title }),
    h('div', { class: 'stance-mini' }, (t.stanceNames || []).map((n) => h('span', { text: n }))),
    h('div', { class: 'controversy-meter' },
      h('span', { class: 'tiny muted', text: '分歧烈度' }),
      h('div', { class: 'controversy-bar' },
        h('div', { class: 'controversy-fill', style: { width: `${pct}%` } })),
      h('span', { class: 'tiny num', text: String(pct) })));
}
