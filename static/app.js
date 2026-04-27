'use strict';

let allResults = [];
let activeTab  = 'all';
let sortKey    = 'score';
let sortAsc    = false;

// ── Clock & market status ─────────────────────────────────────────────────
function updateClock() {
  const fmt = (opts) =>
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', ...opts }).format(new Date());

  const time = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const date = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
  document.getElementById('nyTime').textContent = `NY: ${date}, ${time}`;

  const h   = parseInt(fmt({ hour: 'numeric', hour12: false }));
  const m   = parseInt(fmt({ minute: 'numeric' }));
  const day = fmt({ weekday: 'short' });
  const open = !['Sat', 'Sun'].includes(day) && ((h === 9 && m >= 30) || (h > 9 && h < 16));
  const premarket  = !['Sat', 'Sun'].includes(day) && h >= 4  && (h < 9 || (h === 9 && m < 30));
  const afterhours = !['Sat', 'Sun'].includes(day) && h >= 16 && h < 20;

  const el = document.getElementById('marketStatus');
  if (open) {
    el.textContent = '● MARKET OPEN';
    el.className   = 'market-badge open';
  } else if (premarket) {
    el.textContent = '◑ PRE-MARKET';
    el.className   = 'market-badge pre';
  } else if (afterhours) {
    el.textContent = '◑ AFTER HOURS';
    el.className   = 'market-badge pre';
  } else {
    el.textContent = '● CLOSED · Last session data';
    el.className   = 'market-badge closed';
  }
}
updateClock();
setInterval(updateClock, 1000);

// ── Timeframe buttons ─────────────────────────────────────────────────────
document.querySelectorAll('.tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
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

  setLoading(true);

  try {
    const res = await fetch('/api/scan', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ timeframe, min_score: minScore, sector, symbols, force }),
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
    document.getElementById('resultsWrap').innerHTML =
      `<div class="error-msg">❌ ${err.message}</div>`;
  } finally {
    setLoading(false);
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────
function updateStats(d) {
  document.getElementById('sAnalyzed').textContent  = d.total_scanned;
  document.getElementById('sFound').textContent     = d.total_found;
  document.getElementById('sBull').textContent      = d.bullish_count;
  document.getElementById('sBear').textContent      = d.bearish_count;
  document.getElementById('sStrong').textContent    = d.strong_count;
  document.getElementById('sTime').textContent      = d.timestamp;
  document.getElementById('sDataAsOf').textContent  = d.data_as_of || '—';

  const cacheTag = document.getElementById('cacheTag');
  cacheTag.style.display = d.from_cache ? 'inline-flex' : 'none';
}

// ── Filter & Render ───────────────────────────────────────────────────────
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
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-msg">🔍 No results match the current filters.</div>';
    return;
  }

  wrap.innerHTML = `
    <div class="table-toolbar">
      <span class="result-count">${rows.length} result${rows.length !== 1 ? 's' : ''}</span>
      <button class="refresh-btn" onclick="startScan(true)" title="Force refresh — bypass cache">↺ Refresh</button>
    </div>
    <table class="results-table">
      <thead><tr>
        <th>#</th>
        <th class="sortable" onclick="setSort('symbol')">Symbol ${sortIcon('symbol')}</th>
        <th class="sortable" onclick="setSort('score')">Score ${sortIcon('score')}</th>
        <th>Direction</th>
        <th class="sortable" onclick="setSort('rsi')">RSI ${sortIcon('rsi')}</th>
        <th>MACD</th>
        <th>EMA Trend</th>
        <th class="sortable" onclick="setSort('vol_ratio')">Volume ${sortIcon('vol_ratio')}</th>
        <th class="sortable" onclick="setSort('price')">Price ${sortIcon('price')}</th>
        <th>Data As Of</th>
        <th>Sector</th>
      </tr></thead>
      <tbody id="tBody">${rows.map(buildRow).join('')}</tbody>
    </table>`;
}

function sortIcon(key) {
  if (sortKey !== key) return '<span style="opacity:.3">↕</span>';
  return sortAsc ? '↑' : '↓';
}

function setSort(key) {
  if (sortKey === key) { sortAsc = !sortAsc; }
  else { sortKey = key; sortAsc = (key === 'symbol'); }
  render();
}

// ── Row ───────────────────────────────────────────────────────────────────
function buildRow(r, i) {
  const dc    = r.direction === 'Bullish' ? 'bullish' : r.direction === 'Bearish' ? 'bearish' : 'neutral';
  const arrow = r.direction === 'Bullish' ? '▲' : r.direction === 'Bearish' ? '▼' : '●';
  const sc    = r.score >= 80 ? 'score-fire' : r.score >= 65 ? 'score-high' : r.score >= 45 ? 'score-med' : 'score-low';

  const macdBull = r.macd > r.macd_signal;
  const ema3 = r.ema200
    ? (r.price > r.ema20 && r.ema20 > r.ema50 && r.ema50 > r.ema200
        ? '<span class="green">▲▲▲</span>'
        : r.price < r.ema20 && r.ema20 < r.ema50 && r.ema50 < r.ema200
          ? '<span class="red">▼▼▼</span>'
          : r.price > r.ema20 ? '<span class="green">▲</span>' : '<span class="red">▼</span>')
    : (r.price > r.ema20 ? '<span class="green">▲▲</span>' : '<span class="red">▼▼</span>');

  return `
    <tr class="result-row" onclick="toggleCard(this,'${r.symbol}')">
      <td class="rank">${i + 1}</td>
      <td><div class="sym-cell"><span class="sym">${r.symbol}</span><span class="sym-name">${r.name || ''}</span></div></td>
      <td><span class="score-badge ${sc}">${r.score}</span></td>
      <td><span class="dir ${dc}">${arrow} ${r.direction}</span></td>
      <td class="${r.rsi > 70 ? 'green' : r.rsi < 30 ? 'red' : ''}">${r.rsi}</td>
      <td><span class="${macdBull ? 'green' : 'red'}">${macdBull ? '▲ Bull' : '▼ Bear'}</span></td>
      <td>${ema3}</td>
      <td class="${r.vol_ratio >= 1.5 ? 'green' : 'muted'}">${r.vol_ratio}x</td>
      <td>$${r.price.toLocaleString()}</td>
      <td><span class="candle-date">${r.last_candle || '—'}</span></td>
      <td><span class="sec-tag">${r.sector || ''}</span></td>
    </tr>
    <tr class="card-row" id="card-${r.symbol}" style="display:none">
      <td colspan="11">${buildCard(r)}</td>
    </tr>`;
}

// ── Card ──────────────────────────────────────────────────────────────────
function buildCard(r) {
  const dc = r.direction === 'Bullish' ? 'bullish' : 'bearish';
  const pct = (v) => {
    const d = ((v - r.entry) / r.entry * 100).toFixed(2);
    return `<span class="${d >= 0 ? 'green' : 'red'}">(${d >= 0 ? '+' : ''}${d}%)</span>`;
  };

  const barFill = (score) => {
    const cls = score >= 60 ? 'green-bar' : score >= 40 ? '' : 'red-bar';
    return `<div class="bar-fill ${cls}" style="width:${score}%"></div>`;
  };

  const emaChip = (label, val) => {
    const cl = r.price > val ? 'green' : 'red';
    return `<div class="ema-chip"><div class="ema-lbl">${label}</div><div class="ema-val ${cl}">$${val.toLocaleString()}</div></div>`;
  };

  return `
    <div class="stock-card">
      <div class="card-top">
        <div>
          <span class="card-sym">${r.symbol}</span>
          <span class="card-name">${r.name}</span>
          <br>
          <span class="sec-tag" style="margin-top:6px;display:inline-block">${r.sector}</span>
          ${r.last_candle ? `<span class="candle-chip">📅 Data as of ${r.last_candle}</span>` : ''}
        </div>
        <div class="card-score-box">
          <div class="big-score ${dc}">${r.score}</div>
          <div class="score-label">${r.direction} Signal</div>
        </div>
      </div>

      <div class="trade-grid">
        <div class="trade-item">
          <div class="trade-label">Entry Price</div>
          <div class="trade-val">$${r.entry}</div>
        </div>
        <div class="trade-item">
          <div class="trade-label">Target (2× ATR)</div>
          <div class="trade-val ${dc}">$${r.target} ${pct(r.target)}</div>
        </div>
        <div class="trade-item">
          <div class="trade-label">Stop Loss (1× ATR)</div>
          <div class="trade-val red">$${r.stop} ${pct(r.stop)}</div>
        </div>
        <div class="trade-item">
          <div class="trade-label">ATR</div>
          <div class="trade-val">$${r.atr}</div>
        </div>
        <div class="trade-item">
          <div class="trade-label">Risk / Reward</div>
          <div class="trade-val">1 : ${r.rr}</div>
        </div>
        <div class="trade-item">
          <div class="trade-label">Volume Ratio</div>
          <div class="trade-val ${r.vol_ratio >= 1.5 ? 'green' : ''}">${r.vol_ratio}× avg</div>
        </div>
      </div>

      <div class="ind-bars">
        <div class="ind-row">
          <div class="ind-name">EMA Trend</div>
          <div class="bar-track">${barFill(r.ema_score)}</div>
          <div class="ind-val">${r.ema_score}</div>
        </div>
        <div class="ind-row">
          <div class="ind-name">MACD</div>
          <div class="bar-track">${barFill(r.macd_score)}</div>
          <div class="ind-val">${r.macd_score}</div>
        </div>
        <div class="ind-row">
          <div class="ind-name">RSI (${r.rsi})</div>
          <div class="bar-track"><div class="bar-fill" style="width:${r.rsi}%;background:${r.rsi > 70 ? '#ff1744' : r.rsi < 30 ? '#ff6d00' : '#448aff'}"></div></div>
          <div class="ind-val">${r.rsi_score}</div>
        </div>
        <div class="ind-row">
          <div class="ind-name">Volume</div>
          <div class="bar-track">${barFill(r.vol_score)}</div>
          <div class="ind-val">${r.vol_score}</div>
        </div>
      </div>

      <div class="ema-row">
        ${emaChip('Price', r.price)}
        ${emaChip('EMA 20', r.ema20)}
        ${emaChip('EMA 50', r.ema50)}
        ${r.ema200 ? emaChip('EMA 200', r.ema200) : ''}
      </div>
    </div>`;
}

// ── Toggle expanded card ──────────────────────────────────────────────────
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

// ── Enter key on inputs ───────────────────────────────────────────────────
['minScore', 'symInput'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') startScan();
  });
});
