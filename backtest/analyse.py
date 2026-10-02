"""Backtest analysis on the collected data (backtest/data/*.json).

Test 1 - does Jev call it right?  Compare what the price did after each kind of call.
Test 2 - would the rules have made money?  Simulate rule sets with costs; tune on the first
         half of the history, judge on the second half.
Usage: python3 analyse.py stock|crypto
"""
import json, glob, sys, math, random
import numpy as np

KIND = sys.argv[1] if len(sys.argv) > 1 else 'stock'
COST = {'stock': 0.20, 'crypto': 0.70}[KIND]        # % per side: fee/FX + slippage (ASSUMPTION)
HZ = {'stock': [5, 10, 20], 'crypto': [10, 24, 72]}[KIND]   # look-ahead in bars (days / hours)
STEP = {'stock': 1, 'crypto': 4}[KIND]               # bars between decision points
START = 10000.0


def load():
    assets = {}
    for f in sorted(glob.glob('data/*.json')):
        d = json.load(open(f))
        if d['kind'] != KIND or not d['ans']:
            continue
        bars = np.array(d['bars'], dtype=float)      # t, o, h, l, c, v
        ans = {}
        for k, v in d['ans'].items():
            p = v.split('|')
            if p[0] == '?' or '' in p:
                continue
            ans[int(k)] = dict(trend=p[0], tconf=float(p[1]), mom=float(p[2]), mconf=float(p[3]),
                               over=float(p[4]), brk=float(p[5]), rise=float(p[6]))
        assets[d['id']] = dict(bars=bars, ans=ans)
    return assets


def sma(c, i, n): return c[i - n + 1:i + 1].mean()


def rsi(c, i, n=14):
    d = np.diff(c[max(0, i - 109):i + 1])
    g, l = np.maximum(d, 0), np.maximum(-d, 0)
    ag, al = g[:n].mean(), l[:n].mean()
    for k in range(n, len(d)):
        ag, al = (ag * (n - 1) + g[k]) / n, (al * (n - 1) + l[k]) / n
    return 100.0 if al == 0 else 100 - 100 / (1 + ag / al)


def formula(bars, i):
    """The same judgement made by fixed formulas, no AI (the live bot's account C logic)."""
    c = bars[:, 4]; p = c[i]
    s20, s50 = sma(c, i, 20), sma(c, i, 50)
    ch72, ch6 = p / c[i - 72] - 1, (p / c[i - 6] - 1) * 100
    hi, lo = bars[i - 71:i + 1, 2].max(), bars[i - 71:i + 1, 3].min()
    up = p > s20 > s50 and ch72 > 0
    dn = p < s20 < s50 and ch72 < 0
    rp = (p - lo) / (hi - lo) * 100 if hi > lo else 50
    return dict(trend='u' if up else 'd' if dn else 's', tconf=1.0, mom=3.0 if ch6 > 0.5 else 2.0, mconf=1.0,
                over=1.0 if (rsi(c, i) > 70 or rp > 95) else 0.0, brk=1.0 if p <= lo * 1.01 else 0.0,
                rise=0.5 + max(-0.4, min(0.4, ch72)))


# ------------------------------------------------------------------ Test 1: call quality
def test1(assets):
    print(f'\n=== TEST 1: what the price did after each call ({KIND}) ===')
    rows = []                                         # (time, asset, jev, formula, fwd returns)
    for a, d in assets.items():
        b = d['bars']; c = b[:, 4]
        for i, j in d['ans'].items():
            if i < 110: continue
            fw = [(c[i + h] / c[i] - 1) * 100 if i + h < len(c) else np.nan for h in HZ]
            rows.append((b[i, 0], a, j, formula(b, i), fw))
    print(f'{len(rows):,} decision points across {len(assets)} assets')
    t = np.array([r[0] for r in rows]); fw = np.array([r[4] for r in rows])
    # market-adjust: subtract the average of all assets at the same moment, so a rising market isn't mistaken for skill
    adj = fw.copy()
    for tt in np.unique(t):
        m = t == tt
        adj[m] = fw[m] - np.nanmean(fw[m], axis=0)

    def report(name, mask):
        mask = np.asarray(mask)
        out = f'  {name:<44} n={mask.sum():>6,} '
        for k, h in enumerate(HZ):
            x, xa = fw[mask, k], adj[mask, k]
            ok = ~np.isnan(x)
            if ok.sum() < 30: out += f'| {h:>2}: too few '; continue
            # t-stat on per-moment means of the market-adjusted return (moments, not rows, are the independent units)
            tm = t[mask][ok]; per = np.array([xa[ok][tm == u].mean() for u in np.unique(tm)])
            per = per[::max(1, h // STEP)]            # thin out overlapping windows
            ts = per.mean() / (per.std(ddof=1) / math.sqrt(len(per))) if len(per) > 5 and per.std() > 0 else float('nan')
            out += f'| {h:>2}: {x[ok].mean():+.2f}% up {100 * (x[ok] > 0).mean():.0f}% vs-mkt {xa[ok].mean():+.2f}% (t={ts:+.1f}) '
        print(out)

    J = [r[2] for r in rows]; F = [r[3] for r in rows]
    entry = lambda s: s['trend'] == 'u' and s['tconf'] >= 0.7 and s['mom'] >= 3 and s['mconf'] >= 0.6 and s['over'] < 0.5
    print(f'  look-ahead in bars: {HZ}.  "vs-mkt" = return minus the average asset at the same moment.')
    report('ALL moments (the base rate)', [True] * len(rows))
    report('Jev: trend up', [s['trend'] == 'u' for s in J])
    report('Jev: trend down', [s['trend'] == 'd' for s in J])
    report('Jev: full BUY signal (live rules)', [entry(s) for s in J])
    report('Jev: momentum >= 3.5', [s['mom'] >= 3.5 for s in J])
    report('Jev: overextended >= 0.5', [s['over'] >= 0.5 for s in J])
    report('Jev: breakdown >= 0.5', [s['brk'] >= 0.5 for s in J])
    rise = np.array([s['rise'] for s in J]); qs = np.quantile(rise, [0.2, 0.8])
    report(f'Jev: "will rise" top 20% (>= {qs[1]:.2f})', rise >= qs[1])
    report(f'Jev: "will rise" bottom 20% (<= {qs[0]:.2f})', rise <= qs[0])
    report('Formula: trend up', [s['trend'] == 'u' for s in F])
    report('Formula: trend down', [s['trend'] == 'd' for s in F])
    report('Formula: full BUY signal', [entry(s) for s in F])
    k = 1; ok = ~np.isnan(fw[:, k])
    print(f'  Jev "will rise" score vs what happened over {HZ[k]} bars: correlation {np.corrcoef(rise[ok], fw[ok, k])[0, 1]:+.3f}, '
          f'vs-market {np.corrcoef(rise[ok], adj[ok, k])[0, 1]:+.3f}')
    agree = np.mean([j['trend'] == f['trend'] for j, f in zip(J, F)])
    print(f'  Jev and the formula give the same trend label {100 * agree:.0f}% of the time')


# ------------------------------------------------------------------ Test 2: trading simulation
def simulate(assets, sig, P, t_from, t_to, seed=None):
    """One shared account. Decide at a bar's close, trade at the next bar's open, pay COST each side.
    P: entry(s)->bool, exit(s)->bool, stop %, target % (None = none), trail (bool), size %, max positions."""
    rng = random.Random(seed) if seed is not None else None
    times = sorted({b[0] for d in assets.values() for b in d['bars'] if t_from <= b[0] < t_to})
    idx = {a: {b[0]: i for i, b in enumerate(d['bars'])} for a, d in assets.items()}
    cash, pos, trades, curve, pending = START, {}, [], [], []
    names = sorted(assets)
    for t in times:
        # 1. carry out orders decided at the previous bar, at this bar's open
        for a, side in pending:
            i = idx[a].get(t)
            if i is None: continue
            o = assets[a]['bars'][i, 1]
            if side == 'buy' and a not in pos and len(pos) < P['maxpos']:
                eq = cash + sum(p['qty'] * p['last'] for p in pos.values())
                spend = min(cash, eq * P['size'] / 100)
                if spend < 50: continue
                fill = o * (1 + COST / 100)
                pos[a] = dict(qty=spend / fill, cost=spend, entry=o, high=o, stop=o * (1 - P['stop'] / 100), last=o)
                cash -= spend
            elif side == 'sell' and a in pos:
                p = pos.pop(a); got = p['qty'] * o * (1 - COST / 100); cash += got
                trades.append((got / p['cost'] - 1) * 100)
        pending = []
        # 2. stops and targets inside this bar, then this bar's decisions
        for a in names:
            i = idx[a].get(t)
            if i is None: continue
            b = assets[a]['bars'][i]
            if a in pos:
                p = pos[a]; exitp = None
                if b[3] <= p['stop']: exitp = min(p['stop'], b[1])          # gap down fills at the open
                elif P['target'] and b[2] >= p['entry'] * (1 + P['target'] / 100): exitp = max(p['entry'] * (1 + P['target'] / 100), b[1])
                if exitp is not None:
                    pos.pop(a); got = p['qty'] * exitp * (1 - COST / 100); cash += got
                    trades.append((got / p['cost'] - 1) * 100); continue
                p['last'] = b[4]
                if P['trail']:
                    p['high'] = max(p['high'], b[2]); p['stop'] = max(p['stop'], p['high'] * (1 - P['stop'] / 100))
            s = sig[a].get(i)
            if s is None: continue
            if a in pos:
                if P['exit'](s): pending.append((a, 'sell'))
            elif rng is not None:
                if rng.random() < P['rand_rate']: pending.append((a, 'buy'))
            elif P['entry'](s): pending.append((a, 'buy'))
        curve.append(cash + sum(p['qty'] * p['last'] for p in pos.values()))
    curve = np.array(curve); peak = np.maximum.accumulate(curve)
    tr = np.array(trades) if trades else np.array([0.0])
    return dict(ret=(curve[-1] / START - 1) * 100, dd=((peak - curve) / peak).max() * 100, n=len(trades),
                win=100 * (tr > 0).mean() if trades else 0, avg=tr.mean() if trades else 0)


def hold(assets, t_from, t_to):
    r = []
    for d in assets.values():
        b = d['bars']; m = (b[:, 0] >= t_from) & (b[:, 0] < t_to)
        if m.sum() > 2: r.append(b[m][-1, 4] / b[m][0, 1] * (1 - COST / 100) - 1)
    return 100 * np.mean(r)


def test2(assets):
    print(f'\n=== TEST 2: would the rules have made money? ({KIND}, cost {COST}% per side) ===')
    jev = {a: d['ans'] for a, d in assets.items()}
    frm = {a: {i: formula(d['bars'], i) for i in d['ans']} for a, d in assets.items()}
    ts = sorted({d['bars'][i, 0] for d in assets.values() for i in d['ans']})
    t0, tm, t1 = ts[0], ts[len(ts) // 2], ts[-1] + 1
    day = lambda t: np.datetime64(int(t), 's').astype('datetime64[D]')
    print(f'  tune on {day(t0)} to {day(tm)}; judge on {day(tm)} to {day(t1)} (never seen while tuning)')

    def rules(mom=3.0, over=0.5, stop=3, target=6, trail=False, size=10, maxpos=10, rise=None, exit_rise=None):
        if rise is not None:
            e = lambda s: s['rise'] >= rise and s['over'] < over
            x = lambda s: s['rise'] <= exit_rise
        else:
            e = lambda s: s['trend'] == 'u' and s['tconf'] >= 0.7 and s['mom'] >= mom and s['mconf'] >= 0.6 and s['over'] < over
            x = lambda s: (s['trend'] == 'd' and s['tconf'] >= 0.6) or s['brk'] >= 0.7
        return dict(entry=e, exit=x, stop=stop, target=target, trail=trail, size=size, maxpos=maxpos)

    grid = {'live rules (3% stop, 6% target)': rules()}
    for mom in (3.0, 3.3, 3.6):
        for stop, target, trail in ((5, 10, False), (8, 16, False), (8, None, True), (12, None, True)):
            for maxpos, size in ((5, 20), (10, 10)):
                grid[f'trend: mom>={mom} stop {stop}% {"trail" if trail else "target " + str(target) + "%"} max {maxpos}'] = rules(mom=mom, stop=stop, target=target, trail=trail, size=size, maxpos=maxpos)
    for rise, ex in ((0.55, 0.45), (0.6, 0.45), (0.65, 0.5), (0.7, 0.5)):
        for stop in (8, 12):
            grid[f'"will rise" >= {rise}, sell <= {ex}, trail {stop}% max 5'] = rules(rise=rise, exit_rise=ex, stop=stop, target=None, trail=True, size=20, maxpos=5)

    for label, sig in (('JEV', jev), ('FORMULA (no AI)', frm)):
        res = {k: simulate(assets, sig, P, t0, tm) for k, P in grid.items()}
        best = max((k for k in res if res[k]['n'] >= 15), key=lambda k: res[k]['ret'], default=None)
        print(f'\n  {label}')
        for k in ['live rules (3% stop, 6% target)'] + ([best] if best and best != 'live rules (3% stop, 6% target)' else []):
            a, b = res[k], simulate(assets, sig, grid[k], tm, t1)
            tag = 'best in tuning: ' if k == best else ''
            print(f'    {tag}{k}')
            print(f'      tuning half:  {a["ret"]:+7.1f}%  trades {a["n"]:>4}  won {a["win"]:.0f}%  avg {a["avg"]:+.2f}%  worst drop {a["dd"]:.0f}%')
            print(f'      judged half:  {b["ret"]:+7.1f}%  trades {b["n"]:>4}  won {b["win"]:.0f}%  avg {b["avg"]:+.2f}%  worst drop {b["dd"]:.0f}%')
        if label == 'JEV' and best:
            # control: same exits and stops, but entries at random, as often as Jev's
            P = dict(grid[best]); n_sig = sum(1 for a in jev for s in jev[a].values() if P['entry'](s)); n_all = sum(len(v) for v in jev.values())
            P['rand_rate'] = n_sig / n_all
            rr = [simulate(assets, jev, P, tm, t1, seed=s)['ret'] for s in range(20)]
            print(f'      control - same exits, RANDOM entries (20 runs), judged half: average {np.mean(rr):+.1f}%, range {min(rr):+.1f}% to {max(rr):+.1f}%')
        top = sorted(res, key=lambda k: -res[k]['ret'])[:5]
        print('      top 5 in tuning -> judged half: ' + '; '.join(f'{res[k]["ret"]:+.0f}% -> {simulate(assets, sig, grid[k], tm, t1)["ret"]:+.0f}%' for k in top))
    print(f'\n  Buy & hold all {len(assets)} equally:  tuning half {hold(assets, t0, tm):+.1f}%   judged half {hold(assets, tm, t1):+.1f}%')
    if KIND == 'stock':
        try:
            spy = {'SPY': dict(bars=np.array(json.load(open('data/SPY.json'))['bars'], dtype=float))}
            print(f'  S&P 500 (SPY):                 tuning half {hold(spy, t0, tm):+.1f}%   judged half {hold(spy, tm, t1):+.1f}%')
        except Exception as e:
            print('  (no SPY data)', e)


if __name__ == '__main__':
    A = load()
    if not A: sys.exit('no data yet')
    test1(A)
    test2(A)
