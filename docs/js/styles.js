// Grid styles (the same as styles.py). A style turns the beat grid and the media into a Timeline: for every cell of a
// rows x cols grid, what it shows from when (a source drawn into a rect: the whole frame = slices of one picture, a
// column, a row, or just the cell), plus the sound effects that go with each change.
//
// grid9   the viral 3x3 grid edit: one picture assembles tile by tile, columns wipe in, nine clips pop into the tiles,
//         a picture rebuilds tile by tile, beat cuts, a two-picture checkerboard, tiles drop out at the end.
// blinds  four vertical strips: wipes strip by strip, split screens, strip flashes.
// pulse   a new picture on the beat with a zoom punch, a white flash every eight pictures.
//
// Every style moves at a pace (PACES): busy songs get sixteenth-note builds and a cut on every beat, calm ones
// quarter or half notes.

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

// How fast an edit moves, in notes: `step` (beats) between the parts of a build (tiles, strips, stutters), `every`
// (beats) between cuts, `bars` per move. The song picks one (beats.js pace); the calmer second edit takes the next.
export const PACES = [
  { name: 'sixteenth notes', desc: 'Builds on sixteenth notes, a cut every beat', step: 0.25, every: 1, bars: 1 },
  { name: 'eighth notes', desc: 'Builds on eighth notes, a cut every beat', step: 0.5, every: 1, bars: 1 },
  { name: 'quarter notes', desc: 'Builds on quarter notes, a cut every two beats', step: 1, every: 2, bars: 2 },
  { name: 'half notes', desc: 'Builds on half notes, a cut every bar', step: 2, every: 4, bars: 4 },
];
export const paceOf = grid => PACES[Math.max(0, Math.min(PACES.length - 1, grid.level ?? 0))];

// the step for `count` parts of a build whose last part must start within `room` seconds: the pace's note, halved
// until it fits
export function stepFor(p, B, count, room) {
  let step = p.step * B;
  while (step * (count - 1) > room + 1e-6 && step > B / 8 + 1e-6) step /= 2;
  return step;
}

// the beats a cut lands on: every `every` beats, counted from the first bar
export function everyBeat(grid, every, from = -1e-3, to = Infinity) {
  const d0 = grid.downbeats.find(d => d >= from) ?? 0, B = grid.beat;
  return grid.beats.filter(b => b >= Math.max(from, d0 - 1e-3) && b < to && (every <= 1 || Math.round((b - d0) / B) % every === 0));
}

// hands out the media in order, round and round
export function pool(n) { let i = 0; return () => i++ % n; }

// move start times: every `perBar` bars (doubled at fast tempos) from 0 until the song or the limit runs out
export function slots(grid, seconds, perBar) {
  const bar = grid.bar, downs = grid.downbeats.filter(d => d >= -1e-3);
  let per = bar * perBar >= 1.6 ? perBar : perBar * 2;
  for (;;) {
    const starts = downs.filter((_, i) => i % per === 0), L = bar * per;
    while (starts.length && starts[starts.length - 1] + L > seconds + 0.05) starts.pop();
    if (starts.length >= 2) return [starts, L];
    // a short edit: shorter moves, so there are at least two
    if (per === 1) throw new Error('The song is too short for this style (it needs at least two bars).');
    per = Math.max(1, per >> 1);
  }
}

const SPIRAL = [6, 3, 0, 1, 2, 5, 8, 7, 4];          // the template's assemble order: up the left, across, down the right, centre last
const SPIRAL_R = [5, 8, 7, 6, 3, 0, 1, 2, 4];
const CROSS = [1, 3, 5, 7], CORNERS = [0, 2, 6, 8];

export function grid9(grid, sources, seconds, fps, W, H, rnd, hasTitle) {
  const tl = new Timeline(3, 3, W, H, fps), take = pool(sources.length), B = grid.beat, p = paceOf(grid), fast = p.step <= 0.25;
  const pop = Math.max(1, Math.round(fps * 0.04)) / fps;          // one tile per frame, like the template (the busiest pace)
  const [starts, L] = slots(grid, seconds, p.bars);
  // the calmer paces build on the note instead, fitted into the move
  // (at half notes the tiles come in threes: three steps instead of nine)
  const group = p.step >= 2 ? 3 : 1, at = i => Math.floor(i / group);
  const tiles = fast ? pop : stepFor(p, B, 9 / group, L * 0.8), buildStep = fast ? Math.max(2, Math.round(fps * 0.075)) / fps : tiles;
  const strips = fast ? B / 4 : stepFor(p, B, 3, L * 0.5);
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
      SPIRAL.forEach((ci, i) => { tl.put(t + at(i) * tiles, ci, a, 'full', t); if (i % group === 0) tl.sound(t + at(i) * tiles, 'tick', ci, 0.8); });
      if (hasTitle) { const t1 = t + Math.max(9 / group * tiles, Math.min(2 * B, L * 0.5)); tl.titles.push([tl.snap(t1), tl.snap(t + L - 2 / fps)]); tl.sound(t1, 'pop', null, 0.8); }
    } else if (move === 'columns' || move === 'rows') {
      tl.sound(t, 'whoosh', null, 0.5);
      for (let k = 0; k < 3; k++) {
        const s = take(), tk = t + k * strips;
        for (let j = 0; j < 3; j++) { const ci = move === 'columns' ? j * 3 + k : k * 3 + j; tl.put(tk, ci, s, move === 'columns' ? 'col' : 'row', tk); }
        tl.sound(tk, 'tick', move === 'columns' ? k * 3 + 1 : 4, 1.0);
      }
    } else if (move === 'mosaic') {
      tl.sound(t, 'whoosh', null, 0.6);
      rnd.shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]).forEach((ci, i) => { tl.put(t + at(i) * tiles, ci, take(), 'cell', t); if (i % group === 0) tl.sound(t + at(i) * tiles, 'tick', ci, 0.7); });
      // an accent: one tile blinks white an eighth before the next move
      const ci = rnd.choice([0, 1, 2, 3, 5, 6, 7, 8, 4, 4]), tf = t + L - B / 2, prev = tl.state(ci, tf);
      tl.white(tf, ci); tl.add(ci, tl.snap(tf + 2 / fps), prev); tl.sound(tf, 'flash', ci, 0.9);
    } else if (move === 'build') {
      const e = take(), order = rnd.random() < 0.5 ? SPIRAL_R : [...SPIRAL.slice().reverse().slice(1), 4];
      order.forEach((ci, i) => { tl.put(t + at(i) * buildStep, ci, e, 'full', t); if (i % group === 0) tl.sound(t + at(i) * buildStep, 'tick', ci, 0.75); });
    } else if (move === 'cuts') {
      // a cut every `every` beats, leaving the move's last beat to breathe
      for (let k = 0; k * p.every * B < L - B * 0.9; k++) full(t + k * p.every * B, take(), k ? 0.55 : 0.75);
    } else if (move === 'checker') {
      tl.sound(t, 'whoosh', null, 0.6);
      const a = take(), b = take();
      for (let ci = 0; ci < 9; ci++) tl.white(t, ci);
      tl.sound(t, 'flash', null, 1.0);
      for (let ci = 0; ci < 9; ci++) tl.put(t + 1 / fps, ci, [...CORNERS, 4].includes(ci) ? a : b, 'full', t);
      const tr = t + (fast ? Math.min(2 * B, L * 0.55) : L / 2);
      for (const ci of CROSS) tl.put(tr, ci, a, 'full', t);
      tl.sound(tr, 'tick', null, 1.0);
    }
  });
  const end = starts[starts.length - 1] + L;
  // tiles drop out at the end: the cross, then the corners, the centre last (on the last beat; calmer paces take longer)
  const span = fast ? 8 * pop : Math.min(2 * B, 4 * tiles), tout = end - (fast ? B : span + B / 2);
  for (const ci of CROSS) tl.clear(tout, ci);
  tl.sound(tout, 'tick', null, 1.0);
  CORNERS.forEach((ci, i) => { const tc = tout + (i + 1) * span / 5; tl.clear(tc, ci); tl.sound(tc, 'tick', ci, 0.8); });
  tl.clear(tout + span, 4); tl.sound(tout + span, 'tick', null, 0.9);
  tl.end = tl.snap(end + 0.3);
  return tl;
}

export function blinds(grid, sources, seconds, fps, W, H, rnd, hasTitle, n = 4) {
  const tl = new Timeline(1, n, W, H, fps), take = pool(sources.length), B = grid.beat, p = paceOf(grid);
  const [starts, L] = slots(grid, seconds, p.bars), step = stepFor(p, B, n, L * 0.8);
  starts.forEach((t, i) => {
    const kind = i % 2 === 0 ? 'wipe' : 'split';
    tl.moves.push({ t, move: kind });
    const order = [...Array(n).keys()]; if (i % 4 >= 2) order.reverse();
    if (kind === 'wipe') {
      const s = take();
      order.forEach((ci, k) => { tl.put(t + k * step, ci, s, 'full', t); tl.sound(t + k * step, 'tick', ci, 0.9); });
    } else {
      order.forEach((ci, k) => { tl.put(t + k * step, ci, take(), 'cell', t + k * step); tl.sound(t + k * step, 'tick', ci, 0.9); });
      const ci = rnd.randrange(n), tf = t + Math.min(L - B / 2, Math.max(n * step, Math.min(2 * B, L / 2))), prev = tl.state(ci, tf);
      tl.white(tf, ci); tl.add(ci, tl.snap(tf + 2 / fps), prev); tl.sound(tf, 'flash', ci, 0.8);
    }
    if (i === 0 && hasTitle) { const t1 = t + Math.min(L - B, Math.max(n * step, Math.min(2 * B, L / 2))); tl.titles.push([tl.snap(t1), tl.snap(t + L - 2 / fps)]); tl.sound(t1, 'pop', null, 0.8); }
    if (i + 1 < starts.length && (i + 1) % 2 === 0) tl.sound(starts[i + 1], 'whoosh', null, 0.5);
  });
  // the strips clear one by one into the end
  const end = starts[starts.length - 1] + L, out = Math.min(step, B / 2);
  for (let k = 0; k < n; k++) { const tc = end - B / 2 - (n - 1 - k) * out; tl.clear(tc, k); tl.sound(tc, 'tick', k, 0.8); }
  tl.end = tl.snap(end + 0.3);
  return tl;
}

export function pulse(grid, sources, seconds, fps, W, H, rnd, hasTitle) {
  const tl = new Timeline(1, 1, W, H, fps), take = pool(sources.length), B = grid.beat, p = paceOf(grid);
  tl.titleMode = 'center';         // one picture: the title sits in the middle
  const [starts, L] = slots(grid, seconds, p.bars), end = starts[starts.length - 1] + L;
  const isDown = b => grid.downbeats.some(d => Math.abs(d - b) < 1e-3);
  // a new picture every `every` beats; a flash every eight of them, on a bar
  everyBeat(grid, p.every, -1e-3, end - B / 2).forEach((b, i) => {
    const barStart = isDown(b), s = take();
    tl.put(b, 0, s, 'full', b, b);
    tl.sound(b, barStart ? 'thump' : 'tick', null, barStart ? 0.6 : 0.7);
    if (barStart && i % 8 === 0 && i) { tl.white(b, 0); tl.put(b + 1 / fps, 0, s, 'full', b, b); tl.sound(b, 'flash'); }
  });
  tl.moves = starts.map(t => ({ t, move: 'a cut every ' + p.every + ' beats' }));
  if (hasTitle) tl.titles.push([tl.snap(starts[0]), tl.snap(starts[0] + L)]);
  tl.clear(end - B / 2, 0); tl.sound(end - B / 2, 'tick');
  tl.end = tl.snap(end + 0.3);
  return tl;
}
