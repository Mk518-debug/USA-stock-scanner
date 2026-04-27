# -*- coding: utf-8 -*-
"""
Deep Fundamental Research Engine
Scores companies on: Financial Health, Earnings Quality, News & Catalysts
"""
import yfinance as yf
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

DEFAULT_RESEARCH = [
    'AAPL','MSFT','GOOGL','NVDA','AMZN','META',
    'JPM','V','MA','GS','BAC',
    'JNJ','UNH','LLY','ABBV',
    'XOM','CVX',
    'HD','WMT','COST','MCD',
    'TSLA','AVGO','CRM','ORCL','AMD',
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
    try:
        f = float(v)
        return default if f != f else f   # NaN check
    except Exception:
        return default

# ── Financial Health Score ─────────────────────────────────────────────────
def _score_financial(info):
    score   = 0
    details = []

    de  = _safe(info.get('debtToEquity'))
    cr  = _safe(info.get('currentRatio'))
    roe = _safe(info.get('returnOnEquity'))
    pm  = _safe(info.get('profitMargins'))
    fcf = _safe(info.get('freeCashflow'))
    rg  = _safe(info.get('revenueGrowth'))

    if de is not None:
        if   de < 50:  s, p = 'good', 20
        elif de < 150: s, p = 'ok',   12
        else:          s, p = 'bad',   3
        score += p
        details.append({'k': 'Debt/Equity',   'v': '%.0f%%' % de,       's': s})

    if cr is not None:
        if   cr > 2.0: s, p = 'good', 15
        elif cr > 1.0: s, p = 'ok',    8
        else:          s, p = 'bad',   0
        score += p
        details.append({'k': 'Current Ratio', 'v': '%.2f' % cr,          's': s})

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

    if rg is not None:
        if   rg > 0.15: s, p = 'good', 10; v = '+%.1f%%' % (rg*100)
        elif rg > 0.05: s, p = 'ok',    6; v = '+%.1f%%' % (rg*100)
        elif rg > 0:    s, p = 'ok',    2; v = '+%.1f%%' % (rg*100)
        else:           s, p = 'bad',   0; v =  '%.1f%%' % (rg*100)
        score += p
        details.append({'k': 'Rev Growth',    'v': v,                     's': s})

    return min(100, score), details

# ── Earnings Quality Score ─────────────────────────────────────────────────
def _score_earnings(ticker, info):
    score   = 0
    details = []

    try:
        hist = ticker.earnings_history
        if hist is not None and not hist.empty:
            cols    = {c.lower().replace(' ','').replace('(','').replace(')',''):c for c in hist.columns}
            est_col = next((cols[k] for k in cols if 'estimate' in k), None)
            act_col = next((cols[k] for k in cols if 'actual' in k or 'reported' in k), None)

            if est_col and act_col:
                recent = hist.tail(4)
                beats  = sum(
                    1 for _, r in recent.iterrows()
                    if _safe(r[act_col]) is not None
                    and _safe(r[est_col]) is not None
                    and _safe(r[est_col], 0) != 0
                    and float(r[act_col]) > float(r[est_col])
                )
                if   beats == 4: s, p = 'good', 40; v = '4/4 quarters'
                elif beats == 3: s, p = 'ok',   28; v = '3/4 quarters'
                elif beats >= 2: s, p = 'ok',   16; v = '%d/4 quarters' % beats
                else:            s, p = 'bad',   4; v = '%d/4 quarters' % beats
                score += p
                details.append({'k': 'EPS Beats', 'v': v, 's': s})

                try:
                    last  = hist.tail(1).iloc[0]
                    est_v = _safe(last[est_col])
                    act_v = _safe(last[act_col])
                    if est_v and act_v and est_v != 0:
                        surprise = (act_v - est_v) / abs(est_v) * 100
                        if   surprise > 10: s, p = 'good', 25; v = '+%.1f%%' % surprise
                        elif surprise > 0:  s, p = 'ok',   15; v = '+%.1f%%' % surprise
                        else:               s, p = 'bad',   0; v =  '%.1f%%' % surprise
                        score += p
                        details.append({'k': 'Last EPS Surprise', 'v': v, 's': s})
                except Exception:
                    pass
    except Exception:
        pass

    eg  = _safe(info.get('earningsGrowth'))
    if eg is not None:
        if   eg > 0.20: s, p = 'good', 25; v = '+%.1f%%' % (eg*100)
        elif eg > 0.10: s, p = 'ok',   15; v = '+%.1f%%' % (eg*100)
        elif eg > 0:    s, p = 'ok',    8; v = '+%.1f%%' % (eg*100)
        else:           s, p = 'bad',   0; v =  '%.1f%%' % (eg*100)
        score += p
        details.append({'k': 'EPS Growth (YoY)', 'v': v, 's': s})

    fpe = _safe(info.get('forwardPE'))
    tpe = _safe(info.get('trailingPE'))
    if fpe and tpe and 0 < fpe < tpe:
        score += 10
        details.append({'k': 'PE Trend', 'v': 'Fwd %.0f < Trail %.0f' % (fpe, tpe), 's': 'good'})

    return min(100, score), details

# ── News & Catalyst Score ──────────────────────────────────────────────────
_LAUNCH  = ['launch','launches','unveil','introduces','releases','new product','next-gen']
_PARTNER = ['partnership','partner','deal','contract','agreement','collaboration']
_UPGRADE = ['upgrade','outperform','overweight','price target raised','buy rating']
_APPROV  = ['fda','approved','approval','clearance','authorization']
_MA      = ['acquires','acquisition','merger','takeover']
_EARN    = ['earnings','quarterly','revenue','eps','profit','beat','beats','results']
_POS     = ['record','growth','strong','raised','win','award','breakthrough','profit','beat','launch']
_NEG     = ['miss','misses','decline','loss','lawsuit','fraud','warning','recall','resign','investigation','fine','weak']

# Catalyst label mapping (ASCII only — emojis added in frontend JS)
_CAT_LABELS = {
    'launch':  'Product Launch',
    'partner': 'Partnership / Deal',
    'upgrade': 'Analyst Upgrade',
    'approv':  'Regulatory Approval',
    'ma':      'Acquisition / M&A',
}

def _score_news(ticker):
    score     = 50
    items     = []
    catalysts = []

    try:
        news = ticker.news or []
        for item in (news[:10] if isinstance(news, list) else []):
            title = item.get('title', '')
            tl    = title.lower()

            if any(k in tl for k in _LAUNCH):
                tag, tc = 'Product Launch',   'launch';  catalysts.append('launch')
            elif any(k in tl for k in _PARTNER):
                tag, tc = 'Partnership',       'partner'; catalysts.append('partner')
            elif any(k in tl for k in _UPGRADE):
                tag, tc = 'Analyst Upgrade',   'upgrade'; catalysts.append('upgrade')
            elif any(k in tl for k in _APPROV):
                tag, tc = 'Regulatory',        'approv';  catalysts.append('approv')
            elif any(k in tl for k in _MA):
                tag, tc = 'M&A',               'ma';      catalysts.append('ma')
            elif any(k in tl for k in _EARN):
                tag, tc = 'Earnings',          'earn'
            else:
                tag, tc = 'News',              'news'

            score += sum(5 for k in _POS if k in tl)
            score -= sum(8 for k in _NEG if k in tl)

            try:
                ts  = item.get('providerPublishTime', 0)
                age = datetime.utcfromtimestamp(ts).strftime('%b %d') if ts else ''
            except Exception:
                age = ''

            items.append({
                'title': title[:88] + ('...' if len(title) > 88 else ''),
                'tag':   tag,
                'tc':    tc,
                'url':   item.get('link', '#'),
                'age':   age,
            })
    except Exception:
        pass

    seen, uniq = set(), []
    for c in catalysts:
        if c not in seen:
            seen.add(c)
            uniq.append(c)

    return max(0, min(100, score)), items[:6], uniq[:4]

# ── Main analyzer ──────────────────────────────────────────────────────────
def analyze_fundamental(symbol):
    try:
        ticker = yf.Ticker(symbol)
        info   = ticker.info or {}

        price = (_safe(info.get('currentPrice'))
              or _safe(info.get('regularMarketPrice'))
              or _safe(info.get('previousClose'))
              or 0)
        if not price:
            return None

        fin_score,  fin_det   = _score_financial(info)
        earn_score, earn_det  = _score_earnings(ticker, info)
        news_score, news_items, catalysts = _score_news(ticker)

        overall          = int(0.40 * fin_score + 0.35 * earn_score + 0.25 * news_score)
        grade, grade_cls = _grade(overall)

        next_earn = None
        try:
            ed = ticker.earnings_dates
            if ed is not None and not ed.empty:
                now    = datetime.now(timezone.utc)
                future = ed[ed.index > now]
                if not future.empty:
                    next_earn = future.index[0].strftime('%b %d, %Y')
        except Exception:
            pass

        return {
            'symbol':       symbol,
            'name':         info.get('longName') or info.get('shortName') or symbol,
            'sector':       info.get('sector', 'Unknown'),
            'industry':     info.get('industry', ''),
            'price':        round(float(price), 2),
            'market_cap':   _fmt_cap(info.get('marketCap')),
            'pe_ratio':     round(float(info.get('trailingPE') or 0), 1),
            'forward_pe':   round(float(info.get('forwardPE')  or 0), 1),
            'div_yield':    round(float(info.get('dividendYield') or 0) * 100, 2),
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
            'next_earn':     next_earn,
        }
    except Exception as e:
        print('  [research] %s: %s' % (symbol, e))
        return None


def run_research(symbols, max_workers=5):
    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(analyze_fundamental, sym): sym for sym in symbols}
        for fut in as_completed(futures):
            res = fut.result()
            if res:
                results.append(res)
    results.sort(key=lambda x: x['overall_score'], reverse=True)
    return results
