// Subtle edit sound effects, synthesised so they are always in sync and cost nothing (the same sounds as sfx.py):
// tick (a tile popping in), whoosh (a riser into a big change; "d" makes it longer), flash (a white frame), thump (a hard
// cut), pop (title), impact (a drop), slap (a photo landing), glitch (a digital tear).
// Each effect is {t: seconds, k: kind, pan: -1..1, g: gain}.

const env = (n, a, d, sr) => { const e = new Float32Array(n); for (let i = 0; i < n; i++) { const t = i / sr; e[i] = Math.min(1, t / Math.max(a, 1e-4)) * Math.exp(-t / d); } return e; };
const noise = (n, rnd) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = rnd.normal(); return x; };
// one-pole low-pass, a in 0..1 (bigger = darker), a can be a function of the sample index
const lp = (x, a) => { const y = new Float32Array(x.length); let acc = 0; for (let i = 0; i < x.length; i++) { const k = typeof a === 'function' ? a(i) : a; acc += (1 - k) * (x[i] - acc); y[i] = acc; } return y; };
const sweep = (n, sr, f) => { const y = new Float32Array(n); let ph = 0; for (let i = 0; i < n; i++) { ph += 2 * Math.PI * f(i / sr) / sr; y[i] = Math.sin(ph); } return y; };
const pad = (x, n) => { const y = new Float32Array(n); y.set(x.subarray(0, n)); return y; };

function tick(sr, rnd) {
  const n = Math.floor(0.05 * sr), f = 2600 * rnd.uniform(0.85, 1.2), e1 = env(n, 0.0004, 0.006, sr), e2 = env(n, 0.0001, 0.0015, sr), e3 = env(n, 0.001, 0.012, sr);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / sr; y[i] = (Math.sin(2 * Math.PI * f * t) * e1[i] * 0.5 + rnd.normal() * e2[i] * 0.35 + Math.sin(2 * Math.PI * 180 * t) * e3[i] * 0.6) * 0.22; }
  return y;
}

function whoosh(sr, rnd, d = 0.45) {
  const n = Math.floor(d * sr), x = noise(n, rnd);
  const p = i => i / Math.max(1, n - 1);
  let y = lp(x, i => 0.985 - 0.17 * p(i) ** 2); const lo = lp(y, 0.995);
  let m = 1e-9; for (let i = 0; i < n; i++) { y[i] -= lo[i]; m = Math.max(m, Math.abs(y[i])); }
  for (let i = 0; i < n; i++) y[i] = y[i] / m * p(i) ** 2.2 * Math.min(1, (1 - p(i)) * 40) * 0.16;
  return y;
}

function flash(sr, rnd) {
  const n = Math.floor(0.18 * sr), x = noise(n, rnd), l = lp(x, 0.6), e = env(n, 0.0005, 0.035, sr), tk = pad(tick(sr, rnd), n);
  const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = tk[i] * 0.8 + (x[i] - l[i]) * e[i] * 0.10;
  return y;
}

function thump(sr) {
  const n = Math.floor(0.35 * sr), s = sweep(n, sr, t => 75 * Math.exp(-t * 6) + 42), e = env(n, 0.002, 0.09, sr);
  for (let i = 0; i < n; i++) s[i] *= e[i] * 0.28;
  return s;
}

function pop(sr) {
  const n = Math.floor(0.12 * sr), s = sweep(n, sr, t => 520 + 900 * Math.exp(-t * 40)), e = env(n, 0.001, 0.03, sr);
  for (let i = 0; i < n; i++) s[i] *= e[i] * 0.12;
  return s;
}

// a hit for drops and big cuts: the low thump plus a short, gritty crack
function impact(sr, rnd) {
  const n = Math.floor(0.5 * sr), x = noise(n, rnd), l = lp(x, 0.3), e = env(n, 0.0003, 0.025, sr), th = pad(thump(sr), n);
  const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = th[i] * 1.2 + Math.tanh((x[i] - l[i]) * 3) * e[i] * 0.10;
  return y;
}

// a photo landing on a table: a soft, papery slap
function slap(sr, rnd) {
  const n = Math.floor(0.09 * sr), l = lp(noise(n, rnd), 0.55), e = env(n, 0.0008, 0.012, sr), th = thump(sr);
  const y = new Float32Array(n); for (let i = 0; i < n; i++) y[i] = l[i] * e[i] * 0.5 + th[i] * 0.25;
  return y;
}

// a digital tear: stuttering sample-and-hold noise, like a corrupted buffer
function glitch(sr, rnd) {
  const n = Math.floor(0.14 * sr), hold = 20 + rnd.randrange(140), e = env(n, 0.0005, 0.06, sr), y = new Float32Array(n);
  let v = 0, gate = true;
  for (let i = 0; i < n; i++) { if (i % hold === 0) v = rnd.uniform(-1, 1); if (i % 900 === 0) gate = rnd.random() > 0.35; y[i] = gate ? v * e[i] * 0.09 : 0; }
  return y;
}

const KINDS = { tick, whoosh, flash, thump, pop, impact, slap, glitch };

export function render(events, n, sr, rnd) {
  const L = new Float32Array(n), R = new Float32Array(n);
  for (const e of events) {
    const s = e.k === 'whoosh' && e.d ? whoosh(sr, rnd, e.d) : KINDS[e.k](sr, rnd), g = e.g ?? 1;
    // a whoosh ends on its moment, everything else starts on it
    const i = Math.round(e.t * sr) - (e.k === 'whoosh' ? s.length : 0);
    const pan = e.pan || 0, gl = Math.cos((pan + 1) * Math.PI / 4) * 1.41 * g, gr = Math.sin((pan + 1) * Math.PI / 4) * 1.41 * g;
    for (let k = Math.max(0, -i); k < s.length && i + k < n; k++) { L[i + k] += s[k] * gl; R[i + k] += s[k] * gr; }
  }
  return { L, R };
}
