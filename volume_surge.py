"""
Volume Surge Scanner.
Finds stocks with unusually high volume vs their 10-day average —
the earliest signal that institutional money is moving into a stock.
"""
import requests

TV_URL    = 'https://scanner.tradingview.com/america/scan'
_HEADERS  = {
    'origin':       'https://www.tradingview.com',
    'referer':      'https://www.tradingview.com/',
    'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
}

_SECTOR_DISPLAY = {
    'Technology': 'Technology', 'Finance': 'Financial',
    'Healthcare': 'Healthcare', 'Energy': 'Energy',
    'Consumer Cyclical': 'Consumer', 'Consumer Defensive': 'Consumer',
    'Industrial': 'Industrials', 'Communication': 'Communication',
    'Materials': 'Basic Materials', 'Real Estate': 'Real Estate',
    'Utilities': 'Utilities',
}


def _classify(price, e20, e50, rsi, change_pct, macd, msig):
    """Classify the nature of the volume surge."""
    above_e20 = bool(price and e20 and price > e20)
    macd_bull = bool(macd and msig and macd > msig)

    if above_e20 and change_pct >= 2.0 and rsi and rsi > 55:
        return 'Breakout',     'breakout'
    if above_e20 and change_pct >= 0.5 and macd_bull:
        return 'Accumulation', 'accumulation'
    if above_e20 and abs(change_pct) < 1.0 and rsi and 40 < rsi < 60:
        return 'Coiling',      'coiling'      # tight range + high vol = energy building
    if not above_e20 and change_pct <= -2.0 and rsi and rsi < 50:
        return 'Distribution', 'distribution'
    if rsi and rsi < 35 and change_pct < -3.0:
        return 'Capitulation', 'capitulation' # panic selling — watch for reversal
    if rsi and rsi > 70 and change_pct > 4.0:
        return 'Momentum',     'momentum'
    if change_pct >= 1.0:
        return 'Surge Up',     'surge-up'
    if change_pct <= -1.0:
        return 'Surge Down',   'surge-down'
    return 'Unusual Vol',  'unusual'


def scan_volume_surge(min_vol_ratio=2.0, min_price=5.0,
                      min_avg_vol=300_000, market_cap='all', limit=50):
    """
    Returns stocks sorted by relative volume descending.

    min_vol_ratio : current volume / 10-day average (default 2×)
    min_price     : filters out penny stocks (default $5)
    min_avg_vol   : liquidity floor — avoids illiquid names (default 300 K)
    """
    cols = [
        'name', 'description', 'close', 'change', 'volume',
        'average_volume_10d_calc', 'relative_volume_10d_calc',
        'RSI', 'MACD.macd', 'MACD.signal',
        'EMA20', 'EMA50', 'EMA200',
        'ATR', 'ADX', 'ADX+DI', 'ADX-DI',
        'BB.upper', 'BB.lower', 'BB.basis',
        'High', 'Low', 'Open',
        'sector', 'exchange', 'market_cap_basic',
    ]

    base_mcap = 300_000_000
    if market_cap == 'large': base_mcap = 10_000_000_000
    elif market_cap == 'mid': base_mcap = 2_000_000_000

    filters = [
        {'left': 'exchange',                 'operation': 'in_range', 'right': ['NASDAQ', 'NYSE', 'AMEX']},
        {'left': 'type',                     'operation': 'equal',    'right': 'stock'},
        {'left': 'is_primary',               'operation': 'equal',    'right': True},
        {'left': 'market_cap_basic',         'operation': 'greater',  'right': base_mcap},
        {'left': 'close',                    'operation': 'greater',  'right': float(min_price)},
        {'left': 'average_volume_10d_calc',  'operation': 'greater',  'right': int(min_avg_vol)},
        {'left': 'relative_volume_10d_calc', 'operation': 'greater',  'right': float(min_vol_ratio)},
    ]

    body = {
        'filter':  filters,
        'options': {'lang': 'en'},
        'markets': ['america'],
        'symbols': {'tickers': [], 'query': {'types': ['stock']}},
        'columns': cols,
        'sort':    {'sortBy': 'relative_volume_10d_calc', 'sortOrder': 'desc'},
        'range':   [0, limit],
    }

    resp = requests.post(TV_URL, json=body, headers=_HEADERS, timeout=20)
    resp.raise_for_status()
    raw = resp.json()

    results = []
    for item in raw.get('data', []):
        sym  = item['s'].split(':')[-1]
        cm   = dict(zip(cols, item.get('d', [])))

        price      = cm.get('close')                      or 0
        vol        = cm.get('volume')                     or 0
        avg_vol    = cm.get('average_volume_10d_calc')    or 1
        rel_vol    = cm.get('relative_volume_10d_calc')   or round(vol / max(avg_vol, 1), 2)
        change_pct = cm.get('change')                     or 0
        rsi        = cm.get('RSI')                        or 50
        macd       = cm.get('MACD.macd')                  or 0
        msig       = cm.get('MACD.signal')                or 0
        e20        = cm.get('EMA20')                      or 0
        e50        = cm.get('EMA50')                      or 0
        e200       = cm.get('EMA200')
        atr        = cm.get('ATR')                        or 0
        adx        = cm.get('ADX')                        or 0
        pdi        = cm.get('ADX+DI')                     or 0
        ndi        = cm.get('ADX-DI')                     or 0
        bb_upper   = cm.get('BB.upper')                   or 0
        bb_lower   = cm.get('BB.lower')                   or 0
        bb_mid     = cm.get('BB.basis')                   or 0
        high       = cm.get('High')                       or price
        low        = cm.get('Low')                        or price
        open_p     = cm.get('Open')                       or price
        exchange   = cm.get('exchange')                   or 'NASDAQ'
        tv_sector  = cm.get('sector')                     or ''
        sector     = _SECTOR_DISPLAY.get(tv_sector, tv_sector)

        signal, signal_cls = _classify(price, e20, e50, rsi, change_pct, macd, msig)

        # Volume tier label
        if   rel_vol >= 10: vol_tier = 'extreme'    # 10×+ — major catalyst
        elif rel_vol >= 5:  vol_tier = 'very-high'  # 5-10×
        elif rel_vol >= 3:  vol_tier = 'high'        # 3-5×
        else:               vol_tier = 'elevated'    # 2-3×

        # Swing targets using ATR
        bull     = change_pct >= 0
        mult_dir = 1 if bull else -1
        stop  = round(price - mult_dir * 2.5 * atr, 4) if atr else None
        tp1   = round(price + mult_dir * 3.0 * atr, 4) if atr else None
        tp2   = round(price + mult_dir * 5.0 * atr, 4) if atr else None

        results.append({
            'symbol':      sym,
            'name':        cm.get('description') or sym,
            'exchange':    exchange,
            'tv_symbol':   f"{exchange}:{sym}",
            'sector':      sector,
            'price':       round(price, 2),
            'open':        round(open_p, 2),
            'high':        round(high, 2),
            'low':         round(low, 2),
            'change_pct':  round(change_pct, 2),
            'volume':      int(vol),
            'avg_volume':  int(avg_vol),
            'rel_vol':     round(rel_vol, 1),
            'vol_tier':    vol_tier,
            'rsi':         round(rsi, 1),
            'macd':        round(macd, 4),
            'macd_signal': round(msig, 4),
            'ema20':       round(e20, 2),
            'ema50':       round(e50, 2),
            'ema200':      round(e200, 2) if e200 else None,
            'atr':         round(atr, 4),
            'adx':         round(adx, 1),
            'adx_pdi':     round(pdi, 1),
            'adx_ndi':     round(ndi, 1),
            'bb_upper':    round(bb_upper, 2) if bb_upper else None,
            'bb_mid':      round(bb_mid, 2)   if bb_mid   else None,
            'bb_lower':    round(bb_lower, 2) if bb_lower else None,
            'above_e20':   bool(e20 and price > e20),
            'above_e50':   bool(e50 and price > e50),
            'above_e200':  bool(e200 and price > e200),
            'signal':      signal,
            'signal_cls':  signal_cls,
            'stop':        stop,
            'tp1':         tp1,
            'tp2':         tp2,
            'market_cap':  cm.get('market_cap_basic'),
        })

    return results
