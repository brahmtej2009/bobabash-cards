// The big screen. Polls /api/wall every 4 seconds; new taps slide in.
(() => {
  const $ = (s) => document.querySelector(s);
  function el(tag, cls, ...kids) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  }
  const time = (t) => new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const ago = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : time(t); };
  const tick = () => ($('#clock').textContent = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }));
  tick();
  setInterval(tick, 10000);

  let seen = new Set();
  let first = true;
  async function load() {
    let w;
    try { w = await (await fetch('/api/wall', { cache: 'no-store' })).json(); } catch { return; }
    if (!w.event_name) return;
    $('#ev').textContent = w.event_name;
    document.title = `${w.event_name} · live`;
    $('#note').textContent = w.note || `Tap a card on any phone · ${w.card_base.replace(/^https?:\/\//, '')}`;
    $('#nTaps').textContent = w.taps_today;
    $('#nTotal').textContent = w.taps_total;

    const fresh = new Set();
    $('#feed').replaceChildren(...(w.feed.length ? w.feed.map((f) => {
      const key = `${f.card}-${f.ts}`;
      fresh.add(key);
      return el('li', !first && !seen.has(key) ? 'fresh' : '', el('span', 'card', `#${f.card}`), el('b', '', f.name || `Card ${f.card}`), 'got tapped', el('span', 't', ago(f.ts)));
    }) : [el('li', 'empty', 'No taps yet. Go find someone with a card.')]));
    seen = fresh;
    first = false;

    $('#now').replaceChildren(...(w.now.length ? w.now.map((x) => el('div', 'it live', el('b', '', x.title), el('span', '', [x.place, x.ends_at ? `until ${time(x.ends_at)}` : null].filter(Boolean).join(' · ')))) : [el('div', 'empty', 'Nothing on right now.')]));
    $('#next').replaceChildren(...(w.next.length ? w.next.map((x) => el('div', 'it', el('b', '', x.title), el('span', '', [time(x.starts_at), x.place].filter(Boolean).join(' · ')))) : [el('div', 'empty', 'Nothing else scheduled.')]));

    // once the last thing on the schedule has ended, the middle column says so instead of an empty Now/Next
    $('#over').hidden = !w.over;
    $('#sched').hidden = !!w.over;

    $('#teamsTitle').hidden = !w.teams.length;
    $('#board').replaceChildren(...w.teams.map((t) => {
      const sw = el('span', 'sw');
      sw.style.background = t.color || '#f2c14e';
      return el('li', '', sw, el('span', '', t.name), el('span', 'pts', `${t.members} ${t.members === 1 ? 'person' : 'people'}`));
    }));
    $('#taps').replaceChildren(...(w.top_taps.length ? w.top_taps.map((t, i) => el('li', '', el('span', 'rk', i + 1), el('span', 'nm', t.name || `Card ${t.card}`), el('span', 'pts', t.n))) : [el('li', 'empty', 'Nobody yet.')]));

    const n = w.notice;
    $('footer').classList.toggle('urgent', !!n?.urgent);
    const text = n ? `${n.title}${n.body ? ` · ${n.body.replace(/\s+/g, ' ')}` : ''}` : `${w.event_name} · tap a card on any phone to see what its owner built`;
    if ($('#ticker').textContent !== text) $('#ticker').textContent = text;
  }
  load();
  setInterval(load, 4000);
})();
