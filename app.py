import os
import time
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from scanner import run_scan
from stock_lists import get_symbols_by_sector, get_stock_info, SECTORS

app = Flask(__name__)
CORS(app)

# ── Simple in-memory cache (15-minute TTL) ────────────────────────────────────
_cache     = {}
_CACHE_TTL = 900  # seconds


def _cache_key(symbols, timeframe, min_score):
    return f"{','.join(sorted(symbols))}|{timeframe}|{min_score}"


def _cache_get(key):
    entry = _cache.get(key)
    if entry and (time.time() - entry['ts'] < _CACHE_TTL):
        return entry['data']
    return None


def _cache_set(key, data):
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
    force     = data.get('force', False)   # bypass cache when True

    if custom:
        symbols = [s.strip().upper() for s in custom if s.strip()]
    else:
        symbols = get_symbols_by_sector(sector)

    key    = _cache_key(symbols, timeframe, min_score)
    cached = None if force else _cache_get(key)

    if cached:
        cached['from_cache'] = True
        return jsonify(cached)

    results = run_scan(symbols, timeframe=timeframe, min_score=min_score)

    for r in results:
        info = get_stock_info(r['symbol'])
        r['name']   = info['name']
        r['sector'] = info['sector']

    # Most recent data timestamp across all results
    candles   = [r['last_candle'] for r in results if r.get('last_candle')]
    data_as_of = max(candles) if candles else 'N/A'

    payload = {
        'results':       results,
        'total_scanned': len(symbols),
        'total_found':   len(results),
        'bullish_count': len([r for r in results if r['direction'] == 'Bullish']),
        'bearish_count': len([r for r in results if r['direction'] == 'Bearish']),
        'strong_count':  len([r for r in results if r['score'] >= 70]),
        'timestamp':     ny_time(),
        'data_as_of':    data_as_of,
        'timeframe':     timeframe,
        'from_cache':    False,
    }

    _cache_set(key, payload)
    return jsonify(payload)


@app.route('/api/sectors')
def sectors():
    return jsonify(SECTORS)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
