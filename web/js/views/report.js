/**
 * 观点体检报告：把一次回应变成可带走、可复核、可分享的立场卡。
 *
 * 产品判断：体检的价值不在"你赢了"，而在"你知道哪条成立条件与证据还没补齐"。
 * 所以报告的重心是四维画像 + 你可能低估的那一方，而不是分数本身。
 */

import { h, mount, clear, votes, authorityBadge, sourceLink, download, copyText, polar } from '../dom.js?v=20260912';
import { JUDGE_DIMS, posterLine } from '../pipeline.js?v=20260912';

export function renderReport(container, { report, analysis, topicId, onRestart }) {
  const { myStance, opponentStance } = report;

  container.querySelector('#reportTitle').textContent = '观点体检报告';
  container.querySelector('#reportSub').innerHTML =
    `话题「${escapeHtml(analysis.query)}」· 你站在 <b style="color:${myStance.color}">${escapeHtml(myStance.name)}</b> 一侧，` +
    `回应 <b style="color:${opponentStance.color}">${escapeHtml(opponentStance.name)}</b> 的观点 ${report.turns} 次`;

  drawRadar(container.querySelector('#radar'), report);
  container.querySelector('#radarNote').textContent =
    '四维各 0–5 分，由裁判对每一轮发言独立评分后取均值';

  mount(container.querySelector('#reportStats'),
    stat('回合数', report.turns, ''),
    stat('四维总分', report.total.toFixed(1), `/ ${report.maxTotal}`),
    stat('引用来源', report.citations, '处'),
    stat('对手阵营加权支持', `${Math.round(opponentStance.support * 100)}%`, ''));

  mount(container.querySelector('#reportInsights'),
    h('div', { class: 'insight', style: { borderLeftColor: 'var(--side-a)', background: 'rgba(47,139,255,0.07)', marginBottom: '12px' } },
      h('div', { style: { fontSize: '14px', lineHeight: '1.8' }, text: report.summary })),
    report.insights.map((i) => h('div', { class: 'insight' },
      h('h4', { text: i.title }),
      h('div', { text: i.body }))));

  // Make the community connection explicit without pretending we provide
  // private messaging or real-time author contact.
  const insightHost = container.querySelector('#reportInsights');
  insightHost.append(h('div', { class: 'notice', style: { marginTop: '12px' } },
    h('b', { text: '把分歧带回社区：' }),
    h('span', { text: '邀请一位持不同观点的朋友打开同一张分歧地图，或沿原文链接继续阅读。争鸣不代替知乎私信，也不模拟真实答主。' })));

  const shareNote = h('div', { class: 'notice', style: { marginTop: '12px' } },
    h('b', { text: '下一步连接：' }),
    '把这张立场卡发给一位观点不同的朋友，请他从同一张分歧地图重新写一份回应。');
  container.querySelector('#reportInsights').append(shareNote);

  const authors = container.querySelector('#authorList');
  if (report.authors.length) {
    mount(authors, report.authors.map((a) => h('div', { class: 'author' },
      h('div', { class: 'author-grow' },
        h('div', { class: 'author-name' },
          a.author,
          a.stanceName
            ? h('span', {
              class: 'badge',
              style: { marginLeft: '8px', color: a.stanceColor, borderColor: a.stanceColor },
              text: a.stanceName,
            })
            : null),
        h('div', { class: 'author-headline', text: a.title })),
      authorityBadge(a.authorityLevel),
      h('span', { class: 'tiny num muted', text: `赞同 ${votes(a.voteUp)}` }),
      sourceLink(a))));
  } else {
    mount(authors, h('div', { class: 'tiny muted', text: '本场没有检索到与你立场不同的独立作者。' }));
  }

  drawPoster(container.querySelector('#poster'), { report, analysis, myStance });

  container.querySelector('#btnDownloadPoster').onclick = () => {
    const canvas = container.querySelector('#poster');
    canvas.toBlob((blob) => {
      if (blob) download(`争鸣-${analysis.query.slice(0, 12)}.png`, blob);
    }, 'image/png');
  };

  container.querySelector('#btnCopySummary').onclick = async (e) => {
    const text = [
      `我在「争鸣」完成了一次观点体检：${analysis.query}`,
      `我选择「${myStance.name}」，回应「${opponentStance.name}」。`,
      posterLine(report, myStance),
      report.summary,
    ].join('\n');
    const ok = await copyText(text);
    e.target.textContent = ok ? '已复制 ✓' : '复制失败';
    setTimeout(() => { e.target.textContent = '复制结论文本'; }, 1800);
  };

  const shareBtn = container.querySelector('#btnShareReview');
  if (shareBtn) shareBtn.onclick = async (e) => {
    // Share a reproducible snapshot link, not ephemeral debate text or PII.
    const base = `${location.origin}${location.pathname}`;
    const url = `${base}#/arena/${encodeURIComponent(topicId || '')}`;
    const text = `来看看我在「争鸣」体检的观点：${analysis.query}\n打开分歧地图，选一个不同立场一起复核：${url}`;
    let ok = false;
    try {
      if (navigator.share) { await navigator.share({ title: '争鸣 · 问题分歧地图', text, url }); ok = true; }
      else if (navigator.clipboard) { await navigator.clipboard.writeText(text); ok = true; }
    } catch { /* 用户取消分享 */ }
    e.target.textContent = ok ? '已复制分享链接 ✓' : '分享失败';
    setTimeout(() => { e.target.textContent = '邀请朋友复核 ↗'; }, 1800);
  };

  container.querySelector('#btnRestart').onclick = onRestart;
}

function stat(label, value, unit) {
  return h('div', { class: 'stat' },
    h('div', { class: 'stat-label', text: label }),
    h('div', { class: 'stat-value' }, String(value), unit ? h('small', { text: ` ${unit}` }) : null));
}

/* ------------------------------------------------------------------ 雷达图 */

function drawRadar(holder, report) {
  clear(holder);
  const size = 300;
  const cx = size / 2;
  const cy = size / 2;
  const R = 100;
  const n = report.dims.length;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  const el = (tag, attrs) => {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  };

  // 网格
  for (let r = 1; r <= 5; r++) {
    const pts = report.dims.map((_, i) => polar(cx, cy, (R * r) / 5, (360 / n) * i).join(',')).join(' ');
    svg.append(el('polygon', {
      points: pts, fill: 'none',
      stroke: r === 5 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.09)',
      'stroke-width': 1,
    }));
  }
  // 轴线
  for (let i = 0; i < n; i++) {
    const [x, y] = polar(cx, cy, R, (360 / n) * i);
    svg.append(el('line', { x1: cx, y1: cy, x2: x, y2: y, stroke: 'rgba(255,255,255,0.09)', 'stroke-width': 1 }));
  }

  // 数据面
  const dataPts = report.dims.map((d, i) => polar(cx, cy, (R * d.value) / 5, (360 / n) * i).join(',')).join(' ');
  svg.append(el('polygon', {
    points: dataPts, fill: 'rgba(47,139,255,0.24)', stroke: '#4d9dff', 'stroke-width': 2,
    'stroke-linejoin': 'round',
  }));
  // 顶点
  report.dims.forEach((d, i) => {
    const [x, y] = polar(cx, cy, (R * d.value) / 5, (360 / n) * i);
    svg.append(el('circle', { cx: x, cy: y, r: 4, fill: '#4d9dff', stroke: '#070910', 'stroke-width': 2 }));
  });

  // 标签
  report.dims.forEach((d, i) => {
    const [x, y] = polar(cx, cy, R + 30, (360 / n) * i);
    const t = el('text', {
      x, y, fill: '#c3cbd9', 'font-size': 13, 'font-family': 'PingFang SC, Microsoft YaHei, sans-serif',
      'text-anchor': 'middle', 'dominant-baseline': 'middle',
    });
    t.textContent = `${d.label} ${d.value.toFixed(1)}`;
    svg.append(t);
  });

  holder.append(svg);
}

/* -------------------------------------------------------------------- 海报 */

function drawPoster(canvas, { report, analysis, myStance }) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');

  const font = (size, weight = '400') =>
    `${weight} ${size}px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif`;

  // 背景
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#080b13');
  bg.addColorStop(0.5, '#0c1019');
  bg.addColorStop(1, '#070910');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glowA = ctx.createRadialGradient(150, 120, 0, 150, 120, 520);
  glowA.addColorStop(0, 'rgba(47,139,255,0.28)');
  glowA.addColorStop(1, 'rgba(47,139,255,0)');
  ctx.fillStyle = glowA;
  ctx.fillRect(0, 0, W, H);

  const glowB = ctx.createRadialGradient(W - 120, 260, 0, W - 120, 260, 480);
  glowB.addColorStop(0, 'rgba(255,166,61,0.2)');
  glowB.addColorStop(1, 'rgba(255,166,61,0)');
  ctx.fillStyle = glowB;
  ctx.fillRect(0, 0, W, H);

  // 外框
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 2;
  roundRect(ctx, 40, 40, W - 80, H - 80, 26);
  ctx.stroke();

  let y = 108;

  // 品牌
  ctx.fillStyle = '#f2f5fa';
  ctx.font = font(46, '800');
  ctx.fillText('争鸣', 78, y);
  const wBrand = ctx.measureText('争鸣').width;
  ctx.fillStyle = '#8b95a7';
  ctx.font = font(19);
  ctx.fillText('让分歧站到你面前', 78 + wBrand + 18, y - 4);

  y += 58;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  ctx.fillRect(78, y, W - 156, 1);

  // 话题
  y += 62;
  ctx.fillStyle = '#5f6878';
  ctx.font = font(19);
  ctx.fillText('争议话题', 78, y);

  y += 46;
  ctx.fillStyle = '#f2f5fa';
  ctx.font = font(38, '700');
  y = wrapText(ctx, analysis.query, 78, y, W - 156, 50);

  // 对决双方
  y += 34;
  const boxW = (W - 156 - 24) / 2;

  drawSideBox(ctx, 78, y, boxW, 150, myStance, '你站这一方');
  drawSideBox(ctx, 78 + boxW + 24, y, boxW, 150, report.opponentStance, '对手阵营');

  y += 196;

  // 四维条形
  ctx.fillStyle = '#5f6878';
  ctx.font = font(19);
  ctx.fillText('论证质量四维', 78, y);
  y += 34;

  const barW = W - 156 - 210;
  for (const d of report.dims) {
    ctx.fillStyle = '#c3cbd9';
    ctx.font = font(21);
    ctx.fillText(d.label, 78, y + 17);

    ctx.fillStyle = 'rgba(255,255,255,0.09)';
    roundRect(ctx, 168, y + 2, barW, 16, 8);
    ctx.fill();

    const g = ctx.createLinearGradient(168, 0, 168 + barW, 0);
    g.addColorStop(0, '#1479ff');
    g.addColorStop(1, '#5fb0ff');
    ctx.fillStyle = g;
    roundRect(ctx, 168, y + 2, Math.max(10, (barW * d.value) / 5), 16, 8);
    ctx.fill();

    ctx.fillStyle = '#f2f5fa';
    ctx.font = font(22, '700');
    ctx.fillText(d.value.toFixed(1), 168 + barW + 20, y + 18);

    y += 44;
  }

  y += 8;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  ctx.moveTo(78, y);
  ctx.lineTo(W - 78, y);
  ctx.stroke();
  y += 46;

  // 总分
  ctx.fillStyle = '#5f6878';
  ctx.font = font(19);
  ctx.fillText('四维总分', 78, y);
  ctx.fillStyle = '#f2f5fa';
  ctx.font = font(60, '800');
  ctx.fillText(report.total.toFixed(1), 78, y + 62);
  const wTotal = ctx.measureText(report.total.toFixed(1)).width;
  ctx.fillStyle = '#5f6878';
  ctx.font = font(22);
  ctx.fillText(`/ ${report.maxTotal}`, 78 + wTotal + 12, y + 62);

  // 结论：优先在句末断开，避免出现半句话
  ctx.fillStyle = '#c3cbd9';
  ctx.font = font(21);
  const concl = smartTrim(String(report.summary || ''), 108);
  wrapText(ctx, concl, 78, y + 118, W - 156, 34, 3);

  // 页脚
  ctx.fillStyle = '#5f6878';
  ctx.font = font(17);
  ctx.fillText('知乎黑客松 2026 · 校园新锐季 · 灵魂匹配局', 78, H - 96);
  ctx.fillText('zhihu-hackathon · 观点陪练 / 破茧工具', 78, H - 68);
  ctx.fillStyle = 'rgba(47,139,255,0.9)';
  ctx.font = font(17, '600');
  ctx.fillText('争鸣', W - 78 - ctx.measureText('争鸣').width, H - 96);
}

function drawSideBox(ctx, x, y, w, h, stance, caption) {
  ctx.fillStyle = hexA(stance.color, 0.11);
  roundRect(ctx, x, y, w, h, 16);
  ctx.fill();
  ctx.strokeStyle = hexA(stance.color, 0.42);
  ctx.lineWidth = 2;
  roundRect(ctx, x, y, w, h, 16);
  ctx.stroke();

  ctx.fillStyle = '#5f6878';
  ctx.font = '400 17px "PingFang SC", system-ui, sans-serif';
  ctx.fillText(caption, x + 22, y + 34);

  ctx.fillStyle = stance.color;
  ctx.font = '700 30px "PingFang SC", system-ui, sans-serif';
  ctx.fillText(cut(stance.name, 7), x + 22, y + 76);

  ctx.fillStyle = '#c3cbd9';
  ctx.font = '400 19px "PingFang SC", system-ui, sans-serif';
  wrapText(ctx, stance.thesis, x + 22, y + 110, w - 44, 28, 2);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 99) {
  const chars = String(text).split('');
  const lines = [];
  let line = '';
  for (const ch of chars) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);

  const visible = lines.slice(0, maxLines);
  if (lines.length > maxLines && visible.length) {
    // 截断时补省略号，避免海报上出现半句话
    let last = visible[visible.length - 1];
    while (last && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    visible[visible.length - 1] = `${last}…`;
  }
  for (const l of visible) {
    ctx.fillText(l, x, y);
    y += lineHeight;
  }
  return y;
}

/** 按句末标点收尾，读起来是完整的一句 */
function smartTrim(text, limit) {
  const s = String(text).trim();
  if (s.length <= limit) return s;
  const head = s.slice(0, limit);
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('；'));
  if (cut >= limit * 0.5) return head.slice(0, cut + 1);
  return `${head}…`;
}

function cut(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function hexA(hex, a) {
  const c = String(hex).replace('#', '');
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
