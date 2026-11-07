// More free-form styles (the same as looks.py).
//
// zoomthru   3D zoom: a new photo on every beat, arriving through a zoom blur with a slight tilt; flash on the bar.
// glitch     torn slices, RGB split and inverted blocks on every cut, scanlines, a full invert on the bar.
// dreamy     soft aesthetic slideshow: a photo per bar, blur dissolves, glow, a drifting warm light leak, film grain.
// swipe      each photo slides in over the last (a little overshoot, an edge shadow), on the beat, turning round the screen.
// filmstrip  a strip of film across the screen (down it, for vertical video) advancing one frame per beat; every fourth
//            bar the centre frame opens to full screen for beat cuts, then a flash.
import { slots } from './styles.js';
import { Scene } from './scenes.js';
import { easeOut, clamp, lastAt, canvas, rng } from './util.js';

function beatPlan(grid, seconds, snap) {
  const [starts, L] = slots(grid, seconds, 1), end = starts[starts.length - 1] + L;
  return [grid.beats.filter(b => b >= -1e-3 && b < end - 1e-3).map(snap), grid.downbeats.filter(d => d >= -1e-3 && d < end).map(snap), end, snap(end - grid.bar)];
}
const on = (b, downs) => downs.some(d => Math.abs(b - d) < 1e-3);

// how often to cut (beats), how shots arrive, colour, and what rides on the bar
const LOOKS = {
  zoomthru: { every: 1, trans: 'zoom', grade: 'clean', flash: 0.5, tilt: 4 },
  glitch: { every: 1, trans: 'glitch', grade: 'glitch', flash: 0, tilt: 0 },
  dreamy: { every: 4, trans: 'dissolve', grade: 'dreamy', flash: 0, tilt: 0 },
  swipe: { every: 1, trans: 'slide', grade: 'clean', flash: 0, tilt: 0 },
};
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const GRADES = { clean: 'saturate(1.1) contrast(1.06)', glitch: 'saturate(0.85) contrast(1.18)', dreamy: 'saturate(0.85) brightness(0.9)' };

class Cuts extends Scene {
  constructor(grid, sources, seconds, fps, W, H, rnd, title, fx, look) {
    super(W, H, fps, fx);
    const lk = this.lk = LOOKS[look]; this.sources = sources; const B = this.B = grid.beat;
    const [beats, downs, end, hold] = beatPlan(grid, seconds, t => this.snap(t));
    const every = lk.every * (lk.every === 1 && B < 0.36 ? 2 : 1);      // very fast songs: every other beat
    const n = sources.length; let k = 0; this.shots = [];
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i];
      if (b >= hold - 1e-3) break;
      if (i % every) continue;
      this.add(b, k % n, on(b, downs), lk.trans === 'slide' ? DIRS[k % 4] : rnd.choice(DIRS), rnd, !this.shots.length); k++;
    }
    this.add(hold, k % n, true, [1, 0], rnd);
    this.starts = this.shots.map(s => s.t);
    this.moves = downs.map(d => ({ t: d, move: lk.trans }));
    if (title) this.titles.push([0, this.snap(Math.min(grid.bar, end / 3))]);
    this.end = this.snap(end); this.fade = [this.snap(end - B), this.end];
    if (lk.grade === 'glitch') {
      this.scan = canvas(1, 4); const x = this.scan.getContext('2d');
      x.fillStyle = 'rgb(224,224,224)'; x.fillRect(0, 0, 1, 2); x.fillStyle = '#fff'; x.fillRect(0, 2, 1, 2);
    }
    if (lk.grade === 'dreamy') {
      this.grain = [0, 1, 2, 3].map(i => {
        const w = Math.ceil(W / 2), h = Math.ceil(H / 2), c = canvas(w, h), x = c.getContext('2d'), d = x.createImageData(w, h), r = rng(77 + i);
        for (let p = 0; p < d.data.length; p += 4) { const v = 128 + r.normal(0, 14); d.data[p] = d.data[p + 1] = d.data[p + 2] = v; d.data[p + 3] = 255; }
        x.putImageData(d, 0, 0); return c;
      });
    }
  }

  add(b, sid, bar, d, rnd, first = false) {
    this.shots.push({ t: b, sid, bar, dir: d, tilt: rnd.choice([-1, 1]) * this.lk.tilt, seed: rnd.randrange(1 << 30) });
    const tr = this.lk.trans;
    if (tr === 'zoom') { if (!first) this.sound(b, 'whoosh', 0.4, 0, { d: 0.2 }); this.sound(b, bar ? 'thump' : 'tick', bar ? 0.6 : 0.4); }
    else if (tr === 'slide') { if (!first) this.sound(b, 'whoosh', 0.35, -0.6 * d[0], { d: 0.16 }); this.sound(b, 'slap', 0.5, -0.4 * d[0]); }
    else if (tr === 'glitch') { this.sound(b, 'glitch', bar ? 0.8 : 0.55); if (bar) this.sound(b, 'thump', 0.5); }
    else if (tr === 'dissolve') { if (!first) this.sound(b, 'whoosh', 0.25, 0, { d: 0.6 }); this.sound(b, 'pop', 0.35); }
  }

  frameOf(ctx, s, t, extra = 1) {
    const local = Math.max(0, t - s.t), tilt = s.tilt * (1 - easeOut(clamp(local / 0.35)));
    const z = 1.03 * extra + (['zoom', 'slide'].includes(this.lk.trans) ? 0.06 * Math.exp(-local * 9) : 0);
    ctx.filter = GRADES[this.lk.grade];
    this.sources[s.sid].draw(ctx, local, this.W, this.H, z, tilt ? { rot: tilt } : null);
    ctx.filter = 'none';
  }

  draw(ctx, t) {
    const { W, H, B, lk, fx } = this;
    const i = lastAt(this.starts, t + 1e-6), s = this.shots[i], prev = i ? this.shots[i - 1] : null, nx = this.shots[i + 1];
    const local = t - s.t, tr = lk.trans;
    if (tr === 'zoom') {
      const wd = Math.min(0.12, B / 3); let z = 1, radial = 0;
      if (local < wd) { const q = local / wd; z = 1 + 0.45 * (1 - q) ** 3; radial = (1 - q) ** 2; }
      if (nx && nx.t - t < wd) { const p = 1 - (nx.t - t) / wd; z = 1 + 0.6 * p ** 3; radial = p ** 2; }
      this.frameOf(ctx, s, t, z);
      if (radial > 0.05) fx.zoomBlur(ctx, radial, 0.04);
    } else if (tr === 'slide' && prev && local < Math.min(0.28, B * 0.7)) {
      const q = local / Math.min(0.28, B * 0.7);
      this.frameOf(ctx, prev, t); fx.fade(ctx, 0.35 * q);
      const e = 1 + 2.2 * (q - 1) ** 3 + 1.2 * (q - 1) ** 2;        // ease out with a little overshoot
      const [dx, dy] = s.dir, ox = Math.round(dx * W * (1 - e)), oy = Math.round(dy * H * (1 - e));
      // a soft shadow just outside the incoming edge
      const sh = Math.round(40 * W / 1920) + 8, edge = dx > 0 ? [ox - sh, 0, sh, H] : dx < 0 ? [W + ox, 0, sh, H] : dy > 0 ? [0, oy - sh, W, sh] : [0, H + oy, W, sh];
      ctx.save(); ctx.globalAlpha = 0.4; ctx.fillStyle = '#000'; ctx.fillRect(...edge); ctx.restore();
      const [c, x] = fx.scratch(4); this.frameOf(x, s, t); ctx.drawImage(c, ox, oy);
    } else if (tr === 'dissolve' && prev && local < Math.min(0.7, B * 2)) {
      const q = easeOut(local / Math.min(0.7, B * 2));
      this.frameOf(ctx, prev, t);
      const [c, x] = fx.scratch(4); this.frameOf(x, s, t);
      ctx.save(); ctx.globalAlpha = q; ctx.filter = `blur(${(6 * (1 - q) * W / 1080).toFixed(1)}px)`; ctx.drawImage(c, 0, 0); ctx.restore();
    } else this.frameOf(ctx, s, t);
    if (tr === 'glitch') this.glitched(ctx, s, t, local, nx);
    if (lk.grade === 'glitch') { ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = ctx.createPattern(this.scan, 'repeat'); ctx.fillRect(0, 0, W, H); ctx.restore(); }
    if (lk.grade === 'dreamy') {
      // glow, a drifting warm light leak, a cooler blue, grain
      const [c, x] = fx.scratch(4); x.filter = `blur(${Math.round(W / 34)}px)`; x.drawImage(ctx.canvas, 0, 0);
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = 0.22; ctx.drawImage(c, 0, 0);
      const amp = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 1.3)), g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      [0, 0.5, 1, 1.5, 2, 2.5, 3].forEach(r => g.addColorStop(r / 3, `rgba(255,140,60,${Math.exp(-r * r / 2)})`));
      ctx.globalAlpha = amp; ctx.fillStyle = g;
      // a gaussian blob, sigma 0.2 W by 0.27 H, out to three sigma
      ctx.setTransform(3 * 0.2 * W, 0, 0, 3 * 0.274 * H, 0.9 * W, 0.2 * H); ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
      fx.wash(ctx, 'rgb(255,255,240)', 1, 'multiply');
      ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = 0.5; ctx.drawImage(this.grain[Math.floor(t * this.fps) % 4], 0, 0, W, H); ctx.restore();
    }
    fx.vignette(ctx, lk.grade === 'clean' ? 0.3 : 0.5);
    if (lk.flash && s.bar && local < 0.4) fx.flash(ctx, lk.flash * Math.exp(-local / 0.07));
    this.fadeOut(ctx, t);
  }

  // around each cut: torn horizontal slices, RGB split, flickering inverted blocks; a faint jitter otherwise
  glitched(ctx, s, t, local, nx) {
    const { W, H, fx } = this, r = rng(s.seed + Math.floor(t * this.fps));
    if (local < 0.14 || (nx && nx.t - t < 0.07)) {
      const amt = local < 0.14 ? 1 : 0.6, [c, x] = fx.scratch(4); x.drawImage(ctx.canvas, 0, 0);
      for (let y = 0; y < H;) {
        const h = Math.floor(H / 40 + r.random() * (H / 8 - H / 40)), off = Math.round(r.normal(0, 0.06 * W * amt));
        for (const k of [off - W, off, off + W]) ctx.drawImage(c, 0, y, W, h, k, y, W, h);
        y += h;
      }
      fx.rgbSplit(ctx, Math.round((8 + r.random() * 20) * W / 1920 * amt));
      const blocks = 1 + r.randrange(3);
      for (let b = 0; b < blocks; b++) fx.invert(ctx, Math.floor(r.random() * W * 0.8), Math.floor(r.random() * H * 0.9), Math.floor(W * 0.25), Math.floor(H * 0.08));
      if (local < 1.5 / this.fps && s.bar) fx.invert(ctx);
    } else if (r.random() < 0.3) fx.rgbSplit(ctx, 3, 0);
  }
}
const cuts = look => (grid, sources, seconds, fps, W, H, rnd, title, fx) => new Cuts(grid, sources, seconds, fps, W, H, rnd, title, fx, look);

class Filmstrip extends Scene {
  constructor(grid, sources, seconds, fps, W, H, rnd, title, fx) {
    super(W, H, fps, fx);
    this.sources = sources; const B = this.B = grid.beat;
    const [beats, downs, end, hold] = beatPlan(grid, seconds, t => this.snap(t));
    this.horiz = W >= H;
    const short = this.horiz ? H : W;
    this.fh = Math.round(short * 0.46);              // frame size across the strip
    this.fl = Math.round(this.fh * 1.45);            // and along it
    this.hole = Math.round(this.fh * 0.075);
    this.pitch = this.fl + this.hole * 2;            // a whole number of sprocket holes per frame, so they line up
    const n = this.n = sources.length;
    this.steps = []; this.full = []; this.flashes = [];   // steps: [t, frame the strip moves to]; full: [t0, t1, [[t, sid]]]
    let idx = 0, mode = 'strip';
    for (const b of beats) {
      const bi = downs.filter(d => d <= b + 1e-3).length - 1, bar = on(b, downs);
      if (bar && ((bi % 4) + 4) % 4 === 3 && b < hold - 1e-3 && mode === 'strip') {
        mode = 'open'; this.full.push([b, null, [[b, idx % n]]]);
        this.sound(b, 'whoosh', 0.5, 0, { d: 0.2 }); this.sound(b, 'pop', 0.6); this.moves.push({ t: b, move: 'open frame' });
        continue;
      }
      if (mode === 'open') {
        if (!bar) { idx++; this.full[this.full.length - 1][2].push([b, idx % n]); this.sound(b, 'tick', 0.5); this.sound(b, 'thump', 0.35); continue; }
        this.full[this.full.length - 1][1] = b; mode = 'strip'; this.flashes.push(b); this.sound(b, 'flash', 0.9);
        this.moves.push({ t: b, move: 'strip' });
      }
      if (this.steps.length) idx++;
      this.steps.push([b, idx]); this.sound(b, 'tick', 0.55); this.sound(b, 'slap', 0.25);
      if (this.steps.length > 1) this.sound(b, 'whoosh', 0.2, 0, { d: 0.12 });
    }
    if (this.full.length && this.full[this.full.length - 1][1] === null) this.full[this.full.length - 1][1] = end;
    if (title) this.titles.push([0, this.snap(Math.min(grid.bar, end / 3))]);
    this.end = this.snap(end); this.fade = [this.snap(end - B), this.end];
    this.cache = new Map(); this.bg = new Map();
    this.travel = Math.min(0.2, B * 0.5);
  }

  photo(sid, w, h) {
    const k = `${sid}|${w}|${h}`;
    if (!this.cache.has(k)) this.cache.set(k, this.sources[sid].still(w, h, 0.5));
    return this.cache.get(k);
  }
  backdrop(sid) {
    if (!this.bg.has(sid)) {
      const small = this.sources[sid].still(Math.ceil(this.W / 8), Math.ceil(this.H / 8), 0, 'blur(3px) brightness(0.5)');
      const big = canvas(this.W, this.H), x = big.getContext('2d');
      x.drawImage(small, 0, 0, this.W, this.H); this.fx.vignette(x, 0.5); this.bg.set(sid, big);
    }
    return this.bg.get(sid);
  }

  // strip position in frames: each step glides over `travel` seconds centred on its beat
  pos(t) {
    let p = this.steps.length ? this.steps[0][1] : 0;
    for (let i = 1; i < this.steps.length; i++) {
      const [t0, k] = this.steps[i], q = clamp((t - t0 + this.travel / 2) / this.travel);
      if (q <= 0) break;
      p = this.steps[i - 1][1] + (k - this.steps[i - 1][1]) * easeOut(q);
    }
    return p;
  }

  draw(ctx, t) {
    for (const [t0, t1, cuts] of this.full) {
      if (t0 <= t && t < t1) {
        const j = lastAt(cuts.map(c => c[0]), t + 1e-6), [ct, sid] = cuts[j];
        if (j === 0 && t - t0 < 0.22) return this.strip(ctx, t, easeOut((t - t0) / 0.22));
        const e = t - ct;
        this.sources[sid].draw(ctx, e, this.W, this.H, 1 + 0.06 * Math.exp(-e * 10));
        return this.finish(ctx, t);
      }
    }
    this.strip(ctx, t);
  }

  strip(ctx, t, openP = 0) {
    const { W, H, horiz } = this, p = this.pos(t);
    ctx.drawImage(this.backdrop(((Math.round(p) % this.n) + this.n) % this.n), 0, 0);
    const band = this.fh + this.hole * 6, L = horiz ? W : H, a0 = Math.floor((horiz ? H : W) / 2 - band / 2);
    ctx.fillStyle = 'rgba(14,14,14,0.85)';
    if (horiz) ctx.fillRect(0, a0, W, band); else ctx.fillRect(a0, 0, band, H);
    const hp = this.hole * 2, off = ((-(p * this.pitch) % hp) + hp) % hp;
    ctx.fillStyle = 'rgb(225,225,225)';
    for (let k = -1; k < L / hp + 2; k++) {
      const c0 = k * hp + off;
      for (const side of [a0 + this.hole, a0 + band - this.hole * 2]) {
        if (horiz) ctx.fillRect(c0, side, this.hole, this.hole); else ctx.fillRect(side, c0, this.hole, this.hole);
      }
    }
    const [fw, fh] = horiz ? [this.fl, this.fh] : [this.fh, this.fl];
    for (let k = Math.floor(p) - 3; k <= Math.floor(p) + 3; k++) {
      const d = (k - p) * this.pitch;
      const x0 = horiz ? Math.round(W / 2 + d - fw / 2) : Math.round(W / 2 - fw / 2), y0 = horiz ? Math.round(H / 2 - fh / 2) : Math.round(H / 2 + d - fh / 2);
      if (x0 > W || y0 > H || x0 + fw < 0 || y0 + fh < 0) continue;
      ctx.drawImage(this.photo(((k % this.n) + this.n) % this.n, fw, fh), x0, y0);
      ctx.fillStyle = `rgba(0,0,0,${0.35 * Math.min(1, Math.abs(k - p))})`; ctx.fillRect(x0, y0, fw, fh);
    }
    if (openP > 0) {      // the centre photo grows from its frame to the whole screen
      const w = Math.round(fw + (W - fw) * openP), h = Math.round(fh + (H - fh) * openP);
      ctx.save(); ctx.translate(Math.round((W - w) / 2), Math.round((H - h) / 2));
      this.sources[((Math.round(p) % this.n) + this.n) % this.n].draw(ctx, 0.5, w, h); ctx.restore();
    }
    this.finish(ctx, t);
  }

  finish(ctx, t) {
    for (const b of this.flashes) { const a = t - b; if (a >= 0 && a < 0.4) this.fx.flash(ctx, Math.exp(-a / 0.08)); }
    this.fadeOut(ctx, t);
  }
}

export const LOOK_STYLES = {
  zoomthru: cuts('zoomthru'), glitch: cuts('glitch'), dreamy: cuts('dreamy'), swipe: cuts('swipe'),
  filmstrip: (...a) => new Filmstrip(...a),
};
