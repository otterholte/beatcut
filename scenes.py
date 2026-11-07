"""Free-form template styles: the style draws every whole frame itself (beatcut.compose calls draw(t, sources)).

velocity  the phonk "shake" edit: a dark, letterboxed intro cutting every two beats, sixteenth-note stutter cuts and a
          riser into the drop; on the drop a white flash, hard shake, RGB split and full colour; then a cut on every
          beat with whip pans (motion-blurred), zoom-throughs and flashes on the bars, double-time cuts every other
          bar, and a held last shot that fades out.
dump      the photo dump: polaroids drop onto a blurred backdrop one per beat and pile up, a caption on the first;
          every fourth bar it zooms into the top photo for full-screen beat cuts, then a camera flash brings the pile
          back; piles are swept off the table on the bar.
"""
import math, os
import numpy as np, cv2
from styles import slots

HERE = os.path.dirname(os.path.abspath(__file__))
ease_out = lambda p: 1 - (1 - p) ** 3
ease_in = lambda p: p ** 3
clamp = lambda p: min(1.0, max(0.0, p))

class Scene:
    title_mode = 'center'
    cells = []
    def __init__(self, W, H, fps):
        self.W, self.H, self.fps = W, H, fps
        self.sfx, self.titles, self.moves, self.end = [], [], [], 0
    def snap(self, t): return round(t * self.fps) / self.fps
    def sound(self, t, k, g=1.0, pan=0.0, **kw):
        self.sfx.append({'t': round(self.snap(t), 4), 'k': k, 'g': g, 'pan': pan, **kw})

def vignette(W, H, strength):
    y, x = np.ogrid[-1:1:H * 1j, -1:1:W * 1j]
    return (1 - strength * np.clip((x * x + y * y) / 2, 0, 1) ** 1.5).astype(np.float32)[..., None]

def rotation(W, H, deg, dx=0, dy=0, s=1.0):
    M = cv2.getRotationMatrix2D((W / 2, H / 2), deg, s); M[0, 2] += dx; M[1, 2] += dy
    return M

class Velocity(Scene):
    intro_bars = 2          # the edit starts this many bars before the drop

    def __init__(self, grid, sources, seconds, fps, W, H, rnd, title):
        super().__init__(W, H, fps)
        self.sources, self.rnd = sources, rnd
        B, bar = grid['beat'], grid['bar']; self.B = B
        starts, L = slots(grid, seconds, 1)
        end = starts[-1] + L
        downs = [d for d in grid['downbeats'] if -1e-3 <= d < end]
        drop = grid.get('drop')
        if drop is None or drop < bar * 0.9 or drop > end - 2 * bar: drop = downs[1]
        self.drop = drop = self.snap(drop)
        beats = [b for b in grid['beats'] if -1e-3 <= b < end - 1e-3]
        n = len(sources); nxt = iter(range(10 ** 6))
        take = lambda: next(nxt) % n
        self.shots, self.hits = [], []          # shots: (t, sid, transition, dir); hits: (t, shake, rgb, flash)
        # intro: a new shot every two beats, then sixteenth-note stutter cuts on the last beat before the drop
        for b in beats:
            if b >= drop - B - 1e-3: break
            if round((b - beats[0]) / B) % 2 == 0: self.shots.append((self.snap(b), take(), 'cut', 0))
        for k in range(4):
            ts = drop - B + k * B / 4
            self.shots.append((self.snap(ts), take(), 'cut', 0)); self.sound(ts, 'tick', 0.5 + 0.1 * k); self.hits.append((self.snap(ts), 0.12, 0, 0))
        self.sound(drop, 'whoosh', 0.75, d=min(drop, bar))
        if title: self.titles.append((0.0, self.snap(drop - B)))
        self.moves.append({'t': 0, 'move': 'intro'}); self.moves.append({'t': round(drop, 3), 'move': 'drop'})
        # the drop
        self.shots.append((drop, take(), 'flash', 0)); self.hits.append((drop, 1.0, 1.0, 1.0))
        self.sound(drop, 'impact', 1.0); self.sound(drop, 'flash', 0.6)
        # after the drop: a cut on every beat; the last bar holds one shot
        hold = self.snap(end - bar)
        dirs = [(1, 0), (-1, 0), (0, 1), (0, -1)]
        for i, b in enumerate(x for x in beats if drop + 1e-3 < x < hold - 1e-3):
            b = self.snap(b); on_bar = any(abs(b - d) < 0.02 for d in downs)
            if on_bar:
                kind = 'flash' if (len(self.moves) % 2) else 'zoom'
                self.moves.append({'t': round(b, 3), 'move': 'bar ' + kind})
                self.shots.append((b, take(), kind, 0)); self.hits.append((b, 0.6, 0.7, 0.8 if kind == 'flash' else 0))
                self.sound(b, 'impact', 0.7)
                if kind == 'zoom': self.sound(b, 'whoosh', 0.45, d=0.22)
            else:
                d = rnd.choice(dirs)
                self.shots.append((b, take(), 'whip', d)); self.hits.append((b, 0.25, 0.2, 0))
                self.sound(b, 'whoosh', 0.35, pan=-0.5 * d[0], d=0.16); self.sound(b, 'tick', 0.35)
                # double time on the off-beat of beat 3, every other bar
                if i % 8 == 6:
                    t2 = self.snap(b + B / 2)
                    self.shots.append((t2, take(), 'cut', 0)); self.hits.append((t2, 0.3, 0.3, 0)); self.sound(t2, 'tick', 0.6)
        self.shots.append((hold, take(), 'flash', 0)); self.hits.append((hold, 0.8, 0.8, 0.9))
        self.sound(hold, 'impact', 0.9); self.moves.append({'t': round(hold, 3), 'move': 'final hold'})
        self.shots.sort(key=lambda s: s[0])
        self.starts = [s[0] for s in self.shots]
        self.end = self.snap(end); self.fade = (self.snap(end - B), self.end)
        self.vig = vignette(W, H, 0.55)
        self.phase = {h[0]: (rnd.uniform(0, 6.3), rnd.uniform(0, 6.3), rnd.uniform(0, 6.3)) for h in self.hits}
        self.wd = min(0.12, B / 3)       # whip / zoom half-length

    def draw(self, t, sources):
        W, H, B = self.W, self.H, self.B
        i = max(0, int(np.searchsorted(self.starts, t + 1e-6)) - 1)
        st, sid, kind, d = self.shots[i]
        nx = self.shots[i + 1] if i + 1 < len(self.shots) else None
        local = t - st
        z = 1.04 + (0.14 * math.exp(-local * 7) if kind in ('flash', 'zoom') else 0.05 * math.exp(-local * 9))
        dx = dy = rot = 0.0; blur = (0, 0); radial = 0.0
        wd = self.wd
        # whip: the outgoing shot accelerates away, the incoming one arrives at speed and settles; both blur
        if kind == 'whip' and local < wd:
            q = local / wd; off = 0.35 * (1 - q) ** 3
            dx, dy = d[0] * W * off, d[1] * H * off
            sp = 1.05 * (1 - q) ** 2 / wd / self.fps
            blur = (int(min(300, sp * W)) if d[0] else 0, int(min(300, sp * H)) if d[1] else 0)
        if nx and nx[2] == 'whip' and nx[0] - t < wd:
            p = 1 - (nx[0] - t) / wd; off = -0.35 * p ** 3; nd = nx[3]
            dx, dy = nd[0] * W * off, nd[1] * H * off
            sp = 1.05 * p ** 2 / wd / self.fps
            blur = (int(min(300, sp * W)) if nd[0] else 0, int(min(300, sp * H)) if nd[1] else 0)
        if kind == 'zoom' and local < wd:
            q = local / wd; z *= 1 + 0.35 * (1 - q) ** 3; radial = (1 - q) ** 2
        if nx and nx[2] == 'zoom' and nx[0] - t < wd:
            p = 1 - (nx[0] - t) / wd; z *= 1 + 0.5 * p ** 3; radial = p ** 2
        # shake, RGB split and flash from recent hits
        rgb = flash = 0.0
        for ht, sh, rg, fl in self.hits:
            a = t - ht
            if a < 0 or a > 0.6: continue
            ph = self.phase[ht]; e = math.exp(-a / 0.15)
            dx += sh * e * 0.03 * W * math.sin(2 * math.pi * 11 * a + ph[0])
            dy += sh * e * 0.025 * H * math.sin(2 * math.pi * 13 * a + ph[1])
            rot += sh * e * 2.5 * math.sin(2 * math.pi * 7 * a + ph[2])
            rgb = max(rgb, rg * math.exp(-a / 0.09)); flash = max(flash, fl * math.exp(-a / 0.07))
        img = sources[sid].render(local, W, H, punch=z, post=rotation(W, H, rot, dx, dy))
        if blur[0] > 2 or blur[1] > 2: img = cv2.blur(img, (max(1, blur[0]), max(1, blur[1])))
        if radial > 0.05:
            acc = img.astype(np.float32)
            for k in (1, 2, 3):
                acc += cv2.warpAffine(img, rotation(W, H, 0, s=1 + 0.035 * k * radial), (W, H), borderMode=cv2.BORDER_REFLECT)
            img = (acc / 4).astype(np.uint8)
        f = img.astype(np.float32)
        intro = t < self.drop
        gray = f.mean(2, keepdims=True)
        if intro: f = (gray + (f - gray) * 0.35) * 0.78
        else: f = (gray + (f - gray) * 1.18 - 128) * 1.12 + 128
        f *= self.vig
        k = int(rgb * 22 * W / 1920)
        if k:
            f[..., 2] = np.roll(f[..., 2], k, 1); f[..., 0] = np.roll(f[..., 0], -k, 1)
        if flash > 0.01: f = f * (1 - flash) + 255 * flash
        a0, a1 = self.fade
        if t > a0: f *= 1 - clamp((t - a0) / (a1 - a0))
        fr = np.clip(f, 0, 255).astype(np.uint8)
        # letterbox in the intro, snapping open on the drop
        lb = 0.11 * H * (1 if intro else 1 - ease_out(clamp((t - self.drop) / 0.12)))
        if lb >= 1: fr[:int(lb)] = 0; fr[H - int(lb):] = 0
        return fr

def velocity(*a): return Velocity(*a)
velocity.intro_bars = Velocity.intro_bars

class Dump(Scene):
    title_mode = None      # the title is a caption written on the first photo

    def __init__(self, grid, sources, seconds, fps, W, H, rnd, title):
        super().__init__(W, H, fps)
        self.sources, self.rnd, self.title = sources, rnd, title
        B, bar = grid['beat'], grid['bar']; self.B = B
        starts, L = slots(grid, seconds, 1)
        end = starts[-1] + L
        beats = [self.snap(b) for b in grid['beats'] if -1e-3 <= b < end - 1e-3]
        downs = [self.snap(d) for d in grid['downbeats'] if -1e-3 <= d < end]
        self.P = round(0.6 * H) if W >= H else round(0.74 * W)        # photo side on screen
        self.cards, self.full, self.flashes = [], [], []                # cards: dicts; full: (t0, t1, sid); flashes: t
        n = len(sources); nxt = iter(range(10 ** 6)); take = lambda: next(nxt) % n
        self.fall = min(0.14, B * 0.4)
        pile, mode, zoom_card = [], 'pile', None
        last_bar = downs[-1] if downs else end - bar
        for b in beats:
            bi = sum(1 for d in downs if d <= b + 1e-3) - 1; on_bar = any(abs(b - d) < 1e-3 for d in downs)
            ph = bi % 4
            if on_bar:
                self.moves.append({'t': round(b, 3), 'move': ['pile', 'pile', 'zoom in', 'flash back'][ph] if b < last_bar else 'final'})
                if ph == 0 and pile and b < last_bar:
                    for c in pile: c['sweep'] = (b, rnd.choice([-1, 1]))
                    self.sound(b, 'whoosh', 0.6, d=0.25); pile = []
                if ph == 2 and pile and b < last_bar:
                    zoom_card = pile[-1]; zoom_card['zoom'] = b; mode = 'full'
                    self.sound(b, 'whoosh', 0.5, d=0.2); self.sound(b, 'pop', 0.8)
                    continue
                if ph == 3 and mode == 'full':
                    self.full[-1] = (self.full[-1][0], b, self.full[-1][2]); mode = 'pile'
                    for c in pile: c['gone'] = b
                    pile = []; self.flashes.append(b); self.sound(b, 'flash', 0.9)
            if mode == 'full':
                if self.full and self.full[-1][1] > b: self.full[-1] = (self.full[-1][0], b, self.full[-1][2])
                self.full.append((b, b + bar, take())); self.sound(b, 'tick', 0.6); self.sound(b, 'thump', 0.35)
                continue
            # a card lands on this beat
            c = {'sid': take(), 'land': b, 'x': W / 2 + rnd.uniform(-0.16, 0.16) * W, 'y': H / 2 + rnd.uniform(-0.05, 0.05) * H,
                 'rot': rnd.uniform(-8, 8), 'from': rnd.choice([-1, 1])}
            if not self.cards and title: c['caption'] = title
            pile.append(c); self.cards.append(c)
            self.sound(b, 'slap', 0.9, pan=(c['x'] / W - 0.5) * 1.2); self.sound(b, 'tick', 0.25)
        if self.full and mode == 'full': self.full[-1] = (self.full[-1][0], end, self.full[-1][2])
        out = self.snap(end - B / 2)
        for c in pile: c.setdefault('sweep', (out, rnd.choice([-1, 1])))
        self.sound(out, 'whoosh', 0.6, d=0.25)
        self.end = self.snap(end + 0.2); self.fade = (out, self.end)
        self.tex, self.bg = {}, {}
        self.vig = vignette(W, H, 0.45)

    def texture(self, c):
        """The polaroid for a card: photo square, white frame, a deeper bottom edge; drawn at 1.5x for crispness."""
        key = (c['sid'], c.get('caption'))
        if key in self.tex: return self.tex[key]
        src = self.sources[c['sid']]; im = src.pixels(0)
        P = round(self.P * 1.5); b, bb = round(P * 0.06), round(P * 0.24)
        s = min(im.shape[:2]); y0, x0 = (im.shape[0] - s) // 2, (im.shape[1] - s) // 2
        photo = cv2.resize(im[y0:y0 + s, x0:x0 + s], (P, P), interpolation=cv2.INTER_AREA)
        card = np.full((P + b + bb, P + 2 * b, 3), (238, 243, 246), np.uint8)
        card[b:b + P, b:b + P] = photo
        if c.get('caption'):
            from PIL import Image, ImageDraw, ImageFont
            f = ImageFont.truetype(os.path.join(HERE, 'fonts', 'Fraunces-Italic.ttf'), round(bb * 0.42))
            pim = Image.fromarray(card[..., ::-1].copy()); d = ImageDraw.Draw(pim)
            w = d.textlength(c['caption'], font=f)
            d.text(((card.shape[1] - w) / 2, b + P + bb * 0.22), c['caption'], font=f, fill=(48, 44, 40))
            card = np.asarray(pim)[..., ::-1].copy()
        alpha = np.full(card.shape[:2], 255, np.uint8)
        self.tex[key] = (card, alpha)
        return self.tex[key]

    def backdrop(self, sid):
        if sid not in self.bg:
            im = self.sources[sid].pixels(0)
            s = max(self.W / 8 / im.shape[1], self.H / 8 / im.shape[0])
            small = cv2.resize(im, (max(1, round(im.shape[1] * s)), max(1, round(im.shape[0] * s))), interpolation=cv2.INTER_AREA)
            y0, x0 = (small.shape[0] - self.H // 8) // 2, (small.shape[1] - self.W // 8) // 2
            small = cv2.GaussianBlur(small[y0:y0 + self.H // 8, x0:x0 + self.W // 8], (0, 0), 3)
            g = small.mean(2, keepdims=True); small = (g + (small - g) * 0.8) * 0.78
            self.bg[sid] = cv2.resize(small.astype(np.float32), (self.W, self.H), interpolation=cv2.INTER_CUBIC)
        return self.bg[sid]

    def pose(self, c, t):
        """Where a card is at time t: None before it falls in and after it has left."""
        W, H = self.W, self.H
        t0 = c['land'] - self.fall
        if t < t0 or t >= c.get('gone', 1e9): return None
        q = clamp((t - t0) / self.fall)
        s = 1 + 0.45 * (1 - ease_out(q)); a = clamp(q * 3)
        x, y = c['x'], c['y'] - 0.06 * H * (1 - ease_out(q)); rot = c['rot'] + 10 * c['from'] * (1 - ease_out(q))
        if q >= 1:   # a little settle after landing
            e = t - c['land']; s *= 1 - 0.012 * math.sin(e * 40) * math.exp(-e * 12)
        lift = 1 - ease_out(q)
        if 'zoom' in c and t >= c['zoom']:
            p = ease_out(clamp((t - c['zoom']) / 0.22))
            S = max(W, H) / self.P * 1.02
            s, x, y, rot = s + (S - s) * p, x + (W / 2 - x) * p, y + (H / 2 - y) * p, rot * (1 - p)
            # aim the photo square, not the whole frame, at the screen centre
            y -= (self.P * 0.09) * s * p
        if 'sweep' in c:
            ts, dr = c['sweep']; p = clamp((t - (ts - 0.2)) / 0.2)
            if p >= 1: return None
            x += dr * 1.4 * W * ease_in(p); rot += dr * 25 * ease_in(p)
        return s, x, y, rot, a, lift

    def paste(self, f, tex, s, x, y, rot, a, lift):
        card, alpha = tex
        k = s / 1.5
        M = cv2.getRotationMatrix2D((card.shape[1] / 2, card.shape[0] / 2), rot, k)
        M[0, 2] += x - card.shape[1] / 2; M[1, 2] += y - card.shape[0] / 2
        # draw only inside the card's bounding box
        cs = np.array([[0, 0, 1], [card.shape[1], 0, 1], [0, card.shape[0], 1], [card.shape[1], card.shape[0], 1]], np.float32) @ M.T
        pad = 60 + 80 * lift
        x0, y0 = int(max(0, cs[:, 0].min() - pad)), int(max(0, cs[:, 1].min() - pad))
        x1, y1 = int(min(self.W, cs[:, 0].max() + pad)), int(min(self.H, cs[:, 1].max() + pad))
        if x1 <= x0 or y1 <= y0: return
        M2 = M.copy(); M2[0, 2] -= x0; M2[1, 2] -= y0
        w, h = x1 - x0, y1 - y0
        rgb = cv2.warpAffine(card, M2, (w, h), flags=cv2.INTER_AREA if k < 0.8 else cv2.INTER_LINEAR)
        al = cv2.warpAffine(alpha, M2, (w, h)).astype(np.float32)[..., None] / 255 * a
        # a soft shadow that grows and drifts while the card is in the air
        off = round(0.012 * self.H * (1 + 3 * lift))
        # (blurred at quarter size: a soft shadow needs no detail, and this is most of the render time)
        small = cv2.resize(np.roll(np.roll(al[..., 0], off, 0), off // 2, 1), (max(1, w // 4), max(1, h // 4)), interpolation=cv2.INTER_AREA)
        sh = cv2.resize(cv2.GaussianBlur(small, (0, 0), (6 + 18 * lift) / 4), (w, h))[..., None] * (0.5 - 0.25 * lift)
        reg = f[y0:y1, x0:x1]
        reg *= 1 - sh
        f[y0:y1, x0:x1] = reg * (1 - al) + rgb.astype(np.float32) * al

    def draw(self, t, sources):
        W, H = self.W, self.H
        for t0, t1, sid in self.full:
            if t0 <= t < t1:
                e = t - t0; punch = 1.0 + 0.06 * math.exp(-e * 10)
                f = sources[sid].render(e, W, H, punch=punch).astype(np.float32)
                return self.finish(f, t)
        landed = [c for c in self.cards if c['land'] <= t and t < c.get('gone', 1e9) and ('sweep' not in c or t < c['sweep'][0] - 0.2)]
        top = landed[-1]['sid'] if landed else (self.cards[0]['sid'] if self.cards else 0)
        f = self.backdrop(top).copy()
        if len(landed) > 1:   # the backdrop eases over to the newest photo
            q = clamp((t - landed[-1]['land']) / 0.15)
            if q < 1: f = self.backdrop(landed[-2]['sid']) * (1 - q) + f * q
        f *= self.vig
        for c in self.cards:
            p = self.pose(c, t)
            if p: self.paste(f, self.texture(c), *p)
        return self.finish(f, t)

    def finish(self, f, t):
        for b in self.flashes:
            a = t - b
            if 0 <= a < 0.4: f = f * (1 - math.exp(-a / 0.08)) + 255 * math.exp(-a / 0.08)
        a0, a1 = self.fade
        if t > a0: f *= 1 - clamp((t - a0) / (a1 - a0))
        return np.clip(f, 0, 255).astype(np.uint8)

def dump(*a): return Dump(*a)
