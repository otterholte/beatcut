// Beatcut in the browser: song + photos/clips in, two MP4s out (the edit with the song, and the same edit with only the
// sound effects, for posting with the song from Instagram's or TikTok's own library). Everything runs on the visitor's
// device: the beat finding, the drawing (canvas) and the encoding (WebCodecs + mp4-muxer).
import { Muxer, ArrayBufferTarget } from '../vendor/mp4-muxer.js';
import { decode, analyse, hook, SR } from './beats.js';
import { render as renderSfx } from './sfx.js';
import { rng } from './util.js';
import { loadSources, syncVideos, FX } from './media.js';
import { grid9, blinds, pulse } from './styles.js';
import { velocity, dump } from './scenes.js';
import { LOOK_STYLES } from './looks.js';

// grid styles take no effects kit (and blinds has its own last argument), so they are wrapped
const grid = f => (g, s, sec, fps, W, H, rnd, title) => f(g, s, sec, fps, W, H, rnd, !!title);
export const STYLES = { grid9: grid(grid9), blinds: grid(blinds), pulse: grid(pulse), velocity, dump, ...LOOK_STYLES };

export function supported() { return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined'; }

async function pickVideoCodec(W, H, fps) {
  const bitrate = Math.round(W * H * fps * 0.2);
  for (const hw of ['no-preference', 'prefer-software'])
    for (const codec of ['avc1.640033', 'avc1.640028', 'avc1.4d0033', 'avc1.42003e', 'avc1.42001f']) {
      const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration: hw };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) { /* try the next */ }
    }
  throw new Error('This browser cannot encode H.264 video. Try Chrome or Edge on a computer.');
}

async function pickAudioCodec() {
  const aac = { codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 192000 };
  try { if ((await AudioEncoder.isConfigSupported(aac)).supported) return { cfg: aac, mux: 'aac' }; } catch (e) { /* fall back */ }
  const opus = { codec: 'opus', sampleRate: SR, numberOfChannels: 2, bitrate: 160000 };
  if ((await AudioEncoder.isConfigSupported(opus)).supported) return { cfg: opus, mux: 'opus' };
  throw new Error('This browser cannot encode audio. Try Chrome or Edge.');
}

async function encodeAudio(muxer, acodec, L, R) {
  let err = null;
  const enc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => err = e });
  enc.configure(acodec.cfg);
  for (let i = 0; i < L.length; i += SR) {
    const n = Math.min(SR, L.length - i), data = new Float32Array(n * 2);
    data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
    enc.encode(new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / SR * 1e6), data }));
  }
  await enc.flush(); enc.close();
  if (err) throw err;
}

function drawTitle(ctx, text, mode, W, H) {
  const words = text.split(/\s+/).filter(Boolean);
  const parts = mode === 'center' ? [[text, W / 2]] : [[words.slice(0, Math.max(1, words.length >> 1)).join(' '), W / 6], [words.slice(Math.max(1, words.length >> 1)).join(' '), W * 5 / 6]];
  ctx.save();
  ctx.font = `${Math.round(H * (mode === 'center' ? (W < H ? 0.07 : 0.11) : 0.045))}px Fraunces, Georgia, serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 8;
  // the left words sit left of the centre cell, the right words right of it, on the middle row (as in the template)
  for (const [s, x] of parts) if (s) ctx.fillText(s, x, H / 2, mode === 'center' ? W * 0.9 : W / 3 * 0.92);
  ctx.restore();
}

function compose(ctx, t, tl, sources, title, W, H) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (tl.draw) tl.draw(ctx, t);
  else {
    tl.cells.forEach(([x, y, w, h], ci) => {
      const c = tl.state(ci, t);
      if (!c) return;
      if (c.k === 'white') { ctx.fillStyle = 'rgb(245,245,245)'; ctx.fillRect(x, y, w, h); return; }
      const [rx, ry, rw, rh] = c.rect, punch = c.punch !== undefined ? 1 + 0.07 * Math.exp(-(t - c.punch) * 9) : 1;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); ctx.translate(rx, ry);
      sources[c.s].draw(ctx, t - c.t0, rw, rh, punch);
      ctx.restore();
    });
    // thin black seams between the cells, as in the template
    const seam = Math.max(2, Math.round(H / 360)); ctx.fillStyle = '#000';
    for (const [x, y] of tl.cells) { if (x > 0) ctx.fillRect(x - seam / 2, 0, seam, H); if (y > 0) ctx.fillRect(0, y - seam / 2, W, seam); }
  }
  if (title && tl.titleMode) for (const [a, b] of tl.titles) if (a <= t && t < b) drawTitle(ctx, title, tl.titleMode, W, H);
}

const nearestDown = (grid, t) => grid.downbeats.filter(d => d >= -1e-3).reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);

// opts: {media: [File], song: ArrayBuffer, songInfo: {title, artist, link}, style, seconds, start (number or null),
//        title, W, H, fps, seed, canvas (shows the frames as they render), onProgress(fraction, text), signal}
export async function makeEdit(opts) {
  const { W, H } = opts, fps = opts.fps || 30, rnd = rng(opts.seed || 1), say = opts.onProgress || (() => {});
  say(0, 'Listening to the song');
  const audio = await decode(opts.song);
  await new Promise(r => setTimeout(r, 30));
  let g = analyse(audio);
  const style = STYLES[opts.style] || STYLES.grid9, total = audio.length / SR;
  // where in the song the edit starts, always on a downbeat (a template starts on the hit): the start asked for; a set
  // number of bars before the drop for styles built around one; the hook of a song much longer than the edit; the
  // first downbeat
  let start = g.downbeats.find(d => d >= -1e-3);
  if (Number.isFinite(opts.start)) start = nearestDown(g, opts.start);
  else if (style.introBars && g.drop !== null) start = nearestDown(g, g.drop - style.introBars * g.bar);
  else if (opts.seconds && total > opts.seconds + 4) start = hook(audio, g, opts.seconds);
  const s0 = Math.max(0, Math.round(start * SR));
  const cut = { L: audio.L.subarray(s0), R: audio.R.subarray(s0) };
  g = { ...g, beats: g.beats.map(b => b - start), downbeats: g.downbeats.map(d => d - start), drop: g.drop === null ? null : g.drop - start };
  const beatInfo = `${g.bpm.toFixed(0)} BPM, starting at ${fmt(start)} in the song`;
  say(0.02, 'Opening the photos', beatInfo);
  const sources = await loadSources(opts.media, W, H, rnd);
  const fx = new FX(W, H);
  const seconds = Math.min(opts.seconds || 1e9, cut.L.length / SR);
  const tl = style(g, sources, seconds, fps, W, H, rnd, opts.title || '', fx);
  const end = tl.end, n = Math.round(end * SR);

  // audio: the song cut at the end of the edit with a short fade, plus the effects
  const fxA = renderSfx(tl.sfx, n, SR, rnd), mixL = new Float32Array(n), mixR = new Float32Array(n);
  const fade = Math.round(Math.min(0.8, end * 0.1) * SR), k = Math.tanh(1.05);
  for (let i = 0; i < n; i++) {
    const f = i > n - fade ? ((n - i) / fade) ** 2 : 1;
    mixL[i] = Math.tanh(((cut.L[i] || 0) * f * 0.9 + fxA.L[i]) * 1.05) / k;
    mixR[i] = Math.tanh(((cut.R[i] || 0) * f * 0.9 + fxA.R[i]) * 1.05) / k;
  }

  // video: encoded once, muxed twice (with the song, and with only the effects)
  const vcfg = await pickVideoCodec(W, H, fps), acodec = await pickAudioCodec();
  const mk = () => new Muxer({ target: new ArrayBufferTarget(), fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width: W, height: H, frameRate: fps }, audio: { codec: acodec.mux, sampleRate: SR, numberOfChannels: 2 } });
  const withSong = mk(), bare = mk();
  let err = null;
  const venc = new VideoEncoder({ output: (c, m) => { withSong.addVideoChunk(c, m); bare.addVideoChunk(c, m); }, error: e => err = e });
  venc.configure(vcfg);
  const cv = opts.canvas; cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  const frames = Math.round(end * fps), hasVideo = sources.some(s => s.video), t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (err) throw err;
    const t = i / fps;
    compose(ctx, t, tl, sources, opts.title, W, H);
    // clips are seeked to the moment each frame shows, then the frame is drawn again
    for (let pass = 0; hasVideo && pass < 3 && await syncVideos(sources, fps); pass++) compose(ctx, t, tl, sources, opts.title, W, H);
    const vf = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: i % (fps * 2) === 0 }); vf.close();
    while (venc.encodeQueueSize > 4) await new Promise(r => setTimeout(r, 2));
    if (i % 3 === 0) {
      const left = (performance.now() - t0) / (i + 1) * (frames - i) / 1000;
      say(0.05 + 0.9 * i / frames, `Cutting it to the beat (${Math.ceil(left)} s left)`, beatInfo);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  await venc.flush(); venc.close();
  if (err) throw err;
  say(0.96, 'Mixing the sound', beatInfo);
  await encodeAudio(withSong, acodec, mixL, mixR);
  await encodeAudio(bare, acodec, fxA.L, fxA.R);
  withSong.finalize(); bare.finalize();
  const share = { song: opts.songInfo || {}, song_start: +start.toFixed(2), song_start_text: fmt(start), length: +end.toFixed(2), bpm: +g.bpm.toFixed(1) };
  say(1, 'Done', beatInfo);
  return {
    video: new Blob([withSong.target.buffer], { type: 'video/mp4' }),
    bare: new Blob([bare.target.buffer], { type: 'video/mp4' }),
    share, plan: { bpm: g.bpm, start, moves: tl.moves, sfx: tl.sfx },
  };
}

export const fmt = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
