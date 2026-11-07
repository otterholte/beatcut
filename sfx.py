"""Subtle edit sound effects, synthesised so they are always in sync and cost nothing:
tick (a tile popping in), whoosh (a riser into a big change; "d" makes it longer), flash (a white frame), thump (a hard
cut), pop (title), impact (a drop), slap (a photo landing). Each effect is {"t": seconds, "k": kind, "pan": -1..1, "g": gain}. Effects land exactly on the frame they belong to."""
import numpy as np

def _env(n, a, d, sr):
    t = np.arange(n) / sr
    return np.minimum(1, t / max(a, 1e-4)) * np.exp(-t / d)

def _lp(x, a):
    # one-pole low-pass, a in 0..1 (bigger = darker), per-sample coefficient allowed
    y = np.empty_like(x); acc = 0.0
    a = np.broadcast_to(a, x.shape)
    for i in range(len(x)):
        acc += (1 - a[i]) * (x[i] - acc); y[i] = acc
    return y

def tick(sr, rnd):
    n = int(0.05 * sr); t = np.arange(n) / sr
    f = 2600 * rnd.uniform(0.85, 1.2)
    body = np.sin(2 * np.pi * f * t) * _env(n, 0.0004, 0.006, sr)
    click = np.random.default_rng(rnd.randrange(1 << 30)).standard_normal(n) * _env(n, 0.0001, 0.0015, sr)
    low = np.sin(2 * np.pi * 180 * t) * _env(n, 0.001, 0.012, sr) * 0.6
    return (body * 0.5 + click * 0.35 + low) * 0.22

def whoosh(sr, rnd, d=0.45):
    n = int(d * sr); p = np.linspace(0, 1, n)
    x = np.random.default_rng(rnd.randrange(1 << 30)).standard_normal(n)
    y = _lp(x, 0.985 - 0.17 * p ** 2)
    y = y - _lp(y, 0.995)
    return y / (np.abs(y).max() + 1e-9) * (p ** 2.2) * np.minimum(1, (1 - p) * 40) * 0.16

def flash(sr, rnd):
    n = int(0.18 * sr)
    x = np.random.default_rng(rnd.randrange(1 << 30)).standard_normal(n)
    hi = x - _lp(x, 0.6)
    tk = tick(sr, rnd)
    return np.concatenate([tk, np.zeros(n - len(tk))]) * 0.8 + hi * _env(n, 0.0005, 0.035, sr) * 0.10

def thump(sr, rnd):
    n = int(0.35 * sr); t = np.arange(n) / sr
    f = 75 * np.exp(-t * 6) + 42
    return np.sin(2 * np.pi * np.cumsum(f) / sr) * _env(n, 0.002, 0.09, sr) * 0.28

def pop(sr, rnd):
    n = int(0.12 * sr); t = np.arange(n) / sr
    f = 520 + 900 * np.exp(-t * 40)
    return np.sin(2 * np.pi * np.cumsum(f) / sr) * _env(n, 0.001, 0.03, sr) * 0.12

def impact(sr, rnd):
    # a hit for drops and big cuts: the low thump plus a short, gritty crack
    n = int(0.5 * sr)
    x = np.random.default_rng(rnd.randrange(1 << 30)).standard_normal(n)
    crack = np.tanh((x - _lp(x, 0.3)) * 3) * _env(n, 0.0003, 0.025, sr) * 0.10
    th = thump(sr, rnd); th = np.concatenate([th, np.zeros(n - len(th))])
    return th * 1.2 + crack

def slap(sr, rnd):
    # a photo landing on a table: a soft, papery slap
    n = int(0.09 * sr)
    x = np.random.default_rng(rnd.randrange(1 << 30)).standard_normal(n)
    return _lp(x, 0.55) * _env(n, 0.0008, 0.012, sr) * 0.5 + thump(sr, rnd)[:n] * 0.25

def glitch(sr, rnd):
    # a digital tear: stuttering sample-and-hold noise, like a corrupted buffer
    n = int(0.14 * sr); r = np.random.default_rng(rnd.randrange(1 << 30))
    hold = int(r.integers(20, 160)); x = np.repeat(r.uniform(-1, 1, n // hold + 1), hold)[:n]
    gate = np.repeat(r.random(n // 900 + 1) > 0.35, 900)[:n]
    return x * gate * _env(n, 0.0005, 0.06, sr) * 0.09

KINDS = {'glitch': glitch, 'tick': tick, 'whoosh': whoosh, 'flash': flash, 'thump': thump, 'pop': pop, 'impact': impact, 'slap': slap}

def render(events, n, sr, rnd):
    out = np.zeros((n, 2), np.float32)
    for e in events:
        s = (whoosh(sr, rnd, e['d']) if e['k'] == 'whoosh' and 'd' in e else KINDS[e['k']](sr, rnd)) * e.get('g', 1.0)
        # a whoosh ends on its moment, everything else starts on it
        i = int(round(e['t'] * sr)) - (len(s) if e['k'] == 'whoosh' else 0)
        pan = e.get('pan', 0.0); gl, gr = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        a, b = max(0, i), min(n, i + len(s))
        if b <= a: continue
        seg = s[a - i:b - i]
        out[a:b, 0] += seg * gl * 1.41; out[a:b, 1] += seg * gr * 1.41
    return out
