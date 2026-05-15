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

  ['cardsArea','newsArea','optionsScanArea','reportArea','screenArea'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.height = scrollH + 'px';
  });
  if (sidebar) sidebar.style.height = winH + 'px';
}

window.addEventListener('load',   fitScrollZones);
window.addEventListener('resize', fitScrollZones);

// ── State ─────────────────────────────────────────────────────────────────
let allResults   = [];
let activeTab    = 'all';
let scanType     = 'comprehensive';
let lastTF       = '1d';
let searchQuery  = '';
let watchedSet   = new Set();
let dismissSet   = new Set();
let marketCap    = 'all';
let compareList  = [];
let _chartSymbol = '';
let _chartTvSym  = '';
let scanHistory  = [];
let currentPage  = 0;
const PAGE_SIZE  = 50;
let rsiMin = 0, rsiMax = 100;

// ── localStorage: persist watchlist + settings ───────────────────────────
function saveWatchlist() {
  try { localStorage.setItem('usa_watched', JSON.stringify([...watchedSet])); } catch(e) {}
}
(function loadWatchlist() {
  try {
    const s = localStorage.getItem('usa_watched');
    if (s) watchedSet = new Set(JSON.parse(s));
  } catch(e) {}
})();

function saveSettings() {
  try {
    localStorage.setItem('usa_settings', JSON.stringify({
      tf: lastTF, scanType,
      minScore: document.getElementById('minScore')?.value || 50,
      sector:   document.getElementById('sectorSel')?.value || 'all',
      minPrice: document.getElementById('minPrice')?.value || '',
      maxPrice: document.getElementById('maxPrice')?.value || '',
      minVol:   document.getElementById('minVolume')?.value || 0,
      mktCap:   marketCap,
    }));
  } catch(e) {}
}
(function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('usa_settings') || 'null');
    if (!s) return;
    if (s.minScore) {
      const el = document.getElementById('minScore');
      if (el) { el.value = s.minScore; document.getElementById('scoreDisplay').textContent = s.minScore; }
    }
    if (s.sector) { const el = document.getElementById('sectorSel'); if (el) el.value = s.sector; }
    if (s.minPrice) { const el = document.getElementById('minPrice'); if (el) el.value = s.minPrice; }
    if (s.maxPrice) { const el = document.getElementById('maxPrice'); if (el) el.value = s.maxPrice; }
    if (s.minVol)   { const el = document.getElementById('minVolume'); if (el) { el.value = s.minVol; updateVolLabel(s.minVol); } }
    if (s.mktCap)   {
      marketCap = s.mktCap;
      document.querySelectorAll('#mktCapGroup .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.cap === s.mktCap));
    }
    if (s.tf) {
      lastTF = s.tf;
      document.querySelectorAll('#tfGroup .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.tf === s.tf));
    }
    if (s.scanType) {
      scanType = s.scanType;
      document.querySelectorAll('#scanTypeGroup .seg-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.type === s.scanType));
    }
  } catch(e) {}
})();

// ── Scan history ──────────────────────────────────────────────────────────
(function loadHistory() {
  try { scanHistory = JSON.parse(localStorage.getItem('usa_history') || '[]'); } catch(e) {}
  renderHistory();
})();

function saveScanToHistory(d) {
  const entry = {
    ts:        d.timestamp,
    total:     d.total_scanned,
    bullish:   d.bullish_count,
    quality:   d.quality_score,
    grade:     d.scan_grade,
    tf:        d.timeframe,
    tops:      (d.results || []).slice(0, 5).map(r => r.symbol),
  };
  scanHistory = [entry, ...scanHistory.filter(e => e.ts !== entry.ts)].slice(0, 5);
  try { localStorage.setItem('usa_history', JSON.stringify(scanHistory)); } catch(e) {}
  renderHistory();
}

function renderHistory() {
  const el = document.getElementById('historyList');
  const cnt = document.getElementById('histCount');
  if (!el) return;
  if (cnt) cnt.textContent = scanHistory.length ? `(${scanHistory.length})` : '';
  if (!scanHistory.length) { el.innerHTML = '<div class="sl-empty">No history yet</div>'; return; }
  el.innerHTML = scanHistory.map((h, i) => `
    <div class="hist-item">
      <div class="hist-top">
        <span class="hist-grade grade-badge ${(h.grade||'d').toLowerCase()}">${h.grade||'—'}</span>
        <span class="hist-tf">${h.tf||'1D'}</span>
        <span class="hist-score">${h.quality||0}/100</span>
        <span class="hist-time">${h.ts||''}</span>
      </div>
      <div class="hist-syms">${(h.tops||[]).join(' · ')}</div>
    </div>`).join('');
}

function toggleHistory() {
  const el = document.getElementById('historyList');
  const ar = document.getElementById('histArrow');
  if (!el) return;
  const open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  if (ar) ar.textContent = open ? '▾' : '▴';
}

// ── Volume label helper ───────────────────────────────────────────────────
function updateVolLabel(val) {
  const n = parseInt(val) || 0;
  const el = document.getElementById('volDisplay');
  if (!el) return;
  if (n === 0) { el.textContent = 'Any'; return; }
  el.textContent = n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M' : Math.round(n/1000)+'K';
}

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
  const fmtNY  = (o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...o }).format(new Date());
  const fmtRUH = (o) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Riyadh',      ...o }).format(new Date());

  document.getElementById('nyTime').textContent =
    `NY: ${fmtNY({weekday:'short',month:'short',day:'numeric'})}, ${fmtNY({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true})}`;

  document.getElementById('ruhTime').textContent =
    `RUH: ${fmtRUH({weekday:'short',month:'short',day:'numeric'})}, ${fmtRUH({hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:true})}`;

  const h   = parseInt(fmtNY({ hour:'numeric', hour12:false }));
  const m   = parseInt(fmtNY({ minute:'numeric' }));
  const day = fmtNY({ weekday:'short' });
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
wireSegs('scanTypeGroup', btn => { scanType  = btn.dataset.type; currentPage = 0; render(); });
wireSegs('tfGroup',       btn => { lastTF    = btn.dataset.tf; });
wireSegs('mktCapGroup',   btn => { marketCap = btn.dataset.cap; });

function updateRsiLabel() {
  rsiMin = parseInt(document.getElementById('rsiMin')?.value || 0);
  rsiMax = parseInt(document.getElementById('rsiMax')?.value || 100);
  if (rsiMin > rsiMax) { rsiMin = rsiMax; document.getElementById('rsiMin').value = rsiMin; }
  const el = document.getElementById('rsiDisplay');
  if (el) el.textContent = (rsiMin === 0 && rsiMax === 100) ? '0–100' : `${rsiMin}–${rsiMax}`;
  currentPage = 0; render();
}

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.ftab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.ftab').forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected','false'); });
    tab.classList.add('active'); tab.setAttribute('aria-selected','true');
    activeTab = tab.dataset.tab;
    currentPage = 0;
    const cardsEl   = document.getElementById('cardsArea');
    const newsEl    = document.getElementById('newsArea');
    const optEl     = document.getElementById('optionsScanArea');
    const accEl     = document.getElementById('accuracyReport');

    // Hide all panels
    [cardsEl, newsEl, optEl].forEach(el => { if (el) el.style.display = 'none'; });

    if (activeTab === 'news') {
      if (newsEl) newsEl.style.display = '';
      fetchNews();
    } else if (activeTab === 'optionsscan') {
      if (optEl) optEl.style.display = '';
      if (accEl) accEl.style.display = 'none';
    } else {
      if (cardsEl) cardsEl.style.display = '';
      render();
    }
  });
});

// ── Mobile sidebar drawer ─────────────────────────────────────────────────
function openSidebar() {
  document.querySelector('.sidebar')?.classList.add('open');
  document.getElementById('sidebarBackdrop')?.classList.add('active');
  document.body.style.overflow = 'hidden';
}
function closeSidebar() {
  document.querySelector('.sidebar')?.classList.remove('open');
  document.getElementById('sidebarBackdrop')?.classList.remove('active');
  document.body.style.overflow = '';
}
// Close sidebar after scan starts on mobile
const _origStartScan = startScan;

// ── Market / Custom switch ────────────────────────────────────────────────
function switchMarket(mode) {
  document.getElementById('mtAll').classList.toggle('active',    mode === 'all');
  document.getElementById('mtCustom').classList.toggle('active', mode === 'custom');
  document.getElementById('allPanel').style.display    = mode === 'all'    ? '' : 'none';
  document.getElementById('customPanel').style.display = mode === 'custom' ? '' : 'none';
}

// ── Search ────────────────────────────────────────────────────────────────
function onSearch(v) { searchQuery = v.trim().toLowerCase(); currentPage = 0; render(); }

// ── Scan ──────────────────────────────────────────────────────────────────
async function startScan(force = false) {
  const timeframe = document.querySelector('#tfGroup .seg-btn.active').dataset.tf;
  const minScore  = parseInt(document.getElementById('minScore').value) || 40;
  const sector    = document.getElementById('sectorSel').value;
  const isCustom  = document.getElementById('mtCustom').classList.contains('active');
  const symRaw    = document.getElementById('symInput').value;
  const symbols   = isCustom ? symRaw.split(/[\n,]+/).map(s=>s.trim().toUpperCase()).filter(Boolean) : [];
  const minPrice  = parseFloat(document.getElementById('minPrice')?.value) || 0;
  const maxPrice  = parseFloat(document.getElementById('maxPrice')?.value) || 0;
  const minVol    = parseInt(document.getElementById('minVolume')?.value)  || 0;
  lastTF = timeframe;
  saveSettings();

  currentPage = 0;
  closeSidebar();
  setLoading(true);
  startProgressAnim(symbols.length || 200);
  try {
    const res  = await fetch('/api/scan', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ timeframe, min_score: minScore, sector, symbols, force,
                             min_price: minPrice, max_price: maxPrice,
                             min_volume: minVol, market_cap: marketCap,
                             rsi_min: rsiMin, rsi_max: rsiMax }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('Server returned an invalid response. Try again.'); }
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    allResults = data.results;
    updateStats(data);
    populateStockList(data.results);
    saveScanToHistory(data);
    checkAlerts(data.results);

    document.getElementById('statsTop').style.display  = 'grid';
    document.getElementById('filterBar').style.display = 'flex';
    document.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
    document.querySelector('.ftab[data-tab="all"]').classList.add('active');
    activeTab = 'all';
    render();
    showAccuracyReport(data);
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

  const trend = d.bullish_count > d.bearish_count ? 'Bullish'
              : d.bearish_count > d.bullish_count  ? 'Bearish' : 'Mixed';
  const te = document.getElementById('sTrend');
  te.textContent = (trend === 'Bullish' ? '▲ ' : trend === 'Bearish' ? '▼ ' : '● ') + trend;
  te.className   = 'sb-trend ' + (trend === 'Bullish' ? 'bull' : trend === 'Bearish' ? 'bear' : '');

  // Market Regime badge
  const re = document.getElementById('sRegime');
  if (re && d.regime_score !== undefined) {
    const rs = d.regime_score;
    const rl = d.regime_label || (rs >= 60 ? 'Risk-On' : rs <= 40 ? 'Risk-Off' : 'Neutral');
    re.textContent = (rs >= 60 ? '🟢 ' : rs <= 40 ? '🔴 ' : '🟡 ') + rl + ' (' + rs + ')';
    re.className   = 'sb-regime ' + (rs >= 60 ? 'bull' : rs <= 40 ? 'bear' : '');
  }

  // Scan Quality badge
  const qe = document.getElementById('sQuality');
  const ge = document.getElementById('sGrade');
  if (qe && d.quality_score !== undefined) {
    const qs = d.quality_score;
    qe.textContent = qs + '/100';
    qe.className   = 'sb-quality ' + (qs >= 80 ? 'grade-a' : qs >= 65 ? 'grade-b' : qs >= 50 ? 'grade-c' : 'grade-d');
    if (ge) { ge.textContent = 'Grade ' + (d.scan_grade || '—'); ge.className = 'sb-sub grade-badge ' + (d.scan_grade||'').toLowerCase(); }
  }

  document.getElementById('cacheTag').style.display = d.from_cache ? 'inline-block' : 'none';
}

// ── Accuracy Report Panel ─────────────────────────────────────────────────
function showAccuracyReport(d) {
  const el = document.getElementById('accuracyReport');
  if (!el || d.quality_score === undefined) return;

  const qs    = d.quality_score || 0;
  const grade = d.scan_grade   || '—';
  const gradeColor = grade === 'A' ? 'var(--green)' : grade === 'B' ? '#69f0ae'
                   : grade === 'C' ? 'var(--yellow)' : 'var(--red)';
  const barW = qs + '%';

  const clarity  = d.clarity_pct      || 0;
  const trendPct = d.trend_pct        || 0;
  const avgVotes = d.avg_up_votes     || 0;
  const highConf = d.high_conf_count  || 0;
  const avgScore = d.avg_score        || 0;
  const insight  = d.scan_insight     || '';
  const regMatch = d.regime_match;

  // Indicator breakdown for scanned results
  const total = allResults.length || 1;
  const trendCount    = allResults.filter(r => r.signal_type === 'Trend').length;
  const reversalCount = allResults.filter(r => r.signal_type === 'Reversal').length;
  const mixedCount    = allResults.filter(r => r.signal_type === 'Mixed' || r.signal_type === 'Weak').length;

  el.style.display = 'block';
  el.innerHTML = `
<div class="acc-panel">
  <div class="acc-top">
    <div class="acc-grade-col">
      <div class="acc-grade" style="color:${gradeColor};border-color:${gradeColor}">${grade}</div>
      <div class="acc-grade-lbl">Scan Grade</div>
    </div>
    <div class="acc-main">
      <div class="acc-title">Scan Quality Report <span class="acc-source">${d.source||'TradingView'} · ${d.timeframe||'1D'}</span></div>
      <div class="acc-bar-wrap">
        <div class="acc-bar-track">
          <div class="acc-bar-fill" style="width:${barW};background:${gradeColor}"></div>
        </div>
        <span class="acc-score-val">${qs}/100</span>
      </div>
      <div class="acc-insight">${insight}</div>
    </div>
    <button class="acc-close" onclick="document.getElementById('accuracyReport').style.display='none'">✕</button>
  </div>

  <div class="acc-metrics">
    <div class="acc-m">
      <div class="acc-m-val ${clarity>=70?'good':clarity>=50?'ok':'bad'}">${clarity}%</div>
      <div class="acc-m-lbl">Clear Signals</div>
      <div class="acc-m-sub">Vote diff ≥ 3</div>
    </div>
    <div class="acc-m">
      <div class="acc-m-val ${trendPct>=60?'good':trendPct>=40?'ok':'bad'}">${trendPct}%</div>
      <div class="acc-m-lbl">Trend Signals</div>
      <div class="acc-m-sub">Strong consensus</div>
    </div>
    <div class="acc-m">
      <div class="acc-m-val ${avgVotes>=7?'good':avgVotes>=5?'ok':'bad'}">${avgVotes}</div>
      <div class="acc-m-lbl">Avg Bull Votes</div>
      <div class="acc-m-sub">Bullish results</div>
    </div>
    <div class="acc-m">
      <div class="acc-m-val ${highConf>=10?'good':highConf>=5?'ok':'bad'}">${highConf}</div>
      <div class="acc-m-lbl">High Confidence</div>
      <div class="acc-m-sub">Score ≥ 70</div>
    </div>
    <div class="acc-m">
      <div class="acc-m-val ${avgScore>=65?'good':avgScore>=50?'ok':'bad'}">${avgScore}</div>
      <div class="acc-m-lbl">Avg Score</div>
      <div class="acc-m-sub">All signals</div>
    </div>
    <div class="acc-m">
      <div class="acc-m-val ${regMatch?'good':'bad'}">${regMatch?'✓ Yes':'✗ No'}</div>
      <div class="acc-m-lbl">Regime Match</div>
      <div class="acc-m-sub">Trend aligned</div>
    </div>
  </div>

  <div class="acc-dist">
    <div class="acc-dist-lbl">Signal Distribution</div>
    <div class="acc-dist-bars">
      <div class="acc-dist-row">
        <span class="acc-dist-name">Trend</span>
        <div class="acc-dist-track">
          <div class="acc-dist-fill trend-fill" style="width:${Math.round(trendCount/total*100)}%"></div>
        </div>
        <span class="acc-dist-count">${trendCount}</span>
      </div>
      <div class="acc-dist-row">
        <span class="acc-dist-name">Reversal</span>
        <div class="acc-dist-track">
          <div class="acc-dist-fill rev-fill" style="width:${Math.round(reversalCount/total*100)}%"></div>
        </div>
        <span class="acc-dist-count">${reversalCount}</span>
      </div>
      <div class="acc-dist-row">
        <span class="acc-dist-name">Mixed</span>
        <div class="acc-dist-track">
          <div class="acc-dist-fill mix-fill" style="width:${Math.round(mixedCount/total*100)}%"></div>
        </div>
        <span class="acc-dist-count">${mixedCount}</span>
      </div>
    </div>
  </div>
</div>`;
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
    case 'trend':      list = list.filter(r => r.signal_type==='Trend' || r.ema_score>=70); break;
    case 'reversal':   list = list.filter(r => r.signal_type==='Reversal' || r.rsi<38||r.rsi>68); break;
    case 'momentum':   list = list.filter(r => (r.vol_ratio||0)>=1.5 && (r.rsi||0)>=55); break;
    case 'breakout':   list = list.filter(r => (r.patterns||[]).includes('20D Breakout') || r.score>=75); break;
    case 'oversold':   list = list.filter(r => (r.rsi||100)<=35 || (r.patterns||[]).some(p=>p.toLowerCase().includes('oversold'))); break;
  }
  // RSI range filter
  if (rsiMin > 0 || rsiMax < 100) {
    list = list.filter(r => (r.rsi||0) >= rsiMin && (r.rsi||0) <= rsiMax);
  }
  if (searchQuery) list = list.filter(r =>
    r.symbol.toLowerCase().includes(searchQuery) || (r.name||'').toLowerCase().includes(searchQuery));
  return list;
}

function render() {
  const wrap = document.getElementById('cardsArea');
  const key  = document.getElementById('sortSel')?.value || 'score';
  const list = [...getFiltered()].sort((a,b) => (b[key]||0) - (a[key]||0));

  if (!list.length) { wrap.innerHTML = '<div class="empty-msg">🔍 No results match your filters.</div>'; return; }

  const ordered  = [...list.filter(r=>watchedSet.has(r.symbol)), ...list.filter(r=>!watchedSet.has(r.symbol))];
  const visible  = ordered.slice(0, (currentPage + 1) * PAGE_SIZE);
  const hasMore  = visible.length < ordered.length;

  wrap.innerHTML = `<div class="cards-grid">${visible.map(buildCard).join('')}</div>` +
    (hasMore ? `<div class="load-more-wrap">
      <button class="load-more-btn" onclick="currentPage++;render()">
        Load more (${ordered.length - visible.length} remaining)
      </button></div>` : '');
}

// ── Pattern Tags ──────────────────────────────────────────────────────────
function getPatterns(r) {
  const t = [];

  // Backend-supplied patterns (already assembled in scanner.py / tv_scanner.py)
  if (r.patterns && r.patterns.length) {
    r.patterns.forEach(p => {
      const lp = p.toLowerCase();
      const cls = (lp.includes('bull') || lp.includes('hammer') ||
                   lp.includes('breakout') || lp.includes('rs+') ||
                   lp.includes('htf aligned') || lp.includes('bullish')) ? 'green'
                : (lp.includes('bear') || lp.includes('star') ||
                   lp.includes('rs-') || lp.includes('bearish')) ? 'red'
                : (lp.includes('adx')) ? 'blue'
                : (lp.includes('bb squeeze')) ? 'purple'
                : '';
      t.push({ label: p, cls });
    });
  }

  // TV Strong rating badge
  if (r.tv_rating === 'Strong Buy')  t.push({ label:'TV Strong Buy',  cls:'green' });
  if (r.tv_rating === 'Strong Sell') t.push({ label:'TV Strong Sell', cls:'red' });

  // High confidence
  if (r.score >= 80 && !t.some(x => x.label === 'High Confidence'))
    t.push({ label:'High Confidence', cls:'purple' });

  return t;
}

// ── Export helpers ────────────────────────────────────────────────────────
function toggleExportMenu() {
  const m = document.getElementById('exportMenu');
  if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
}
document.addEventListener('click', e => {
  if (!e.target.closest('.export-wrap')) {
    const m = document.getElementById('exportMenu');
    if (m) m.style.display = 'none';
  }
});

function exportExcel() {
  const rows = [...getFiltered()];
  if (!rows.length) { alert('No results to export.'); return; }
  if (typeof XLSX === 'undefined') { alert('Excel library not loaded. Use CSV instead.'); return; }
  const data = rows.map(r => ({
    Symbol: r.symbol, Name: r.name||'', Score: r.score, Direction: r.direction,
    'Signal Type': r.signal_type||'', 'Up Votes': r.up_votes||0, 'Down Votes': r.down_votes||0,
    'TV Rating': r.tv_rating||'', Price: r.price, 'Change%': r.change_pct||0,
    RSI: r.rsi, ADX: r.adx||0, 'Vol Ratio': r.vol_ratio,
    ATR: r.atr, Entry: r.entry, Stop: r.stop||'',
    'Goal 1': r.tp1||'', 'Goal 2': r.tp2||'', 'Goal 3': r.tp3||'',
    Support: r.support||'', Resistance: r.resistance||'',
    Sector: r.sector||'', Patterns: (r.patterns||[]).join(';'),
    'Data As Of': r.last_candle||''
  }));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Scan Results');
  XLSX.writeFile(wb, `usa_scan_${new Date().toISOString().slice(0,10)}.xlsx`);
}

// ── CSV Export ────────────────────────────────────────────────────────────
function exportCSV() {
  const rows = [...getFiltered()];
  if (!rows.length) { alert('No results to export.'); return; }

  const headers = ['Symbol','Name','Score','Direction','Signal Type','Up Votes','Down Votes',
                   'TV Rating','Price','Change%','RSI','ADX','MACD','EMA Trend',
                   'Volume Ratio','ATR','Entry','Stop','Goal1','Goal2','Goal3','Sector',
                   'Patterns','Divergence','HTF EMA','BB Squeeze','Data As Of'];
  const lines = [headers.join(',')];

  rows.forEach(r => {
    const emaDir = r.price>r.ema20&&r.ema20>r.ema50 ? 'Bull'
                 : r.price<r.ema20&&r.ema20<r.ema50 ? 'Bear' : 'Mixed';
    const row = [
      r.symbol,
      '"' + (r.name||'').replace(/"/g,'') + '"',
      r.score, r.direction, r.signal_type||'',
      r.up_votes||0, r.down_votes||0,
      r.tv_rating||'—', r.price, r.change_pct||0,
      r.rsi, r.adx||0,
      (r.macd>r.macd_signal?'Bull':'Bear'),
      emaDir, r.vol_ratio,
      r.atr, r.entry, r.stop||'', r.tp1||'', r.tp2||'', r.tp3||'',
      r.sector||'',
      '"' + (r.patterns||[]).join(';') + '"',
      r.divergence||'', r.htf_ema_dir||0,
      r.bb_squeeze||0,
      r.last_candle||''
    ];
    lines.push(row.join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'usa_scan_' + new Date().toISOString().slice(0,10) + '.csv';
  a.click();
}

// ── Build Card (Saudi scanner layout) ────────────────────────────────────
function buildCard(r) {
  const dc    = r.direction==='Bullish'?'bull':r.direction==='Bearish'?'bear':'neutral';
  const chgCl = (r.change_pct||0)>0?'bull':(r.change_pct||0)<0?'bear':'';
  const chgS  = (r.change_pct||0)>0?'+':'';
  const isW   = watchedSet.has(r.symbol);
  const atr   = r.atr || 0;
  const mult  = r.direction==='Bullish'?1:-1;

  // AB.SK targets: Stop=5×ATR, G1=2.5×ATR, G2=5×ATR, G3=7.5×ATR
  const entry = r.entry || r.price;
  const stop  = r.stop  != null ? r.stop  : (atr ? (entry - mult*5.0*atr).toFixed(4) : '');
  const t1    = r.tp1   != null ? r.tp1   : (atr ? (entry + mult*2.5*atr).toFixed(4) : '');
  const t2    = r.tp2   != null ? r.tp2   : (atr ? (entry + mult*5.0*atr).toFixed(4) : '');
  const t3    = r.tp3   != null ? r.tp3   : (atr ? (entry + mult*7.5*atr).toFixed(4) : '');
  const dist  = t2 ? Math.abs(((parseFloat(t2)-entry)/entry)*100).toFixed(2) : '—';

  // Votes
  const upV   = r.up_votes   || 0;
  const dnV   = r.down_votes || 0;
  const totV  = upV + dnV || 1;
  const upPct = Math.round(upV / totV * 100);
  const dnPct = 100 - upPct;

  // EMA 1D direction
  const ema1dBull = r.price > r.ema20 && r.ema20 > r.ema50;
  const ema1dBear = r.price < r.ema20 && r.ema20 < r.ema50;
  const ema1dCls  = ema1dBull ? 'bull' : ema1dBear ? 'bear' : '';
  const ema1dLbl  = ema1dBull ? '↑ Bullish' : ema1dBear ? '↓ Bearish' : '↔ Mixed';

  // HTF EMA (1H) direction
  const htfDir  = r.htf_ema_dir || r.mtf_align || 0;
  const htfBull = htfDir > 0;
  const htfBear = htfDir < 0;
  const htfCls  = htfBull ? 'bull' : htfBear ? 'bear' : '';
  const htfLbl  = htfBull ? '↑ Bullish' : htfBear ? '↓ Bearish' : '↔ Mixed';

  // ADX
  const adx    = r.adx || 0;
  const adxDiCls = adx >= 25 ? ((r.adx_plus_di||0) > (r.adx_minus_di||0) ? 'bull' : 'bear') : '';
  const adxLbl   = adx >= 40 ? 'Strong' : adx >= 25 ? 'Trending' : 'Weak';

  // RSI level badge (high=RSI≥60, low=RSI<60)
  const rsiHigh = r.rsi >= 60;
  const rsiCls  = rsiHigh ? 'rsi-high' : 'rsi-low';
  const rsiLbl  = rsiHigh ? 'High ✓' : 'Low';

  // Trend direction badge
  const trendLbl = r.direction === 'Bullish' ? 'Ascension' :
                   r.direction === 'Bearish' ? 'Decline'   : 'Sideways';

  const patterns = getPatterns(r);
  const tvLink   = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.tv_symbol||r.symbol)}`;

  return `
<div class="stock-card ${dc}${isW?' watched':''}" id="card_${r.symbol}">

  <!-- ─── Header row: score + badges + price ─── -->
  <div class="sk-header">
    <span class="sk-score ${dc}">${r.score}</span>
    <div class="sk-badges">
      <span class="sk-dir-badge ${dc}">${r.direction}</span>
      <span class="sector-tag">${r.sector||''}</span>
      ${isW?'<span class="watched-chip">📌</span>':''}
    </div>
    <div class="sk-price-col">
      <span class="sk-price">${r.price}</span>
      <span class="card-dot ${dc}"></span>
    </div>
  </div>

  <!-- ─── Symbol row ─── -->
  <div class="sk-sym-row">
    <span class="card-sym">${r.symbol}</span>
    <span class="card-name">${r.name||''}</span>
    <a href="${tvLink}" target="_blank" rel="noopener" class="sk-check">Check ✓</a>
  </div>

  <!-- ─── Vote progress bar ─── -->
  <div class="sk-vote-track">
    <div class="vote-fill bull-fill" style="width:${upPct}%"></div>
    <div class="vote-fill bear-fill" style="width:${dnPct}%"></div>
  </div>

  <!-- ─── Signal badges ─── -->
  <div class="sk-signal-row">
    <span class="sk-rsi-badge ${rsiCls}">${rsiLbl}</span>
    <span class="sk-trend-badge ${dc}">${trendLbl} <span class="sk-dot ${dc}">●</span></span>
    <span class="tv-badge ${r.tv_css||'tv-na'}">${r.tv_rating||'—'}</span>
    <span class="change-pct ${chgCl}" style="margin-left:auto">${chgS}${r.change_pct||0}%</span>
  </div>

  <div class="card-sep"></div>

  <!-- ─── 4 metrics: EMA 1D | EMA 1H | ADX | RSI ─── -->
  <div class="sk-metrics">
    <div class="sk-m">
      <span class="sk-m-label">EMA ${lastTF.toUpperCase()}</span>
      <span class="sk-m-val ${ema1dCls}">↑ ${ema1dLbl.replace('↑ ','').replace('↓ ','').replace('↔ ','')}</span>
    </div>
    <div class="sk-m">
      <span class="sk-m-label">EMA 1H</span>
      <span class="sk-m-val ${htfCls}">${htfLbl}</span>
    </div>
    <div class="sk-m">
      <span class="sk-m-label">ADX ${lastTF.toUpperCase()}: <b>${adx}</b></span>
      <span class="sk-m-val ${adxDiCls}">${adxLbl}</span>
    </div>
    <div class="sk-m">
      <span class="sk-m-label">RSI ${lastTF.toUpperCase()}: <b>${r.rsi}</b></span>
      <span class="sk-m-val ${r.rsi>=60?'bull':r.rsi<=40?'bear':''}">${r.rsi>=70?'Overbought':r.rsi>=55?'Bullish':r.rsi<=30?'Oversold':r.rsi<=45?'Bearish':'Neutral'}</span>
    </div>
  </div>

  <!-- ─── Current price ─── -->
  <div class="sk-price-row">
    <span class="cp-label">Current Price:</span>
    <span class="cp-val">$${parseFloat(r.price||0).toFixed(2)}</span>
    <span class="cp-change ${chgCl}" style="margin-left:4px">${chgS}${r.change_pct||0}%</span>
    ${r.supertrend ? `<span class="st-badge ${r.supertrend_dir===1?'bull':'bear'}">ST ${r.supertrend_dir===1?'▲':'▼'}</span>` : ''}
  </div>

  <!-- ─── Entry & Objectives AB.SK ─── -->
  <div class="sk-objectives">
    <div class="sk-obj-hdr">✓ Entry &amp; Objectives AB.SK</div>
    <div class="sk-obj-row2">
      <div class="sk-obj-field">
        <div class="sk-obj-lbl red-lbl">Stop Loss ●</div>
        <input class="sk-obj-input stop-inp" id="sl_${r.symbol}" value="${stop}">
      </div>
      <div class="sk-obj-field">
        <div class="sk-obj-lbl">Entry Price ♦</div>
        <input class="sk-obj-input" id="en_${r.symbol}" value="${entry}">
      </div>
    </div>
    <div class="sk-obj-row3">
      <div class="sk-obj-field">
        <div class="sk-obj-lbl green-lbl">Goal 3 🎯</div>
        <input class="sk-obj-input goal-inp" id="t3_${r.symbol}" value="${t3}" readonly>
      </div>
      <div class="sk-obj-field">
        <div class="sk-obj-lbl green-lbl">Goal 2 🎯</div>
        <input class="sk-obj-input goal-inp" id="t2_${r.symbol}" value="${t2}" readonly>
      </div>
      <div class="sk-obj-field">
        <div class="sk-obj-lbl green-lbl">Goal 1 🎯</div>
        <input class="sk-obj-input goal-inp" id="t1_${r.symbol}" value="${t1}" readonly>
      </div>
    </div>
    <div class="sk-obj-stats">Distance: ${dist}% | ATR: ${r.atr}</div>
  </div>

  <!-- ─── Patterns + Agree ─── -->
  <div class="sk-patterns">
    ${patterns.map(p=>`<span class="pattern-tag ${p.cls}">${p.label}</span>`).join('')}
    <div class="sk-agree">Agree: ${r.last_candle||'—'} (${upV} indicators) ↺</div>
  </div>

  <!-- ─── Options Activity (lazy) ─── -->
  <div class="analyst-section">
    <button class="analyst-toggle" id="options_btn_${r.symbol}"
            onclick="toggleOptions('${r.symbol}',${r.price})">
      📈 Options Activity ▾
    </button>
    <div id="options_${r.symbol}" class="analyst-content" style="display:none"></div>
  </div>

  <!-- ─── Analyst Rating (lazy) ─── -->
  <div class="analyst-section">
    <button class="analyst-toggle" id="analyst_btn_${r.symbol}"
            onclick="toggleAnalyst('${r.symbol}','${r.tv_symbol||r.symbol}',${r.tv_recommend??r.composite??null})">
      📊 Analyst Rating ▾
    </button>
    <div id="analyst_${r.symbol}" class="analyst-content" style="display:none"></div>
  </div>

  <!-- ─── Support / Resistance ─── -->
  ${(r.support||r.resistance) ? `
  <div class="sk-sr-row">
    <span class="sr-item support">▲ S: $${parseFloat(r.support||0).toFixed(2)}</span>
    <span class="sr-item resistance">▼ R: $${parseFloat(r.resistance||0).toFixed(2)}</span>
  </div>` : ''}

  <!-- ─── Footer ─── -->
  <div class="card-footer">
    <button class="cf-btn danger" onclick="dismissCard('${r.symbol}')" title="Dismiss" aria-label="Dismiss ${r.symbol}">✕</button>
    <a href="${tvLink}" target="_blank" rel="noopener" class="cf-btn chart-btn" title="Open chart in TradingView">📊 Chart</a>
    <button class="cf-btn${isW?' watch-active':''}" onclick="toggleWatch('${r.symbol}')">
      ${isW?'📌':'👁'} Watch
    </button>
    <button class="cf-btn" onclick="openAlertModal('${r.symbol}')" title="Set alert" aria-label="Set alert for ${r.symbol}">🔔</button>
    <button class="cf-btn${compareList.some(s=>s.symbol===r.symbol)?' watch-active':''}"
            onclick="toggleCompare('${r.symbol}')" title="Compare" aria-label="Compare ${r.symbol}">
      ${compareList.some(s=>s.symbol===r.symbol)?'✓ Cmp':'⊕ Cmp'}
    </button>
    <span class="sk-votes">${dnV}↓ | ${upV}↑</span>
  </div>

</div>`;
}

// ── Card Actions ──────────────────────────────────────────────────────────
function calcTargets(symbol, atr, direction) {
  const entry = parseFloat(document.getElementById(`en_${symbol}`)?.value);
  if (!entry || !atr) return;
  const m = direction === 'Bullish' ? 1 : -1;
  // AB.SK formula: Stop=5×ATR, G1=2.5×ATR, G2=5×ATR, G3=7.5×ATR
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v.toFixed(4); };
  set(`sl_${symbol}`, entry - m * 5.0 * atr);
  set(`t1_${symbol}`, entry + m * 2.5 * atr);
  set(`t2_${symbol}`, entry + m * 5.0 * atr);
  set(`t3_${symbol}`, entry + m * 7.5 * atr);

  watchedSet.add(symbol);
  document.getElementById(`card_${symbol}`)?.classList.add('watched');
}

function toggleWatch(symbol) {
  watchedSet.has(symbol) ? watchedSet.delete(symbol) : watchedSet.add(symbol);
  saveWatchlist();
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
  const txt = document.getElementById('scanBtnText');
  if (txt && !on) txt.textContent = '🔍 START SCAN';
  if (txt && on)  txt.textContent = '⏳ SCANNING…';
  if (!on) stopProgressAnim();
}

// ── Progress animation ────────────────────────────────────────────────────
let _progTimer = null;
let _progVal   = 0;

function startProgressAnim(total) {
  _progVal = 0;
  const fill = document.getElementById('overlayProgressFill');
  const note = document.getElementById('overlayNote');
  if (fill) fill.style.width = '0%';
  if (note) note.textContent = 'Connecting to data source…';

  let step = 0;
  const msgs = [
    'Fetching real-time quotes…',
    `Analyzing ${Math.round(total * 0.3)} stocks…`,
    `Analyzing ${Math.round(total * 0.6)} stocks…`,
    `Analyzing ${Math.round(total * 0.85)} stocks…`,
    'Computing indicators…',
    'Ranking signals…',
    'Almost done…',
  ];
  _progTimer = setInterval(() => {
    // Fast to 80%, then slow
    const target = step < msgs.length - 1 ? (step + 1) / msgs.length * 82 : 90;
    _progVal = Math.min(_progVal + (target - _progVal) * 0.3, 90);
    if (fill) fill.style.width = _progVal + '%';
    if (note && step < msgs.length) note.textContent = msgs[step] || '';
    step++;
    if (step >= msgs.length) clearInterval(_progTimer);
  }, 800);
}

function stopProgressAnim() {
  clearInterval(_progTimer);
  const fill = document.getElementById('overlayProgressFill');
  if (fill) { fill.style.width = '100%'; setTimeout(() => { fill.style.width = '0%'; }, 400); }
}

// ── Chart Modal ───────────────────────────────────────────────────────────
function openChart(symbol, tvSymbol, name) {
  _chartSymbol = tvSymbol || symbol;
  document.getElementById('chartSym').textContent  = symbol;
  document.getElementById('chartName').textContent = name ? ' — ' + name : '';
  // Match chart TF to current scan TF
  const tfMap = { '1d':'D', '4h':'240', '1h':'60', '15m':'15' };
  const sel = document.getElementById('chartTfSel');
  if (sel) sel.value = tfMap[lastTF] || 'D';
  _loadChartIframe();
  document.getElementById('chartModal').style.display = 'flex';
}

function reloadChart() { _loadChartIframe(); }

function _loadChartIframe() {
  const theme    = document.body.classList.contains('light') ? 'light' : 'dark';
  const interval = document.getElementById('chartTfSel')?.value || 'D';
  const sym      = encodeURIComponent(_chartSymbol);
  const url = `https://www.tradingview.com/widgetembed/?symbol=${sym}&interval=${interval}` +
              `&theme=${theme}&style=1&locale=en&toolbar_bg=f1f3f6` +
              `&enable_publishing=0&hide_top_toolbar=0&hide_side_toolbar=0&allow_symbol_change=0` +
              `&save_image=0&studies=[]&hideideas=1`;
  document.getElementById('chartIframe').src = url;
}

function closeChart() {
  document.getElementById('chartModal').style.display = 'none';
  document.getElementById('chartIframe').src = '';
}

// ══════════════════════════════════════════════════════════════════════════
//  ANALYST RATING GAUGE
// ══════════════════════════════════════════════════════════════════════════

// SVG arc points (cx=100,cy=100,r=75): angles 0°/60°/120°/180°
// x = 100+75*cos(θ),  y = 100-75*sin(θ)
// Three segments: Sell (left), Hold (centre), Buy (right)
const _ARC3 = [
  [175.0, 100.0],  // 0°  — right (Buy end)
  [137.5,  35.1],  // 60°
  [ 62.5,  35.1],  // 120°
  [ 25.0, 100.0],  // 180° — left (Sell end)
];

function _buildGaugeSVG(buy, hold, sell, total, target, targetH, targetL, source) {
  if (!total) return `<div class="ag-nodata">No analyst data available</div>`;

  // Score 1–3: sell=1, hold=2, buy=3
  const score    = (buy * 3 + hold * 2 + sell * 1) / total;
  // Map 1–3 → angle 180°→0°
  const norm     = (score - 1) / 2;
  const angleDeg = 180 - norm * 180;
  const angleRad = angleDeg * Math.PI / 180;
  const nx = (100 + 58 * Math.cos(angleRad)).toFixed(1);
  const ny = (100 - 58 * Math.sin(angleRad)).toFixed(1);

  const label      = score >= 2.6 ? 'Buy'
                   : score >= 1.4 ? 'Neutral'
                   :                'Sell';
  const labelColor = score >= 2.6 ? '#00bfa5'
                   : score >= 1.4 ? '#ffd740'
                   :                '#ff5722';

  // 3-segment arc: Sell → Hold → Buy (left to right)
  const segData = [
    { x1:_ARC3[3][0], y1:_ARC3[3][1], x2:_ARC3[2][0], y2:_ARC3[2][1], col:'#ff5722' }, // Sell
    { x1:_ARC3[2][0], y1:_ARC3[2][1], x2:_ARC3[1][0], y2:_ARC3[1][1], col:'#ffd740' }, // Hold
    { x1:_ARC3[1][0], y1:_ARC3[1][1], x2:_ARC3[0][0], y2:_ARC3[0][1], col:'#00bfa5' }, // Buy
  ];
  const segs = segData.map(s =>
    `<path d="M ${s.x1},${s.y1} A 75,75 0 0,1 ${s.x2},${s.y2}"
       fill="none" stroke="${s.col}" stroke-width="14" stroke-linecap="butt"/>`
  ).join('');

  const pct = v => Math.round(v / total * 100);

  const targetRow = target ? `
    <div class="ag-targets">
      <div class="ag-tgt-item">
        <span class="ag-tgt-lbl">Avg Target</span>
        <span class="ag-tgt-val">$${target}</span>
      </div>
      ${targetH ? `<div class="ag-tgt-item">
        <span class="ag-tgt-lbl">High</span>
        <span class="ag-tgt-val" style="color:var(--green)">$${targetH}</span>
      </div>` : ''}
      ${targetL ? `<div class="ag-tgt-item">
        <span class="ag-tgt-lbl">Low</span>
        <span class="ag-tgt-val" style="color:var(--red)">$${targetL}</span>
      </div>` : ''}
    </div>` : '';

  return `
<div class="ag-wrap">
  <div class="ag-title">Analyst Rating <span class="ag-src">${source||'TradingView'}</span></div>
  <div class="ag-sub">Based on ${total} analysts</div>

  <svg viewBox="0 0 200 115" class="ag-svg" xmlns="http://www.w3.org/2000/svg">
    <path d="M 25,100 A 75,75 0 0,1 175,100"
          fill="none" stroke="rgba(255,255,255,.07)" stroke-width="14" stroke-linecap="round"/>
    ${segs}
    <text x="16"  y="113" font-size="7" fill="#777" text-anchor="middle">Sell</text>
    <text x="184" y="113" font-size="7" fill="#777" text-anchor="middle">Buy</text>
    <text x="100" y="16"  font-size="7" fill="#777" text-anchor="middle">Neutral</text>
    <line x1="100" y1="100" x2="${nx}" y2="${ny}"
          stroke="white" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="100" cy="100" r="5" fill="white"/>
  </svg>

  <div class="ag-label" style="color:${labelColor}">${label}</div>

  <div class="ag-bars">
    ${[
      { lbl:'Buy',  v:buy,  col:'#00bfa5' },
      { lbl:'Hold', v:hold, col:'#888888' },
      { lbl:'Sell', v:sell, col:'#ff5722' },
    ].map(r => `
    <div class="ag-bar-row">
      <span class="ag-bar-lbl">${r.lbl}</span>
      <div class="ag-bar-track">
        <div class="ag-bar-fill" style="width:${pct(r.v)}%;background:${r.col}"></div>
      </div>
      <span class="ag-bar-num">${r.v}</span>
    </div>`).join('')}
  </div>
  ${targetRow}
</div>`;
}

async function toggleAnalyst(symbol, tvSymbol, tvRec) {
  const content = document.getElementById(`analyst_${symbol}`);
  const btn     = document.getElementById(`analyst_btn_${symbol}`);
  if (!content) return;

  if (content.style.display !== 'none') {
    content.style.display = 'none';
    if (btn) btn.textContent = '📊 Analyst Rating ▾';
    return;
  }
  content.style.display = 'block';
  if (btn) btn.textContent = '📊 Analyst Rating ▴';
  if (content.dataset.loaded) return;

  content.innerHTML = '<div class="ag-loading"><div class="spinner" style="width:24px;height:24px;margin:0 auto 8px"></div>Loading from TradingView…</div>';
  try {
    const res = await fetch('/api/analyst', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ symbol, tv_symbol: tvSymbol || '', tv_rec: tvRec }),
    });
    const d = await res.json();
    content.dataset.loaded = '1';

    if (d.total > 0) {
      // Real analyst consensus data available
      content.innerHTML = _buildGaugeSVG(d.buy||0, d.hold||0, d.sell||0,
                                          d.total, d.target, d.target_h, d.target_l, d.source);
    } else if (d.target) {
      // Only price targets available, no count breakdown
      content.innerHTML = _buildGaugeSVG(0, 0, 0, 0,
                                          d.target, d.target_h, d.target_l, d.source);
    } else if (d.tv_rec !== null && d.tv_rec !== undefined) {
      // Fallback: use TradingView technical consensus (-1→1)
      content.innerHTML = _buildTvRecGauge(d.tv_rec, d.source);
    } else {
      content.innerHTML = '<div class="ag-nodata">No analyst data available for this stock</div>';
    }
  } catch(e) {
    content.innerHTML = '<div class="ag-nodata">Failed to load — try again</div>';
  }
}

function _buildTvRecGauge(rec, source) {
  // rec is TradingView Recommend.All (-1 to +1)
  const norm     = (rec + 1) / 2;              // 0→1
  const angleDeg = 180 - norm * 180;
  const angleRad = angleDeg * Math.PI / 180;
  const nx = (100 + 58 * Math.cos(angleRad)).toFixed(1);
  const ny = (100 - 58 * Math.sin(angleRad)).toFixed(1);

  const label      = rec >= 0.5  ? 'Strong Buy'
                   : rec >= 0.1  ? 'Buy'
                   : rec > -0.1  ? 'Neutral'
                   : rec > -0.5  ? 'Sell'
                   :               'Strong Sell';
  const labelColor = rec >= 0.5  ? '#00bfa5'
                   : rec >= 0.1  ? '#69f0ae'
                   : rec > -0.1  ? '#ffd740'
                   : rec > -0.5  ? '#ff9800'
                   :               '#ff5722';

  const segData = [
    { x1:_ARC3[3][0], y1:_ARC3[3][1], x2:_ARC3[2][0], y2:_ARC3[2][1], col:'#ff5722' },
    { x1:_ARC3[2][0], y1:_ARC3[2][1], x2:_ARC3[1][0], y2:_ARC3[1][1], col:'#ffd740' },
    { x1:_ARC3[1][0], y1:_ARC3[1][1], x2:_ARC3[0][0], y2:_ARC3[0][1], col:'#00bfa5' },
  ];
  const segs = segData.map(s =>
    `<path d="M ${s.x1},${s.y1} A 75,75 0 0,1 ${s.x2},${s.y2}"
       fill="none" stroke="${s.col}" stroke-width="14" stroke-linecap="butt"/>`
  ).join('');

  return `
<div class="ag-wrap">
  <div class="ag-title">Technical Consensus <span class="ag-src">TradingView</span></div>
  <div class="ag-sub">Based on TradingView's 26-indicator rating</div>
  <svg viewBox="0 0 200 115" class="ag-svg" xmlns="http://www.w3.org/2000/svg">
    <path d="M 25,100 A 75,75 0 0,1 175,100"
          fill="none" stroke="rgba(255,255,255,.07)" stroke-width="14" stroke-linecap="round"/>
    ${segs}
    <text x="16"  y="113" font-size="7" fill="#777" text-anchor="middle">Sell</text>
    <text x="184" y="113" font-size="7" fill="#777" text-anchor="middle">Buy</text>
    <text x="100" y="16"  font-size="7" fill="#777" text-anchor="middle">Neutral</text>
    <line x1="100" y1="100" x2="${nx}" y2="${ny}"
          stroke="white" stroke-width="2.5" stroke-linecap="round"/>
    <circle cx="100" cy="100" r="5" fill="white"/>
  </svg>
  <div class="ag-label" style="color:${labelColor}">${label}</div>
  <div class="ag-sub" style="margin-top:8px">Score: ${(rec*100).toFixed(0)} / 100</div>
</div>`;
}

// ══════════════════════════════════════════════════════════════════════════
//  OPTIONS SCANNER  (dedicated tab)
// ══════════════════════════════════════════════════════════════════════════
let optScanData    = [];   // accumulated results
let optScanRunning = false;

function startOptionsScan() {
  const count  = parseInt(document.getElementById('optScanCount')?.value || 10);
  const stocks = allResults.slice(0, count);

  if (!stocks.length) {
    document.getElementById('optEmptyState').style.display = 'block';
    document.getElementById('optTableWrap').style.display  = 'none';
    document.getElementById('optScanSub').textContent      = 'Run the main scan first';
    return;
  }

  // Build options metrics from scan data already in memory — no extra API calls
  optScanData = stocks.map(r => {
    const pcr      = r.put_call_ratio || 0;
    const vol      = r.volatility_d   || 0;   // annualised IV proxy
    const vr       = r.vol_ratio      || 1;

    const pcrSig   = pcr > 0 ? (pcr < 0.5 ? 'bullish' : pcr > 1.2 ? 'bearish' : 'neutral')
                              : (r.direction === 'Bullish' ? 'bullish'
                                 : r.direction === 'Bearish' ? 'bearish' : 'neutral');
    const ivSig    = vol > 80 ? 'very_high' : vol > 50 ? 'high'
                   : vol > 35 ? 'elevated'  : vol > 15 ? 'normal' : 'low';

    // Approximate UOA from volume spike — high vol_ratio = unusual activity
    const uoaCalls = vr >= 1.5
      ? [{ type:'call', strike:'—', volume: r.volume||0, oi: 0,
           vol_oi: Math.round(vr * 10) / 10, iv: vol, otm: true }]
      : [];

    let score = 0;
    if (pcrSig === 'bullish')             score += 2;
    else if (pcrSig === 'bearish')        score -= 2;
    if (r.direction === 'Bullish')        score += 1;
    else if (r.direction === 'Bearish')   score -= 1;
    if (vr >= 1.5)                        score += 1;

    return {
      symbol:      r.symbol,
      expiry:      '—',
      dte:         '—',
      call_vol:    r.volume || 0,
      put_vol:     pcr > 0 ? Math.round((r.volume||0) * pcr) : 0,
      call_oi:     0, put_oi: 0,
      pcr_vol:     pcr || '—',
      pcr_signal:  pcrSig,
      atm_iv:      vol || '—',
      iv_rank:     50,
      iv_signal:   ivSig,
      max_pain:    null, mp_dist: 0,
      uoa_calls:   uoaCalls, uoa_puts: [],
      oi_dist:     [],
      opt_signal:  score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral',
      _scan:       r,
    };
  });

  document.getElementById('optEmptyState').style.display = 'none';
  document.getElementById('optTableWrap').style.display  = 'block';
  document.getElementById('optProgress').style.display   = 'none';
  document.getElementById('optScanSub').textContent      = `${optScanData.length} stocks · data from scan`;

  renderOptTable();
}

function _optRowHTML(d) {
  const scan   = d._scan || {};
  const dc     = scan.direction === 'Bullish' ? 'bull' : scan.direction === 'Bearish' ? 'bear' : '';
  const sigCls = d.opt_signal === 'bullish' ? 'bull' : d.opt_signal === 'bearish' ? 'bear' : '';
  const sigLbl = d.opt_signal === 'bullish' ? '▲ Bullish' : d.opt_signal === 'bearish' ? '▼ Bearish' : '● Neutral';
  const pcrCls = d.pcr_signal === 'bullish' ? 'bull' : d.pcr_signal === 'bearish' ? 'bear' : '';
  const ivCls  = ['high','very_high','elevated'].includes(d.iv_signal) ? 'bear'
               : d.iv_signal === 'low' ? 'bull' : '';
  const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(scan.tv_symbol||d.symbol)}`;

  const vr       = scan.vol_ratio || 1;
  const vrCls    = vr >= 2.0 ? 'fire-ratio' : vr >= 1.5 ? 'bull' : '';
  const vrLbl    = vr >= 2.0 ? `${vr}× 🔥` : vr >= 1.5 ? `${vr}×` : `${vr}×`;
  const pcrDisp  = d.pcr_vol > 0 ? d.pcr_vol : '—';
  const ivDisp   = d.atm_iv  > 0 ? d.atm_iv + '%' : '—';

  return `<tr class="opt-tr ${sigCls}" id="otr_${d.symbol}">
    <td class="opt-td-sym">
      <span class="opt-tr-sym ${dc}">${d.symbol}</span>
      <span style="font-size:.68rem;color:var(--text3)">${scan.name||''}</span>
      <a href="${tvLink}" target="_blank" rel="noopener" class="opt-tr-chart">📊</a>
    </td>
    <td><span class="opt-sig-badge ${sigCls}">${sigLbl}</span></td>
    <td class="${pcrCls}" style="font-weight:700">${pcrDisp}
      <div class="opt-td-sub ${pcrCls}">${d.pcr_signal}</div></td>
    <td class="${ivCls}" style="font-weight:700">${ivDisp}
      <div class="opt-td-sub">${d.iv_signal?.replace('_',' ')}</div></td>
    <td class="${vrCls}" style="font-weight:700">${vrLbl}
      <div class="opt-td-sub">vol spike</div></td>
    <td style="font-weight:700">${scan.score || '—'}
      <div class="opt-td-sub">${scan.direction||''}</div></td>
    <td style="font-weight:700">${scan.rsi || '—'}
      <div class="opt-td-sub">RSI</div></td>
    <td style="font-weight:700">${scan.adx || '—'}
      <div class="opt-td-sub">ADX</div></td>
  </tr>`;
}

function _appendOptRow(d) {
  const tbody = document.getElementById('optTableBody');
  if (!tbody) return;
  const tr = document.createElement('tbody');
  tr.innerHTML = _optRowHTML(d);
  tbody.appendChild(tr.firstElementChild);
}

function renderOptTable() {
  const sig    = document.getElementById('optFilterSig')?.value || 'all';
  const sortBy = document.getElementById('optSortBy')?.value    || 'uoa';

  let list = [...optScanData];

  // Filter
  switch (sig) {
    case 'bullish':  list = list.filter(d => d.opt_signal === 'bullish'); break;
    case 'bearish':  list = list.filter(d => d.opt_signal === 'bearish'); break;
    case 'uoa':      list = list.filter(d => {
      const top = [...(d.uoa_calls||[]),...(d.uoa_puts||[])].sort((a,b)=>b.vol_oi-a.vol_oi)[0];
      return top && top.vol_oi >= 5;
    }); break;
    case 'iv_high':  list = list.filter(d => d.atm_iv >= 50); break;
    case 'low_pcr':  list = list.filter(d => d.pcr_vol < 0.5); break;
  }

  // Sort
  const sortFn = {
    score:     d => -(d._scan?.score    || 0),
    vol_ratio: d => -(d._scan?.vol_ratio || 0),
    pcr_vol:   d => d.pcr_vol || 99,
    atm_iv:    d => -(d.atm_iv || 0),
    rsi:       d => -(d._scan?.rsi || 0),
  };
  list.sort(sortFn[sortBy] || (() => 0));

  const tbody = document.getElementById('optTableBody');
  if (tbody) tbody.innerHTML = list.map(_optRowHTML).join('');
}

// ══════════════════════════════════════════════════════════════════════════
//  OPTIONS ACTIVITY  (per-card section)
// ══════════════════════════════════════════════════════════════════════════

function _fmtV(v) {
  if (!v) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M';
  if (v >= 1_000)     return (v / 1_000).toFixed(0) + 'K';
  return String(v);
}

function _buildOptionsPanel(d, price) {
  if (d.error) return `<div class="opt-nodata">⚠ ${d.error}</div>`;

  const pcrCls = d.pcr_signal === 'bullish' ? 'bull' : d.pcr_signal === 'bearish' ? 'bear' : '';
  const ivCls  = d.iv_signal === 'high' || d.iv_signal === 'very_high' || d.iv_signal === 'elevated' ? 'bear' : d.iv_signal === 'low' ? 'bull' : '';
  const mpCls  = d.mp_dist > 0 ? 'bull' : d.mp_dist < 0 ? 'bear' : '';
  const sigCls = d.opt_signal === 'bullish' ? 'bull' : d.opt_signal === 'bearish' ? 'bear' : '';
  const sigLbl = d.opt_signal === 'bullish' ? '▲ Bullish' : d.opt_signal === 'bearish' ? '▼ Bearish' : '● Neutral';

  const pcrInterpret = d.pcr_vol < 0.5  ? 'Heavy call buying — bullish sentiment'
                     : d.pcr_vol > 1.2  ? 'Heavy put buying — bearish / hedging'
                     :                    'Balanced positioning';

  const ivInterpret  = d.iv_signal === 'very_high' ? 'Expensive — major event expected'
                     : d.iv_signal === 'high'      ? 'Elevated — event risk present'
                     : d.iv_signal === 'elevated'  ? 'Above average — watch for breakout'
                     : d.iv_signal === 'normal'    ? 'Normal range'
                     :                               'Low — options cheap';

  // UOA rows
  const uoaAll = [...(d.uoa_calls||[]), ...(d.uoa_puts||[])]
    .sort((a,b) => b.vol_oi - a.vol_oi).slice(0,6);

  const uoaHTML = uoaAll.length ? `
  <div class="opt-sec-title">Unusual Options Activity</div>
  <div class="opt-uoa-table">
    <div class="opt-uoa-head">
      <span>Type</span><span>Strike</span><span>Volume</span>
      <span>OI</span><span>Vol/OI</span><span>IV%</span>
    </div>
    ${uoaAll.map(u => `
    <div class="opt-uoa-row ${u.type === 'call' ? 'bull' : 'bear'}">
      <span class="opt-type-tag ${u.type === 'call' ? 'call-tag' : 'put-tag'}">${u.type.toUpperCase()}${u.otm ? ' OTM' : ''}</span>
      <span class="opt-strike">$${u.strike}</span>
      <span class="opt-vol">${_fmtV(u.volume)}</span>
      <span class="opt-oi-num">${_fmtV(u.oi)}</span>
      <span class="opt-ratio ${u.vol_oi >= 5 ? 'fire-ratio' : ''}">${u.vol_oi}×</span>
      <span class="opt-iv">${u.iv}%</span>
    </div>`).join('')}
  </div>` : '<div class="opt-nodata" style="font-size:.75rem;padding:8px 0">No unusual activity detected</div>';

  // OI Distribution
  const maxOI = Math.max(...(d.oi_dist||[]).flatMap(r => [r.call_oi, r.put_oi]), 1);
  const oiHTML = (d.oi_dist||[]).length ? `
  <div class="opt-sec-title">Open Interest by Strike <span style="opacity:.5;font-weight:400">★ Max Pain  ◀ Price</span></div>
  <div class="opt-oi-chart">
    ${(d.oi_dist||[]).map(r => {
      const cW = Math.round(r.call_oi / maxOI * 100);
      const pW = Math.round(r.put_oi  / maxOI * 100);
      const atP = price && Math.abs(r.strike - price) / price < 0.012;
      const isMP = d.max_pain && r.strike === d.max_pain;
      return `<div class="opt-oi-row${atP?' at-price':''}${isMP?' is-maxpain':''}">
        <span class="opt-oi-strike">${r.strike}${atP?' ◀':''}${isMP?' ★':''}</span>
        <div class="opt-oi-bars">
          <div class="opt-bar-half call-half">
            <div class="opt-bar-fill call-fill" style="width:${cW}%"></div>
          </div>
          <div class="opt-bar-half put-half">
            <div class="opt-bar-fill put-fill" style="width:${pW}%"></div>
          </div>
        </div>
        <span class="opt-oi-nums"><span class="bull">${_fmtV(r.call_oi)}</span>/<span class="bear">${_fmtV(r.put_oi)}</span></span>
      </div>`;
    }).join('')}
    <div class="opt-oi-legend">
      <span class="bull">■ Calls</span><span class="bear">■ Puts</span>
    </div>
  </div>` : '';

  return `
<div class="opt-wrap">

  <!-- Header: expiry + signal -->
  <div class="opt-header">
    <span class="opt-expiry">Exp: ${d.expiry} &nbsp;·&nbsp; ${d.dte}d to expiry</span>
    <span class="opt-sig-badge ${sigCls}">${sigLbl}</span>
  </div>

  <!-- 3 key metrics -->
  <div class="opt-key-metrics">
    <div class="opt-km">
      <div class="opt-km-val ${pcrCls}">${d.pcr_vol}</div>
      <div class="opt-km-lbl">P/C Ratio</div>
      <div class="opt-km-hint ${pcrCls}">${d.pcr_signal.toUpperCase()}</div>
    </div>
    <div class="opt-km">
      <div class="opt-km-val ${ivCls}">${d.atm_iv}%</div>
      <div class="opt-km-lbl">ATM IV &nbsp;<span style="font-size:.6rem;opacity:.6">IVR ${d.iv_rank}%</span></div>
      <div class="opt-km-hint">${d.iv_signal.replace('_',' ').toUpperCase()}</div>
    </div>
    <div class="opt-km">
      <div class="opt-km-val ${mpCls}">$${d.max_pain}</div>
      <div class="opt-km-lbl">Max Pain</div>
      <div class="opt-km-hint ${mpCls}">${d.mp_dist > 0 ? '+' : ''}${d.mp_dist}% from price</div>
    </div>
  </div>

  <!-- Interpret P/C -->
  <div class="opt-interpret">${pcrInterpret} &nbsp;·&nbsp; ${ivInterpret}</div>

  <!-- Volume / OI summary row -->
  <div class="opt-vol-row">
    <div class="opt-vr"><span class="opt-vr-lbl">Call Vol</span><span class="opt-vr-val bull">${_fmtV(d.call_vol)}</span></div>
    <div class="opt-vr"><span class="opt-vr-lbl">Put Vol</span><span class="opt-vr-val bear">${_fmtV(d.put_vol)}</span></div>
    <div class="opt-vr"><span class="opt-vr-lbl">Call OI</span><span class="opt-vr-val bull">${_fmtV(d.call_oi)}</span></div>
    <div class="opt-vr"><span class="opt-vr-lbl">Put OI</span><span class="opt-vr-val bear">${_fmtV(d.put_oi)}</span></div>
  </div>

  ${uoaHTML}
  ${oiHTML}

</div>`;
}

async function toggleOptions(symbol, price) {
  const content = document.getElementById(`options_${symbol}`);
  const btn     = document.getElementById(`options_btn_${symbol}`);
  if (!content) return;

  if (content.style.display !== 'none') {
    content.style.display = 'none';
    if (btn) btn.textContent = '📈 Options Activity ▾';
    return;
  }
  content.style.display = 'block';
  if (btn) btn.textContent = '📈 Options Activity ▴';
  if (content.dataset.loaded) return;

  content.innerHTML = '<div class="ag-loading"><div class="spinner" style="width:24px;height:24px;margin:0 auto 8px"></div>Loading options data…</div>';
  try {
    const res = await fetch('/api/options', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ symbol, price }),
    });
    const d = await res.json();

    if (res.status === 429 || d.rate_limited) {
      // Don't mark loaded — allow retry
      content.innerHTML = `
        <div class="opt-rate-limit">
          <div class="opt-rl-icon">⏳</div>
          <div class="opt-rl-msg">Yahoo Finance rate limit — wait 30–60 s then retry</div>
          <button class="opt-retry-btn" onclick="
            document.getElementById('options_${symbol}').dataset.loaded='';
            toggleOptions('${symbol}',${price})">↺ Retry</button>
        </div>`;
      return;
    }

    content.dataset.loaded = '1';
    content.innerHTML = _buildOptionsPanel(d, price);
  } catch(e) {
    content.innerHTML = `<div class="opt-nodata">Failed to load options data<br>
      <button class="opt-retry-btn" style="margin-top:8px" onclick="
        document.getElementById('options_${symbol}').dataset.loaded='';
        toggleOptions('${symbol}',${price})">↺ Retry</button></div>`;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  COMPARE MODE
// ══════════════════════════════════════════════════════════════════════════
function toggleCompare(symbol) {
  const r = allResults.find(x => x.symbol === symbol);
  if (!r) return;
  const idx = compareList.findIndex(s => s.symbol === symbol);
  if (idx > -1) {
    compareList.splice(idx, 1);
  } else {
    if (compareList.length >= 2) { alert('Already comparing 2 stocks. Remove one first.'); return; }
    compareList.push(r);
  }
  updateCompareBar();
  render();
}

function updateCompareBar() {
  const bar = document.getElementById('compareBar');
  const txt = document.getElementById('compareBarText');
  const btn = document.getElementById('compareBtn');
  if (!bar) return;
  bar.style.display = compareList.length > 0 ? 'flex' : 'none';
  if (txt) txt.textContent = compareList.map(s => s.symbol).join(' vs ');
  if (btn) btn.disabled = compareList.length < 2;
}

function clearCompare() {
  compareList = [];
  updateCompareBar();
  render();
}

function openCompareModal() {
  if (compareList.length < 2) return;
  const [a, b] = compareList;
  const metrics = [
    { label:'Score',         va:a.score,       vb:b.score,       higher:true,  fmt:v=>v },
    { label:'Price',         va:a.price,       vb:b.price,       higher:null,  fmt:v=>'$'+parseFloat(v).toFixed(2) },
    { label:'Change %',      va:a.change_pct,  vb:b.change_pct,  higher:true,  fmt:v=>v+'%' },
    { label:'RSI',           va:a.rsi,         vb:b.rsi,         higher:false, fmt:v=>v },
    { label:'ADX',           va:a.adx||0,      vb:b.adx||0,      higher:true,  fmt:v=>v },
    { label:'Vol Ratio',     va:a.vol_ratio,   vb:b.vol_ratio,   higher:true,  fmt:v=>v+'x' },
    { label:'Up Votes',      va:a.up_votes||0, vb:b.up_votes||0, higher:true,  fmt:v=>v },
    { label:'Signal Type',   va:a.signal_type, vb:b.signal_type, higher:null,  fmt:v=>v||'—' },
    { label:'Support',       va:a.support||0,  vb:b.support||0,  higher:null,  fmt:v=>v?'$'+parseFloat(v).toFixed(2):'—' },
    { label:'Resistance',    va:a.resistance||0,vb:b.resistance||0,higher:null,fmt:v=>v?'$'+parseFloat(v).toFixed(2):'—' },
    { label:'ATR',           va:a.atr||0,      vb:b.atr||0,      higher:null,  fmt:v=>v },
  ];
  const rows = metrics.map(m => {
    const aWins = m.higher===true?(m.va>m.vb):m.higher===false?(m.va<m.vb):null;
    const aC = aWins===true?'cmp-win':aWins===false?'cmp-lose':'';
    const bC = aWins===false?'cmp-win':aWins===true?'cmp-lose':'';
    return `<tr>
      <td class="cmp-metric">${m.label}</td>
      <td class="cmp-val ${aC}">${m.fmt(m.va)}</td>
      <td class="cmp-val ${bC}">${m.fmt(m.vb)}</td>
    </tr>`;
  }).join('');
  document.getElementById('compareContent').innerHTML = `
    <h3 class="cmp-title">${a.symbol} <span style="opacity:.4">vs</span> ${b.symbol}</h3>
    <div class="cmp-sub">${a.name||''} · ${b.name||''}</div>
    <table class="cmp-table">
      <thead><tr>
        <th>Metric</th>
        <th>${a.symbol}</th>
        <th>${b.symbol}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  document.getElementById('compareModal').style.display = 'flex';
}

// ══════════════════════════════════════════════════════════════════════════
//  PRICE / SIGNAL ALERTS
// ══════════════════════════════════════════════════════════════════════════
(function initAlerts() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
})();

function openAlertModal(symbol) {
  const r = allResults.find(x => x.symbol === symbol);
  if (!r) return;
  const alerts = JSON.parse(localStorage.getItem('usa_alerts') || '[]');
  const existing = alerts.filter(a => a.symbol === symbol);
  document.getElementById('alertContent').innerHTML = `
    <h3 class="cmp-title">🔔 Alerts for ${symbol}</h3>
    <div class="cmp-sub">Current price: $${parseFloat(r.price).toFixed(2)} · Score: ${r.score}</div>
    <div class="alert-form">
      <div class="alert-row">
        <select id="alertType" class="ctrl-select">
          <option value="price_above">Price ≥</option>
          <option value="price_below">Price ≤</option>
          <option value="score_above">Score ≥</option>
        </select>
        <input id="alertValue" class="range-inp" type="number" placeholder="Value" style="flex:1">
        <button class="cf-btn chart-btn" onclick="saveAlert('${symbol}')">+ Add</button>
      </div>
    </div>
    ${existing.length ? `<div class="alert-existing">
      <div class="cmp-sub" style="margin-bottom:6px">Active alerts:</div>
      ${existing.map((a,i)=>`<div class="alert-item">
        <span>${a.type==='price_above'?'Price ≥':a.type==='price_below'?'Price ≤':'Score ≥'} ${a.value}</span>
        <button onclick="removeAlert('${symbol}',${i})" class="cf-btn danger">✕</button>
      </div>`).join('')}
    </div>` : ''}`;
  document.getElementById('alertModal').style.display = 'flex';
}

function saveAlert(symbol) {
  const type  = document.getElementById('alertType')?.value;
  const value = parseFloat(document.getElementById('alertValue')?.value);
  if (!type || isNaN(value)) return;
  const alerts = JSON.parse(localStorage.getItem('usa_alerts') || '[]');
  alerts.push({ symbol, type, value, ts: Date.now() });
  localStorage.setItem('usa_alerts', JSON.stringify(alerts));
  openAlertModal(symbol);
}

function removeAlert(symbol, idx) {
  let alerts = JSON.parse(localStorage.getItem('usa_alerts') || '[]');
  const symAlerts = alerts.filter(a => a.symbol === symbol);
  symAlerts.splice(idx, 1);
  alerts = [...alerts.filter(a => a.symbol !== symbol), ...symAlerts];
  localStorage.setItem('usa_alerts', JSON.stringify(alerts));
  openAlertModal(symbol);
}

function closeAlertModal() { document.getElementById('alertModal').style.display = 'none'; }

function checkAlerts(results) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const alerts = JSON.parse(localStorage.getItem('usa_alerts') || '[]');
  alerts.forEach(a => {
    const s = results.find(r => r.symbol === a.symbol);
    if (!s) return;
    let triggered = false;
    let msg = '';
    if (a.type === 'price_above' && s.price >= a.value) { triggered = true; msg = `Price $${s.price} ≥ $${a.value}`; }
    if (a.type === 'price_below' && s.price <= a.value) { triggered = true; msg = `Price $${s.price} ≤ $${a.value}`; }
    if (a.type === 'score_above' && s.score >= a.value) { triggered = true; msg = `Score ${s.score} ≥ ${a.value}`; }
    if (triggered) new Notification(`📈 ${a.symbol} Alert`, { body: msg, icon: '/static/favicon.ico' });
  });
}

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

  const BULL_WORDS = ['beat','surge','upgrade','record','rally','growth','profit','soar','rise','strong','exceed'];
  const BEAR_WORDS = ['miss','drop','downgrade','loss','cut','decline','risk','fall','weak','below','layoff'];
  function scoreSentiment(title) {
    const h = (title||'').toLowerCase();
    const b = BULL_WORDS.filter(w => h.includes(w)).length;
    const r = BEAR_WORDS.filter(w => h.includes(w)).length;
    if (b > r) return 'pos';
    if (r > b) return 'neg';
    return '';
  }

  feed.innerHTML = list.map(n => {
    const emoji    = CAT_EMOJI[n.cat_cls] || '📰';
    const sentCls  = n.sentiment === 'pos' ? 'pos' : n.sentiment === 'neg' ? 'neg' : scoreSentiment(n.title);
    const sent     = sentCls;
    const sentBadge = sentCls === 'pos' ? '<span class="sent-badge pos">▲ Bullish</span>'
                    : sentCls === 'neg' ? '<span class="sent-badge neg">▼ Bearish</span>' : '';
    const thumb = n.thumb
      ? `<img class="ni-thumb" src="${n.thumb}" alt="" onerror="this.style.display='none'">`
      : '';
    return `
      <div class="news-item ${sent}">
        <div class="ni-sym">${n.symbol}</div>
        <div class="ni-body">
          <div class="ni-meta">
            <span class="ni-cat-tag nc-${n.cat_cls}">${emoji} ${n.cat}</span>
            ${sentBadge}
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

