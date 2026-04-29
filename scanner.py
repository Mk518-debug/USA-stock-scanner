import math
import time
import yfinance as yf
import pandas as pd
import numpy as np
from concurrent.futures import ThreadPoolExecutor, as_completed

from core_regime import market_regime_score

# ── Per-timeframe composite weights ──────────────────────────────────────────
_WEIGHTS = {
    '1d':  {'ema': 0.30, 'macd': 0.20, 'rsi': 0.15, 'vol': 0.10, 'regime': 0.10, 'st': 0.15},
    '4h':  {'ema': 0.25, 'macd': 0.25, 'rsi': 0.20, 'vol': 0.10, 'regime': 0.05, 'st': 0.15},
    '1h':  {'ema': 0.20, 'macd': 0.25, 'rsi': 0.20, 'vol': 0.15, 'regime': 0.05, 'st': 0.15},
    '15m': {'ema': 0.15, 'macd': 0.25, 'rsi': 0.20, 'vol': 0.20, 'regime': 0.05, 'st': 0.15},
}

# ── SPY relative-strength cache ───────────────────────────────────────────────
_SPY_CACHE = {'ts': 0.0, 'ret20': 0.0}


def _spy_return_20d():
    if time.time() - _SPY_CACHE['ts'] < 900:
        return _SPY_CACHE['ret20']
    try:
        spy = yf.download('SPY', period='30d', interval='1d',
                          progress=False, auto_adjust=True, actions=False)
        close = spy['Close'].squeeze()
        if len(close) >= 21:
            ret = float((close.iloc[-1] - close.iloc[-21]) / close.iloc[-21])
            _SPY_CACHE.update({'ts': time.time(), 'ret20': ret})
            return ret
    except Exception:
        pass
    return 0.0


# ── Indicator functions ───────────────────────────────────────────────────────

def _rsi(prices, period=14):
    delta = prices.diff()
    gain  = delta.clip(lower=0)
    loss  = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _macd(prices, fast=12, slow=26, signal=9):
    ema_fast    = prices.ewm(span=fast,   adjust=False).mean()
    ema_slow    = prices.ewm(span=slow,   adjust=False).mean()
    macd_line   = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line, macd_line - signal_line


def _ema(prices, period):
    return prices.ewm(span=period, adjust=False).mean()


def _atr(high, low, close, period=14):
    tr = pd.concat([
        high - low,
        (high - close.shift(1)).abs(),
        (low  - close.shift(1)).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(com=period - 1, min_periods=period).mean()


def _bollinger(close, period=20, std_dev=2.0):
    """Returns (upper, middle, lower, squeeze_pct).
    squeeze_pct: 0=open bands, 100=max squeeze seen in last 100 bars."""
    mid   = close.rolling(period).mean()
    std   = close.rolling(period).std()
    upper = mid + std_dev * std
    lower = mid - std_dev * std
    width = (upper - lower) / mid.replace(0, np.nan) * 100

    # Squeeze percentile: how narrow are bands vs recent history?
    cur_w = float(width.iloc[-1] or 0)
    hist  = width.dropna().iloc[-100:]
    if len(hist) > 10:
        squeeze_pct = int((1.0 - float((hist < cur_w).mean())) * 100)
    else:
        squeeze_pct = 0

    return (float(upper.iloc[-1] or 0),
            float(mid.iloc[-1]   or 0),
            float(lower.iloc[-1] or 0),
            squeeze_pct)


def _supertrend(high, low, close, period=10, multiplier=3.0):
    """Returns (st_value, direction) where direction 1=bull, -1=bear."""
    atr_s     = _atr(high, low, close, period)
    hl2       = (high + low) / 2.0
    upper_raw = (hl2 + multiplier * atr_s).values
    lower_raw = (hl2 - multiplier * atr_s).values
    close_arr = close.values
    n = len(close_arr)

    fu = upper_raw.copy()
    fl = lower_raw.copy()
    st = np.zeros(n)

    for i in range(1, n):
        fu[i] = upper_raw[i] if upper_raw[i] < fu[i-1] or close_arr[i-1] > fu[i-1] else fu[i-1]
        fl[i] = lower_raw[i] if lower_raw[i] > fl[i-1] or close_arr[i-1] < fl[i-1] else fl[i-1]
        if st[i-1] == fu[i-1]:
            st[i] = fu[i] if close_arr[i] <= fu[i] else fl[i]
        else:
            st[i] = fl[i] if close_arr[i] >= fl[i] else fu[i]

    direction = 1 if close_arr[-1] > st[-1] else -1
    return float(st[-1]), direction


def _adx_di(high, low, close, period=14):
    """Returns (adx, plus_di, minus_di, adx_rising).
    adx_rising = True when ADX has been increasing for last 3 bars."""
    h = high.values
    l = low.values
    c = close.values
    n = len(c)

    pdm    = np.zeros(n)
    ndm    = np.zeros(n)
    tr_arr = np.zeros(n)

    for i in range(1, n):
        up        = h[i] - h[i-1]
        down      = l[i-1] - l[i]
        pdm[i]    = up   if up   > max(down, 0) else 0
        ndm[i]    = down if down > max(up,   0) else 0
        tr_arr[i] = max(h[i]-l[i], abs(h[i]-c[i-1]), abs(l[i]-c[i-1]))

    tr_s  = pd.Series(tr_arr).ewm(com=period-1, min_periods=period).mean()
    pdm_s = pd.Series(pdm).ewm(com=period-1,    min_periods=period).mean()
    ndm_s = pd.Series(ndm).ewm(com=period-1,    min_periods=period).mean()

    pdi = 100 * pdm_s / tr_s.replace(0, np.nan)
    ndi = 100 * ndm_s / tr_s.replace(0, np.nan)
    dx  = 100 * (pdi - ndi).abs() / (pdi + ndi).replace(0, np.nan)
    adx = dx.ewm(com=period-1, min_periods=period).mean()

    adx_vals    = adx.dropna().values
    adx_rising  = (len(adx_vals) >= 3 and
                   adx_vals[-1] > adx_vals[-2] > adx_vals[-3] and
                   adx_vals[-1] > 20)

    return (float(adx.iloc[-1] or 0),
            float(pdi.iloc[-1] or 0),
            float(ndi.iloc[-1] or 0),
            bool(adx_rising))


def _count_votes(c, e20, e50, e200, ml, sl, r, vr, st_dir,
                 adx_val, pdi, ndi, bb_mid, htf_ema, divergence):
    """
    10-indicator vote system (some abstain when neutral).
    Returns (up_votes, down_votes).
    """
    up = down = 0

    # 1. EMA alignment (primary TF)
    if e200:
        if   c > e20 > e50 > e200: up   += 1
        elif c < e20 < e50 < e200: down += 1
        elif c > e20 > e50:        up   += 1  # no e200 stack but still aligned
        elif c < e20 < e50:        down += 1
    else:
        if   c > e20 > e50: up   += 1
        elif c < e20 < e50: down += 1

    # 2. HTF EMA (higher timeframe confirms)
    if   htf_ema ==  1: up   += 1
    elif htf_ema == -1: down += 1

    # 3. MACD crossover
    if ml > sl: up   += 1
    else:       down += 1

    # 4. RSI level (abstains in neutral zone 45-55)
    if   r >= 55: up   += 1
    elif r <= 45: down += 1

    # 5. SuperTrend direction
    if   st_dir ==  1: up   += 1
    elif st_dir == -1: down += 1

    # 6. ADX + Directional Index (abstains if trend weak)
    if adx_val > 20:
        if   pdi > ndi: up   += 1
        elif ndi > pdi: down += 1

    # 7. Volume confirmation (follows the stronger side)
    if vr >= 1.5:
        if up > down:   up   += 1
        elif down > up: down += 1

    # 8. Bollinger Band position (price vs midline)
    if bb_mid:
        if   c > bb_mid: up   += 1
        elif c < bb_mid: down += 1

    # 9-10. Divergence counts as 2 votes (strong reversal signal)
    if   divergence == 'bullish': up   += 2
    elif divergence == 'bearish': down += 2

    return up, down


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


def rsi_score(r_now, r_prev):
    try:
        r_now  = float(r_now)
        r_prev = float(r_prev)
    except Exception:
        return 50.0
    base  = 100.0 * math.exp(-((r_now - 60.0) ** 2) / (2 * 18.0 ** 2))
    slope = r_now - r_prev
    bonus = max(-15.0, min(15.0, slope * 1.5))
    if r_now > 80 and slope < 0: bonus -= 25.0
    if r_now < 20 and slope > 0: bonus += 20.0
    return max(0.0, min(100.0, base + bonus))


_NEXT_TF = {'15m': '1h', '1h': '4h', '4h': '1d', '1d': '1wk'}


def htf_alignment(symbol, timeframe):
    htf = _NEXT_TF.get(timeframe)
    if not htf:
        return 0
    if htf == '1wk':
        df = _fetch_with_retry(symbol, '1d')
        if df is None or len(df) < 50:
            return 0
        df    = df.resample('W').agg({'Close': 'last'}).dropna()
        if len(df) < 12:
            return 0
        close = df['Close'].squeeze()
    else:
        df = _fetch_with_retry(symbol, htf)
        if df is None or len(df) < 50:
            return 0
        close = df['Close'].squeeze()
    e20 = close.ewm(span=20, adjust=False).mean().iloc[-1]
    e50 = close.ewm(span=50, adjust=False).mean().iloc[-1]
    c   = close.iloc[-1]
    if c > e20 > e50: return  1
    if c < e20 < e50: return -1
    return 0


def _local_peaks(arr, min_dist=4):
    result = []
    for i in range(1, len(arr) - 1):
        if arr[i] > arr[i-1] and arr[i] > arr[i+1]:
            if not result or i - result[-1] >= min_dist:
                result.append(i)
    return result


def _local_troughs(arr, min_dist=4):
    result = []
    for i in range(1, len(arr) - 1):
        if arr[i] < arr[i-1] and arr[i] < arr[i+1]:
            if not result or i - result[-1] >= min_dist:
                result.append(i)
    return result


def detect_divergence(close, rsi_s, lookback=40):
    if len(close) < lookback or len(rsi_s) < lookback:
        return None
    c = list(close.values[-lookback:])
    r = list(rsi_s.values[-lookback:])

    p_highs = _local_peaks(c,   min_dist=4)
    r_highs = _local_peaks(r,   min_dist=4)
    p_lows  = _local_troughs(c, min_dist=4)
    r_lows  = _local_troughs(r, min_dist=4)

    if (len(p_highs) >= 2 and len(r_highs) >= 2 and
            c[p_highs[-1]] > c[p_highs[-2]] and
            r[r_highs[-1]] < r[r_highs[-2]] - 2):
        return 'bearish'

    if (len(p_lows) >= 2 and len(r_lows) >= 2 and
            c[p_lows[-1]] < c[p_lows[-2]] and
            r[r_lows[-1]] > r[r_lows[-2]] + 2):
        return 'bullish'

    return None


def candle_patterns(opens, highs, lows, closes):
    patterns = []
    if len(closes) < 3:
        return patterns

    o  = float(opens.iloc[-1]);  h  = float(highs.iloc[-1])
    l  = float(lows.iloc[-1]);   c  = float(closes.iloc[-1])
    o2 = float(opens.iloc[-2]);  c2 = float(closes.iloc[-2])

    body   = abs(c - o)
    range_ = h - l
    if range_ < 1e-10:
        return patterns

    lower_wick = min(o, c) - l
    upper_wick = h - max(o, c)

    if lower_wick >= 2 * body and upper_wick < 0.5 * body and c >= o:
        patterns.append('Hammer')
    if upper_wick >= 2 * body and lower_wick < 0.5 * body and c <= o:
        patterns.append('Shooting Star')
    if c2 < o2 and c > o and c >= o2 and o <= c2:
        patterns.append('Bull Engulfing')
    if c2 > o2 and c < o and c <= o2 and o >= c2:
        patterns.append('Bear Engulfing')
    if len(closes) >= 21:
        recent_high = float(highs.iloc[-21:-1].max())
        if c > recent_high:
            patterns.append('20D Breakout')

    return patterns


# ── Main analyzer ─────────────────────────────────────────────────────────────
def analyze(symbol, timeframe='1d'):
    try:
        df = _fetch_with_retry(symbol, timeframe)
        if df is None or len(df) < 30:
            return None

        close  = df['Close'].squeeze()
        high   = df['High'].squeeze()
        low    = df['Low'].squeeze()
        vol    = df['Volume'].squeeze()
        opens  = df['Open'].squeeze() if 'Open' in df.columns else close

        last_candle = _fmt_candle_date(df.index[-1], timeframe)

        rsi_s               = _rsi(close)
        macd_l, sig_l, hist = _macd(close)
        ema20               = _ema(close, 20)
        ema50               = _ema(close, 50)
        ema200              = _ema(close, 200) if len(df) >= 200 else None
        vol_ma              = vol.rolling(20).median()
        atr_s               = _atr(high, low, close)

        c      = float(close.iloc[-1])
        r      = float(rsi_s.iloc[-1])
        r_prev = float(rsi_s.iloc[-3]) if len(rsi_s) >= 3 else r
        ml     = float(macd_l.iloc[-1])
        sl     = float(sig_l.iloc[-1])
        h0     = float(hist.iloc[-1])
        h1     = float(hist.iloc[-2]) if len(hist) > 1 else 0.0
        e20    = float(ema20.iloc[-1])
        e50    = float(ema50.iloc[-1])
        e200   = float(ema200.iloc[-1]) if ema200 is not None else None
        v      = float(vol.iloc[-1])
        vma    = float(vol_ma.iloc[-1])
        atr    = float(atr_s.iloc[-1])

        # ── Bollinger Bands ──────────────────────────────────────────────────
        bb_upper, bb_mid, bb_lower, bb_squeeze = _bollinger(close)

        # ── SuperTrend ───────────────────────────────────────────────────────
        st_val, st_dir = _supertrend(high, low, close)

        # ── ADX / DI (includes ADX Rising detection) ──────────────────────
        adx_val, pdi, ndi, adx_rising = _adx_di(high, low, close)

        # ── EMA trend score ──────────────────────────────────────────────────
        if e200 is not None:
            if   c > e20 > e50 > e200: ema_sc = 92
            elif c > e20 > e50:        ema_sc = 72
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

        # ── MACD score ───────────────────────────────────────────────────────
        if ml > sl:
            macd_sc = 82 if (h0 > 0 and h0 > h1) else 68 if h0 > 0 else 58
        else:
            macd_sc = 18 if (h0 < 0 and h0 < h1) else 32 if h0 < 0 else 42

        # ── RSI score ────────────────────────────────────────────────────────
        rsi_sc = rsi_score(r, r_prev)

        # ── Volume score ─────────────────────────────────────────────────────
        vr = v / vma if vma > 0 else 1.0
        if   vr >= 2.0: vol_sc = 90
        elif vr >= 1.5: vol_sc = 75
        elif vr >= 1.0: vol_sc = 55
        elif vr >= 0.7: vol_sc = 38
        else:           vol_sc = 20

        # ── SuperTrend score ─────────────────────────────────────────────────
        st_sc = 80 if st_dir == 1 else 20

        # ── Divergence ───────────────────────────────────────────────────────
        div = detect_divergence(close, rsi_s)
        div_adj = 0
        if   div == 'bullish': div_adj = +8
        elif div == 'bearish': div_adj = -8

        # ── Relative strength vs SPY ─────────────────────────────────────────
        if len(close) >= 21:
            stock_ret20 = float((close.iloc[-1] - close.iloc[-21]) / close.iloc[-21])
        else:
            stock_ret20 = 0.0
        spy_ret20 = _spy_return_20d()
        rs_20 = round((stock_ret20 - spy_ret20) * 100, 2)

        # ── Market regime ─────────────────────────────────────────────────────
        reg        = market_regime_score()
        regime_adj = (reg - 50) / 50.0
        regime_sc  = 50 + 50 * regime_adj

        # ── Per-timeframe composite ───────────────────────────────────────────
        w = _WEIGHTS.get(timeframe, _WEIGHTS['1d'])
        composite = (
            w['ema']    * ema_sc
            + w['macd'] * macd_sc
            + w['rsi']  * rsi_sc
            + w['vol']  * vol_sc
            + w['regime'] * regime_sc
            + w['st']   * st_sc
            + div_adj
        )
        composite = max(0, min(100, composite))

        if   composite > 55: direction = 'Bullish'
        elif composite < 45: direction = 'Bearish'
        else:                direction = 'Neutral'

        strength = min(100, int(abs(composite - 50) * 3))
        if direction == 'Neutral':
            strength = min(strength, 25)

        # ── MTF confluence ────────────────────────────────────────────────────
        mtf = htf_alignment(symbol, timeframe)
        if direction == 'Bullish':
            mult_score = 1.2 if mtf > 0 else 0.6 if mtf < 0 else 1.0
        elif direction == 'Bearish':
            mult_score = 1.2 if mtf < 0 else 0.6 if mtf > 0 else 1.0
        else:
            mult_score = 1.0
        strength = min(100, int(strength * mult_score))

        # ── Vote-based consensus ──────────────────────────────────────────────
        up_votes, down_votes = _count_votes(
            c, e20, e50, e200, ml, sl, r, vr,
            st_dir, adx_val, pdi, ndi,
            bb_mid, mtf, div)

        vote_diff = abs(up_votes - down_votes)
        if div and ((div == 'bullish' and down_votes > up_votes) or
                    (div == 'bearish' and up_votes > down_votes)):
            signal_type = 'Reversal'
        elif vote_diff >= 3:
            signal_type = 'Trend'
        else:
            signal_type = 'Mixed'

        # ── Candlestick + technical patterns ─────────────────────────────────
        patterns = candle_patterns(opens, high, low, close)

        if div == 'bullish':  patterns.append('Bullish Divergence')
        if div == 'bearish':  patterns.append('Bearish Divergence')
        if bb_squeeze >= 70:  patterns.append(f'BB Squeeze {bb_squeeze}%')
        if adx_rising:        patterns.append('ADX Rising')
        if mtf > 0:           patterns.append('HTF Aligned')
        if rs_20 >= 5:        patterns.append('RS+ vs SPY')
        if rs_20 <= -5:       patterns.append('RS- vs SPY')

        # ── AB.SK trade levels ────────────────────────────────────────────────
        # Stop = 5×ATR, Goal1 = 2.5×ATR, Goal2 = 5×ATR, Goal3 = 7.5×ATR
        mult_dir = 1 if direction == 'Bullish' else -1
        entry    = round(c, 4)
        stop_lvl = round(c - mult_dir * 5.0 * atr, 4)
        tp1      = round(c + mult_dir * 2.5 * atr, 4)
        tp2      = round(c + mult_dir * 5.0 * atr, 4)
        tp3      = round(c + mult_dir * 7.5 * atr, 4)
        rr_ratio = round(abs(tp2 - c) / max(abs(c - stop_lvl), 0.01), 2)

        return {
            'symbol':        symbol,
            'score':         strength,
            'direction':     direction,
            'composite':     round(composite, 1),
            'signal_type':   signal_type,
            'up_votes':      up_votes,
            'down_votes':    down_votes,
            'price':         round(c, 4),
            'rsi':           round(r, 1),
            'macd':          round(ml, 4),
            'macd_signal':   round(sl, 4),
            'ema20':         round(e20, 4),
            'ema50':         round(e50, 4),
            'ema200':        round(e200, 4) if e200 else None,
            'volume':        int(v),
            'vol_ratio':     round(vr, 2),
            'atr':           round(atr, 4),
            'adx':           round(adx_val, 1),
            'adx_plus_di':   round(pdi, 1),
            'adx_minus_di':  round(ndi, 1),
            'adx_rising':    adx_rising,
            'supertrend':    round(st_val, 4),
            'supertrend_dir': st_dir,
            'bb_upper':      round(bb_upper, 4),
            'bb_mid':        round(bb_mid, 4),
            'bb_lower':      round(bb_lower, 4),
            'bb_squeeze':    bb_squeeze,
            'entry':         entry,
            'stop':          stop_lvl,
            'tp1':           tp1,
            'tp2':           tp2,
            'tp3':           tp3,
            'target':        tp2,
            'rr':            rr_ratio,
            'ema_score':     round(ema_sc, 1),
            'macd_score':    round(macd_sc, 1),
            'rsi_score':     round(rsi_sc, 1),
            'vol_score':     round(vol_sc, 1),
            'regime_score':  int(reg),
            'htf_ema_dir':   int(mtf),
            'mtf_align':     int(mtf),
            'divergence':    div,
            'patterns':      patterns,
            'rs_20':         rs_20,
            'last_candle':   last_candle,
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
