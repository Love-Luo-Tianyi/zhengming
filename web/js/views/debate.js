/**
 * 回应体检：你选择一个观点坐标，针对不同论据提交草稿并获得四维反馈。
 * 每一次回应都被按四维体检——这是「观点复核」和单纯表达态度的区别。
 */

import { h, mount, loading, clear, typewriter, authorityBadge, sourceLink } from '../dom.js?v=20260912c';
import { debateTurn, JUDGE_DIMS, STANCE_COLORS } from '../pipeline.js?v=20260912f';
import { llmAvailable } from '../llm.js?v=20260912c';

const MAX_ROUNDS = 5;

export function createDebateView(container, { analysis, onFinish, onExit }) {
  const state = {
    myId: null,
    oppId: null,
    history: [],       // { role: 'me'|'opp', content, scores?, comment?, probe? }
    busy: false,
    finished: false,
  };

  const stream = container.querySelector('#stream');
  const roundsEl = container.querySelector('#rounds');
  const oppPanel = container.querySelector('#opponentPanel');
  const ammoPanel = container.querySelector('#ammoPanel');
  const input = container.querySelector('#composerInput');
  const btnSend = container.querySelector('#btnSend');
  const btnSwap = container.querySelector('#btnSwapSide');
  const btnEnd = container.querySelector('#btnEndDebate');
  const hint = container.querySelector('#composerHint');

  btnSend.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
  });
  btnSwap.addEventListener('click', () => {
    if (state.busy || state.finished) return;
    const t = state.myId;
    state.myId = state.oppId;
    state.oppId = t;
    state.history = [];
    start();
  });
  btnEnd.addEventListener('click', () => {
    if (state.busy) return;
    finish();
  });
  container.querySelector('#debateBack').addEventListener('click', (e) => {
    e.preventDefault();
    if (state.busy) return;
    onExit();
  });

  function stanceById(id) {
    return analysis.stances.find((s) => s.id === id) || analysis.stances[0];
  }

  function start() {
    state.finished = false;
    const me = stanceById(state.myId);
    const opp = stanceById(state.oppId);

    container.querySelector('#debateTitle').textContent = analysis.query;
    mount(container.querySelector('#debateMeta'),
      h('span', { class: 'mode-pill' }, h('span', { class: 'mode-dot' }), h('span', { text: `你 · ${me.name}` })),
      h('span', { class: 'mode-pill' }, h('span', { text: '回应对象 · ' }, h('b', { text: opp.name }))),
      h('span', { class: 'mode-pill' }, h('span', {
        text: llmAvailable() ? '模型裁判 · 四维打分' : '本地裁判 · 规则引擎（可在设置里换成模型）',
      })));

    renderOpponentPanel(opp);
    renderAmmo(me);
    renderRounds();
    updateHint();

    // 先展示待回应观点：只使用快照中已溯源的论据
    clear(stream);
    const opener = opp.arguments[0]?.text || opp.thesis;
    state.history.push({
      role: 'opp',
      content: `先看这条不同观点：${opp.thesis}\n${opener}——你准备如何回应？`,
    });
    pushOppBubble(state.history[state.history.length - 1].content, true);
    input.focus();
  }

  function renderOpponentPanel(opp) {
    mount(oppPanel,
      h('div', { style: { fontSize: '15px', fontWeight: '700', color: opp.color, marginBottom: '8px' }, text: opp.name }),
      h('div', { class: 'tiny', style: { lineHeight: '1.7', color: 'var(--text-200)' }, text: opp.thesis }),
      h('div', { style: { marginTop: '12px' } },
        opp.arguments.slice(0, 3).map((a, i) => h('div', {
          class: 'stance-arg',
          style: { marginBottom: '8px' },
        }, h('span', { class: 'bullet', style: { color: opp.color }, text: String(i + 1) }),
          h('span', { text: a.text })))));
  }

  function renderAmmo(me) {
    mount(ammoPanel,
      h('div', { style: { lineHeight: '1.75', marginBottom: '10px' }, text: '引用下面这些来源（写「第 N 条」或作者名）能显著提高「依据」得分。' }),
      me.arguments.map((a, i) => h('div', { style: { marginBottom: '7px' } },
        h('span', { style: { color: me.color }, text: `${i + 1}. ` }), a.text)),
      me.representatives.slice(0, 3).map((r) => h('div', { style: { marginTop: '8px' } },
        h('div', { style: { color: 'var(--text-200)' }, text: `《${r.title}》` }),
        h('div', { style: { display: 'flex', gap: '7px', alignItems: 'center', marginTop: '4px' } },
          h('span', { text: r.author }), authorityBadge(r.authorityLevel), sourceLink(r)))));
  }

  function renderRounds() {
    const done = state.history.filter((t) => t.role === 'me').length;
    mount(roundsEl, Array.from({ length: MAX_ROUNDS }, (_, i) => {
      const cls = i < done ? 'round-dot done' : 'round-dot';
      return h('div', { class: 'round-row' },
        h('span', { class: cls, text: String(i + 1) }),
        h('span', { text: i < done ? roundSummary(i) : i === done ? '当前提交' : '未开始' }));
    }));
  }

  function roundSummary(i) {
    const me = state.history.filter((t) => t.role === 'me')[i];
    if (!me?.scores) return '已完成';
    const total = JUDGE_DIMS.reduce((s, d) => s + (me.scores[d.key] || 0), 0);
    return `${total} / 20 分`;
  }

  function updateHint() {
    const done = state.history.filter((t) => t.role === 'me').length;
    hint.textContent = done >= MAX_ROUNDS
      ? '已完成 5 次提交，可以查看体检报告了'
      : `第 ${done + 1} / ${MAX_ROUNDS} 次提交 · ⌘/Ctrl + Enter 提交`;
    btnSend.textContent = done >= MAX_ROUNDS ? '继续提交' : '提交回应';
  }

  function pushOppBubble(text, instant = false) {
    const opp = stanceById(state.oppId);
    const body = h('div', { class: 'turn-body' });
    const turn = h('div', {
      class: 'turn opp',
      style: { '--oc': opp.color, '--oc-dim': opp.dim, '--oc-bd': opp.bd },
    },
      h('div', { class: 'turn-head' },
        h('span', { class: 'avatar opp', text: opp.name.slice(0, 1) }),
        h('span', { text: `回应对象 · ${opp.name}` })),
      body);
    stream.append(turn);
    if (instant) body.textContent = text;
    else typewriter(body, text, { speed: 14 }).then(() => scrollDown());
  }

  function pushMyBubble(text) {
    stream.append(h('div', { class: 'turn me' },
      h('div', { class: 'turn-head' },
        h('span', { class: 'avatar me', text: '我' }),
        h('span', { text: '你' })),
      h('div', { class: 'turn-body', text })));
  }

  function pushJudgeCard({ scores, comment, probe, engine }) {
    const total = JUDGE_DIMS.reduce((s, d) => s + (scores[d.key] || 0), 0);
    const dims = h('div', { class: 'judge-dims' }, JUDGE_DIMS.map((d) => {
      const v = scores[d.key] || 0;
      const cls = v <= 2 ? 'low' : v <= 3.5 ? 'mid' : '';
      return h('div', { class: 'dim', title: d.hint },
        h('div', { class: 'dim-top' }, h('span', { text: d.label }), h('b', { text: `${v}/5` })),
        h('div', { class: 'dim-bar' }, h('div', { class: `dim-fill ${cls}`, style: { width: `${(v / 5) * 100}%` } })));
    }));

    stream.append(h('div', { class: 'judge' },
      h('div', { class: 'judge-head' },
        h('span', { class: 'judge-title', text: `裁判 · ${engine === 'llm' ? '模型' : '本地规则'}` }),
        h('span', { class: 'judge-total', text: `${total}` }, h('span', { class: 'tiny muted', text: ' / 20' }))),
      dims,
      comment ? h('div', { class: 'judge-comment' }, h('b', { text: '点评：' }), comment) : null,
      probe ? h('div', { class: 'judge-probe' }, h('b', { text: '追问：' }), probe) : null));
    scrollDown();
  }

  function pushThinking() {
    const el = loading('正在整理下一条待回应论据…');
    el.id = 'thinking';
    stream.append(el);
    scrollDown();
    return el;
  }

  function scrollDown() {
    const box = container.querySelector('.stream');
    if (box) window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  async function send() {
    if (state.busy || state.finished) return;
    const text = input.value.trim();
    if (!text) { input.focus(); return; }

    state.busy = true;
    btnSend.disabled = true;
    input.value = '';
    pushMyBubble(text);
    const thinking = pushThinking();

    try {
      const res = await debateTurn({
        query: analysis.query,
        myStance: stanceById(state.myId),
        opponentStance: stanceById(state.oppId),
        history: state.history,
        message: text,
      });

      thinking.remove();
      state.history.push({ role: 'me', content: text, scores: res.scores, comment: res.comment, probe: res.probe });
      pushJudgeCard(res);

      const oppText = res.probe ? `${res.reply}\n${res.probe}` : res.reply;
      state.history.push({ role: 'opp', content: oppText });
      pushOppBubble(oppText);

      renderRounds();
      updateHint();
    } catch (err) {
      thinking.remove();
      stream.append(h('div', { class: 'notice err', html: `<b>本轮失败：</b>${err.message}` }));
    } finally {
      state.busy = false;
      btnSend.disabled = false;
      input.focus();
    }
  }

  function finish() {
    const myTurns = state.history.filter((t) => t.role === 'me');
    if (!myTurns.length) {
      stream.append(h('div', { class: 'notice', html: '<b>还没有提交回应。</b>至少写下一条回应，系统才有内容可体检。' }));
      return;
    }
    state.finished = true;
    onFinish({
      myStance: stanceById(state.myId),
      opponentStance: stanceById(state.oppId),
      history: state.history,
    });
  }

  return {
    begin(myStanceId) {
      const idx = analysis.stances.findIndex((s) => s.id === myStanceId);
      state.myId = analysis.stances[idx].id;
      state.oppId = analysis.stances[(idx + 1) % analysis.stances.length].id;
      start();
    },
    /** 「替这一方辩」：用户扮演该阵营，AI 自动站到最强的对立面 */
    beginAs(sideId) {
      const idx = analysis.stances.findIndex((s) => s.id === sideId);
      state.oppId = analysis.stances[idx].id;
      const others = analysis.stances.filter((s) => s.id !== sideId).sort((a, b) => b.support - a.support);
      state.myId = (others[0] || analysis.stances[0]).id;
      start();
    },
  };
}
