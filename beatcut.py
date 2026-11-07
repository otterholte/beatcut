"""Beatcut: CapCut-style template edits cut to the music, rendered straight to MP4.
Give it photos and/or video clips and a song; it finds the beat, lays the media out with a template style
(styles.py), adds subtle sound effects on every visual hit (sfx.py) and renders.

usage: python beatcut.py <job.json>
       python beatcut.py --media <folder> --music <song.mp3> [--style grid9] [--out out.mp4] [--title "Word Word"]
job.json: {"media": "media" | [files], "music": "music.mp3", "style": "grid9", "size": [1920, 1080], "fps": 30,
           "title": "Iceland Unseen", "seconds": 20, "seed": 1, "out": "out.mp4"}   (paths relative to the job file)
"""
import json, os, random, subprocess, sys, wave
import numpy as np, cv2
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import beats as beatlib, sfx as sfxlib, styles as stylelib, scenes
import looks
stylelib.STYLES.update(velocity=scenes.velocity, dump=scenes.dump, **looks.ALL)

IMG = ('.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff')
VID = ('.mp4', '.mov', '.webm', '.mkv', '.ogv', '.avi', '.m4v')

def ffmpeg():
    try:
        import imageio_ffmpeg; return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception: return 'ffmpeg'

def imread(p):
    # cv2.imread cannot open non-ASCII Windows paths
    return cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)

class Source:
    """One photo or clip. render(t, w, h) gives it cover-cropped into w x h at its own local time t, with a slow push."""
    def __init__(self, path, W, H, rnd):
        self.path, self.W, self.H = path, W, H
        self.video = path.lower().endswith(VID)
        self.dir = rnd.choice([(1, 0), (-1, 0), (0, 1), (0, -1), (0, 0)])
        self.zoom = (1.0, 1.035) if self.video else (1.02, 1.10)
        if self.video:
            self.cap = cv2.VideoCapture(path)
            self.vfps = self.cap.get(cv2.CAP_PROP_FPS) or 30
            n = self.cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
            self.vdur = n / self.vfps if n > 0 else 10
            self.inpoint = min(1.0, self.vdur * 0.1)
            self.idx, self.frame = -1, None
            ok, f = self.cap.read()
            if not ok: raise SystemExit('cannot read video ' + path)
            self.idx, self.frame = 0, f
        else:
            im = imread(path)
            if im is None: raise SystemExit('cannot read image ' + path)
            # keep enough pixels for a full-frame render plus the push
            s = max(W * 1.15 / im.shape[1], H * 1.15 / im.shape[0])
            if s < 1: im = cv2.resize(im, (round(im.shape[1] * s), round(im.shape[0] * s)), interpolation=cv2.INTER_AREA)
            self.img = im

    def pixels(self, t):
        if not self.video: return self.img
        want = int((self.inpoint + t) * self.vfps) % max(1, int(self.vdur * self.vfps))
        if want < self.idx:
            self.cap.set(cv2.CAP_PROP_POS_FRAMES, want); self.idx = want - 1
        while self.idx < want:
            ok, f = self.cap.read()
            if not ok: break
            self.idx += 1; self.frame = f
        return self.frame

    def render(self, t, w, h, life=4.0, punch=1.0, post=None):
        # post: an extra 2x3 transform (shake, whip, spin) applied in the same warp
        im = self.pixels(t)
        ih, iw = im.shape[:2]
        p = min(1.0, max(0.0, t / life)); p = p * (2 - p) * 0.5 + p * 0.5   # eased, never stops
        z = (self.zoom[0] + (self.zoom[1] - self.zoom[0]) * p) * punch
        s = max(w / iw, h / ih) * z
        # spare room the push leaves for a small drift
        dx = (iw * s - w) * 0.5 * self.dir[0] * (p - 0.5) * 0.8
        dy = (ih * s - h) * 0.5 * self.dir[1] * (p - 0.5) * 0.8
        M = np.float32([[s, 0, w / 2 - iw * s / 2 + dx], [0, s, h / 2 - ih * s / 2 + dy]])
        if post is not None: M = (np.vstack([post, [0, 0, 1]]) @ np.vstack([M, [0, 0, 1]]))[:2].astype(np.float32)
        flags = cv2.INTER_AREA if s < 0.5 else cv2.INTER_LINEAR
        return cv2.warpAffine(im, M, (w, h), flags=flags, borderMode=cv2.BORDER_REFLECT)

def load_media(spec, base, W, H, rnd):
    files = []
    for m in (spec if isinstance(spec, list) else [spec]):
        p = os.path.join(base, m)
        if os.path.isdir(p): files += sorted(os.path.join(p, f) for f in os.listdir(p) if f.lower().endswith(IMG + VID))
        else: files.append(p)
    if not files: raise SystemExit('no photos or clips found in ' + str(spec))
    return [Source(f, W, H, rnd) for f in files]

class Title:
    """split: half the words left of the centre cell, half right (the grid template). center: one big line."""
    def __init__(self, text, W, H, font, mode='split'):
        from PIL import Image, ImageDraw, ImageFont
        words = text.split()
        if mode == 'center': self.parts = [text, '']
        else: self.parts = [' '.join(words[:max(1, len(words) // 2)]), ' '.join(words[max(1, len(words) // 2):])]
        f = ImageFont.truetype(font, round(H * (0.11 if mode == 'center' else 0.045)))
        self.layers = []
        for i, word in enumerate(self.parts):
            if not word: continue
            box = f.getbbox(word); tw, th = box[2] - box[0] + 8, box[3] - box[1] + 8
            im = Image.new('L', (tw, th), 0); ImageDraw.Draw(im).text((4 - box[0], 4 - box[1]), word, font=f, fill=255)
            a = np.asarray(im, np.float32)[..., None] / 255
            # left word sits left of the centre cell, right word right of it, on the middle row (as in the template)
            cx = W / 2 if mode == 'center' else W / 6 if i == 0 else W * 5 / 6
            self.layers.append((a, round(cx - tw / 2), round(H / 2 - th / 2)))

    def draw(self, fr):
        for a, x, y in self.layers:
            h, w = a.shape[:2]; reg = fr[y:y + h, x:x + w].astype(np.float32)
            shadow = cv2.GaussianBlur(a, (0, 0), 3)[..., None] * 0.5
            reg = reg * (1 - shadow) ; reg = reg * (1 - a) + 255 * a
            fr[y:y + h, x:x + w] = reg.astype(np.uint8)

def compose(t, tl, sources, W, H, cells, seam, title, cache):
    # free-form styles (scenes.py) draw the whole frame themselves
    fr = tl.draw(t, sources) if hasattr(tl, 'draw') else np.zeros((H, W, 3), np.uint8)
    for ci, (x, y, w, h) in enumerate(cells if not hasattr(tl, 'draw') else []):
        c = tl.state(ci, t)
        if not c: continue
        if c['k'] == 'white':
            fr[y:y + h, x:x + w] = 245; continue
        sid = c['s']; rx, ry, rw, rh = c['rect']
        key = (sid, c['t0'], rx, ry, rw, rh)
        if key not in cache:
            punch = 1 + 0.07 * np.exp(-(t - c['punch']) * 9) if 'punch' in c else 1
            cache[key] = sources[sid].render(t - c['t0'], rw, rh, punch=punch)
        img = cache[key]
        fr[y:y + h, x:x + w] = img[y - ry:y - ry + h, x - rx:x - rx + w]
    if seam:
        for x, y, w, h in cells:
            if x > 0: fr[:, x - seam // 2:x - seam // 2 + seam] = 0
            if y > 0: fr[y - seam // 2:y - seam // 2 + seam, :] = 0
    for t0, t1 in (tl.titles if title else []):
        if t0 <= t < t1: title.draw(fr)
    return fr

def run(job, base):
    W, H = job.get('size', [1920, 1080]); fps = job.get('fps', 30)
    rnd = random.Random(job.get('seed', 1))
    out = os.path.join(base, job.get('out', 'out.mp4'))
    music = os.path.join(base, job['music'])
    print('beat: analysing', os.path.basename(music))
    audio, sr = beatlib.load(music, ffmpeg())
    grid = beatlib.analyse(audio, sr)
    # where in the song the edit starts, always on a downbeat (a template starts on the hit). In order: "start" in the
    # job; a set number of bars before the drop for styles built around one; the hook of a song much longer than
    # the edit; the first downbeat.
    style = stylelib.STYLES[job.get('style', 'grid9')]
    total = len(audio) / sr
    start = next(d for d in grid['downbeats'] if d >= -1e-3)
    if isinstance(job.get('start'), (int, float)): start = job['start']
    elif getattr(style, 'intro_bars', None) and grid['drop'] is not None:
        start = min((d for d in grid['downbeats'] if d >= -1e-3), key=lambda d: abs(d - (grid['drop'] - style.intro_bars * grid['bar'])))
    elif job.get('seconds') and total > job['seconds'] + 4:
        start = beatlib.hook(audio, sr, grid, job['seconds'])
    audio = audio[int(start * sr):]
    grid = {**grid, 'beats': [b - start for b in grid['beats']], 'downbeats': [d - start for d in grid['downbeats']],
            'drop': None if grid['drop'] is None else grid['drop'] - start}
    print(f"beat: start {start:.2f}s, {grid['bpm']:.1f} BPM, first downbeat {grid['downbeats'][0]:.2f}s, bar {grid['bar']:.2f}s, song {len(audio) / sr:.1f}s")
    sources = load_media(job['media'], base, W, H, rnd)
    print('media:', len(sources), 'files')
    seconds = min(job.get('seconds') or 1e9, len(audio) / sr)
    tl = style(grid, sources, seconds, fps, W, H, rnd, job.get('title') or '')
    end = tl.end
    print(f'plan: {len(tl.moves)} moves, {len(tl.sfx)} sound effects, {end:.2f}s')
    # audio: the song cut at the end of the edit with a short fade, plus the effects
    n = int(end * sr)
    song = audio[:n] if len(audio) >= n else np.pad(audio, ((0, n - len(audio)), (0, 0)))
    fade = int(min(0.8, end * 0.1) * sr); song[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 2
    fx = sfxlib.render(tl.sfx, n, sr, rnd) * job.get('sfx_gain', 1.0)
    mix = song * job.get('music_gain', 0.9) + fx
    mix = np.tanh(mix * 1.05) / np.tanh(1.05)
    wav, fxwav = out[:-4] + '.mix.wav', out[:-4] + '.fx.wav'
    for path, x in ((wav, mix), (fxwav, fx)):
        with wave.open(path, 'wb') as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr); w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())
    font = job.get('font') or os.path.join(HERE, 'fonts', 'Fraunces.ttf')
    mode = getattr(tl, 'title_mode', 'split')
    title = Title(job['title'], W, H, font, mode) if job.get('title') and mode else None
    cells = tl.cells; seam = 0 if hasattr(tl, 'draw') else job.get('seam', max(2, round(H / 360)))
    cmd = [ffmpeg(), '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{W}x{H}', '-r', str(fps), '-i', '-', '-i', wav,
           '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    frames = int(round(end * fps))
    for i in range(frames):
        fr = compose(i / fps, tl, sources, W, H, cells, seam, title, {})
        p.stdin.write(fr.tobytes())
        if i % (fps * 2) == 0: print(f'render {i}/{frames}', flush=True)
    p.stdin.close(); p.wait()
    # the same edit with only the sound effects: for Instagram / TikTok, where the song is added from their catalogue
    bare = out[:-4] + '-no-music.mp4'
    subprocess.run([ffmpeg(), '-v', 'error', '-y', '-i', out, '-i', fxwav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac',
                    '-b:a', '192k', '-shortest', '-movflags', '+faststart', bare], check=True)
    os.remove(wav); os.remove(fxwav)
    song_info = job.get('song') or {}
    share = {'song': song_info, 'song_start': round(start, 2), 'song_start_text': f'{int(start // 60)}:{start % 60:05.2f}',
             'length': round(end, 2), 'bpm': round(grid['bpm'], 1), 'video': os.path.basename(out), 'video_no_music': os.path.basename(bare),
             'how': 'Post the no-music video, add the song from the app\'s music library and set it to start at song_start; '
                    'the cuts are timed to that point.'}
    json.dump(share, open(out[:-4] + '.share.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    json.dump({'bpm': grid['bpm'], 'bar': grid['bar'], 'start': start, 'downbeats': grid['downbeats'][:64], 'moves': tl.moves, 'sfx': tl.sfx},
              open(out[:-4] + '.plan.json', 'w'), indent=1)
    print('wrote', out)
    return out

if __name__ == '__main__':
    a = sys.argv[1:]
    if a and a[0].endswith('.json'):
        jf = os.path.abspath(a[0]); run(json.load(open(jf, encoding='utf-8')), os.path.dirname(jf))
    else:
        opt = {a[i][2:]: a[i + 1] for i in range(0, len(a) - 1, 2) if a[i].startswith('--')}
        job = {'media': opt['media'], 'music': opt['music'], 'style': opt.get('style', 'grid9'), 'out': opt.get('out', 'beatcut.mp4')}
        if 'title' in opt: job['title'] = opt['title']
        if 'seconds' in opt: job['seconds'] = float(opt['seconds'])
        if 'size' in opt: job['size'] = [int(v) for v in opt['size'].split('x')]
        if 'start' in opt: job['start'] = float(opt['start'])
        run(job, os.getcwd())
