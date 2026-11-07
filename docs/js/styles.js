// Grid styles (the same as styles.py). A style turns the beat grid and the media into a Timeline: for every cell of a
// rows x cols grid, what it shows from when (a source drawn into a rect: the whole frame = slices of one picture, a
// column, a row, or just the cell), plus the sound effects that go with each change.
//
// grid9   the viral 3x3 grid edit: one picture assembles tile by tile, columns wipe in, nine clips pop into the tiles,
//         a picture rebuilds tile by tile, beat cuts, a two-picture checkerboard, tiles drop out at the end.
// blinds  four vertical strips: wipes strip by strip on sixteenth notes, split screens, strip flashes.
// pulse   one picture per beat with a zoom punch, a white flash every two bars.

export class Timeline {
  constructor(rows, cols, W, H, fps) {
    Object.assign(this, { rows, cols, W, H, fps });
    const xs = [], ys = [];
    for (let c = 0; c <= cols; c++) xs.push(Math.round(c * W / cols));
    for (let r = 0; r <= rows; r++) ys.push(Math.round(r * H / rows));
    this.xs = xs; this.ys = ys; this.cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) this.cells.push([xs[c], ys[r], xs[c + 1] - xs[c], ys[r + 1] - ys[r]]);
    this.ev = this.cells.map(() => []);
    this.sfx = []; this.titles = []; this.moves = []; this.end = 0; this.titleMode = 'split';
  }
  snap(t) { return Math.round(t * this.fps) / this.fps; }

  rect(kind, ci) {
    const r = Math.floor(ci / this.cols), c = ci % this.cols;
    if (kind === 'full') return [0, 0, this.W, this.H];
    if (kind === 'col') return [this.xs[c], 0, this.xs[c + 1] - this.xs[c], this.H];
    if (kind === 'row') return [0, this.ys[r], this.W, this.ys[r + 1] - this.ys[r]];
    return this.cells[ci];
  }

  put(t, ci, sid, kind = 'full', t0 = null, punch = null) {
    t = this.snap(t);
    const c = { k: 'src', s: sid, rect: this.rect(kind, ci), t0: this.snap(t0 === null ? t : t0) };
    if (punch !== null) c.punch = this.snap(punch);
    this.add(ci, t, c);
  }
  white(t, ci) { this.add(ci, this.snap(t), { k: 'white' }); }
  clear(t, ci) { this.add(ci, this.snap(t), null); }

  add(ci, t, c) {
    const ev = this.ev[ci]; let i = 0;
    while (i < ev.length && ev[i][0] <= t) i++;
    // a later instruction for the same frame replaces the earlier one
    if (i && ev[i - 1][0] === t) ev[i - 1] = [t, c]; else ev.splice(i, 0, [t, c]);
  }
  state(ci, t) {
    let out = null;
    for (const [et, c] of this.ev[ci]) { if (et <= t + 1e-6) out = c; else break; }
    return out;
  }
  pan(ci) { const c = ci % this.cols; return this.cols === 1 ? 0 : (c / (this.cols - 1) * 2 - 1) * 0.6; }
  sound(t, k, ci = null, g = 1) { this.sfx.push({ t: this.snap(t), k, pan: ci === null ? 0 : this.pan(ci), g }); }
}

// hands out the media in order, round and round
export function pool(n) { let i = 0; return () => i++ % n; }

// move start times: every bar (or every two bars at fast tempos) from 0 until the song or the limit runs out
export function slots(grid, seconds, perBar) {
  const bar = grid.bar, per = bar * perBar >= 1.6 ? perBar : perBar * 2;
  const downs = grid.downbeats.filter(d => d >= -1e-3);
  const starts = downs.filter((_, i) => i % per === 0), L = bar * per;
  while (starts.length && starts[starts.length - 1] + L > seconds + 0.05) starts.pop();
  if (starts.length < 2) throw new Error('The song is too short for this style (it needs at least two bars).');
  return [starts, L];
}

const SPIRAL = [6, 3, 0, 1, 2, 5, 8, 7, 4];          // the template's assemble order: up the left, across, down the right, centre last
const SPIRAL_R = [5, 8, 7, 6, 3, 0, 1, 2, 4];
const CROSS = [1, 3, 5, 7], CORNERS = [0, 2, 6, 8];

export function grid9(grid, sources, seconds, fps, W, H, rnd, hasTitle) {
  const tl = new Timeline(3, 3, W, H, fps), take = pool(sources.length), B = grid.beat;
  const pop = Math.max(1, Math.round(fps * 0.04)) / fps;          // one tile per frame, like the template
  const buildStep = Math.max(2, Math.round(fps * 0.075)) / fps;
  const [starts, L] = slots(grid, seconds, 1);
  const body = ['columns', 'mosaic', 'build', 'cuts', 'checker', 'rows', 'mosaic', 'build', 'checker', 'cuts'];
  const plan = ['assemble', ...starts.slice(1).map((_, i) => body[i % body.length])];
  // the last move shows one picture, so the drop-out at the end breaks a whole image apart like the template
  if (plan.length > 2 && !['build', 'cuts', 'checker'].includes(plan[plan.length - 1])) plan[plan.length - 1] = 'build';
  const full = (t, sid, g) => { for (let ci = 0; ci < 9; ci++) tl.put(t, ci, sid, 'full', t); tl.sound(t, 'thump', null, g); };

  starts.forEach((t, si) => {
    const move = plan[si];
    tl.moves.push({ t, move });
    if (move === 'assemble') {
      const a = take();
      SPIRAL.forEach((ci, i) => { tl.put(t + i * pop, ci, a, 'full', t); tl.sound(t + i * pop, 'tick', ci, 0.8); });
      if (hasTitle) { const t1 = t + Math.min(2 * B, L * 0.5); tl.titles.push([tl.snap(t1), tl.snap(t + L - 2 / fps)]); tl.sound(t1, 'pop', null, 0.8); }
    } else if (move === 'columns' || move === 'rows') {
      tl.sound(t, 'whoosh', null, 0.5);
      for (let k = 0; k < 3; k++) {
        const s = take(), tk = t + k * B / 4;
        for (let j = 0; j < 3; j++) { const ci = move === 'columns' ? j * 3 + k : k * 3 + j; tl.put(tk, ci, s, move === 'columns' ? 'col' : 'row', tk); }
        tl.sound(tk, 'tick', move === 'columns' ? k * 3 + 1 : 4, 1.0);
      }
    } else if (move === 'mosaic') {
      tl.sound(t, 'whoosh', null, 0.6);
      rnd.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]).forEach((ci, i) => { tl.put(t + i * pop, ci, take(), 'cell', t); tl.sound(t + i * pop, 'tick', ci, 0.7); });
      // an accent: one tile blinks white an eighth before the next bar
      const ci = rnd.choice([0, 1, 2, 3, 5, 6, 7, 8, 4, 4]), tf = t + L - B / 2, prev = tl.state(ci, tf);
      tl.white(tf, ci); tl.add(ci, tl.snap(tf + 2 / fps), prev); tl.sound(tf, 'flash', ci, 0.9);
    } else if (move === 'build') {
      const e = take(), order = rnd.random() < 0.5 ? SPIRAL_R : [...SPIRAL.slice().reverse().slice(1), 4];
      order.forEach((ci, i) => { tl.put(t + i * buildStep, ci, e, 'full', t); tl.sound(t + i * buildStep, 'tick', ci, 0.75); });
    } else if (move === 'cuts') {
      for (let k = 0; k < 3; k++) full(t + k * B, take(), k ? 0.55 : 0.75);
    } else if (move === 'checker') {
      tl.sound(t, 'whoosh', null, 0.6);
      const a = take(), b = take();
      for (let ci = 0; ci < 9; ci++) tl.white(t, ci);
      tl.sound(t, 'flash', null, 1.0);
      for (let ci = 0; ci < 9; ci++) tl.put(t + 1 / fps, ci, [...CORNERS, 4].includes(ci) ? a : b, 'full', t);
      const tr = t + Math.min(2 * B, L * 0.55);
      for (const ci of CROSS) tl.put(tr, ci, a, 'full', t);
      tl.sound(tr, 'tick', null, 1.0);
    }
  });
  const end = starts[starts.length - 1] + L;
  // tiles drop out on the last beat: the cross, then the corners, the centre last
  const tout = end - B;
  for (const ci of CROSS) tl.clear(tout, ci);
  tl.sound(tout, 'tick', null, 1.0);
  CORNERS.forEach((ci, i) => { tl.clear(tout + (i + 1) * 2 * pop, ci); tl.sound(tout + (i + 1) * 2 * pop, 'tick', ci, 0.8); });
  tl.clear(tout + 6 * 2 * pop / 1.5, 4); tl.sound(tout + 6 * 2 * pop / 1.5, 'tick', null, 0.9);
  tl.end = tl.snap(end + 0.3);
  return tl;
}

export function blinds(grid, sources, seconds, fps, W, H, rnd, hasTitle, n = 4) {
  const tl = new Timeline(1, n, W, H, fps), take = pool(sources.length), B = grid.beat;
  const [starts, L] = slots(grid, seconds, 1), s16 = B / 4;
  starts.forEach((t, i) => {
    const kind = i % 2 === 0 ? 'wipe' : 'split';
    tl.moves.push({ t, move: kind });
    const order = [...Array(n).keys()]; if (i % 4 >= 2) order.reverse();
    if (kind === 'wipe') {
      const s = take();
      order.forEach((ci, k) => { tl.put(t + k * s16, ci, s, 'full', t); tl.sound(t + k * s16, 'tick', ci, 0.9); });
    } else {
      order.forEach((ci, k) => { tl.put(t + k * s16, ci, take(), 'cell', t + k * s16); tl.sound(t + k * s16, 'tick', ci, 0.9); });
      const ci = rnd.randrange(n), tf = t + 2 * B, prev = tl.state(ci, tf);
      tl.white(tf, ci); tl.add(ci, tl.snap(tf + 2 / fps), prev); tl.sound(tf, 'flash', ci, 0.8);
    }
    if (i === 0 && hasTitle) { tl.titles.push([tl.snap(t + 2 * B), tl.snap(t + L - 2 / fps)]); tl.sound(t + 2 * B, 'pop', null, 0.8); }
    if (i + 1 < starts.length && (i + 1) % 2 === 0) tl.sound(starts[i + 1], 'whoosh', null, 0.5);
  });
  const end = starts[starts.length - 1] + L;
  for (let k = 0; k < n; k++) { tl.clear(end - B + k * s16, k); tl.sound(end - B + k * s16, 'tick', k, 0.8); }
  tl.end = tl.snap(end + 0.3);
  return tl;
}

export function pulse(grid, sources, seconds, fps, W, H, rnd, hasTitle) {
  const tl = new Timeline(1, 1, W, H, fps), take = pool(sources.length), B = grid.beat;
  tl.titleMode = 'center';         // one picture: the title sits in the middle
  const [starts, L] = slots(grid, seconds, 1), end = starts[starts.length - 1] + L;
  const beats = grid.beats.filter(b => b >= -1e-3 && b < end - B / 2);
  const isDown = b => grid.downbeats.some(d => Math.abs(d - b) < 1e-3);
  beats.forEach((b, i) => {
    const barStart = isDown(b), s = take();
    tl.put(b, 0, s, 'full', b, b);
    tl.sound(b, barStart ? 'thump' : 'tick', null, barStart ? 0.6 : 0.7);
    if (barStart && i % 8 === 0 && i) { tl.white(b, 0); tl.put(b + 1 / fps, 0, s, 'full', b, b); tl.sound(b, 'flash'); }
  });
  tl.moves = starts.map(t => ({ t, move: 'beat cuts' }));
  if (hasTitle) tl.titles.push([tl.snap(starts[0]), tl.snap(starts[0] + L)]);
  tl.clear(end - B / 2, 0); tl.sound(end - B / 2, 'tick');
  tl.end = tl.snap(end + 0.3);
  return tl;
}
