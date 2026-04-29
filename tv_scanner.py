"""
TradingView Screener API integration.
Uses the same endpoint TradingView's website calls internally.
Returns real-time data + TV's own technical ratings in one fast request.
"""
import requests

TV_URL = 'https://scanner.tradingview.com/america/scan'

_HEADERS = {
    'origin':       'https://www.tradingview.com',
    'referer':      'https://www.tradingview.com/',
    'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
}

# TradingView interval codes
_TF = {'1d': '', '4h': '|240', '1h': '|60', '15m': '|15'}

# TradingView sector names -> our display names
_SECTOR_MAP = {
    'Technology':             'Technology',
    'Financial':              'Finance',
    'Healthcare':             'Healthcare',
    'Energy':                 'Energy',
    'Consumer Cyclical':      'Consumer',
    'Consumer Defensive':     'Consumer',
    'Industrials':            'Industrial',
    'Communication Services': 'Communication',
    'Basic Materials':        'Materials',
    'Real Estate':            'Real Estate',
    'Utilities':              'Utilities',
}

# Our sector names -> TradingView sector names (for filtering)
_SECTOR_TV = {v: k for k, v in _SECTOR_MAP.items()}
_SECTOR_TV['Consumer'] = 'Consumer Cyclical'


def _tv_label(v):
    if v is None:   return 'N/A',        'tv-na'
    if v >= 0.5:    return 'Strong Buy',  'tv-strong-buy'
    if v >= 0.1:    return 'Buy',         'tv-buy'
    if v > -0.1:    return 'Neutral',     'tv-neutral'
    if v > -0.5:    return 'Sell',        'tv-sell'
    return               'Strong Sell',   'tv-strong-sell'


def _direction(v):
    if v is None:  return 'Neutral'
    if v >= 0.1:   return 'Bullish'
    if v <= -0.1:  return 'Bearish'
    return 'Neutral'


def _strength(v):
    if v is None: return 0
    return min(100, int(abs(v) * 100))


def _ema_score(c, e20, e50, e200):
    if not (c and e20 and e50): return 50
    if e200:
        if c > e20 > e50 > e200: return 92
        if c > e20 > e50:        return 72
        if c < e20 < e50 < e200: return 8
        if c < e20 < e50:        return 28
    else:
        if c > e20 > e50: return 75
        if c < e20 < e50: return 25
    return 50


def _macd_score(m, s):
    if m is None or s is None: return 50
    return 72 if m > s else 28


def _rsi_score(r):
    if not r: return 50
    if r >= 70: return 75
    if r >= 60: return 85
    if r >= 50: return 65
    if r >= 40: return 35
    return 22


def _vol_score(vr):
    if vr >= 2.0: return 90
    if vr >= 1.5: return 75
    if vr >= 1.0: return 55
    return 35


def _tv_votes(c, e20, e50, e200, ml, ms, r, vr, adx, pdi, ndi, rec):
    """Vote-based consensus from TradingView data. Returns (up, down)."""
    up = down = 0

    # 1. EMA trend
    if e200:
        if   c > e20 > e50 > e200: up   += 2
        elif c < e20 < e50 < e200: down += 2
        elif c > e20 > e50:        up   += 1
        elif c < e20 < e50:        down += 1
    else:
        if   c and e20 and e50:
            if   c > e20 > e50: up   += 1
            elif c < e20 < e50: down += 1

    # 2. MACD
    if ml is not None and ms is not None:
        if ml > ms: up   += 1
        else:       down += 1

    # 3. RSI
    if r:
        if   r >= 55: up   += 1
        elif r <= 45: down += 1

    # 4. TV recommendation as proxy (strong = counts as vote)
    if rec is not None:
        if   rec >= 0.3: up   += 1
        elif rec <= -0.3: down += 1

    # 5. ADX directional
    if adx and adx > 20 and pdi is not None and ndi is not None:
        if   pdi > ndi: up   += 1
        elif ndi > pdi: down += 1

    # 6. Volume confirmation
    if vr >= 1.5:
        if up > down:   up   += 1
        elif down > up: down += 1

    return up, down


def _signal_type(up, down, divergence=None):
    vote_diff = abs(up - down)
    if divergence:
        return 'Reversal'
    if vote_diff >= 3:
        return 'Trend'
    return 'Mixed'


def scan_tv(sector='all', timeframe='1d', min_score=40, limit=200):
    sf = _TF.get(timeframe, '')

    cols = [
        'name', 'description', 'close', 'change', 'change_abs',
        f'Recommend.All{sf}', f'Recommend.MA{sf}', f'Recommend.Other{sf}',
        f'RSI{sf}', f'MACD.macd{sf}', f'MACD.signal{sf}',
        f'EMA20{sf}', f'EMA50{sf}', f'EMA200{sf}',
        'volume', 'average_volume_10d_calc',
        'ATR', 'ADX', 'ADX+DI', 'ADX-DI',
        'sector', 'exchange', 'market_cap_basic',
    ]

    filters = [
        {'left': 'exchange',          'operation': 'in_range', 'right': ['NASDAQ', 'NYSE', 'AMEX']},
        {'left': 'market_cap_basic',  'operation': 'greater',  'right': 500_000_000},
        {'left': 'type',              'operation': 'equal',    'right': 'stock'},
        {'left': 'is_primary',        'operation': 'equal',    'right': True},
    ]

    if sector and sector.lower() not in ('all', ''):
        tv_sector = _SECTOR_TV.get(sector, sector)
        filters.append({'left': 'sector', 'operation': 'equal', 'right': tv_sector})

    body = {
        'filter':  filters,
        'options': {'lang': 'en'},
        'markets': ['america'],
        'symbols': {'tickers': [], 'query': {'types': ['stock']}},
        'columns': cols,
        'sort':    {'sortBy': f'Recommend.All{sf}', 'sortOrder': 'desc'},
        'range':   [0, limit],
    }

    resp = requests.post(TV_URL, json=body, headers=_HEADERS, timeout=20)
    resp.raise_for_status()
    raw = resp.json()

    results = []
    for item in raw.get('data', []):
        sym  = item['s'].split(':')[-1]
        vals = item.get('d', [])
        cm   = dict(zip(cols, vals))

        rec       = cm.get(f'Recommend.All{sf}')
        label, css = _tv_label(rec)
        direction  = _direction(rec)
        strength   = _strength(rec)

        if strength < min_score:
            continue

        price   = cm.get('close')     or 0
        vol     = cm.get('volume')    or 0
        avg_vol = cm.get('average_volume_10d_calc') or 1
        vr      = round(vol / avg_vol, 2) if avg_vol else 1.0

        rsi  = cm.get(f'RSI{sf}')         or 0
        macd = cm.get(f'MACD.macd{sf}')   or 0
        msig = cm.get(f'MACD.signal{sf}') or 0
        e20  = cm.get(f'EMA20{sf}')       or 0
        e50  = cm.get(f'EMA50{sf}')       or 0
        e200 = cm.get(f'EMA200{sf}')
        atr  = cm.get('ATR')              or 0

        adx_val = cm.get('ADX')      or 0
        pdi     = cm.get('ADX+DI')   or 0
        ndi     = cm.get('ADX-DI')   or 0

        tv_sector = cm.get('sector') or 'Unknown'
        sector_display = _SECTOR_MAP.get(tv_sector, tv_sector)
        exchange  = cm.get('exchange') or 'NASDAQ'

        # AB.SK-style targets (SuperTrend not available from screener, use ATR levels)
        mult_dir = 1 if direction == 'Bullish' else -1
        tp1  = round(price + mult_dir * 1.5 * atr, 2) if atr else None
        tp2  = round(price + mult_dir * 3.0 * atr, 2) if atr else None
        tp3  = round(price + mult_dir * 4.5 * atr, 2) if atr else None
        stop = round(price - mult_dir * 1.0 * atr, 2) if atr else None

        # Vote-based consensus
        up_votes, down_votes = _tv_votes(
            price, e20, e50, e200, macd, msig, rsi, vr, adx_val, pdi, ndi, rec)
        signal_type = _signal_type(up_votes, down_votes)

        results.append({
            'symbol':        sym,
            'name':          cm.get('description') or sym,
            'sector':        sector_display,
            'exchange':      exchange,
            'tv_symbol':     f"{exchange}:{sym}",
            'score':         strength,
            'direction':     direction,
            'signal_type':   signal_type,
            'up_votes':      up_votes,
            'down_votes':    down_votes,
            'tv_rating':     label,
            'tv_css':        css,
            'tv_recommend':  round(rec, 3) if rec is not None else None,
            'price':         round(price, 2),
            'change_pct':    round(cm.get('change') or 0, 2),
            'rsi':           round(rsi, 1),
            'macd':          round(macd, 4),
            'macd_signal':   round(msig, 4),
            'ema20':         round(e20, 2),
            'ema50':         round(e50, 2),
            'ema200':        round(e200, 2) if e200 else None,
            'volume':        int(vol),
            'vol_ratio':     vr,
            'atr':           round(atr, 2),
            'adx':           round(adx_val, 1),
            'adx_plus_di':   round(pdi, 1),
            'adx_minus_di':  round(ndi, 1),
            'entry':         round(price, 2),
            'stop':          stop,
            'tp1':           tp1,
            'tp2':           tp2,
            'tp3':           tp3,
            'target':        tp2,
            'rr':            round(abs(tp2 - price) / max(abs(price - stop), 0.01), 2) if (tp2 and stop) else 2.0,
            'last_candle':   'Real-time',
            'source':        'TradingView',
            'ema_score':     _ema_score(price, e20, e50, e200),
            'macd_score':    _macd_score(macd, msig),
            'rsi_score':     _rsi_score(rsi),
            'vol_score':     _vol_score(vr),
            'composite':     round((rec + 1) / 2 * 100, 1) if rec is not None else 50,
            'supertrend':    None,
            'supertrend_dir': 1 if direction == 'Bullish' else -1,
            'divergence':    None,
            'patterns':      [],
            'rs_20':         None,
            'mtf_align':     0,
            'regime_score':  50,
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    return results
