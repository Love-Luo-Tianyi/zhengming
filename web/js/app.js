/**
 * 争鸣 · 应用入口
 *
 * 一条主链路贯穿三个视图：
 *   首页输入争议 → 战局（拆成立场阵营）→ 对练（入座、被裁判）→ 体检报告（带走）
 */

import {
  loadSettings, saveSettings, resetSettings, detectBackend, modeLabel, settings, runtime,
} from './config.js';
import { fetchAnswers, loadTopic, clearCache, ZhihuError } from './providers.js';
import { clusterStances, buildReport } from './pipeline.js';
import { llmAvailable } from './llm.js';
import { h, mount, loading, notice } from './dom.js';
import { renderHome } from './views/home.js';
import { renderArena } from './views/arena.js';
import { createDebateView } from './views/debate.js';
import { renderReport } from './views/report.js';

const app = { analysis: null, report: null, topicId: null };
let debateView = null;
const SESSION_KEY = 'zhengming.session.v1';
let routeBusy = false;

const views = {
  home: document.getElementById('viewHome'),
  arena: document.getElementById('viewArena'),
  debate: document.getElementById('viewDebate'),
  report: document.getElementById('viewReport'),
};

/* ------------------------------------------------------------------ 启动 */

(async function boot() {
  loadSettings();
  syncSettingsForm();
  renderHomeView();
  bindUi();
  await route();
  window.addEventListener('hashchange', route);

  await detectBackend();
  refreshModePill();
})();

/* --------------------------------------------------------------- 视图切换 */

function show(name) {
  for (const [k, el] of Object.entries(views)) el.classList.toggle('hidden', k !== name);
  window.scrollTo(0, 0);
}

async function route() {
  if (routeBusy) return;
  routeBusy = true;
  try {
    const hash = location.hash.replace(/^#\/?/, '');
    const wantsArena = hash === 'arena' || hash.startsWith('arena/');
    const wantsDebate = hash === 'debate' || hash.startsWith('debate/');
    const wantsReport = hash === 'report' || hash.startsWith('report/');

    // A GitHub Pages reload has no in-memory state. Restore the last offline
    // snapshot when possible; live analyses intentionally fall back home.
    // Deep links may carry a snapshot id (e.g. #/arena/ai-programmer). Prefer
    // that explicit id over the last local session so shared links open the
    // same question for another person.
    const deepTopicId = wantsArena
      ? decodeURIComponent((hash.match(/^arena\/([^/?#]+)/) || [])[1] || '')
      : '';
    if ((wantsArena || wantsDebate || wantsReport) && (!app.analysis || (deepTopicId && app.topicId !== deepTopicId))) {
      const saved = readSession();
      const restoreId = deepTopicId || saved?.topicId;
      if (restoreId) {
        await openSnapshot(restoreId, { navigate: false });
      }
    }

    if (wantsArena && app.analysis) return show('arena');
    if (wantsDebate && app.analysis && debateView) return show('debate');
    if (wantsReport && app.report) return show('report');

    if (wantsDebate || wantsReport) {
      // A debate/report transcript is ephemeral and cannot be reconstructed
      // safely after reload; keep the user on the restored arena instead.
      if (app.analysis) {
        show('arena');
        document.getElementById('arenaMeta').append(notice(
          '对练记录只保存在当前页面，刷新后无法恢复。已回到该话题的分歧地图，请重新入座。', ''));
        if (location.hash !== '#/arena') history.replaceState(null, '', '#/arena');
      } else {
        renderHomeView();
        show('home');
        if (location.hash) history.replaceState(null, '', '#/');
      }
      return;
    }

    if (!hash || hash === '/') { renderHomeView(); show('home'); return; }
    // Unknown or stale hashes should never leave a blank page.
    renderHomeView();
    show('home');
    if (location.hash) history.replaceState(null, '', '#/');
  } finally {
    routeBusy = false;
  }
}

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function refreshModePill() {
  const m = modeLabel();
  const pill = document.getElementById('modePill');
  document.getElementById('modeText').textContent = m.text;
  pill.classList.toggle('live', m.data === 'live');
  pill.classList.toggle('offline', m.data === 'demo' && m.llm === 'offline');
  pill.title = m.data === 'live'
    ? '当前请求会使用知乎开放平台实时数据（需自行配置凭据）'
    : '当前使用内置的知乎公开问答离线快照；不会请求实时知乎 API。要切换实时模式，请点右上角「设置」。';

  document.getElementById('footerMode').textContent =
    `当前运行姿态：${m.text}`
    + (m.backendReady ? ' · 后端已连接' : ' · 未连接后端')
    + (m.llm === 'offline' ? '（未配置模型时使用可解释的本地裁判规则引擎）' : '');
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function saveSession() {
  try {
    if (app.topicId) localStorage.setItem(SESSION_KEY, JSON.stringify({ topicId: app.topicId, at: Date.now() }));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* 隐私模式或配额不足时不阻断主流程 */ }
}

/* --------------------------------------------------------------- 首页 */

function renderHomeView() {
  renderHome(views.home, {
    onPick: (id) => openSnapshot(id),
    onAnalyze: (q) => analyze(q),
    onFreeform: () => {
      setDataMode('live');
      openSettings();
    },
  });
}

/* ------------------------------------------------------- 主链路：拆解争议 */

async function analyze(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) return;

  show('arena');
  document.getElementById('arenaTitle').textContent = query;
  mount(document.getElementById('arenaMeta'));
  mount(document.getElementById('arenaDivergence'));
  document.getElementById('arenaKeyline').innerHTML = '';

  const grid = document.getElementById('stanceGrid');
  const steps = [
    stepRow('检索该话题下的回答与权威等级'),
    stepRow('按权威度 × 赞同数加权，识别立场阵营'),
    stepRow('生成每一方的最强论证并挂回原文出处'),
  ];
  mount(grid, loading('正在检索…'), h('div', { class: 'steps' }, steps.map((s) => s.el)));

  try {
    steps[0].set('active');
    const { answers, origin, snapshot, fallbackReason } = await fetchAnswers(query, { limit: 10 });
    steps[0].set('done');

    if (answers.length < 4) {
      throw new Error(`这个话题只检索到 ${answers.length} 条回答，样本太少无法拆分阵营。换个说法，或从样本库里挑一个。`);
    }

    steps[1].set('active');
    const analysis = await clusterStances({
      query: snapshot?.title || query,
      answers,
      precomputed: snapshot?.analysis,
    });
    steps[1].set('done');
    steps[2].set('done');

    if (analysis.stances.length < 2) {
      throw new Error('这个话题的立场没有被拆成两个以上阵营。可能争议度不足，换一个话题试试。');
    }

    analysis.origin = origin;
    analysis.fallbackReason = fallbackReason;
    app.analysis = analysis;
    app.topicId = snapshot?.id || null;
    saveSession();

    await new Promise((r) => setTimeout(r, 240));
    renderArena(views.arena, {
      analysis,
      onEnterDebate: (sid) => enterDebate(sid, false),
      onEnterAsOpponent: (sid) => enterDebate(sid, true),
    });
    go(app.topicId ? `#/arena/${encodeURIComponent(app.topicId)}` : '#/arena');
  } catch (err) {
    const msg = err instanceof ZhihuError
      ? `${err.message}<br />可以切回离线快照，或从样本库里挑一个话题。`
      : err.code === 'NOT_IN_LIBRARY'
        ? `样本库里没有「${query}」这个话题。<br />两个办法：① 从样本库里挑一个；② 在右上角「设置」里填入知乎开放平台 Access Secret，就能拆解任意话题。`
        : err.message;
    mount(grid, notice(msg, 'err'));
  }
}

function stepRow(text) {
  const tick = h('span', { class: 'tick' });
  const el = h('div', { class: 'step' }, tick, h('span', { text }));
  return {
    el,
    set(state) {
      el.classList.remove('active', 'done');
      if (state) el.classList.add(state);
      tick.textContent = state === 'done' ? '✓' : '';
    },
  };
}

async function openSnapshot(id, { navigate = true } = {}) {
  show('arena');
  document.getElementById('arenaTitle').textContent = '载入中…';
  mount(document.getElementById('arenaMeta'));
  mount(document.getElementById('arenaDivergence'));
  document.getElementById('arenaKeyline').innerHTML = '';
  mount(document.getElementById('stanceGrid'), loading('正在载入快照…'));

  try {
    const topic = await loadTopic(id);
    const analysis = await clusterStances({
      query: topic.title,
      answers: topic.answers,
      precomputed: topic.analysis,
    });
    analysis.origin = 'snapshot';
    app.analysis = analysis;
    app.topicId = id;
    app.report = null;
    saveSession();

    renderArena(views.arena, {
      analysis,
      onEnterDebate: (sid) => enterDebate(sid, false),
      onEnterAsOpponent: (sid) => enterDebate(sid, true),
    });
    if (navigate) go(`#/arena/${encodeURIComponent(id)}`);
  } catch (err) {
    mount(document.getElementById('stanceGrid'), notice(`快照载入失败：${err.message}`, 'err'));
  }
}

/* ------------------------------------------------------------- 进入对练 */

function enterDebate(stanceId, asOpponent) {
  if (!app.analysis) return;
  show('debate');

  debateView = createDebateView(views.debate, {
    analysis: app.analysis,
    onExit: () => go('#/arena'),
    onFinish: async ({ myStance, opponentStance, history }) => {
      show('report');
      mount(document.getElementById('authorList'), loading('正在生成报告…'));
      const report = await buildReport({
        query: app.analysis.query,
        myStance,
        stances: app.analysis.stances,
        history,
      });
      report.myStance = myStance;
      report.opponentStance = opponentStance;
      app.report = report;

      renderReport(views.report, {
        report,
        analysis: app.analysis,
        topicId: app.topicId,
        onRestart: () => {
          app.report = null;
          if (app.analysis) enterDebate(myStance.id, false);
          else go('#/');
        },
      });
      go('#/report');
    },
  });

  if (asOpponent) debateView.beginAs(stanceId);
  else debateView.begin(stanceId);
  go('#/debate');
}

/* ------------------------------------------------------------------ 设置 */

function openSettings() {
  document.getElementById('settingsMask').classList.remove('hidden');
  syncSettingsForm();
}
function closeSettings() {
  document.getElementById('settingsMask').classList.add('hidden');
}

function syncSettingsForm() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('inputSecret', settings.secret);
  set('inputBaseUrl', settings.baseUrl);
  set('inputApiKey', settings.apiKey);
  set('inputModel', settings.model);
  set('inputBackend', settings.backendUrl);

  document.querySelectorAll('#segData button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.dataMode));
  document.querySelectorAll('#segLlm button').forEach((b) => b.classList.toggle('on', b.dataset.v === settings.llmMode));
  document.getElementById('byokFields').classList.toggle('hidden', settings.llmMode !== 'byok');

  const usingBackendZhihu = !!(runtime.backend && runtime.backend.zhihu);
  document.getElementById('fieldSecret').classList.toggle('hidden', settings.dataMode !== 'live' || usingBackendZhihu);
}

function setDataMode(mode) {
  saveSettings({ dataMode: mode });
  syncSettingsForm();
  refreshModePill();
}

function bindUi() {
  const topSearchInput = document.getElementById('topSearchInput');
  const topSearchBtn = document.getElementById('topSearchBtn');
  const runTopSearch = () => {
    const q = topSearchInput?.value.trim();
    if (!q) { topSearchInput?.focus(); return; }
    const topicInput = document.getElementById('topicInput');
    if (topicInput) topicInput.value = q;
    analyze(q);
  };
  topSearchBtn?.addEventListener('click', runTopSearch);
  topSearchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runTopSearch(); });

  document.getElementById('btnSettings').addEventListener('click', openSettings);
  document.getElementById('btnCloseSettings').addEventListener('click', closeSettings);
  document.getElementById('settingsMask').addEventListener('click', (e) => {
    if (e.target.id === 'settingsMask') closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });

  document.querySelectorAll('#segData button').forEach((b) => {
    b.addEventListener('click', () => { saveSettings({ dataMode: b.dataset.v }); syncSettingsForm(); refreshModePill(); });
  });
  document.querySelectorAll('#segLlm button').forEach((b) => {
    b.addEventListener('click', () => { saveSettings({ llmMode: b.dataset.v }); syncSettingsForm(); });
  });

  document.getElementById('btnSaveSettings').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '保存中…';
    saveSettings({
      secret: document.getElementById('inputSecret').value.trim(),
      baseUrl: document.getElementById('inputBaseUrl').value.trim(),
      apiKey: document.getElementById('inputApiKey').value.trim(),
      model: document.getElementById('inputModel').value.trim(),
      backendUrl: document.getElementById('inputBackend').value.trim(),
    });
    clearCache();
    await detectBackend();
    if (llmAvailable() && settings.llmMode === 'offline') {
      // 用户没显式选过模型来源，但现在有可用模型了，自动升级一次
      saveSettings({ llmMode: 'backend' });
    }
    refreshModePill();
    syncSettingsForm();
    closeSettings();
    renderHomeView();
    if (location.hash && location.hash !== '#/') go('#/');
    btn.disabled = false;
    btn.textContent = '保存并重新检测';
  });

  document.getElementById('btnResetSettings').addEventListener('click', async () => {
    resetSettings();
    clearCache();
    await detectBackend();
    syncSettingsForm();
    refreshModePill();
    renderHomeView();
  });
}
