'use strict';

// ── State ─────────────────────────────────────────────────────────────────
let allResults  = [];
let activeTab   = 'all';
let scanType    = 'comprehensive';
let lastTF      = '1d';
let searchQuery = '';
let watchedSet  = new Set();
let dismissSet  = new Set();

// ── Theme ─────────────────────────────────────────────────────────────────
function applyTheme(light) {
  document.body.classList.toggle('light', light);
  document.getElementById('themeToggle').textContent = light ? '🌙' : '☀️';
}
function toggleTheme() {
  const isLight = !document.body.classList.contains('light');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');
  applyTheme(isLight);
}
applyTheme(localStorage.getItem('theme') === 'light');

// ── Clock ─────────────────────────────────────────────────────────────────
function updateClock() {
  const fmt = (o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...o }).format(new Date());
  document.getElementById('nyTime').textContent =
    `NY: ${fmt({weekday:'short',month:'short',day:'numeric'})}, ${fmt({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true})}`;

  const h   = parseInt(fmt({ hour:'numeric', hour12:false }));
  const m   = parseInt(fmt({ minute:'numeric' }));
  const day = fmt({ weekday:'short' });
  const el  = document.getElementById('marketStatus');
  const wk  = ['Sat','Sun'].includes(day);
  if      (!wk && ((h===9&&m>=30)||(h>9&&h<16))) { el.textContent='● MARKET OPEN'; el.className='market-badge open'; }
  else if (!wk && h>=4 && (h<9||(h===9&&m<30)))  { el.textContent='◑ PRE-MARKET';  el.className='market-badge pre';  }
  else if (!wk && h>=16 && h<20)                  { el.textContent='◑ AFTER HOURS'; el.className='market-badge pre';  }
  else                                            { el.textContent='● CLOSED';      el.className='market-badge closed'; }
}
updateClock();
setInterval(updateClock, 1000);

// ── Segment buttons ───────────────────────────────────────────────────────
function wireSegs(groupId, onSelect) {
  document.querySelectorAll(`#${groupId} .seg-btn`).forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(`#${groupId} .seg-btn`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onSelect(btn);
    });
  });
}
wireSegs('scanTypeGroup', btn => { scanType = btn.dataset.type; render(); });
wireSegs('tfGroup',       btn => { lastTF   = btn.dataset.tf; });

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.ftab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    render();
  });
});

// ── Market / Custom switch ────────────────────────────────────────────────
function switchMarket(mode) {
  document.getElementById('mtAll').classList.toggle('active',    mode === 'all');
  document.getElementById('mtCustom').classList.toggle('active', mode === 'custom');
  document.getElementById('allPanel').style.display    = mode === 'all'    ? '' : 'none';
  document.getElementById('customPanel').style.display = mode === 'custom' ? '' : 'none';
}

// ── Search ────────────────────────────────────────────────────────────────
function onSearch(v) { searchQuery = v.trim().toLowerCase(); render(); }

// ── Scan ──────────────────────────────────────────────────────────────────
async function startScan(force = false) {
  const timeframe = document.querySelector('#tfGroup .seg-btn.active').dataset.tf;
  const minScore  = parseInt(document.getElementById('minScore').value) || 40;
  const sector    = document.getElementById('sectorSel').value;
  const isCustom  = document.getElementById('mtCustom').classList.contains('active');
  const symRaw    = document.getElementById('symInput').value;
  const symbols   = isCustom ? symRaw.split(/[\n,]+/).map(s=>s.trim().toUpperCase()).filter(Boolean) : [];
  lastTF = timeframe;

  setLoading(true);
  try {
    const res  = await fetch('/api/scan', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ timeframe, min_score: minScore, sector, symbols, force }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    allResults = data.results;
    updateStats(data);
    populateStockList(data.results);

    document.getElementById('statsTop').style.display  = 'grid';
    document.getElementById('filterBar').style.display = 'flex';
    document.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
    document.querySelector('.ftab[data-tab="all"]').classList.add('active');
    activeTab = 'all';
    render();
  } catch (err) {
    document.getElementById('cardsArea').innerHTML = `<div class="error-msg">❌ ${err.message}</div>`;
  } finally {
    setLoading(false);
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────
function updateStats(d) {
  document.getElementById('sAnalyzed').textContent = d.total_scanned;
  document.getElementById('sStrong').textContent   = d.strong_count;
  document.getElementById('sTime').textContent     = d.timestamp;

  const trend = d.bullish_count > d.bearish_count ? 'Bullish' : d.bearish_count > d.bullish_count ? 'Bearish' : 'Mixed';
  const te = document.getElementById('sTrend');
  te.textContent = (trend === 'Bullish' ? '▲ ' : trend === 'Bearish' ? '▼ ' : '● ') + trend;
  te.className   = 'sb-trend ' + (trend === 'Bullish' ? 'bull' : trend === 'Bearish' ? 'bear' : '');

  document.getElementById('cacheTag').style.display = d.from_cache ? 'inline-block' : 'none';
}

// ── Sidebar stock list ────────────────────────────────────────────────────
function populateStockList(results) {
  const wrap = document.getElementById('stockList');
  document.getElementById('slCount').textContent = `(${results.length})`;
  if (!results.length) { wrap.innerHTML = '<div class="sl-empty">No results</div>'; return; }
  wrap.innerHTML = results.map(r => `
    <div class="sl-item ${r.direction==='Bullish'?'bull':'bear'}" onclick="scrollToCard('${r.symbol}')">
      <span class="sl-sym">${r.symbol}</span>
      <span class="sl-name">${r.name||''}</span>
      <span class="sl-score ${r.score>=70?'high':''}">${r.score}</span>
    </div>`).join('');
}

function scrollToCard(symbol) {
  const el = document.getElementById(`card_${symbol}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── Filter & Render ───────────────────────────────────────────────────────
function getFiltered() {
  let list = allResults.filter(r => !dismissSet.has(r.symbol));
  switch (activeTab) {
    case 'bullish': list = list.filter(r => r.direction==='Bullish'); break;
    case 'bearish': list = list.filter(r => r.direction==='Bearish'); break;
    case 's80':     list = list.filter(r => r.score>=80); break;
    case 'strong':  list = list.filter(r => ['Strong Buy','Buy'].includes(r.tv_rating)); break;
    case 'open':    list = list.filter(r => watchedSet.has(r.symbol)); break;
  }
  switch (scanType) {
    case 'trend':    list = list.filter(r => r.ema_score>=70); break;
    case 'reversal': list = list.filter(r => r.rsi<38||r.rsi>62); break;
  }
  if (searchQuery) list = list.filter(r => r.symbol.toLowerCase().includes(searchQuery) || (r.name||'').toLowerCase().includes(searchQuery));
  return list;
}

function render() {
  const wrap = document.getElementById('cardsArea');
  const key  = document.getElementById('sortSel').value;
  const list = [...getFiltered()].sort((a,b) => (b[key]||0) - (a[key]||0));

  if (!list.length) { wrap.innerHTML = '<div class="empty-msg">🔍 No results match your filters.</div>'; return; }

  // Watched cards float to top
  const ordered = [...list.filter(r=>watchedSet.has(r.symbol)), ...list.filter(r=>!watchedSet.has(r.symbol))];
  wrap.innerHTML = `<div class="cards-grid">${ordered.map(buildCard).join('')}</div>`;
}

// ── Pattern Tags ──────────────────────────────────────────────────────────
function getPatterns(r) {
  const t = [];
  if (r.vol_ratio >= 1.3) t.push({ label:`Vol +${Math.round((r.vol_ratio-1)*100)}%`, cls:'' });
  if (r.ema_score >= 85)  t.push({ label:'EMA Aligned', cls:'green' });
  if (r.ema200 && r.price>r.ema20 && r.ema20>r.ema50 && r.ema50>r.ema200) t.push({ label:'All EMAs Bull', cls:'green' });
  if (r.ema200 && r.price<r.ema20 && r.ema20<r.ema50 && r.ema50<r.ema200) t.push({ label:'All EMAs Bear', cls:'red' });
  if (r.macd > r.macd_signal && r.macd_score>=75) t.push({ label:'MACD Cross ▲', cls:'blue' });
  if (r.macd < r.macd_signal && r.macd_score<=30) t.push({ label:'MACD Cross ▼', cls:'red' });
  if (r.rsi < 30)  t.push({ label:'RSI Oversold',   cls:'red' });
  if (r.rsi > 70)  t.push({ label:'RSI Overbought', cls:'' });
  if (r.rsi>=50 && r.rsi<=65) t.push({ label:'RSI Bullish', cls:'green' });
  if (r.rsi>=35 && r.rsi<50)  t.push({ label:'RSI Bearish', cls:'red' });
  if (r.tv_rating==='Strong Buy')  t.push({ label:'TV: Strong Buy',  cls:'purple' });
  if (r.tv_rating==='Strong Sell') t.push({ label:'TV: Strong Sell', cls:'red' });
  if (r.score>=80) t.push({ label:'High Confidence', cls:'purple' });
  return t;
}

// ── Build Card ────────────────────────────────────────────────────────────
function buildCard(r) {
  const dc    = r.direction==='Bullish'?'bull':r.direction==='Bearish'?'bear':'neutral';
  const chgCl = r.change_pct>0?'bull':r.change_pct<0?'bear':'';
  const chgS  = r.change_pct>0?'+':'';
  const isW   = watchedSet.has(r.symbol);
  const mult  = r.direction==='Bullish'?1:-1;
  const atr   = r.atr||0;
  const t1    = atr ? (r.entry + mult*1.0*atr).toFixed(2) : '';
  const t2    = atr ? (r.entry + mult*2.0*atr).toFixed(2) : '';
  const t3    = atr ? (r.entry + mult*3.0*atr).toFixed(2) : '';
  const stop  = atr ? (r.entry - mult*0.8*atr).toFixed(2) : '';
  const dist  = t2  ? Math.abs(((parseFloat(t2)-r.entry)/r.entry)*100).toFixed(1) : '—';

  const patterns = getPatterns(r);
  const tvLink   = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.tv_symbol||r.symbol)}`;

  return `
<div class="stock-card ${dc}${isW?' watched':''}" id="card_${r.symbol}">
  <div class="card-top">
    <div class="card-score-col">
      <div class="card-score ${dc}">${r.score}</div>
      <div class="card-dot ${dc}"></div>
    </div>
    <div class="card-info-col">
      <div class="card-badges">
        <span class="scan-type-tag">${scanType.charAt(0).toUpperCase()+scanType.slice(1)}</span>
        <span class="sector-tag">${r.sector||''}</span>
        ${isW?'<span class="watched-chip">📌 Watching</span>':''}
      </div>
      <div class="card-sym-row">
        <span class="card-sym">${r.symbol}</span>
        <span class="card-status ${dc}"></span>
        <span class="card-name">${r.name||''}</span>
      </div>
    </div>
    <div class="card-top-right">
      <span class="tv-badge ${r.tv_css||'tv-na'}">${r.tv_rating||'—'}</span>
      <span class="change-pct ${chgCl}">${chgS}${r.change_pct}%</span>
    </div>
  </div>

  <div class="card-sep"></div>

  <div class="card-metrics">
    <div class="cm">
      <span class="cm-label">EMA 20</span>
      <span class="cm-val ${r.price>r.ema20?'bull':'bear'}">${r.price>r.ema20?'↑ Above':'↓ Below'}</span>
    </div>
    <div class="cm">
      <span class="cm-label">EMA 50</span>
      <span class="cm-val ${r.ema20>r.ema50?'bull':'bear'}">${r.ema20>r.ema50?'↑ Bull':'↓ Bear'}</span>
    </div>
    <div class="cm">
      <span class="cm-label">RSI</span>
      <span class="cm-val ${r.rsi>60?'bull':r.rsi<40?'bear':''}">${r.rsi}</span>
    </div>
    <div class="cm">
      <span class="cm-label">MACD</span>
      <span class="cm-val ${r.macd>r.macd_signal?'bull':'bear'}">${r.macd>r.macd_signal?'↑ Bull':'↓ Bear'}</span>
    </div>
  </div>

  <div class="card-price-row">
    <span class="cp-label">Current Price:</span>
    <span class="cp-val">$${r.price.toLocaleString()}</span>
    <span class="cp-change ${chgCl}">${chgS}${r.change_pct}%</span>
  </div>

  <div class="card-targets">
    <div class="ct-row">
      <div class="ct-field">
        <div class="ct-label">✓ Entry Price</div>
        <input class="ct-input" id="en_${r.symbol}" value="${r.entry}">
      </div>
      <div class="ct-field">
        <div class="ct-label red">● Stop Loss</div>
        <input class="ct-input red-i" id="sl_${r.symbol}" value="${stop}" placeholder="—">
      </div>
      <button class="ct-calc-btn" onclick="calcTargets('${r.symbol}',${atr},'${r.direction}')">
        Calculate ↗
      </button>
    </div>
    <div class="ct-row">
      <div class="ct-field">
        <div class="ct-label green">🎯 Target 1</div>
        <input class="ct-input green-i" id="t1_${r.symbol}" value="${t1}" placeholder="—" readonly>
      </div>
      <div class="ct-field">
        <div class="ct-label green">🎯 Target 2</div>
        <input class="ct-input green-i" id="t2_${r.symbol}" value="${t2}" placeholder="—" readonly>
      </div>
      <div class="ct-field">
        <div class="ct-label green">🎯 Target 3</div>
        <input class="ct-input green-i" id="t3_${r.symbol}" value="${t3}" placeholder="—" readonly>
      </div>
    </div>
    <div class="ct-atr">ATR: $${r.atr} &nbsp;|&nbsp; R/R: 1:2 &nbsp;|&nbsp; Distance: ${dist}%</div>
  </div>

  <div class="card-patterns">
    ${patterns.map(p=>`<span class="pattern-tag ${p.cls}">${p.label}</span>`).join('')}
  </div>

  <div class="card-footer">
    <span class="cf-time">⏱ ${r.last_candle||'—'}</span>
    <div class="cf-actions">
      <a href="${tvLink}" target="_blank" rel="noopener" class="cf-btn chart-btn" title="Open chart in TradingView">📊 Chart</a>
      <button class="cf-btn${isW?' watch-active':''}" onclick="toggleWatch('${r.symbol}')" title="Watch">
        ${isW?'📌':'👁'} Watch
      </button>
      <button class="cf-btn danger" onclick="dismissCard('${r.symbol}')" title="Dismiss">✕</button>
    </div>
  </div>
</div>`;
}

// ── Card Actions ──────────────────────────────────────────────────────────
function calcTargets(symbol, atr, direction) {
  const entry = parseFloat(document.getElementById(`en_${symbol}`)?.value);
  if (!entry || !atr) return;
  const m = direction === 'Bullish' ? 1 : -1;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v.toFixed(2); };
  set(`sl_${symbol}`, entry - m * 0.8 * atr);
  set(`t1_${symbol}`, entry + m * 1.0 * atr);
  set(`t2_${symbol}`, entry + m * 2.0 * atr);
  set(`t3_${symbol}`, entry + m * 3.0 * atr);

  watchedSet.add(symbol);
  document.getElementById(`card_${symbol}`)?.classList.add('watched');
}

function toggleWatch(symbol) {
  watchedSet.has(symbol) ? watchedSet.delete(symbol) : watchedSet.add(symbol);
  render();
}

function dismissCard(symbol) {
  dismissSet.add(symbol);
  const el = document.getElementById(`card_${symbol}`);
  if (el) { el.style.opacity = '0'; el.style.transform = 'scale(.95)'; el.style.transition = 'all .2s'; setTimeout(() => render(), 200); }
}

function closeAllWatched() {
  watchedSet.clear();
  render();
}

// ── Loading ───────────────────────────────────────────────────────────────
function setLoading(on, isResearch = false) {
  document.getElementById('loadingOverlay').style.display = on ? 'flex' : 'none';
  const btn  = document.getElementById('mainBtn');
  btn.disabled = on;
  if (isResearch) {
    document.getElementById('mainBtnText').textContent    = on ? '⏳ RESEARCHING…' : '🔬 RUN RESEARCH';
    document.getElementById('overlayTitle').textContent   = 'Running Deep Research…';
    document.getElementById('overlaySub').textContent     = 'Fetching financials, earnings & news for each company';
    document.getElementById('overlayNote').textContent    = '⏱ ~2 sec per company · allow 30–60 sec total';
  } else {
    document.getElementById('mainBtnText').textContent    = on ? '⏳ SCANNING…' : '🔍 START SCAN';
    document.getElementById('overlayTitle').textContent   = 'Scanning US Markets…';
    document.getElementById('overlaySub').textContent     = 'Fetching real-time data · works market open or closed';
    document.getElementById('overlayNote').textContent    = '⏱ ~3 sec via TradingView · ~60 sec via Yahoo Finance';
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  MODE SWITCHING
// ══════════════════════════════════════════════════════════════════════════
let currentMode = 'scanner';

function switchMode(mode) {
  currentMode = mode;
  const isRes = mode === 'research';

  document.getElementById('modeScanner').classList.toggle('active',  !isRes);
  document.getElementById('modeResearch').classList.toggle('active',  isRes);

  document.getElementById('scannerPanel').style.display  = isRes ? 'none' : 'flex';
  document.getElementById('scannerPanel').style.flexDirection = 'column';
  document.getElementById('researchPanel').style.display = isRes ? 'flex' : 'none';
  document.getElementById('researchPanel').style.flexDirection = 'column';

  document.getElementById('scannerSide').style.display  = isRes ? 'none' : '';
  document.getElementById('researchSide').style.display = isRes ? '' : 'none';

  document.getElementById('mainBtnText').textContent = isRes ? '🔬 RUN RESEARCH' : '🔍 START SCAN';
  document.getElementById('refreshBtn').style.display = 'none';
}

function onMainBtn(force = false) {
  if (currentMode === 'research') startResearch(force);
  else startScan(force);
}

// ══════════════════════════════════════════════════════════════════════════
//  DEEP RESEARCH
// ══════════════════════════════════════════════════════════════════════════
let resResults   = [];
let resActiveTab = 'all';
let resSearch    = '';
let resMinScore  = 0;
let resDismissSet = new Set();

// Segment group for min grade
document.querySelectorAll('#resGradeGroup .seg-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#resGradeGroup .seg-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    resMinScore = parseInt(btn.dataset.grade) || 0;
    resRender();
  });
});

// Research tab buttons
document.querySelectorAll('[data-rtab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[data-rtab]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    resActiveTab = tab.dataset.rtab;
    resRender();
  });
});

function resOnSearch(v) { resSearch = v.trim().toLowerCase(); resRender(); }

async function startResearch(force = false) {
  const rawInput = document.getElementById('resSymInput').value.trim();
  const symbols  = rawInput
    ? rawInput.split(/[\n,]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];

  setLoading(true, true);
  try {
    const res  = await fetch('/api/research', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ symbols, force }),
    });
    if (!res.ok) throw new Error('Server error ' + res.status);
    const data = await res.json();

    resResults = data.results;
    updateResStats(data);

    document.getElementById('resStatsTop').style.display  = 'grid';
    document.getElementById('resFilterBar').style.display = 'flex';
    document.getElementById('refreshBtn').style.display   = '';
    document.querySelectorAll('[data-rtab]').forEach(t => t.classList.remove('active'));
    document.querySelector('[data-rtab="all"]').classList.add('active');
    resActiveTab = 'all';
    resRender();
  } catch (err) {
    document.getElementById('resCardsArea').innerHTML = '<div class="error-msg">Error: ' + err.message + '</div>';
  } finally {
    setLoading(false, true);
  }
}

function updateResStats(d) {
  document.getElementById('rTotal').textContent     = d.total;
  document.getElementById('rAGrade').textContent    = d.a_grade;
  document.getElementById('rCatalysts').textContent = d.has_catalysts;
  document.getElementById('rLaunches').textContent  = d.product_launches;
  document.getElementById('rTime').textContent      = d.timestamp;
  document.getElementById('resCacheTag').style.display = d.from_cache ? 'inline-block' : 'none';
}

function resFiltered() {
  let list = resResults.filter(r => !resDismissSet.has(r.symbol));
  switch (resActiveTab) {
    case 'agrade':   list = list.filter(r => ['A+','A'].includes(r.grade)); break;
    case 'catalyst': list = list.filter(r => r.catalysts && r.catalysts.length > 0); break;
    case 'launch':   list = list.filter(r => r.catalysts && r.catalysts.includes('launch')); break;
    case 'earnings': list = list.filter(r => r.earn_score >= 60); break;
  }
  if (resMinScore > 0)  list = list.filter(r => r.overall_score >= resMinScore);
  if (resSearch) list = list.filter(r =>
    r.symbol.toLowerCase().includes(resSearch) ||
    (r.name   || '').toLowerCase().includes(resSearch) ||
    (r.sector || '').toLowerCase().includes(resSearch)
  );
  return list;
}

function resRender() {
  const wrap  = document.getElementById('resCardsArea');
  const key   = document.getElementById('resSortSel').value;
  const list  = [...resFiltered()].sort((a, b) => (b[key] || 0) - (a[key] || 0));

  if (!list.length) {
    wrap.innerHTML = '<div class="empty-msg">No companies match the current filters.</div>';
    return;
  }
  wrap.innerHTML = '<div class="research-grid">' + list.map(buildResCard).join('') + '</div>';
}

// ── Catalyst emoji map ─────────────────────────────────────────────────────
const CAT_META = {
  launch:  { emoji: '🚀', label: 'Product Launch',      cls: 'cat-launch'  },
  partner: { emoji: '🤝', label: 'Partnership',         cls: 'cat-partner' },
  upgrade: { emoji: '⬆',  label: 'Analyst Upgrade',     cls: 'cat-upgrade' },
  approv:  { emoji: '✅', label: 'Regulatory Approval', cls: 'cat-approv'  },
  ma:      { emoji: '🏢', label: 'Acquisition / M&A',   cls: 'cat-ma'      },
};
const NEWS_TC_META = {
  launch:  { emoji: '🚀', cls: 'ni-launch'  },
  partner: { emoji: '🤝', cls: 'ni-partner' },
  upgrade: { emoji: '⬆',  cls: 'ni-upgrade' },
  approv:  { emoji: '✅', cls: 'ni-approv'  },
  ma:      { emoji: '🏢', cls: 'ni-ma'      },
  earn:    { emoji: '📊', cls: 'ni-earn'    },
  news:    { emoji: '📰', cls: 'ni-news'    },
};

function barCls(s) { return s >= 70 ? 'high' : s >= 45 ? 'mid' : 'low'; }

function buildResCard(r) {
  const pill = d => {
    const icon = d.s === 'good' ? '✓' : d.s === 'bad' ? '✗' : '~';
    return '<span class="dp ' + d.s + '"><span class="dp-k">' + d.k + '</span> <span class="dp-v">' + d.v + '</span> <span class="dp-i">' + icon + '</span></span>';
  };

  const newsItem = n => {
    const m = NEWS_TC_META[n.tc] || NEWS_TC_META.news;
    return '<div class="ni"><span class="ni-tag ' + m.cls + '">' + m.emoji + ' ' + n.tag + '</span>' +
      '<a href="' + n.url + '" target="_blank" rel="noopener" class="ni-title">' + n.title + '</a>' +
      '<span class="ni-age">' + n.age + '</span></div>';
  };

  const catalystHtml = (r.catalysts || []).map(c => {
    const m = CAT_META[c];
    return m ? '<span class="cat-chip ' + m.cls + '">' + m.emoji + ' ' + m.label + '</span>' : '';
  }).join('');

  const tvLink  = 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(r.symbol);
  const yfLink  = 'https://finance.yahoo.com/quote/' + r.symbol;

  return '<div class="research-card" id="rc_' + r.symbol + '">' +

    '<div class="rc-header">' +
      '<div class="rc-grade ' + r.grade_cls + '">' + r.grade + '</div>' +
      '<div class="rc-info">' +
        '<div class="rc-sym-row"><span class="rc-sym">' + r.symbol + '</span><span class="rc-name">' + r.name + '</span></div>' +
        '<div class="rc-meta">' +
          '<span>$' + r.price + '</span><span class="dot">·</span>' +
          '<span>' + r.market_cap + '</span>' +
          (r.pe_ratio ? '<span class="dot">·</span><span>P/E: ' + r.pe_ratio + '</span>' : '') +
          (r.div_yield ? '<span class="dot">·</span><span>Div: ' + r.div_yield + '%</span>' : '') +
        '</div>' +
        '<div style="display:flex;gap:5px;flex-wrap:wrap">' +
          '<span class="sector-tag">' + (r.sector || '') + '</span>' +
          (r.industry ? '<span class="industry-tag">' + r.industry + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="rc-overall">' +
        '<div class="rc-overall-num">' + r.overall_score + '</div>' +
        '<div class="rc-overall-label">Overall</div>' +
        '<div class="score-bar-track" style="width:80px"><div class="score-bar-fill ' + barCls(r.overall_score) + '" style="width:' + r.overall_score + '%"></div></div>' +
      '</div>' +
    '</div>' +

    (catalystHtml ? '<div class="rc-catalysts">' + catalystHtml + '</div>' : '') +

    '<div class="rc-section">' +
      '<div class="rc-sec-header"><span class="rc-sec-title">💰 Financial Health</span><span class="rc-sec-score ' + barCls(r.fin_score) + '">' + r.fin_score + '</span></div>' +
      '<div class="score-bar-track sm-bar"><div class="score-bar-fill ' + barCls(r.fin_score) + '" style="width:' + r.fin_score + '%"></div></div>' +
      '<div class="rc-pills">' + (r.fin_det || []).map(pill).join('') + '</div>' +
    '</div>' +

    '<div class="rc-section">' +
      '<div class="rc-sec-header"><span class="rc-sec-title">📈 Earnings Quality</span><span class="rc-sec-score ' + barCls(r.earn_score) + '">' + r.earn_score + '</span></div>' +
      '<div class="score-bar-track sm-bar"><div class="score-bar-fill ' + barCls(r.earn_score) + '" style="width:' + r.earn_score + '%"></div></div>' +
      '<div class="rc-pills">' + (r.earn_det || []).map(pill).join('') + '</div>' +
      (r.next_earn ? '<div class="rc-next-earn">📅 Next Earnings: ' + r.next_earn + '</div>' : '') +
    '</div>' +

    '<div class="rc-section">' +
      '<div class="rc-sec-header"><span class="rc-sec-title">📰 News & Catalysts</span><span class="rc-sec-score ' + barCls(r.news_score) + '">' + r.news_score + '</span></div>' +
      '<div class="score-bar-track sm-bar"><div class="score-bar-fill ' + barCls(r.news_score) + '" style="width:' + r.news_score + '%"></div></div>' +
      '<div class="rc-news">' + ((r.news_items || []).length ? r.news_items.map(newsItem).join('') : '<div class="no-news">No recent news found</div>') + '</div>' +
    '</div>' +

    '<div class="rc-footer">' +
      '<a href="' + tvLink + '" target="_blank" rel="noopener" class="rc-link-btn">📊 TradingView</a>' +
      '<a href="' + yfLink + '" target="_blank" rel="noopener" class="rc-link-btn">💹 Yahoo Finance</a>' +
      '<button class="rc-dismiss" onclick="ressDismiss(\'' + r.symbol + '\')">✕</button>' +
    '</div>' +

  '</div>';
}

function ressDismiss(symbol) {
  resDismissSet.add(symbol);
  const el = document.getElementById('rc_' + symbol);
  if (el) { el.style.opacity = '0'; el.style.transform = 'scale(.95)'; el.style.transition = 'all .2s'; setTimeout(resRender, 200); }
}
