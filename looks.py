"""More free-form styles (see scenes.py for the idea).

zoomthru   3D zoom: a new photo on every beat, arriving through a zoom blur with a slight tilt; flash on the bar.
glitch     glitch / "flash warning": torn slices, RGB split and inverted blocks on every cut, scanlines, a full
           invert on the bar, digital-tear sounds.
dreamy     soft aesthetic slideshow: a photo per bar, blur dissolves, glow, a drifting warm light leak, film grain.
swipe      swipe stack: each photo slides in over the last (with a little overshoot and an edge shadow), on the beat,
           directions turning around the screen.
filmstrip  a strip of film across the screen (down it, for vertical video) advancing one frame per beat, sprocket
           holes and all; every fourth bar the centre frame opens to full screen for beat cuts, then a flash.
"""
import math
import numpy as np, cv2
from scenes import Scene, vignette, rotation, ease_out, clamp
from styles import slots, pace_of

def beat_plan(grid, seconds, snap):
    """Beats and bar starts of the edit, the end (a whole bar), and the start of the held last bar."""
    starts, L = slots(grid, seconds, 1)
    end = starts[-1] + L
    beats = [snap(b) for b in grid['beats'] if -1e-3 <= b < end - 1e-3]
    downs = [snap(d) for d in grid['downbeats'] if -1e-3 <= d < end]
    return beats, downs, end, snap(end - grid['bar'])

def on(b, downs): return any(abs(b - d) < 1e-3 for d in downs)

# how often to cut (beats), how shots arrive, colour, and what rides on the bar
LOOKS = {
    'zoomthru': {'every': 1, 'trans': 'zoom', 'grade': 'clean', 'flash': 0.5, 'tilt': 4},
    'glitch':   {'every': 1, 'trans': 'glitch', 'grade': 'glitch', 'flash': 0.0, 'tilt': 0},
    'dreamy':   {'every': 4, 'trans': 'dissolve', 'grade': 'dreamy', 'flash': 0.0, 'tilt': 0},
    'swipe':    {'every': 1, 'trans': 'slide', 'grade': 'clean', 'flash': 0.0, 'tilt': 0},
}
DIRS = [(1, 0), (0, 1), (-1, 0), (0, -1)]

class Cuts(Scene):
    """One photo at a time, changing every N beats, in one of the LOOKS."""
    def __init__(self, grid, sources, seconds, fps, W, H, rnd, title, look):
        super().__init__(W, H, fps)
        self.lk = lk = LOOKS[look]; self.sources = sources; B = grid['beat']; self.B = B
        beats, downs, end, hold = beat_plan(grid, seconds, self.snap)
        # the look's cut length times the pace's, at most two bars (very fast songs: every other beat at least)
        every = min(8, max(lk['every'] * pace_of(grid)['every'], 2 if B < 0.36 else 1))
        n = len(sources); k = 0; self.shots = []
        for i, b in enumerate(beats):
            if b >= hold - 1e-3: break
            if i % every: continue
            self.add(b, k % n, on(b, downs), DIRS[k % 4] if lk['trans'] == 'slide' else rnd.choice(DIRS), rnd, first=not self.shots); k += 1
        self.add(hold, k % n, True, (1, 0), rnd)
        self.starts = [s['t'] for s in self.shots]
        self.moves = [{'t': round(d, 3), 'move': lk['trans']} for d in downs]
        if title: self.titles.append((0.0, self.snap(min(grid['bar'], end / 3))))
        self.end = self.snap(end); self.fade = (self.snap(end - B), self.end)
        self.vig = vignette(W, H, 0.3 if lk['grade'] == 'clean' else 0.5)
        if lk['grade'] == 'dreamy':
            y, x = np.mgrid[0:H // 8, 0:W // 8].astype(np.float32); x /= W / 8; y /= H / 8
            blob = np.exp(-((x - 0.9) ** 2 / 0.08 + (y - 0.2) ** 2 / 0.15))[..., None] * np.array([60, 140, 255], np.float32)
            self.leak = cv2.resize(blob, (W, H), interpolation=cv2.INTER_CUBIC)
        if lk['grade'] == 'glitch':
            self.scan = (1 - 0.12 * (np.arange(H) % 4 < 2)).astype(np.float32)[:, None, None]

    def add(self, b, sid, bar, d, rnd, first=False):
        self.shots.append({'t': b, 'sid': sid, 'bar': bar, 'dir': d, 'tilt': rnd.choice([-1, 1]) * self.lk['tilt'], 'seed': rnd.randrange(1 << 30)})
        tr = self.lk['trans']
        if tr == 'zoom':
            if not first: self.sound(b, 'whoosh', 0.4, d=0.2)
            self.sound(b, 'thump' if bar else 'tick', 0.6 if bar else 0.4)
        elif tr == 'slide':
            if not first: self.sound(b, 'whoosh', 0.35, pan=-0.6 * d[0], d=0.16)
            self.sound(b, 'slap', 0.5, pan=-0.4 * d[0])
        elif tr == 'glitch':
            self.sound(b, 'glitch', 0.8 if bar else 0.55)
            if bar: self.sound(b, 'thump', 0.5)
        elif tr == 'dissolve':
            if not first: self.sound(b, 'whoosh', 0.25, d=0.6)
            self.sound(b, 'pop', 0.35)

    def frame_of(self, s, t, extra=1.0):
        local = max(0.0, t - s['t'])
        tilt = s['tilt'] * (1 - ease_out(clamp(local / 0.35)))
        z = 1.03 * extra + (0.06 * math.exp(-local * 9) if self.lk['trans'] in ('zoom', 'slide') else 0)
        return self.sources[s['sid']].render(local, self.W, self.H, punch=z, post=rotation(self.W, self.H, tilt))

    def draw(self, t, sources):
        W, H, B, lk = self.W, self.H, self.B, self.lk
        i = max(0, int(np.searchsorted(self.starts, t + 1e-6)) - 1)
        s = self.shots[i]; prev = self.shots[i - 1] if i else None; nx = self.shots[i + 1] if i + 1 < len(self.shots) else None
        local = t - s['t']; tr = lk['trans']
        if tr == 'zoom':
            wd = min(0.12, B / 3); z = 1.0; radial = 0
            if local < wd: q = local / wd; z = 1 + 0.45 * (1 - q) ** 3; radial = (1 - q) ** 2
            if nx and nx['t'] - t < wd: p = 1 - (nx['t'] - t) / wd; z = 1 + 0.6 * p ** 3; radial = p ** 2
            img = self.frame_of(s, t, z)
            if radial > 0.05:
                acc = img.astype(np.float32)
                for k in (1, 2, 3): acc += cv2.warpAffine(img, rotation(W, H, 0, s=1 + 0.04 * k * radial), (W, H), borderMode=cv2.BORDER_REFLECT)
                img = (acc / 4).astype(np.uint8)
            f = img.astype(np.float32)
        elif tr == 'slide' and prev and local < min(0.28, B * 0.7):
            q = local / min(0.28, B * 0.7)
            f = self.frame_of(prev, t).astype(np.float32) * (1 - 0.35 * q)
            front = self.frame_of(s, t).astype(np.float32)
            e = 1 + 2.2 * (q - 1) ** 3 + 1.2 * (q - 1) ** 2        # ease out with a little overshoot
            dx, dy = s['dir']; ox, oy = int(dx * W * (1 - e)), int(dy * H * (1 - e))
            xs, xd = (slice(0, W - ox), slice(ox, W)) if ox >= 0 else (slice(-ox, W), slice(0, W + ox))
            ys, yd = (slice(0, H - oy), slice(oy, H)) if oy >= 0 else (slice(-oy, H), slice(0, H + oy))
            # a soft shadow just outside the incoming edge
            sh = 40
            if dx > 0: f[:, max(0, ox - sh):max(0, ox)] *= 0.6
            if dx < 0: f[:, min(W, W + ox):min(W, W + ox + sh)] *= 0.6
            if dy > 0: f[max(0, oy - sh):max(0, oy)] *= 0.6
            if dy < 0: f[min(H, H + oy):min(H, H + oy + sh)] *= 0.6
            f[yd, xd] = front[ys, xs]
        elif tr == 'dissolve' and prev and local < min(0.7, B * 2):
            q = ease_out(local / min(0.7, B * 2))
            a = self.frame_of(prev, t).astype(np.float32); b = self.frame_of(s, t)
            k = int(40 * (1 - q)) | 1
            b = cv2.GaussianBlur(b, (k, k), 0) if k > 1 else b
            f = a * (1 - q) + b.astype(np.float32) * q
        else:
            f = self.frame_of(s, t).astype(np.float32)
        if tr == 'glitch': f = self.glitched(f, s, t, local, nx)
        gray = f.mean(2, keepdims=True)
        if lk['grade'] == 'clean': f = (gray + (f - gray) * 1.1 - 128) * 1.06 + 128
        elif lk['grade'] == 'glitch': f = ((gray + (f - gray) * 0.85 - 128) * 1.18 + 128) * self.scan
        elif lk['grade'] == 'dreamy':
            f = (gray + (f - gray) * 0.85) * 0.86 + 24
            small = cv2.resize(f, (W // 8, H // 8), interpolation=cv2.INTER_AREA)
            f = f + cv2.resize(cv2.GaussianBlur(small, (0, 0), 4), (W, H)) * 0.22 - 20       # glow
            f = f + self.leak * (0.25 + 0.35 * (0.5 + 0.5 * math.sin(t * 1.3)))
            f[..., 0] *= 0.94; f[..., 2] *= 1.04
            grain = np.random.default_rng(int(t * self.fps)).normal(0, 5, (H // 2 + 1, W // 2 + 1, 1)).astype(np.float32)
            f += grain.repeat(2, 0).repeat(2, 1)[:H, :W]
        f *= self.vig
        if lk['flash'] and s['bar'] and local < 0.4: f = f + (255 - f) * lk['flash'] * math.exp(-local / 0.07)
        a0, a1 = self.fade
        if t > a0: f *= 1 - clamp((t - a0) / (a1 - a0))
        return np.clip(f, 0, 255).astype(np.uint8)

    def glitched(self, f, s, t, local, nx):
        """Around each cut: torn horizontal slices, RGB split, flickering inverted blocks; a faint jitter otherwise."""
        W, H = self.W, self.H
        r = np.random.default_rng(s['seed'] + int(t * self.fps))
        if local < 0.14 or (nx is not None and nx['t'] - t < 0.07):
            amt = 1.0 if local < 0.14 else 0.6
            out = f.copy(); y = 0
            while y < H:
                h = int(r.integers(H // 40, H // 8)); out[y:y + h] = np.roll(f[y:y + h], int(r.normal(0, 0.06 * W * amt)), 1); y += h
            f = out
            k = int(r.integers(8, 28) * W / 1920 * amt)
            f[..., 2] = np.roll(f[..., 2], k, 1); f[..., 0] = np.roll(f[..., 0], -k, 1)
            for _ in range(int(r.integers(1, 4))):
                x0, y0, bw, bh = int(r.integers(0, W * 0.8)), int(r.integers(0, H * 0.9)), int(W * 0.25), int(H * 0.08)
                f[y0:y0 + bh, x0:x0 + bw] = 255 - f[y0:y0 + bh, x0:x0 + bw]
            if local < 1.5 / self.fps and s['bar']: f = 255 - f
        elif r.random() < 0.3:
            f[..., 2] = np.roll(f[..., 2], 3, 1)
        return f

def _cuts(look):
    def style(grid, sources, seconds, fps, W, H, rnd, title): return Cuts(grid, sources, seconds, fps, W, H, rnd, title, look)
    return style
zoomthru, glitch, dreamy, swipe = (_cuts(k) for k in ('zoomthru', 'glitch', 'dreamy', 'swipe'))

class Filmstrip(Scene):
    def __init__(self, grid, sources, seconds, fps, W, H, rnd, title):
        super().__init__(W, H, fps)
        self.sources = sources; B = grid['beat']; self.B = B
        beats, downs, end, hold = beat_plan(grid, seconds, self.snap)
        self.horiz = W >= H
        short = H if self.horiz else W
        self.fh = round(short * 0.46)                    # frame size across the strip
        self.fl = round(self.fh * 1.45)                  # and along it
        self.hole = round(self.fh * 0.075)
        self.pitch = self.fl + self.hole * 2             # a whole number of sprocket holes per frame, so they line up
        self.n = n = len(sources)
        self.steps, self.full, self.flashes = [], [], []  # steps: (t, frame the strip moves to); full: [t0, t1, [(t, sid)]]
        idx, mode = 0, 'strip'
        # the strip moves (and the open frame cuts) every `every` beats of the pace
        every = pace_of(grid)['every']; d0 = downs[0] if downs else 0
        for b in [x for x in beats if round((x - d0) / B) % every == 0]:
            bi = sum(1 for d in downs if d <= b + 1e-3) - 1; bar = on(b, downs)
            if bar and bi % 4 == 3 and b < hold - 1e-3 and mode == 'strip':
                mode = 'open'; self.full.append([b, None, [(b, idx % n)]])
                self.sound(b, 'whoosh', 0.5, d=0.2); self.sound(b, 'pop', 0.6); self.moves.append({'t': round(b, 3), 'move': 'open frame'})
                continue
            if mode == 'open':
                if not bar:
                    idx += 1; self.full[-1][2].append((b, idx % n)); self.sound(b, 'tick', 0.5); self.sound(b, 'thump', 0.35)
                    continue
                self.full[-1][1] = b; mode = 'strip'; self.flashes.append(b); self.sound(b, 'flash', 0.9)
                self.moves.append({'t': round(b, 3), 'move': 'strip'})
            if self.steps: idx += 1
            self.steps.append((b, idx)); self.sound(b, 'tick', 0.55); self.sound(b, 'slap', 0.25)
            if len(self.steps) > 1: self.sound(b, 'whoosh', 0.2, d=0.12)
        if self.full and self.full[-1][1] is None: self.full[-1][1] = end
        self.st = [s[0] for s in self.steps]
        if title: self.titles.append((0.0, self.snap(min(grid['bar'], end / 3))))
        self.end = self.snap(end); self.fade = (self.snap(end - B), self.end)
        self.vig = vignette(W, H, 0.5); self.cache, self.bg = {}, {}
        self.travel = min(0.2, B * 0.5)

    def photo(self, sid, w, h):
        if (sid, w, h) not in self.cache: self.cache[(sid, w, h)] = self.sources[sid].render(0.5, w, h).astype(np.float32)
        return self.cache[(sid, w, h)]

    def backdrop(self, sid):
        if sid not in self.bg:
            small = cv2.GaussianBlur(self.sources[sid].render(0, self.W // 8, self.H // 8), (0, 0), 3).astype(np.float32) * 0.5
            self.bg[sid] = cv2.resize(small, (self.W, self.H), interpolation=cv2.INTER_CUBIC) * self.vig
        return self.bg[sid]

    def pos(self, t):
        """Strip position in frames: each step glides over `travel` seconds centred on its beat."""
        p = self.steps[0][1] if self.steps else 0
        for (t0, k), prev in zip(self.steps, [None] + self.steps[:-1]):
            if prev is None: continue
            q = clamp((t - t0 + self.travel / 2) / self.travel)
            if q <= 0: break
            p = prev[1] + (k - prev[1]) * ease_out(q)
        return p

    def draw(self, t, sources):
        W, H = self.W, self.H
        for t0, t1, cuts in self.full:
            if t0 <= t < t1:
                j = max(0, int(np.searchsorted([c[0] for c in cuts], t + 1e-6)) - 1); ct, sid = cuts[j]
                if j == 0 and t - t0 < 0.22: return self.strip(t, ease_out((t - t0) / 0.22))
                e = t - ct
                return self.finish(sources[sid].render(e, W, H, punch=1 + 0.06 * math.exp(-e * 10)).astype(np.float32), t)
        return self.strip(t)

    def strip(self, t, open_p=0.0):
        W, H = self.W, self.H; p = self.pos(t)
        f = self.backdrop(int(round(p)) % self.n).copy()
        band = self.fh + self.hole * 6; L = W if self.horiz else H
        a0 = (H if self.horiz else W) // 2 - band // 2
        if self.horiz: f[a0:a0 + band] = f[a0:a0 + band] * 0.15 + 14
        else: f[:, a0:a0 + band] = f[:, a0:a0 + band] * 0.15 + 14
        hp = self.hole * 2; off = -(p * self.pitch) % hp
        for k in range(-1, L // hp + 2):
            c0, c1 = max(0, int(k * hp + off)), max(0, int(k * hp + off) + self.hole)
            for side in (a0 + self.hole, a0 + band - self.hole * 2):
                if self.horiz: f[side:side + self.hole, c0:c1] = 225
                else: f[c0:c1, side:side + self.hole] = 225
        fw, fh = (self.fl, self.fh) if self.horiz else (self.fh, self.fl)
        for k in range(int(p) - 3, int(p) + 4):
            d = (k - p) * self.pitch
            x0, y0 = (int(W / 2 + d - fw / 2), H // 2 - fh // 2) if self.horiz else (W // 2 - fw // 2, int(H / 2 + d - fh / 2))
            xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + fw), min(H, y0 + fh)
            if xb > xa and yb > ya:
                f[ya:yb, xa:xb] = self.photo(k % self.n, fw, fh)[ya - y0:yb - y0, xa - x0:xb - x0] * (1 - 0.35 * min(1, abs(k - p)))
        if open_p > 0:      # the centre photo grows from its frame to the whole screen
            w, h = int(fw + (W - fw) * open_p), int(fh + (H - fh) * open_p)
            f[(H - h) // 2:(H - h) // 2 + h, (W - w) // 2:(W - w) // 2 + w] = self.sources[int(round(p)) % self.n].render(0.5, w, h)
        return self.finish(f, t)

    def finish(self, f, t):
        for b in self.flashes:
            a = t - b
            if 0 <= a < 0.4: f = f * (1 - math.exp(-a / 0.08)) + 255 * math.exp(-a / 0.08)
        a0, a1 = self.fade
        if t > a0: f = f * (1 - clamp((t - a0) / (a1 - a0)))
        return np.clip(f, 0, 255).astype(np.uint8)

def filmstrip(*a): return Filmstrip(*a)

ALL = {'zoomthru': zoomthru, 'glitch': glitch, 'dreamy': dreamy, 'swipe': swipe, 'filmstrip': filmstrip}
