/**
 * 战局：把一场争论拆成并排的立场阵营。
 * 页面结构本身就是产品主张——分歧不是要被总结掉的噪声，而是要被并排看见的主语。
 */

import { h, mount, authorityBadge, sourceLink, votes, clear } from '../dom.js?v=20260912';

export function renderArena(container, { analysis, onEnterDebate, onEnterAsOpponent }) {
  const { query, stances, controversy, keyline, answers } = analysis;

  container.querySelector('#arenaTitle').textContent = query;

  const live = analysis.origin === 'live';
  const engineLabel = analysis.engine === 'llm' ? '模型分析' : '本地规则分析';
  mount(container.querySelector('#arenaMeta'),
    h('span', { class: `mode-pill ${live ? 'live' : ''}` },
      h('span', { class: 'mode-dot' }),
      h('span', { text: live ? '知乎实时检索' : '离线快照' })),
    h('span', { class: 'mode-pill' }, h('span', { text: `${answers.length} 条回答` })),
    h('span', { class: 'mode-pill' }, h('span', { text: engineLabel })),
    analysis.fallbackReason
      ? h('span', { class: 'mode-pill' }, h('span', { text: `已从实时降级：${analysis.fallbackReason.slice(0, 24)}` }))
      : null);

  const pct = Math.round(controversy * 100);
  mount(container.querySelector('#arenaDivergence'),
    h('span', { class: 'divergence-label', text: '分歧烈度' }),
    h('span', { class: 'divergence-value', text: String(pct) }),
    h('div', { class: 'controversy-bar', style: { width: '180px' } },
      h('div', { class: 'controversy-fill', style: { width: `${pct}%` } })),
    h('span', { class: 'divergence-note', text: controversyNote(pct) }));

  container.querySelector('#arenaKeyline').innerHTML =
    `<b>真正的分歧点：</b>${escapeHtml(keyline || '这一话题下存在明显立场分化。')}`;

  const grid = container.querySelector('#stanceGrid');
  mount(grid, stances.map((s) => stanceCard(s, analysis, onEnterDebate, onEnterAsOpponent)));
}

function controversyNote(pct) {
  if (pct >= 70) return '双方权威度接近、阵营分布均匀——这是一场真正胶着的争论。';
  if (pct >= 45) return '存在清晰的对立阵营，但一方已略占上风。';
  return '立场分布偏向一侧，但仍有一条值得认真对待的少数意见。';
}

function stanceCard(s, analysis, onEnterDebate, onEnterAsOpponent) {
  const drawer = h('div', { class: 'drawer hidden' });

  const toggle = h('button', {
    class: 'btn btn-sm btn-ghost',
    onclick: () => {
      const open = !drawer.classList.contains('hidden');
      if (!open) buildDrawer(drawer, s, analysis);
      drawer.classList.toggle('hidden', open);
      toggle.textContent = open ? `查看 ${s.representatives.length} 条原始回答` : '收起原始回答';
    },
  }, `查看 ${s.representatives.length} 条原始回答`);

  const card = h('div', {
    class: 'stance-card',
    style: { '--sc': s.color, '--sc-dim': s.dim, '--sc-bd': s.bd },
  },
    h('div', { class: 'stance-card-head' },
      h('div', { class: 'stance-name', text: s.name }),
      h('div', { class: 'stance-support' }, h('b', { text: `${Math.round(s.support * 100)}%` }), '加权支持')),
    h('div', { class: 'support-bar' }, h('div', { class: 'support-fill', style: { width: `${Math.round(s.support * 100)}%` } })),
    h('div', { class: 'stance-thesis', text: s.thesis }),
    h('div', { class: 'stance-args' },
      s.arguments.map((a) => h('div', { class: 'stance-arg' },
        h('span', { class: 'bullet', text: '—' }),
        h('span', {},
          a.text,
          a.evidenceIds?.length
            ? h('span', { class: 'src', text: ` [来源 ${a.evidenceIds.join('·')}]` })
            : null)))),
    s.keywords?.length
      ? h('div', { class: 'stance-mini', style: { marginTop: '13px' } }, s.keywords.map((k) => h('span', { text: k })))
      : null,
    h('div', { class: 'stance-foot' },
      h('button', { class: 'btn btn-sm btn-primary', onclick: () => onEnterDebate(s.id) }, '入座这一方'),
      h('button', {
        class: 'btn btn-sm',
        title: '反过来：你来扮演这一方，让 AI 站到你的对立面',
        onclick: () => onEnterAsOpponent(s.id),
      }, '替这一方辩'),
      toggle),
    drawer,
  );
  return card;
}

function buildDrawer(drawer, stance, analysis) {
  clear(drawer);
  const seen = new Set();
  const items = [];
  for (const r of stance.representatives) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    items.push(r);
  }
  if (!items.length) {
    for (const a of analysis.answers) {
      if ((stance.evidenceIds || []).includes(a.id) && !seen.has(a.id)) { seen.add(a.id); items.push(a); }
    }
  }
  if (!items.length) {
    drawer.append(h('div', { class: 'tiny muted', text: '这一阵营在本次检索里没有单独署名的代表回答。' }));
    return;
  }
  for (const a of items.slice(0, 6)) {
    drawer.append(h('div', { class: 'evidence' },
      h('div', { class: 'evidence-title', text: a.title }),
      h('div', { class: 'evidence-text clamp', text: a.excerpt }),
      a.comments?.length
        ? h('div', { class: 'evidence-text', style: { marginTop: '8px', color: 'var(--text-400)' } },
          h('b', { text: '精选评论：' }), a.comments.slice(0, 2).join(' ／ '))
        : null,
      h('div', { class: 'evidence-top', style: { marginTop: '10px' } },
        h('span', { text: a.author }),
        h('span', { class: 'tiny muted', text: `回答 ID ${a.answerId || '未知'}` }),
        authorityBadge(a.authorityLevel),
        h('span', { text: `赞同 ${votes(a.voteUp)}` }),
        h('span', { text: `评论 ${votes(a.commentCount)}` }),
        sourceLink(a))));
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
