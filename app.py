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


def _key(symbols, timeframe, min_score, sector):
    return f"{','.join(sorted(symbols)) if symbols else sector}|{timeframe}|{min_score}"


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
    data      = request.get_json(force=True)
    timeframe = data.get('timeframe', '1d')
    min_score = int(data.get('min_score', 40))
    sector    = data.get('sector', 'all')
    custom    = data.get('symbols', [])
    force     = data.get('force', False)
    islamic   = bool(data.get('islamic', False))

    custom_syms = [s.strip().upper() for s in custom if s.strip()]

    cache_key = _key(custom_syms, timeframe, min_score, sector)
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
            results = scan_tv(sector=sector, timeframe=timeframe,
                              min_score=min_score, islamic=islamic)
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

    candles    = [r['last_candle'] for r in results if r.get('last_candle')]
    data_as_of = max(candles) if candles else ny_time()

    reg = market_regime_score()
    payload = {
        'results':       results,
        'total_scanned': len(results),
        'total_found':   len(results),
        'bullish_count': len([r for r in results if r['direction'] == 'Bullish']),
        'bearish_count': len([r for r in results if r['direction'] == 'Bearish']),
        'strong_count':  len([r for r in results if r['score'] >= 70]),
        'halal_count':   len([r for r in results if r.get('halal')]),
        'timestamp':     ny_time(),
        'data_as_of':    data_as_of,
        'timeframe':     timeframe,
        'source':        source,
        'regime_score':  reg,
        'regime_label':  regime_label(reg),
        'from_cache':    False,
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
