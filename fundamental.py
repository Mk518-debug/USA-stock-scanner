# -*- coding: utf-8 -*-
"""
Deep Fundamental Research Engine
One HTTP call per stock (ticker.info only) to avoid Yahoo Finance rate limits.
Sequential processing with retry backoff.
"""
import time
import yfinance as yf
from datetime import datetime, timezone

# Default list kept at 10 so the initial research finishes in ~30-40 seconds.
# Users can add more symbols manually — each extra stock adds ~3 seconds.
DEFAULT_RESEARCH = [
    'AAPL','MSFT','NVDA','GOOGL','AMZN',
    'JPM','V','JNJ','HD','TSLA',
]

# ── Helpers ────────────────────────────────────────────────────────────────
def _grade(s):
    if s >= 85: return 'A+', 'g-aplus'
    if s >= 75: return 'A',  'g-a'
    if s >= 65: return 'B+', 'g-bplus'
    if s >= 55: return 'B',  'g-b'
    if s >= 40: return 'C',  'g-c'
    return 'D', 'g-d'

def _fmt_cap(mc):
    if not mc: return 'N/A'
    if mc >= 1e12: return '$%.2fT' % (mc / 1e12)
    if mc >= 1e9:  return '$%.1fB' % (mc / 1e9)
    return '$%.0fM' % (mc / 1e6)

def _safe(v, default=None):
    """Return float(v), converting NaN/inf/None to default."""
    try:
        f = float(v)
        if f != f or f == float('inf') or f == float('-inf'):
            return default
        return f
    except Exception:
        return default

def _n(v, default=0, decimals=2):
    """JSON-safe rounded number: NaN/None/inf → default."""
    return round(_safe(v, default), decimals)

import requests as _requests

_SESSION = _requests.Session()
_SESSION.headers.update({
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
})


def _fetch_info(symbol, max_retries=2):
    """Fetch ticker.info with retry on rate-limit. Max 2 retries (≤30 s extra per stock)."""
    waits = [10, 20]
    for attempt in range(max_retries + 1):
        try:
            ticker = yf.Ticker(symbol, session=_SESSION)
            info   = ticker.info or {}
            price  = (_safe(info.get('currentPrice'))
                   or _safe(info.get('regularMarketPrice'))
                   or _safe(info.get('previousClose')))
            if price:
                return ticker, info
            return None, None
        except Exception as e:
            msg = str(e).lower()
            if ('rate' in msg or 'too many' in msg or '429' in msg) and attempt < max_retries:
                wait = waits[attempt]
                print('  [rate limit] %s — retry in %ds (%d/%d)'
                      % (symbol, wait, attempt + 1, max_retries))
                time.sleep(wait)
            else:
                print('  [skip] %s: %s' % (symbol, e))
                return None, None
    return None, None

# ── Financial Health Score ─────────────────────────────────────────────────
def _score_financial(info):
    score, details = 0, []

    de  = _safe(info.get('debtToEquity'))
    cr  = _safe(info.get('currentRatio'))
    roe = _safe(info.get('returnOnEquity'))
    pm  = _safe(info.get('profitMargins'))
    fcf = _safe(info.get('freeCashflow'))
    qr  = _safe(info.get('quickRatio'))

    if de is not None:
        if   de < 50:  s, p = 'good', 20
        elif de < 150: s, p = 'ok',   12
        else:          s, p = 'bad',   3
        score += p
        details.append({'k': 'Debt/Equity',   'v': '%.0f%%' % de,        's': s})

    if cr is not None:
        if   cr > 2.0: s, p = 'good', 15
        elif cr > 1.0: s, p = 'ok',    8
        else:          s, p = 'bad',   0
        score += p
        details.append({'k': 'Current Ratio', 'v': '%.2f'  % cr,         's': s})

    if roe is not None:
        if   roe > 0.25: s, p = 'good', 20
        elif roe > 0.12: s, p = 'ok',   12
        elif roe > 0:    s, p = 'ok',    5
        else:            s, p = 'bad',   0
        score += p
        details.append({'k': 'ROE',           'v': '%.1f%%' % (roe*100), 's': s})

    if pm is not None:
        if   pm > 0.20: s, p = 'good', 20
        elif pm > 0.10: s, p = 'ok',   13
        elif pm > 0:    s, p = 'ok',    5
        else:           s, p = 'bad',   0
        score += p
        details.append({'k': 'Net Margin',    'v': '%.1f%%' % (pm*100),  's': s})

    if fcf is not None:
        if   fcf >= 1e9: s, p = 'good', 15; v = '+$%.1fB' % (fcf/1e9)
        elif fcf > 0:    s, p = 'ok',    8; v = '+$%.0fM' % (fcf/1e6)
        else:            s, p = 'bad',   0; v = '-$%.0fM' % (abs(fcf)/1e6)
        score += p
        details.append({'k': 'Free Cash Flow','v': v,                     's': s})

    if qr is not None:
        if   qr > 1.5: s, p = 'good', 10
        elif qr > 1.0: s, p = 'ok',    5
        else:          s, p = 'bad',   0
        score += p
        details.append({'k': 'Quick Ratio',   'v': '%.2f' % qr,          's': s})

    return min(100, score), details

# ── Earnings Quality Score (info-only, no extra HTTP call) ─────────────────
def _score_earnings(info):
    score, details = 0, []

    eg  = _safe(info.get('earningsGrowth'))
    rg  = _safe(info.get('revenueGrowth'))
    gm  = _safe(info.get('grossMargins'))
    om  = _safe(info.get('operatingMargins'))
    fpe = _safe(info.get('forwardPE'))
    tpe = _safe(info.get('trailingPE'))

    if eg is not None:
        if   eg > 0.25: s, p = 'good', 35; v = '+%.1f%%' % (eg*100)
        elif eg > 0.15: s, p = 'ok',   25; v = '+%.1f%%' % (eg*100)
        elif eg > 0.05: s, p = 'ok',   15; v = '+%.1f%%' % (eg*100)
        elif eg > 0:    s, p = 'ok',    8; v = '+%.1f%%' % (eg*100)
        else:           s, p = 'bad',   0; v =  '%.1f%%' % (eg*100)
        score += p
        details.append({'k': 'EPS Growth (YoY)',  'v': v, 's': s})

    if rg is not None:
        if   rg > 0.20: s, p = 'good', 25; v = '+%.1f%%' % (rg*100)
        elif rg > 0.10: s, p = 'ok',   15; v = '+%.1f%%' % (rg*100)
        elif rg > 0:    s, p = 'ok',    8; v = '+%.1f%%' % (rg*100)
        else:           s, p = 'bad',   0; v =  '%.1f%%' % (rg*100)
        score += p
        details.append({'k': 'Revenue Growth',    'v': v, 's': s})

    if gm is not None:
        if   gm > 0.50: s, p = 'good', 15
        elif gm > 0.30: s, p = 'ok',    8
        elif gm > 0:    s, p = 'ok',    3
        else:           s, p = 'bad',   0
        score += p
        details.append({'k': 'Gross Margin',      'v': '%.1f%%' % (gm*100), 's': s})

    if om is not None:
        if   om > 0.25: s, p = 'good', 15
        elif om > 0.10: s, p = 'ok',    8
        elif om > 0:    s, p = 'ok',    3
        else:           s, p = 'bad',   0
        score += p
        details.append({'k': 'Operating Margin',  'v': '%.1f%%' % (om*100), 's': s})

    if fpe and tpe and fpe > 0 and tpe > 0:
        if fpe < tpe:
            score += 10
            details.append({'k': 'PE Trend', 'v': 'Fwd %.0f < Trail %.0f' % (fpe, tpe), 's': 'good'})
        else:
            details.append({'k': 'PE Ratio', 'v': 'Fwd %.0f / Trail %.0f' % (fpe, tpe), 's': 'ok'})

    return min(100, score), details

# ── News & Catalyst Score ──────────────────────────────────────────────────
_LAUNCH  = ['launch','launches','unveil','introduces','releases','new product','next-gen']
_PARTNER = ['partnership','partner','deal','contract','agreement','collaboration']
_UPGRADE = ['upgrade','outperform','overweight','price target raised','buy rating']
_APPROV  = ['fda','approved','approval','clearance','authorization']
_MA      = ['acquires','acquisition','merger','takeover']
_EARN    = ['earnings','quarterly','revenue','eps','profit','beat','beats','results']
_POS     = ['record','growth','strong','raised','win','award','breakthrough','profit','beat','launch']
_NEG     = ['miss','misses','decline','loss','lawsuit','fraud','warning','recall','resign',
            'investigation','fine','weak','downgrade']

def _score_news(ticker):
    score, items, catalysts = 50, [], []
    try:
        news = ticker.news or []
        for item in (news[:10] if isinstance(news, list) else []):
            title = item.get('title', '')
            tl    = title.lower()

            if   any(k in tl for k in _LAUNCH):  tag, tc = 'Product Launch',  'launch';  catalysts.append('launch')
            elif any(k in tl for k in _PARTNER):  tag, tc = 'Partnership',     'partner'; catalysts.append('partner')
            elif any(k in tl for k in _UPGRADE):  tag, tc = 'Analyst Upgrade', 'upgrade'; catalysts.append('upgrade')
            elif any(k in tl for k in _APPROV):   tag, tc = 'Regulatory',      'approv';  catalysts.append('approv')
            elif any(k in tl for k in _MA):        tag, tc = 'M&A',             'ma';      catalysts.append('ma')
            elif any(k in tl for k in _EARN):      tag, tc = 'Earnings',        'earn'
            else:                                  tag, tc = 'News',            'news'

            score += sum(5 for k in _POS if k in tl)
            score -= sum(8 for k in _NEG if k in tl)

            try:
                ts  = item.get('providerPublishTime', 0)
                age = datetime.utcfromtimestamp(ts).strftime('%b %d') if ts else ''
            except Exception:
                age = ''

            items.append({
                'title': title[:88] + ('...' if len(title) > 88 else ''),
                'tag': tag, 'tc': tc,
                'url': item.get('link', '#'),
                'age': age,
            })
    except Exception:
        pass

    seen, uniq = set(), []
    for c in catalysts:
        if c not in seen: seen.add(c); uniq.append(c)

    return max(0, min(100, score)), items[:6], uniq[:4]

# ── Next earnings date ─────────────────────────────────────────────────────
def _next_earnings(ticker):
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

# ── Main analyzer ──────────────────────────────────────────────────────────
def analyze_fundamental(symbol):
    ticker, info = _fetch_info(symbol)
    if ticker is None or info is None:
        return None

    try:
        fin_score,  fin_det  = _score_financial(info)
        earn_score, earn_det = _score_earnings(info)
        news_score, news_items, catalysts = _score_news(ticker)

        overall          = int(0.40 * fin_score + 0.35 * earn_score + 0.25 * news_score)
        grade, grade_cls = _grade(overall)

        price = (_safe(info.get('currentPrice'))
              or _safe(info.get('regularMarketPrice'))
              or _safe(info.get('previousClose'))
              or 0)

        return {
            'symbol':        symbol,
            'name':          info.get('longName') or info.get('shortName') or symbol,
            'sector':        info.get('sector', 'Unknown'),
            'industry':      info.get('industry', ''),
            'price':         _n(price, 0, 2),
            'market_cap':    _fmt_cap(_safe(info.get('marketCap'))),
            'pe_ratio':      _n(info.get('trailingPE'),   0, 1),
            'forward_pe':    _n(info.get('forwardPE'),    0, 1),
            'div_yield':     _n((_safe(info.get('dividendYield'), 0)) * 100, 0, 2),
            'overall_score': overall,
            'grade':         grade,
            'grade_cls':     grade_cls,
            'fin_score':     fin_score,
            'earn_score':    earn_score,
            'news_score':    news_score,
            'fin_det':       fin_det,
            'earn_det':      earn_det,
            'news_items':    news_items,
            'catalysts':     catalysts,
            'next_earn':     _next_earnings(ticker),
        }
    except Exception as e:
        print('  [research] %s: %s' % (symbol, e))
        return None


def run_research(symbols):
    """Sequential with 2 s gaps. Max 15 symbols to stay within server timeout."""
    symbols = symbols[:15]
    results = []
    total   = len(symbols)
    for i, sym in enumerate(symbols):
        print('  [research] %d/%d  %s' % (i + 1, total, sym))
        res = analyze_fundamental(sym)
        if res:
            results.append(res)
        if i < total - 1:
            time.sleep(2)
    results.sort(key=lambda x: x['overall_score'], reverse=True)
    return results
