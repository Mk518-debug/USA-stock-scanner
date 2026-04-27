# -*- coding: utf-8 -*-
"""
Deep Fundamental Research Engine
Single HTTP call per stock (ticker.info only).
No retries — skip rate-limited stocks immediately.
Hard deadline prevents server timeout.
"""
import time
import yfinance as yf
import requests as _req
from datetime import datetime, timezone

DEFAULT_RESEARCH = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN',
    'JPM',  'V',    'JNJ',  'HD',    'TSLA',
]

# ── Shared browser-like session ────────────────────────────────────────────
_SESSION = _req.Session()
_SESSION.headers.update({
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
})

# ── Helpers ────────────────────────────────────────────────────────────────
def _grade(s):
    if s >= 85: return 'A+', 'g-aplus'
    if s >= 75: return 'A',  'g-a'
    if s >= 65: return 'B+', 'g-bplus'
    if s >= 55: return 'B',  'g-b'
    if s >= 40: return 'C',  'g-c'
    return 'D', 'g-d'

def _fmt_cap(mc):
    try:
        mc = float(mc)
        if mc != mc or mc <= 0: return 'N/A'
        if mc >= 1e12: return '$%.2fT' % (mc / 1e12)
        if mc >= 1e9:  return '$%.1fB' % (mc / 1e9)
        return '$%.0fM' % (mc / 1e6)
    except Exception:
        return 'N/A'

def _safe(v, default=None):
    """Return float(v) or default. Converts NaN/inf/None to default."""
    try:
        f = float(v)
        if f != f or abs(f) == float('inf'):
            return default
        return f
    except Exception:
        return default

def _n(v, default=0, dec=2):
    """JSON-safe rounded number."""
    return round(_safe(v, default) or default, dec)

# ── Fetch (single attempt, no retry) ──────────────────────────────────────
def _fetch(symbol):
    try:
        t    = yf.Ticker(symbol, session=_SESSION)
        info = t.info or {}
        price = (_safe(info.get('currentPrice'))
              or _safe(info.get('regularMarketPrice'))
              or _safe(info.get('previousClose')))
        if price:
            return t, info
        return None, None
    except Exception as e:
        print('  [skip] %s: %s' % (symbol, str(e)[:100]))
        return None, None

# ── Financial Health Score ─────────────────────────────────────────────────
def _fin_score(info):
    sc, det = 0, []

    def add(key, val, rules, fmt):
        nonlocal sc
        if val is None: return
        for lo, pts, sig in rules:
            if val >= lo:
                sc += pts
                det.append({'k': key, 'v': fmt(val), 's': sig})
                return
        det.append({'k': key, 'v': fmt(val), 's': 'bad'})

    de  = _safe(info.get('debtToEquity'))
    cr  = _safe(info.get('currentRatio'))
    roe = _safe(info.get('returnOnEquity'))
    pm  = _safe(info.get('profitMargins'))
    fcf = _safe(info.get('freeCashflow'))
    qr  = _safe(info.get('quickRatio'))

    if de is not None:
        s, p = ('good',20) if de<50 else ('ok',12) if de<150 else ('bad',3)
        sc += p; det.append({'k':'Debt/Equity',   'v':'%.0f%%'%de,        's':s})
    if cr is not None:
        s, p = ('good',15) if cr>2 else ('ok',8) if cr>1 else ('bad',0)
        sc += p; det.append({'k':'Current Ratio', 'v':'%.2f'%cr,          's':s})
    if roe is not None:
        s, p = ('good',20) if roe>.25 else ('ok',12) if roe>.12 else ('ok',5) if roe>0 else ('bad',0)
        sc += p; det.append({'k':'ROE',           'v':'%.1f%%'%(roe*100), 's':s})
    if pm is not None:
        s, p = ('good',20) if pm>.20 else ('ok',13) if pm>.10 else ('ok',5) if pm>0 else ('bad',0)
        sc += p; det.append({'k':'Net Margin',    'v':'%.1f%%'%(pm*100),  's':s})
    if fcf is not None:
        if fcf >= 1e9:  s,p,v = 'good',15,'+ $%.1fB'%(fcf/1e9)
        elif fcf > 0:   s,p,v = 'ok',   8,'+ $%.0fM'%(fcf/1e6)
        else:           s,p,v = 'bad',  0,'- $%.0fM'%(abs(fcf)/1e6)
        sc += p; det.append({'k':'Free Cash Flow','v':v,                  's':s})
    if qr is not None:
        s, p = ('good',10) if qr>1.5 else ('ok',5) if qr>1 else ('bad',0)
        sc += p; det.append({'k':'Quick Ratio',   'v':'%.2f'%qr,          's':s})

    return min(100, sc), det

# ── Earnings Quality Score ─────────────────────────────────────────────────
def _earn_score(info):
    sc, det = 0, []

    eg  = _safe(info.get('earningsGrowth'))
    rg  = _safe(info.get('revenueGrowth'))
    gm  = _safe(info.get('grossMargins'))
    om  = _safe(info.get('operatingMargins'))
    fpe = _safe(info.get('forwardPE'))
    tpe = _safe(info.get('trailingPE'))

    if eg is not None:
        if   eg>.25:  s,p,v='good',35,'+%.1f%%'%(eg*100)
        elif eg>.15:  s,p,v='ok',  25,'+%.1f%%'%(eg*100)
        elif eg>.05:  s,p,v='ok',  15,'+%.1f%%'%(eg*100)
        elif eg>0:    s,p,v='ok',   8,'+%.1f%%'%(eg*100)
        else:         s,p,v='bad',  0, '%.1f%%'%(eg*100)
        sc += p; det.append({'k':'EPS Growth (YoY)',   'v':v,'s':s})

    if rg is not None:
        if   rg>.20:  s,p,v='good',25,'+%.1f%%'%(rg*100)
        elif rg>.10:  s,p,v='ok',  15,'+%.1f%%'%(rg*100)
        elif rg>0:    s,p,v='ok',   8,'+%.1f%%'%(rg*100)
        else:         s,p,v='bad',  0, '%.1f%%'%(rg*100)
        sc += p; det.append({'k':'Revenue Growth',     'v':v,'s':s})

    if gm is not None:
        s, p = ('good',15) if gm>.50 else ('ok',8) if gm>.30 else ('ok',3) if gm>0 else ('bad',0)
        sc += p; det.append({'k':'Gross Margin',       'v':'%.1f%%'%(gm*100),'s':s})

    if om is not None:
        s, p = ('good',15) if om>.25 else ('ok',8) if om>.10 else ('ok',3) if om>0 else ('bad',0)
        sc += p; det.append({'k':'Operating Margin',   'v':'%.1f%%'%(om*100),'s':s})

    if fpe and tpe and 0 < fpe < tpe:
        sc += 10
        det.append({'k':'PE Trend','v':'Fwd %.0f < Trail %.0f'%(fpe,tpe),'s':'good'})
    elif fpe and tpe and fpe > 0 and tpe > 0:
        det.append({'k':'PE Ratio','v':'Fwd %.0f / Trail %.0f'%(fpe,tpe),'s':'ok'})

    return min(100, sc), det

# ── News Score (from ticker.info fields only — no extra HTTP call) ─────────
_LAUNCH  = ['launch','launches','unveil','introduces','new product','next-gen','releases']
_PARTNER = ['partnership','partner','deal','contract','agreement','collaboration']
_UPGRADE = ['upgrade','outperform','overweight','price target raised']
_APPROV  = ['fda','approved','approval','clearance']
_MA      = ['acquires','acquisition','merger','takeover']
_EARN_KW = ['earnings','quarterly','revenue','beat','beats','results']
_POS     = ['record','growth','strong','raised','win','breakthrough','profit','beat','launch']
_NEG     = ['miss','misses','decline','loss','lawsuit','fraud','warning','recall',
            'investigation','fine','weak','downgrade']

def _news_score(ticker):
    sc, items, cats = 50, [], []
    try:
        news = ticker.news
        if not isinstance(news, list):
            return sc, items, cats
        for item in news[:10]:
            title = item.get('title','') or ''
            tl    = title.lower()

            if   any(k in tl for k in _LAUNCH):  tag,tc='Product Launch','launch';  cats.append('launch')
            elif any(k in tl for k in _PARTNER):  tag,tc='Partnership',  'partner'; cats.append('partner')
            elif any(k in tl for k in _UPGRADE):  tag,tc='Analyst Upgrade','upgrade'; cats.append('upgrade')
            elif any(k in tl for k in _APPROV):   tag,tc='Regulatory',   'approv';  cats.append('approv')
            elif any(k in tl for k in _MA):        tag,tc='M&A',          'ma';      cats.append('ma')
            elif any(k in tl for k in _EARN_KW):   tag,tc='Earnings',     'earn'
            else:                                  tag,tc='News',         'news'

            sc += sum(5 for k in _POS if k in tl)
            sc -= sum(8 for k in _NEG if k in tl)

            try:
                ts  = item.get('providerPublishTime', 0) or 0
                age = datetime.utcfromtimestamp(ts).strftime('%b %d') if ts else ''
            except Exception:
                age = ''

            items.append({
                'title': title[:88] + ('...' if len(title)>88 else ''),
                'tag': tag, 'tc': tc,
                'url': item.get('link','#') or '#',
                'age': age,
            })
    except Exception:
        pass

    seen, uniq = set(), []
    for c in cats:
        if c not in seen: seen.add(c); uniq.append(c)

    return max(0, min(100, sc)), items[:6], uniq[:4]

# ── Next earnings date ─────────────────────────────────────────────────────
def _next_earn(ticker):
    try:
        ed = ticker.earnings_dates
        if ed is not None and not ed.empty:
            now    = datetime.now(timezone.utc)
            future = ed[ed.index > now]
            if not future.empty:
                return future.index[0].strftime('%b %d, %Y')
    except Exception:
        pass
    return None

# ── Analyze one stock ──────────────────────────────────────────────────────
def analyze_fundamental(symbol):
    ticker, info = _fetch(symbol)
    if ticker is None:
        return None
    try:
        fin_sc, fin_det   = _fin_score(info)
        earn_sc, earn_det = _earn_score(info)
        news_sc, news_items, cats = _news_score(ticker)

        overall          = int(0.40*fin_sc + 0.35*earn_sc + 0.25*news_sc)
        grade, grade_cls = _grade(overall)

        price = (_safe(info.get('currentPrice'))
              or _safe(info.get('regularMarketPrice'))
              or _safe(info.get('previousClose')) or 0)

        return {
            'symbol':        symbol,
            'name':          (info.get('longName') or info.get('shortName') or symbol),
            'sector':        (info.get('sector') or 'Unknown'),
            'industry':      (info.get('industry') or ''),
            'price':         _n(price, 0, 2),
            'market_cap':    _fmt_cap(info.get('marketCap')),
            'pe_ratio':      _n(info.get('trailingPE'),  0, 1),
            'forward_pe':    _n(info.get('forwardPE'),   0, 1),
            'div_yield':     _n(_safe(info.get('dividendYield'), 0) * 100, 0, 2),
            'overall_score': overall,
            'grade':         grade,
            'grade_cls':     grade_cls,
            'fin_score':     fin_sc,
            'earn_score':    earn_sc,
            'news_score':    news_sc,
            'fin_det':       fin_det,
            'earn_det':      earn_det,
            'news_items':    news_items,
            'catalysts':     cats,
            'next_earn':     _next_earn(ticker),
        }
    except Exception as e:
        print('  [err] %s: %s' % (symbol, e))
        return None

# ── Quick connectivity check ───────────────────────────────────────────────
def _yahoo_ok():
    """Fast check using yf.download (different endpoint, rarely rate-limited)."""
    try:
        import yfinance as _yf
        df = _yf.download('AAPL', period='1d', interval='1d',
                          progress=False, auto_adjust=True)
        return not df.empty
    except Exception:
        return False


# ── Run batch ──────────────────────────────────────────────────────────────
def run_research(symbols, max_secs=55):
    """
    Sequential, no retries. Hard deadline = max_secs seconds.
    Returns (results, warning_message).
    """
    symbols  = list(symbols)[:15]
    results  = []
    skipped  = 0
    deadline = time.time() + max_secs

    # Pre-flight: if Yahoo Finance is completely inaccessible, fail fast
    if not _yahoo_ok():
        print('  [research] Yahoo Finance unreachable — rate limited')
        return [], 'rate_limited'

    for i, sym in enumerate(symbols):
        if time.time() >= deadline:
            print('  [deadline] stopping at %d/%d' % (i, len(symbols)))
            break
        print('  [research] %d/%d  %s' % (i+1, len(symbols), sym))
        res = analyze_fundamental(sym)
        if res:
            results.append(res)
        else:
            skipped += 1
        if i < len(symbols) - 1 and time.time() < deadline - 1:
            time.sleep(1.5)

    results.sort(key=lambda x: x['overall_score'], reverse=True)

    if not results and skipped > 0:
        return [], 'rate_limited'
    if skipped > len(results):
        return results, 'partial'
    return results, 'ok'
