/**
 * 配置与运行模式检测。
 *
 * 争鸣有三种运行姿态，按"能拿到什么"自动降级，保证任何环境下 Demo 都不会白屏：
 *   1. backend —— 部署了 server/，知乎密钥与模型密钥都在服务端（最理想）
 *   2. byok    —— 访客自带模型 Key，数据可从知乎开放平台实时拉（密钥只存本地）
 *   3. demo    —— 全部离线：内置真实知乎问答快照 + 本地裁判规则引擎（默认，永远可用）
 */

const STORAGE_KEY = 'zhengming.settings.v1';

const DEFAULTS = {
  dataMode: 'demo',      // demo | live
  secret: '',            // 知乎开放平台 Access Secret
  llmMode: 'offline',    // offline | byok | backend
  baseUrl: '',
  apiKey: '',
  model: '',
  backendUrl: '',
};

export const settings = { ...DEFAULTS };

/** 用户是否手动改过模型来源；没改过时让后端优先，避免部署好了却还在跑本地规则 */
let llmModeExplicit = false;

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.llmMode) llmModeExplicit = true;
      Object.assign(settings, parsed);
    }
  } catch { /* 隐私模式下 localStorage 可能不可用，忽略即可 */ }
  return settings;
}

export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  if ('llmMode' in patch) llmModeExplicit = true;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* 同上 */ }
  return settings;
}

export function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* 同上 */ }
  Object.assign(settings, DEFAULTS);
  llmModeExplicit = false;
  return settings;
}

/** 后端探活结果，由 detectBackend() 写入 */
export const runtime = {
  backend: null,      // { ok, zhihu, llm, model } | null
  backendChecked: false,
};

function normalizeBase(url) {
  return (url || '').trim().replace(/\/+$/, '');
}

/**
 * 后端地址。
 * 页面本身就是后端发的（同源）时，用空串走相对路径即可；
 * 静态托管（如 GitHub Pages）时，需要用户在设置里填一个后端地址。
 */
export function backendBase() {
  if (settings.backendUrl) return normalizeBase(settings.backendUrl);
  if (runtime.backend?.sameOrigin) return '';
  return '';
}

/** 探测后端：先试同源 /api/health，再试用户填写的地址 */
export async function detectBackend() {
  runtime.backendChecked = true;
  runtime.backend = null;

  const candidates = [];
  // 静态托管平台上同源探测会 404，成本很低，所以总是先试一次
  candidates.push({ base: '', sameOrigin: true });
  if (settings.backendUrl) candidates.push({ base: normalizeBase(settings.backendUrl), sameOrigin: false });

  for (const c of candidates) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(`${c.base}/api/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      if (data && data.name === '争鸣') {
        runtime.backend = { ...data, sameOrigin: c.sameOrigin };
        return runtime.backend;
      }
    } catch { /* 试下一个候选 */ }
  }
  return null;
}

/** 当前实际生效的数据源与模型来源 */
export function effectiveMode() {
  const backendReady = !!(runtime.backend && runtime.backend.ok);
  const backendHasLlm = backendReady && !!runtime.backend.llm;
  const backendHasZhihu = backendReady && !!runtime.backend.zhihu;

  // 数据：用户显式选了实时并给了 key，或后端已配好知乎密钥
  const canLiveZhihu = (settings.dataMode === 'live' && !!settings.secret) || backendHasZhihu;

  // 模型：显式选择优先；没显式选过时，后端可用就用后端，否则看自带 Key
  let llm = 'offline';
  if (settings.llmMode === 'byok' && settings.apiKey && settings.baseUrl) llm = 'byok';
  else if (settings.llmMode === 'backend' && backendHasLlm) llm = 'backend';
  else if (!llmModeExplicit && backendHasLlm) llm = 'backend';
  else if (!llmModeExplicit && settings.apiKey && settings.baseUrl) llm = 'byok';

  const data = canLiveZhihu ? 'live' : 'demo';
  return { data, llm, backendReady, backendHasLlm, backendHasZhihu };
}

export function modeLabel() {
  const m = effectiveMode();
  const dataText = m.data === 'live' ? '知乎实时数据' : '离线快照数据';
  const llmText = m.llm === 'backend' ? '后端模型' : m.llm === 'byok' ? '你的模型 Key' : '本地裁判';
  return { data: dataText, llm: llmText, text: `${dataText} · ${llmText}`, ...m };
}
