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
    const matchIdx = [];
    for (const i of idxArr) {
      if (col[i] !== item.key) continue;
      matchIdx.push(i);
      const v2 = col2[i];
      modeCounts.set(v2, (modeCounts.get(v2) || 0) + 1);
    }
    let bestK = null, bestC = -1;
    for (const [k, c] of modeCounts.entries()) { if (c > bestC) { bestC = c; bestK = k; } }
    item.modeLabel = (bestK === -1 || bestK === null) ? '—' : dict2[bestK];
    item.modeCount = bestC < 0 ? 0 : bestC;
    item.keywordPhrase = keywordPhraseFor(matchIdx);
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
// Frequency-ranked keywords (from the Описание text, PII stripped at build time) among a set of rows.
// Not text summarization — just word-frequency counting. See report footnote for details.
function keywordPhraseFor(idxArr, topN) {
  if (!DATA.dicts.keyword || !DATA.cols.keywords) return '';
  const kwCounts = new Map();
  for (const i of idxArr) {
    const kwStr = DATA.cols.keywords[i];
    if (!kwStr) continue;
    for (const idStr of kwStr.split(',')) {
      if (!idStr) continue;
      const id = Number(idStr);
      kwCounts.set(id, (kwCounts.get(id) || 0) + 1);
    }
  }
  return [...kwCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN || 4).map(([id]) => DATA.dicts.keyword[id]).join(', ');
}
function attachMode(rows, idxArr, colName, modeCol) {
  const col = DATA.cols[colName];
  const col2 = DATA.cols[modeCol];
  const dict2 = DATA.dicts[modeCol];
  rows.forEach(r => {
    const modeCounts = new Map();
    const matchIdx = [];
    for (const i of idxArr) {
      if (col[i] !== r.key) continue;
      matchIdx.push(i);
      const v2 = col2[i];
      modeCounts.set(v2, (modeCounts.get(v2) || 0) + 1);
    }
    let bestK = null, bestC = -1;
    for (const [k, c] of modeCounts.entries()) { if (c > bestC) { bestC = c; bestK = k; } }
    r.modeLabel = (bestK == null || bestK === -1) ? null : dict2[bestK];
    r.keywordPhrase = keywordPhraseFor(matchIdx);
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
        <td>${escapeHtml(r.label)}${r.delta >= 0 ? growthBadgeHtml(r.pct) : declineBadgeHtml(r.pct)}${r.modeLabel ? `<div class="r-sub">${escapeHtml(opts.modeLabel || 'Чаще всего жалуются')}: «${escapeHtml(r.modeLabel)}»</div>` : ''}${r.keywordPhrase ? `<div class="r-sub r-sub-kw">Частые слова в обращениях: ${escapeHtml(r.keywordPhrase)}</div>` : ''}</td>
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
  const growthPodtema = attachMode(podtemaDyn.filter(r => r.delta > 0 && r.mainCount >= 5).sort((a, b) => b.mainCount - a.mainCount).slice(0, 6), mainIdx, 'podtema', 'fact');
  const declinePodtema = attachMode(podtemaDyn.filter(r => r.delta < 0 && r.compCount >= 5).sort((a, b) => b.mainCount - a.mainCount).slice(0, 6), mainIdx, 'podtema', 'fact');

  const kuratorDyn = isOverall ? attachMode(computeDynList(mainIdx, compIdx, 'kurator').sort((a, b) => b.mainCount - a.mainCount).slice(0, 8), mainIdx, 'kurator', 'fact') : [];

  const addrDyn = attachMode(computeDynList(mainAddr, compAddr, 'addr').sort((a, b) => b.mainCount - a.mainCount).slice(0, 8), mainAddr, 'addr', 'fact');
  const addrGrowth = attachMode(computeDynList(mainAddr, compAddr, 'addr').filter(r => r.delta > 0 && r.mainCount >= 5).sort((a, b) => b.mainCount - a.mainCount).slice(0, 4), mainAddr, 'addr', 'fact');

  const topEmails = topWithMode(mainIdx, 'email', 'fact', 10, { excludeNull: true });

  const factsTop = attachMode(computeDynList(mainIdx, compIdx, 'fact').sort((a, b) => b.mainCount - a.mainCount).slice(0, 8), mainIdx, 'fact', 'addr');

  const naprTop = countBy(mainIdx, 'napr').slice(0, 5);
  const istochnikTop = countBy(mainIdx, 'istochnik').slice(0, 8);
  const tipTop = countBy(mainIdx, 'tip').slice(0, 5);

  // "What's actually behind the numbers" phrases — used in section intros instead of methodology explanations
  const addrThemePhrase = topThemePhrase(mainAddr, 'podtema', 2);
  const growthKeySet = new Set(growthPodtema.map(r => r.key));
  const growthFactPhrase = growthKeySet.size ? topThemePhrase(mainIdx.filter(i => growthKeySet.has(DATA.cols.podtema[i])), 'fact', 2) : '';
  const emailThemePhrase = topThemePhrase(mainIdx, 'podtema', 2);
  const kuratorThemePhrase = kuratorDyn.length ? kuratorDyn[0].modeLabel : '';

  // ---- per-section conclusions: shown at the end of each section AND consolidated in "Итог" ----
  const sectionConclusions = [];
  function blockConclusion(text) {
    sectionConclusions.push(text);
    return `<div class="r-callout r-callout-mini"><div class="r-callout-icon">→</div><div class="r-callout-text"><strong>Вывод:</strong> ${text}</div></div>`;
  }
  const podtemaConclusion = (growthPodtema.length || declinePodtema.length)
    ? `${growthPodtema.length ? `наибольший рост — «${escapeHtml(growthPodtema[0].label)}» (${fmtNum(growthPodtema[0].mainCount)}, ${pctText(growthPodtema[0].pct)})` : ''}${growthPodtema.length && declinePodtema.length ? '; ' : ''}${declinePodtema.length ? `наибольшее снижение — «${escapeHtml(declinePodtema[0].label)}» (${fmtNum(declinePodtema[0].mainCount)}, ${pctText(declinePodtema[0].pct)})` : ''}.`
    : 'значимых изменений по подтемам не выявлено.';
  const kuratorConclusion = kuratorDyn.length
    ? `больше всего обращений у куратора «${escapeHtml(kuratorDyn[0].label)}» — ${fmtNum(kuratorDyn[0].mainCount)} (${total ? Math.round(kuratorDyn[0].mainCount / total * 1000) / 10 : 0}% от общего числа).`
    : '';
  const addrConclusion = addrDyn.length
    ? `больше всего обращений по адресу «${escapeHtml(addrDyn[0].label)}» — ${fmtNum(addrDyn[0].mainCount)}${addrGrowth.length ? `; резче всего вырос адрес «${escapeHtml(addrGrowth[0].label)}» (${pctText(addrGrowth[0].pct)})` : ''}.`
    : 'адресов с указанной улицей за период не найдено.';
  const emailConclusion = topEmails.length
    ? `самый активный заявитель — ${escapeHtml(topEmails[0].label)} (${topEmails[0].count} ${pluralRu(topEmails[0].count, ['обращение', 'обращения', 'обращений'])}).`
    : '';
  const razbivkaConclusion = (naprTop.length || istochnikTop.length)
    ? `основное направление — «${naprTop.length ? escapeHtml(naprTop[0].label) : '—'}»${istochnikTop.length ? `, основной источник — «${escapeHtml(istochnikTop[0].label)}» (${total ? Math.round(istochnikTop[0].count / total * 1000) / 10 : 0}% от общего числа)` : ''}.`
    : '';

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

  // ---- plain-data model for PPTX export (no HTML markup) ----
  const stripHtml = s => String(s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const reportModel = {
    omsu: DATA.omsu, titleMain, scopeTitle, periodTxt, compTxt,
    total, totalComp, dynPct: dyn.pct, dynDelta: dyn.delta, resolvedPct,
    takeaways: takeaways.map(stripHtml),
    growthPodtema: growthPodtema.map(r => ({ label: r.label, main: r.mainCount, comp: r.compCount, pct: r.pct, mode: r.modeLabel, kw: r.keywordPhrase })),
    declinePodtema: declinePodtema.map(r => ({ label: r.label, main: r.mainCount, comp: r.compCount, pct: r.pct, mode: r.modeLabel, kw: r.keywordPhrase })),
    factsTop: factsTop.map(r => ({ label: r.label, main: r.mainCount, comp: r.compCount, pct: r.pct, mode: r.modeLabel, kw: r.keywordPhrase })),
    kuratorDyn: kuratorDyn.map(r => ({ label: r.label, main: r.mainCount, comp: r.compCount, pct: r.pct, mode: r.modeLabel, kw: r.keywordPhrase })),
    addrDyn: addrDyn.map(r => ({ label: r.label, main: r.mainCount, comp: r.compCount, pct: r.pct, mode: r.modeLabel, kw: r.keywordPhrase })),
    addrGrowth: addrGrowth.map(r => ({ label: r.label, main: r.mainCount, comp: r.compCount, pct: r.pct, mode: r.modeLabel, kw: r.keywordPhrase })),
    topEmails: topEmails.map(r => ({ label: r.label, count: r.count, mode: r.modeLabel, kw: r.keywordPhrase })),
    naprTop: naprTop.map(r => ({ label: r.label, count: r.count })),
    istochnikTop: istochnikTop.map(r => ({ label: r.label, count: r.count })),
    tipTop: tipTop.map(r => ({ label: r.label, count: r.count })),
    isOverall,
    sectionConclusions: sectionConclusions.map(stripHtml),
  };

  // ---- assemble HTML ----
  const html = `
  <div class="report-scope">
    <div class="r-toolbar no-print">
      <button type="button" class="r-print-btn" id="r-pptx-btn">📊 Экспорт PPTX</button>
      <button type="button" class="r-print-btn" id="r-print-btn">🖨 Печать / PDF</button>
    </div>

    <header class="r-header">
      <div>
        <div class="r-meta">Дашборд обращений граждан · Аналитическая справка · ${new Date().toLocaleDateString('ru-RU')}</div>
        <h1>${escapeHtml(DATA.omsu)} <span>· ${escapeHtml(titleMain)}</span></h1>
        <div class="r-header-sub">Анализ обращений за период ${periodTxt} в сравнении с ${compTxt}. Срез: ${escapeHtml(scopeTitle)}.</div>
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
        <div><h3>Наибольший прирост</h3>${dynTableHtml(growthPodtema, 'Подтема', { modeLabel: 'Чаще всего жалуются' })}</div>
        <div><h3>Наибольшее снижение</h3>${dynTableHtml(declinePodtema, 'Подтема', { modeLabel: 'Чаще всего жалуются' })}</div>
      </div>
      <h3>Топ фактов</h3>
      ${dynTableHtml(factsTop, 'Факт', { modeLabel: 'Адрес' })}
      ${blockConclusion(podtemaConclusion)}
    </div>

    ${isOverall ? `
    <div class="r-block">
      <div class="r-tag"><span class="n">04</span> Кураторы</div>
      <h2>Рейтинг кураторов по объёму</h2>
      <p class="r-desc">${kuratorThemePhrase ? `У куратора-лидера чаще всего жители жалуются на ${kuratorThemePhrase}.` : 'Кураторы с наибольшим объёмом обращений за основной период.'}</p>
      ${dynTableHtml(kuratorDyn, 'Куратор', { modeLabel: 'Чаще всего жалуются' })}
      ${blockConclusion(kuratorConclusion)}
    </div>` : ''}

    <div class="r-block">
      <div class="r-tag"><span class="n">05</span> Адреса</div>
      <h2>Адреса — объём и точки роста</h2>
      <p class="r-desc">${addrThemePhrase ? `По адресам-лидерам чаще всего фигурируют жалобы на ${addrThemePhrase}. Справа — адреса с резким приростом обращений, потенциальные новые проблемные точки.` : 'Адреса с наибольшим числом обращений и наибольшим приростом.'}</p>
      <div class="r-grid2">
        <div><h3>По объёму</h3>${dynTableHtml(addrDyn, 'Адрес', { modeLabel: 'Чаще всего жалуются' })}</div>
        <div><h3>Резкий прирост</h3>${dynTableHtml(addrGrowth, 'Адрес', { modeLabel: 'Чаще всего жалуются' })}</div>
      </div>
      ${blockConclusion(addrConclusion)}
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">06</span> Заявители</div>
      <h2>Активные заявители</h2>
      <p class="r-desc">${emailThemePhrase ? `Чаще всего активные заявители пишут по теме ${emailThemePhrase}.` : 'Топ-10 заявителей по количеству обращений за основной период.'}</p>
      <div class="r-cards-grid">
        <div class="r-info-card">
          <div class="r-info-card-meta">Топ-10 заявителей · ${escapeHtml(scopeTitle)}</div>
          ${topEmails.map((e, i) => `<div class="r-info-row"><span class="r-info-rank">${String(i + 1).padStart(2, '0')}</span><span class="r-info-text"><span class="r-info-email" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</span>${e.modeLabel ? `<div class="r-sub">Чаще всего жалуется: «${escapeHtml(e.modeLabel)}»</div>` : ''}${e.keywordPhrase ? `<div class="r-sub r-sub-kw">Частые слова: ${escapeHtml(e.keywordPhrase)}</div>` : ''}</span><span class="r-info-count">${e.count}</span></div>`).join('') || '<div class="empty-note">Нет данных</div>'}
        </div>
      </div>
      ${blockConclusion(emailConclusion)}
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">07</span> Разбивка</div>
      <h2>Направления, источники, тип сообщения</h2>
      <p class="r-desc">${naprTop.length ? `Больше всего обращений приходится на направление «${escapeHtml(naprTop[0].label)}»${istochnikTop.length ? `, основной канал поступления — «${escapeHtml(istochnikTop[0].label)}»` : ''}.` : ''}</p>
      <h3>По источникам</h3>
      <div class="r-grid2">
        <div>${sourceStatusTableHtml(mainIdx, compIdx)}</div>
        <div>${svgPieChart(istochnikTop, 180)}</div>
      </div>
      <h3>Направления</h3>${barTableHtml(naprTop)}
      <h3>Тип сообщения</h3>${barTableHtml(tipTop)}
      ${blockConclusion(razbivkaConclusion)}
    </div>

    <div class="r-block">
      <div class="r-tag"><span class="n">08</span> Итог</div>
      <h2>Итоговая сводка</h2>
      <p class="r-desc">Все выводы по разделам справки — в одном месте, по срезу «${escapeHtml(scopeTitle)}» за ${periodTxt}.</p>
      <div class="r-callout ${dyn.delta >= 0 ? 'bad' : ''}">
        <div class="r-callout-icon">${dyn.delta >= 0 ? '↑' : '↓'}</div>
        <div class="r-callout-text"><strong>Общая динамика:</strong> обращения по срезу «${escapeHtml(scopeTitle)}» ${dyn.delta >= 0 ? 'выросли' : 'снизились'} с ${fmtNum(totalComp)} до ${fmtNum(total)} (${pctText(dyn.pct)}).</div>
      </div>
      ${sectionConclusions.map((t, i) => `<div class="r-takeaway"><div class="r-takeaway-num">${String(i + 1).padStart(2, '0')}</div><div class="r-takeaway-text">${t}</div></div>`).join('')}
    </div>

    <div class="r-footer">Дашборд обращений граждан · ${escapeHtml(DATA.omsu)} · Отчётный период: ${periodTxt} в сопоставлении с ${compTxt} · Срез: ${escapeHtml(scopeTitle)} · Сформировано ${new Date().toLocaleString('ru-RU')}</div>
  </div>`;

  root.innerHTML = html;
  const printBtn = document.getElementById('r-print-btn');
  if (printBtn) printBtn.addEventListener('click', () => window.print());
  window.__lastReportModel = reportModel;
  const pptxBtn = document.getElementById('r-pptx-btn');
  if (pptxBtn) pptxBtn.addEventListener('click', () => exportReportPptx(reportModel));
}

function barTableHtml(rows) {
  if (!rows.length) return `<div class="empty-note">Нет данных</div>`;
  const max = rows[0].count;
  return `<div class="r-table-wrap"><table>
    <thead><tr><th>Значение</th><th style="width:90px">Кол-во</th><th style="width:80px">Доля</th></tr></thead>
    <tbody>${rows.map(o => `<tr><td>${escapeHtml(o.label)}</td><td class="r-num">${fmtNum(o.count)}</td><td class="r-num">${Math.round(o.count / max * 100)}%</td></tr>`).join('')}</tbody>
  </table></div>`;
}

const PIE_COLORS = ['#4f8cff', '#38bdf8', '#22c55e', '#f5b942', '#a78bfa', '#f5455c', '#fb923c', '#94a3b8', '#2dd4bf', '#f472b6'];

function svgPieChart(items, size) {
  size = size || 200;
  const total = items.reduce((s, o) => s + o.count, 0);
  if (!total) return `<div class="empty-note">Нет данных</div>`;
  const r = size / 2, cx = r, cy = r;
  let angle = -Math.PI / 2;
  const paths = items.map((o, i) => {
    const frac = o.count / total;
    const a0 = angle;
    const a1 = angle + frac * Math.PI * 2;
    angle = a1;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    if (frac >= 0.999) {
      return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>`;
    }
    return `<path d="M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${color}" stroke="#fff" stroke-width="1.5"/>`;
  }).join('');
  const legend = items.map((o, i) => `
    <div class="r-pie-legend-row">
      <span class="r-pie-swatch" style="background:${PIE_COLORS[i % PIE_COLORS.length]}"></span>
      <span class="r-pie-label">${escapeHtml(o.label)}</span>
      <span class="r-pie-val">${fmtNum(o.count)} · ${Math.round(o.count / total * 100)}%</span>
    </div>`).join('');
  return `<div class="r-pie-wrap">
    <svg viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px;flex:none;">${paths}</svg>
    <div class="r-pie-legend">${legend}</div>
  </div>`;
}

// Источник × статус: кол-во / динамика / в работе / отработано / % отработки — как в примере ЦУР-справки
function sourceStatusTableHtml(mainIdx, compIdx) {
  const rows = computeDynList(mainIdx, compIdx, 'istochnik').sort((a, b) => b.mainCount - a.mainCount);
  if (!rows.length) return `<div class="empty-note">Нет данных</div>`;
  const col = DATA.cols.istochnik, statusCol = DATA.cols.status;
  rows.forEach(r => {
    let resolved = 0, total = 0;
    for (const i of mainIdx) {
      if (col[i] !== r.key) continue;
      total++;
      if (RESOLVED_STATUS_IDX.has(statusCol[i])) resolved++;
    }
    r.resolved = resolved;
    r.inWork = total - resolved;
    r.resolvedPct = total ? Math.round(resolved / total * 1000) / 10 : 0;
  });
  return `<div class="r-table-wrap"><table>
    <thead><tr><th>Источник</th><th style="width:70px">Кол-во</th><th style="width:78px">Динамика</th><th style="width:70px">В работе</th><th style="width:80px">Отработано</th><th style="width:90px">% отработки</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${escapeHtml(r.label)}</td>
      <td class="r-num">${fmtNum(r.mainCount)}</td>
      <td class="r-delta ${r.delta >= 0 ? 'bad' : 'good'}">${pctText(r.pct)}</td>
      <td class="r-num">${fmtNum(r.inWork)}</td>
      <td class="r-num">${fmtNum(r.resolved)}</td>
      <td class="r-num">${r.resolvedPct}%</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}


function buildExportRows(idxArr) {
  const cols = ['ecur', 'numsrc', 'date', 'napr', 'sint', 'fact', 'podtema', 'status', 'kurator', 'ispolnitel', 'tip', 'istochnik', 'uk', 'addr', 'naspunkt', 'rayon', 'email', 'spam', 'overdue', 'hasRepeats', 'repeats', 'hasDelay', 'delayCount'];
  const headers = ['Номер ЕЦУР', 'Номер в источнике', 'Дата', 'Направление', 'Синт.группа', 'Факт', 'Подтема', 'Статус', 'Куратор', 'Исполнитель', 'Тип сообщения', 'Источник', 'УК', 'Адрес', 'Населённый пункт', 'Район', 'Почта заявителя', 'Спам', 'Просрочка', 'Есть повторы', 'Кол-во повторов', 'Есть отложки', 'Кол-во отложенных решений'];
  const plainCols = new Set(['ecur', 'numsrc', 'repeats', 'delayCount']);
  const rows = [headers];
  for (const i of idxArr) {
    rows.push(cols.map(c => {
      if (c === 'date') return fmtDateRu(dayToISO(DATA.cols.date[i]));
      if (plainCols.has(c)) return DATA.cols[c][i] ?? '';
      const v = DATA.cols[c][i];
      return v === -1 ? '' : DATA.dicts[c][v];
    }));
  }
  return rows;
}

/* ================= Report -> PPTX export (hand-built minimal OOXML via JSZip) ================= */
function pxmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function pptxBulletXml(text, opts) {
  opts = opts || {};
  const sz = opts.sz || 1400;
  const bold = opts.bold ? ' b="1"' : '';
  const color = opts.color ? `<a:solidFill><a:srgbClr val="${opts.color}"/></a:solidFill>` : '';
  const bullet = opts.noBullet ? '<a:buNone/>' : '<a:buFont typeface="Arial"/><a:buChar char="\u2022"/>';
  const indentAttr = opts.noBullet ? '' : ' marL="228600" indent="-228600"';
  const spcAttr = opts.spaceBefore ? `<a:spcBef><a:spcPts val="${opts.spaceBefore}"/></a:spcBef>` : '';
  const rPr = color
    ? `<a:rPr lang="ru-RU" sz="${sz}"${bold} dirty="0">${color}</a:rPr>`
    : `<a:rPr lang="ru-RU" sz="${sz}"${bold} dirty="0"/>`;
  return `<a:p><a:pPr${indentAttr}>${spcAttr}${bullet}</a:pPr><a:r>${rPr}<a:t>${pxmlEscape(text)}</a:t></a:r></a:p>`;
}
function pptxSlideXml(title, bodyParagraphsXml, footerText) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="9" name="HeaderBand"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="1028700"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="06223F"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ru-RU"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="8" name="AccentRule"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="1028700"/><a:ext cx="12192000" cy="38100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="38BDF8"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ru-RU"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="257175"/><a:ext cx="11277600" cy="600075"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU" sz="2600" b="1" dirty="0"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr><a:t>${pxmlEscape(title)}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1257300"/><a:ext cx="11277600" cy="5257800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr><a:normAutofit fontScale="85000" lnSpcReduction="10000"/></a:bodyPr><a:lstStyle/>${bodyParagraphsXml}</p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="7" name="Footer"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="6629400"/><a:ext cx="11277600" cy="182880"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ru-RU" sz="900" dirty="0"><a:solidFill><a:srgbClr val="94A3B8"/></a:solidFill></a:rPr><a:t>${pxmlEscape(footerText || '')}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`;
}

function pptxRankLines(rows, opts) {
  opts = opts || {};
  return rows.map((r, i) => {
    const main = `${String(i + 1).padStart(2, '0')}. ${r.label} — ${fmtNum(r.main != null ? r.main : r.count)}${r.comp != null ? ` (было ${fmtNum(r.comp)}, ${pctText(r.pct)})` : ''}`;
    let out = pptxBulletXml(main, { sz: 1300 });
    if (r.mode) out += pptxBulletXml(`Чаще всего жалуются: «${r.mode}»`, { sz: 1050, noBullet: true, color: '5C7AA3' });
    if (r.kw) out += pptxBulletXml(`Частые слова: ${r.kw}`, { sz: 1050, noBullet: true, color: '1456A8' });
    return out;
  }).join('');
}

function buildReportSlides(m) {
  const slides = [];
  // 1. title
  slides.push({
    title: `${m.omsu} · ${m.titleMain}`,
    body: [
      pptxBulletXml(`Период: ${m.periodTxt}`, { noBullet: true, sz: 1600 }),
      pptxBulletXml(`Сравнение: ${m.compTxt}`, { noBullet: true, sz: 1600 }),
      pptxBulletXml(`Срез: ${m.scopeTitle}`, { noBullet: true, sz: 1600 }),
      pptxBulletXml(`Всего обращений: ${fmtNum(m.total)} (${pctText(m.dynPct)} к сравнению)`, { noBullet: true, sz: 1600, bold: true }),
      pptxBulletXml(`Решено: ${m.resolvedPct}%`, { noBullet: true, sz: 1600 }),
    ].join(''),
  });
  // 2. takeaways
  slides.push({ title: 'Ключевые выводы', body: m.takeaways.map(t => pptxBulletXml(t, { sz: 1300 })).join('') });
  // 3. growth
  if (m.growthPodtema.length) slides.push({ title: 'Подтемы — наибольший прирост', body: pptxRankLines(m.growthPodtema) });
  if (m.declinePodtema.length) slides.push({ title: 'Подтемы — наибольшее снижение', body: pptxRankLines(m.declinePodtema) });
  if (m.factsTop.length) slides.push({ title: 'Топ фактов', body: pptxRankLines(m.factsTop) });
  if (m.isOverall && m.kuratorDyn.length) slides.push({ title: 'Рейтинг кураторов по объёму', body: pptxRankLines(m.kuratorDyn) });
  if (m.addrDyn.length) slides.push({ title: 'Адреса — по объёму', body: pptxRankLines(m.addrDyn) });
  if (m.addrGrowth.length) slides.push({ title: 'Адреса — резкий прирост', body: pptxRankLines(m.addrGrowth) });
  if (m.topEmails.length) slides.push({ title: 'Активные заявители', body: pptxRankLines(m.topEmails) });
  const razbBody = [
    pptxBulletXml('Направления', { bold: true, sz: 1300 }),
    ...m.naprTop.map(r => pptxBulletXml(`${r.label} — ${fmtNum(r.count)}`, { sz: 1150 })),
    pptxBulletXml('Источники', { bold: true, sz: 1300, spaceBefore: 1200 }),
    ...m.istochnikTop.map(r => pptxBulletXml(`${r.label} — ${fmtNum(r.count)}`, { sz: 1150 })),
  ].join('');
  slides.push({ title: 'Направления и источники', body: razbBody });
  // final: итог
  const itogBody = [
    pptxBulletXml(`Обращения ${m.dynDelta >= 0 ? 'выросли' : 'снизились'} с ${fmtNum(m.totalComp)} до ${fmtNum(m.total)} (${pctText(m.dynPct)})`, { bold: true, sz: 1400 }),
    ...m.sectionConclusions.map(t => pptxBulletXml(t, { sz: 1250 })),
  ].join('');
  slides.push({ title: 'Итоговая сводка', body: itogBody });
  return slides;
}

const PPTX_CONTENT_TYPES = (n) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${Array.from({ length: n }, (_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}</Types>`;

const PPTX_ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const PPTX_CORE_XML = (title) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${pxmlEscape(title)}</dc:title><dc:creator>Дашборд обращений граждан</dc:creator><cp:lastModifiedBy>Дашборд обращений граждан</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified></cp:coreProperties>`;

const PPTX_APP_XML = (n) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Дашборд обращений граждан</Application><Slides>${n}</Slides><PresentationFormat>On-screen Show (16:9)</PresentationFormat><TitlesOfParts><vt:vector size="${n}" baseType="lpstr">${Array.from({ length: n }, () => '<vt:lpstr>Slide</vt:lpstr>').join('')}</vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0000</AppVersion></Properties>`;

const PPTX_SLIDE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`;

const PPTX_PRESENTATION = (n) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster1"/></p:sldMasterIdLst><p:sldIdLst>${Array.from({ length: n }, (_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join('')}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

const PPTX_PRESENTATION_RELS = (n) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdMaster1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${Array.from({ length: n }, (_, i) => `<Relationship Id="rIdSlide${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`;

const PPTX_SLIDE_MASTER = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`;

const PPTX_SLIDE_MASTER_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`;

const PPTX_SLIDE_LAYOUT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sldLayout>`;

const PPTX_SLIDE_LAYOUT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;

const PPTX_THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Custom"><a:themeElements><a:clrScheme name="Custom"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="06223F"/></a:dk2><a:lt2><a:srgbClr val="E8EEF7"/></a:lt2><a:accent1><a:srgbClr val="1456A8"/></a:accent1><a:accent2><a:srgbClr val="B91C1C"/></a:accent2><a:accent3><a:srgbClr val="15803D"/></a:accent3><a:accent4><a:srgbClr val="A86600"/></a:accent4><a:accent5><a:srgbClr val="1D6FC4"/></a:accent5><a:accent6><a:srgbClr val="7F1414"/></a:accent6><a:hlink><a:srgbClr val="1456A8"/></a:hlink><a:folHlink><a:srgbClr val="7F1414"/></a:folHlink></a:clrScheme><a:fontScheme name="Custom"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Custom"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

async function exportReportPptx(model) {
  if (typeof JSZip === 'undefined') {
    alert('Не удалось загрузить библиотеку экспорта (нужен интернет для загрузки jszip.js). Попробуйте обновить страницу.');
    return;
  }
  const slides = buildReportSlides(model);
  const zip = new JSZip();
  zip.file('[Content_Types].xml', PPTX_CONTENT_TYPES(slides.length));
  zip.file('_rels/.rels', PPTX_ROOT_RELS);
  zip.file('docProps/core.xml', PPTX_CORE_XML(`${model.omsu} · ${model.titleMain}`));
  zip.file('docProps/app.xml', PPTX_APP_XML(slides.length));
  zip.file('ppt/presentation.xml', PPTX_PRESENTATION(slides.length));
  zip.file('ppt/_rels/presentation.xml.rels', PPTX_PRESENTATION_RELS(slides.length));
  zip.file('ppt/slideMasters/slideMaster1.xml', PPTX_SLIDE_MASTER);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', PPTX_SLIDE_MASTER_RELS);
  zip.file('ppt/slideLayouts/slideLayout1.xml', PPTX_SLIDE_LAYOUT);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', PPTX_SLIDE_LAYOUT_RELS);
  zip.file('ppt/theme/theme1.xml', PPTX_THEME);
  slides.forEach((s, i) => {
    zip.file(`ppt/slides/slide${i + 1}.xml`, pptxSlideXml(s.title, s.body, `${model.omsu} · ${i + 1} / ${slides.length}`));
    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, PPTX_SLIDE_RELS);
  });
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `spravka_${fmtDateRu(dayToISO(state.mainStart))}_${fmtDateRu(dayToISO(state.mainEnd))}.pptx`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportXlsx() {
  const idxArr = window.__lastMainIdx || [];
  const filename = `obrasheniya_${fmtDateRu(dayToISO(state.mainStart))}_${fmtDateRu(dayToISO(state.mainEnd))}.xlsx`;

  if (typeof XLSX === 'undefined') {
    alert('Не удалось загрузить библиотеку экспорта (нужен интернет для загрузки xlsx.js). Попробуйте обновить страницу.');
    return;
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildExportRows(idxArr)), 'Детализация');

  const overdueIdx = idxArr.filter(i => DATA.cols.overdue[i] === 1);
  const repeatsIdx = idxArr.filter(i => DATA.cols.hasRepeats[i] === 1);
  const delayIdx = idxArr.filter(i => DATA.cols.hasDelay[i] === 1);

  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildExportRows(overdueIdx)), 'Просрочки');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildExportRows(repeatsIdx)), 'Повторы');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildExportRows(delayIdx)), 'Отложки');

  XLSX.writeFile(wb, filename);
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
  document.getElementById('btnExport').addEventListener('click', exportXlsx);
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
