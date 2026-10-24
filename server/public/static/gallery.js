// Public gallery: approved photos, newest first, a lightbox, and new photos dropping in every 30 seconds.
(() => {
  const $ = (s) => document.querySelector(s);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) n.append(k);
    return n;
  }
  let photos = [];
  const shown = new Set();

  function tile(p, i, fresh) {
    return el('button', { class: `ph${fresh ? ' fresh' : ''}`, type: 'button', 'data-id': p.id, 'aria-label': p.caption || `Photo by ${p.by}`, onclick: () => openLb(photos.findIndex((x) => x.id === p.id)) },
      el('img', { src: p.url, alt: p.caption || `Photo by ${p.by}`, loading: i > 8 ? 'lazy' : 'eager' }),
      el('span', { class: 'cap' }, p.caption ? el('b', { text: p.caption }) : null, el('span', { text: `by ${p.by}` })));
  }

  async function load() {
    let data;
    try { data = await (await fetch('/api/gallery', { cache: 'no-store' })).json(); } catch { return; }
    const first = !shown.size;
    photos = data.photos || [];
    $('#sub').textContent = photos.length ? `${photos.length} photo${photos.length === 1 ? '' : 's'} from ${data.event_name}` : `Photos from ${data.event_name}`;
    $('#empty').hidden = photos.length > 0;
    const grid = $('#grid');
    if (first) {
      grid.replaceChildren(...photos.map((p, i) => tile(p, i, false)));
      photos.forEach((p) => shown.add(p.id));
      return;
    }
    // keep what's on screen; new ones go on top, removed ones disappear
    const ids = new Set(photos.map((p) => p.id));
    for (const node of [...grid.children]) if (!ids.has(node.dataset.id)) node.remove();
    const fresh = photos.filter((p) => !shown.has(p.id));
    for (const p of fresh.reverse()) { grid.prepend(tile(p, 0, true)); shown.add(p.id); }
  }

  // lightbox
  let at = 0;
  function openLb(i) {
    if (i < 0) return;
    at = i;
    const p = photos[at];
    $('#lbImg').src = p.url;
    $('#lbImg').alt = p.caption || `Photo by ${p.by}`;
    $('#lbCap').textContent = p.caption || '';
    $('#lbBy').textContent = `by ${p.by}`;
    $('#lb').hidden = false;
  }
  const close = () => { $('#lb').hidden = true; };
  const step = (d) => openLb((at + d + photos.length) % photos.length);
  $('#lbClose').addEventListener('click', close);
  $('#lbPrev').addEventListener('click', () => step(-1));
  $('#lbNext').addEventListener('click', () => step(1));
  $('#lb').addEventListener('click', (e) => { if (e.target.id === 'lb') close(); });
  document.addEventListener('keydown', (e) => {
    if ($('#lb').hidden) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  let x0 = null;
  $('#lb').addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  $('#lb').addEventListener('touchend', (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); x0 = null; });

  load();
  setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
})();
