# Beatcut: CapCut-style template edits, cut to the music

Give it photos and/or video clips and a song. It finds the beat, lays the media out in a template style, puts a subtle
sound effect on every visual hit, and renders an MP4. No manual editing.

Python 3.10+ with `numpy`, `opencv-python`, `Pillow` and `imageio-ffmpeg` (for its ffmpeg binary):

```bash
pip install -r requirements.txt
```

Composing songs needs an ElevenLabs key in `ELEVENLABS_API_KEY` or `elevenlabs_key.txt` (gitignored). Finding
photos needs nothing.

## The app

```bash
python app.py        # http://localhost:8300
```

One page: drop in photos/clips (or type what photos to find), upload a song (or describe one to compose), pick one of
the ten styles (each card plays a sample on hover once you have rendered the sample jobs in `jobs/`, which are not in the repo), add a caption, choose 9:16 or 16:9. You get two MP4s: the edit with
the song, and the same edit with only the sound effects, for posting on Instagram / TikTok with the song added from
their own music library at the start time it shows (`<out>.share.json` also holds it, with the song's name and link).

## Quick start

```bash
# 1. media: your own folder of photos/clips, or find licensed ones on Wikimedia Commons
python find.py jobs/iceland/media "Iceland landscape" 18
# 2. music: your own MP3, or compose one with ElevenLabs (elevenlabs_key.txt)
python music.py jobs/iceland/music.mp3 20 "Cinematic chill electronic, about 100 BPM, ..."
# 3. render
python beatcut.py jobs/iceland/job.json
python beatcut.py --media <folder> --music <song.mp3> --style blinds --title "Two Words" --seconds 12 --out x.mp4
```

`job.json`: `media` (folder or list), `music`, `style`, `size` ([1920,1080]; [1080,1920] for vertical), `fps`, `title`
(first half of the words left of the centre, second half right), `seconds` (cap; snapped to whole bars), `seed`,
`start` (song second the edit starts on; default: two bars before the drop for `velocity`, the song's hook when the
song is much longer than `seconds`, else the first downbeat), `song` ({title, artist, link}, passed to share.json), `music_gain`, `sfx_gain`, `seam` (px), `out`.
Next to the MP4 it writes `<out>-no-music.mp4` (sound effects only), `<out>.share.json` (song, where in the song the
edit starts, length, tempo) and `<out>.plan.json` (tempo, bar starts, every move and every sound effect with its time).

## How it works

- `beats.py`: tempo from the autocorrelation of spectral flux, beat phase from a comb, the downbeat from kick energy.
  Every move starts on a downbeat; fast steps run on sixteenth notes or one frame apart.
- `styles.py`: a style writes a Timeline: for each cell of a rows x cols grid, what it shows from when. A cell shows a
  source drawn into a rect: the whole frame (so the cells are slices of one picture), a column, a row, or the cell alone.
  Sources keep their own clock, so slices of one picture line up and keep a slow push or keep playing.
- `sfx.py`: synthesised tick / whoosh / flash / thump / pop, panned by the cell's column, placed on the exact frame.
- `beatcut.py`: loads the media (photos get a slow push and drift; clips play), mixes the song and effects, renders the
  frames and pipes them to ffmpeg (H.264 + AAC).

## Styles

| style | grid | what happens |
| --- | --- | --- |
| `grid9` | 3x3 | The viral grid edit (reference: a CapCut "viral grid effect" tutorial). One picture assembles a tile per frame in a spiral (a tick each), title words appear either side of the centre; columns (or rows) wipe in on sixteenths, each a different clip; nine clips pop into the tiles with a white blink an eighth before the next bar; a picture rebuilds tile by tile; three beat cuts; a white flash into a two-picture checkerboard that resolves to one; tiles drop out on the last beat (cross, corners, centre last). Thin black seams stay throughout. |
| `blinds` | 1x4 | Strips wipe a picture in on sixteenths, then split into four clips with a strip flash, alternating each bar. |
| `pulse` | 1x1 | A new picture on every beat with a zoom punch, a thump on each bar, a white flash every two bars. |
| `zoomthru` | free | 3D zoom: a new photo every beat, punching in through a zoom blur with a slight tilt; a flash on each bar. |
| `glitch` | free | Glitch / "flash warning": torn slices, RGB split and inverted blocks on every cut, scanlines, a full invert on the bar. |
| `swipe` | free | Swipe stack: each photo slides in over the last on the beat (overshoot, edge shadow), directions turning round the screen. |
| `filmstrip` | free | A roll of film advancing one frame per beat (down the screen for vertical video); every fourth bar a frame opens to full screen for beat cuts. |
| `dreamy` | free | Soft aesthetic slideshow: a photo per bar, blur dissolves, glow, a warm drifting light leak, film grain. |
| `velocity` | free | The phonk "shake" edit (car / sports / gym edits). Starts two bars before the song's drop: dark, letterboxed, desaturated, a cut every two beats, sixteenth-note stutter cuts and a riser into the drop. On the drop: white flash, hard shake, RGB split, full colour, the letterbox snaps open. Then a cut on every beat: motion-blurred whip pans (whoosh each), zoom-throughs and flashes on the bars (impact), double-time cuts every other bar; the last bar holds one shot and fades. |
| `dump` | free | The photo dump. Polaroids drop onto a blurred backdrop of the newest photo, one per beat, and pile up (a paper slap each); the title is handwritten on the first. Every fourth bar it zooms into the top photo for full-screen beat cuts, then a camera flash brings the pile back; piles are swept off on the bar. |

`beats.py` also finds a drop (the moment the song gets much louder) and lines the bars up so the drop starts one; that
also fixes a grid locked half a beat off by off-beat hi-hats. Free-form styles (`scenes.py`) draw whole frames
themselves instead of filling grid cells (`velocity` and `dump` in `scenes.py`, the rest in `looks.py`).

Adding a style: write a function `(grid, sources, seconds, fps, W, H, rnd, has_title) -> Timeline` in `styles.py` and
add it to `STYLES`.

Credits for Commons media are in `<media>/credits.json`; CC BY / BY-SA photos need that credit where the video is posted.

Fonts: Fraunces (`fonts/`) is under the SIL Open Font License 1.1.
