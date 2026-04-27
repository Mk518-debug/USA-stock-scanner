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
function setLoading(on) {
  document.getElementById('loadingOverlay').style.display = on ? 'flex' : 'none';
  const btn = document.getElementById('scanBtn');
  btn.disabled = on;
  document.getElementById('scanBtnText').textContent = on ? '⏳ SCANNING…' : '🔍 START SCAN';
}
