"""
Daily outcome evaluator.
Runs via APScheduler — fetches prices 5 days after a signal was logged,
records win/loss, then recalculates indicator weights from the full history.
"""
from collections import defaultdict
from datetime import datetime, timezone, timedelta

import yfinance as yf
import db

# How many calendar days to wait before evaluating — matched to each timeframe's
# typical holding period so the signal has enough time to reach TP or stop.
_EVAL_DAYS = {
    '1d':  14,   # swing trade: up to 2-3 weeks
    '4h':  7,    # medium hold: ~1 week
    '1h':  3,    # short hold: 2-3 days
    '15m': 2,    # intraday/scalp: 1-2 days
    '1w':  28,   # weekly: ~4 weeks
    '1mo': 45,   # monthly: 6 weeks
}
_DEFAULT_EVAL_DAYS = 10

# yfinance period string to fetch enough history to cover evaluation window
_FETCH_PERIOD = {
    '1d':  '25d',
    '4h':  '12d',
    '1h':  '7d',
    '15m': '5d',
    '1w':  '45d',
    '1mo': '60d',
}
_DEFAULT_FETCH = '15d'


def evaluate_pending_outcomes():
    """Entry point called by APScheduler once per day."""
    if not db.enabled():
        return
    conn = db.get_conn()
    if conn is None:
        return
    try:
        _eval_signals(conn)
        _update_indicator_weights(conn)
        conn.commit()
    except Exception as e:
        print(f'[evaluator] top-level error: {e}')
        conn.rollback()
    finally:
        db.put_conn(conn)


# ── Signal evaluation ─────────────────────────────────────────────────────────

def _eval_signals(conn):
    cur = conn.cursor()
    # Fetch signals whose timeframe eval window has passed — use the longest
    # window (28 days) as the outer cutoff so we catch everything.
    max_cutoff = datetime.now(timezone.utc) - timedelta(days=2)
    cur.execute(
        '''
        SELECT s.id, s.symbol, s.timeframe, s.direction, s.price, s.tp1, s.tp2,
               s.stop, s.scanned_at
        FROM signals s
        LEFT JOIN signal_outcomes o ON o.signal_id = s.id
        WHERE s.scanned_at <= %s AND o.id IS NULL
        LIMIT 150
        ''',
        (max_cutoff,),
    )
    rows = cur.fetchall()
    cur.close()

    if not rows:
        print('[evaluator] no pending signals')
        return

    now = datetime.now(timezone.utc)
    evaluated = 0
    for sig_id, symbol, timeframe, direction, entry, tp1, tp2, stop, scanned_at in rows:
        eval_days = _EVAL_DAYS.get(timeframe, _DEFAULT_EVAL_DAYS)
        # Only evaluate once the holding window has elapsed
        if scanned_at and (now - scanned_at).days < eval_days:
            continue
        try:
            _eval_one(conn, sig_id, symbol, timeframe, direction, entry, tp1, tp2,
                      stop, eval_days)
            evaluated += 1
        except Exception as e:
            print(f'[evaluator] {symbol}: {e}')

    print(f'[evaluator] evaluated {evaluated} signals')


def _eval_one(conn, sig_id, symbol, timeframe, direction, entry, tp1, tp2, stop,
              eval_days):
    fetch_period = _FETCH_PERIOD.get(timeframe, _DEFAULT_FETCH)
    hist = yf.Ticker(symbol).history(period=fetch_period, interval='1d')
    if hist.empty or entry is None:
        return

    bull       = direction == 'Bullish'
    exit_price = float(hist['Close'].iloc[-1])
    high_max   = float(hist['High'].max())
    low_min    = float(hist['Low'].min())

    # Return % from the trader's perspective (positive = profit)
    return_pct = (exit_price - entry) / entry * 100
    if not bull:
        return_pct = -return_pct

    hit_tp1  = bool(tp1  and (high_max >= tp1  if bull else low_min  <= tp1))
    hit_tp2  = bool(tp2  and (high_max >= tp2  if bull else low_min  <= tp2))
    hit_stop = bool(stop and (low_min  <= stop if bull else high_max >= stop))

    if hit_tp2:
        outcome = 'win'
    elif hit_stop and not hit_tp1:
        outcome = 'loss'
    elif return_pct >= 3.0:
        outcome = 'win'
    elif return_pct <= -3.0:
        outcome = 'loss'
    else:
        outcome = 'neutral'

    cur = conn.cursor()
    cur.execute(
        '''
        INSERT INTO signal_outcomes
            (signal_id, symbol, direction, entry_price, exit_price, return_pct,
             hit_tp1, hit_tp2, hit_stop, outcome, evaluated_at, evaluation_days)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        ''',
        (
            sig_id, symbol, direction, entry, round(exit_price, 4),
            round(return_pct, 2), hit_tp1, hit_tp2, hit_stop,
            outcome, datetime.now(timezone.utc), EVAL_DAYS,
        ),
    )
    cur.close()


# ── Weight learning ──────────────────────────────────────────────────────────

def _update_indicator_weights(conn):
    """
    For each indicator score, check whether score > 50 predicted the correct
    direction AND the trade was a win. Win-rate drives the new weight.
    """
    cur = conn.cursor()
    cur.execute(
        '''
        SELECT s.timeframe, s.ema_score, s.macd_score, s.rsi_score, s.vol_score,
               s.direction, o.outcome
        FROM signals s
        JOIN signal_outcomes o ON o.signal_id = s.id
        WHERE o.outcome IN ('win', 'loss')
        ORDER BY s.scanned_at DESC
        LIMIT 1000
        ''',
    )
    rows = cur.fetchall()

    # stats[tf:indicator] = {'wins': n, 'total': n}
    stats = defaultdict(lambda: {'wins': 0, 'total': 0})

    for tf, ema_sc, macd_sc, rsi_sc, vol_sc, direction, outcome in rows:
        bull = direction == 'Bullish'
        win  = outcome == 'win'
        for ind, sc in [('ema', ema_sc), ('macd', macd_sc),
                        ('rsi', rsi_sc), ('vol', vol_sc)]:
            if sc is None:
                continue
            voted_bull = sc > 50
            # Correct if vote matched direction AND it was a win,
            # OR if vote was opposite direction AND it was a loss.
            correct = (voted_bull == bull) == win
            key = f'{tf}:{ind}'
            stats[key]['total'] += 1
            if correct:
                stats[key]['wins'] += 1

    for key, s in stats.items():
        if s['total'] < 10:
            continue
        tf, ind   = key.split(':', 1)
        win_rate  = round(s['wins'] / s['total'], 4)
        # Map win_rate 0.30–0.70 → weight 0.05–0.35 (linear)
        raw_w     = 0.05 + max(0.0, win_rate - 0.30) / 0.40 * 0.30
        weight    = round(max(0.02, min(0.40, raw_w)), 4)

        cur.execute(
            '''
            INSERT INTO indicator_weights
                (timeframe, indicator, weight, win_rate, sample_count, last_updated)
            VALUES (%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (timeframe, indicator)
            DO UPDATE SET weight       = EXCLUDED.weight,
                          win_rate     = EXCLUDED.win_rate,
                          sample_count = EXCLUDED.sample_count,
                          last_updated = EXCLUDED.last_updated
            ''',
            (tf, ind, weight, win_rate, s['total']),
        )

    cur.close()
    print('[evaluator] indicator weights updated')


# ── Admin stats helper ────────────────────────────────────────────────────────

def get_learning_stats():
    """Return a summary dict for the /api/admin/learning-stats endpoint."""
    if not db.enabled():
        return {'enabled': False}

    conn = db.get_conn()
    if conn is None:
        return {'enabled': False, 'error': 'db unavailable'}
    try:
        cur = conn.cursor()

        cur.execute('SELECT COUNT(*) FROM signals')
        total_signals = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM signal_outcomes WHERE outcome != 'pending'")
        total_evaluated = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM signal_outcomes WHERE outcome = 'win'")
        total_wins = cur.fetchone()[0]

        cur.execute("SELECT COUNT(*) FROM signal_outcomes WHERE outcome = 'loss'")
        total_losses = cur.fetchone()[0]

        cur.execute('SELECT AVG(return_pct) FROM signal_outcomes WHERE return_pct IS NOT NULL')
        avg_return = cur.fetchone()[0]

        cur.execute(
            '''
            SELECT timeframe, indicator, weight, win_rate, sample_count
            FROM indicator_weights
            ORDER BY timeframe, indicator
            '''
        )
        weights = [
            {'timeframe': r[0], 'indicator': r[1],
             'weight': r[2], 'win_rate': r[3], 'samples': r[4]}
            for r in cur.fetchall()
        ]

        cur.execute(
            '''
            SELECT s.symbol, s.direction, s.score, o.return_pct, o.outcome,
                   s.scanned_at
            FROM signals s
            JOIN signal_outcomes o ON o.signal_id = s.id
            ORDER BY s.scanned_at DESC
            LIMIT 20
            '''
        )
        recent = [
            {'symbol': r[0], 'direction': r[1], 'score': r[2],
             'return_pct': r[3], 'outcome': r[4],
             'scanned_at': r[5].isoformat() if r[5] else None}
            for r in cur.fetchall()
        ]

        cur.close()
        win_rate = round(total_wins / max(total_evaluated, 1) * 100, 1)
        return {
            'enabled':        True,
            'total_signals':  total_signals,
            'total_evaluated': total_evaluated,
            'total_wins':     total_wins,
            'total_losses':   total_losses,
            'win_rate_pct':   win_rate,
            'avg_return_pct': round(float(avg_return), 2) if avg_return else 0,
            'weights':        weights,
            'recent_outcomes': recent,
        }
    except Exception as e:
        print(f'[evaluator.get_learning_stats] {e}')
        return {'enabled': True, 'error': str(e)}
    finally:
        db.put_conn(conn)


# ── Automatic scheduled scan ──────────────────────────────────────────────────

def auto_scan():
    """
    Runs a full market scan automatically and logs results to the DB.
    Called by APScheduler 3× per trading day — no user interaction needed.
    Skips weekends.
    """
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    # Skip Saturday (5) and Sunday (6)
    if now.weekday() >= 5:
        print('[auto_scan] weekend — skipping')
        return

    try:
        from tv_scanner import scan_tv
        from signal_logger import log_signals_async

        total = 0
        for tf in ('1d', '4h'):
            try:
                results = scan_tv(sector='all', timeframe=tf, min_score=50, limit=150)
                if results:
                    log_signals_async(results, tf, 'TradingView')
                    total += len(results)
                    print(f'[auto_scan] {tf}: {len(results)} signals logged')
            except Exception as e:
                print(f'[auto_scan] {tf} error: {e}')

        print(f'[auto_scan] done — {total} total signals logged')
    except Exception as e:
        print(f'[auto_scan] failed: {e}')
