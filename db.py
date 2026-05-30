"""
Database connection pool for the learning system.
Gracefully disables itself when DATABASE_URL is not set.
"""
import os

_pool = None
_enabled = False


def _init_pool():
    global _pool, _enabled
    url = os.environ.get('DATABASE_URL', '')
    if not url:
        return
    try:
        import psycopg2
        from psycopg2 import pool as pg_pool
        # Render / Heroku emit postgres:// but psycopg2 needs postgresql://
        if url.startswith('postgres://'):
            url = 'postgresql://' + url[len('postgres://'):]
        _pool = pg_pool.ThreadedConnectionPool(1, 10, url)
        _enabled = True
    except Exception as e:
        print(f'[DB] pool init failed: {e}')


def enabled():
    return _enabled


def get_conn():
    if not _enabled or _pool is None:
        return None
    return _pool.getconn()


def put_conn(conn):
    if _pool and conn:
        _pool.putconn(conn)


def init_db():
    _init_pool()
    conn = get_conn()
    if conn is None:
        print('[DB] No DATABASE_URL — learning system disabled')
        return
    try:
        cur = conn.cursor()
        cur.execute('''
            CREATE TABLE IF NOT EXISTS signals (
                id           SERIAL PRIMARY KEY,
                symbol       VARCHAR(20)  NOT NULL,
                timeframe    VARCHAR(10)  NOT NULL,
                direction    VARCHAR(10)  NOT NULL,
                score        INTEGER      NOT NULL,
                composite    FLOAT,
                signal_type  VARCHAR(20),
                up_votes     INTEGER      DEFAULT 0,
                down_votes   INTEGER      DEFAULT 0,
                price        FLOAT,
                rsi          FLOAT,
                macd         FLOAT,
                ema_score    FLOAT,
                macd_score   FLOAT,
                rsi_score    FLOAT,
                vol_score    FLOAT,
                vol_ratio    FLOAT,
                adx          FLOAT,
                mtf_align    INTEGER      DEFAULT 0,
                divergence   VARCHAR(20),
                source       VARCHAR(50),
                tp1          FLOAT,
                tp2          FLOAT,
                stop         FLOAT,
                scanned_at   TIMESTAMPTZ  DEFAULT NOW()
            )
        ''')
        cur.execute('''
            CREATE TABLE IF NOT EXISTS signal_outcomes (
                id              SERIAL PRIMARY KEY,
                signal_id       INTEGER REFERENCES signals(id) ON DELETE CASCADE,
                symbol          VARCHAR(20)  NOT NULL,
                direction       VARCHAR(10)  NOT NULL,
                entry_price     FLOAT        NOT NULL,
                exit_price      FLOAT,
                return_pct      FLOAT,
                hit_tp1         BOOLEAN      DEFAULT FALSE,
                hit_tp2         BOOLEAN      DEFAULT FALSE,
                hit_stop        BOOLEAN      DEFAULT FALSE,
                outcome         VARCHAR(20)  DEFAULT 'pending',
                evaluated_at    TIMESTAMPTZ,
                evaluation_days INTEGER      DEFAULT 5
            )
        ''')
        cur.execute('''
            CREATE TABLE IF NOT EXISTS indicator_weights (
                id           SERIAL PRIMARY KEY,
                timeframe    VARCHAR(10)  NOT NULL,
                indicator    VARCHAR(30)  NOT NULL,
                weight       FLOAT        NOT NULL DEFAULT 0.5,
                win_rate     FLOAT,
                sample_count INTEGER      DEFAULT 0,
                last_updated TIMESTAMPTZ  DEFAULT NOW(),
                UNIQUE(timeframe, indicator)
            )
        ''')
        # Index for fast pending-signal lookup
        cur.execute('''
            CREATE INDEX IF NOT EXISTS idx_signals_scanned_at
            ON signals(scanned_at)
        ''')
        conn.commit()
        cur.close()
        print('[DB] Tables ready')
    except Exception as e:
        print(f'[DB] init error: {e}')
        conn.rollback()
    finally:
        put_conn(conn)
