# -*- coding: utf-8 -*-
"""
Comprehensive Stock Analysis Engine
Covers: Financial Statements, Valuation, Growth, Risk, News, Investment Verdict
"""
import time
import requests
import yfinance as yf
from news_fetch import fetch_news, _SESSION


def _fetch_info(symbol, max_retries=3):
    """Fetch ticker.info with retry on Yahoo Finance rate-limits."""
    waits = [8, 15, 25]
    for attempt in range(max_retries + 1):
        try:
            ticker = yf.Ticker(symbol, session=_SESSION)
            info   = ticker.info or {}
            price  = (_s(info.get('currentPrice'))
                   or _s(info.get('regularMarketPrice'))
                   or _s(info.get('previousClose')))
            if price:
                return ticker, info
            return None, None          # unknown / bad symbol
        except Exception as e:
            msg = str(e).lower()
            if ('rate' in msg or 'too many' in msg or '429' in msg) and attempt < max_retries:
                wait = waits[min(attempt, len(waits) - 1)]
                print('  [rate limit] %s — retry in %ds (%d/%d)' % (symbol, wait, attempt+1, max_retries))
                time.sleep(wait)
            else:
                raise
    return None, None

TV_URL = 'https://scanner.tradingview.com/america/scan'
_TV_HEADERS = {
    'origin':       'https://www.tradingview.com',
    'referer':      'https://www.tradingview.com/',
    'user-agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'content-type': 'application/json',
}

# ── Helpers ────────────────────────────────────────────────────────────────
def _s(v, default=None):
    try:
        f = float(v)
        return default if (f != f or abs(f) == float('inf')) else f
    except Exception:
        return default

def _fmt_cap(mc):
    mc = _s(mc)
    if not mc or mc <= 0: return 'N/A'
    if mc >= 1e12: return '$%.2fT' % (mc / 1e12)
    if mc >= 1e9:  return '$%.1fB' % (mc / 1e9)
    return '$%.0fM' % (mc / 1e6)

def _pct(v):
    v = _s(v)
    if v is None: return 'N/A'
    sign = '+' if v >= 0 else ''
    return '%s%.1f%%' % (sign, v * 100)

def _val(v, dec=2, prefix='', suffix=''):
    v = _s(v)
    if v is None: return 'N/A'
    return '%s%.*f%s' % (prefix, dec, v, suffix)

def _sig(v, good_thresh, bad_thresh, invert=False):
    """Return 'good', 'ok', or 'bad' signal for a value."""
    v = _s(v)
    if v is None: return 'muted'
    if invert:
        if v <= good_thresh: return 'good'
        if v <= bad_thresh:  return 'ok'
        return 'bad'
    if v >= good_thresh: return 'good'
    if v >= bad_thresh:  return 'ok'
    return 'bad'

# ── Buffett Score ──────────────────────────────────────────────────────────
def _buffett_score(info):
    score = 0
    signals = []

    roe = _s(info.get('returnOnEquity'))
    if roe is not None:
        if roe > 0.20: score += 20; s = 'good'
        elif roe > 0.12: score += 12; s = 'ok'
        elif roe > 0: score += 5; s = 'ok'
        else: s = 'bad'
        signals.append({'k': 'ROE', 'v': _pct(roe), 's': s})

    de = _s(info.get('debtToEquity'))
    if de is not None:
        if de < 50:  score += 20; s = 'good'
        elif de < 100: score += 12; s = 'ok'
        elif de < 200: score += 5; s = 'ok'
        else: s = 'bad'
        signals.append({'k': 'Debt/Equity', 'v': '%.0f%%' % de, 's': s})

    pm = _s(info.get('profitMargins'))
    if pm is not None:
        if pm > 0.20: score += 20; s = 'good'
        elif pm > 0.10: score += 12; s = 'ok'
        elif pm > 0: score += 5; s = 'ok'
        else: s = 'bad'
        signals.append({'k': 'Net Margin', 'v': _pct(pm), 's': s})

    fcf = _s(info.get('freeCashflow'))
    if fcf is not None:
        if fcf > 5e9: score += 15; s = 'good'; v = '+$%.1fB' % (fcf/1e9)
        elif fcf > 0: score += 10; s = 'ok';   v = '+$%.0fM' % (fcf/1e6)
        else: s = 'bad';  v = '-$%.0fM' % (abs(fcf)/1e6)
        signals.append({'k': 'Free Cash Flow', 'v': v, 's': s})

    eg = _s(info.get('earningsGrowth'))
    if eg is not None:
        if eg > 0.15: score += 15; s = 'good'
        elif eg > 0.05: score += 8; s = 'ok'
        elif eg > 0: score += 3; s = 'ok'
        else: s = 'bad'
        signals.append({'k': 'Earnings Growth', 'v': _pct(eg), 's': s})

    pe = _s(info.get('trailingPE'))
    if pe is not None and pe > 0:
        if 5 < pe < 15: score += 10; s = 'good'
        elif 15 <= pe < 25: score += 5; s = 'ok'
        else: s = 'bad'
        signals.append({'k': 'P/E Ratio', 'v': '%.1f' % pe, 's': s})

    score = min(100, score)
    if score >= 75:   verdict, invest = 'Strong Buy',   'Yes — Meets Buffett Criteria ✓'
    elif score >= 60: verdict, invest = 'Buy',          'Likely Yes — Good Value'
    elif score >= 45: verdict, invest = 'Hold',         'Maybe — Some Concerns'
    else:             verdict, invest = 'Avoid',        'No — Does Not Meet Criteria'

    return score, verdict, invest, signals

# ── Single Stock Analysis ──────────────────────────────────────────────────
def analyze_stock(symbol):
    try:
        ticker, info = _fetch_info(symbol.upper())
        if ticker is None or info is None:
            return {'error': 'Symbol not found or Yahoo Finance unavailable: %s' % symbol}

        news_items = fetch_news([symbol.upper()], max_per_symbol=8)
        buf_score, buf_verdict, buf_invest, buf_signals = _buffett_score(info)

        direction = ('Bullish' if buf_score >= 60
                     else 'Bearish' if buf_score <= 40
                     else 'Neutral')

        # Analyst recommendation text
        rec_map = {
            'strongBuy': 'Strong Buy', 'buy': 'Buy',
            'hold': 'Hold', 'sell': 'Sell', 'strongSell': 'Strong Sell'
        }
        rec = rec_map.get(info.get('recommendationKey', ''), 'N/A')

        # Upside/downside to analyst target
        target = _s(info.get('targetMeanPrice'))
        upside = None
        if target and price:
            upside = (target - price) / price * 100

        return {
            # Identity
            'symbol':          symbol.upper(),
            'name':            (info.get('longName') or info.get('shortName') or symbol),
            'sector':          (info.get('sector') or 'Unknown'),
            'industry':        (info.get('industry') or ''),
            'website':         (info.get('website') or ''),

            # Price
            'price':           round(float(price), 2),
            'change_pct':      round(float(_s(info.get('regularMarketChangePercent'), 0)), 2),
            'market_cap':      _fmt_cap(info.get('marketCap')),
            'week52_high':     round(float(_s(info.get('fiftyTwoWeekHigh'), 0)), 2),
            'week52_low':      round(float(_s(info.get('fiftyTwoWeekLow'), 0)), 2),
            'beta':            round(float(_s(info.get('beta'), 0)), 2),

            # Section 1 — Financial Statements
            'revenue_growth':  _s(info.get('revenueGrowth')),
            'earnings_growth': _s(info.get('earningsGrowth')),
            'gross_margin':    _s(info.get('grossMargins')),
            'net_margin':      _s(info.get('profitMargins')),
            'op_margin':       _s(info.get('operatingMargins')),
            'eps_ttm':         round(float(_s(info.get('trailingEps'), 0)), 2),
            'eps_fwd':         round(float(_s(info.get('forwardEps'), 0)), 2),
            'debt_equity':     round(float(_s(info.get('debtToEquity'), 0)), 1),
            'current_ratio':   round(float(_s(info.get('currentRatio'), 0)), 2),
            'quick_ratio':     round(float(_s(info.get('quickRatio'), 0)), 2),
            'fcf':             _s(info.get('freeCashflow')),
            'op_cashflow':     _s(info.get('operatingCashflow')),
            'roe':             _s(info.get('returnOnEquity')),
            'roa':             _s(info.get('returnOnAssets')),

            # Section 2 — Valuation
            'pe_ttm':          round(float(_s(info.get('trailingPE'), 0)), 1),
            'pe_fwd':          round(float(_s(info.get('forwardPE'), 0)), 1),
            'pb':              round(float(_s(info.get('priceToBook'), 0)), 2),
            'ev_ebitda':       round(float(_s(info.get('enterpriseToEbitda'), 0)), 1),
            'div_yield':       round(float(_s(info.get('dividendYield'), 0)) * 100, 2),
            'peg':             round(float(_s(info.get('pegRatio'), 0)), 2),

            # Section 3 — Growth
            'target_price':    round(float(target), 2) if target else None,
            'upside':          round(float(upside), 1) if upside is not None else None,
            'analyst_rec':     rec,
            'analyst_count':   int(info.get('numberOfAnalystOpinions') or 0),

            # Section 4 — Risk
            'short_float':     round(float(_s(info.get('shortPercentOfFloat'), 0)) * 100, 1),

            # Section 6 — Investment Verdict
            'direction':       direction,
            'buffett_score':   buf_score,
            'buffett_verdict': buf_verdict,
            'buffett_invest':  buf_invest,
            'buffett_signals': buf_signals,

            # Section 5 — News
            'news':            news_items[:6],
        }
    except Exception as e:
        return {'error': str(e)}

# ── Value Screener (TradingView API) ──────────────────────────────────────
_VALUE_COLS = [
    'name', 'description', 'close', 'change',
    'price_earnings_ttm', 'price_book_fq',
    'dividend_yield_calc', 'earnings_growth',
    'return_on_equity', 'debt_to_equity_fq',
    'Recommend.All', 'market_cap_basic', 'sector',
]

def screen_undervalued(max_pe=15, min_div=0.0, max_pb=3.0, limit=30):
    filters = [
        {'left': 'exchange',         'operation': 'in_range', 'right': ['NASDAQ', 'NYSE']},
        {'left': 'market_cap_basic', 'operation': 'greater',  'right': 1_000_000_000},
        {'left': 'type',             'operation': 'equal',    'right': 'stock'},
        {'left': 'is_primary',       'operation': 'equal',    'right': True},
    ]
    if max_pe > 0:
        filters.append({'left': 'price_earnings_ttm', 'operation': 'in_range', 'right': [1, max_pe]})
    if max_pb > 0:
        filters.append({'left': 'price_book_fq', 'operation': 'in_range', 'right': [0.01, max_pb]})
    if min_div > 0:
        filters.append({'left': 'dividend_yield_calc', 'operation': 'greater', 'right': min_div})

    body = {
        'filter':  filters,
        'options': {'lang': 'en'},
        'markets': ['america'],
        'symbols': {'tickers': [], 'query': {'types': ['stock']}},
        'columns': _VALUE_COLS,
        'sort':    {'sortBy': 'earnings_growth', 'sortOrder': 'desc'},
        'range':   [0, limit],
    }
    resp = requests.post(TV_URL, json=body, headers=_TV_HEADERS, timeout=15)
    resp.raise_for_status()

    results = []
    for item in resp.json().get('data', []):
        sym = item['s'].split(':')[-1]
        cm  = dict(zip(_VALUE_COLS, item.get('d', [])))

        def _n(k, dec=2):
            v = _s(cm.get(k), 0)
            return round(float(v), dec) if v else 0

        rec = _s(cm.get('Recommend.All'))
        tv_dir = ('Bullish' if rec and rec > 0.1
                  else 'Bearish' if rec and rec < -0.1
                  else 'Neutral')

        results.append({
            'symbol':     sym,
            'name':       (cm.get('description') or sym),
            'price':      _n('close', 2),
            'change_pct': _n('change', 2),
            'pe':         _n('price_earnings_ttm', 1),
            'pb':         _n('price_book_fq', 2),
            'div_yield':  _n('dividend_yield_calc', 2),
            'eps_growth': round(_n('earnings_growth') * 100, 1),
            'roe':        round(_n('return_on_equity') * 100, 1),
            'debt_eq':    _n('debt_to_equity_fq', 1),
            'tv_dir':     tv_dir,
            'sector':     (cm.get('sector') or 'Unknown'),
            'market_cap': _fmt_cap(cm.get('market_cap_basic')),
        })

    return results
