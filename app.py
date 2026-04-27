import os
import time
import traceback
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from tv_scanner import scan_tv
from scanner import run_scan
from stock_lists import get_symbols_by_sector, get_stock_info, SECTORS
from fundamental import run_research, DEFAULT_RESEARCH

app = Flask(__name__)
CORS(app)

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
            results = scan_tv(sector=sector, timeframe=timeframe, min_score=min_score)
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

    payload = {
        'results':       results,
        'total_scanned': len(results),
        'total_found':   len(results),
        'bullish_count': len([r for r in results if r['direction'] == 'Bullish']),
        'bearish_count': len([r for r in results if r['direction'] == 'Bearish']),
        'strong_count':  len([r for r in results if r['score'] >= 70]),
        'timestamp':     ny_time(),
        'data_as_of':    data_as_of,
        'timeframe':     timeframe,
        'source':        source,
        'from_cache':    False,
    }

    _cset(cache_key, payload)
    return jsonify(payload)


@app.route('/api/research', methods=['POST'])
def research():
    data      = request.get_json(force=True)
    custom    = data.get('symbols', [])
    force     = data.get('force', False)
    min_score = int(data.get('min_score', 0))

    symbols = [s.strip().upper() for s in custom if s.strip()] if custom else DEFAULT_RESEARCH
    symbols = symbols[:30]

    cache_key = 'research|' + ','.join(sorted(symbols))
    if not force:
        # Use 1-hour TTL for research (fundamental data changes slowly)
        entry = _cache.get(cache_key)
        if entry and (time.time() - entry['ts'] < 3600):
            entry['data']['from_cache'] = True
            return jsonify(entry['data'])

    try:
        results = run_research(symbols)
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e), 'results': [], 'total': 0}), 500

    if min_score > 0:
        results = [r for r in results if r['overall_score'] >= min_score]

    payload = {
        'results':          results,
        'total':            len(results),
        'a_grade':          len([r for r in results if r['grade'] in ('A+', 'A')]),
        'has_catalysts':    len([r for r in results if r.get('catalysts')]),
        'product_launches': len([r for r in results if 'launch' in (r.get('catalysts') or [])]),
        'earn_beats':       len([r for r in results if r.get('earn_score', 0) >= 60]),
        'timestamp':        ny_time(),
        'from_cache':       False,
    }
    _cset(cache_key, payload)
    return jsonify(payload)


@app.route('/api/sectors')
def sectors():
    return jsonify(SECTORS)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
