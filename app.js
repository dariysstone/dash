const TAB_HASHES = { 'tab-overview': 'overview', 'tab-curators': 'curators', 'tab-report': 'report', 'tab-calendar': 'calendar' };
const TAB_TARGETS = { overview: 'tab-overview', curators: 'tab-curators', report: 'tab-report', calendar: 'tab-calendar' };

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
  let resolved = 0, overdueInWork = 0, repeatsInWork = 0, delayInWork = 0;
  for (const i of idxArr) {
    const isResolved = RESOLVED_STATUS_IDX.has(DATA.cols.status[i]);
    if (isResolved) { resolved++; continue; }
    if (DATA.cols.overdue[i] === 1) overdueInWork++;
    if (DATA.cols.hasRepeats[i] === 1) repeatsInWork++;
    if (DATA.cols.hasDelay[i] === 1) delayInWork++;
  }
  const inWork = total - resolved;
  const rows = [{ label: 'Решено', count: resolved }, { label: 'В работе', count: inWork }];
  const maxCount = Math.max(resolved, inWork, 1);
  let html = `<div class="toplist">` + rows.map(o => {
    const pct = Math.round((o.count / total) * 1000) / 10;
    const barPct = Math.round((o.count / maxCount) * 100);
    return `<div class="toprow">
      <span class="name">${o.label}</span>
      <span class="bar"><i style="width:${barPct}%"></i></span>
      <span class="cnt">${o.count}</span>
      <span class="dyn" style="color:var(--text-soft);font-weight:600;font-family:var(--mono);">${pct}%</span>
    </div>`;
  }).join('') + `</div>`;
  if (inWork > 0 && (overdueInWork || repeatsInWork || delayInWork)) {
    const pctOf = n => inWork ? Math.round(n / inWork * 1000) / 10 : 0;
    html += `<div class="status-subnote">Из «В работе»: просрочено — <b>${overdueInWork}</b> (${pctOf(overdueInWork)}%) · с повторами — <b>${repeatsInWork}</b> (${pctOf(repeatsInWork)}%) · с отложенными решениями — <b>${delayInWork}</b> (${pctOf(delayInWork)}%)</div>`;
  }
  return html;
}

/* ================= Core aggregation (validated in Node) ================= */
function buildMask(filters) {
  const n = DATA.n;
  const idx = [];
  const c = DATA.cols;
  const dateArr = c.date, kuratorArr = c.kurator, podtemaArr = c.podtema, sintArr = c.sint,
        istochnikArr = c.istochnik, naprArr = c.napr, tipArr = c.tip, statusArr = c.status,
        naspunktArr = c.naspunkt, rayonArr = c.rayon, ukArr = c.uk, ispolnitelArr = c.ispolnitel, spamArr = c.spam,
        overdueArr = c.overdue, hasRepeatsArr = c.hasRepeats, hasDelayArr = c.hasDelay;
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
    if (filters.overdue && !filters.overdue.has(overdueArr[i])) continue;
    if (filters.hasRepeats && !filters.hasRepeats.has(hasRepeatsArr[i])) continue;
    if (filters.hasDelay && !filters.hasDelay.has(hasDelayArr[i])) continue;
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
/* Counts by the combination of two columns together, e.g. Направление + Синт.группа —
   only combinations that actually occur in the data show up (no empty cross-product). */
function countByPair(idxArr, colA, colB) {
  const ca = DATA.cols[colA], cb = DATA.cols[colB];
  const da = DATA.dicts[colA], db = DATA.dicts[colB];
  const counts = new Map();
  for (const i of idxArr) {
    const a = ca[i], b = cb[i];
    const key = a + '|' + b;
    const entry = counts.get(key);
    if (entry) entry.count++; else counts.set(key, { a, b, count: 1 });
  }
  const arr = [...counts.values()].map(o => ({
    a: o.a, b: o.b, count: o.count,
    label: `${o.a === -1 ? '—' : da[o.a]} — ${o.b === -1 ? '—' : db[o.b]}`,
  }));
  arr.sort((x, y) => y.count - x.count);
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
      e.stopPropagation();
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
        e.stopPropagation();
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
    ['overdue', 'Просрочка'], ['hasRepeats', 'Есть повторы'], ['hasDelay', 'Есть отложки'],
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
  for (const key of ['kurator', 'podtema', 'sint', 'istochnik', 'napr', 'tip', 'status', 'naspunkt', 'rayon', 'uk', 'ispolnitel', 'spam', 'overdue', 'hasRepeats', 'hasDelay']) {
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

  if (opts.expandCol && opts.blockId) BLOCK_DATA[opts.blockId] = { colName, idxArr: opts.expandIdx || mainIdx, expandCol: opts.expandCol };

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
const EXPAND_STATE = {}; // "blockId::key" -> { breakdown: [...], shown: n }
const EXPAND_PAGE_SIZE = 10;

function renderExpandPanelHtml(breakdown, shown) {
  const slice = breakdown.slice(0, shown);
  const maxC = breakdown.length ? breakdown[0].count : 1;
  const rowsHtml = slice.map(b => `
      <div class="exp-row">
        <span class="exp-name" title="${escapeHtml(b.label)}">${escapeHtml(b.label)}</span>
        <span class="exp-bar"><i style="width:${Math.round(b.count / maxC * 100)}%"></i></span>
        <span class="exp-cnt">${b.count}</span>
      </div>`).join('');
  const hasMore = shown < breakdown.length;
  const controls = `<div class="exp-controls">
      ${hasMore ? `<button type="button" class="exp-btn exp-more">Показать ещё ${Math.min(EXPAND_PAGE_SIZE, breakdown.length - shown)}</button>` : ''}
      <button type="button" class="exp-btn exp-less">Скрыть ${Math.min(EXPAND_PAGE_SIZE, shown)}</button>
    </div>`;
  return `<div class="expand-panel">${rowsHtml}${controls}</div>`;
}

function closeExpandRow(row, stateKey) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('expand-panel')) next.remove();
  row.classList.remove('open');
  delete EXPAND_STATE[stateKey];
}

function openExpandRow(row) {
  const blockId = row.dataset.block;
  const key = Number(row.dataset.key);
  const stateKey = blockId + '::' + key;
  const info = BLOCK_DATA[blockId];
  if (!info) return;
  const col = DATA.cols[info.colName];
  const subIdx = info.idxArr.filter(i => col[i] === key);
  const breakdown = countBy(subIdx, info.expandCol);
  EXPAND_STATE[stateKey] = { breakdown, shown: Math.min(EXPAND_PAGE_SIZE, breakdown.length) };
  row.classList.add('open');
  row.insertAdjacentHTML('afterend', renderExpandPanelHtml(breakdown, EXPAND_STATE[stateKey].shown));
}

function refreshExpandRow(row, stateKey) {
  const st = EXPAND_STATE[stateKey];
  const next = row.nextElementSibling;
  if (next && next.classList.contains('expand-panel')) next.remove();
  row.insertAdjacentHTML('afterend', renderExpandPanelHtml(st.breakdown, st.shown));
}

function attachExpandHandler(containerId) {
  const container = document.getElementById(containerId);

  container.addEventListener('click', (e) => {
    const moreBtn = e.target.closest('.exp-more');
    const lessBtn = e.target.closest('.exp-less');
    if (moreBtn || lessBtn) {
      e.stopPropagation();
      const panel = e.target.closest('.expand-panel');
      const row = panel.previousElementSibling;
      const stateKey = row.dataset.block + '::' + row.dataset.key;
      const st = EXPAND_STATE[stateKey];
      if (!st) return;
      if (moreBtn) {
        st.shown = Math.min(st.breakdown.length, st.shown + EXPAND_PAGE_SIZE);
        refreshExpandRow(row, stateKey);
      } else {
        st.shown -= EXPAND_PAGE_SIZE;
        if (st.shown <= 0) closeExpandRow(row, stateKey);
        else refreshExpandRow(row, stateKey);
      }
      return;
    }

    const row = e.target.closest('.toprow.expandable');
    if (!row || !container.contains(row)) return;
    const stateKey = row.dataset.block + '::' + row.dataset.key;
    if (row.classList.contains('open')) { closeExpandRow(row, stateKey); return; }
    // one expanded row at a time per block keeps the list readable
    container.querySelectorAll('.toprow.expandable.open').forEach(r => {
      closeExpandRow(r, r.dataset.block + '::' + r.dataset.key);
    });
    openExpandRow(row);
  });
}

function collapseAllExpanded(containerId) {
  const container = document.getElementById(containerId);
  container.querySelectorAll('.toprow.expandable.open').forEach(r => {
    closeExpandRow(r, r.dataset.block + '::' + r.dataset.key);
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

  document.getElementById('ov-podtemy').innerHTML = topBlockHtml(mainIdx, compIdx, 'podtema', 10, { expandCol: 'fact', blockId: 'ov-podtemy' });
  document.getElementById('ov-fakty').innerHTML = topBlockHtml(mainIdx, compIdx, 'fact', 10);

  document.getElementById('ov-emails').innerHTML = topBlockHtml(mainIdx, compIdx, 'email', 10, { excludeNull: true, modeCol: 'naspunkt', modeLabel: 'Насел. пункт', expandCol: 'podtema', blockId: 'ov-emails' });
  document.getElementById('ov-addresa').innerHTML = topBlockHtml(mainAddr, compAddr, 'addr', 10, { modeCol: 'podtema', modeLabel: 'Гл. подтема' });

  document.getElementById('ov-status').innerHTML = statusBlockHtml(mainIdx);

  document.getElementById('ov-count-note').textContent = `Найдено: ${mainIdx.length} обращений`;
  window.__lastMainIdx = mainIdx; // for CSV export
  window.__lastCompIdx = compIdx; // for the report generator

  try { renderTrendChart('trendChart', mainIdx, compIdx); }
  catch (e) { console.error('trend chart failed', e); document.getElementById('trendChart').closest('.chart-wrap').innerHTML = '<div class="empty-note">График недоступен (ошибка отрисовки)</div>'; }
}

/* ================= Curator tab ================= */
let curatorMS = null;
let curatorPairPick = null; // "naprIdx|sintIdx", reset whenever curator changes so default = top combination
function buildCuratorPicker() {
  const container = document.getElementById('curatorPickHolder');
  curatorMS = new MultiSelect(container, {
    label: 'Куратор', options: freqOptions('kurator'), mode: 'single', placeholder: 'Выберите куратора',
    onChange: () => { curatorPairPick = null; renderCuratorTab(); },
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

  // ---- Направление + Синт.группа combined pill tabs (only combinations that actually occur) ----
  const pairTop = countByPair(mainIdx, 'napr', 'sint').slice(0, 14);
  const pairKey = o => o.a + '|' + o.b;
  if (!curatorPairPick || !pairTop.some(o => pairKey(o) === curatorPairPick)) {
    curatorPairPick = pairTop.length ? pairKey(pairTop[0]) : null;
  }
  const tabsHolder = document.getElementById('c-podtema-tabs');
  if (!pairTop.length) {
    tabsHolder.innerHTML = `<div class="empty-note">Нет данных за выбранный период</div>`;
  } else {
    tabsHolder.innerHTML = pairTop.map(o => `
      <div class="pill ${pairKey(o) === curatorPairPick ? 'active' : ''}" data-key="${pairKey(o)}" title="${escapeHtml(o.label)}">
        <span>${escapeHtml(o.label.length > 46 ? o.label.slice(0, 44) + '…' : o.label)}</span><span class="cnt">${o.count}</span>
      </div>`).join('');
    tabsHolder.querySelectorAll('.pill').forEach(p => {
      p.addEventListener('click', () => { curatorPairPick = p.dataset.key; renderCuratorTab(); });
    });
  }

  const note = document.getElementById('c-podtema-note');
  if (curatorPairPick != null) {
    const [naprKey, sintKey] = curatorPairPick.split('|').map(Number);
    const drillMain = mainIdx.filter(i => DATA.cols.napr[i] === naprKey && DATA.cols.sint[i] === sintKey);
    const drillComp = compIdx.filter(i => DATA.cols.napr[i] === naprKey && DATA.cols.sint[i] === sintKey);
    const drillAddr = drillMain.filter(i => DATA.cols.ulitsa[i] !== -1);
    const drillAddrComp = drillComp.filter(i => DATA.cols.ulitsa[i] !== -1);
    const naprLabel = naprKey === -1 ? '—' : DATA.dicts.napr[naprKey];
    const sintLabel = sintKey === -1 ? '—' : DATA.dicts.sint[sintKey];
    note.textContent = `— ${naprLabel} — ${sintLabel} (${drillMain.length})`;

    document.getElementById('c-podtemy').innerHTML = topBlockHtml(drillMain, drillComp, 'podtema', 10, { expandCol: 'fact', blockId: 'c-podtemy' });
    document.getElementById('c-fakty').innerHTML = topBlockHtml(drillMain, drillComp, 'fact', 10);
    document.getElementById('c-istochniki').innerHTML = topBlockHtml(drillMain, drillComp, 'istochnik', 10);
    document.getElementById('c-addresa').innerHTML = topBlockHtml(drillAddr, drillAddrComp, 'addr', 10, { modeCol: 'podtema', modeLabel: 'Гл. подтема' });
    document.getElementById('c-emails').innerHTML = topBlockHtml(drillMain, drillComp, 'email', 10, { excludeNull: true, modeCol: 'naspunkt', modeLabel: 'Насел. пункт', expandCol: 'podtema', blockId: 'c-emails', expandIdx: mainIdx });
  } else {
    note.textContent = '';
    ['c-podtemy', 'c-fakty', 'c-istochniki', 'c-addresa', 'c-emails'].forEach(id => {
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

/* ================= Report ("Справка") ================= */
function fmtNum(n) { return Math.round(n).toLocaleString('ru-RU'); }
function pluralRu(n, forms) {
  const abs = Math.abs(n) % 100;
  const n1 = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (n1 > 1 && n1 < 5) return forms[1];
  if (n1 === 1) return forms[0];
  return forms[2];
}
function pctText(pct) { return `${pct > 0 ? '+' : ''}${pct}%`; }

// Per-key dynamics list (main vs comparison count) for a given column — the base data for every ranking table.
function computeDynList(mainIdx, compIdx, colName, opts) {
  opts = opts || {};
  const mainCounts = countBy(mainIdx, colName, opts);
  const compCounts = countBy(compIdx, colName, opts);
  const mainMap = new Map(mainCounts.map(o => [o.key, o.count]));
  const compMap = new Map(compCounts.map(o => [o.key, o.count]));
  const dict = DATA.dicts[colName];
  const keys = new Set([...mainMap.keys(), ...compMap.keys()]);
  const rows = [];
  keys.forEach(k => {
    const mc = mainMap.get(k) || 0;
    const cc = compMap.get(k) || 0;
    const dyn = dynamics(mc, cc);
    rows.push({ key: k, label: k === -1 ? '(не указано)' : dict[k], mainCount: mc, compCount: cc, delta: dyn.delta, pct: dyn.pct });
  });
  return rows;
}
function reportRowClass(pct) { return pct >= 30 ? 'r-row-crit' : (pct <= -20 ? 'r-row-good' : ''); }
function growthBadgeHtml(pct) {
  if (pct >= 100) return '<span class="r-badge crit">КРИТИЧЕСКИЙ ПРИРОСТ</span>';
  if (pct >= 30) return '<span class="r-badge crit">ЗНАЧИТЕЛЬНЫЙ ПРИРОСТ</span>';
  return '';
}
function declineBadgeHtml(pct) { return pct <= -30 ? '<span class="r-badge good">СНИЖЕНИЕ</span>' : ''; }

// Attaches "what residents mostly complained about" to each ranking row (e.g. dominant podtema per address/curator).
function attachMode(rows, idxArr, colName, modeCol) {
  const col = DATA.cols[colName];
  const col2 = DATA.cols[modeCol];
  const dict2 = DATA.dicts[modeCol];
  rows.forEach(r => {
    const modeCounts = new Map();
    for (const i of idxArr) {
      if (col[i] !== r.key) continue;
      const v2 = col2[i];
      modeCounts.set(v2, (modeCounts.get(v2) || 0) + 1);
    }
    let bestK = null, bestC = -1;
    for (const [k, c] of modeCounts.entries()) { if (c > bestC) { bestC = c; bestK = k; } }
    r.modeLabel = (bestK == null || bestK === -1) ? null : dict2[bestK];
  });
  return rows;
}
// Short "chiefly complained about X and Y" phrase for section intros, computed straight from the data.
function topThemePhrase(idxArr, colName, topN) {
  const top = countBy(idxArr, colName, { excludeNull: true }).slice(0, topN || 2);
  if (!top.length) return '';
  return top.map(o => `«${o.label}»`).join(' и ');
}

function dynTableHtml(rows, colLabel, opts) {
  opts = opts || {};
  if (!rows.length) return `<div class="empty-note">Нет данных</div>`;
  return `<div class="r-table-wrap"><table>
    <thead><tr><th style="width:28px">№</th><th>${escapeHtml(colLabel)}</th><th style="width:80px">Сравн.</th><th style="width:80px">Осн.</th><th style="width:78px">Динамика</th></tr></thead>
    <tbody>${rows.map((r, i) => `
      <tr class="${reportRowClass(r.pct)}">
        <td class="r-rank">${String(i + 1).padStart(2, '0')}</td>
        <td>${escapeHtml(r.label)}${r.delta >= 0 ? growthBadgeHtml(r.pct) : declineBadgeHtml(r.pct)}${r.modeLabel ? `<div class="r-sub">${escapeHtml(opts.modeLabel || 'Чаще всего')}: ${escapeHtml(r.modeLabel)}</div>` : ''}</td>
        <td class="r-num">${fmtNum(r.compCount)}</td>
        <td class="r-num">${fmtNum(r.mainCount)}</td>
        <td class="r-delta ${r.delta >= 0 ? 'bad' : 'good'}">${pctText(r.pct)}</td>
      </tr>`).join('')}</tbody>
  </table></div>`;
}

/* ================= Calendar (отложенные решения) ================= */
const RU_MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const RU_DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const calState = { year: null, month: null, selectedDate: null };

function calendarMatchIdx() {
  if (!DATA.dicts.delayDate || !DATA.dicts.delayDate.length) return [];
  const filters = readFilters(false);
  const idx = buildMask({ dateStart: MIN_DAY, dateEnd: MAX_DAY, ...filters });
  return idx.filter(i => DATA.cols.delayDate[i] !== -1);
}

function initCalendar() {
  const today = new Date();
  calState.year = today.getFullYear();
  calState.month = today.getMonth();
  document.getElementById('calPrev').addEventListener('click', () => { shiftCalMonth(-1); });
  document.getElementById('calNext').addEventListener('click', () => { shiftCalMonth(1); });
  document.getElementById('calToday').addEventListener('click', () => {
    const t = new Date();
    calState.year = t.getFullYear(); calState.month = t.getMonth();
    calState.selectedDate = t.toISOString().slice(0, 10);
    renderCalendar();
  });
}
function shiftCalMonth(delta) {
  calState.month += delta;
  if (calState.month < 0) { calState.month = 11; calState.year--; }
  if (calState.month > 11) { calState.month = 0; calState.year++; }
  renderCalendar();
}

function renderCalendar() {
  const grid = document.getElementById('calGrid');
  const titleEl = document.getElementById('calTitle');
  if (!grid || !titleEl) return;
  const idxArr = calendarMatchIdx();

  titleEl.textContent = `${RU_MONTHS[calState.month]} ${calState.year}`;

  // group matching rows by ISO date string (dict-decoded)
  const byDate = new Map(); // 'YYYY-MM-DD' -> [row indices]
  for (const i of idxArr) {
    const iso = DATA.dicts.delayDate[DATA.cols.delayDate[i]];
    if (!byDate.has(iso)) byDate.set(iso, []);
    byDate.get(iso).push(i);
  }

  const monthPrefix = `${calState.year}-${String(calState.month + 1).padStart(2, '0')}`;
  let monthTotal = 0;
  byDate.forEach((arr, iso) => { if (iso.startsWith(monthPrefix)) monthTotal += arr.length; });
  document.getElementById('calTotal').textContent = `Всего в этом месяце: ${monthTotal}`;

  const first = new Date(Date.UTC(calState.year, calState.month, 1));
  const daysInMonth = new Date(Date.UTC(calState.year, calState.month + 1, 0)).getUTCDate();
  let firstDow = first.getUTCDay(); // 0=Sun
  firstDow = firstDow === 0 ? 6 : firstDow - 1; // Monday-first index

  const todayIso = new Date().toISOString().slice(0, 10);

  let html = RU_DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');
  for (let k = 0; k < firstDow; k++) html += `<div class="cal-day empty"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${monthPrefix}-${String(day).padStart(2, '0')}`;
    const items = byDate.get(iso) || [];
    const isToday = iso === todayIso;
    const isPast = iso < todayIso;
    const isSelected = iso === calState.selectedDate;
    html += `<div class="cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}${items.length && isPast ? ' past' : ''}" data-date="${iso}">
      <span class="dnum">${day}</span>
      ${items.length ? `<div class="dcount">${items.length}</div>` : ''}
    </div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.cal-day:not(.empty)').forEach(cell => {
    cell.addEventListener('click', () => {
      calState.selectedDate = cell.dataset.date;
      renderCalendar();
      renderCalDayList(cell.dataset.date, byDate.get(cell.dataset.date) || []);
    });
  });

  if (calState.selectedDate) renderCalDayList(calState.selectedDate, byDate.get(calState.selectedDate) || []);
}

function renderCalDayList(iso, items) {
  const panel = document.getElementById('calDayPanel');
  const list = document.getElementById('calDayList');
  const titleEl = document.getElementById('calDayTitle');
  if (!panel) return;
  panel.style.display = 'block';
  titleEl.textContent = fmtDateRu(iso);
  if (!items.length) { list.innerHTML = `<div class="empty-note">На этот день ничего не отложено</div>`; return; }
  const sorted = [...items].sort((a, b) => (DATA.cols.delayCount[b] || 0) - (DATA.cols.delayCount[a] || 0));
  list.innerHTML = sorted.map(i => {
    const podtema = DATA.cols.podtema[i] !== -1 ? DATA.dicts.podtema[DATA.cols.podtema[i]] : '—';
    const kurator = DATA.cols.kurator[i] !== -1 ? DATA.dicts.kurator[DATA.cols.kurator[i]] : '—';
    const addr = DATA.cols.addr[i] !== -1 ? DATA.dicts.addr[DATA.cols.addr[i]] : '—';
    const dc = DATA.cols.delayCount[i] || 0;
    const ecur = DATA.cols.ecur[i];
    const numsrc = DATA.cols.numsrc[i];
    const nums = [
      ecur ? `<span class="task-num">ЕЦУР № ${escapeHtml(ecur)}</span>` : '',
      numsrc ? `<span class="task-num task-num-src">в источнике № ${escapeHtml(numsrc)}</span>` : '',
    ].filter(Boolean).join(' ');
    return `<div class="cal-day-list-row">
      <span>
        <span class="name">${nums ? `${nums}<br>` : ''}${escapeHtml(podtema)}</span>
        <div class="meta">${escapeHtml(kurator)} · ${escapeHtml(addr)}</div>
      </span>
      <span class="badge-n">отложено ${dc}×</span>
    </div>`;
  }).join('');
}

function renderReport(mainIdx, compIdx) {
  const root = document.getElementById('reportRoot');
  if (!root || !mainIdx) return;

  // ---- scope detection from the currently active global filters ----
  const kuratorSel = msWidgets.kurator.getSelected();
  const podtemaSel = msWidgets.podtema.getSelected();
  const sintSel = msWidgets.sint.getSelected();
  const isOverall = !(kuratorSel && kuratorSel.size === 1);
  const scopeChips = [];
  if (kuratorSel && kuratorSel.size === 1) scopeChips.push(`Куратор: ${DATA.dicts.kurator[[...kuratorSel][0]]}`);
  if (sintSel && sintSel.size === 1) scopeChips.push(`Синт.группа: ${DATA.dicts.sint[[...sintSel][0]]}`);
  if (podtemaSel && podtemaSel.size === 1) scopeChips.push(`Подтема: ${DATA.dicts.podtema[[...podtemaSel][0]]}`);
  const scopeTitle = scopeChips.length ? scopeChips.join(' · ') : 'все кураторы и темы';
  const titleMain = scopeChips.length ? scopeChips[scopeChips.length - 1].split(': ')[1] : 'Сводная аналитика';

  const total = mainIdx.length, totalComp = compIdx.length;
  const dyn = dynamics(total, totalComp);
  const mainAddr = mainIdx.filter(i => DATA.cols.ulitsa[i] !== -1);
  const compAddr = compIdx.filter(i => DATA.cols.ulitsa[i] !== -1);
  let resolved = 0;
  for (const i of mainIdx) if (RESOLVED_STATUS_IDX.has(DATA.cols.status[i])) resolved++;
  const resolvedPct = total ? Math.round(resolved / total * 1000) / 10 : 0;

  const periodTxt = `${fmtDateRu(dayToISO(state.mainStart))} – ${fmtDateRu(dayToISO(state.mainEnd))}`;
  const compTxt = `${fmtDateRu(dayToISO(state.compStart))} – ${fmtDateRu(dayToISO(state.compEnd))}`;

  // ---- rankings ----
  const podtemaDyn = computeDynList(mainIdx, compIdx, 'podtema');
  const growthPodtema = attachMode(podtemaDyn.filter(r => r.delta > 0 && r.mainCount >= 5).sort((a, b) => b.pct - a.pct).slice(0, 6), mainIdx, 'podtema', 'fact');
  const declinePodtema = attachMode(podtemaDyn.filter(r => r.delta < 0 && r.compCount >= 5).sort((a, b) => a.pct - b.pct).slice(0, 6), mainIdx, 'podtema', 'fact');

  const kuratorDyn = isOverall ? attachMode(computeDynList(mainIdx, compIdx, 'kurator').sort((a, b) => b.mainCount - a.mainCount).slice(0, 8), mainIdx, 'kurator', 'podtema') : [];

  const addrDyn = attachMode(computeDynList(mainAddr, compAddr, 'addr').sort((a, b) => b.mainCount - a.mainCount).slice(0, 8), mainAddr, 'addr', 'podtema');
  const addrGrowth = attachMode(computeDynList(mainAddr, compAddr, 'addr').filter(r => r.delta > 0 && r.mainCount >= 5).sort((a, b) => b.pct - a.pct).slice(0, 4), mainAddr, 'addr', 'podtema');

  const topEmails = topWithMode(mainIdx, 'email', 'podtema', 10, { excludeNull: true });

  const naprTop = countBy(mainIdx, 'napr').slice(0, 5);
  const istochnikTop = countBy(mainIdx, 'istochnik').slice(0, 5);
  const tipTop = countBy(mainIdx, 'tip').slice(0, 5);

  // "What's actually behind the numbers" phrases — used in section intros instead of methodology explanations
  const addrThemePhrase = topThemePhrase(mainAddr, 'podtema', 2);
  const growthKeySet = new Set(growthPodtema.map(r => r.key));
  const growthFactPhrase = growthKeySet.size ? topThemePhrase(mainIdx.filter(i => growthKeySet.has(DATA.cols.podtema[i])), 'fact', 2) : '';
  const emailThemePhrase = topThemePhrase(mainIdx, 'podtema', 2);
  const kuratorThemePhrase = kuratorDyn.length ? kuratorDyn[0].modeLabel : '';

  // ---- narrative takeaways ----
  const takeaways = [];
  takeaways.push(`За период <strong>${periodTxt}</strong> по выбранному срезу (${escapeHtml(scopeTitle)}) поступило <strong>${fmtNum(total)}</strong> ${pluralRu(total, ['обращение', 'обращения', 'обращений'])} против <strong>${fmtNum(totalComp)}</strong> за ${compTxt} — ${dyn.delta >= 0 ? `рост <span class="r-pct-bad">${pctText(dyn.pct)} (${dyn.delta >= 0 ? '+' : ''}${fmtNum(dyn.delta)})</span>` : `снижение <span class="r-pct-good">${pctText(dyn.pct)} (${fmtNum(dyn.delta)})</span>`}.`);
  if (growthPodtema.length) {
    const g = growthPodtema[0];
    takeaways.push(`Наибольший прирост среди подтем — <strong>«${escapeHtml(g.label)}»</strong>: ${fmtNum(g.compCount)} → ${fmtNum(g.mainCount)} <span class="r-pct-bad">${pctText(g.pct)}</span>.`);
  }
  if (declinePodtema.length) {
    const d = declinePodtema[0];
    takeaways.push(`Заметнее всего снизилась подтема <strong>«${escapeHtml(d.label)}»</strong>: ${fmtNum(d.compCount)} → ${fmtNum(d.mainCount)} <span class="r-pct-good">${pctText(d.pct)}</span>.`);
  }
  if (isOverall && kuratorDyn.length) {
    const k = kuratorDyn[0];
    const share = total ? Math.round(k.mainCount / total * 1000) / 10 : 0;
    takeaways.push(`Больше всего обращений закреплено за куратором <strong>«${escapeHtml(k.label)}»</strong> — ${fmtNum(k.mainCount)} (${share}% от общего числа).`);
  }
  if (addrGrowth.length) {
    const a = addrGrowth[0];
    takeaways.push(`Резкий рост обращений по конкретному адресу: <strong>${escapeHtml(a.label)}</strong> — ${fmtNum(a.compCount)} → ${fmtNum(a.mainCount)} <span class="r-pct-bad">${pctText(a.pct)}</span>, стоит проверить точечно.`);
  }
  takeaways.push(`Доля обращений в статусе «Решено» — <strong>${resolvedPct}%</strong> (${fmtNum(resolved)} из ${fmtNum(total)}), доля «В работе» — <strong>${Math.round((100 - resolvedPct) * 10) / 10}%</strong>.`);

  // ---- assemble HTML ----
  const html = `
  <div class="report-scope">
    <div class="r-toolbar no-print">
      <button type="button" class="r-print-btn" id="r-print-btn">🖨 Печать / PDF</button>
    </div>

    <header class="r-header">
      <div>
        <div class="r-meta">Дашборд обращений граждан · Аналитическая справка · ${new Date().toLocaleDateString('ru-RU')}</div>
        <h1>${escapeHtml(DATA.omsu)} <span>· ${escapeHtml(titleMain)}</span></h1>
        <div class="r-sub">Анализ обращений за период ${periodTxt} в сравнении с ${compTxt}. Срез: ${escapeHtml(scopeTitle)}.</div>
      </div>
      <div class="r-header-stats">
        <div><div class="r-hstat-label">Всего обращений</div><div class="r-hstat-value">${fmtNum(total)}</div></div>
        <div><div class="r-hstat-label">Динамика</div><div class="r-hstat-value">${pctText(dyn.pct)}</div></div>
        <div><div class="r-hstat-label">Решено</div><div class="r-hstat-value">${resolvedPct}%</div></div>
      </div>
    </header>

    <div class="r-block r-toc-block">
      <div class="r-tag"><span class="n">01</span> Содержание справки</div>
      <h2>Структура документа</h2>
      <div class="r-toc-grid">
        <div class="r-toc-item"><span class="r-toc-num">01</span><span>Ключевые выводы</span></div>
        <div class="r-toc-item"><span class="r-toc-num">02</span><span>Общая динамика обращений</span></div>
        <div class="r-toc-item"><span class="r-toc-num">03</span><span>Подтемы с наибольшим приростом и снижением</span></div>
        ${isOverall ? `<div class="r-toc-item"><span class="r-toc-num">04</span><span>Рейтинг кураторов по объёму</span></div>` : ''}
        <div class="r-toc-item"><span class="r-toc-num">05</span><span>Адреса — объём и точки роста</span></div>
        <div class="r-toc-item"><span class="r-toc-num">06</span><span>Активные заявители</span></div>
        <div class="r-toc-item"><span class="r-toc-num">07</span><span>Направления, источники, тип сообщения</span></div>
        <div class="r-toc-item"><span class="r-toc-num">08</span><span>Итоговая сводка</span></div>
      </div>
    </div>

    <div class="r-block r-takeaways">
      <div class="r-tag"><span class="n">01</span> Ключевые выводы · саммари</div>
      <h2>Основные итоги отчётного периода</h2>
      <p class="r-desc">Главные показатели и тенденции по срезу «${escapeHtml(scopeTitle)}» для управленческого решения.</p>
      ${takeaways.map((t, i) => `<div class="r-takeaway"><div class="r-takeaway-num">${String(i + 1).padStart(2, '0')}</div><div class="r-takeaway-text">${t}</div></div>`).join('')}
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">02</span> Общая динамика</div>
      <h2>${fmtNum(total)} ${pluralRu(total, ['обращение', 'обращения', 'обращений'])}</h2>
      <p class="r-desc">Сопоставление объёма и ключевых счётчиков за основной период и период сравнения.</p>
      <div class="r-stat-grid">
        <div class="r-stat-card ${dyn.delta >= 0 ? 'bad' : 'good'}">
          <div class="r-stat-label">Всего обращений</div>
          <div class="r-stat-value">${fmtNum(total)}</div>
          <div class="r-stat-compare">Сравнение: ${fmtNum(totalComp)} · <span class="${dyn.delta >= 0 ? 'r-pct-bad' : 'r-pct-good'}" style="padding:0;background:none;border:none;">${pctText(dyn.pct)}</span></div>
        </div>
        <div class="r-stat-card">
          <div class="r-stat-label">Решено</div>
          <div class="r-stat-value">${resolvedPct}%</div>
          <div class="r-stat-compare">${fmtNum(resolved)} из ${fmtNum(total)}</div>
        </div>
        <div class="r-stat-card">
          <div class="r-stat-label">Кураторов</div>
          <div class="r-stat-value">${distinctCount(mainIdx, 'kurator')}</div>
          <div class="r-stat-compare">задействовано за период</div>
        </div>
        <div class="r-stat-card">
          <div class="r-stat-label">Адресов с улицей</div>
          <div class="r-stat-value">${distinctCount(mainAddr, 'addr')}</div>
          <div class="r-stat-compare">уникальных за период</div>
        </div>
      </div>
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">03</span> Подтемы · рост и снижение</div>
      <h2>Где хуже, а где лучше</h2>
      <p class="r-desc">${growthFactPhrase ? `Внутри растущих подтем чаще всего встречаются жалобы на ${growthFactPhrase}.` : 'Подтемы с наибольшим приростом и наибольшим снижением относительно периода сравнения.'}</p>
      <div class="r-grid2">
        <div><h3>Наибольший прирост</h3>${dynTableHtml(growthPodtema, 'Подтема', { modeLabel: 'Чаще всего' })}</div>
        <div><h3>Наибольшее снижение</h3>${dynTableHtml(declinePodtema, 'Подтема', { modeLabel: 'Чаще всего' })}</div>
      </div>
    </div>

    ${isOverall ? `
    <div class="r-block">
      <div class="r-tag"><span class="n">04</span> Кураторы</div>
      <h2>Рейтинг кураторов по объёму</h2>
      <p class="r-desc">${kuratorThemePhrase ? `У куратора-лидера чаще всего жители жалуются на ${kuratorThemePhrase}.` : 'Кураторы с наибольшим объёмом обращений за основной период.'}</p>
      ${dynTableHtml(kuratorDyn, 'Куратор', { modeLabel: 'Чаще всего' })}
    </div>` : ''}

    <div class="r-block">
      <div class="r-tag"><span class="n">05</span> Адреса</div>
      <h2>Адреса — объём и точки роста</h2>
      <p class="r-desc">${addrThemePhrase ? `По адресам-лидерам чаще всего фигурируют жалобы на ${addrThemePhrase}. Справа — адреса с резким приростом обращений, потенциальные новые проблемные точки.` : 'Адреса с наибольшим числом обращений и наибольшим приростом.'}</p>
      <div class="r-grid2">
        <div><h3>По объёму</h3>${dynTableHtml(addrDyn, 'Адрес', { modeLabel: 'Жалуются на' })}</div>
        <div><h3>Резкий прирост</h3>${dynTableHtml(addrGrowth, 'Адрес', { modeLabel: 'Жалуются на' })}</div>
      </div>
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">06</span> Заявители</div>
      <h2>Активные заявители</h2>
      <p class="r-desc">${emailThemePhrase ? `Чаще всего активные заявители пишут по теме ${emailThemePhrase}.` : 'Топ-10 заявителей по количеству обращений за основной период.'}</p>
      <div class="r-cards-grid">
        <div class="r-info-card">
          <div class="r-info-card-meta">Топ-10 заявителей · ${escapeHtml(scopeTitle)}</div>
          ${topEmails.map((e, i) => `<div class="r-info-row"><span class="r-info-rank">${String(i + 1).padStart(2, '0')}</span><span class="r-info-text"><span class="r-info-email" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</span>${e.modeLabel ? `<div class="r-sub">Жалуется на: ${escapeHtml(e.modeLabel)}</div>` : ''}</span><span class="r-info-count">${e.count}</span></div>`).join('') || '<div class="empty-note">Нет данных</div>'}
        </div>
      </div>
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">07</span> Разбивка</div>
      <h2>Направления, источники, тип сообщения</h2>
      <p class="r-desc">${naprTop.length ? `Больше всего обращений приходится на направление «${escapeHtml(naprTop[0].label)}»${istochnikTop.length ? `, основной канал поступления — «${escapeHtml(istochnikTop[0].label)}»` : ''}.` : ''}</p>
      <div class="r-grid2">
        <div><h3>Направления</h3>${barTableHtml(naprTop)}</div>
        <div><h3>Источники</h3>${barTableHtml(istochnikTop)}</div>
      </div>
      <h3>Тип сообщения</h3>${barTableHtml(tipTop)}
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">99</span> Развитие справки</div>
      <h2>Что можно добавить дальше</h2>
      <p class="r-desc">Текст обращения («Описание») сейчас не включён в данные дашборда — только категории (подтема/факт/направление). Чтобы оценивать социальную значимость и тональность обращений по самому тексту, нужно отдельно подключить анализ текста: это заметно увеличит объём данных и потребует отдельного шага обработки. Если это актуально — можно обсудить отдельно, как лучше это сделать.</p>
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">08</span> Итог</div>
      <h2>Итоговая сводка</h2>
      <p class="r-desc">Краткое резюме по срезу «${escapeHtml(scopeTitle)}» за ${periodTxt}.</p>
      <div class="r-callout ${dyn.delta >= 0 ? 'bad' : ''}">
        <div class="r-callout-icon">${dyn.delta >= 0 ? '↑' : '↓'}</div>
        <div class="r-callout-text"><strong>Итог:</strong> обращения по срезу «${escapeHtml(scopeTitle)}» ${dyn.delta >= 0 ? 'выросли' : 'снизились'} с ${fmtNum(totalComp)} до ${fmtNum(total)} (${pctText(dyn.pct)}).
        ${growthPodtema.length ? ` Наибольшего внимания требует подтема «${escapeHtml(growthPodtema[0].label)}» (${pctText(growthPodtema[0].pct)}).` : ''}
        ${declinePodtema.length ? ` Заметно улучшилась ситуация по теме «${escapeHtml(declinePodtema[0].label)}» (${pctText(declinePodtema[0].pct)}).` : ''}</div>
      </div>
    </div>

    <div class="r-footer">Дашборд обращений граждан · ${escapeHtml(DATA.omsu)} · Отчётный период: ${periodTxt} в сопоставлении с ${compTxt} · Срез: ${escapeHtml(scopeTitle)} · Сформировано ${new Date().toLocaleString('ru-RU')}</div>
  </div>`;

  root.innerHTML = html;
  const printBtn = document.getElementById('r-print-btn');
  if (printBtn) printBtn.addEventListener('click', () => window.print());
}

function barTableHtml(rows) {
  if (!rows.length) return `<div class="empty-note">Нет данных</div>`;
  const max = rows[0].count;
  return `<div class="r-table-wrap"><table>
    <thead><tr><th>Значение</th><th style="width:90px">Кол-во</th><th style="width:80px">Доля</th></tr></thead>
    <tbody>${rows.map(o => `<tr><td>${escapeHtml(o.label)}</td><td class="r-num">${fmtNum(o.count)}</td><td class="r-num">${Math.round(o.count / max * 100)}%</td></tr>`).join('')}</tbody>
  </table></div>`;
}


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
  renderReport(window.__lastMainIdx, window.__lastCompIdx);
  renderCalendar();
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
  initCalendar();
  attachExpandHandler('ov-emails');
  attachExpandHandler('c-emails');
  attachExpandHandler('ov-podtemy');
  attachExpandHandler('c-podtemy');

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.collapse-all-btn');
    if (btn) collapseAllExpanded(btn.dataset.collapse);
  });

  document.getElementById('btnApply').addEventListener('click', applyAll);
  document.getElementById('btnReset').addEventListener('click', resetFilters);
  document.getElementById('btnExport').addEventListener('click', exportCsv);
  document.getElementById('moreToggle').addEventListener('click', () => {
    document.getElementById('extraFilters').classList.toggle('open');
    document.getElementById('moreToggle').classList.toggle('open');
  });

  function switchTab(targetId, pushHash) {
    document.querySelectorAll('.tab, .app-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tabpage').forEach(p => p.classList.remove('active'));
    document.querySelectorAll(`.tab[data-target="${targetId}"], .app-tab[data-target="${targetId}"]`).forEach(t => t.classList.add('active'));
    const page = document.getElementById(targetId);
    if (page) page.classList.add('active');
    if (pushHash !== false) {
      const hash = TAB_HASHES[targetId] || '';
      if (hash) { try { history.replaceState(null, '', '#' + hash); } catch (e) {} }
    }
  }
  window.__switchTab = switchTab;

  document.querySelectorAll('.tab, .app-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.target));
  });

  const hashTarget = TAB_TARGETS[(location.hash || '').replace(/^#/, '')];
  if (hashTarget) switchTab(hashTarget, false);

  applyAll();
}

/* ================= Bootstrap: load data.json, then init the UI ================= */
function bootstrap() {
  const loader = document.getElementById('loadingScreen');
  const finishLoad = (data) => {
    DATA = data;
    BASE_DATE = new Date(DATA.baseDate + 'T00:00:00Z');
    MAX_DAY = DATA.cols.date.reduce((a, b) => Math.max(a, b), 0);
    MIN_DAY = DATA.cols.date.reduce((a, b) => Math.min(a, b), MAX_DAY);
    RESOLVED_STATUS_IDX = new Set(
      DATA.dicts.status.map((label, i) => (RESOLVED_STATUS_LABELS.has(label) ? i : null)).filter(v => v !== null)
    );
    if (loader) loader.remove();
    init();
  };

  // Single-file build embeds the data directly (window.__EMBEDDED_DATA__) — use it synchronously.
  if (window.__EMBEDDED_DATA__) { finishLoad(window.__EMBEDDED_DATA__); return; }

  // Multi-file build (index.html + data.json as separate files) — fetch it at runtime.
  fetch('data.json?t=' + Date.now(), { cache: 'no-store' })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(finishLoad)
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
