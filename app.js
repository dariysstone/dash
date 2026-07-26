/* ================= Utilities: date <-> day index ================= */
let DATA = null;
let BASE_DATE = null;
let MAX_DAY = 0, MIN_DAY = 0;
let RESOLVED_STATUS_IDX = new Set();
const RESOLVED_STATUS_LABELS = new Set(['Закрыта', 'Готово', 'Оценка обратной связи']);

function dayToISO(day) {
  const d = new Date(BASE_DATE.getTime() + day * 86400000);
  return d.toISOString().slice(0, 10);
}
function isoToDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return Math.round((d.getTime() - BASE_DATE.getTime()) / 86400000);
}
function fmtDateRu(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/* Status collapsed into two buckets: "Решено" = Закрыта / Готово / Оценка обратной связи, everything else = "В работе" */
function statusBlockHtml(idxArr) {
  const total = idxArr.length;
  if (!total) return `<div class="empty-note">Нет данных за выбранный период</div>`;
  let resolved = 0;
  for (const i of idxArr) if (RESOLVED_STATUS_IDX.has(DATA.cols.status[i])) resolved++;
  const inWork = total - resolved;
  const rows = [{ label: 'Решено', count: resolved }, { label: 'В работе', count: inWork }];
  const maxCount = Math.max(resolved, inWork, 1);
  return `<div class="toplist">` + rows.map(o => {
    const pct = Math.round((o.count / total) * 1000) / 10;
    const barPct = Math.round((o.count / maxCount) * 100);
    return `<div class="toprow">
      <span class="name">${o.label}</span>
      <span class="bar"><i style="width:${barPct}%"></i></span>
      <span class="cnt">${o.count}</span>
      <span class="dyn" style="color:var(--text-soft);font-weight:600;font-family:var(--mono);">${pct}%</span>
    </div>`;
  }).join('') + `</div>`;
}

/* ================= Core aggregation (validated in Node) ================= */
function buildMask(filters) {
  const n = DATA.n;
  const idx = [];
  const c = DATA.cols;
  const dateArr = c.date, kuratorArr = c.kurator, podtemaArr = c.podtema, sintArr = c.sint,
        istochnikArr = c.istochnik, naprArr = c.napr, tipArr = c.tip, statusArr = c.status,
        naspunktArr = c.naspunkt, rayonArr = c.rayon, ukArr = c.uk, ispolnitelArr = c.ispolnitel, spamArr = c.spam;
  const { dateStart, dateEnd } = filters;
  for (let i = 0; i < n; i++) {
    const d = dateArr[i];
    if (d < dateStart || d > dateEnd) continue;
    if (filters.kurator && !filters.kurator.has(kuratorArr[i])) continue;
    if (filters.podtema && !filters.podtema.has(podtemaArr[i])) continue;
    if (filters.sint && !filters.sint.has(sintArr[i])) continue;
    if (filters.istochnik && !filters.istochnik.has(istochnikArr[i])) continue;
    if (filters.napr && !filters.napr.has(naprArr[i])) continue;
    if (filters.tip && !filters.tip.has(tipArr[i])) continue;
    if (filters.status && !filters.status.has(statusArr[i])) continue;
    if (filters.naspunkt && !filters.naspunkt.has(naspunktArr[i])) continue;
    if (filters.rayon && !filters.rayon.has(rayonArr[i])) continue;
    if (filters.uk && !filters.uk.has(ukArr[i])) continue;
    if (filters.ispolnitel && !filters.ispolnitel.has(ispolnitelArr[i])) continue;
    if (filters.spam && !filters.spam.has(spamArr[i])) continue;
    idx.push(i);
  }
  return idx;
}
function countBy(idxArr, colName, opts) {
  opts = opts || {};
  const col = DATA.cols[colName];
  const dict = DATA.dicts[colName];
  const counts = new Map();
  for (const i of idxArr) {
    const v = col[i];
    if (opts.excludeNull && v === -1) continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const arr = [...counts.entries()].map(([k, cnt]) => ({ key: k, label: k === -1 ? '(не указано)' : dict[k], count: cnt }));
  arr.sort((a, b) => b.count - a.count);
  return arr;
}
function topWithMode(idxArr, colName, colName2, topN, opts) {
  const top = countBy(idxArr, colName, opts).slice(0, topN);
  const col = DATA.cols[colName];
  const col2 = DATA.cols[colName2];
  const dict2 = DATA.dicts[colName2];
  for (const item of top) {
    const modeCounts = new Map();
    for (const i of idxArr) {
      if (col[i] !== item.key) continue;
      const v2 = col2[i];
      modeCounts.set(v2, (modeCounts.get(v2) || 0) + 1);
    }
    let bestK = null, bestC = -1;
    for (const [k, c] of modeCounts.entries()) { if (c > bestC) { bestC = c; bestK = k; } }
    item.modeLabel = (bestK === -1 || bestK === null) ? '—' : dict2[bestK];
    item.modeCount = bestC < 0 ? 0 : bestC;
  }
  return top;
}
function distinctCount(idxArr, colName, excludeNull) {
  const col = DATA.cols[colName];
  const s = new Set();
  for (const i of idxArr) { const v = col[i]; if (excludeNull && v === -1) continue; s.add(v); }
  return s.size;
}
function dynamics(mainCount, compCount) {
  if (compCount === 0 && mainCount === 0) return { pct: 0, delta: 0 };
  if (compCount === 0) return { pct: mainCount * 100, delta: mainCount };
  const delta = mainCount - compCount;
  return { pct: Math.round((delta / compCount) * 1000) / 10, delta };
}
function deltaHtml(dyn) {
  // Fewer обращения is a good outcome here, so color is inverted relative to the raw sign:
  // a decrease is shown in green, an increase in red.
  const cls = dyn.delta > 0 ? 'down' : (dyn.delta < 0 ? 'up' : 'flat');
  const arrow = dyn.delta > 0 ? '▲' : (dyn.delta < 0 ? '▼' : '→');
  const pctTxt = dyn.pct === null ? 'н/д' : `${dyn.pct > 0 ? '+' : ''}${dyn.pct}%`;
  const sign = dyn.delta > 0 ? '+' : '';
  return `<span class="delta ${cls}">${arrow} ${pctTxt} <span class="tag">${sign}${dyn.delta}</span></span>`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* ================= Filter dictionaries / options (auto-derived from data) ================= */
// Options are always built from whatever values exist in DATA.dicts — nothing is hardcoded,
// so re-generating this dashboard from a newer export automatically picks up renamed/added values.
function freqOptions(colName, idxForCount) {
  const dict = DATA.dicts[colName];
  const counts = new Array(dict.length).fill(0);
  const col = DATA.cols[colName];
  for (let i = 0; i < col.length; i++) { const v = col[i]; if (v >= 0) counts[v]++; }
  return dict.map((label, i) => ({ key: i, label, count: counts[i] })).sort((a, b) => b.count - a.count);
}

/* ================= MultiSelect component ================= */
class MultiSelect {
  constructor(container, { label, options, mode = 'multi', onChange, placeholder = 'Все' }) {
    this.options = options; // [{key,label,count}]
    this.selected = new Set();
    this.mode = mode;
    this.onChange = onChange || (() => {});
    this.placeholder = placeholder;
    this.el = document.createElement('div');
    this.el.className = 'ms';
    this.el.innerHTML = `
      ${label ? `<span class="ms-label">${label}</span>` : ''}
      <div class="ms-btn"><span class="ms-btn-text">${placeholder}</span></div>
      <div class="ms-panel hidden">
        <div class="ms-search"><input type="text" placeholder="Поиск..."></div>
        <div class="ms-actions"><span data-act="all">Выбрать все</span><span data-act="none">Сбросить</span></div>
        <div class="ms-list"></div>
      </div>`;
    container.appendChild(this.el);
    this.btn = this.el.querySelector('.ms-btn');
    this.btnText = this.el.querySelector('.ms-btn-text');
    this.panel = this.el.querySelector('.ms-panel');
    this.search = this.el.querySelector('.ms-search input');
    this.list = this.el.querySelector('.ms-list');
    this.actions = this.el.querySelector('.ms-actions');
    if (mode === 'single') this.actions.style.display = 'none';

    this.btn.addEventListener('click', (e) => { e.stopPropagation(); this._togglePanel(); });
    this.search.addEventListener('input', () => this._renderList());
    this.actions.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (act === 'all') this.options.forEach(o => this.selected.add(o.key));
      if (act === 'none') this.selected.clear();
      this._renderList(); this._updateLabel(); this.onChange(this.selected);
    });
    document.addEventListener('click', (e) => { if (!this.el.contains(e.target)) this._closePanel(); });
    this._renderList();
    this._updateLabel();
  }
  _togglePanel() {
    const isHidden = this.panel.classList.contains('hidden');
    document.querySelectorAll('.ms-panel').forEach(p => p.classList.add('hidden'));
    if (isHidden) { this.panel.classList.remove('hidden'); this.search.value = ''; this._renderList(); this.search.focus(); }
  }
  _closePanel() { this.panel.classList.add('hidden'); }
  _renderList() {
    const q = this.search.value.trim().toLowerCase();
    const filtered = q ? this.options.filter(o => o.label.toLowerCase().includes(q)) : this.options;
    if (!filtered.length) { this.list.innerHTML = `<div class="ms-empty">Ничего не найдено</div>`; return; }
    this.list.innerHTML = filtered.slice(0, 400).map(o => `
      <label class="ms-item" data-key="${o.key}">
        <input type="${this.mode === 'single' ? 'radio' : 'checkbox'}" ${this.selected.has(o.key) ? 'checked' : ''}>
        <span class="lbl" title="${escapeHtml(o.label)}">${escapeHtml(o.label)}</span>
        <span class="n">${o.count}</span>
      </label>`).join('');
    this.list.querySelectorAll('.ms-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const key = Number(item.dataset.key);
        if (this.mode === 'single') { this.selected.clear(); this.selected.add(key); this._closePanel(); }
        else { if (this.selected.has(key)) this.selected.delete(key); else this.selected.add(key); }
        this._renderList(); this._updateLabel(); this.onChange(this.selected);
      });
    });
  }
  _updateLabel() {
    if (this.selected.size === 0) { this.btnText.textContent = this.placeholder; this.btn.querySelector('.cnt')?.remove(); return; }
    const first = this.options.find(o => this.selected.has(o.key));
    const txt = this.mode === 'single' ? (first ? first.label : this.placeholder) : (this.selected.size === 1 ? first.label : `Выбрано`);
    this.btnText.textContent = txt.length > 26 ? txt.slice(0, 24) + '…' : txt;
    let cnt = this.btn.querySelector('.cnt');
    if (this.mode !== 'single' && this.selected.size > 0) {
      if (!cnt) { cnt = document.createElement('span'); cnt.className = 'cnt'; this.btn.appendChild(cnt); }
      cnt.textContent = this.selected.size;
    }
  }
  getSelected() { return this.selected.size ? this.selected : null; }
  setSelectedSingle(key) { this.selected.clear(); this.selected.add(key); this._renderList(); this._updateLabel(); }
}

/* ================= State & filter widgets ================= */
const state = {
  mainStart: null, mainEnd: null, compStart: null, compEnd: null,
  curatorTabPick: null,
};
const msWidgets = {};

function buildFilterWidgets() {
  const primaryDefs = [
    ['kurator', 'Куратор'], ['podtema', 'Подтема'], ['sint', 'Синт. группа'], ['istochnik', 'Источник'],
  ];
  const extraDefs = [
    ['napr', 'Направление'], ['tip', 'Тип сообщения'], ['status', 'Статус'],
    ['naspunkt', 'Населённый пункт'], ['rayon', 'Район'], ['uk', 'Управляющая компания'],
    ['ispolnitel', 'Исполнитель'], ['spam', 'Спам'],
  ];
  const primaryRow = document.getElementById('primaryFilters');
  const extraRow = document.getElementById('extraFilters');
  primaryDefs.forEach(([col, label]) => {
    msWidgets[col] = new MultiSelect(primaryRow, { label, options: freqOptions(col), placeholder: 'Все' });
  });
  extraDefs.forEach(([col, label]) => {
    msWidgets[col] = new MultiSelect(extraRow, { label, options: freqOptions(col), placeholder: 'Все' });
  });
}

function readFilters(excludeKurator) {
  const f = {};
  for (const key of ['kurator', 'podtema', 'sint', 'istochnik', 'napr', 'tip', 'status', 'naspunkt', 'rayon', 'uk', 'ispolnitel', 'spam']) {
    if (excludeKurator && key === 'kurator') continue;
    f[key] = msWidgets[key].getSelected();
  }
  return f;
}

/* ================= Rendering helpers ================= */
const BLOCK_DATA = {}; // blockId -> {colName, idxArr} used by expandable rows to compute subtopic breakdowns on click

function topBlockHtml(mainIdx, compIdx, colName, topN, opts) {
  opts = opts || {};
  const mainTop = countBy(mainIdx, colName, opts).slice(0, topN);
  if (!mainTop.length) return `<div class="empty-note">Нет данных за выбранный период</div>`;
  const compCounts = new Map(countBy(compIdx, colName, opts).map(o => [o.key, o.count]));
  const maxCount = mainTop[0].count;

  if (opts.modeCol) {
    const col = DATA.cols[colName];
    const col2 = DATA.cols[opts.modeCol];
    const dict2 = DATA.dicts[opts.modeCol];
    for (const item of mainTop) {
      const modeCounts = new Map();
      for (const i of mainIdx) {
        if (col[i] !== item.key) continue;
        const v2 = col2[i];
        modeCounts.set(v2, (modeCounts.get(v2) || 0) + 1);
      }
      let bestK = null, bestC = -1;
      for (const [k, c] of modeCounts.entries()) { if (c > bestC) { bestC = c; bestK = k; } }
      item.modeLabel = (bestK === -1 || bestK === null) ? '—' : dict2[bestK];
    }
  }

  if (opts.expandCol && opts.blockId) BLOCK_DATA[opts.blockId] = { colName, idxArr: opts.expandIdx || mainIdx };

  return `<div class="toplist">` + mainTop.map(o => {
    const dyn = dynamics(o.count, compCounts.get(o.key) || 0);
    const pct = Math.round((o.count / maxCount) * 100);
    const sub = opts.modeCol ? `<span class="sub">${escapeHtml(opts.modeLabel || '')}: ${escapeHtml(o.modeLabel)}</span>` : '';
    const expandAttrs = opts.expandCol ? ` data-block="${opts.blockId}" data-key="${o.key}"` : '';
    const expandCls = opts.expandCol ? ' expandable' : '';
    const chevron = opts.expandCol ? `<span class="chev">▸</span>` : '';
    return `<div class="toprow${expandCls}"${expandAttrs}>
      ${chevron}<span class="name" title="${escapeHtml(o.label)}">${escapeHtml(o.label)}${sub}</span>
      <span class="bar"><i style="width:${pct}%"></i></span>
      <span class="cnt">${o.count}</span>
      <span class="dyn">${deltaHtml(dyn)}</span>
    </div>`;
  }).join('') + `</div>`;
}

/* Click-to-expand: a requester row shows the breakdown of subtopics (or other column) it complained about */
function attachExpandHandler(containerId) {
  const container = document.getElementById(containerId);
  container.addEventListener('click', (e) => {
    const row = e.target.closest('.toprow.expandable');
    if (!row || !container.contains(row)) return;
    const next = row.nextElementSibling;
    if (next && next.classList.contains('expand-panel')) { next.remove(); row.classList.remove('open'); return; }
    container.querySelectorAll('.expand-panel').forEach(p => p.remove());
    container.querySelectorAll('.toprow.expandable.open').forEach(r => r.classList.remove('open'));
    const blockId = row.dataset.block;
    const key = Number(row.dataset.key);
    const info = BLOCK_DATA[blockId];
    if (!info) return;
    const col = DATA.cols[info.colName];
    const subIdx = info.idxArr.filter(i => col[i] === key);
    const breakdown = countBy(subIdx, 'podtema').slice(0, 8);
    const maxC = breakdown.length ? breakdown[0].count : 1;
    const panelHtml = `<div class="expand-panel">` + breakdown.map(b => `
      <div class="exp-row">
        <span class="exp-name" title="${escapeHtml(b.label)}">${escapeHtml(b.label)}</span>
        <span class="exp-bar"><i style="width:${Math.round(b.count / maxC * 100)}%"></i></span>
        <span class="exp-cnt">${b.count}</span>
      </div>`).join('') + `</div>`;
    row.classList.add('open');
    row.insertAdjacentHTML('afterend', panelHtml);
  });
}

function kpiCard(elId, label, val, dyn, accent) {
  const el = document.getElementById(elId);
  el.style.setProperty('--accent', accent);
  el.innerHTML = `<span class="ic">${label}</span><div class="val">${val}</div><div>${deltaHtml(dyn)}</div>`;
}

/* ---- trend chart (hand-rolled SVG, no external dependency) ---- */
function svgTrendChart(mount, mainDaily, compDaily, labels, compLabels) {
  const W = 1000, H = 230, padL = 34, padR = 12, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = labels.length;
  const allVals = mainDaily.concat(compDaily.filter(v => v !== null && v !== undefined));
  let maxV = allVals.length ? Math.max(...allVals) : 0;
  if (maxV <= 0) maxV = 1;
  maxV = Math.ceil(maxV * 1.15);
  const x = i => n <= 1 ? padL : padL + (i / (n - 1)) * plotW;
  const y = v => padT + plotH - (v / maxV) * plotH;

  const mainPts = mainDaily.map((v, i) => [x(i), y(v)]);
  const mainLine = mainPts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  const areaPath = mainLine + ` L${x(n - 1).toFixed(1)},${(padT + plotH).toFixed(1)} L${x(0).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;

  // comparison: draw only contiguous runs of non-null values
  let compSegs = [], cur = [];
  compDaily.forEach((v, i) => {
    if (v === null || v === undefined) { if (cur.length > 1) compSegs.push(cur); cur = []; return; }
    cur.push([x(i), y(v)]);
  });
  if (cur.length > 1) compSegs.push(cur);
  const compPaths = compSegs.map(seg => seg.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '));

  // gridlines (4 rows) + y labels
  const gridN = 4;
  let gridSvg = '';
  for (let g = 0; g <= gridN; g++) {
    const v = Math.round(maxV * g / gridN);
    const gy = y(v);
    gridSvg += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="#1b2233" stroke-width="1"/>`;
    gridSvg += `<text x="${padL - 6}" y="${(gy + 3).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#6b7688" font-family="var(--mono)">${v}</text>`;
  }
  // x labels: show ALL of them when the period is short (<=14 points), otherwise thin out to ~7
  const step = n <= 14 ? 1 : Math.max(1, Math.ceil(n / 7));
  let xLabelsSvg = '';
  for (let i = 0; i < n; i += step) {
    xLabelsSvg += `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9.5" fill="#6b7688">${labels[i]}</text>`;
  }

  // invisible hit columns for hover/tooltip, one per data point
  const hitW = n > 1 ? plotW / (n - 1) : plotW;
  let hitRects = '';
  for (let i = 0; i < n; i++) {
    const cx = x(i);
    hitRects += `<rect data-i="${i}" x="${(cx - hitW / 2).toFixed(1)}" y="${padT}" width="${hitW.toFixed(1)}" height="${plotH.toFixed(1)}" fill="transparent"/>`;
  }

  mount.innerHTML = `<div style="position:relative;">
  <svg class="trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:230px;display:block;">
    <defs>
      <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#38bdf8" stop-opacity="0"/>
      </linearGradient>
    </defs>
    ${gridSvg}
    <path d="${areaPath}" fill="url(#areaGrad)" stroke="none"/>
    ${compPaths.map(p => `<path d="${p}" fill="none" stroke="#f5455c" stroke-width="1.5" stroke-dasharray="5,4"/>`).join('')}
    <path d="${mainLine}" fill="none" stroke="#38bdf8" stroke-width="2.2"/>
    ${mainPts.map(p => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2" fill="#38bdf8"/>`).join('')}
    <line class="hoverline" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" stroke="#8892a6" stroke-width="1" opacity="0" />
    ${xLabelsSvg}
    <g class="hit-layer">${hitRects}</g>
  </svg>
  <div class="chart-tooltip" style="display:none;"></div>
  </div>`;

  const hoverLine = mount.querySelector('.hoverline');
  const tooltip = mount.querySelector('.chart-tooltip');
  mount.querySelectorAll('.hit-layer rect').forEach(rect => {
    rect.addEventListener('mouseenter', () => {
      const i = Number(rect.dataset.i);
      const cx = x(i);
      hoverLine.setAttribute('x1', cx); hoverLine.setAttribute('x2', cx); hoverLine.setAttribute('opacity', '1');
      const compV = compDaily[i];
      const compLbl = (compLabels && compLabels[i]) ? compLabels[i] : null;
      tooltip.innerHTML = `<b>${labels[i]}</b>` +
        `<div><span class="dot" style="background:#38bdf8"></span>Основной: <b>${mainDaily[i]}</b></div>` +
        (compV !== null && compV !== undefined ? `<div><span class="dot" style="background:#f5455c"></span>Сравнение${compLbl ? ' (' + compLbl + ')' : ''}: <b>${compV}</b></div>` : '');
      tooltip.style.display = 'block';
      const pctLeft = (cx / W) * 100;
      tooltip.style.left = pctLeft > 70 ? 'auto' : `calc(${pctLeft}% + 8px)`;
      tooltip.style.right = pctLeft > 70 ? `calc(${100 - pctLeft}% + 8px)` : 'auto';
      const pctTop = (y(mainDaily[i]) / H) * 100;
      tooltip.style.top = `calc(${pctTop}% - 10px)`;
    });
    rect.addEventListener('mouseleave', () => { hoverLine.setAttribute('opacity', '0'); tooltip.style.display = 'none'; });
  });
}

function renderTrendChart(mountId, mainIdx, compIdx) {
  const mount = document.getElementById(mountId);
  const mainLen = state.mainEnd - state.mainStart + 1;
  const compLen = state.compEnd - state.compStart + 1;
  const mainDaily = new Array(mainLen).fill(0);
  for (const i of mainIdx) mainDaily[DATA.cols.date[i] - state.mainStart]++;
  const compDaily = new Array(compLen).fill(0);
  for (const i of compIdx) compDaily[DATA.cols.date[i] - state.compStart]++;
  const labels = [];
  for (let d = state.mainStart; d <= state.mainEnd; d++) labels.push(fmtDateRu(dayToISO(d)));
  const compAligned = labels.map((_, i) => (i < compDaily.length ? compDaily[i] : null));
  const compLabels = labels.map((_, i) => (i < compLen ? fmtDateRu(dayToISO(state.compStart + i)) : null));
  svgTrendChart(mount, mainDaily, compAligned, labels, compLabels);
}

/* ================= Overview tab ================= */
function renderOverview() {
  const filters = readFilters(false);
  const mainIdx = buildMask({ dateStart: state.mainStart, dateEnd: state.mainEnd, ...filters });
  const compIdx = buildMask({ dateStart: state.compStart, dateEnd: state.compEnd, ...filters });

  document.getElementById('ov-range').textContent =
    `${fmtDateRu(dayToISO(state.mainStart))} – ${fmtDateRu(dayToISO(state.mainEnd))} · сравнение с ${fmtDateRu(dayToISO(state.compStart))} – ${fmtDateRu(dayToISO(state.compEnd))}`;

  kpiCard('kpi-total', 'Всего обращений', mainIdx.length, dynamics(mainIdx.length, compIdx.length), '#4f8cff');
  kpiCard('kpi-podtem', 'Подтем', distinctCount(mainIdx, 'podtema'), dynamics(distinctCount(mainIdx, 'podtema'), distinctCount(compIdx, 'podtema')), '#38bdf8');
  kpiCard('kpi-kurator', 'Кураторов', distinctCount(mainIdx, 'kurator'), dynamics(distinctCount(mainIdx, 'kurator'), distinctCount(compIdx, 'kurator')), '#22c55e');
  const mainAddr = mainIdx.filter(i => DATA.cols.ulitsa[i] !== -1);
  const compAddr = compIdx.filter(i => DATA.cols.ulitsa[i] !== -1);
  kpiCard('kpi-addr', 'Адресов с улицей', distinctCount(mainAddr, 'addr'), dynamics(distinctCount(mainAddr, 'addr'), distinctCount(compAddr, 'addr')), '#f5b942');

  document.getElementById('ov-kuratory').innerHTML = topBlockHtml(mainIdx, compIdx, 'kurator', 10, { modeCol: 'podtema', modeLabel: 'Гл. подтема' });

  document.getElementById('ov-napr').innerHTML = topBlockHtml(mainIdx, compIdx, 'napr', 8);
  document.getElementById('ov-istochnik').innerHTML = topBlockHtml(mainIdx, compIdx, 'istochnik', 8);
  document.getElementById('ov-tip').innerHTML = topBlockHtml(mainIdx, compIdx, 'tip', 8);

  document.getElementById('ov-podtemy').innerHTML = topBlockHtml(mainIdx, compIdx, 'podtema', 10);
  document.getElementById('ov-fakty').innerHTML = topBlockHtml(mainIdx, compIdx, 'fact', 10);

  document.getElementById('ov-emails').innerHTML = topBlockHtml(mainIdx, compIdx, 'email', 10, { excludeNull: true, modeCol: 'naspunkt', modeLabel: 'Насел. пункт', expandCol: 'podtema', blockId: 'ov-emails' });
  document.getElementById('ov-addresa').innerHTML = topBlockHtml(mainAddr, compAddr, 'addr', 10, { modeCol: 'podtema', modeLabel: 'Гл. подтема' });

  document.getElementById('ov-status').innerHTML = statusBlockHtml(mainIdx);

  document.getElementById('ov-count-note').textContent = `Найдено: ${mainIdx.length} обращений`;
  window.__lastMainIdx = mainIdx; // for CSV export

  try { renderTrendChart('trendChart', mainIdx, compIdx); }
  catch (e) { console.error('trend chart failed', e); document.getElementById('trendChart').closest('.chart-wrap').innerHTML = '<div class="empty-note">График недоступен (ошибка отрисовки)</div>'; }
}

/* ================= Curator tab ================= */
let curatorMS = null;
let curatorPodtemaPick = null; // reset whenever curator changes so default = top subtopic
function buildCuratorPicker() {
  const container = document.getElementById('curatorPickHolder');
  curatorMS = new MultiSelect(container, {
    label: 'Куратор', options: freqOptions('kurator'), mode: 'single', placeholder: 'Выберите куратора',
    onChange: () => { curatorPodtemaPick = null; renderCuratorTab(); },
  });
  // default = curator with most rows overall
  const top = freqOptions('kurator')[0];
  if (top) curatorMS.setSelectedSingle(top.key);
}

function renderCuratorTab() {
  const picked = curatorMS.getSelected();
  if (!picked) return;
  const kuratorKey = [...picked][0];
  const baseFilters = readFilters(true); // all global filters except kurator
  const mainIdx = buildMask({ dateStart: state.mainStart, dateEnd: state.mainEnd, ...baseFilters, kurator: new Set([kuratorKey]) });
  const compIdx = buildMask({ dateStart: state.compStart, dateEnd: state.compEnd, ...baseFilters, kurator: new Set([kuratorKey]) });
  const mainAddr = mainIdx.filter(i => DATA.cols.ulitsa[i] !== -1);
  const compAddr = compIdx.filter(i => DATA.cols.ulitsa[i] !== -1);

  kpiCard('c-kpi-total', 'Всего обращений', mainIdx.length, dynamics(mainIdx.length, compIdx.length), '#4f8cff');
  kpiCard('c-kpi-podtem', 'Подтем', distinctCount(mainIdx, 'podtema'), dynamics(distinctCount(mainIdx, 'podtema'), distinctCount(compIdx, 'podtema')), '#38bdf8');
  kpiCard('c-kpi-sint', 'Синт. групп', distinctCount(mainIdx, 'sint'), dynamics(distinctCount(mainIdx, 'sint'), distinctCount(compIdx, 'sint')), '#22c55e');
  kpiCard('c-kpi-addr', 'Адресов с улицей', distinctCount(mainAddr, 'addr'), dynamics(distinctCount(mainAddr, 'addr'), distinctCount(compAddr, 'addr')), '#f5b942');

  document.getElementById('c-status').innerHTML = statusBlockHtml(mainIdx);
  document.getElementById('c-count-note').textContent = `Найдено: ${mainIdx.length} обращений`;
  window.__lastCuratorMainIdx = mainIdx;

  // ---- subtopic pill tabs ----
  const podtemaTop = countBy(mainIdx, 'podtema').slice(0, 14);
  if (!curatorPodtemaPick || !podtemaTop.some(o => o.key === curatorPodtemaPick)) {
    curatorPodtemaPick = podtemaTop.length ? podtemaTop[0].key : null;
  }
  const tabsHolder = document.getElementById('c-podtema-tabs');
  if (!podtemaTop.length) {
    tabsHolder.innerHTML = `<div class="empty-note">Нет данных за выбранный период</div>`;
  } else {
    tabsHolder.innerHTML = podtemaTop.map(o => `
      <div class="pill ${o.key === curatorPodtemaPick ? 'active' : ''}" data-key="${o.key}" title="${escapeHtml(o.label)}">
        <span>${escapeHtml(o.label.length > 42 ? o.label.slice(0, 40) + '…' : o.label)}</span><span class="cnt">${o.count}</span>
      </div>`).join('');
    tabsHolder.querySelectorAll('.pill').forEach(p => {
      p.addEventListener('click', () => { curatorPodtemaPick = Number(p.dataset.key); renderCuratorTab(); });
    });
  }

  const note = document.getElementById('c-podtema-note');
  if (curatorPodtemaPick != null) {
    const drillMain = mainIdx.filter(i => DATA.cols.podtema[i] === curatorPodtemaPick);
    const drillComp = compIdx.filter(i => DATA.cols.podtema[i] === curatorPodtemaPick);
    const drillAddr = drillMain.filter(i => DATA.cols.ulitsa[i] !== -1);
    const drillAddrComp = drillComp.filter(i => DATA.cols.ulitsa[i] !== -1);
    note.textContent = `— ${DATA.dicts.podtema[curatorPodtemaPick]} (${drillMain.length})`;

    document.getElementById('c-fakty').innerHTML = topBlockHtml(drillMain, drillComp, 'fact', 10);
    document.getElementById('c-istochniki').innerHTML = topBlockHtml(drillMain, drillComp, 'istochnik', 10);
    document.getElementById('c-addresa').innerHTML = topBlockHtml(drillAddr, drillAddrComp, 'addr', 10, { modeCol: 'podtema', modeLabel: 'Гл. подтема' });
    document.getElementById('c-emails').innerHTML = topBlockHtml(drillMain, drillComp, 'email', 10, { excludeNull: true, modeCol: 'naspunkt', modeLabel: 'Насел. пункт', expandCol: 'podtema', blockId: 'c-emails', expandIdx: mainIdx });
  } else {
    note.textContent = '';
    ['c-fakty', 'c-istochniki', 'c-addresa', 'c-emails'].forEach(id => {
      document.getElementById(id).innerHTML = `<div class="empty-note">Нет данных</div>`;
    });
  }

  try { renderTrendChartInto('c-trendChart', mainIdx, compIdx); }
  catch (e) { console.error('trend chart failed', e); document.getElementById('c-trendChart').closest('.chart-wrap').innerHTML = '<div class="empty-note">График недоступен (ошибка отрисовки)</div>'; }
}

let curatorTrendChart = null;
function renderTrendChartInto(mountId, mainIdx, compIdx) {
  renderTrendChart(mountId, mainIdx, compIdx);
}

/* ================= CSV export ================= */
function exportCsv() {
  const idxArr = window.__lastMainIdx || [];
  const cols = ['date', 'napr', 'sint', 'fact', 'podtema', 'status', 'kurator', 'ispolnitel', 'tip', 'istochnik', 'uk', 'addr', 'naspunkt', 'rayon', 'email', 'spam'];
  const headers = ['Дата', 'Направление', 'Синт.группа', 'Факт', 'Подтема', 'Статус', 'Куратор', 'Исполнитель', 'Тип сообщения', 'Источник', 'УК', 'Адрес', 'Населённый пункт', 'Район', 'Почта заявителя', 'Спам'];
  const lines = [headers.join(';')];
  for (const i of idxArr) {
    const row = cols.map(c => {
      if (c === 'date') return fmtDateRu(dayToISO(DATA.cols.date[i]));
      const v = DATA.cols[c][i];
      const val = v === -1 ? '' : DATA.dicts[c][v];
      return '"' + String(val).replace(/"/g, '""') + '"';
    });
    lines.push(row.join(';'));
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `obrasheniya_${fmtDateRu(dayToISO(state.mainStart))}_${fmtDateRu(dayToISO(state.mainEnd))}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ================= Init ================= */
function setDateInputs() {
  document.getElementById('mainStart').value = dayToISO(state.mainStart);
  document.getElementById('mainEnd').value = dayToISO(state.mainEnd);
  document.getElementById('compStart').value = dayToISO(state.compStart);
  document.getElementById('compEnd').value = dayToISO(state.compEnd);
}
function readDateInputs() {
  state.mainStart = isoToDay(document.getElementById('mainStart').value);
  state.mainEnd = isoToDay(document.getElementById('mainEnd').value);
  state.compStart = isoToDay(document.getElementById('compStart').value);
  state.compEnd = isoToDay(document.getElementById('compEnd').value);
}

function applyAll() {
  readDateInputs();
  renderOverview();
  renderCuratorTab();
}

function resetFilters() {
  Object.values(msWidgets).forEach(w => { w.selected.clear(); w._renderList(); w._updateLabel(); });
  state.mainEnd = MAX_DAY; state.mainStart = Math.max(MIN_DAY, MAX_DAY - 6);
  state.compEnd = state.mainStart - 1; state.compStart = Math.max(MIN_DAY, state.compEnd - 6);
  setDateInputs();
  applyAll();
}

function init() {
  document.getElementById('omsuName').textContent = DATA.omsu;
  document.getElementById('dataRange').textContent = `${fmtDateRu(dayToISO(MIN_DAY))} – ${fmtDateRu(dayToISO(MAX_DAY))}`;
  document.getElementById('rowCount').textContent = DATA.n.toLocaleString('ru-RU');

  state.mainEnd = MAX_DAY; state.mainStart = Math.max(MIN_DAY, MAX_DAY - 6);
  state.compEnd = state.mainStart - 1; state.compStart = Math.max(MIN_DAY, state.compEnd - 6);
  setDateInputs();

  buildFilterWidgets();
  buildCuratorPicker();
  attachExpandHandler('ov-emails');
  attachExpandHandler('c-emails');

  document.getElementById('btnApply').addEventListener('click', applyAll);
  document.getElementById('btnReset').addEventListener('click', resetFilters);
  document.getElementById('btnExport').addEventListener('click', exportCsv);
  document.getElementById('moreToggle').addEventListener('click', () => {
    document.getElementById('extraFilters').classList.toggle('open');
    document.getElementById('moreToggle').classList.toggle('open');
  });

  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tabpage').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.target).classList.add('active');
    });
  });

  applyAll();
}

/* ================= Bootstrap: load data.json, then init the UI ================= */
function bootstrap() {
  const loader = document.getElementById('loadingScreen');
  fetch('data.json')
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      DATA = data;
      BASE_DATE = new Date(DATA.baseDate + 'T00:00:00Z');
      MAX_DAY = DATA.cols.date.reduce((a, b) => Math.max(a, b), 0);
      MIN_DAY = DATA.cols.date.reduce((a, b) => Math.min(a, b), MAX_DAY);
      RESOLVED_STATUS_IDX = new Set(
        DATA.dicts.status.map((label, i) => (RESOLVED_STATUS_LABELS.has(label) ? i : null)).filter(v => v !== null)
      );
      if (loader) loader.remove();
      init();
    })
    .catch(err => {
      console.error('Не удалось загрузить data.json', err);
      if (loader) {
        loader.innerHTML = `<div class="load-error">
          Не удалось загрузить <b>data.json</b> (${escapeHtml(err.message)}).<br>
          Убедитесь, что файл data.json лежит рядом с index.html в том же каталоге/репозитории,
          и что страница открыта через http(s):// (а не как локальный файл file:// — некоторые
          браузеры блокируют fetch() для локальных файлов).
        </div>`;
      }
    });
}
document.addEventListener('DOMContentLoaded', bootstrap);
