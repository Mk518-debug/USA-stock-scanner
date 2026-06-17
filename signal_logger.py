"""
Signal logger and learned-weight retrieval.
Runs DB writes on a background thread so scan latency is unaffected.
"""
import threading
import db

# Minimum outcomes needed before switching from default to learned weights
_MIN_SAMPLES = 30

# Default weights (mirrors scanner.py — single source of truth via get_weights())
_DEFAULT_WEIGHTS = {
    # 'div' (divergence) added as proper weighted indicator.
    # Each timeframe takes 0.03 from 'macd' to keep the total at 1.00.
    '1d':  {'ema': 0.22, 'macd': 0.22, 'rsi': 0.18, 'vol': 0.12,
             'regime': 0.10, 'st': 0.08, 'stoch': 0.04, 'mom': 0.01, 'div': 0.03},
    '4h':  {'ema': 0.17, 'macd': 0.24, 'rsi': 0.20, 'vol': 0.15,
             'regime': 0.08, 'st': 0.07, 'stoch': 0.04, 'mom': 0.02, 'div': 0.03},
    '1h':  {'ema': 0.10, 'macd': 0.27, 'rsi': 0.24, 'vol': 0.18,
             'regime': 0.05, 'st': 0.06, 'stoch': 0.05, 'mom': 0.02, 'div': 0.03},
    '15m': {'ema': 0.06, 'macd': 0.29, 'rsi': 0.26, 'vol': 0.20,
             'regime': 0.03, 'st': 0.06, 'stoch': 0.05, 'mom': 0.02, 'div': 0.03},
    '1w':  {'ema': 0.28, 'macd': 0.17, 'rsi': 0.14, 'vol': 0.10,
             'regime': 0.14, 'st': 0.08, 'stoch': 0.04, 'mom': 0.02, 'div': 0.03},
    '1mo': {'ema': 0.32, 'macd': 0.15, 'rsi': 0.12, 'vol': 0.08,
             'regime': 0.16, 'st': 0.07, 'stoch': 0.04, 'mom': 0.03, 'div': 0.03},
}


def get_weights(timeframe):
    """Return composite weights — learned if DB has enough samples, else defaults."""
    if not db.enabled():
        return _DEFAULT_WEIGHTS.get(timeframe, _DEFAULT_WEIGHTS['1d'])

    conn = db.get_conn()
    if conn is None:
        return _DEFAULT_WEIGHTS.get(timeframe, _DEFAULT_WEIGHTS['1d'])
    try:
        cur = conn.cursor()
        cur.execute(
            'SELECT indicator, weight FROM indicator_weights '
            'WHERE timeframe = %s AND sample_count >= %s',
            (timeframe, _MIN_SAMPLES),
        )
        rows = cur.fetchall()
        cur.close()
        if not rows:
            return _DEFAULT_WEIGHTS.get(timeframe, _DEFAULT_WEIGHTS['1d'])

        learned = {row[0]: row[1] for row in rows}
        base = dict(_DEFAULT_WEIGHTS.get(timeframe, _DEFAULT_WEIGHTS['1d']))
        base.update(learned)

        # Renormalize so weights always sum to 1.0
        total = sum(base.values())
        if total > 0:
            base = {k: round(v / total, 4) for k, v in base.items()}
        return base
    except Exception as e:
        print(f'[signal_logger.get_weights] {e}')
        return _DEFAULT_WEIGHTS.get(timeframe, _DEFAULT_WEIGHTS['1d'])
    finally:
        db.put_conn(conn)


def log_signals_async(results, timeframe, source):
    """Fire-and-forget: log scan results to DB without blocking the response."""
    if not db.enabled() or not results:
        return
    t = threading.Thread(
        target=_log_signals,
        args=(list(results), timeframe, source),
        daemon=True,
    )
    t.start()


def _log_signals(results, timeframe, source):
    conn = db.get_conn()
    if conn is None:
        return
    try:
        cur = conn.cursor()
        for r in results:
            cur.execute(
                '''
                INSERT INTO signals
                    (symbol, timeframe, direction, score, composite, signal_type,
                     up_votes, down_votes, price, rsi, macd, ema_score, macd_score,
                     rsi_score, vol_score, vol_ratio, adx, mtf_align, divergence,
                     source, tp1, tp2, stop)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ''',
                (
                    r.get('symbol'), timeframe, r.get('direction'),
                    r.get('score', 0), r.get('composite'), r.get('signal_type'),
                    r.get('up_votes', 0), r.get('down_votes', 0),
                    r.get('price'), r.get('rsi'), r.get('macd'),
                    r.get('ema_score'), r.get('macd_score'), r.get('rsi_score'),
                    r.get('vol_score'), r.get('vol_ratio'), r.get('adx'),
                    r.get('mtf_align', 0), r.get('divergence'),
                    source, r.get('tp1'), r.get('tp2'), r.get('stop'),
                ),
            )
        conn.commit()
        cur.close()
    except Exception as e:
        print(f'[signal_logger._log_signals] {e}')
        conn.rollback()
    finally:
        db.put_conn(conn)
