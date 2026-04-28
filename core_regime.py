# -*- coding: utf-8 -*-
"""
Market regime detector.

Returns a 0..100 score based on SPY's position relative to its 50/200 EMAs
and the current VIX level.  >60 = risk-on, <40 = risk-off, ~50 = neutral.

The score is cached for 15 minutes to avoid hammering yfinance on every scan.
"""
import time
import yfinance as yf

_CACHE_TTL = 900  # 15 minutes
_cache = {"ts": 0.0, "score": 50}


def _safe_last(series):
    try:
        return float(series.dropna().iloc[-1])
    except Exception:
        return None


def market_regime_score():
    """Returns int 0..100. >60 risk-on, <40 risk-off, ~50 neutral.

    Falls back to 50 (neutral) on any data failure so callers never crash.
    """
    if time.time() - _cache["ts"] < _CACHE_TTL:
        return _cache["score"]

    try:
        spy = yf.download(
            "SPY", period="1y", interval="1d",
            progress=False, auto_adjust=True, actions=False,
        )["Close"].squeeze()
        vix = yf.download(
            "^VIX", period="3mo", interval="1d",
            progress=False, auto_adjust=True, actions=False,
        )["Close"].squeeze()

        last   = _safe_last(spy)
        ema50  = _safe_last(spy.ewm(span=50,  adjust=False).mean())
        ema200 = _safe_last(spy.ewm(span=200, adjust=False).mean())
        vix_l  = _safe_last(vix)

        if last is None or ema50 is None:
            _cache.update(ts=time.time(), score=50)
            return 50

        s = 50
        if last > ema50:               s += 15
        if ema200 and last > ema200:   s += 15
        if last < ema50:               s -= 15
        if ema200 and last < ema200:   s -= 15

        if vix_l is not None:
            if vix_l < 15:   s += 10
            elif vix_l > 25: s -= 15

        s = max(0, min(100, int(s)))
        _cache.update(ts=time.time(), score=s)
        return s
    except Exception:
        # On any failure, return last cached value or neutral
        return _cache.get("score", 50)


def regime_label(score):
    if score >= 65:  return "Risk-On"
    if score >= 55:  return "Mildly Risk-On"
    if score >= 45:  return "Neutral"
    if score >= 35:  return "Mildly Risk-Off"
    return "Risk-Off"
