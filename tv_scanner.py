"""
TradingView Screener API integration.
Returns real-time data + TV technical ratings + additional indicators.
"""
import requests

TV_URL = 'https://scanner.tradingview.com/america/scan'

_HEADERS = {
    'origin':       'https://www.tradingview.com',
    'referer':      'https://www.tradingview.com/',
    'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
}

_TF = {'1d': '', '4h': '|240', '1h': '|60', '15m': '|15', '1w': '|W', '1mo': '|M'}

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

_SECTOR_TV = {v: k for k, v in _SECTOR_MAP.items()}
_SECTOR_TV['Consumer'] = 'Consumer Cyclical'


def _tv_label(v):
    if v is None:  return 'N/A',        'tv-na'
    if v >= 0.5:   return 'Strong Buy',  'tv-strong-buy'
    if v >= 0.1:   return 'Buy',         'tv-buy'
    if v > -0.1:   return 'Neutral',     'tv-neutral'
    if v > -0.5:   return 'Sell',        'tv-sell'
    return              'Strong Sell',   'tv-strong-sell'


def _direction(v):
    if v is None: return 'Neutral'
    if v >= 0.1:  return 'Bullish'
    if v <= -0.1: return 'Bearish'
    return 'Neutral'


def _strength(v):
    if v is None: return 0
    return min(100, int(abs(v) * 100))


def _tv_votes(c, e20, e50, e200, ml, ms, r, vr, adx, pdi, ndi, rec, bb_mid,
              htf_e20, htf_e50, htf_c):
    """
    10-indicator vote system using TradingView screener data.
    Returns (up_votes, down_votes).
    """
    up = down = 0

    # 1. EMA alignment (primary TF)
    if c and e20 and e50:
        if e200:
            if   c > e20 > e50 > e200: up   += 1
            elif c < e20 < e50 < e200: down += 1
            elif c > e20 > e50:        up   += 1
            elif c < e20 < e50:        down += 1
        else:
            if   c > e20 > e50: up   += 1
            elif c < e20 < e50: down += 1

    # 2. HTF EMA (1H) alignment
    if htf_c and htf_e20 and htf_e50:
        if   htf_c > htf_e20 > htf_e50: up   += 1
        elif htf_c < htf_e20 < htf_e50: down += 1

    # 3. MACD
    if ml is not None and ms is not None:
        if ml > ms: up   += 1
        else:       down += 1

    # 4. RSI (abstains 45-55)
    if r:
        if   r >= 55: up   += 1
        elif r <= 45: down += 1

    # 5. TV recommendation as SuperTrend proxy
    if rec is not None:
        if   rec >= 0.3: up   += 1
        elif rec <= -0.3: down += 1

    # 6. ADX directional
    if adx and adx > 20 and pdi is not None and ndi is not None:
        if   pdi > ndi: up   += 1
        elif ndi > pdi: down += 1

    # 7. Volume confirmation
    if vr >= 1.5:
        if up > down:   up   += 1
        elif down > up: down += 1

    # 8. Bollinger position
    if bb_mid and c:
        if   c > bb_mid: up   += 1
        elif c < bb_mid: down += 1

    return up, down


def _signal_type_from_votes(up, down):
    diff = abs(up - down)
    if diff >= 3: return 'Trend'
    return 'Mixed'


def fetch_analyst_tv(tv_symbol):
    """
    Fetch Wall Street analyst consensus for one symbol from TradingView.
    Tries multiple known column-name variants; returns dict or None.
    """
    # TradingView exposes analyst data under these column names
    cols = [
        'Recommend.All',           # technical consensus (-1→1), used as fallback
        'analyst_count',
        'buy_count',   'sell_count',   'neutral_count',   # primary candidate names
        'Analysts.Buy','Analysts.Sell','Analysts.Neutral', # alternative names
        'price_target_average', 'price_target_high', 'price_target_low',
    ]
    body = {
        'symbols': {'tickers': [tv_symbol]},
        'columns': cols,
        'options': {'lang': 'en'},
        'markets': ['america'],
    }
    try:
        resp = requests.post(TV_URL, json=body, headers=_HEADERS, timeout=15)
        resp.raise_for_status()
        raw = resp.json()
        if not raw.get('data'):
            return None

        cm = dict(zip(cols, raw['data'][0].get('d', [])))

        # Try primary names, then alternatives
        def _i(k1, k2=None):
            v = cm.get(k1) or (cm.get(k2) if k2 else None)
            return int(v) if v is not None else None

        buy  = _i('buy_count',  'Analysts.Buy')
        sell = _i('sell_count', 'Analysts.Sell')
        hold = _i('neutral_count', 'Analysts.Neutral')
        analyst_count = _i('analyst_count')
        total = analyst_count or ((buy or 0) + (hold or 0) + (sell or 0))

        # Only return counts if we got real data
        if total and total > 0 and (buy is not None or hold is not None):
            return {
                'buy':      buy  or 0,
                'hold':     hold or 0,
                'sell':     sell or 0,
                'total':    total,
                'target':   cm.get('price_target_average'),
                'target_h': cm.get('price_target_high'),
                'target_l': cm.get('price_target_low'),
                'rec_all':  cm.get('Recommend.All'),  # kept for reference
            }

        # If analyst counts not available but price targets exist, return targets only
        target = cm.get('price_target_average')
        if target:
            return {
                'buy': 0, 'hold': 0, 'sell': 0, 'total': 0,
                'target':   target,
                'target_h': cm.get('price_target_high'),
                'target_l': cm.get('price_target_low'),
                'rec_all':  cm.get('Recommend.All'),
            }

        return None
    except Exception as e:
        print(f'[fetch_analyst_tv {tv_symbol}] {e}')
        return None


def scan_tv(sector='all', timeframe='1d', min_score=40, limit=200,
            min_price=0, max_price=0, min_vol=0, market_cap='all'):
    sf  = _TF.get(timeframe, '')
    sf1 = '|60'  # always request 1H as secondary TF for HTF EMA

    cols = [
        'name', 'description', 'close', 'change', 'change_abs',
        f'Recommend.All{sf}', f'Recommend.MA{sf}', f'Recommend.Other{sf}',
        f'RSI{sf}', f'MACD.macd{sf}', f'MACD.signal{sf}',
        f'EMA20{sf}', f'EMA50{sf}', f'EMA200{sf}',
        'volume', 'average_volume_10d_calc',
        'ATR', 'ADX', 'ADX+DI', 'ADX-DI',
        'BB.upper', 'BB.lower', 'BB.basis',
        f'EMA20{sf1}', f'EMA50{sf1}', f'close{sf1}',
        'put_call_ratio', 'Volatility.D', 'HV.1M',
        'sector', 'exchange', 'market_cap_basic',
    ]

    # Base market cap floor (overridden by market_cap param)
    base_mcap = 500_000_000
    if market_cap == 'mid':   base_mcap = 2_000_000_000
    elif market_cap == 'large': base_mcap = 10_000_000_000

    filters = [
        {'left': 'exchange',         'operation': 'in_range', 'right': ['NASDAQ', 'NYSE', 'AMEX']},
        {'left': 'market_cap_basic', 'operation': 'greater',  'right': base_mcap},
        {'left': 'type',             'operation': 'equal',    'right': 'stock'},
        {'left': 'is_primary',       'operation': 'equal',    'right': True},
    ]

    if market_cap == 'small':
        filters.append({'left': 'market_cap_basic', 'operation': 'less', 'right': 2_000_000_000})
    elif market_cap == 'mid':
        filters.append({'left': 'market_cap_basic', 'operation': 'less', 'right': 10_000_000_000})

    if min_price > 0:
        filters.append({'left': 'close', 'operation': 'greater', 'right': float(min_price)})
    if max_price > 0:
        filters.append({'left': 'close', 'operation': 'less',    'right': float(max_price)})
    if min_vol > 0:
        filters.append({'left': 'volume', 'operation': 'greater', 'right': int(min_vol)})

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

        rec        = cm.get(f'Recommend.All{sf}')
        label, css = _tv_label(rec)
        direction  = _direction(rec)
        strength   = _strength(rec)

        if strength < min_score:
            continue

        price   = cm.get('close')    or 0
        vol     = cm.get('volume')   or 0
        avg_vol = cm.get('average_volume_10d_calc') or 1
        vr      = round(vol / avg_vol, 2) if avg_vol else 1.0

        rsi  = cm.get(f'RSI{sf}')          or 0
        macd = cm.get(f'MACD.macd{sf}')    or 0
        msig = cm.get(f'MACD.signal{sf}')  or 0
        e20  = cm.get(f'EMA20{sf}')        or 0
        e50  = cm.get(f'EMA50{sf}')        or 0
        e200 = cm.get(f'EMA200{sf}')
        atr  = cm.get('ATR')               or 0

        adx_val = cm.get('ADX')     or 0
        pdi     = cm.get('ADX+DI')  or 0
        ndi     = cm.get('ADX-DI')  or 0

        bb_upper = cm.get('BB.upper') or 0
        bb_lower = cm.get('BB.lower') or 0
        bb_mid   = cm.get('BB.basis') or 0

        # HTF (1H) EMA data
        htf_e20 = cm.get(f'EMA20{sf1}') or 0
        htf_e50 = cm.get(f'EMA50{sf1}') or 0
        htf_c   = cm.get(f'close{sf1}') or 0
        htf_ema_dir = (1  if htf_c and htf_e20 and htf_e50 and htf_c > htf_e20 > htf_e50
                       else -1 if htf_c and htf_e20 and htf_e50 and htf_c < htf_e20 < htf_e50
                       else 0)

        tv_sector      = cm.get('sector') or 'Unknown'
        sector_display = _SECTOR_MAP.get(tv_sector, tv_sector)
        exchange       = cm.get('exchange') or 'NASDAQ'

        # AB.SK targets: Stop=5×ATR, G1=2.5×ATR, G2=5×ATR, G3=7.5×ATR
        mult_dir = 1 if direction == 'Bullish' else -1
        stop     = round(price - mult_dir * 5.0 * atr, 4) if atr else None
        tp1      = round(price + mult_dir * 2.5 * atr, 4) if atr else None
        tp2      = round(price + mult_dir * 5.0 * atr, 4) if atr else None
        tp3      = round(price + mult_dir * 7.5 * atr, 4) if atr else None
        rr_val   = round(abs(tp2 - price) / max(abs(price - stop), 0.01), 2) if (tp2 and stop) else 1.0

        # Vote system
        up_votes, down_votes = _tv_votes(
            price, e20, e50, e200, macd, msig, rsi, vr,
            adx_val, pdi, ndi, rec, bb_mid,
            htf_e20, htf_e50, htf_c)
        signal_type = _signal_type_from_votes(up_votes, down_votes)

        # BB Squeeze (from TV data)
        bb_squeeze = 0
        if bb_upper and bb_lower and bb_mid:
            width = (bb_upper - bb_lower) / bb_mid * 100 if bb_mid else 0
            # Without historical data, mark as squeeze if width < 4% (heuristic)
            if width < 4.0:
                bb_squeeze = 80  # approximate

        # Build patterns list
        patterns = []
        if adx_val > 20 and pdi > ndi:   patterns.append('ADX Bullish')
        if adx_val > 20 and ndi > pdi:   patterns.append('ADX Bearish')
        if bb_squeeze >= 70:              patterns.append(f'BB Squeeze {bb_squeeze}%')
        if vr >= 1.5:                     patterns.append(f'Vol +{int((vr-1)*100)}%')

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
            'price':         round(price, 4),
            'change_pct':    round(cm.get('change') or 0, 2),
            'rsi':           round(rsi, 1),
            'macd':          round(macd, 4),
            'macd_signal':   round(msig, 4),
            'ema20':         round(e20, 4),
            'ema50':         round(e50, 4),
            'ema200':        round(e200, 4) if e200 else None,
            'volume':        int(vol),
            'vol_ratio':     vr,
            'atr':           round(atr, 4),
            'adx':           round(adx_val, 1),
            'adx_plus_di':   round(pdi, 1),
            'adx_minus_di':  round(ndi, 1),
            'adx_rising':    False,
            'supertrend':    None,
            'supertrend_dir': mult_dir,
            'bb_upper':      round(bb_upper, 4) if bb_upper else None,
            'bb_mid':        round(bb_mid, 4) if bb_mid else None,
            'bb_lower':      round(bb_lower, 4) if bb_lower else None,
            'bb_squeeze':    bb_squeeze,
            'entry':         round(price, 4),
            'stop':          stop,
            'tp1':           tp1,
            'tp2':           tp2,
            'tp3':           tp3,
            'target':        tp2,
            'rr':            rr_val,
            'htf_ema_dir':   htf_ema_dir,
            'mtf_align':     htf_ema_dir,
            'divergence':    None,
            'patterns':      patterns,
            'rs_20':         None,
            'support':       round(bb_lower, 4) if bb_lower else round(price * 0.95, 4),
            'resistance':    round(bb_upper, 4) if bb_upper else round(price * 1.05, 4),
            # ── Options metrics from TV screener (arrive with main scan) ──
            'put_call_ratio': round(float(cm.get('put_call_ratio') or 0), 2),
            'volatility_d':   round(float(cm.get('Volatility.D') or cm.get('HV.1M') or 0) * 100, 1),
            'last_candle':   'Real-time',
            'source':        'TradingView',
            'ema_score':     75 if (price and e20 and e50 and price > e20 > e50) else 25,
            'macd_score':    72 if macd > msig else 28,
            'rsi_score':     50,
            'vol_score':     75 if vr >= 1.5 else 45,
            'composite':     round((rec + 1) / 2 * 100, 1) if rec is not None else 50,
            'regime_score':  50,
        })

    results.sort(key=lambda x: x['score'], reverse=True)
    return results
