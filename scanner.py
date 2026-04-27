import time
import yfinance as yf
import pandas as pd
import numpy as np
from concurrent.futures import ThreadPoolExecutor, as_completed


def _rsi(prices, period=14):
    delta = prices.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _macd(prices, fast=12, slow=26, signal=9):
    ema_fast = prices.ewm(span=fast, adjust=False).mean()
    ema_slow = prices.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line, macd_line - signal_line


def _ema(prices, period):
    return prices.ewm(span=period, adjust=False).mean()


def _atr(high, low, close, period=14):
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low - close.shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(com=period - 1, min_periods=period).mean()


_INTERVAL_PARAMS = {
    '1d':  {'period': '1y',  'interval': '1d'},
    '4h':  {'period': '60d', 'interval': '1h'},
    '1h':  {'period': '60d', 'interval': '1h'},
    '15m': {'period': '30d', 'interval': '15m'},
}


def _fetch(symbol, timeframe):
    p = _INTERVAL_PARAMS.get(timeframe, _INTERVAL_PARAMS['1d'])
    df = yf.download(
        symbol,
        period=p['period'],
        interval=p['interval'],
        progress=False,
        auto_adjust=True,
        actions=False,
    )
    if df.empty:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    if timeframe == '4h':
        df = df.resample('4h').agg({
            'Open': 'first', 'High': 'max',
            'Low': 'min', 'Close': 'last', 'Volume': 'sum',
        }).dropna()
    return df


def _fetch_with_retry(symbol, timeframe, retries=2):
    for attempt in range(retries):
        try:
            df = _fetch(symbol, timeframe)
            if df is not None and len(df) > 0:
                return df
        except Exception:
            if attempt < retries - 1:
                time.sleep(0.5)
    return None


def _fmt_candle_date(ts, timeframe):
    try:
        if timeframe == '1d':
            return pd.Timestamp(ts).strftime('%b %d, %Y')
        return pd.Timestamp(ts).strftime('%b %d, %Y %H:%M')
    except Exception:
        return str(ts)


def analyze(symbol, timeframe='1d'):
    try:
        df = _fetch_with_retry(symbol, timeframe)
        if df is None or len(df) < 30:
            return None

        close = df['Close'].squeeze()
        high  = df['High'].squeeze()
        low   = df['Low'].squeeze()
        vol   = df['Volume'].squeeze()

        last_candle = _fmt_candle_date(df.index[-1], timeframe)

        rsi_s               = _rsi(close)
        macd_l, sig_l, hist = _macd(close)
        ema20               = _ema(close, 20)
        ema50               = _ema(close, 50)
        ema200              = _ema(close, 200) if len(df) >= 200 else None
        vol_ma              = vol.rolling(20).mean()
        atr_s               = _atr(high, low, close)

        c    = float(close.iloc[-1])
        r    = float(rsi_s.iloc[-1])
        ml   = float(macd_l.iloc[-1])
        sl   = float(sig_l.iloc[-1])
        h0   = float(hist.iloc[-1])
        h1   = float(hist.iloc[-2]) if len(hist) > 1 else 0.0
        e20  = float(ema20.iloc[-1])
        e50  = float(ema50.iloc[-1])
        e200 = float(ema200.iloc[-1]) if ema200 is not None else None
        v    = float(vol.iloc[-1])
        vma  = float(vol_ma.iloc[-1])
        atr  = float(atr_s.iloc[-1])

        # ── EMA trend score (0-100) ──────────────────────────────────────────
        if e200 is not None:
            if   c > e20 > e50 > e200: ema_sc = 92
            elif c > e20 > e50:        ema_sc = 72
            elif c > e20 and e20 > e50 and e50 < e200: ema_sc = 62
            elif c > e20:              ema_sc = 55
            elif c < e20 < e50 < e200: ema_sc = 8
            elif c < e20 < e50:        ema_sc = 28
            elif c < e20:              ema_sc = 45
            else:                      ema_sc = 50
        else:
            if   c > e20 > e50: ema_sc = 75
            elif c > e20:       ema_sc = 58
            elif c < e20 < e50: ema_sc = 25
            elif c < e20:       ema_sc = 42
            else:               ema_sc = 50

        # ── MACD score (0-100) ───────────────────────────────────────────────
        if ml > sl:
            macd_sc = 82 if (h0 > 0 and h0 > h1) else 68 if h0 > 0 else 58
        else:
            macd_sc = 18 if (h0 < 0 and h0 < h1) else 32 if h0 < 0 else 42

        # ── RSI score (0-100) ────────────────────────────────────────────────
        if   r >= 80: rsi_sc = 55
        elif r >= 70: rsi_sc = 78
        elif r >= 60: rsi_sc = 85
        elif r >= 50: rsi_sc = 65
        elif r >= 40: rsi_sc = 35
        elif r >= 30: rsi_sc = 22
        else:         rsi_sc = 10

        # ── Volume score (0-100) ─────────────────────────────────────────────
        vr = v / vma if vma > 0 else 1.0
        if   vr >= 2.0: vol_sc = 90
        elif vr >= 1.5: vol_sc = 75
        elif vr >= 1.0: vol_sc = 55
        elif vr >= 0.7: vol_sc = 38
        else:           vol_sc = 20

        composite = 0.35 * ema_sc + 0.30 * macd_sc + 0.25 * rsi_sc + 0.10 * vol_sc

        if composite > 55:
            direction = 'Bullish'
        elif composite < 45:
            direction = 'Bearish'
        else:
            direction = 'Neutral'

        strength = min(100, int(abs(composite - 50) * 3))
        if direction == 'Neutral':
            strength = min(strength, 25)

        if direction == 'Bullish':
            target = round(c + 2.0 * atr, 2)
            stop   = round(c - 1.0 * atr, 2)
        else:
            target = round(c - 2.0 * atr, 2)
            stop   = round(c + 1.0 * atr, 2)

        return {
            'symbol':      symbol,
            'score':       strength,
            'direction':   direction,
            'composite':   round(composite, 1),
            'price':       round(c, 2),
            'rsi':         round(r, 1),
            'macd':        round(ml, 4),
            'macd_signal': round(sl, 4),
            'ema20':       round(e20, 2),
            'ema50':       round(e50, 2),
            'ema200':      round(e200, 2) if e200 else None,
            'volume':      int(v),
            'vol_ratio':   round(vr, 2),
            'atr':         round(atr, 2),
            'entry':       round(c, 2),
            'target':      target,
            'stop':        stop,
            'rr':          2.0,
            'ema_score':   round(ema_sc, 1),
            'macd_score':  round(macd_sc, 1),
            'rsi_score':   round(rsi_sc, 1),
            'vol_score':   round(vol_sc, 1),
            'last_candle': last_candle,
        }
    except Exception as e:
        print(f"  [!] {symbol}: {e}")
        return None


def run_scan(symbols, timeframe='1d', min_score=40, max_workers=12):
    results = []
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        futures = {ex.submit(analyze, sym, timeframe): sym for sym in symbols}
        for fut in as_completed(futures):
            res = fut.result()
            if res and res['score'] >= min_score:
                results.append(res)
    results.sort(key=lambda x: x['score'], reverse=True)
    return results
