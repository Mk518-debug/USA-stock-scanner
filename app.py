import os
import time
import traceback
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from tv_scanner import scan_tv
from scanner import run_scan
from stock_lists import get_symbols_by_sector, get_stock_info, SECTORS
from news_fetch import fetch_news
from core_regime import market_regime_score, regime_label

app = Flask(__name__)
CORS(app)


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


@app.route('/api/sectors')
def sectors():
    return jsonify(SECTORS)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
