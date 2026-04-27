'use strict';

let allResults  = [];
let activeTab   = 'all';
let sortKey     = 'score';
let sortAsc     = false;
let lastTF      = '1d';

// ── Clock & market status ─────────────────────────────────────────────────
function updateClock() {
  const fmt = (o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...o }).format(new Date());
  document.getElementById('nyTime').textContent =
    `NY: ${fmt({ weekday:'short', month:'short', day:'numeric' })}, ${fmt({ hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true })}`;

  const h   = parseInt(fmt({ hour: 'numeric', hour12: false }));
  const m   = parseInt(fmt({ minute: 'numeric' }));
  const day = fmt({ weekday: 'short' });
  const el  = document.getElementById('marketStatus');

  const wknd = ['Sat','Sun'].includes(day);
  if (!wknd && ((h === 9 && m >= 30) || (h > 9 && h < 16))) {
    el.textContent = '● MARKET OPEN'; el.className = 'market-badge open';
  } else if (!wknd && h >= 4 && (h < 9 || (h === 9 && m < 30))) {
    el.textContent = '◑ PRE-MARKET';  el.className = 'market-badge pre';
  } else if (!wknd && h >= 16 && h < 20) {
    el.textContent = '◑ AFTER HOURS'; el.className = 'market-badge pre';
  } else {
    el.textContent = '● CLOSED · Last session data'; el.className = 'market-badge closed';
  }
}
updateClock();
setInterval(updateClock, 1000);

// ── Timeframe buttons ─────────────────────────────────────────────────────
document.querySelectorAll('.tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    lastTF = btn.dataset.tf;
  });
});

// ── Tabs ──────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeTab = tab.dataset.tab;
    render();
  });
});

// ── Scan ──────────────────────────────────────────────────────────────────
async function startScan(force = false) {
  const timeframe = document.querySelector('.tf-btn.active').dataset.tf;
  const minScore  = parseInt(document.getElementById('minScore').value) || 40;
  const sector    = document.getElementById('sectorSel').value;
  const symRaw    = document.getElementById('symInput').value.trim();
  const symbols   = symRaw ? symRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  lastTF          = timeframe;

  setLoading(true);
  try {
    const res = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeframe, min_score: minScore, sector, symbols, force }),
    });
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();

    allResults = data.results;
    updateStats(data);
    document.getElementById('statsBar').style.display = 'flex';
    document.getElementById('tabBar').style.display   = 'flex';
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.tab[data-tab="all"]').classList.add('active');
    activeTab = 'all';
    render();
  } catch (err) {
    document.getElementById('resultsWrap').innerHTML = `<div class="error-msg">❌ ${err.message}</div>`;
  } finally {
    setLoading(false);
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────
function updateStats(d) {
  document.getElementById('sAnalyzed').textContent = d.total_scanned;
  document.getElementById('sFound').textContent    = d.total_found;
  document.getElementById('sBull').textContent     = d.bullish_count;
  document.getElementById('sBear').textContent     = d.bearish_count;
  document.getElementById('sStrong').textContent   = d.strong_count;
  document.getElementById('sTime').textContent     = d.timestamp;
  document.getElementById('sDataAsOf').textContent = d.data_as_of || '—';

  const srcBadge = document.getElementById('sourceBadge');
  srcBadge.textContent  = d.source === 'TradingView' ? '📡 TradingView' : '📊 Yahoo Finance';
  srcBadge.className    = 'source-badge ' + (d.source === 'TradingView' ? 'src-tv' : 'src-yf');
  srcBadge.style.display = 'inline-flex';

  const ct = document.getElementById('cacheTag');
  ct.style.display = d.from_cache ? 'inline-flex' : 'none';
}

// ── Filter & render ───────────────────────────────────────────────────────
function filtered() {
  switch (activeTab) {
    case 'bullish': return allResults.filter(r => r.direction === 'Bullish');
    case 'bearish': return allResults.filter(r => r.direction === 'Bearish');
    case 'strong':  return allResults.filter(r => r.score >= 70);
    default:        return allResults;
  }
}

function render() {
  const rows = [...filtered()].sort((a, b) => {
    const va = a[sortKey], vb = b[sortKey];
    if (va === vb) return 0;
    return (sortAsc ? 1 : -1) * (va < vb ? -1 : 1);
  });

  const wrap = document.getElementById('resultsWrap');
  if (!rows.length) { wrap.innerHTML = '<div class="empty-msg">🔍 No results match the current filters.</div>'; return; }

  wrap.innerHTML = `
    <div class="table-toolbar">
      <span class="result-count">${rows.length} result${rows.length !== 1 ? 's' : ''}</span>
      <button class="refresh-btn" onclick="startScan(true)">↺ Refresh</button>
    </div>
    <div class="table-scroll">
    <table class="results-table">
      <thead><tr>
        <th>#</th>
        <th class="sortable" onclick="setSort('symbol')">Symbol ${si('symbol')}</th>
        <th class="sortable" onclick="setSort('score')">Score ${si('score')}</th>
        <th>Direction</th>
        <th>TV Rating</th>
        <th class="sortable" onclick="setSort('change_pct')">Change ${si('change_pct')}</th>
        <th class="sortable" onclick="setSort('rsi')">RSI ${si('rsi')}</th>
        <th>MACD</th>
        <th>EMA</th>
        <th class="sortable" onclick="setSort('vol_ratio')">Vol ${si('vol_ratio')}</th>
        <th class="sortable" onclick="setSort('price')">Price ${si('price')}</th>
        <th>Sector</th>
      </tr></thead>
      <tbody>${rows.map(buildRow).join('')}</tbody>
    </table>
    </div>`;
}

const si = (key) => sortKey !== key ? '<span style="opacity:.3">↕</span>' : sortAsc ? '↑' : '↓';

function setSort(key) {
  sortAsc = sortKey === key ? !sortAsc : (key === 'symbol');
  sortKey = key;
  render();
}

// ── Row ───────────────────────────────────────────────────────────────────
function buildRow(r, i) {
  const dc    = r.direction === 'Bullish' ? 'bullish' : r.direction === 'Bearish' ? 'bearish' : 'neutral';
  const arrow = r.direction === 'Bullish' ? '▲' : r.direction === 'Bearish' ? '▼' : '●';
  const sc    = r.score >= 80 ? 'score-fire' : r.score >= 65 ? 'score-high' : r.score >= 45 ? 'score-med' : 'score-low';
  const chgCl = r.change_pct > 0 ? 'green' : r.change_pct < 0 ? 'red' : 'muted';
  const chgSign = r.change_pct > 0 ? '+' : '';

  const macdBull = r.macd > r.macd_signal;
  const ema3 = r.ema200
    ? (r.price > r.ema20 && r.ema20 > r.ema50 && r.ema50 > r.ema200 ? '<span class="green">▲▲▲</span>'
     : r.price < r.ema20 && r.ema20 < r.ema50 && r.ema50 < r.ema200 ? '<span class="red">▼▼▼</span>'
     : r.price > r.ema20 ? '<span class="green">▲</span>' : '<span class="red">▼</span>')
    : (r.price > r.ema20 ? '<span class="green">▲▲</span>' : '<span class="red">▼▼</span>');

  return `
    <tr class="result-row" onclick="toggleCard(this,'${r.symbol}')">
      <td class="rank">${i + 1}</td>
      <td><div class="sym-cell">
        <span class="sym">${r.symbol}</span>
        <span class="sym-name">${r.name || ''}</span>
      </div></td>
      <td><span class="score-badge ${sc}">${r.score}</span></td>
      <td><span class="dir ${dc}">${arrow} ${r.direction}</span></td>
      <td><span class="tv-badge ${r.tv_css || 'tv-na'}">${r.tv_rating || '—'}</span></td>
      <td><span class="${chgCl}">${chgSign}${r.change_pct}%</span></td>
      <td class="${r.rsi > 70 ? 'green' : r.rsi < 30 ? 'red' : ''}">${r.rsi}</td>
      <td><span class="${macdBull ? 'green' : 'red'}">${macdBull ? '▲ Bull' : '▼ Bear'}</span></td>
      <td>${ema3}</td>
      <td class="${r.vol_ratio >= 1.5 ? 'green' : 'muted'}">${r.vol_ratio}x</td>
      <td>$${r.price.toLocaleString()}</td>
      <td><span class="sec-tag">${r.sector || ''}</span></td>
    </tr>
    <tr class="card-row" id="card-${r.symbol}" style="display:none">
      <td colspan="12">${buildCard(r)}</td>
    </tr>`;
}

// ── Card ──────────────────────────────────────────────────────────────────
function buildCard(r) {
  const dc   = r.direction === 'Bullish' ? 'bullish' : 'bearish';
  const pct  = (v) => { const d = ((v - r.entry) / r.entry * 100).toFixed(2); return `<span class="${d >= 0 ? 'green' : 'red'}">(${d >= 0 ? '+' : ''}${d}%)</span>`; };
  const bar  = (s) => `<div class="bar-fill ${s >= 60 ? 'green-bar' : s >= 40 ? '' : 'red-bar'}" style="width:${s}%"></div>`;
  const chip = (lbl, val) => `<div class="ema-chip"><div class="ema-lbl">${lbl}</div><div class="ema-val ${r.price > val ? 'green' : 'red'}">$${val.toLocaleString()}</div></div>`;

  const tvLink = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(r.tv_symbol || r.symbol)}`;
  const chgSign = r.change_pct > 0 ? '+' : '';

  return `
    <div class="stock-card">
      <div class="card-top">
        <div>
          <span class="card-sym">${r.symbol}</span>
          <span class="card-name">${r.name}</span>
          <br>
          <span class="sec-tag" style="margin-top:6px;display:inline-block">${r.sector}</span>
          ${r.last_candle ? `<span class="candle-chip">📅 ${r.last_candle}</span>` : ''}
          <span class="change-chip ${r.change_pct >= 0 ? 'green' : 'red'}">${chgSign}${r.change_pct}% today</span>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px">
          <div class="card-score-box">
            <div class="big-score ${dc}">${r.score}</div>
            <div class="score-label">${r.direction} Signal</div>
          </div>
          <span class="tv-badge-lg ${r.tv_css || 'tv-na'}">${r.tv_rating || '—'}</span>
          <a href="${tvLink}" target="_blank" rel="noopener" class="tv-link-btn">📈 Open in TradingView ↗</a>
        </div>
      </div>

      <div class="trade-grid">
        <div class="trade-item"><div class="trade-label">Entry Price</div><div class="trade-val">$${r.entry}</div></div>
        <div class="trade-item"><div class="trade-label">Target (2× ATR)</div><div class="trade-val ${dc}">$${r.target} ${r.target ? pct(r.target) : ''}</div></div>
        <div class="trade-item"><div class="trade-label">Stop Loss (1× ATR)</div><div class="trade-val red">$${r.stop} ${r.stop ? pct(r.stop) : ''}</div></div>
        <div class="trade-item"><div class="trade-label">ATR</div><div class="trade-val">$${r.atr}</div></div>
        <div class="trade-item"><div class="trade-label">Risk / Reward</div><div class="trade-val">1 : ${r.rr}</div></div>
        <div class="trade-item"><div class="trade-label">Volume</div><div class="trade-val ${r.vol_ratio >= 1.5 ? 'green' : ''}">${r.vol_ratio}× avg</div></div>
      </div>

      <div class="ind-bars">
        <div class="ind-row"><div class="ind-name">EMA Trend</div><div class="bar-track">${bar(r.ema_score)}</div><div class="ind-val">${r.ema_score}</div></div>
        <div class="ind-row"><div class="ind-name">MACD</div><div class="bar-track">${bar(r.macd_score)}</div><div class="ind-val">${r.macd_score}</div></div>
        <div class="ind-row"><div class="ind-name">RSI (${r.rsi})</div><div class="bar-track"><div class="bar-fill" style="width:${r.rsi}%;background:${r.rsi>70?'#ff1744':r.rsi<30?'#ff6d00':'#448aff'}"></div></div><div class="ind-val">${r.rsi_score}</div></div>
        <div class="ind-row"><div class="ind-name">Volume</div><div class="bar-track">${bar(r.vol_score)}</div><div class="ind-val">${r.vol_score}</div></div>
      </div>

      <div class="ema-row" style="margin-bottom:16px">
        ${chip('Price', r.price)}
        ${chip('EMA 20', r.ema20)}
        ${chip('EMA 50', r.ema50)}
        ${r.ema200 ? chip('EMA 200', r.ema200) : ''}
      </div>

      <!-- TradingView Chart (injected after render) -->
      <div class="tv-chart-wrap" id="tv_wrap_${r.symbol}">
        <div class="tv-chart-header">
          <span>📊 TradingView Chart</span>
          <button class="tv-load-btn" onclick="loadTVChart('${r.symbol}','${r.tv_symbol || r.symbol}','${lastTF}')">Load Chart</button>
        </div>
        <div id="tv_chart_${r.symbol}" class="tv-chart-container"></div>
      </div>
    </div>`;
}

// ── TradingView chart injection ───────────────────────────────────────────
const _TV_INTERVALS = { '1d':'D', '4h':'240', '1h':'60', '15m':'15' };

function loadTVChart(symbol, tvSymbol, timeframe) {
  const container = document.getElementById(`tv_chart_${symbol}`);
  const header    = container.previousElementSibling;
  if (!container || container.childElementCount > 0) return;

  container.style.height = '420px';
  header.querySelector('.tv-load-btn').style.display = 'none';

  const widget = document.createElement('div');
  widget.className = 'tradingview-widget-container__widget';
  widget.style.cssText = 'height:100%;width:100%';
  container.appendChild(widget);

  const script = document.createElement('script');
  script.type  = 'text/javascript';
  script.src   = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  script.async = true;
  script.textContent = JSON.stringify({
    autosize:          true,
    symbol:            tvSymbol,
    interval:          _TV_INTERVALS[timeframe] || 'D',
    timezone:          'America/New_York',
    theme:             'dark',
    style:             '1',
    locale:            'en',
    backgroundColor:   'rgba(13,13,26,0)',
    gridColor:         'rgba(28,28,50,1)',
    hide_top_toolbar:  false,
    hide_legend:       false,
    save_image:        false,
    calendar:          false,
    support_host:      'https://www.tradingview.com',
  });
  container.appendChild(script);
}

// ── Toggle card ───────────────────────────────────────────────────────────
function toggleCard(row, symbol) {
  const cardRow = document.getElementById(`card-${symbol}`);
  const open    = cardRow.style.display !== 'none';

  document.querySelectorAll('.card-row').forEach(r  => r.style.display = 'none');
  document.querySelectorAll('.result-row').forEach(r => r.classList.remove('active'));

  if (!open) {
    cardRow.style.display = 'table-row';
    row.classList.add('active');
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

// ── Loading ───────────────────────────────────────────────────────────────
function setLoading(on) {
  document.getElementById('loadingOverlay').style.display = on ? 'flex' : 'none';
  const btn = document.getElementById('scanBtn');
  btn.disabled = on;
  document.getElementById('scanBtnText').textContent = on ? '⏳ SCANNING…' : '▶ START SCAN';
}

// ── Enter key ─────────────────────────────────────────────────────────────
['minScore', 'symInput'].forEach(id =>
  document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') startScan(); })
);
