"""Template styles. A style turns the beat grid and the media into a Timeline: for every cell of a rows x cols grid, what it
shows from when (a source drawn into a rect: the whole frame = slices of one picture, a column, a row, or just the cell),
plus the sound effects that go with each change.

grid9   the viral 3x3 grid edit: one picture assembles tile by tile, columns wipe in, nine clips pop into the tiles,
        a picture rebuilds tile by tile, beat cuts, a two-picture checkerboard, tiles drop out at the end.
blinds  four vertical strips: wipes strip by strip on sixteenth notes, split screens, strip flashes.
pulse   one picture per beat with a zoom punch, a white flash every two bars.
"""
import bisect, itertools

class Timeline:
    def __init__(self, rows, cols, W, H, fps):
        self.rows, self.cols, self.W, self.H, self.fps = rows, cols, W, H, fps
        xs = [round(c * W / cols) for c in range(cols + 1)]; ys = [round(r * H / rows) for r in range(rows + 1)]
        self.cells = [(xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]) for r in range(rows) for c in range(cols)]
        self.xs, self.ys = xs, ys
        self.ev = [[] for _ in self.cells]
        self.sfx, self.titles, self.moves, self.end = [], [], [], 0

    def snap(self, t): return round(t * self.fps) / self.fps
    def frame(self, n=1): return n / self.fps

    def rect(self, kind, ci):
        r, c = divmod(ci, self.cols)
        if kind == 'full': return (0, 0, self.W, self.H)
        if kind == 'col': return (self.xs[c], 0, self.xs[c + 1] - self.xs[c], self.H)
        if kind == 'row': return (0, self.ys[r], self.W, self.ys[r + 1] - self.ys[r])
        return self.cells[ci]

    def put(self, t, ci, sid, kind='full', t0=None, punch=None):
        t = self.snap(t)
        c = {'k': 'src', 's': sid, 'rect': self.rect(kind, ci), 't0': self.snap(t if t0 is None else t0)}
        if punch is not None: c['punch'] = self.snap(punch)
        self._add(ci, t, c)

    def white(self, t, ci): self._add(ci, self.snap(t), {'k': 'white'})
    def clear(self, t, ci): self._add(ci, self.snap(t), None)

    def _add(self, ci, t, c):
        ev = self.ev[ci]
        i = bisect.bisect_right([e[0] for e in ev], t)
        # a later instruction for the same frame replaces the earlier one
        if i and ev[i - 1][0] == t: ev[i - 1] = (t, c)
        else: ev.insert(i, (t, c))

    def state(self, ci, t):
        ev = self.ev[ci]
        i = bisect.bisect_right([e[0] for e in ev], t + 1e-6)
        return ev[i - 1][1] if i else None

    def pan(self, ci):
        c = ci % self.cols
        return 0 if self.cols == 1 else (c / (self.cols - 1) * 2 - 1) * 0.6

    def sound(self, t, k, ci=None, g=1.0):
        self.sfx.append({'t': round(self.snap(t), 4), 'k': k, 'pan': 0 if ci is None else self.pan(ci), 'g': g})

    @property
    def events(self): return [e for ev in self.ev for e in ev]

class Pool:
    """Hands out the media in order, round and round."""
    def __init__(self, sources): self.n = len(sources); self.i = 0
    def take(self, k=None):
        if k is None:
            s = self.i % self.n; self.i += 1; return s
        return [self.take() for _ in range(k)]

def slots(grid, seconds, per_bar):
    """Move start times: every bar (or every two bars at fast tempos) from 0 until the song or the limit runs out."""
    bar = grid['bar']; per = per_bar if bar * per_bar >= 1.6 else per_bar * 2
    downs = [d for d in grid['downbeats'] if d >= -1e-3]
    starts = downs[::per]
    L = bar * per
    while starts and starts[-1] + L > seconds + 0.05: starts.pop()
    if len(starts) < 2: raise SystemExit('the song is too short for this style (needs at least two bars)')
    return starts, L

SPIRAL = [6, 3, 0, 1, 2, 5, 8, 7, 4]          # the template's assemble order: up the left, across, down the right, centre last
SPIRAL_R = [5, 8, 7, 6, 3, 0, 1, 2, 4]
CROSS, CORNERS = [1, 3, 5, 7], [0, 2, 6, 8]

def grid9(grid, sources, seconds, fps, W, H, rnd, has_title):
    tl = Timeline(3, 3, W, H, fps); pool = Pool(sources); B = grid['beat']
    pop = max(1, round(fps * 0.04)) / fps          # one tile per frame, like the template
    build_step = max(2, round(fps * 0.075)) / fps
    starts, L = slots(grid, seconds, 1)
    body = ['columns', 'mosaic', 'build', 'cuts', 'checker', 'rows', 'mosaic', 'build', 'checker', 'cuts']
    plan = ['assemble'] + [m for m, _ in zip(itertools.cycle(body), starts[1:])]
    # the last move shows one picture, so the drop-out at the end breaks a whole image apart like the template
    if len(plan) > 2 and plan[-1] not in ('build', 'cuts', 'checker'): plan[-1] = 'build'
    state = {'full': None}

    def full(t, sid, t0=None, sound='thump', g=0.7):
        for ci in range(9): tl.put(t, ci, sid, 'full', t0 if t0 is not None else t)
        if sound: tl.sound(t, sound, g=g)
        state['full'] = (sid, t0 if t0 is not None else t)

    for t, move in zip(starts, plan):
        tl.moves.append({'t': round(t, 3), 'move': move})
        if move == 'assemble':
            a = pool.take()
            for i, ci in enumerate(SPIRAL):
                tl.put(t + i * pop, ci, a, 'full', t0=t); tl.sound(t + i * pop, 'tick', ci, 0.8)
            state['full'] = (a, t)
            if has_title:
                t1 = t + min(2 * B, L * 0.5)
                tl.titles.append((tl.snap(t1), tl.snap(t + L - 2 / fps))); tl.sound(t1, 'pop', g=0.8)
        elif move in ('columns', 'rows'):
            tl.sound(t, 'whoosh', g=0.5)
            for k in range(3):
                s, tk = pool.take(), t + k * B / 4
                for j in range(3):
                    ci = j * 3 + k if move == 'columns' else k * 3 + j
                    tl.put(tk, ci, s, 'col' if move == 'columns' else 'row', t0=tk)
                tl.sound(tk, 'tick', k * 3 + 1 if move == 'columns' else 4, 1.0)
            state['full'] = None
        elif move == 'mosaic':
            tl.sound(t, 'whoosh', g=0.6)
            order = list(range(9)); rnd.shuffle(order)
            for i, ci in enumerate(order):
                tl.put(t + i * pop, ci, pool.take(), 'cell', t0=t); tl.sound(t + i * pop, 'tick', ci, 0.7)
            # an accent: one tile blinks white an eighth before the next bar
            ci = rnd.choice([c for c in range(9) if c != 4] + [4, 4])
            tf = t + L - B / 2
            prev = tl.state(ci, tf)
            tl.white(tf, ci); tl._add(ci, tl.snap(tf + 2 / fps), prev); tl.sound(tf, 'flash', ci, 0.9)
            state['full'] = None
        elif move == 'build':
            e = pool.take(); order = SPIRAL_R if rnd.random() < 0.5 else SPIRAL[::-1][1:] + [4]
            for i, ci in enumerate(order):
                tl.put(t + i * build_step, ci, e, 'full', t0=t); tl.sound(t + i * build_step, 'tick', ci, 0.75)
            state['full'] = (e, t)
        elif move == 'cuts':
            for k in range(3): full(t + k * B, pool.take(), g=0.55 if k else 0.75)
        elif move == 'checker':
            tl.sound(t, 'whoosh', g=0.6)
            a, b = pool.take(), pool.take()
            for ci in range(9): tl.white(t, ci)
            tl.sound(t, 'flash', g=1.0)
            for ci in range(9): tl.put(t + 1 / fps, ci, a if ci in CORNERS + [4] else b, 'full', t0=t)
            tr = t + min(2 * B, L * 0.55)
            for ci in CROSS: tl.put(tr, ci, a, 'full', t0=t)
            tl.sound(tr, 'tick', g=1.0)
            state['full'] = (a, t)
    end = starts[-1] + L
    # tiles drop out on the last beat: the cross, then the corners, the centre last
    tout = end - B
    for ci in CROSS: tl.clear(tout, ci)
    tl.sound(tout, 'tick', g=1.0)
    for i, ci in enumerate(CORNERS):
        tl.clear(tout + (i + 1) * 2 * pop, ci); tl.sound(tout + (i + 1) * 2 * pop, 'tick', ci, 0.8)
    tl.clear(tout + 6 * 2 * pop / 1.5, 4); tl.sound(tout + 6 * 2 * pop / 1.5, 'tick', g=0.9)
    tl.end = tl.snap(end + 0.3)
    return tl

def blinds(grid, sources, seconds, fps, W, H, rnd, has_title, n=4):
    tl = Timeline(1, n, W, H, fps); pool = Pool(sources); B = grid['beat']
    starts, L = slots(grid, seconds, 1)
    s16 = B / 4
    for i, t in enumerate(starts):
        kind = 'wipe' if i % 2 == 0 else 'split'
        tl.moves.append({'t': round(t, 3), 'move': kind})
        order = list(range(n)) if i % 4 < 2 else list(range(n))[::-1]
        if kind == 'wipe':
            s = pool.take()
            for k, ci in enumerate(order):
                tl.put(t + k * s16, ci, s, 'full', t0=t); tl.sound(t + k * s16, 'tick', ci, 0.9)
        else:
            for k, ci in enumerate(order):
                tl.put(t + k * s16, ci, pool.take(), 'cell', t0=t + k * s16); tl.sound(t + k * s16, 'tick', ci, 0.9)
            ci = rnd.randrange(n); tf = t + 2 * B; prev = tl.state(ci, tf)
            tl.white(tf, ci); tl._add(ci, tl.snap(tf + 2 / fps), prev); tl.sound(tf, 'flash', ci, 0.8)
        if i == 0 and has_title:
            tl.titles.append((tl.snap(t + 2 * B), tl.snap(t + L - 2 / fps))); tl.sound(t + 2 * B, 'pop', g=0.8)
        if i + 1 < len(starts) and (i + 1) % 2 == 0: tl.sound(starts[i + 1], 'whoosh', g=0.5)
    end = starts[-1] + L
    for k in range(n):
        tl.clear(end - B + k * s16, k); tl.sound(end - B + k * s16, 'tick', k, 0.8)
    tl.end = tl.snap(end + 0.3)
    return tl

def pulse(grid, sources, seconds, fps, W, H, rnd, has_title):
    tl = Timeline(1, 1, W, H, fps); pool = Pool(sources); B = grid['beat']
    starts, L = slots(grid, seconds, 1)
    end = starts[-1] + L
    beats = [b for b in grid['beats'] if -1e-3 <= b < end - B / 2]
    downs = set(round(d, 3) for d in grid['downbeats'])
    for i, b in enumerate(beats):
        bar_start = round(b, 3) in downs
        s = pool.take(); tl.put(b, 0, s, 'full', t0=b, punch=b)
        tl.sound(b, 'thump' if bar_start else 'tick', g=0.6 if bar_start else 0.7)
        if bar_start and i % 8 == 0 and i:
            tl.white(b, 0); tl.put(b + 1 / fps, 0, s, 'full', t0=b, punch=b); tl.sound(b, 'flash')
    tl.moves = [{'t': round(s, 3), 'move': 'beat cuts'} for s in starts]
    if has_title: tl.titles.append((tl.snap(starts[0]), tl.snap(starts[0] + L)))
    tl.clear(end - B / 2, 0); tl.sound(end - B / 2, 'tick')
    tl.end = tl.snap(end + 0.3)
    return tl

STYLES = {'grid9': grid9, 'blinds': blinds, 'pulse': pulse}
