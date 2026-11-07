"""Compose a music bed for a beat edit with ElevenLabs Music (key from ELEVENLABS_API_KEY or elevenlabs_key.txt).
usage: python music.py <out.mp3> <seconds> "<prompt>"
The prompt is wrapped so the track has a clear, steady beat to cut on."""
import json, os, sys, urllib.request, urllib.error
BEAT = ('Instrumental only, no vocals. A steady, clearly audible beat at a fixed tempo with strong downbeats on every bar, '
        'tight drums, no tempo changes, no rubato, starts on the beat with no long intro, ends cleanly on a final hit. ')

def key():
    k = os.environ.get('ELEVENLABS_API_KEY')
    if k: return k.strip()
    return open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'elevenlabs_key.txt')).read().strip()

def make(out, seconds, prompt):
    body = {'prompt': BEAT + prompt, 'music_length_ms': int(max(10, min(300, seconds)) * 1000), 'force_instrumental': True}
    req = urllib.request.Request('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128', data=json.dumps(body).encode(),
                                 headers={'xi-api-key': key(), 'Content-Type': 'application/json'})
    try:
        data = urllib.request.urlopen(req, timeout=600).read()
    except urllib.error.HTTPError as e:
        raise SystemExit(f'music failed: {e} {e.read()[:300]}')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    open(out, 'wb').write(data)
    return out

if __name__ == '__main__':
    print(make(sys.argv[1], float(sys.argv[2]), sys.argv[3]))
