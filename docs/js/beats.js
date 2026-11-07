// Beat grid of a song: tempo, beat times and downbeats (bar starts), plus the drop and the hook. The same method as
// beats.py: mel-band onsets, tempo from autocorrelation, beats tracked through the song by dynamic programming (so a
// drifting tempo is followed and faint beats keep to the tempo), the drop as the moment the song gets much louder.
export const SR = 44100;

export async function decode(arrayBuffer) {
  // decoding into an OfflineAudioContext resamples to its rate
  const ctx = new OfflineAudioContext(2, 1, SR);
  const ab = await ctx.decodeAudioData(arrayBuffer);
  const L = new Float32Array(ab.getChannelData(0));
  const R = ab.numberOfChannels > 1 ? new Float32Array(ab.getChannelData(1)) : new Float32Array(L);
  return { L, R, sr: ab.sampleRate, length: L.length };
}

function fftTables(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
  return { rev, cos, sin };
}

function fft(re, im, T) {
  const n = re.length;
  for (let i = 0; i < n; i++) { const j = T.rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
      const a = i + j, b = a + half, wr = T.cos[k], wi = T.sin[k];
      const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
      re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
    }
  }
}

function melBank(n, sr, bands = 48, lo = 30, hi = 11000) {
  const mel = f => 2595 * Math.log10(1 + f / 700), inv = m => 700 * (10 ** (m / 2595) - 1);
  const edges = []; for (let i = 0; i < bands + 2; i++) edges.push(inv(mel(lo) + (mel(hi) - mel(lo)) * i / (bands + 1)));
  // each band as its first bin and triangle weights
  return Array.from({ length: bands }, (_, i) => {
    const a = edges[i], c = edges[i + 1], b = edges[i + 2], w = [];
    const b0 = Math.ceil(a * n / sr), b1 = Math.floor(b * n / sr);
    for (let k = b0; k <= b1; k++) { const f = k * sr / n; w.push(Math.max(0, Math.min((f - a) / (c - a), (b - f) / (b - c)))); }
    return { b0, w, centre: c };
  });
}

// Onset strength per hop, all bands and the low end (kick / bass) alone: positive change in log energy of mel bands, so
// lows and mids count as much as the hiss up top (as in standard beat trackers).
function onsets(mono, sr, hop, n = 2048) {
  const T = fftTables(n), win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const frames = Math.floor((mono.length + n / 2) / hop) + 1, bank = melBank(n, sr), nb = bank.length;
  const re = new Float32Array(n), im = new Float32Array(n), pw = new Float32Array(n / 2 + 1);
  const E = new Float32Array(frames * nb); let top = -Infinity;
  for (let f = 0; f < frames; f++) {
    const s0 = f * hop - n / 2;
    for (let i = 0; i < n; i++) { const k = s0 + i; re[i] = (k >= 0 && k < mono.length ? mono[k] : 0) * win[i]; im[i] = 0; }
    fft(re, im, T);
    for (let k = 0; k <= n / 2; k++) pw[k] = re[k] * re[k] + im[k] * im[k];
    for (let j = 0; j < nb; j++) {
      const { b0, w } = bank[j]; let s = 0; for (let k = 0; k < w.length; k++) s += pw[b0 + k] * w[k];
      const v = 10 * Math.log10(1e-10 + s); E[f * nb + j] = v; if (v > top) top = v;
    }
  }
  const lowBands = bank.filter(b => b.centre < 200).length, fl = top - 80;
  const env = new Float32Array(frames), low = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    let e = 0, l = 0;
    for (let j = 0; j < nb; j++) {
      const d = Math.max(E[f * nb + j], fl) - Math.max(E[(f - 1) * nb + j], fl);
      if (d > 0) { e += d; if (j < lowBands) l += d; }
    }
    env[f] = e / nb; low[f] = l / Math.max(1, lowBands);
  }
  return [detrend(env), detrend(low)];
}

// remove the slow loudness swell (a 16-frame moving average), keep the rises
function detrend(d) {
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i++) {
    let s = 0; for (let k = i - 8; k <= i + 7; k++) if (k >= 0 && k < d.length) s += d[k];
    out[i] = Math.max(0, d[i] - s / 16);
  }
  let m = 1e-9; for (const v of out) m = Math.max(m, v);
  for (let i = 0; i < out.length; i++) out[i] /= m;
  return out;
}

// Beat times (in frames) that follow the song: dynamic programming over the onset envelope, as in Ellis (2007). Each
// beat is the best onset about one period after the last one; straying from the tempo costs `tight`, so a song that
// drifts is followed, and where the onsets are faint the beats simply keep to the tempo.
function track(o, period, tight = 300) {
  const n = o.length; let m = 0, v = 0;
  for (const x of o) m += x; m /= n; for (const x of o) v += (x - m) ** 2;
  const sd = Math.sqrt(v / n) + 1e-9;
  const lo = Math.max(1, Math.round(period / 2)), hi = Math.round(period * 2), pen = [];
  for (let l = lo; l <= hi; l++) pen.push(-tight * Math.log(l / period) ** 2);
  const C = new Float64Array(n), P = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    C[t] = o[t] / sd; if (t < lo) continue;
    let best = -Infinity, bp = -1;
    for (let l = lo; l <= hi && t - l >= 0; l++) { const c = C[t - l] + pen[l - lo]; if (c > best) { best = c; bp = t - l; } }
    if (best > 0) { C[t] += best; P[t] = bp; }
  }
  // the last beat: the strongest chain ending in the final period and a half
  let t = Math.max(0, n - Math.floor(period * 1.5));
  for (let i = t; i < n; i++) if (C[i] > C[t]) t = i;
  const b = []; while (t >= 0) { b.push(t); t = P[t]; }
  b.reverse();
  // carry the grid on at the tempo before the first and after the last tracked beat (silence, a fade)
  const head = []; for (let x = b[0] - period; x > -period; x -= period) head.unshift(x);
  const tail = []; for (let x = b[b.length - 1] + period; x < n + period; x += period) tail.push(x);
  return [...head, ...b, ...tail];
}

// RMS loudness in windows of w samples, centred like numpy's 'same' convolution, sampled every w
function loudness(mono, w) {
  const pre = new Float64Array(mono.length + 1);
  for (let i = 0; i < mono.length; i++) pre[i + 1] = pre[i] + mono[i] * mono[i];
  const n = Math.ceil(mono.length / w), out = new Float32Array(n), h = Math.floor((w - 1) / 2);
  for (let j = 0; j < n; j++) {
    const i = j * w, a = Math.max(0, i - (w - 1 - h)), b = Math.min(mono.length, i + h + 1);
    out[j] = Math.sqrt((pre[b] - pre[a]) / w + 1e-9);
  }
  return out;
}

const mean = (a, i, j) => { i = Math.max(0, i); j = Math.min(a.length, j); let s = 0; for (let k = i; k < j; k++) s += a[k]; return j > i ? s / (j - i) : 0; };
const interp = (e, x) => { const i = Math.floor(x); if (i < 0) return e[0]; if (i >= e.length - 1) return e[e.length - 1]; return e[i] + (e[i + 1] - e[i]) * (x - i); };
const sum = (e, ps) => ps.reduce((s, p) => s + interp(e, p), 0);

export function mono(audio) {
  const m = new Float32Array(audio.length);
  for (let i = 0; i < m.length; i++) m[i] = (audio.L[i] + audio.R[i]) / 2;
  return m;
}

export function analyse(audio) {
  const sr = audio.sr, m = mono(audio), hop = 256, rate = sr / hop;
  const [env, low] = onsets(m, sr, hop);
  // tempo: autocorrelation over 70..180 BPM, nudged towards ~110 so double/half tempo are not picked
  const maxLag = Math.ceil(rate * 60 / 70 * 4) + 3, ac = new Float32Array(maxLag);
  for (let l = 0; l < maxLag; l++) { let s = 0; for (let i = 0; i + l < env.length; i++) s += env[i] * env[i + l]; ac[l] = s; }
  const at = lag => { const i = Math.floor(lag), fr = lag - i; return i + 1 < ac.length ? ac[i] * (1 - fr) + ac[i + 1] * fr : null; };
  let best = -1, period = rate * 60 / 110;
  for (let bpm = 70; bpm < 180; bpm += 0.1) {
    const lag = rate * 60 / bpm; let v = at(lag); if (v === null) continue;
    for (const k of [2, 4]) { const x = at(lag * k); if (x !== null) v += 0.5 * x; }   // a real beat lines up at 2 and 4 beats too
    v *= Math.exp(-0.5 * (Math.log2(bpm / 110) / 0.9) ** 2);
    if (v > best) { best = v; period = lag; }
  }
  // beats, tracked through the song so a drifting tempo is followed. The kick counts most (so off-beat hi-hats don't
  // pull the beats half a beat off), but only when the low end has a steady pulse of its own: songs without drums have none.
  const comb = e => {
    const c = [];
    for (let p = 0; p < period; p += 0.5) { let s = 0, k = 0; for (let x = p; x < e.length - 1; x += period) { s += interp(e, x); k++; } c.push(s / k); }
    return Math.max(...c) / (c.reduce((a, b) => a + b, 0) / c.length + 1e-9);
  };
  const kick = comb(low) > 1.4 ? 1.5 : 0;
  const o = env.map((v, i) => v + kick * low[i]);
  let pos = track(o, period);
  // clarity: how much stronger the onsets are on the beats than on average; faint beats keep strictly to the tempo
  const om = o.reduce((a, b) => a + b, 0) / o.length, inside = pos.filter(p => p >= 0 && p < o.length - 1);
  if (sum(o, inside) / inside.length / (om + 1e-9) < 1.6) pos = track(o, period, 1000);
  let beats = pos.map(p => p / rate);
  const gaps = pos.slice(1).map((p, i) => p - pos[i]).sort((a, b) => a - b); period = gaps[gaps.length >> 1];
  // a drop: the moment the song gets much louder (1 s after against 1 s before), with a floor so a fade-in is not one
  const w = Math.floor(0.02 * sr), loud = loudness(m, w), n = 50;
  const sorted = Float32Array.from(loud).sort(), floor = 0.15 * sorted[sorted.length >> 1];
  let bestR = 0, bi = -1;
  for (let i = n; i < loud.length - n; i++) { const r = mean(loud, i, i + n) / Math.max(floor, mean(loud, i - n, i)); if (r > bestR) { bestR = r; bi = i; } }
  const nearest = t => { let j = 0; beats.forEach((b, i) => { if (Math.abs(b - t) < Math.abs(beats[j] - t)) j = i; }); return j; };
  let drop = null;
  if (bestR > 3) {
    let i = bi;
    while (i > n && loud[i - 1] > Math.max(floor, mean(loud, i - n, i)) * 2) i--;      // back to the very start of the hit
    const dropT = i * w / sr; let j = nearest(dropT);
    // the drop is on a beat: when the beats sit half a beat off (locked to off-beat hats), use the half-way points
    if (Math.abs(beats[j] - dropT) > period / rate * 0.25) { beats = beats.slice(1).map((b, i) => (b + beats[i]) / 2); j = nearest(dropT); }
    drop = j;
  }
  let k = 0;
  if (drop !== null) k = drop % 4;
  else {
    let bestK = -1;
    for (let j = 0; j < 4; j++) {
      const p = beats.filter((_, i) => i % 4 === j).map(b => b * rate), v = (sum(low, p) + 0.5 * sum(env, p)) / Math.max(1, p.length);
      if (v > bestK) { bestK = v; k = j; }
    }
  }
  const down = beats.filter((_, i) => i % 4 === k);
  // bars before the first full one still count (a pickup), so the edit can start at 0
  const bar = period * 4 / rate;
  while (down[0] - bar > -0.05) down.unshift(down[0] - bar);
  const B = period / rate;
  return { bpm: 60 * rate / period, beat: B, bar, beats, drop: drop === null ? null : beats[drop], downbeats: down.filter(d => d > -bar), pace: pace(env, beats, B, rate) };
}

// How busy the music is between the beats, as the pace an edit should move at (an index into styles.js PACES):
// 0 sixteenth notes (busy hi-hats, strong off-beats), 1 eighth notes, 2 quarter notes (a song with little between its
// beats, like a strummed folk song). Fast songs move one step calmer.
function pace(env, beats, B, rate) {
  const peak = t => { const i = Math.round(t * rate); let m = 0; for (let k = i - 2; k <= i + 2; k++) if (k >= 0 && k < env.length) m = Math.max(m, env[k]); return m; };
  const inSong = beats.filter(b => b > 0 && b < env.length / rate - 1);
  const avg = f => inSong.reduce((s, b) => s + f(b), 0) / Math.max(1, inSong.length);
  const q = avg(peak) + 1e-9, e = avg(b => peak(b + B / 2)) / q, s = avg(b => (peak(b + B / 4) + peak(b + 3 * B / 4)) / 2) / q;
  let level = e >= 0.9 && s >= 0.2 ? 0 : e >= 0.7 ? 1 : 2;
  if (60 / B > 140) level = Math.min(3, level + 1);
  return { level, eighths: +e.toFixed(2), sixteenths: +s.toFixed(2) };
}

// The downbeat where the best `seconds` of a long song start: loud throughout, and best of all where the song jumps up
// (a chorus or drop coming in): the part a short video would use.
export function hook(audio, grid, seconds) {
  const sr = audio.sr, m = mono(audio), w = Math.floor(0.05 * sr), loud = loudness(m, w), rate = sr / w;
  const avg = (a, b) => mean(loud, Math.floor(a * rate), Math.max(1, Math.floor(b * rate)));
  const bar = grid.bar, total = m.length / sr, g = mean(loud, 0, loud.length);
  const cands = grid.downbeats.filter(d => d >= 0 && d + seconds <= total);
  if (!cands.length) return grid.downbeats.find(d => d >= -1e-3);
  const score = d => avg(d, d + seconds) / g + 0.5 * Math.min(2, Math.max(0, avg(d, d + 2 * bar) / Math.max(avg(d - 2 * bar, d), 1e-6) - 1));
  return cands.reduce((a, b) => score(b) > score(a) ? b : a);
}
