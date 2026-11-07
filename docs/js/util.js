// Small helpers shared by the styles: a seeded random source (so the same seed gives the same edit) and easing.
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0; let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const r = {
    random: next,
    uniform: (lo, hi) => lo + (hi - lo) * next(),
    randrange: n => Math.floor(next() * n),
    choice: arr => arr[Math.floor(next() * arr.length)],
    shuffle: arr => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; },
    normal: (mu = 0, sd = 1) => mu + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  };
  return r;
}

export const easeOut = p => 1 - (1 - p) ** 3;
export const easeIn = p => p ** 3;
export const clamp = p => Math.min(1, Math.max(0, p));

// index of the last item in a sorted list that is <= t (or 0)
export function lastAt(sorted, t) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= t) lo = m + 1; else hi = m; }
  return Math.max(0, lo - 1);
}

export function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
  return c;
}
