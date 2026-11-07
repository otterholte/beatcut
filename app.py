"""Beatcut web app: drop in photos/clips and a song (or let it find photos and compose a song), pick one of the
styles, get the edit as an MP4, plus a copy with only the sound effects for posting with a catalogue song.
usage: python app.py [port]   ->  http://localhost:8300
Jobs are folders in jobs/web-<id>/ (job.json, media/, the song, status.json, the videos)."""
import email, email.policy, json, os, re, subprocess, sys, threading, time, uuid
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
HERE = os.path.dirname(os.path.abspath(__file__))
JOBS = os.path.join(HERE, 'jobs')
PY = sys.executable
MAX_UPLOAD = 800 * 1024 * 1024
MEDIA_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.mp4', '.mov', '.webm', '.m4v')
SONG_EXT = ('.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac')

STYLES = [
    {'key': 'grid9', 'name': 'Grid 9', 'desc': 'A photo builds tile by tile in a 3x3 grid, columns wipe in, nine photos pop into the tiles, checkerboard swaps, tiles drop out.', 'needs': 10, 'sample': 'iceland/iceland-grid9.mp4'},
    {'key': 'velocity', 'name': 'Velocity', 'desc': 'Phonk shake edit: a dark intro and stutter cuts into the drop, then flash, shake, RGB split and whip pans on every beat.', 'needs': 8, 'sample': 'velocity/velocity-phone.mp4'},
    {'key': 'dump', 'name': 'Photo dump', 'desc': 'Polaroids drop onto the table one per beat and pile up, with your caption on the first. Zooms into full-screen beat cuts.', 'needs': 8, 'sample': 'dump/dump.mp4'},
    {'key': 'zoomthru', 'name': '3D zoom', 'desc': 'A new photo every beat, punching in through a zoom blur with a slight tilt; a flash on each bar.', 'needs': 6, 'sample': 'dump/v-zoomthru.mp4'},
    {'key': 'glitch', 'name': 'Glitch', 'desc': 'Torn slices, RGB split and inverted blocks on every cut, scanlines, a full invert on the bar.', 'needs': 6, 'sample': 'dump/v-glitch.mp4'},
    {'key': 'swipe', 'name': 'Swipe stack', 'desc': 'Each photo slides in over the last on the beat, with a little overshoot, directions turning round the screen.', 'needs': 6, 'sample': 'dump/v-swipe.mp4'},
    {'key': 'filmstrip', 'name': 'Film strip', 'desc': 'A roll of film advancing one frame per beat; every fourth bar a frame opens up to full screen.', 'needs': 6, 'sample': 'dump/v-filmstrip.mp4'},
    {'key': 'dreamy', 'name': 'Dreamy', 'desc': 'Soft aesthetic slideshow: a photo per bar, blur dissolves, glow, a warm light leak and film grain.', 'needs': 4, 'sample': 'dump/v-dreamy.mp4'},
    {'key': 'pulse', 'name': 'Beat pulse', 'desc': 'A new photo on every beat with a zoom punch, a thump on each bar and a white flash every two bars.', 'needs': 6, 'sample': 'iceland/iceland-pulse.mp4'},
    {'key': 'blinds', 'name': 'Blinds', 'desc': 'Four vertical strips: photos wipe in strip by strip on sixteenth notes, then split into four.', 'needs': 6, 'sample': 'iceland/iceland-blinds.mp4'},
]
KEYS = {s['key'] for s in STYLES}
render_lock = threading.Lock()          # one render at a time: each uses the whole CPU

def status(jd, **kw):
    f = os.path.join(jd, 'status.json')
    s = json.load(open(f, encoding='utf-8')) if os.path.exists(f) else {}
    s.update(kw); s['updated'] = time.time()
    json.dump(s, open(f + '.tmp', 'w', encoding='utf-8')); os.replace(f + '.tmp', f)
    return s

def run_step(jd, args, step):
    status(jd, step=step)
    p = subprocess.Popen([PY, *args], cwd=jd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace')
    log = []
    for line in p.stdout:
        log.append(line.rstrip()); m = re.match(r'render (\d+)/(\d+)', line)
        if m: status(jd, progress=int(m[1]) / max(1, int(m[2])))
        if line.startswith('beat:'): status(jd, beat=line[5:].strip())
    p.wait()
    open(os.path.join(jd, step + '.log'), 'w', encoding='utf-8').write('\n'.join(log))
    if p.returncode: raise RuntimeError(f'{step} failed: ' + ' / '.join(log[-3:]))

def process(jd, job, find, prompt):
    try:
        media = os.path.join(jd, 'media')
        if find and not any(f.lower().endswith(MEDIA_EXT) for f in os.listdir(media)):
            run_step(jd, [os.path.join(HERE, 'find.py'), 'media', find, '14'], 'finding photos')
        if prompt and not job.get('music'):
            run_step(jd, [os.path.join(HERE, 'music.py'), 'song.mp3', str(job['seconds'] + 4), prompt], 'making the song')
            job['music'] = 'song.mp3'
        if not any(f.lower().endswith(MEDIA_EXT) for f in os.listdir(media)): raise RuntimeError('no photos or clips to use')
        if not job.get('music'): raise RuntimeError('no song')
        json.dump(job, open(os.path.join(jd, 'job.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
        status(jd, step='waiting for the renderer')
        with render_lock:
            status(jd, progress=0)
            run_step(jd, [os.path.join(HERE, 'beatcut.py'), 'job.json'], 'editing')
        share = json.load(open(os.path.join(jd, 'edit.share.json'), encoding='utf-8'))
        status(jd, state='done', step='done', progress=1, share=share)
    except Exception as e:
        status(jd, state='error', error=str(e))

def parse_form(ctype, body):
    msg = email.message_from_bytes(b'Content-Type: ' + ctype.encode() + b'\r\n\r\n' + body, policy=email.policy.HTTP)
    fields, files = {}, []
    for part in msg.iter_parts():
        name = part.get_param('name', header='content-disposition')
        data = part.get_payload(decode=True) or b''
        if part.get_filename(): files.append((name, part.get_filename(), data))
        else: fields[name] = data.decode('utf-8', 'replace').strip()
    return fields, files

def new_job(fields, files):
    jid = time.strftime('%m%d-%H%M%S-') + uuid.uuid4().hex[:4]
    jd = os.path.join(JOBS, 'web-' + jid); os.makedirs(os.path.join(jd, 'media'))
    song, n = None, 0
    for name, fn, data in files:
        ext = os.path.splitext(fn)[1].lower()
        if name == 'media' and ext in MEDIA_EXT:
            n += 1; open(os.path.join(jd, 'media', f'{n:03d}{ext}'), 'wb').write(data)
        elif name == 'song' and ext in SONG_EXT and data:
            song = 'song' + ext; open(os.path.join(jd, song), 'wb').write(data)
    style = fields.get('style') if fields.get('style') in KEYS else 'grid9'
    vertical = fields.get('format', 'vertical') == 'vertical'
    job = {'media': 'media', 'music': song, 'style': style, 'size': [1080, 1920] if vertical else [1920, 1080], 'fps': 30,
           'seconds': max(6, min(60, float(fields.get('seconds') or 15))), 'seed': int(time.time()) % 1000, 'out': 'edit.mp4',
           'song': {k: fields.get('song_' + k, '') for k in ('title', 'artist', 'link')}}
    if fields.get('title'): job['title'] = fields['title'][:60]
    if fields.get('start'):
        try: job['start'] = float(fields['start'])
        except ValueError: pass
    status(jd, state='working', step='starting', progress=0, style=style, photos=n)
    threading.Thread(target=process, args=(jd, job, fields.get('find', '')[:80], fields.get('prompt', '')[:600]), daemon=True).start()
    return jid

class Handler(BaseHTTPRequestHandler):
    def send(self, code, body, ctype='application/json'):
        if isinstance(body, (dict, list)): body = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', ctype); self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def file(self, path, ctype):
        if not os.path.isfile(path): return self.send(404, {'error': 'not found'})
        size = os.path.getsize(path); rng = re.match(r'bytes=(\d+)-(\d*)', self.headers.get('Range', ''))
        a, b = (int(rng[1]), int(rng[2]) if rng[2] else size - 1) if rng else (0, size - 1)
        self.send_response(206 if rng else 200); self.send_header('Content-Type', ctype); self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(b - a + 1))
        if rng: self.send_header('Content-Range', f'bytes {a}-{b}/{size}')
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(a); left = b - a + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk: break
                try: self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError): return
                left -= len(chunk)

    def do_GET(self):
        u = self.path.split('?')[0]
        if u == '/': return self.file(os.path.join(HERE, 'web', 'index.html'), 'text/html; charset=utf-8')
        if u == '/api/styles':
            return self.send(200, [{**s, 'sample': '/samples/' + s['sample'] if os.path.exists(os.path.join(JOBS, s['sample'])) else None} for s in STYLES])
        m = re.fullmatch(r'/api/jobs/([\w-]+)', u)
        if m:
            f = os.path.join(JOBS, 'web-' + m[1], 'status.json')
            return self.send(200, json.load(open(f, encoding='utf-8'))) if os.path.exists(f) else self.send(404, {'error': 'no such job'})
        m = re.fullmatch(r'/files/([\w-]+)/([\w.-]+\.mp4)', u)
        if m: return self.file(os.path.join(JOBS, 'web-' + m[1], m[2]), 'video/mp4')
        m = re.fullmatch(r'/samples/(\w+)/([\w.-]+\.mp4)', u)
        if m: return self.file(os.path.join(JOBS, m[1], m[2]), 'video/mp4')
        self.send(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/api/jobs': return self.send(404, {'error': 'not found'})
        n = int(self.headers.get('Content-Length') or 0)
        if n > MAX_UPLOAD: return self.send(413, {'error': 'upload too big'})
        fields, files = parse_form(self.headers.get('Content-Type', ''), self.rfile.read(n))
        self.send(200, {'id': new_job(fields, files)})

    def log_message(self, *a): pass

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8300
    print(f'Beatcut on http://localhost:{port}')
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
