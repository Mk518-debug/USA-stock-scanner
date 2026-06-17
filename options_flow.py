"""
Options Flow Scanner.
Detects unusual options activity (sweeps, put/call imbalance) as a proxy
for institutional order flow. Uses yfinance for options chain data and the
TV screener for the high-activity stock universe.
"""
import time
import requests
import pandas as pd
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date as _date

TV_URL   = 'https://scanner.tradingview.com/america/scan'
_HEADERS = {
    'origin':       'https://www.tradingview.com',
    'referer':      'https://www.tradingview.com/',
    'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
}

_FLOW_CACHE: dict = {}     # symbol → (ts, data)
_SCAN_CACHE = {'ts': 0.0, 'data': []}
_CACHE_TTL  = 900          # 15 minutes


# ── Universe ───────────────────────────────────────────────────────────────────
def _get_universe(limit: int = 80):
    """Return most-active stocks from TV screener as seed universe."""
    cols = ['description', 'close', 'change', 'volume',
            'average_volume_10d_calc', 'relative_volume_10d_calc',
            'sector', 'exchange']
    body = {
        'filter': [
            {'left': 'exchange',                'operation': 'in_range', 'right': ['NASDAQ','NYSE','AMEX']},
            {'left': 'type',                    'operation': 'equal',    'right': 'stock'},
            {'left': 'is_primary',              'operation': 'equal',    'right': True},
            {'left': 'market_cap_basic',        'operation': 'greater',  'right': 500_000_000},
            {'left': 'close',                   'operation': 'greater',  'right': 5.0},
            {'left': 'average_volume_10d_calc', 'operation': 'greater',  'right': 500_000},
        ],
        'options': {'lang': 'en'},
        'markets': ['america'],
        'columns': cols,
        'sort': {'sortBy': 'volume', 'sortOrder': 'desc'},
        'range': [0, limit],
    }
    resp = requests.post(TV_URL, json=body, headers=_HEADERS, timeout=15)
    resp.raise_for_status()
    raw = resp.json()
    stocks = []
    for item in raw.get('data', []):
        sym = item['s'].split(':')[-1]
        cm  = dict(zip(cols, item.get('d', [])))
        stocks.append({
            'symbol':     sym,
            'name':       cm.get('description') or sym,
            'price':      round(float(cm.get('close')   or 0), 2),
            'change_pct': round(float(cm.get('change')  or 0), 2),
            'volume':     int(cm.get('volume')           or 0),
            'rel_vol':    round(float(cm.get('relative_volume_10d_calc') or 1), 1),
            'exchange':   cm.get('exchange') or 'NASDAQ',
            'sector':     cm.get('sector')   or '',
        })
    return stocks


# ── Per-symbol options fetch ───────────────────────────────────────────────────
def _fetch_flow(symbol: str, price: float):
    """
    Fetch options chain for one symbol and detect unusual activity.
    Returns a flow dict or None if nothing interesting.
    """
    cached = _FLOW_CACHE.get(symbol)
    if cached and time.time() - cached[0] < _CACHE_TTL:
        return cached[1]

    try:
        tk   = yf.Ticker(symbol)
        exps = tk.options
        if not exps:
            _FLOW_CACHE[symbol] = (time.time(), None)
            return None

        today  = _date.today()
        # Nearest 3 expirations (most liquid)
        exps   = exps[:3]

        total_cv = 0.0
        total_pv = 0.0
        sweeps   = []

        for exp in exps:
            try:
                chain = tk.option_chain(exp)
                calls = chain.calls.copy()
                puts  = chain.puts.copy()
                for df in (calls, puts):
                    df['volume']            = pd.to_numeric(df['volume'],            errors='coerce').fillna(0)
                    df['openInterest']      = pd.to_numeric(df['openInterest'],      errors='coerce').fillna(0)
                    df['impliedVolatility'] = pd.to_numeric(df.get('impliedVolatility', 0), errors='coerce').fillna(0)

                total_cv += float(calls['volume'].sum())
                total_pv += float(puts['volume'].sum())

                # Sweep = vol ≥ 500 AND vol/OI ≥ 2×
                for opt_type, df in [('call', calls), ('put', puts)]:
                    for _, row in df.iterrows():
                        vol = float(row['volume'])
                        oi  = float(row['openInterest'])
                        if vol < 500 or oi <= 0:
                            continue
                        ratio = vol / oi
                        if ratio < 2.0:
                            continue
                        sweeps.append({
                            'type':   opt_type,
                            'strike': round(float(row['strike']), 2),
                            'expiry': exp,
                            'volume': int(vol),
                            'oi':     int(oi),
                            'ratio':  round(ratio, 1),
                            'iv':     round(float(row['impliedVolatility']) * 100, 1),
                        })
            except Exception:
                continue

        if total_cv + total_pv == 0:
            _FLOW_CACHE[symbol] = (time.time(), None)
            return None

        sweeps.sort(key=lambda x: x['ratio'], reverse=True)
        call_sweeps = [s for s in sweeps if s['type'] == 'call']
        put_sweeps  = [s for s in sweeps if s['type'] == 'put']

        top_call_r  = call_sweeps[0]['ratio'] if call_sweeps else 0
        top_put_r   = put_sweeps[0]['ratio']  if put_sweeps  else 0
        pcr         = round(total_pv / max(total_cv, 1), 2)

        has_call_sweep = bool(call_sweeps and top_call_r >= 3)
        has_put_sweep  = bool(put_sweeps  and top_put_r  >= 3)

        if has_call_sweep and not has_put_sweep:
            flow_type  = 'call_sweep'
            flow_label = 'Call Sweep'
            flow_cls   = 'bullish'
        elif has_put_sweep and not has_call_sweep:
            flow_type  = 'put_sweep'
            flow_label = 'Put Sweep'
            flow_cls   = 'bearish'
        elif has_call_sweep and has_put_sweep:
            flow_type  = 'mixed'
            flow_label = 'Mixed Sweeps'
            flow_cls   = 'neutral'
        elif pcr < 0.5 and total_cv >= 2000:
            flow_type  = 'call_bias'
            flow_label = 'Call Bias'
            flow_cls   = 'bullish'
        elif pcr > 1.5 and total_pv >= 2000:
            flow_type  = 'put_bias'
            flow_label = 'Put Bias'
            flow_cls   = 'bearish'
        else:
            _FLOW_CACHE[symbol] = (time.time(), None)
            return None

        total_vol  = total_cv + total_pv
        flow_score = round((total_cv - total_pv) / max(total_vol, 1) * 100, 1)

        result = {
            'call_vol':        int(total_cv),
            'put_vol':         int(total_pv),
            'pcr':             pcr,
            'flow_type':       flow_type,
            'flow_label':      flow_label,
            'flow_cls':        flow_cls,
            'flow_score':      flow_score,
            'top_sweep_ratio': round(max(top_call_r, top_put_r), 1),
            'sweeps':          sweeps[:5],
        }
        _FLOW_CACHE[symbol] = (time.time(), result)
        return result

    except Exception:
        _FLOW_CACHE[symbol] = (time.time(), None)
        return None


# ── Public scan ───────────────────────────────────────────────────────────────
def scan_options_flow(limit: int = 30, force: bool = False):
    """
    Returns list of stocks with unusual options flow, sorted by sweep strength.
    Results cached for 15 minutes.
    """
    now = time.time()
    if not force and now - _SCAN_CACHE['ts'] < _CACHE_TTL and _SCAN_CACHE['data']:
        return _SCAN_CACHE['data']

    stocks = _get_universe(limit=75)
    meta   = {s['symbol']: s for s in stocks}

    results = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(_fetch_flow, sym, s['price']): sym
                   for sym, s in meta.items()}
        for fut in as_completed(futures):
            sym  = futures[fut]
            flow = fut.result()
            if not flow:
                continue
            results.append({**meta[sym], **flow})

    # Sort: outright sweeps first, then by sweep ratio, then flow score
    results.sort(key=lambda x: (
        1 if 'sweep' in x.get('flow_type', '') else 0,
        x.get('top_sweep_ratio', 0),
        abs(x.get('flow_score', 0)),
    ), reverse=True)

    out = results[:limit]
    _SCAN_CACHE['ts']   = now
    _SCAN_CACHE['data'] = out
    return out
