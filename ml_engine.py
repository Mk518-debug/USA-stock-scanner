"""
ML engine — trains on evaluated signal outcomes and predicts win probability.

Phase 1 (200+ outcomes):  Logistic Regression  — fast, interpretable
Phase 2 (1000+ outcomes): Random Forest        — captures non-linear patterns

Model is serialised to the DB so it survives Render restarts.
"""
import pickle
import numpy as np
import db

_MIN_LR = 200
_MIN_RF = 1000

_cache = None   # loaded model: {model, scaler, type, samples, accuracy}

# ── Feature extraction ────────────────────────────────────────────────────────

_ST_MAP  = {'Trend': 3, 'Reversal': 2, 'Mixed': 1, 'Weak': 0}
_DIV_MAP = {'bullish': 1, 'bearish': -1, None: 0, 'None': 0, '': 0}


def _features(d):
    return [
        float(d.get('ema_score')  or 50),
        float(d.get('macd_score') or 50),
        float(d.get('rsi_score')  or 50),
        float(d.get('vol_score')  or 50),
        float(d.get('adx')        or 20),
        float(d.get('vol_ratio')  or 1.0),
        float(d.get('rsi')        or 50),
        float(d.get('up_votes')   or 0),
        float(d.get('down_votes') or 0),
        float(_ST_MAP.get(d.get('signal_type'), 1)),
        float(_DIV_MAP.get(d.get('divergence'), 0)),
        float(d.get('mtf_align')  or 0),
        float(d.get('composite')  or 50),
        float(d.get('score')      or 50),
    ]


# ── Load / save ───────────────────────────────────────────────────────────────

def load_model():
    """Load latest model from DB into memory cache."""
    global _cache
    conn = db.get_conn()
    if conn is None:
        return
    try:
        cur = conn.cursor()
        cur.execute(
            'SELECT model_type, model_data, sample_count, accuracy '
            'FROM ml_models ORDER BY trained_at DESC LIMIT 1'
        )
        row = cur.fetchone()
        cur.close()
        if row:
            model_type, model_data, sample_count, accuracy = row
            obj = pickle.loads(bytes(model_data))
            _cache = {
                'model':    obj['model'],
                'scaler':   obj['scaler'],
                'type':     model_type,
                'samples':  sample_count,
                'accuracy': accuracy or 0.0,
            }
            print(f'[ml] loaded {model_type} '
                  f'({sample_count} samples, {accuracy:.1%} acc)')
    except Exception as e:
        print(f'[ml] load error: {e}')
    finally:
        db.put_conn(conn)


def _save_model(model, scaler, model_type, n, accuracy, conn):
    blob = pickle.dumps({'model': model, 'scaler': scaler})
    cur = conn.cursor()
    cur.execute(
        'INSERT INTO ml_models (model_type, model_data, sample_count, accuracy) '
        'VALUES (%s, %s, %s, %s)',
        (model_type, blob, n, round(accuracy, 4)),
    )
    cur.close()


# ── Training ──────────────────────────────────────────────────────────────────

def train_model():
    """Fetch all evaluated signals and (re)train the model."""
    if not db.enabled():
        return
    conn = db.get_conn()
    if conn is None:
        return
    try:
        cur = conn.cursor()
        cur.execute(
            '''
            SELECT s.ema_score, s.macd_score, s.rsi_score, s.vol_score,
                   s.adx, s.vol_ratio, s.rsi, s.up_votes, s.down_votes,
                   s.signal_type, s.divergence, s.mtf_align, s.composite,
                   s.score, o.outcome
            FROM signals s
            JOIN signal_outcomes o ON o.signal_id = s.id
            WHERE o.outcome IN ('win', 'loss')
            '''
        )
        rows = cur.fetchall()
        cur.close()
        n = len(rows)

        if n < _MIN_LR:
            print(f'[ml] not enough data ({n}/{_MIN_LR} needed) — skipping')
            return

        col_names = ['ema_score', 'macd_score', 'rsi_score', 'vol_score',
                     'adx', 'vol_ratio', 'rsi', 'up_votes', 'down_votes',
                     'signal_type', 'divergence', 'mtf_align', 'composite', 'score']
        X, y = [], []
        for row in rows:
            d = dict(zip(col_names, row[:14]))
            X.append(_features(d))
            y.append(1 if row[14] == 'win' else 0)

        from sklearn.preprocessing import StandardScaler
        from sklearn.model_selection import cross_val_score

        X = np.array(X, dtype=float)
        y = np.array(y)

        scaler = StandardScaler()
        Xs = scaler.fit_transform(X)

        if n >= _MIN_RF:
            from sklearn.ensemble import RandomForestClassifier
            model = RandomForestClassifier(
                n_estimators=200, max_depth=8, min_samples_leaf=5,
                class_weight='balanced', random_state=42, n_jobs=-1,
            )
            model_type = 'RandomForest'
        else:
            from sklearn.linear_model import LogisticRegression
            model = LogisticRegression(
                C=0.5, max_iter=1000,
                class_weight='balanced', random_state=42,
            )
            model_type = 'LogisticRegression'

        # Cross-validated accuracy (min 3 folds to avoid errors on small sets)
        n_folds = max(3, min(5, n // 40))
        cv_scores = cross_val_score(model, Xs, y, cv=n_folds, scoring='accuracy')
        accuracy = float(cv_scores.mean())

        model.fit(Xs, y)

        _save_model(model, scaler, model_type, n, accuracy, conn)
        conn.commit()

        global _cache
        _cache = {
            'model':    model,
            'scaler':   scaler,
            'type':     model_type,
            'samples':  n,
            'accuracy': accuracy,
        }
        print(f'[ml] trained {model_type}: {n} samples, '
              f'cv_accuracy={accuracy:.1%}')

        _update_weights(model, model_type, conn)

    except Exception as e:
        print(f'[ml] train error: {e}')
        try:
            conn.rollback()
        except Exception:
            pass
    finally:
        db.put_conn(conn)


# ── Prediction ────────────────────────────────────────────────────────────────

def predict(signal_dict):
    """
    Return win probability 0-100 for a signal dict.
    Returns None if no model is loaded yet.
    """
    global _cache
    if _cache is None:
        load_model()
    if _cache is None:
        return None
    try:
        X = np.array([_features(signal_dict)], dtype=float)
        Xs = _cache['scaler'].transform(X)
        prob = _cache['model'].predict_proba(Xs)[0][1]
        return round(float(prob) * 100, 1)
    except Exception as e:
        print(f'[ml] predict error: {e}')
        return None


def get_model_info():
    """Return current model metadata dict for /api/admin/learning-stats."""
    global _cache
    if _cache is None:
        load_model()
    if _cache is None:
        return {'active': False, 'next_at': _MIN_LR}
    return {
        'active':   True,
        'type':     _cache['type'],
        'samples':  _cache['samples'],
        'accuracy': round(_cache['accuracy'] * 100, 1),
        'next_upgrade': (
            _MIN_RF if _cache['type'] == 'LogisticRegression'
            and _cache['samples'] < _MIN_RF else None
        ),
    }


# ── Weight update from feature importances ───────────────────────────────────

def _update_weights(model, model_type, conn):
    """Push ML feature importances into indicator_weights table."""
    try:
        feat_names = ['ema_score', 'macd_score', 'rsi_score', 'vol_score',
                      'adx', 'vol_ratio', 'rsi', 'up_votes', 'down_votes',
                      'signal_type', 'divergence', 'mtf_align', 'composite', 'score']
        ind_map = {
            'ema_score':  'ema',
            'macd_score': 'macd',
            'rsi_score':  'rsi',
            'vol_score':  'vol',
        }

        if model_type == 'RandomForest':
            importances = model.feature_importances_
        else:
            importances = np.abs(model.coef_[0])

        total = importances.sum()
        if total > 0:
            importances = importances / total

        cur = conn.cursor()
        for feat, imp in zip(feat_names, importances):
            ind = ind_map.get(feat)
            if ind is None:
                continue
            w = round(max(0.02, min(0.40, float(imp))), 4)
            for tf in ('1d', '4h', '1h', '15m'):
                cur.execute(
                    '''
                    INSERT INTO indicator_weights
                        (timeframe, indicator, weight, win_rate, sample_count, last_updated)
                    VALUES (%s,%s,%s,NULL,0,NOW())
                    ON CONFLICT (timeframe, indicator)
                    DO UPDATE SET weight=EXCLUDED.weight,
                                  last_updated=EXCLUDED.last_updated
                    ''',
                    (tf, ind, w),
                )
        cur.close()
        print('[ml] indicator weights updated from feature importances')
    except Exception as e:
        print(f'[ml] weight update error: {e}')
