"""Beat grid of a song: tempo, beat times and downbeats (bar starts). Onsets from mel bands; beats tracked through the
song by dynamic programming, so a drifting tempo is followed and faint beats simply keep to the tempo."""
import subprocess
import numpy as np

SR = 44100

def load(path, ff):
    raw = subprocess.run([ff, '-v', 'error', '-i', path, '-f', 's16le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, '<i2').reshape(-1, 2).astype(np.float32) / 32768, SR

def mel_bank(n, sr, bands=48, lo=30.0, hi=11000.0):
    mel = lambda f: 2595 * np.log10(1 + f / 700); inv = lambda m: 700 * (10 ** (m / 2595) - 1)
    edges = inv(np.linspace(mel(lo), mel(hi), bands + 2)); f = np.fft.rfftfreq(n, 1 / sr)
    M = np.zeros((bands, len(f)), np.float32)
    for i in range(bands):
        a, c, b = edges[i], edges[i + 1], edges[i + 2]
        M[i] = np.clip(np.minimum((f - a) / (c - a), (b - f) / (b - c)), 0, None)
    return M, edges[1:-1]

def onsets(mono, sr, hop, n=2048):
    """Onset strength per hop, all bands and the low end (kick / bass) alone: positive change in log energy of mel
    bands, so lows and mids count as much as the hiss up top (as in standard beat trackers)."""
    win = np.hanning(n)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(mono, (n // 2, n)), n)[::hop]
    M, centres = mel_bank(n, sr)
    out = []
    for i in range(0, len(frames), 4096):           # in blocks, to keep memory small on long songs
        S = np.abs(np.fft.rfft(frames[i:i + 4096] * win, axis=1)) ** 2
        out.append(np.log10(1e-10 + S @ M.T) * 10)
    E = np.vstack(out)
    E = np.maximum(E, E.max() - 80)
    D = np.maximum(0, np.diff(E, axis=0, prepend=E[:1]))
    clean = lambda d: np.maximum(d - np.convolve(d, np.ones(16) / 16, 'same'), 0)    # remove the slow swell
    return clean(D.mean(1)), clean(D[:, centres < 200].mean(1))

def track(o, period, tight=300.0):
    """Beat times (in frames) that follow the song: dynamic programming over the onset envelope, as in Ellis (2007).
    Each beat is the best onset about one period after the last one; straying from the tempo costs `tight`, so a song
    that drifts is followed, and where the onsets are faint the beats simply keep to the tempo."""
    n = len(o); o = o / (o.std() + 1e-9)
    lags = np.arange(max(1, int(round(period / 2))), int(round(period * 2)) + 1)
    pen = -tight * np.log(lags / period) ** 2
    C, P = o.astype(np.float64).copy(), np.full(n, -1)
    for t in range(lags[0], n):
        ps = t - lags; ok = ps >= 0
        cand = C[ps[ok]] + pen[ok]; j = int(np.argmax(cand))
        if cand[j] > 0: C[t] += cand[j]; P[t] = ps[ok][j]
    # the last beat: the strongest chain ending in the final period
    tail = np.arange(max(0, n - int(period * 1.5)), n)
    t = int(tail[np.argmax(C[tail])]); out = []
    while t >= 0: out.append(t); t = P[t]
    b = np.array(out[::-1], np.float64)
    # carry the grid on at the tempo before the first and after the last tracked beat (silence, a fade)
    head = np.arange(b[0] - period, -period, -period)[::-1]; rest = np.arange(b[-1] + period, n + period, period)
    return np.concatenate([head, b, rest])

def hook(audio, sr, grid, seconds):
    """The downbeat where the best `seconds` of a long song start: loud throughout, and best of all where the song
    jumps up (a chorus or drop coming in) - the part a short video would use."""
    mono = audio.mean(1); w = int(0.05 * sr)
    loud = np.sqrt(np.convolve(mono ** 2, np.ones(w) / w, 'same')[::w] + 1e-9); rate = sr / w
    avg = lambda a, b: loud[max(0, int(a * rate)):max(1, int(b * rate))].mean()
    bar, total = grid['bar'], len(mono) / sr
    cands = [d for d in grid['downbeats'] if d >= 0 and d + seconds <= total]
    if not cands: return next(d for d in grid['downbeats'] if d >= -1e-3)
    g = loud.mean()
    score = lambda d: avg(d, d + seconds) / g + 0.5 * min(2, max(0, avg(d, d + 2 * bar) / max(avg(d - 2 * bar, d), 1e-6) - 1))
    return max(cands, key=score)

def analyse(audio, sr):
    mono = audio.mean(1)
    hop = 256; rate = sr / hop
    env, low = onsets(mono, sr, hop)
    env = env / (env.max() + 1e-9); low = low / (low.max() + 1e-9)
    # tempo: autocorrelation over 70..180 BPM, nudged towards ~110 so double/half tempo are not picked
    ac = np.correlate(env, env, 'full')[len(env) - 1:]
    best, period = -1, None
    for bpm in np.arange(70, 180, 0.1):
        lag = rate * 60 / bpm
        i = int(lag); fr = lag - i
        if i + 1 >= len(ac): continue
        v = (ac[i] * (1 - fr) + ac[i + 1] * fr)
        for k in (2, 4):   # a real beat lines up at 2 and 4 beats too
            j = lag * k; ii = int(j)
            if ii + 1 < len(ac): v += 0.5 * (ac[ii] * (1 - (j - ii)) + ac[ii + 1] * (j - ii))
        v *= np.exp(-0.5 * (np.log2(bpm / 110) / 0.9) ** 2)
        if v > best: best, period = v, lag
    samp = lambda e, pos: np.interp(pos, np.arange(len(e)), e)
    # beats: tracked through the song so a drifting tempo is followed. The kick counts most, so off-beat hi-hats
    # don't pull the beats half a beat off.
    # (only when the low end has a steady pulse of its own: songs without drums have none)
    def comb(e):
        c = [samp(e, np.arange(p, len(e) - 1, period)).mean() for p in np.arange(0, period, 0.5)]
        return max(c) / (np.mean(c) + 1e-9)
    o = env + (1.5 * low if comb(low) > 1.4 else 0)
    pos = track(o, period)
    # clarity: how much stronger the onsets are on the beats than on average; faint beats keep strictly to the tempo
    clarity = samp(o, pos[(pos >= 0) & (pos < len(o) - 1)]).mean() / (o.mean() + 1e-9)
    if clarity < 1.6: pos = track(o, period, tight=1000)
    beats = pos / rate
    period = float(np.median(np.diff(pos)))
    # a drop: the moment the song gets much louder (1 s after against 1 s before)
    w = int(0.02 * sr); loud = np.sqrt(np.convolve(mono ** 2, np.ones(w) / w, 'same')[::w] + 1e-9)
    # (a floor under "before" so a song fading in from silence is not a drop)
    n = 50; floor = 0.15 * np.median(loud)
    ratio = np.array([loud[i:i + n].mean() / max(floor, loud[i - n:i].mean()) for i in range(n, len(loud) - n)])
    drop = None
    if len(ratio) and ratio.max() > 3:
        i = int(np.argmax(ratio)) + n
        while i > n and loud[i - 1] > max(floor, loud[i - n:i].mean()) * 2: i -= 1      # back to the very start of the hit
        drop_t = i * w / sr
        j = int(np.argmin(np.abs(beats - drop_t))); B = period / rate
        # the drop is on a beat: when the beats sit half a beat off (locked to off-beat hats), use the half-way points
        if abs(beats[j] - drop_t) > B * 0.25:
            beats = (beats[:-1] + beats[1:]) / 2; j = int(np.argmin(np.abs(beats - drop_t)))
        drop = j
    if drop is not None: k = drop % 4
    else:
        bpos = beats * rate
        lows = [samp(low, bpos[k::4]).mean() + 0.5 * samp(env, bpos[k::4]).mean() for k in range(4)]
        k = int(np.argmax(lows))
    down = beats[k::4]
    # bars before the first full one still count (a pickup), so the edit can start at 0
    bar = period * 4 / rate
    while down[0] - bar > -0.05: down = np.insert(down, 0, down[0] - bar)
    return {'bpm': 60 * rate / period, 'beat': period / rate, 'bar': bar, 'beats': [float(b) for b in beats],
            'drop': None if drop is None else float(beats[drop]),
            'downbeats': [float(d) for d in down if d > -bar]}
