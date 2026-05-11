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
    showAccuracyReport(data);
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
    <span class="cp-val">$${(r.price||0).toLocaleString()}</span>
    ${r.supertrend ? `<span class="st-badge ${r.supertrend_dir===1?'bull':'bear'} ml-auto">ST ${r.supertrend_dir===1?'▲':'▼'} ${r.supertrend}</span>` : ''}
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

  <!-- ─── Footer ─── -->
  <div class="card-footer">
    <button class="cf-btn danger" onclick="dismissCard('${r.symbol}')" title="Dismiss">✕</button>
    <a href="${tvLink}" target="_blank" rel="noopener" class="cf-btn chart-btn">Details ▼</a>
    <button class="cf-btn${isW?' watch-active':''}" onclick="toggleWatch('${r.symbol}')">
      ${isW?'📌 Watching':'Scan ⊘'}
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

