// Find photos on Wikimedia Commons, keeping only licenses a published video may use (public domain, CC0, CC BY,
// CC BY-SA). Prefers Commons "Quality images". Each result comes back as a File plus its credit line.
const API = 'https://commons.wikimedia.org/w/api.php';
const strip = s => (s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

export function licenseOk(lic) {
  const l = (lic || '').toLowerCase();
  if (!l || /\bnc\b|non-?commercial|\bnd\b|no ?deriv|fair use|copyrighted/.test(l)) return false;
  return /public domain|^pd\b|pd-|cc0|no restrictions|^cc[- ]by(-sa)?\b/.test(l);
}

async function search(words, quality) {
  const p = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: '50',
    gsrsearch: words + ' filetype:bitmap' + (quality ? ' incategory:Quality_images' : ''),
    prop: 'imageinfo', iiprop: 'url|size|extmetadata|mime', iiurlwidth: '1920',
  });
  const r = await fetch(API + '?' + p);
  if (!r.ok) throw new Error('Wikimedia Commons did not answer');
  const pages = Object.values((await r.json()).query?.pages || {});
  return pages.sort((a, b) => (a.index || 0) - (b.index || 0));
}

// vertical: a vertical video, so tall and square photos are welcome too
export async function findPhotos(words, count = 14, vertical = true, onEach = () => {}) {
  let pages = await search(words, true);
  if (pages.length < count) pages = pages.concat(await search(words, false));
  const out = [], seen = new Set();
  for (const p of pages) {
    if (out.length >= count) break;
    const ii = (p.imageinfo || [])[0] || {}, m = ii.extmetadata || {}, v = k => strip(m[k]?.value);
    const lic = v('LicenseShortName'), w = ii.width || 0, h = ii.height || 0;
    if (seen.has(p.title) || !licenseOk(lic) || Math.min(w, h) < 1000 || (!vertical && w < h * 1.2)) continue;
    if (!/image\/(jpeg|png|webp)/.test(ii.mime || '')) continue;
    try {
      const r = await fetch(ii.thumburl || ii.url);
      if (!r.ok) continue;
      const blob = await r.blob(), name = p.title.replace(/^File:/, '');
      const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
      const credit = { title: name, license: lic, artist: (v('Artist') || v('Credit')).slice(0, 120), page: ii.descriptionurl };
      seen.add(p.title); out.push({ file, credit }); onEach(out.length, count, file);
    } catch (e) { /* skip this one */ }
  }
  if (!out.length) throw new Error('No freely licensed photos found for that. Try other words.');
  return out;
}
