// Free-form styles (the same as scenes.py): the style draws every whole frame itself with draw(ctx, t).
//
// velocity  the phonk "shake" edit: a dark, letterboxed intro cutting every two beats, sixteenth-note stutter cuts and a
//           riser into the drop; on the drop a white flash, hard shake, RGB split and full colour; then a cut on every
//           beat with whip pans (motion-blurred), zoom-throughs and flashes on the bars, double-time cuts every other
//           bar, and a held last shot that fades out.
// dump      the photo dump: polaroids drop onto a blurred backdrop one per beat and pile up, a caption on the first;
//           every fourth bar it zooms into the top photo for full-screen beat cuts, then a camera flash brings the pile
//           back; piles are swept off the table on the bar.
import { slots, paceOf } from './styles.js';
import { easeOut, easeIn, clamp, lastAt, canvas } from './util.js';

export class Scene {
  constructor(W, H, fps, fx) {
    Object.assign(this, { W, H, fps, fx });
    this.sfx = []; this.titles = []; this.moves = []; this.end = 0; this.titleMode = 'center';
  }
  snap(t) { return Math.round(t * this.fps) / this.fps; }
  sound(t, k, g = 1, pan = 0, extra = {}) { this.sfx.push({ t: this.snap(t), k, g, pan, ...extra }); }
  fadeOut(ctx, t) { const [a0, a1] = this.fade; if (t > a0) this.fx.fade(ctx, clamp((t - a0) / (a1 - a0))); }
}

export class Velocity extends Scene {
  constructor(grid, sources, seconds, fps, W, H, rnd, title, fx) {
    super(W, H, fps, fx);
    this.sources = sources;
    const B = grid.beat, bar = grid.bar; this.B = B;
    const [starts, L] = slots(grid, seconds, 1), end = starts[starts.length - 1] + L;
    const downs = grid.downbeats.filter(d => d >= -1e-3 && d < end);
    let drop = grid.drop;
    if (drop === null || drop < bar * 0.9 || drop > end - 2 * bar) drop = downs[1];
    this.drop = drop = this.snap(drop);
    const beats = grid.beats.filter(b => b >= -1e-3 && b < end - 1e-3);
    let k = 0; const take = () => k++ % sources.length;
    const p = paceOf(grid);
    this.shots = []; this.hits = [];          // shots: [t, sid, transition, dir]; hits: [t, shake, rgb, flash]
    // intro: a new shot every two beats (four when calm), then stutter cuts into the drop: four sixteenths, four
    // eighths, or two eighths at the calm paces
    const sStep = Math.min(p.step, 0.5) * B, sCount = p.step >= 1 ? 2 : 4, sFrom = drop - sCount * sStep;
    for (const b of beats) {
      if (b >= sFrom - 1e-3) break;
      if (Math.round((b - beats[0]) / B) % Math.min(4, 2 * p.every) === 0) this.shots.push([this.snap(b), take(), 'cut', null]);
    }
    for (let j = 0; j < sCount; j++) {
      const ts = sFrom + j * sStep;
      this.shots.push([this.snap(ts), take(), 'cut', null]); this.sound(ts, 'tick', 0.5 + 0.1 * j); this.hits.push([this.snap(ts), 0.12, 0, 0]);
    }
    this.sound(drop, 'whoosh', 0.75, 0, { d: Math.min(drop, bar) });
    if (title) this.titles.push([0, this.snap(drop - B)]);
    this.moves.push({ t: 0, move: 'intro' }, { t: drop, move: 'drop' });
    // the drop
    this.shots.push([drop, take(), 'flash', null]); this.hits.push([drop, 1, 1, 1]);
    this.sound(drop, 'impact', 1); this.sound(drop, 'flash', 0.6);
    // after the drop: a cut every beat (or every `every` beats); the last bar holds one shot
    const hold = this.snap(end - bar), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    beats.filter(x => x > drop + 1e-3 && x < hold - 1e-3 && Math.round((x - drop) / B) % p.every === 0).forEach((b0, i) => {
      const b = this.snap(b0), onBar = downs.some(d => Math.abs(b - d) < 0.02);
      if (onBar) {
        const kind = this.moves.length % 2 ? 'flash' : 'zoom';
        this.moves.push({ t: b, move: 'bar ' + kind });
        this.shots.push([b, take(), kind, null]); this.hits.push([b, 0.6, 0.7, kind === 'flash' ? 0.8 : 0]);
        this.sound(b, 'impact', 0.7);
        if (kind === 'zoom') this.sound(b, 'whoosh', 0.45, 0, { d: 0.22 });
      } else {
        const d = rnd.choice(dirs);
        this.shots.push([b, take(), 'whip', d]); this.hits.push([b, 0.25, 0.2, 0]);
        this.sound(b, 'whoosh', 0.35, -0.5 * d[0], { d: 0.16 }); this.sound(b, 'tick', 0.35);
        // double time on the off-beat of beat 3, every other bar (at the busiest pace)
        if (p.step <= 0.25 && i % 8 === 6) { const t2 = this.snap(b + B / 2); this.shots.push([t2, take(), 'cut', null]); this.hits.push([t2, 0.3, 0.3, 0]); this.sound(t2, 'tick', 0.6); }
      }
    });
    this.shots.push([hold, take(), 'flash', null]); this.hits.push([hold, 0.8, 0.8, 0.9]);
    this.sound(hold, 'impact', 0.9); this.moves.push({ t: hold, move: 'final hold' });
    this.shots.sort((a, b) => a[0] - b[0]);
    this.starts = this.shots.map(s => s[0]);
    this.end = this.snap(end); this.fade = [this.snap(end - B), this.end];
    this.phase = new Map(this.hits.map(h => [h, [rnd.uniform(0, 6.3), rnd.uniform(0, 6.3), rnd.uniform(0, 6.3)]]));
    this.wd = Math.min(0.12, B / 3);       // whip / zoom half-length
  }

  draw(ctx, t) {
    const { W, H, fx, wd } = this;
    const i = lastAt(this.starts, t + 1e-6), [st, sid, kind, d] = this.shots[i], nx = this.shots[i + 1];
    const local = t - st;
    let z = 1.04 + (kind === 'flash' || kind === 'zoom' ? 0.14 * Math.exp(-local * 7) : 0.05 * Math.exp(-local * 9));
    let dx = 0, dy = 0, rot = 0, blur = [0, 0], radial = 0;
    // whip: the outgoing shot accelerates away, the incoming one arrives at speed and settles; both blur
    if (kind === 'whip' && local < wd) {
      const q = local / wd, off = 0.35 * (1 - q) ** 3, sp = 1.05 * (1 - q) ** 2 / wd / this.fps;
      dx = d[0] * W * off; dy = d[1] * H * off; blur = [d[0] ? Math.min(300, sp * W) : 0, d[1] ? Math.min(300, sp * H) : 0];
    }
    if (nx && nx[2] === 'whip' && nx[0] - t < wd) {
      const p = 1 - (nx[0] - t) / wd, off = -0.35 * p ** 3, nd = nx[3], sp = 1.05 * p ** 2 / wd / this.fps;
      dx = nd[0] * W * off; dy = nd[1] * H * off; blur = [nd[0] ? Math.min(300, sp * W) : 0, nd[1] ? Math.min(300, sp * H) : 0];
    }
    if (kind === 'zoom' && local < wd) { const q = local / wd; z *= 1 + 0.35 * (1 - q) ** 3; radial = (1 - q) ** 2; }
    if (nx && nx[2] === 'zoom' && nx[0] - t < wd) { const p = 1 - (nx[0] - t) / wd; z *= 1 + 0.5 * p ** 3; radial = p ** 2; }
    // shake, RGB split and flash from recent hits
    let rgb = 0, flash = 0;
    for (const h of this.hits) {
      const [ht, sh, rg, fl] = h, a = t - ht;
      if (a < 0 || a > 0.6) continue;
      const ph = this.phase.get(h), e = Math.exp(-a / 0.15);
      dx += sh * e * 0.03 * W * Math.sin(2 * Math.PI * 11 * a + ph[0]);
      dy += sh * e * 0.025 * H * Math.sin(2 * Math.PI * 13 * a + ph[1]);
      rot += sh * e * 2.5 * Math.sin(2 * Math.PI * 7 * a + ph[2]);
      rgb = Math.max(rgb, rg * Math.exp(-a / 0.09)); flash = Math.max(flash, fl * Math.exp(-a / 0.07));
    }
    const intro = t < this.drop;
    // the grade rides on the draw: dark and desaturated before the drop, punchy after
    ctx.filter = intro ? 'saturate(0.35) brightness(0.78)' : 'saturate(1.18) contrast(1.12)';
    this.sources[sid].draw(ctx, local, W, H, z, { rot, dx, dy });
    ctx.filter = 'none';
    fx.motionBlur(ctx, blur[0], blur[1]);
    if (radial > 0.05) fx.zoomBlur(ctx, radial);
    fx.vignette(ctx, 0.55);
    fx.rgbSplit(ctx, Math.round(rgb * 22 * W / 1920));
    fx.flash(ctx, flash);
    this.fadeOut(ctx, t);
    // letterbox in the intro, snapping open on the drop
    const lb = 0.11 * H * (intro ? 1 : 1 - easeOut(clamp((t - this.drop) / 0.12)));
    if (lb >= 1) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, Math.floor(lb)); ctx.fillRect(0, H - Math.floor(lb), W, Math.floor(lb)); }
  }
}
export const velocity = (...a) => new Velocity(...a);
velocity.introBars = 2;          // the edit starts this many bars before the drop

export class Dump extends Scene {
  constructor(grid, sources, seconds, fps, W, H, rnd, title, fx) {
    super(W, H, fps, fx);
    this.sources = sources; this.title = title; this.titleMode = null;       // the title is a caption on the first photo
    const B = grid.beat, bar = grid.bar; this.B = B;
    const [starts, L] = slots(grid, seconds, 1), end = starts[starts.length - 1] + L;
    // a card (or a full-screen cut) every `every` beats of the pace
    const every = paceOf(grid).every, d0 = grid.downbeats.find(d => d >= -1e-3) ?? 0;
    const beats = grid.beats.filter(b => b >= -1e-3 && b < end - 1e-3 && Math.round((b - d0) / B) % every === 0).map(b => this.snap(b));
    const downs = grid.downbeats.filter(d => d >= -1e-3 && d < end).map(d => this.snap(d));
    this.P = W >= H ? Math.round(0.6 * H) : Math.round(0.74 * W);        // photo side on screen
    this.cards = []; this.full = []; this.flashes = [];                     // full: [t0, t1, sid]
    let k = 0; const take = () => k++ % sources.length;
    this.fall = Math.min(0.14, B * 0.4);
    let pile = [], mode = 'pile', zoomAt = 0;
    const lastBar = downs.length ? downs[downs.length - 1] : end - bar;
    for (const b of beats) {
      const bi = downs.filter(d => d <= b + 1e-3).length - 1, onBar = downs.some(d => Math.abs(b - d) < 1e-3), ph = ((bi % 4) + 4) % 4;
      if (onBar) {
        this.moves.push({ t: b, move: b < lastBar ? ['pile', 'pile', 'zoom in', 'flash back'][ph] : 'final' });
        if (ph === 0 && pile.length && b < lastBar) {
          for (const c of pile) c.sweep = [b, rnd.choice([-1, 1])];
          this.sound(b, 'whoosh', 0.6, 0, { d: 0.25 }); pile = [];
        }
        if (ph === 2 && pile.length && b < lastBar) {
          pile[pile.length - 1].zoom = b; mode = 'full'; zoomAt = b;
          this.sound(b, 'whoosh', 0.5, 0, { d: 0.2 }); this.sound(b, 'pop', 0.8);
          continue;
        }
        if (ph === 3 && mode === 'full') {
          // (at a calm pace the zoomed photo may have held the whole bar, with no full-screen cuts after it)
          const f = this.full[this.full.length - 1];
          if (f && f[0] >= zoomAt) f[1] = b;
          mode = 'pile';
          for (const c of pile) c.gone = b;
          pile = []; this.flashes.push(b); this.sound(b, 'flash', 0.9);
        }
      }
      if (mode === 'full') {
        const f = this.full[this.full.length - 1];
        if (f && f[1] > b) f[1] = b;
        this.full.push([b, b + bar, take()]); this.sound(b, 'tick', 0.6); this.sound(b, 'thump', 0.35);
        continue;
      }
      // a card lands on this beat
      const c = { sid: take(), land: b, x: W / 2 + rnd.uniform(-0.16, 0.16) * W, y: H / 2 + rnd.uniform(-0.05, 0.05) * H, rot: rnd.uniform(-8, 8), from: rnd.choice([-1, 1]) };
      if (!this.cards.length && title) c.caption = title;
      pile.push(c); this.cards.push(c);
      this.sound(b, 'slap', 0.9, (c.x / W - 0.5) * 1.2); this.sound(b, 'tick', 0.25);
    }
    const lastFull = this.full[this.full.length - 1];
    if (lastFull && mode === 'full' && lastFull[0] >= zoomAt) lastFull[1] = end;
    const out = this.snap(end - B / 2);
    for (const c of pile) if (!c.sweep) c.sweep = [out, rnd.choice([-1, 1])];
    this.sound(out, 'whoosh', 0.6, 0, { d: 0.25 });
    this.end = this.snap(end + 0.2); this.fade = [out, this.end];
    this.tex = new Map(); this.bg = new Map();
  }

  // the polaroid for a card: photo square, white frame, a deeper bottom edge; drawn at 1.5x for crispness
  texture(c) {
    const key = c.sid + '|' + (c.caption || '');
    if (this.tex.has(key)) return this.tex.get(key);
    const P = Math.round(this.P * 1.5), b = Math.round(P * 0.06), bb = Math.round(P * 0.24);
    const card = canvas(P + 2 * b, P + b + bb), x = card.getContext('2d');
    x.fillStyle = 'rgb(246,243,238)'; x.fillRect(0, 0, card.width, card.height);
    const src = this.sources[c.sid], s = Math.min(src.iw, src.ih);
    x.drawImage(src.el, (src.iw - s) / 2, (src.ih - s) / 2, s, s, b, b, P, P);
    if (c.caption) {
      x.font = `italic ${Math.round(bb * 0.42)}px Fraunces, Georgia, serif`; x.fillStyle = 'rgb(48,44,40)'; x.textAlign = 'center'; x.textBaseline = 'top';
      x.fillText(c.caption, card.width / 2, b + P + bb * 0.22, card.width - 2 * b);
    }
    this.tex.set(key, card);
    return card;
  }

  backdrop(sid) {
    if (!this.bg.has(sid)) {
      const w = Math.ceil(this.W / 8), h = Math.ceil(this.H / 8), small = canvas(w, h), sx = small.getContext('2d');
      const src = this.sources[sid], s = Math.max(w / src.iw, h / src.ih);
      sx.filter = 'blur(3px) saturate(0.8) brightness(0.78)';
      sx.drawImage(src.el, (w - src.iw * s) / 2 - 6, (h - src.ih * s) / 2 - 6, src.iw * s + 12, src.ih * s + 12);
      const big = canvas(this.W, this.H), bx = big.getContext('2d');
      bx.imageSmoothingQuality = 'high'; bx.drawImage(small, 0, 0, this.W, this.H); this.fx.vignette(bx, 0.45);
      this.bg.set(sid, big);
    }
    return this.bg.get(sid);
  }

  // where a card is at time t: null before it falls in and after it has left
  pose(c, t) {
    const { W, H } = this, t0 = c.land - this.fall;
    if (t < t0 || t >= (c.gone ?? 1e9)) return null;
    const q = clamp((t - t0) / this.fall);
    let s = 1 + 0.45 * (1 - easeOut(q)), a = clamp(q * 3);
    let x = c.x, y = c.y - 0.06 * H * (1 - easeOut(q)), rot = c.rot + 10 * c.from * (1 - easeOut(q));
    if (q >= 1) { const e = t - c.land; s *= 1 - 0.012 * Math.sin(e * 40) * Math.exp(-e * 12); }      // a little settle after landing
    const lift = 1 - easeOut(q);
    if (c.zoom !== undefined && t >= c.zoom) {
      const p = easeOut(clamp((t - c.zoom) / 0.22)), S = Math.max(W, H) / this.P * 1.02;
      s += (S - s) * p; x += (W / 2 - x) * p; y += (H / 2 - y) * p; rot *= 1 - p;
      y -= this.P * 0.09 * s * p;           // aim the photo square, not the whole card, at the screen centre
    }
    if (c.sweep) {
      const [ts, dr] = c.sweep, p = clamp((t - (ts - 0.2)) / 0.2);
      if (p >= 1) return null;
      x += dr * 1.4 * W * easeIn(p); rot += dr * 25 * easeIn(p);
    }
    return { s, x, y, rot, a, lift };
  }

  paste(ctx, card, { s, x, y, rot, a, lift }) {
    const k = s / 1.5;
    ctx.save();
    ctx.globalAlpha = a;
    // a soft shadow that grows and drifts while the card is in the air
    const off = Math.round(0.012 * this.H * (1 + 3 * lift));
    ctx.shadowColor = `rgba(0,0,0,${0.5 - 0.25 * lift})`; ctx.shadowBlur = (6 + 18 * lift) * 2; ctx.shadowOffsetX = off / 2; ctx.shadowOffsetY = off;
    ctx.translate(x, y); ctx.rotate(-rot * Math.PI / 180); ctx.scale(k, k);
    ctx.drawImage(card, -card.width / 2, -card.height / 2);
    ctx.restore();
  }

  draw(ctx, t) {
    const { W, H, fx } = this;
    for (const [t0, t1, sid] of this.full) {
      if (t0 <= t && t < t1) { const e = t - t0; this.sources[sid].draw(ctx, e, W, H, 1 + 0.06 * Math.exp(-e * 10)); return this.finish(ctx, t); }
    }
    const landed = this.cards.filter(c => c.land <= t && t < (c.gone ?? 1e9) && (!c.sweep || t < c.sweep[0] - 0.2));
    const top = landed.length ? landed[landed.length - 1].sid : (this.cards.length ? this.cards[0].sid : 0);
    ctx.drawImage(this.backdrop(top), 0, 0);
    if (landed.length > 1) {   // the backdrop eases over to the newest photo
      const q = clamp((t - landed[landed.length - 1].land) / 0.15);
      if (q < 1) { ctx.save(); ctx.globalAlpha = 1 - q; ctx.drawImage(this.backdrop(landed[landed.length - 2].sid), 0, 0); ctx.restore(); }
    }
    for (const c of this.cards) { const p = this.pose(c, t); if (p) this.paste(ctx, this.texture(c), p); }
    this.finish(ctx, t);
  }

  finish(ctx, t) {
    for (const b of this.flashes) { const a = t - b; if (a >= 0 && a < 0.4) this.fx.flash(ctx, Math.exp(-a / 0.08)); }
    this.fadeOut(ctx, t);
  }
}
export const dump = (...a) => new Dump(...a);
