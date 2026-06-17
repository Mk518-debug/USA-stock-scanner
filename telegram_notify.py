"""
Telegram notification module for Volume Surge alerts.
Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from environment.
Silently disabled when env vars are not set.
"""
import os
import time
import requests
from datetime import datetime, timezone, timedelta

_TOKEN   = os.environ.get('TELEGRAM_BOT_TOKEN', '')
_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID',   '')
_API     = 'https://api.telegram.org/bot{token}/{method}'

# ── Deduplication: track symbols notified in the last 6 hours ────────────────
_notified: dict = {}   # symbol → timestamp
_DEDUP_TTL = 6 * 3600  # 6 hours


def enabled() -> bool:
    return bool(_TOKEN and _CHAT_ID)


def _cleanup_dedup():
    now = time.time()
    expired = [s for s, ts in _notified.items() if now - ts > _DEDUP_TTL]
    for s in expired:
        del _notified[s]


def _is_new(symbol: str) -> bool:
    """Return True if this symbol hasn't been notified in the last 6 hours."""
    ts = _notified.get(symbol)
    return ts is None or time.time() - ts > _DEDUP_TTL


def _mark_notified(symbol: str):
    _notified[symbol] = time.time()


def send_message(text: str, parse_mode: str = 'HTML') -> bool:
    """Send a plain message. Returns True on success."""
    if not enabled():
        return False
    try:
        url  = _API.format(token=_TOKEN, method='sendMessage')
        resp = requests.post(url, json={
            'chat_id':    _CHAT_ID,
            'text':       text,
            'parse_mode': parse_mode,
            'disable_web_page_preview': True,
        }, timeout=10)
        return resp.status_code == 200
    except Exception as e:
        print(f'[telegram] send_message error: {e}')
        return False


def _tier_emoji(tier: str) -> str:
    return {'extreme': '🔴', 'very-high': '🟠', 'high': '🟡', 'elevated': '🟢'}.get(tier, '⚪')


def _signal_emoji(signal_cls: str) -> str:
    return {
        'breakout':     '🚀',
        'accumulation': '📈',
        'momentum':     '⚡',
        'coiling':      '🔄',
        'capitulation': '⚠️',
        'distribution': '📉',
        'surge-up':     '⬆️',
        'surge-down':   '⬇️',
    }.get(signal_cls, '📊')


def send_surge_alert(results: list, label: str = ''):
    """
    Send a Telegram alert for new Volume Surge stocks.
    Filters: only extreme (10×+) and very-high (5-10×) tiers, or Breakout/Momentum signals.
    Deduplicates: skips symbols already notified in the last 6 hours.
    """
    if not enabled() or not results:
        return

    _cleanup_dedup()

    # Filter: high-conviction only
    filtered = [
        r for r in results
        if r.get('vol_tier') in ('extreme', 'very-high')
        or r.get('signal_cls') in ('breakout', 'momentum', 'accumulation')
    ]

    # Remove already-notified
    new_picks = [r for r in filtered if _is_new(r['symbol'])]
    if not new_picks:
        print(f'[telegram] surge alert: all {len(filtered)} picks already notified, skipping')
        return

    # ── Format message ────────────────────────────────────────────────────────
    ny_now = datetime.now(timezone(timedelta(hours=-5)))   # ET approx (no DST)
    header = f'<b>⚡ Vol Surge Alert</b> — {label or ny_now.strftime("%I:%M %p ET")}\n'

    lines = []
    for r in new_picks[:10]:   # cap at 10 per message
        tier_e   = _tier_emoji(r.get('vol_tier', ''))
        sig_e    = _signal_emoji(r.get('signal_cls', ''))
        chg_sign = '+' if r.get('change_pct', 0) >= 0 else ''
        ema_tag  = '✓EMA20' if r.get('above_e20') else '✗EMA20'

        lines.append(
            f'{tier_e} <b>{r["symbol"]}</b> ({chg_sign}{r.get("change_pct", 0):.1f}%) — '
            f'{sig_e} {r.get("signal", "")}\n'
            f'   📊 {r.get("rel_vol", 0):.1f}× Vol | RSI {r.get("rsi", 0):.0f} | '
            f'${r.get("price", 0):.2f} | {ema_tag}\n'
            f'   <a href="https://www.tradingview.com/chart/?symbol={r.get("tv_symbol", r["symbol"])}">📈 Chart</a>'
        )
        _mark_notified(r['symbol'])

    footer = f'\n<i>{len(new_picks)} new · {len(filtered)} total high-conviction</i>'
    text   = header + '\n' + '\n\n'.join(lines) + footer

    ok = send_message(text)
    print(f'[telegram] surge alert sent: {ok} — {len(new_picks)} stocks')
