"""Find photos (and short videos) for a beat edit on Wikimedia Commons, keeping only licenses a published video may use
(public domain, CC0, CC BY, CC BY-SA). Prefers Commons "Quality images" in landscape, big enough for 1080p.
usage: python find.py <outdir> "<search words>" [count] [--video]
Writes <outdir>/credits.json (file -> title, license, artist, page)."""
import json, os, re, sys, time, urllib.parse, urllib.request
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
UA = 'Beatcut/1.0 (https://github.com/otterholte/beatcut)'
API = 'https://commons.wikimedia.org/w/api.php'
strip = lambda s: re.sub(r'\s+', ' ', re.sub(r'<[^>]*>', '', s or '')).strip()

def get(url):
    for k in range(5):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=120).read()
        except Exception as e:
            print('  retry', e); time.sleep(3 + 4 * k)
    raise SystemExit('failed ' + url)

def license_ok(lic):
    l = (lic or '').lower()
    if not l or re.search(r'\bnc\b|non-?commercial|\bnd\b|no ?deriv|fair use|copyrighted', l): return False
    return bool(re.search(r'public domain|^pd\b|pd-|cc0|no restrictions|^cc[- ]by(-sa)?\b', l))

def search(words, video=False, quality=True, limit=50):
    q = words + (' filetype:video' if video else ' filetype:bitmap') + (' incategory:Quality_images' if quality and not video else '')
    p = {'action': 'query', 'format': 'json', 'generator': 'search', 'gsrsearch': q, 'gsrnamespace': 6, 'gsrlimit': limit,
         'prop': 'imageinfo', 'iiprop': 'url|size|extmetadata|mime', 'iiurlwidth': 2560}
    pages = json.loads(get(API + '?' + urllib.parse.urlencode(p))).get('query', {}).get('pages', {})
    return sorted(pages.values(), key=lambda p: p.get('index', 0))

def find(out, words, count=12, video=False):
    os.makedirs(out, exist_ok=True)
    cf = os.path.join(out, 'credits.json'); credits = json.load(open(cf)) if os.path.exists(cf) else {}
    pages = search(words, video) or search(words, video, quality=False)
    if len(pages) < count and not video: pages += search(words, video, quality=False)
    got, seen = 0, {c['title'] for c in credits.values()}
    for p in pages:
        if got >= count: break
        ii = (p.get('imageinfo') or [{}])[0]; m = ii.get('extmetadata', {}); v = lambda k: strip((m.get(k) or {}).get('value', ''))
        lic = v('LicenseShortName')
        w, h = ii.get('width', 0), ii.get('height', 0)
        if p['title'] in seen or not license_ok(lic) or w < 1600 or w < h * 1.2: continue
        if video and (ii.get('duration') or 0) > 120: continue
        url = ii['url'] if video or w <= 2560 else ii.get('thumburl', ii['url'])
        ext = os.path.splitext(urllib.parse.urlparse(url).path)[1].lower() or '.jpg'
        k = len(credits) + 1
        while any(f.startswith(f'{k:02d}.') for f in os.listdir(out)): k += 1
        fn = f'{k:02d}{ext}'
        open(os.path.join(out, fn), 'wb').write(get(url))
        credits[fn] = {'title': p['title'], 'license': lic, 'artist': (v('Artist') or v('Credit'))[:120], 'page': ii.get('descriptionurl')}
        seen.add(p['title']); got += 1
        print(fn, w, h, '|', lic, '|', credits[fn]['artist'][:40], '|', p['title'][:60])
        json.dump(credits, open(cf, 'w'), indent=1); time.sleep(0.5)
    return got

if __name__ == '__main__':
    a = [x for x in sys.argv[1:] if not x.startswith('--')]
    n = find(a[0], a[1], int(a[2]) if len(a) > 2 else 12, '--video' in sys.argv)
    print(n, 'found')
