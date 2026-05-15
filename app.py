import os
import time
import traceback
import numpy as np
import pandas as pd
import yfinance as yf
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from datetime import date as _date
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from tv_scanner import scan_tv, fetch_analyst_tv
from scanner import run_scan
from stock_lists import get_symbols_by_sector, get_stock_info, SECTORS
from news_fetch import fetch_news
from core_regime import market_regime_score, regime_label

app = Flask(__name__)
CORS(app)

# ── yfinance session: cookies + realistic headers + retry ────────────────
_OPT_LOCK      = __import__('threading').Lock()
_OPT_LAST_CALL = 0
_OPT_MIN_GAP   = 4   # minimum seconds between options API hits

def _yf_session():
    """Return a requests.Session that looks like Chrome and carries YF cookies."""
    s = requests.Session()
    s.headers.update({
        'User-Agent': (
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
            'AppleWebKit/537.36 (KHTML, like Gecko) '
            'Chrome/124.0.0.0 Safari/537.36'
        ),
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection':      'keep-alive',
    })
    retry = Retry(total=4, backoff_factor=2,
                  status_forcelist=[429, 500, 502, 503, 504])
    s.mount('https://', HTTPAdapter(max_retries=retry))
    # Pre-fetch Yahoo Finance to get session cookies (crumb/consent)
    try:
        s.get('https://finance.yahoo.com/', timeout=6)
    except Exception:
        pass
    return s


def _throttled_ticker(symbol):
    """Rate-limited yf.Ticker: enforces _OPT_MIN_GAP between calls."""
    global _OPT_LAST_CALL
    with _OPT_LOCK:
        gap = time.time() - _OPT_LAST_CALL
        if gap < _OPT_MIN_GAP:
            time.sleep(_OPT_MIN_GAP - gap)
        _OPT_LAST_CALL = time.time()
    return yf.Ticker(symbol, session=_yf_session())


@app.errorhandler(Exception)
def handle_any_exception(e):
    """Catch-all: always return JSON so the browser never gets an HTML error page."""
    traceback.print_exc()
    return jsonify({'error': str(e), 'results': [], 'total': 0,
                    'total_found': 0, 'results': []}), 500

# ── 15-minute result cache ────────────────────────────────────────────────────
_cache     = {}
_CACHE_TTL = 900


def _key(symbols, timeframe, min_score, sector, min_price=0, max_price=0, min_vol=0, market_cap='all'):
    base = ','.join(sorted(symbols)) if symbols else sector
    return f"{base}|{timeframe}|{min_score}|{min_price}-{max_price}|{min_vol}|{market_cap}"


def _cget(key):
    e = _cache.get(key)
    return e['data'] if e and time.time() - e['ts'] < _CACHE_TTL else None


def _cset(key, data):
    _cache[key] = {'data': data, 'ts': time.time()}


# ─────────────────────────────────────────────────────────────────────────────

def ny_time():
    return (datetime.now(timezone.utc) - timedelta(hours=4)).strftime('%b %d, %Y %I:%M:%S %p ET')


@app.route('/')
def index():
    return render_template('index.html', sectors=SECTORS)


@app.route('/api/scan', methods=['POST'])
def scan():
    data       = request.get_json(force=True)
    timeframe  = data.get('timeframe', '1d')
    min_score  = int(data.get('min_score', 40))
    sector     = data.get('sector', 'all')
    custom     = data.get('symbols', [])
    force      = data.get('force', False)
    min_price  = float(data.get('min_price',  0) or 0)
    max_price  = float(data.get('max_price',  0) or 0)
    min_vol    = int(data.get('min_volume',   0) or 0)
    market_cap = data.get('market_cap', 'all')
    rsi_min    = float(data.get('rsi_min', 0)  or 0)
    rsi_max    = float(data.get('rsi_max', 100) or 100)

    custom_syms = [s.strip().upper() for s in custom if s.strip()]

    cache_key = _key(custom_syms, timeframe, min_score, sector, min_price, max_price, min_vol, market_cap)
    if not force:
        cached = _cget(cache_key)
        if cached:
            cached['from_cache'] = True
            return jsonify(cached)

    source = 'TradingView'

    if custom_syms:
        # Custom symbols: yfinance handles any ticker without needing exchange prefix
        results = run_scan(custom_syms, timeframe=timeframe, min_score=min_score)
        for r in results:
            info = get_stock_info(r['symbol'])
            r['name']      = info['name']
            r['sector']    = info['sector']
            r['exchange']  = 'NASDAQ'
            r['tv_symbol'] = f"NASDAQ:{r['symbol']}"
            r['tv_rating'] = '—'
            r['tv_css']    = 'tv-na'
            r['change_pct']= 0
        source = 'Yahoo Finance'
    else:
        # General scan: use TradingView screener (fast, real-time, + TV ratings)
        try:
            results = scan_tv(sector=sector, timeframe=timeframe, min_score=min_score,
                              min_price=min_price, max_price=max_price,
                              min_vol=min_vol, market_cap=market_cap)
        except Exception as e:
            print(f"[TV scan failed: {e}] — falling back to yfinance")
            symbols = get_symbols_by_sector(sector)
            results = run_scan(symbols, timeframe=timeframe, min_score=min_score)
            for r in results:
                info = get_stock_info(r['symbol'])
                r['name']      = info['name']
                r['sector']    = info['sector']
                r['exchange']  = 'NASDAQ'
                r['tv_symbol'] = f"NASDAQ:{r['symbol']}"
                r['tv_rating'] = '—'
                r['tv_css']    = 'tv-na'
                r['change_pct']= 0
            source = 'Yahoo Finance'

    # ── Hard enforce price / volume filters on every result ──────────────────
    # Guarantees the filter works for both TV and yfinance paths.
    if min_price > 0:
        results = [r for r in results if (r.get('price') or 0) >= min_price]
    if max_price > 0:
        results = [r for r in results if (r.get('price') or 0) <= max_price]
    if min_vol > 0:
        results = [r for r in results if (r.get('volume') or 0) >= min_vol]
    if rsi_min > 0:
        results = [r for r in results if (r.get('rsi') or 0) >= rsi_min]
    if rsi_max < 100:
        results = [r for r in results if (r.get('rsi') or 100) <= rsi_max]

    candles    = [r['last_candle'] for r in results if r.get('last_candle')]
    data_as_of = max(candles) if candles else ny_time()

    reg = market_regime_score()

    # ── Scan quality metrics ──────────────────────────────────────────────────
    total     = len(results)
    bull_res  = [r for r in results if r['direction'] == 'Bullish']
    bear_res  = [r for r in results if r['direction'] == 'Bearish']

    # % of stocks with clear vote consensus (diff ≥ 3)
    clear_sig = [r for r in results
                 if abs(r.get('up_votes', 0) - r.get('down_votes', 0)) >= 3]
    clarity_pct = int(len(clear_sig) / max(total, 1) * 100)

    # % with Trend signal type
    trend_pct = int(len([r for r in results if r.get('signal_type') == 'Trend'])
                    / max(total, 1) * 100)

    # Average up-votes on bullish results
    avg_up_votes = (round(sum(r.get('up_votes', 0) for r in bull_res)
                    / max(len(bull_res), 1), 1))

    # High-confidence count (score ≥ 70)
    high_conf = len([r for r in results if r['score'] >= 70])

    # Average score
    avg_score = round(sum(r['score'] for r in results) / max(total, 1), 1)

    # Regime-direction match (bull regime + bullish majority or vice versa)
    bull_majority = len(bull_res) > len(bear_res)
    regime_match  = (reg >= 55 and bull_majority) or (reg <= 45 and not bull_majority)

    # Quality score (0-100): blend of clarity, high-conf, avg-score, regime match
    quality_score = int(
        clarity_pct                          * 0.35
        + (high_conf / max(total, 1) * 100) * 0.25
        + min(100, avg_score)               * 0.30
        + (10 if regime_match else 0)       * 0.10
    )
    quality_score = min(100, quality_score)

    # Grade
    scan_grade = ('A' if quality_score >= 80 else
                  'B' if quality_score >= 65 else
                  'C' if quality_score >= 50 else 'D')

    # Insight string
    if quality_score >= 80:
        insight = ('Excellent market conditions. High-conviction signals across '
                   f'{clarity_pct}% of results. Regime favors the prevailing trend.')
    elif quality_score >= 65:
        insight = (f'Good scan quality. {trend_pct}% trend signals. '
                   'Monitor stops — mid-range volatility detected.')
    elif quality_score >= 50:
        insight = ('Mixed signals. Wait for higher vote consensus before entry. '
                   'Prefer stocks with 7+ votes and Trend signal type.')
    else:
        insight = ('Low signal clarity. Market is choppy. '
                   'Consider increasing Min Score or waiting for clearer conditions.')

    payload = {
        'results':         results,
        'total_scanned':   total,
        'total_found':     total,
        'bullish_count':   len(bull_res),
        'bearish_count':   len(bear_res),
        'strong_count':    len([r for r in results if r['score'] >= 70]),
        'timestamp':       ny_time(),
        'data_as_of':      data_as_of,
        'timeframe':       timeframe,
        'source':          source,
        'regime_score':    reg,
        'regime_label':    regime_label(reg),
        'from_cache':      False,
        # ── Quality metrics ──
        'quality_score':   quality_score,
        'scan_grade':      scan_grade,
        'clarity_pct':     clarity_pct,
        'trend_pct':       trend_pct,
        'avg_up_votes':    avg_up_votes,
        'high_conf_count': high_conf,
        'avg_score':       avg_score,
        'regime_match':    regime_match,
        'scan_insight':    insight,
    }

    _cset(cache_key, payload)
    return jsonify(payload)


@app.route('/api/news', methods=['POST'])
def news():
    data    = request.get_json(force=True) or {}
    symbols = [s.strip().upper() for s in data.get('symbols', []) if s.strip()]
    force   = data.get('force', False)

    if not symbols:
        return jsonify({'news': [], 'total': 0, 'timestamp': ny_time()})

    cache_key = 'news|' + ','.join(sorted(symbols[:20]))
    if not force:
        entry = _cache.get(cache_key)
        if entry and (time.time() - entry['ts'] < 300):   # 5-min cache
            entry['data']['from_cache'] = True
            return jsonify(entry['data'])

    try:
        items = fetch_news(symbols)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'news': [], 'total': 0}), 500

    payload = {
        'news':       items,
        'total':      len(items),
        'launches':   len([n for n in items if n['cat_cls'] == 'launch']),
        'earnings':   len([n for n in items if n['cat_cls'] == 'earn']),
        'upgrades':   len([n for n in items if n['cat_cls'] == 'upgrade']),
        'timestamp':  ny_time(),
        'from_cache': False,
    }
    _cset(cache_key, payload)
    return jsonify(payload)


@app.route('/api/analyst', methods=['POST'])
def analyst_rating():
    data       = request.get_json(force=True) or {}
    symbol     = data.get('symbol',    '').strip().upper()
    tv_symbol  = data.get('tv_symbol', '').strip()
    tv_rec_raw = data.get('tv_rec')        # Recommend.All from scan (-1→1)
    if not symbol:
        return jsonify({'error': 'No symbol'}), 400

    cache_key = f'analyst_tv2|{symbol}'
    cached = _cget(cache_key)
    if cached:
        cached['from_cache'] = True
        return jsonify(cached)

    buy = hold = sell = total = 0
    target = target_h = target_l = None
    source = 'N/A'

    # ── 1. TradingView screener ───────────────────────────────────────────
    if tv_symbol:
        try:
            tv = fetch_analyst_tv(tv_symbol)
            if tv:
                buy, hold, sell = tv['buy'], tv['hold'], tv['sell']
                total = tv['total']
                if tv.get('target'):    target   = round(float(tv['target']),   2)
                if tv.get('target_h'):  target_h = round(float(tv['target_h']), 2)
                if tv.get('target_l'):  target_l = round(float(tv['target_l']), 2)
                if total > 0:           source   = 'TradingView'
        except Exception as e:
            print(f'[TV analyst {symbol}] {e}')

    # ── 2. yfinance — recommendations_summary ────────────────────────────
    if total == 0:
        try:
            ticker = yf.Ticker(symbol, session=_yf_session())
            recs   = ticker.recommendations_summary
            if recs is not None and not recs.empty:
                row = recs.iloc[0]
                def _gi(k): return int(row[k] if k in row.index else 0) if not pd.isna(row.get(k, 0)) else 0
                sb  = _gi('strongBuy');  b = _gi('buy')
                h   = _gi('hold');       s = _gi('sell'); ss = _gi('strongSell')
                total = sb + b + h + s + ss
                if total > 0:
                    buy = sb + b; hold = h; sell = s + ss
                    source = 'Yahoo Finance'
        except Exception:
            pass

    # ── 3. yfinance — analyst_price_targets (targets only) ───────────────
    if target is None:
        try:
            ticker = yf.Ticker(symbol, session=_yf_session())
            apt    = ticker.analyst_price_targets
            if isinstance(apt, dict) and apt.get('mean'):
                target   = round(float(apt['mean']), 2)
                target_h = round(float(apt['high']), 2) if apt.get('high') else None
                target_l = round(float(apt['low']),  2) if apt.get('low')  else None
                if total == 0 and apt.get('numberOfAnalysts'):
                    total = int(apt['numberOfAnalysts'])
                    buy   = total   # treat all as buy if only target data available
                    source = 'Yahoo Finance'
        except Exception:
            pass

    # ── 4. TV technical consensus fallback (always available from scan) ───
    tv_rec = None
    if tv_rec_raw is not None:
        try:
            tv_rec = float(tv_rec_raw)
        except Exception:
            pass

    payload = {
        'symbol':    symbol,
        'source':    source,
        'buy':       buy,
        'hold':      hold,
        'sell':      sell,
        'total':     total,
        'target':    target,
        'target_h':  target_h,
        'target_l':  target_l,
        'tv_rec':    tv_rec,   # -1→1 technical consensus, always shown if counts unavailable
        'from_cache': False,
    }

    _cset(cache_key, payload)
    return jsonify(payload)


def _calc_max_pain(calls, puts):
    """Strike where aggregate option holder loss is minimised (max writer gain)."""
    strikes = sorted(set(
        calls['strike'].dropna().tolist() + puts['strike'].dropna().tolist()
    ))
    if not strikes:
        return None
    min_pain = float('inf')
    mp = strikes[len(strikes) // 2]
    for test in strikes:
        c_loss = sum(
            max(0.0, float(test) - float(s)) * float(oi)
            for s, oi in zip(calls['strike'], calls['openInterest'].fillna(0))
        )
        p_loss = sum(
            max(0.0, float(s) - float(test)) * float(oi)
            for s, oi in zip(puts['strike'], puts['openInterest'].fillna(0))
        )
        total = c_loss + p_loss
        if total < min_pain:
            min_pain = total
            mp = test
    return float(mp)


def _uoa(df, opt_type, price, threshold=3.0, min_vol=300):
    """Top unusual options by Vol/OI ratio."""
    d = df.copy()
    d['volume']       = pd.to_numeric(d['volume'],       errors='coerce').fillna(0)
    d['openInterest'] = pd.to_numeric(d['openInterest'], errors='coerce').fillna(1)
    d['iv']           = pd.to_numeric(d.get('impliedVolatility', 0), errors='coerce').fillna(0)
    d['vol_oi'] = d['volume'] / d['openInterest'].clip(lower=1)
    mask = (d['vol_oi'] >= threshold) & (d['volume'] >= min_vol)
    top  = d[mask].nlargest(4, 'volume')
    rows = []
    for _, r in top.iterrows():
        s = float(r['strike'])
        rows.append({
            'strike':  s,
            'volume':  int(r['volume']),
            'oi':      int(r['openInterest']),
            'vol_oi':  round(float(r['vol_oi']), 1),
            'iv':      round(float(r['iv']) * 100, 1),
            'type':    opt_type,
            'otm':     (s > price if opt_type == 'call' else s < price) if price else False,
        })
    return rows


@app.route('/api/options', methods=['POST'])
def options_data():
    data   = request.get_json(force=True) or {}
    symbol = data.get('symbol', '').strip().upper()
    price  = float(data.get('price', 0) or 0)

    if not symbol:
        return jsonify({'error': 'No symbol provided'}), 400

    cache_key = f'options2|{symbol}'
    cached = _cache.get(cache_key)
    if cached and time.time() - cached['ts'] < 1800:   # 30-min cache for options
        cached['data']['from_cache'] = True
        return jsonify(cached['data'])

    try:
        ticker = _throttled_ticker(symbol)
        exps   = ticker.options

        if not exps:
            return jsonify({'error': 'No options available for this symbol',
                            'symbol': symbol}), 200

        # Pick nearest expiry that is at least 5 days away
        today = _date.today()
        expiry = exps[0]
        for e in exps[:8]:
            try:
                if (_date.fromisoformat(e) - today).days >= 5:
                    expiry = e
                    break
            except Exception:
                pass

        dte = max(0, (_date.fromisoformat(expiry) - today).days)

        chain = ticker.option_chain(expiry)
        calls = chain.calls.copy()
        puts  = chain.puts.copy()

        for df in (calls, puts):
            df['volume']       = pd.to_numeric(df['volume'],       errors='coerce').fillna(0)
            df['openInterest'] = pd.to_numeric(df['openInterest'], errors='coerce').fillna(0)
            df['impliedVolatility'] = pd.to_numeric(
                df.get('impliedVolatility', 0), errors='coerce').fillna(0)

        # ── PCR ──────────────────────────────────────────────────────────
        call_vol = float(calls['volume'].sum())
        put_vol  = float(puts['volume'].sum())
        call_oi  = float(calls['openInterest'].sum())
        put_oi   = float(puts['openInterest'].sum())
        pcr_vol  = round(put_vol / call_vol, 2) if call_vol > 0 else 0.0
        pcr_oi   = round(put_oi  / call_oi,  2) if call_oi  > 0 else 0.0
        pcr_sig  = ('bullish' if pcr_vol < 0.5  else
                    'bearish' if pcr_vol > 1.2  else 'neutral')

        # ── ATM IV ───────────────────────────────────────────────────────
        if price > 0 and len(calls):
            idx = (calls['strike'] - price).abs().idxmin()
            atm_iv = round(float(calls.loc[idx, 'impliedVolatility']) * 100, 1)
        else:
            iv_vals = calls['impliedVolatility'][calls['impliedVolatility'] > 0]
            atm_iv  = round(float(iv_vals.median()) * 100, 1) if len(iv_vals) else 0

        iv_sig = ('very_high' if atm_iv > 80 else
                  'high'      if atm_iv > 50 else
                  'elevated'  if atm_iv > 35 else
                  'normal'    if atm_iv > 15 else 'low')

        # ── Max Pain ──────────────────────────────────────────────────────
        max_pain = _calc_max_pain(calls, puts)
        mp_dist  = round((max_pain - price) / price * 100, 1) if (max_pain and price) else 0

        # ── UOA ───────────────────────────────────────────────────────────
        uoa_calls = _uoa(calls, 'call', price)
        uoa_puts  = _uoa(puts,  'put',  price)

        # ── OI Distribution (±18% of current price) ───────────────────────
        if price > 0:
            lo, hi = price * 0.82, price * 1.18
            c_near = calls[calls['strike'].between(lo, hi)]
            p_near = puts[puts['strike'].between(lo, hi)]
        else:
            c_near, p_near = calls, puts

        near_strikes = sorted(set(
            c_near['strike'].tolist() + p_near['strike'].tolist()
        ))[:14]

        oi_dist = []
        for s in near_strikes:
            c_row = calls[calls['strike'] == s]
            p_row = puts[puts['strike']  == s]
            c_oi  = int(c_row['openInterest'].sum()) if len(c_row) else 0
            p_oi  = int(p_row['openInterest'].sum()) if len(p_row) else 0
            if c_oi + p_oi > 0:
                oi_dist.append({'strike': s, 'call_oi': c_oi, 'put_oi': p_oi})

        # ── IV Percentile (approx from chain spread) ──────────────────────
        iv_vals = calls['impliedVolatility'][calls['impliedVolatility'] > 0] * 100
        iv_min  = round(float(iv_vals.min()),  1) if len(iv_vals) else atm_iv
        iv_max  = round(float(iv_vals.max()),  1) if len(iv_vals) else atm_iv
        iv_rank = round((atm_iv - iv_min) / (iv_max - iv_min) * 100) if iv_max > iv_min else 50

        # ── Overall Options Signal ────────────────────────────────────────
        score = 0
        if pcr_sig == 'bullish':          score += 2
        elif pcr_sig == 'bearish':        score -= 2
        if len(uoa_calls) > len(uoa_puts): score += 1
        elif len(uoa_puts) > len(uoa_calls): score -= 1
        if max_pain and price:
            if max_pain > price:  score += 1
            elif max_pain < price: score -= 1

        opt_signal = ('bullish' if score >= 2 else
                      'bearish' if score <= -2 else 'neutral')

        payload = {
            'symbol':       symbol,
            'expiry':       expiry,
            'dte':          dte,
            'call_vol':     int(call_vol),
            'put_vol':      int(put_vol),
            'call_oi':      int(call_oi),
            'put_oi':       int(put_oi),
            'pcr_vol':      pcr_vol,
            'pcr_oi':       pcr_oi,
            'pcr_signal':   pcr_sig,
            'atm_iv':       atm_iv,
            'iv_rank':      iv_rank,
            'iv_signal':    iv_sig,
            'max_pain':     max_pain,
            'mp_dist':      mp_dist,
            'uoa_calls':    uoa_calls,
            'uoa_puts':     uoa_puts,
            'oi_dist':      oi_dist,
            'opt_signal':   opt_signal,
            'from_cache':   False,
        }

        _cset(cache_key, payload)
        return jsonify(payload)

    except Exception as e:
        err = str(e)
        if '429' in err or 'Too Many' in err or 'rate' in err.lower():
            return jsonify({
                'error': 'Yahoo Finance rate limit hit — please wait 30–60 seconds and try again.',
                'rate_limited': True, 'symbol': symbol,
            }), 429
        traceback.print_exc()
        return jsonify({'error': err, 'symbol': symbol}), 500


@app.route('/api/sectors')
def sectors():
    return jsonify(SECTORS)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
