import os
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS
from datetime import datetime, timezone, timedelta
from scanner import run_scan
from stock_lists import get_symbols_by_sector, get_stock_info, SECTORS

app = Flask(__name__)
CORS(app)


def ny_time():
    # UTC-4 (EDT) — close enough without pytz
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

    if custom:
        symbols = [s.strip().upper() for s in custom if s.strip()]
    else:
        symbols = get_symbols_by_sector(sector)

    results = run_scan(symbols, timeframe=timeframe, min_score=min_score)

    for r in results:
        info = get_stock_info(r['symbol'])
        r['name']   = info['name']
        r['sector'] = info['sector']

    bullish  = [r for r in results if r['direction'] == 'Bullish']
    bearish  = [r for r in results if r['direction'] == 'Bearish']
    strong   = [r for r in results if r['score'] >= 70]

    return jsonify({
        'results':       results,
        'total_scanned': len(symbols),
        'total_found':   len(results),
        'bullish_count': len(bullish),
        'bearish_count': len(bearish),
        'strong_count':  len(strong),
        'timestamp':     ny_time(),
        'timeframe':     timeframe,
    })


@app.route('/api/sectors')
def sectors():
    return jsonify(SECTORS)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port, debug=False)
