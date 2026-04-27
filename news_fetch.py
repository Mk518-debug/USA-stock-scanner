# -*- coding: utf-8 -*-
"""
News fetcher — uses ticker.news (lightweight, rarely rate-limited).
Returns news items categorised and sorted newest-first.
"""
import yfinance as yf
import requests
from datetime import datetime, timezone

_SESSION = requests.Session()
_SESSION.headers.update({
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/124.0.0.0 Safari/537.36'
    ),
})

_CATS = [
    (['launch','launches','unveil','introduces','new product','next-gen','releases'],
     'Product Launch', 'launch'),
    (['earnings','quarterly','revenue','eps','profit','beat','beats','results','q1','q2','q3','q4'],
     'Earnings', 'earn'),
    (['upgrade','outperform','overweight','price target raised','buy rating','bullish'],
     'Analyst Upgrade', 'upgrade'),
    (['partnership','deal','contract','agreement','collaboration','signs'],
     'Partnership', 'deal'),
    (['fda','approved','approval','clearance','authorization'],
     'Regulatory', 'approv'),
    (['acquires','acquisition','merger','takeover','buys '],
     'M&A', 'ma'),
    (['dividend','buyback','repurchase'],
     'Dividend/Buyback', 'div'),
]

_NEG = ['lawsuit','fraud','warning','recall','resign','investigation','fine','penalty','miss','misses']


def _cat(title):
    tl = title.lower()
    for kws, label, cls in _CATS:
        if any(k in tl for k in kws):
            return label, cls
    return 'News', 'news'


def _time_ago(ts):
    try:
        if not ts:
            return ''
        delta = int(datetime.now(timezone.utc).timestamp()) - int(ts)
        if delta < 0:
            return 'just now'
        if delta < 3600:
            return '%dm ago' % max(1, delta // 60)
        if delta < 86400:
            return '%dh ago' % (delta // 3600)
        if delta < 604800:
            return '%dd ago' % (delta // 86400)
        return datetime.utcfromtimestamp(ts).strftime('%b %d')
    except Exception:
        return ''


def _sentiment(title):
    tl = title.lower()
    neg = sum(1 for k in _NEG if k in tl)
    pos = sum(1 for k in ['record','growth','beat','beats','raised','profit','strong','win','upgrade','launch'] if k in tl)
    if neg > pos: return 'neg'
    if pos > neg: return 'pos'
    return 'neu'


def fetch_news(symbols, max_per_symbol=6):
    """
    Fetch recent news for each symbol.
    Returns list sorted newest-first.
    """
    news_list = []
    seen_titles = set()

    for sym in symbols[:20]:
        try:
            ticker = yf.Ticker(sym, session=_SESSION)
            raw    = ticker.news
            if not isinstance(raw, list):
                continue
            for item in raw[:max_per_symbol]:
                title = (item.get('title') or '').strip()
                if not title or title in seen_titles:
                    continue
                seen_titles.add(title)

                cat, cat_cls = _cat(title)
                ts = int(item.get('providerPublishTime') or 0)

                # Thumbnail (first resolution if available)
                thumb = ''
                try:
                    resolutions = (item.get('thumbnail') or {}).get('resolutions', [])
                    if resolutions:
                        thumb = resolutions[0].get('url', '')
                except Exception:
                    pass

                news_list.append({
                    'symbol':    sym,
                    'title':     title,
                    'url':       item.get('link') or '#',
                    'source':    item.get('publisher') or '',
                    'time_raw':  ts,
                    'time_str':  _time_ago(ts),
                    'cat':       cat,
                    'cat_cls':   cat_cls,
                    'sentiment': _sentiment(title),
                    'thumb':     thumb,
                })
        except Exception as e:
            print('  [news] %s: %s' % (sym, str(e)[:80]))

    news_list.sort(key=lambda x: x['time_raw'], reverse=True)
    return news_list
