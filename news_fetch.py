# -*- coding: utf-8 -*-
"""
News fetcher using yfinance ticker.news.
Handles both the NEW format (yfinance 0.2.40+) where news is nested under
item['content'], and the OLD format where fields were at the top level.
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
     'Dividend', 'div'),
]
_NEG = ['lawsuit','fraud','warning','recall','resign','investigation','fine','miss','misses','decline']
_POS = ['beat','record','growth','raised','profit','strong','win','upgrade','launch','approved']


def _cat(title):
    tl = title.lower()
    for kws, label, cls in _CATS:
        if any(k in tl for k in kws):
            return label, cls
    return 'News', 'news'


def _sentiment(title):
    tl = title.lower()
    neg = sum(1 for k in _NEG if k in tl)
    pos = sum(1 for k in _POS if k in tl)
    if neg > pos: return 'neg'
    if pos > neg: return 'pos'
    return 'neu'


def _parse_pubdate(s):
    """Convert ISO date string '2026-04-27T15:36:47Z' → Unix timestamp int."""
    if not s:
        return 0
    try:
        return int(datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ')
                   .replace(tzinfo=timezone.utc).timestamp())
    except Exception:
        return 0


def _time_ago(ts):
    try:
        if not ts:
            return ''
        delta = int(datetime.now(timezone.utc).timestamp()) - int(ts)
        if delta < 0:    return 'just now'
        if delta < 3600: return '%dm ago' % max(1, delta // 60)
        if delta < 86400:return '%dh ago' % (delta // 3600)
        if delta < 604800:return '%dd ago' % (delta // 86400)
        return datetime.utcfromtimestamp(ts).strftime('%b %d')
    except Exception:
        return ''


def _parse_item(item):
    """
    Parse one news item from yfinance, handling both formats:
      NEW (0.2.40+): item = {'id': ..., 'content': {...}}
      OLD           : item = {'title': ..., 'link': ..., 'publisher': ..., ...}
    Returns (title, url, source, ts, thumb) or None if item is invalid.
    """
    # ── NEW format ─────────────────────────────────────────────────────────
    if 'content' in item:
        c = item['content'] or {}
        title = (c.get('title') or '').strip()
        if not title:
            return None
        url = ((c.get('clickThroughUrl') or c.get('canonicalUrl') or {})
               .get('url') or '#')
        source = ((c.get('provider') or {}).get('displayName') or '')
        ts     = _parse_pubdate(c.get('pubDate') or c.get('displayTime'))
        thumb  = ((c.get('thumbnail') or {}).get('originalUrl') or '')
        # Fallback to first resolution if originalUrl missing
        if not thumb:
            try:
                resolutions = (c.get('thumbnail') or {}).get('resolutions', [])
                if resolutions:
                    thumb = resolutions[0].get('url', '')
            except Exception:
                pass
        return title, url, source, ts, thumb

    # ── OLD format ─────────────────────────────────────────────────────────
    title = (item.get('title') or '').strip()
    if not title:
        return None
    url    = item.get('link') or '#'
    source = item.get('publisher') or ''
    ts     = int(item.get('providerPublishTime') or 0)
    thumb  = ''
    try:
        resolutions = (item.get('thumbnail') or {}).get('resolutions', [])
        if resolutions:
            thumb = resolutions[0].get('url', '')
    except Exception:
        pass
    return title, url, source, ts, thumb


def fetch_news(symbols, max_per_symbol=6):
    """Fetch and categorise recent news for each symbol. Returns list newest-first."""
    news_list   = []
    seen_titles = set()

    for sym in symbols[:20]:
        try:
            ticker = yf.Ticker(sym, session=_SESSION)
            raw    = ticker.news
            if not isinstance(raw, list):
                continue

            for item in raw[:max_per_symbol]:
                parsed = _parse_item(item)
                if parsed is None:
                    continue
                title, url, source, ts, thumb = parsed

                if title in seen_titles:
                    continue
                seen_titles.add(title)

                cat, cat_cls = _cat(title)
                news_list.append({
                    'symbol':    sym,
                    'title':     title,
                    'url':       url,
                    'source':    source,
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
