"""Beat grid of a song: tempo, beat times and downbeats (bar starts), from spectral flux. Works best on music with a
steady tempo (pop, electronic, hip-hop, most template songs)."""
import subprocess
import numpy as np

SR = 44100

def load(path, ff):
    raw = subprocess.run([ff, '-v', 'error', '-i', path, '-f', 's16le', '-ac', '2', '-ar', str(SR), '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, '<i2').reshape(-1, 2).astype(np.float32) / 32768, SR

def flux(mono, sr, hop, lo, hi, n=2048):
    win = np.hanning(n)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(mono, (n // 2, n)), n)[::hop]
    S = np.abs(np.fft.rfft(frames * win, axis=1))
    f = np.fft.rfftfreq(n, 1 / sr); m = (f >= lo) & (f < hi)
    L = np.log1p(S[:, m] * 20)
    d = np.maximum(0, np.diff(L, axis=0, prepend=L[:1])).sum(1)
    d = d - np.convolve(d, np.ones(16) / 16, 'same')           # remove the slow loudness swell
    return np.maximum(d, 0)

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
    env = flux(mono, sr, hop, 30, 16000)
    low = flux(mono, sr, hop, 30, 160)
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
    # phase: where a comb at that period catches the most onsets
    idx = lambda ph: np.arange(ph, len(env) - 1, period)
    samp = lambda e, pos: np.interp(pos, np.arange(len(e)), e)
    phases = np.arange(0, period, 0.25)
    # the kick counts most: off-beat hi-hats would otherwise pull the grid half a beat off
    ph = phases[int(np.argmax([samp(env, idx(p)).sum() + 1.5 * samp(low, idx(p)).sum() for p in phases]))]
    # a drop: the moment the song gets much louder (1 s after against 1 s before)
    w = int(0.02 * sr); loud = np.sqrt(np.convolve(mono ** 2, np.ones(w) / w, 'same')[::w] + 1e-9)
    # (a floor under "before" so a song fading in from silence is not a drop)
    n = 50; floor = 0.15 * np.median(loud)
    ratio = np.array([loud[i:i + n].mean() / max(floor, loud[i - n:i].mean()) for i in range(n, len(loud) - n)])
    drop = drop_t = None
    if len(ratio) and ratio.max() > 3:
        i = int(np.argmax(ratio)) + n
        while i > n and loud[i - 1] > max(floor, loud[i - n:i].mean()) * 2: i -= 1      # back to the very start of the hit
        drop_t = i * w / sr
        b = idx(ph) / rate; off = (drop_t - b[0]) % (period / rate)
        # the drop is on a beat: when the grid sits half a beat off (locked to off-beat hats), move it
        if period / rate * 0.25 < off < period / rate * 0.75: ph = (ph + period / 2) % period
    beats = idx(ph) / rate
    if drop_t is not None: drop = int(np.argmin(np.abs(beats - drop_t)))
    if drop is not None: k = drop % 4
    else:
        lows = [samp(low, idx(ph)[k::4]).mean() + 0.5 * samp(env, idx(ph)[k::4]).mean() for k in range(4)]
        k = int(np.argmax(lows))
    down = beats[k::4]
    # bars before the first full one still count (a pickup), so the edit can start at 0
    bar = period * 4 / rate
    while down[0] - bar > -0.05: down = np.insert(down, 0, down[0] - bar)
    return {'bpm': 60 * rate / period, 'beat': period / rate, 'bar': bar, 'beats': [float(b) for b in beats],
            'drop': None if drop is None else float(beats[drop]),
            'downbeats': [float(d) for d in down if d > -bar]}
