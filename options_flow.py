"""
Options Flow Scanner.
Detects unusual options activity (sweeps, put/call imbalance) as a proxy
for institutional order flow. Uses yfinance for options chain data and the
TV screener for the high-activity stock universe.
"""
import time
import threading
import requests
import pandas as pd
import yfinance as yf
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date as _date

TV_URL   = 'https://scanner.tradingview.com/america/scan'
_TV_HDR  = {
    'origin':       'https://www.tradingview.com',
    'referer':      'https://www.tradingview.com/',
    'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
}

_FLOW_CACHE: dict = {}
_SCAN_CACHE = {'ts': 0.0, 'data': [], 'errors': 0, 'checked': 0}
_CACHE_TTL  = 900   # 15 min

# ── Shared yfinance session (primes Yahoo Finance cookies once) ───────────────
_SESSION_LOCK = threading.Lock()
_YF_SESSION   = None


def _get_yf_session():
    global _YF_SESSION
    if _YF_SESSION is not None:
        return _YF_SESSION
    with _SESSION_LOCK:
        if _YF_SESSION is not None:
            return _YF_SESSION
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
        })
        try:
            s.get('https://finance.yahoo.com/', timeout=8)
        except Exception:
            pass
        _YF_SESSION = s
    return _YF_SESSION


# ── Universe ──────────────────────────────────────────────────────────────────
def _get_universe(limit: int = 50):
    """Top stocks by volume from TV screener — most likely to have liquid options."""
    cols = ['description', 'close', 'change', 'volume',
            'relative_volume_10d_calc', 'sector', 'exchange']
    body = {
        'filter': [
            {'left': 'exchange',                'operation': 'in_range', 'right': ['NASDAQ', 'NYSE', 'AMEX']},
            {'left': 'type',                    'operation': 'equal',    'right': 'stock'},
            {'left': 'is_primary',              'operation': 'equal',    'right': True},
            {'left': 'market_cap_basic',        'operation': 'greater',  'right': 1_000_000_000},
            {'left': 'close',                   'operation': 'greater',  'right': 5.0},
            {'left': 'average_volume_10d_calc', 'operation': 'greater',  'right': 1_000_000},
        ],
        'options': {'lang': 'en'},
        'markets': ['america'],
        'columns': cols,
        'sort': {'sortBy': 'volume', 'sortOrder': 'desc'},
        'range': [0, limit],
    }
    resp = requests.post(TV_URL, json=body, headers=_TV_HDR, timeout=15)
    resp.raise_for_status()
    stocks = []
    for item in resp.json().get('data', []):
        sym = item['s'].split(':')[-1]
        cm  = dict(zip(cols, item.get('d', [])))
        stocks.append({
            'symbol':     sym,
            'name':       cm.get('description') or sym,
            'price':      round(float(cm.get('close')  or 0), 2),
            'change_pct': round(float(cm.get('change') or 0), 2),
            'volume':     int(cm.get('volume')          or 0),
            'rel_vol':    round(float(cm.get('relative_volume_10d_calc') or 1), 1),
            'exchange':   cm.get('exchange') or 'NASDAQ',
            'sector':     cm.get('sector')   or '',
        })
    return stocks


# ── Per-symbol options fetch ──────────────────────────────────────────────────
def _fetch_flow(symbol: str, price: float):
    """
    Fetch options chain for symbol and detect unusual flow.
    Returns a flow dict or None.
    Thresholds are intentionally relaxed so mid-cap stocks qualify.
    """
    cached = _FLOW_CACHE.get(symbol)
    if cached and time.time() - cached[0] < _CACHE_TTL:
        return cached[1]

    try:
        sess = _get_yf_session()
        tk   = yf.Ticker(symbol, session=sess)
        exps = tk.options
        if not exps:
            _FLOW_CACHE[symbol] = (time.time(), None)
            return None

        # Use nearest 2 expirations (most liquid, avoids slow fetches)
        exps = exps[:2]

        total_cv = 0.0
        total_pv = 0.0
        total_coi = 0.0
        total_poi = 0.0
        sweeps   = []

        for exp in exps:
            try:
                chain = tk.option_chain(exp)
                calls = chain.calls.copy()
                puts  = chain.puts.copy()
                for df in (calls, puts):
                    df['volume']            = pd.to_numeric(df['volume'],            errors='coerce').fillna(0)
                    df['openInterest']      = pd.to_numeric(df['openInterest'],      errors='coerce').fillna(0)
                    df['impliedVolatility'] = pd.to_numeric(
                        df.get('impliedVolatility', pd.Series(dtype=float)), errors='coerce').fillna(0)

                total_cv  += float(calls['volume'].sum())
                total_pv  += float(puts['volume'].sum())
                total_coi += float(calls['openInterest'].sum())
                total_poi += float(puts['openInterest'].sum())

                # Sweep: vol ≥ 100 AND vol/OI ≥ 1.5×
                for opt_type, df in [('call', calls), ('put', puts)]:
                    for _, row in df.iterrows():
                        vol = float(row['volume'])
                        oi  = float(row['openInterest'])
                        if vol < 100 or oi <= 0:
                            continue
                        ratio = vol / oi
                        if ratio < 1.5:
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

        # Nothing traded at all — likely outside market hours or bad data
        if total_cv + total_pv == 0:
            _FLOW_CACHE[symbol] = (time.time(), None)
            return None

        sweeps.sort(key=lambda x: x['ratio'], reverse=True)
        call_sweeps = [s for s in sweeps if s['type'] == 'call']
        put_sweeps  = [s for s in sweeps if s['type'] == 'put']

        top_call_r  = call_sweeps[0]['ratio'] if call_sweeps else 0
        top_put_r   = put_sweeps[0]['ratio']  if put_sweeps  else 0
        pcr         = round(total_pv / max(total_cv, 1), 2)

        # Sweep classification: ratio ≥ 2× (was 3×)
        has_call_sweep = bool(call_sweeps and top_call_r >= 2.0)
        has_put_sweep  = bool(put_sweeps  and top_put_r  >= 2.0)

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
        # PCR bias: pcr < 0.7 bullish, > 1.3 bearish (was 0.5 / 1.5)
        # Min total volume lowered to 500 (was 2000)
        elif pcr < 0.7 and total_cv >= 500:
            flow_type  = 'call_bias'
            flow_label = 'Call Bias'
            flow_cls   = 'bullish'
        elif pcr > 1.3 and total_pv >= 500:
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
            'call_oi':         int(total_coi),
            'put_oi':          int(total_poi),
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

    except Exception as e:
        print(f'[options_flow] {symbol}: {e}')
        _FLOW_CACHE[symbol] = (time.time(), None)
        return None


# ── Public scan ───────────────────────────────────────────────────────────────
def scan_options_flow(limit: int = 30, force: bool = False):
    """
    Returns stocks with unusual options flow, sorted by sweep strength.
    Also returns meta stats (errors, checked) for transparency.
    """
    now = time.time()
    if (not force
            and now - _SCAN_CACHE['ts'] < _CACHE_TTL
            and _SCAN_CACHE['data']):
        return _SCAN_CACHE['data'], _SCAN_CACHE['errors'], _SCAN_CACHE['checked']

    stocks  = _get_universe(limit=50)
    meta    = {s['symbol']: s for s in stocks}
    results = []
    errors  = 0

    # 3 workers with small stagger to avoid Yahoo rate-limiting
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures = {ex.submit(_fetch_flow, sym, s['price']): sym
                   for sym, s in meta.items()}
        for fut in as_completed(futures):
            sym  = futures[fut]
            try:
                flow = fut.result()
            except Exception:
                errors += 1
                continue
            if not flow:
                continue
            results.append({**meta[sym], **flow})

    results.sort(key=lambda x: (
        1 if 'sweep' in x.get('flow_type', '') else 0,
        x.get('top_sweep_ratio', 0),
        abs(x.get('flow_score', 0)),
    ), reverse=True)

    out = results[:limit]
    _SCAN_CACHE.update({'ts': now, 'data': out,
                        'errors': errors, 'checked': len(stocks)})
    return out, errors, len(stocks)
