// Photos and clips, and the frame effects the styles share (all on canvas 2D, so the GPU does the work).
import { canvas } from './util.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]];

// One photo or clip. draw(ctx, t, w, h) paints it cover-cropped into (0, 0, w, h) of the current transform at its own
// local time t, with a slow push and drift. post: {rot (degrees), dx, dy, s} around the centre (shake, whip, spin).
export class Source {
  constructor(el, isVideo, rnd, name) {
    this.el = el; this.video = isVideo; this.name = name;
    this.dir = rnd.choice(DIRS); this.zoom = isVideo ? [1.0, 1.035] : [1.02, 1.10];
    this.iw = isVideo ? el.videoWidth : el.width; this.ih = isVideo ? el.videoHeight : el.height;
    if (isVideo) { this.dur = el.duration || 10; this.inpoint = Math.min(1, this.dur * 0.1); }
    this.need = null;
  }

  // the clip time a local time shows (clips loop)
  clipTime(t) { return (this.inpoint + Math.max(0, t)) % Math.max(0.1, this.dur - 0.05); }

  draw(ctx, t, w, h, punch = 1, post = null, life = 4) {
    if (this.video) this.need = this.clipTime(t);
    const iw = this.iw, ih = this.ih;
    let p = Math.min(1, Math.max(0, t / life)); p = p * (2 - p) * 0.5 + p * 0.5;    // eased, never stops
    let z = (this.zoom[0] + (this.zoom[1] - this.zoom[0]) * p) * punch;
    if (post) {
      // canvas has no mirrored border like the Python version: zoom in just enough that a shake or tilt shows no edge
      const r = Math.abs(post.rot || 0) * Math.PI / 180;
      z *= 1 + 2 * Math.max(Math.abs(post.dx || 0) / w, Math.abs(post.dy || 0) / h) + r * (w / h + h / w) * 0.5;
    }
    const s = Math.max(w / iw, h / ih) * z;
    const dx = (iw * s - w) * 0.5 * this.dir[0] * (p - 0.5) * 0.8, dy = (ih * s - h) * 0.5 * this.dir[1] * (p - 0.5) * 0.8;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
    if (post) {
      ctx.translate(w / 2 + (post.dx || 0), h / 2 + (post.dy || 0)); ctx.rotate(-(post.rot || 0) * Math.PI / 180);
      const k = post.s || 1; ctx.scale(k, k); ctx.translate(-w / 2, -h / 2);
    }
    ctx.drawImage(this.el, w / 2 - iw * s / 2 + dx, h / 2 - ih * s / 2 + dy, iw * s, ih * s);
    ctx.restore();
  }

  // a still of the source cover-cropped into w x h (cards, film frames, backdrops)
  still(w, h, t = 0, filter = '') {
    const c = canvas(w, h), x = c.getContext('2d');
    if (filter) x.filter = filter;
    this.draw(x, t, w, h);
    return c;
  }
}

async function loadImage(blob, W, H) {
  const bm = await createImageBitmap(blob);
  // keep enough pixels for a full-frame render plus the push
  const s = Math.max(W * 1.15 / bm.width, H * 1.15 / bm.height);
  if (s >= 1) return bm;
  const r = await createImageBitmap(blob, { resizeWidth: Math.round(bm.width * s), resizeHeight: Math.round(bm.height * s), resizeQuality: 'high' });
  bm.close(); return r;
}

async function loadVideo(blob) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = URL.createObjectURL(blob);
  await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = () => bad(new Error('cannot read a video clip')); });
  return v;
}

// files: File or Blob objects (with .type)
export async function loadSources(files, W, H, rnd) {
  const out = [];
  for (const f of files) {
    const isVideo = (f.type || '').startsWith('video/');
    try { out.push(new Source(isVideo ? await loadVideo(f) : await loadImage(f, W, H), isVideo, rnd, f.name)); }
    catch (e) { console.warn('skipped', f.name, e); }
  }
  if (!out.length) throw new Error('None of the photos or clips could be opened.');
  return out;
}

// seek every clip that was drawn at a different time than it shows; true if any moved (the frame is drawn again)
export async function syncVideos(sources, fps) {
  const moves = [];
  for (const s of sources) {
    if (!s.video || s.need === null) continue;
    if (Math.abs(s.el.currentTime - s.need) > 0.5 / fps) {
      moves.push(new Promise(ok => { s.el.addEventListener('seeked', ok, { once: true }); s.el.currentTime = s.need; }));
    }
    s.need = null;
  }
  await Promise.all(moves);
  return moves.length > 0;
}

// ---- frame effects ----
// The frame is a canvas; scratch canvases of the same size are reused.

export class FX {
  constructor(W, H) {
    this.W = W; this.H = H; this.pool = []; this.vigs = {};
  }
  scratch(i) {
    while (this.pool.length <= i) { const c = canvas(this.W, this.H); this.pool.push(c); }
    const c = this.pool[i], x = c.getContext('2d');
    x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
    return [c, x];
  }

  // redraw the frame through a CSS filter (grade, blur)
  filter(ctx, f) {
    const [c, x] = this.scratch(0); x.filter = f; x.drawImage(ctx.canvas, 0, 0); x.filter = 'none';
    ctx.drawImage(c, 0, 0);
  }

  // red shifted right by kr, blue left by kb (green stays): the RGB split
  rgbSplit(ctx, kr, kb = kr) {
    if (!kr && !kb) return;
    const parts = [['#f00', kr], ['#0f0', 0], ['#00f', -kb]].map(([col, k], i) => {
      const [c, x] = this.scratch(i + 1); x.drawImage(ctx.canvas, 0, 0);
      x.globalCompositeOperation = 'multiply'; x.fillStyle = col; x.fillRect(0, 0, this.W, this.H); return [c, k];
    });
    ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.W, this.H); ctx.globalCompositeOperation = 'lighter';
    for (const [c, k] of parts) ctx.drawImage(c, k, 0);
    ctx.restore();
  }

  // average of copies: a motion blur along (dx, dy) pixels, or a zoom blur (scales around the centre)
  average(ctx, copies) {
    const [c, x] = this.scratch(0); x.drawImage(ctx.canvas, 0, 0);
    ctx.save();
    copies.forEach((m, i) => {
      ctx.globalAlpha = 1 / (i + 1);
      ctx.setTransform(m.s || 1, 0, 0, m.s || 1, (1 - (m.s || 1)) * this.W / 2 + (m.dx || 0), (1 - (m.s || 1)) * this.H / 2 + (m.dy || 0));
      ctx.drawImage(c, 0, 0);
    });
    ctx.restore();
  }
  motionBlur(ctx, kx, ky, taps = 9) {
    if (kx < 3 && ky < 3) return;
    this.average(ctx, Array.from({ length: taps }, (_, i) => ({ dx: kx * (i / (taps - 1) - 0.5), dy: ky * (i / (taps - 1) - 0.5) })));
  }
  zoomBlur(ctx, amount, step = 0.035) {
    this.average(ctx, [0, 1, 2, 3].map(k => ({ s: 1 + step * k * amount })));
  }

  wash(ctx, color, a, op = 'source-over') {
    if (a <= 0.003) return;
    ctx.save(); ctx.globalAlpha = Math.min(1, a); ctx.globalCompositeOperation = op; ctx.fillStyle = color; ctx.fillRect(0, 0, this.W, this.H); ctx.restore();
  }
  flash(ctx, a) { this.wash(ctx, '#fff', a); }
  fade(ctx, a) { this.wash(ctx, '#000', a); }
  invert(ctx, x = 0, y = 0, w = this.W, h = this.H) {
    ctx.save(); ctx.globalCompositeOperation = 'difference'; ctx.fillStyle = '#fff'; ctx.fillRect(x, y, w, h); ctx.restore();
  }

  // darker towards the corners: 1 - strength * ((x^2 + y^2) / 2)^1.5, as in the Python version
  vignette(ctx, strength) {
    if (!this.vigs[strength]) {
      const w = Math.ceil(this.W / 4), h = Math.ceil(this.H / 4), c = canvas(w, h), x = c.getContext('2d'), d = x.createImageData(w, h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const u = i / (w - 1) * 2 - 1, v = j / (h - 1) * 2 - 1, f = 255 * (1 - strength * Math.min(1, (u * u + v * v) / 2) ** 1.5), k = (j * w + i) * 4;
        d.data[k] = d.data[k + 1] = d.data[k + 2] = f; d.data[k + 3] = 255;
      }
      x.putImageData(d, 0, 0); this.vigs[strength] = c;
    }
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(this.vigs[strength], 0, 0, this.W, this.H); ctx.restore();
  }
}
