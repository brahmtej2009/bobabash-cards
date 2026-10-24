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

  // ---------- slideshow ----------
  // Full screen, one photo at a time with a crossfade. ← → to move, Space to pause, F full screen,
  // T for the timer, Esc to close. New photos join the loop as they're approved.
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  const ss = $('#ss');
  let ssAt = 0, ssId = null, ssPlaying = true, ssMs = Number(store.get('ss-ms')) || 7000, ssTimer = null, ssFront = 'A', ssShownAt = 0, uiT = null;

  function ssShow(i) {
    if (!photos.length) return;
    ssAt = (i + photos.length) % photos.length;
    const p = photos[ssAt];
    ssId = p.id;
    const next = ssFront === 'A' ? $('#ssB') : $('#ssA');
    const prev = ssFront === 'A' ? $('#ssA') : $('#ssB');
    let swapped = false;
    const swap = () => {
      if (swapped) return; // a cached image can report both complete and load
      swapped = true;
      next.classList.remove('kb'); void next.offsetWidth; next.classList.add('on', 'kb');
      prev.classList.remove('on');
      ssFront = ssFront === 'A' ? 'B' : 'A';
    };
    next.onload = swap;
    next.onerror = swap;
    next.alt = p.caption || `Photo by ${p.by}`;
    next.src = p.url;
    if (next.complete && next.naturalWidth) swap();
    $('#ssCapT').textContent = p.caption || '';
    $('#ssCapBy').textContent = `by ${p.by}`;
    $('#ssCount').textContent = `${ssAt + 1} / ${photos.length}`;
    // warm up the next one so the fade never waits on the network
    const pre = photos[(ssAt + 1) % photos.length];
    if (pre) new Image().src = pre.url;
    ssShownAt = Date.now();
    ssSchedule();
  }
  function ssSchedule() {
    clearTimeout(ssTimer);
    const bar = $('#ssProg');
    bar.style.transition = 'none';
    bar.style.width = '0';
    if (!ssPlaying || photos.length < 2) return;
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transition = `width ${ssMs}ms linear`; bar.style.width = '100%'; }));
    ssTimer = setTimeout(() => ssShow(ssAt + 1), ssMs);
  }
  function ssSetPlaying(on) {
    ssPlaying = on;
    $('#ssPlay').textContent = on ? '❚❚' : '▶';
    ssSchedule();
  }
  function ssSetSpeed(ms) {
    ssMs = ms;
    store.set('ss-ms', String(ms));
    for (const b of document.querySelectorAll('#ssSpeed button')) b.classList.toggle('on', Number(b.dataset.ms) === ms);
    ssSchedule();
  }
  function ssOpen() {
    if (!photos.length) return;
    unlockAudio();
    ss.hidden = false;
    document.body.style.overflow = 'hidden';
    ssSetSpeed(ssMs);
    ssSetPlaying(true);
    ssShow(0);
    showUi();
    ss.requestFullscreen?.().catch(() => {});
  }
  function ssClose() {
    clearTimeout(ssTimer);
    ss.hidden = true;
    document.body.style.overflow = '';
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  function showUi() {
    ss.classList.add('ui-on');
    clearTimeout(uiT);
    // hide the controls after 3 s, unless the mouse is on them or someone is typing minutes
    uiT = setTimeout(() => { if (!ss.querySelector('.ss-ui:hover') && document.activeElement?.id !== 'tMin') ss.classList.remove('ui-on'); }, 3000);
  }
  // keep the loop on the same photo when the list refreshes
  function ssRefresh() {
    if (ss.hidden || !ssId) return;
    const i = photos.findIndex((p) => p.id === ssId);
    if (i >= 0) ssAt = i;
    $('#ssCount').textContent = `${ssAt + 1} / ${photos.length}`;
  }

  $('#ssStart').addEventListener('click', ssOpen);
  $('#ssExit').addEventListener('click', ssClose);
  $('#ssPrev').addEventListener('click', () => ssShow(ssAt - 1));
  $('#ssNext').addEventListener('click', () => ssShow(ssAt + 1));
  $('#ssPlay').addEventListener('click', () => ssSetPlaying(!ssPlaying));
  $('#ssFs').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : ss.requestFullscreen?.()).catch?.(() => {}));
  for (const b of document.querySelectorAll('#ssSpeed button')) b.addEventListener('click', () => ssSetSpeed(Number(b.dataset.ms)));
  ss.addEventListener('mousemove', showUi);
  ss.addEventListener('touchstart', showUi, { passive: true });
  ss.addEventListener('click', (e) => { if (e.target.classList.contains('ss-img')) ssSetPlaying(!ssPlaying); });

  // ---------- timer (top right) ----------
  let actx = null;
  function unlockAudio() {
    try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {}
  }
  function dingDing() {
    try {
      unlockAudio();
      const t0 = actx.currentTime + 0.05;
      for (let r = 0; r < 3; r++) for (const [k, f] of [[0, 1318], [0.22, 1760]]) {
        const at = t0 + r * 0.9 + k;
        const o = actx.createOscillator(), g = actx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.35, at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.7);
        o.connect(g).connect(actx.destination);
        o.start(at); o.stop(at + 0.75);
      }
    } catch {}
  }
  let tLeft = 5 * 60e3, tEnd = 0, tTick = null, tPaused = false;
  const fmt = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
  };
  function tRender() {
    const left = tEnd ? tEnd - Date.now() : tLeft;
    $('#tClock').textContent = fmt(left);
    $('#ssTimer').classList.toggle('low', left > 0 && left <= 60e3);
  }
  function tStart() {
    unlockAudio();
    if (!tPaused || tLeft <= 0) tLeft = Math.max(1, Number($('#tMin').value) || 5) * 60e3; // fresh start uses the minutes box
    tPaused = false;
    $('#ssTimer').hidden = false;
    $('#ssTimer').classList.remove('done');
    $('#tDone').hidden = true;
    tEnd = Date.now() + tLeft;
    $('#tGo').textContent = '⏸ Pause timer';
    $('#tGo').classList.add('on');
    clearInterval(tTick);
    tTick = setInterval(() => {
      tRender();
      if (tEnd && Date.now() >= tEnd) {
        clearInterval(tTick);
        tEnd = 0; tLeft = 0;
        $('#tClock').textContent = '00:00';
        $('#ssTimer').classList.add('done');
        $('#tDone').hidden = false;
        $('#tGo').textContent = '⏱ Start timer';
        $('#tGo').classList.remove('on');
        dingDing();
      }
    }, 250);
    tRender();
  }
  function tPause() {
    tLeft = Math.max(0, tEnd - Date.now());
    tEnd = 0;
    tPaused = true;
    clearInterval(tTick);
    $('#tGo').textContent = '⏱ Resume timer';
    $('#tGo').classList.remove('on');
    tRender();
  }
  function tReset() {
    clearInterval(tTick);
    tPaused = false;
    tEnd = 0;
    tLeft = Math.max(1, Number($('#tMin').value) || 5) * 60e3;
    $('#ssTimer').classList.remove('done', 'low');
    $('#tDone').hidden = true;
    $('#tGo').textContent = '⏱ Start timer';
    $('#tGo').classList.remove('on');
    $('#ssTimer').hidden = false;
    tRender();
  }
  $('#tGo').addEventListener('click', () => (tEnd ? tPause() : tStart()));
  $('#tReset').addEventListener('click', tReset);
  $('#tHide').addEventListener('click', () => { if (tEnd) tPause(); $('#ssTimer').hidden = true; });
  $('#tMin').addEventListener('change', () => { if (!tEnd) tReset(); });

  document.addEventListener('keydown', (e) => {
    if (ss.hidden || e.target.id === 'tMin') return;
    const k = e.key;
    if (k === 'ArrowRight') ssShow(ssAt + 1);
    else if (k === 'ArrowLeft') ssShow(ssAt - 1);
    else if (k === ' ') ssSetPlaying(!ssPlaying);
    else if (k === 'Escape') { if (!document.fullscreenElement) ssClose(); }
    else if (k === 'f' || k === 'F') $('#ssFs').click();
    else if (k === 't' || k === 'T') $('#tGo').click();
    else if (k === '1') ssSetSpeed(12000);
    else if (k === '2') ssSetSpeed(7000);
    else if (k === '3') ssSetSpeed(3500);
    else return;
    e.preventDefault();
    showUi();
  });

  const loadAll = () => load().then(() => { $('#ssStart').hidden = !photos.length; ssRefresh(); });
  loadAll();
  setInterval(() => { if (document.visibilityState === 'visible') loadAll(); }, 30000);
})();
