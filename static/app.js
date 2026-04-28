'use strict';

// ── Scroll zone sizing ────────────────────────────────────────────────────
// Explicitly set the height of scroll zones in pixels so every browser
// shows a scrollbar correctly, regardless of CSS flex quirks.
function fitScrollZones() {
  const header  = document.querySelector('.header');
  const sticky  = document.querySelector('.sticky-bars');
  const sidebar = document.querySelector('.sidebar');

  const winH    = window.innerHeight;
  const headerH = header  ? header.offsetHeight  : 56;
  const stickyH = sticky  ? sticky.offsetHeight  : 0;
  const scrollH = Math.max(100, winH - headerH - stickyH);

  ['cardsArea','newsArea','reportArea','screenArea'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.height = scrollH + 'px';
  });
  if (sidebar) sidebar.style.height = winH + 'px';
}

window.addEventListener('load',   fitScrollZones);
window.addEventListener('resize', fitScrollZones);

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
    if (activeTab === 'news') {
      document.getElementById('cardsArea').style.display = 'none';
      document.getElementById('newsArea').style.display  = '';
      fetchNews();
    } else {
      document.getElementById('newsArea').style.display  = 'none';
      document.getElementById('cardsArea').style.display = '';
      render();
    }
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
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('Server returned an invalid response. Try again.'); }
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    allResults = data.results;
    updateStats(data);
    populateStockList(data.results);

    document.getElementById('statsTop').style.display  = 'grid';
    document.getElementById('filterBar').style.display = 'flex';
    document.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
    document.querySelector('.ftab[data-tab="all"]').classList.add('active');
    activeTab = 'all';
    render();
    // Recalculate after sticky-bars grows (stats + filter now visible)
    requestAnimationFrame(fitScrollZones);
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
function setLoading(on) {
  document.getElementById('loadingOverlay').style.display = on ? 'flex' : 'none';
  const btn = document.getElementById('scanBtn');
  if (btn) btn.disabled = on;
}

// ══════════════════════════════════════════════════════════════════════════
//  MODE SWITCHING  (Scanner | Analysis)
// ══════════════════════════════════════════════════════════════════════════
let currentMode = 'scanner';
let analysisTab = 'report';

function switchMode(mode) {
  currentMode = mode;
  document.getElementById('modeScanner').classList.toggle('active',  mode === 'scanner');
  document.getElementById('modeAnalysis').classList.toggle('active', mode === 'analysis');
  document.getElementById('scannerPanel').style.display  = mode === 'scanner'  ? '' : 'none';
  document.getElementById('analysisPanel').style.display = mode === 'analysis' ? '' : 'none';
  document.getElementById('scannerSide').style.display   = mode === 'scanner'  ? '' : 'none';
  document.getElementById('analysisSide').style.display  = mode === 'analysis' ? '' : 'none';
  const txt = document.getElementById('scanBtnText');
  if (mode === 'analysis') {
    txt.textContent = analysisTab === 'report' ? '🔍 RUN ANALYSIS' : '💎 FIND STOCKS';
    loadRegime();
  } else {
    txt.textContent = '🔍 START SCAN';
  }
  requestAnimationFrame(fitScrollZones);
}

function onSideBtn(force = false) {
  if (currentMode === 'analysis') {
    if (analysisTab === 'report') runAnalysis(force);
    else runValueScreen(force);
  } else {
    startScan(force);
  }
}

// Wire analysis sub-tabs
document.querySelectorAll('.a-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.a-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    analysisTab = tab.dataset.atab;
    document.getElementById('reportArea').style.display  = analysisTab === 'report' ? '' : 'none';
    document.getElementById('screenArea').style.display  = analysisTab === 'screen' ? '' : 'none';
    document.getElementById('reportSide').style.display  = analysisTab === 'report' ? '' : 'none';
    document.getElementById('screenSide').style.display  = analysisTab === 'screen' ? '' : 'none';
    const txt = document.getElementById('scanBtnText');
    txt.textContent = analysisTab === 'report' ? '🔍 RUN ANALYSIS' : '💎 FIND STOCKS';
    requestAnimationFrame(fitScrollZones);
  });
});

// ══════════════════════════════════════════════════════════════════════════
//  NEWS SECTION
// ══════════════════════════════════════════════════════════════════════════
let allNews    = [];
let newsCat    = 'all';
let newsSymFilter = 'all';
let newsFetched = false;

// Wire news category chips
document.querySelectorAll('.n-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.n-chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    newsCat = chip.dataset.ncat;
    renderNews();
  });
});

async function fetchNews(force = false) {
  const symbols = allResults.slice(0, 20).map(r => r.symbol);
  const feed    = document.getElementById('newsFeed');

  if (!symbols.length) {
    feed.innerHTML = `
      <div class="news-empty">
        <div class="news-empty-icon">📊</div>
        <div class="news-empty-title">Run a scan first</div>
        <div class="news-empty-desc">The News tab shows headlines for the stocks currently in your scanner results.</div>
      </div>`;
    return;
  }

  if (!force && newsFetched && allNews.length) { renderNews(); return; }

  feed.innerHTML = '<div class="news-loading"><div class="spinner" style="margin:0 auto 12px"></div>Fetching news…</div>';

  try {
    const res  = await fetch('/api/news', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ symbols, force }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('Server error — try again.'); }

    allNews     = data.news || [];
    newsFetched = true;

    // Populate stock filter dropdown
    const sel = document.getElementById('newsStockFilter');
    sel.innerHTML = '<option value="all">All Stocks</option>' +
      symbols.map(s => `<option value="${s}">${s}</option>`).join('');
    newsSymFilter = 'all';

    renderNews();
  } catch (err) {
    feed.innerHTML = `<div class="empty-msg">❌ ${err.message}</div>`;
  }
}

function renderNews() {
  const feed = document.getElementById('newsFeed');
  newsSymFilter = document.getElementById('newsStockFilter')?.value || 'all';

  let list = allNews;
  if (newsSymFilter !== 'all') list = list.filter(n => n.symbol === newsSymFilter);
  if (newsCat       !== 'all') list = list.filter(n => n.cat_cls === newsCat);

  document.getElementById('newsCount').textContent = list.length + ' articles';

  if (!list.length) {
    feed.innerHTML = `
      <div class="news-empty">
        <div class="news-empty-icon">📭</div>
        <div class="news-empty-title">No news found</div>
        <div class="news-empty-desc">Try "All" category or a different stock filter.</div>
      </div>`;
    return;
  }

  const CAT_EMOJI = {
    earn:'📊', launch:'🚀', upgrade:'⬆', deal:'🤝',
    approv:'✅', ma:'🏢', div:'💰', news:'📰',
  };

  feed.innerHTML = list.map(n => {
    const emoji = CAT_EMOJI[n.cat_cls] || '📰';
    const sent  = n.sentiment === 'pos' ? 'pos' : n.sentiment === 'neg' ? 'neg' : '';
    const thumb = n.thumb
      ? `<img class="ni-thumb" src="${n.thumb}" alt="" onerror="this.style.display='none'">`
      : '';
    return `
      <div class="news-item ${sent}">
        <div class="ni-sym">${n.symbol}</div>
        <div class="ni-body">
          <div class="ni-meta">
            <span class="ni-cat-tag nc-${n.cat_cls}">${emoji} ${n.cat}</span>
            <span class="ni-sep">·</span>
            <span class="ni-source">${n.source}</span>
            <span class="ni-time">${n.time_str}</span>
          </div>
          <a href="${n.url}" target="_blank" rel="noopener" class="ni-title">${n.title}</a>
        </div>
        ${thumb}
      </div>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════════════
//  ANALYSIS SECTION
// ══════════════════════════════════════════════════════════════════════════

// ── Market Regime badge ───────────────────────────────────────────────────
async function loadRegime() {
  try {
    const res  = await fetch('/api/regime');
    const data = await res.json();
    const el   = document.getElementById('regimeBadge');
    if (!el) return;
    const cls = data.score >= 55 ? 'regime-on' : data.score <= 45 ? 'regime-off' : 'regime-neu';
    el.textContent   = 'Market: ' + data.label + ' (' + data.score + ')';
    el.className     = 'regime-badge ' + cls;
    el.style.display = '';
  } catch (_) {}
}

// ── Stock Report ──────────────────────────────────────────────────────────
async function runAnalysis(force) {
  const sym = (document.getElementById('analysisSymbol').value || '').trim().toUpperCase();
  if (!sym) { alert('Enter a stock symbol first.'); return; }

  const area = document.getElementById('reportArea');
  area.innerHTML = '<div class="news-loading"><div class="spinner" style="margin:0 auto 14px"></div>Fetching data for ' + sym + '...</div>';
  const txt = document.getElementById('scanBtnText');
  txt.textContent = 'LOADING...';
  document.getElementById('scanBtn').disabled = true;

  try {
    const res  = await fetch('/api/analysis', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ symbol: sym, force: !!force }),
    });
    const text = await res.text();
    let d;
    try { d = JSON.parse(text); } catch(_) { throw new Error('Server error'); }
    if (d.error) throw new Error(d.error);
    area.innerHTML = buildReport(d);
    requestAnimationFrame(fitScrollZones);
  } catch (err) {
    area.innerHTML = '<div class="error-msg">Error: ' + err.message + '</div>';
  } finally {
    txt.textContent = 'RUN ANALYSIS';
    document.getElementById('scanBtn').disabled = false;
  }
}

// ── Value Screener ────────────────────────────────────────────────────────
async function runValueScreen(force) {
  const max_pe  = parseFloat(document.getElementById('maxPE').value)  || 15;
  const max_pb  = parseFloat(document.getElementById('maxPB').value)  || 3;
  const min_div = parseFloat(document.getElementById('minDiv').value) || 0;

  const area = document.getElementById('screenArea');
  area.innerHTML = '<div class="news-loading"><div class="spinner" style="margin:0 auto 14px"></div>Screening for undervalued stocks...</div>';
  document.getElementById('scanBtnText').textContent = 'SCREENING...';
  document.getElementById('scanBtn').disabled = true;

  try {
    const res  = await fetch('/api/undervalued', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ max_pe, max_pb, min_div, force: !!force }),
    });
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    area.innerHTML = buildScreenerTable(d.results, d.timestamp);
    requestAnimationFrame(fitScrollZones);
  } catch (err) {
    area.innerHTML = '<div class="error-msg">Error: ' + err.message + '</div>';
  } finally {
    document.getElementById('scanBtnText').textContent = 'FIND STOCKS';
    document.getElementById('scanBtn').disabled = false;
  }
}

// ── Helpers for report rendering ──────────────────────────────────────────
function _sig(v, good, bad, invert) {
  if (v === null || v === undefined) return 'muted';
  if (invert) return v <= good ? 'good' : v <= bad ? 'ok' : 'bad';
  return v >= good ? 'good' : v >= bad ? 'ok' : 'bad';
}
function _pctFmt(v) {
  if (v === null || v === undefined) return '<span style="color:var(--text3)">N/A</span>';
  const sign = v >= 0 ? '+' : '';
  const cls  = v >= 0 ? 'green' : 'red';
  return '<span class="' + cls + '">' + sign + (v * 100).toFixed(1) + '%</span>';
}
function _m(label, val, sig) {
  sig = sig || 'muted';
  return '<div class="ar-metric"><div class="ar-m-label">' + label +
    '</div><div class="ar-m-val ' + sig + '">' + (val !== null && val !== undefined ? val : 'N/A') + '</div></div>';
}

// ── Full report builder ───────────────────────────────────────────────────
function buildReport(d) {
  const dir    = d.direction === 'Bullish' ? 'bull' : d.direction === 'Bearish' ? 'bear' : 'neu';
  const chgCls = d.change_pct >= 0 ? 'green' : 'red';
  const chgS   = d.change_pct >= 0 ? '+' : '';

  // 52-week position (0-100%)
  const pct52 = (d.week52_high && d.week52_low && d.week52_high !== d.week52_low)
    ? Math.round((d.price - d.week52_low) / (d.week52_high - d.week52_low) * 100)
    : 50;

  // Buffett signals chips
  const bufSigs = (d.buffett_signals || []).map(function(s) {
    return '<span class="buf-sig ' + s.s + '">' + s.k + ': ' + s.v + '</span>';
  }).join('');

  // News items
  const CAT_E = {earn:'📊',launch:'🚀',upgrade:'⬆',deal:'🤝',approv:'✅',ma:'🏢',div:'💰',news:'📰'};
  const newsHtml = (d.news || []).length
    ? (d.news || []).map(function(n) {
        return '<div class="ni" style="margin-bottom:8px">' +
          '<span class="ni-cat-tag nc-' + n.cat_cls + '">' + (CAT_E[n.cat_cls] || '📰') + ' ' + n.cat + '</span>' +
          '<a href="' + n.url + '" target="_blank" rel="noopener" class="ni-title" style="margin-left:8px;font-size:.82rem">' + n.title + '</a>' +
          '<span class="ni-time" style="margin-left:8px">' + n.time_str + '</span></div>';
      }).join('')
    : '<span style="color:var(--text3);font-size:.82rem">No recent news</span>';

  const upside = (d.upside !== null && d.upside !== undefined)
    ? '<span class="' + (d.upside >= 0 ? 'green' : 'red') + '">' +
      (d.upside >= 0 ? '+' : '') + d.upside.toFixed(1) + '% to analyst target</span>'
    : 'N/A';

  // FCF formatted
  const fcfFmt = d.fcf && d.fcf >= 1e9  ? '+$' + (d.fcf/1e9).toFixed(1) + 'B'
               : d.fcf && d.fcf > 0     ? '+$' + (d.fcf/1e6).toFixed(0) + 'M'
               : d.fcf && d.fcf < 0     ? '-$' + (Math.abs(d.fcf)/1e6).toFixed(0) + 'M'
               : 'N/A';
  const fcfSig = d.fcf && d.fcf > 0 ? 'good' : d.fcf && d.fcf < 0 ? 'bad' : 'muted';

  return '<div class="ar-wrap">' +

  // ── Header ──
  '<div class="ar-header">' +
    '<div class="ar-left">' +
      '<div class="ar-sym">' + d.symbol + '</div>' +
      '<div class="ar-name">' + d.name + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">' +
        '<span class="sector-tag">' + (d.sector || '') + '</span>' +
        (d.industry ? '<span class="industry-tag">' + d.industry + '</span>' : '') +
      '</div>' +
      '<div class="ar-price-row">' +
        '<span class="ar-price">$' + d.price + '</span>' +
        '<span class="ar-chg ' + chgCls + '">' + chgS + d.change_pct + '%</span>' +
        '<span style="color:var(--text3);font-size:.75rem">· ' + d.market_cap + '</span>' +
      '</div>' +
    '</div>' +
    '<div class="ar-right">' +
      '<span class="ar-verdict ' + dir + '">' +
        (d.direction === 'Bullish' ? '📈' : '📉') + ' ' + d.direction +
      '</span>' +
      '<div class="ar-buf-score">' +
        '<div class="ar-buf-num">' + d.buffett_score + '/100</div>' +
        '<div class="ar-buf-lbl">Buffett Score</div>' +
        '<div class="ar-buf-invest">' + d.buffett_invest + '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +

  // ── Section 1: Financial Statements ──
  '<div class="ar-section">' +
    '<div class="ar-sec-head"><span class="ar-sec-title">1️⃣ Financial Statements</span></div>' +
    '<div class="ar-sec-body"><div class="ar-grid">' +
      _m('Revenue Growth (YoY)', _pctFmt(d.revenue_growth)) +
      _m('Earnings Growth (YoY)', _pctFmt(d.earnings_growth)) +
      _m('Gross Margin', d.gross_margin !== null ? (d.gross_margin*100).toFixed(1)+'%' : 'N/A', _sig(d.gross_margin,0.50,0.25)) +
      _m('Net Margin',   d.net_margin   !== null ? (d.net_margin  *100).toFixed(1)+'%' : 'N/A', _sig(d.net_margin,  0.15,0.05)) +
      _m('Operating Margin', d.op_margin !== null ? (d.op_margin  *100).toFixed(1)+'%' : 'N/A', _sig(d.op_margin,   0.20,0.08)) +
      _m('EPS (TTM)',    '$'+d.eps_ttm,  _sig(d.eps_ttm,   1, 0)) +
      _m('EPS (Forward)','$'+d.eps_fwd,  _sig(d.eps_fwd,   d.eps_ttm, 0)) +
      _m('Debt / Equity', d.debt_equity+'%', _sig(d.debt_equity, 200, 100, true)) +
      _m('Current Ratio', d.current_ratio,   _sig(d.current_ratio, 1.5, 1.0)) +
      _m('Free Cash Flow', fcfFmt, fcfSig) +
      _m('ROE', d.roe !== null ? (d.roe*100).toFixed(1)+'%' : 'N/A', _sig(d.roe, 0.20, 0.10)) +
      _m('ROA', d.roa !== null ? (d.roa*100).toFixed(1)+'%' : 'N/A', _sig(d.roa, 0.10, 0.05)) +
    '</div></div>' +
  '</div>' +

  // ── Section 2: Valuation ──
  '<div class="ar-section">' +
    '<div class="ar-sec-head"><span class="ar-sec-title">2️⃣ Valuation Metrics</span></div>' +
    '<div class="ar-sec-body"><div class="ar-grid">' +
      _m('P/E Ratio (TTM)',  d.pe_ttm  || 'N/A', _sig(d.pe_ttm,  25, 40, true)) +
      _m('P/E Ratio (Fwd)',  d.pe_fwd  || 'N/A', _sig(d.pe_fwd,  20, 30, true)) +
      _m('Price / Book',     d.pb      || 'N/A', _sig(d.pb,       3,  6, true)) +
      _m('EV / EBITDA',      d.ev_ebitda|| 'N/A',_sig(d.ev_ebitda,15,25, true)) +
      _m('PEG Ratio',        d.peg     || 'N/A', _sig(d.peg,     1.5,2.5,true)) +
      _m('Dividend Yield',   d.div_yield ? d.div_yield+'%' : '—', d.div_yield > 2 ? 'good' : 'muted') +
      _m('Beta',             d.beta,             _sig(d.beta, 1.5, 2.0, true)) +
      _m('52W High',        '$'+d.week52_high) +
      _m('52W Low',         '$'+d.week52_low) +
    '</div>' +
    '<div class="ar-52w-bar" style="margin-top:14px">' +
      '<div style="font-size:.7rem;color:var(--text3);margin-bottom:4px">52-Week Price Range</div>' +
      '<div class="ar-52w-track">' +
        '<div class="ar-52w-dot" style="left:' + pct52 + '%"></div>' +
      '</div>' +
      '<div class="ar-52w-lbls">' +
        '<span>$' + d.week52_low + '</span>' +
        '<span style="color:var(--text2)">Now $' + d.price + '</span>' +
        '<span>$' + d.week52_high + '</span>' +
      '</div>' +
    '</div>' +
    '</div>' +
  '</div>' +

  // ── Section 3: Growth & Competitive ──
  '<div class="ar-section">' +
    '<div class="ar-sec-head"><span class="ar-sec-title">3️⃣ Growth &amp; Competitive Position</span></div>' +
    '<div class="ar-sec-body"><div class="ar-grid">' +
      _m('Revenue Growth',    _pctFmt(d.revenue_growth)) +
      _m('EPS Growth',        _pctFmt(d.earnings_growth)) +
      _m('ROE',               d.roe !== null ? (d.roe*100).toFixed(1)+'%' : 'N/A', _sig(d.roe,0.20,0.10)) +
      _m('Analyst Target',    d.target_price ? '$'+d.target_price : 'N/A') +
      _m('Upside / Downside', upside) +
      _m('Analyst Consensus', d.analyst_rec,
         d.analyst_rec==='Strong Buy'||d.analyst_rec==='Buy' ? 'good' :
         d.analyst_rec==='Hold' ? 'ok' : 'bad') +
      _m('# of Analysts',     d.analyst_count || 'N/A') +
    '</div></div>' +
  '</div>' +

  // ── Section 4: Risk Analysis ──
  '<div class="ar-section">' +
    '<div class="ar-sec-head"><span class="ar-sec-title">4️⃣ Risk Analysis</span></div>' +
    '<div class="ar-sec-body"><div class="ar-grid">' +
      _m('Beta (Volatility)',  d.beta,            _sig(d.beta,       1.5, 2.0, true)) +
      _m('Debt / Equity',      d.debt_equity+'%', _sig(d.debt_equity,200, 100, true)) +
      _m('Current Ratio',      d.current_ratio,   _sig(d.current_ratio,1.5,1.0)) +
      _m('Quick Ratio',        d.quick_ratio,     _sig(d.quick_ratio,  1.0,0.7)) +
      _m('Short % of Float',   d.short_float ? d.short_float+'%' : 'N/A',
         _sig(d.short_float, 20, 10, true)) +
    '</div></div>' +
  '</div>' +

  // ── Section 5: News ──
  '<div class="ar-section">' +
    '<div class="ar-sec-head"><span class="ar-sec-title">5️⃣ Recent News &amp; Catalysts</span></div>' +
    '<div class="ar-sec-body">' + newsHtml + '</div>' +
  '</div>' +

  // ── Section 6: Investment Verdict ──
  '<div class="ar-section">' +
    '<div class="ar-sec-head"><span class="ar-sec-title">6️⃣ Investment Verdict</span></div>' +
    '<div class="ar-sec-body">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">' +
        '<div style="background:rgba(0,230,118,.06);border:1px solid rgba(0,230,118,.2);border-radius:8px;padding:12px">' +
          '<div style="color:var(--green);font-weight:700;margin-bottom:6px">📈 Bullish Case</div>' +
          '<div style="font-size:.82rem;color:var(--text2);line-height:1.5">' +
            (d.direction === 'Bullish' ? 'Technical momentum is positive. ' : '') +
            (d.earnings_growth && d.earnings_growth > 0 ? 'Earnings growing at ' + (d.earnings_growth*100).toFixed(1) + '%. ' : '') +
            (d.fcf && d.fcf > 0 ? 'Positive free cash flow. ' : '') +
            (d.buffett_score >= 60 ? 'Passes Buffett quality criteria.' : '') +
          '</div>' +
        '</div>' +
        '<div style="background:rgba(255,23,68,.05);border:1px solid rgba(255,23,68,.15);border-radius:8px;padding:12px">' +
          '<div style="color:var(--red);font-weight:700;margin-bottom:6px">📉 Bearish Case</div>' +
          '<div style="font-size:.82rem;color:var(--text2);line-height:1.5">' +
            (d.debt_equity > 150 ? 'High debt ('+d.debt_equity+'%). ' : '') +
            (d.beta > 1.5 ? 'High beta '+d.beta+' = elevated risk. ' : '') +
            (d.pe_ttm > 30 ? 'Premium valuation P/E '+d.pe_ttm+'. ' : '') +
            (d.short_float > 10 ? 'High short interest '+d.short_float+'%. ' : '') +
            (d.direction === 'Bearish' ? 'Technical trend is bearish.' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:.82rem;color:var(--text2);margin-bottom:10px;padding:10px;background:rgba(179,136,255,.06);border-radius:6px;border-left:3px solid var(--purple)">' +
        '<strong style="color:var(--purple)">If Warren Buffett:</strong> ' + d.buffett_invest +
      '</div>' +
      '<div class="buf-signals">' + bufSigs + '</div>' +
    '</div>' +
  '</div>' +

  // ── External links ──
  '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">' +
    '<a href="https://finance.yahoo.com/quote/' + d.symbol + '" target="_blank" rel="noopener" class="rc-link-btn">💹 Yahoo Finance</a>' +
    '<a href="https://www.tradingview.com/chart/?symbol=' + d.symbol + '" target="_blank" rel="noopener" class="rc-link-btn">📊 TradingView</a>' +
    '<a href="https://stockanalysis.com/stocks/' + d.symbol.toLowerCase() + '/" target="_blank" rel="noopener" class="rc-link-btn">📋 Stock Analysis</a>' +
  '</div>' +
  '</div>';
}

// ── Value Screener Table ──────────────────────────────────────────────────
function buildScreenerTable(results, ts) {
  if (!results || !results.length)
    return '<div class="empty-msg">No stocks matched your filters. Try relaxing the criteria.</div>';

  const rows = results.map(function(r, i) {
    const chgCls = r.change_pct >= 0 ? 'green' : 'red';
    const dirCls = r.tv_dir === 'Bullish' ? 'bull' : 'bear';
    return '<tr class="vs-row" onclick="switchToReport(\'' + r.symbol + '\')">' +
      '<td style="color:var(--text3)">' + (i+1) + '</td>' +
      '<td><div class="vs-sym">' + r.symbol + '</div><div class="vs-name">' + r.name + '</div></td>' +
      '<td>$' + r.price +
        ' <span class="' + chgCls + '">' + (r.change_pct>=0?'+':'') + r.change_pct + '%</span></td>' +
      '<td><span class="dir ' + dirCls + '">' + (r.tv_dir==='Bullish'?'▲':'▼') + ' ' + r.tv_dir + '</span></td>' +
      '<td class="' + (r.pe>0&&r.pe<15?'green':r.pe>25?'bad':'') + '">' + (r.pe||'—') + '</td>' +
      '<td>' + (r.pb||'—') + '</td>' +
      '<td class="' + (r.div_yield>2?'green':'') + '">' + (r.div_yield?r.div_yield+'%':'—') + '</td>' +
      '<td class="' + (r.eps_growth>10?'green':r.eps_growth<0?'red':'') + '">' + (r.eps_growth?r.eps_growth+'%':'—') + '</td>' +
      '<td class="' + (r.roe>15?'green':'') + '">' + (r.roe?r.roe+'%':'—') + '</td>' +
      '<td><span class="sector-tag">' + r.sector + '</span></td>' +
    '</tr>';
  }).join('');

  return '<div style="overflow-x:auto">' +
    '<div style="font-size:.75rem;color:var(--text3);margin-bottom:8px">Found ' + results.length +
    ' undervalued stocks · ' + (ts||'') + ' · Click any row for full report</div>' +
    '<table class="vs-table"><thead><tr>' +
    '<th>#</th><th>Symbol</th><th>Price</th><th>Signal</th>' +
    '<th>P/E</th><th>P/B</th><th>Div Yield</th><th>EPS Growth</th><th>ROE</th><th>Sector</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function switchToReport(symbol) {
  document.getElementById('analysisSymbol').value = symbol;
  document.querySelectorAll('.a-tab').forEach(function(t){ t.classList.remove('active'); });
  document.querySelector('.a-tab[data-atab="report"]').classList.add('active');
  analysisTab = 'report';
  document.getElementById('reportArea').style.display  = '';
  document.getElementById('screenArea').style.display  = 'none';
  document.getElementById('reportSide').style.display  = '';
  document.getElementById('screenSide').style.display  = 'none';
  document.getElementById('scanBtnText').textContent   = 'RUN ANALYSIS';
  runAnalysis();
}
