(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // Safe DOM builder: strings become text, never HTML. null/false children are skipped.
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  }
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));

  async function api(path, data) {
    const opt = { credentials: 'same-origin' };
    if (data !== undefined) { opt.method = 'POST'; opt.headers = { 'content-type': 'application/json' }; opt.body = JSON.stringify(data); }
    const res = await fetch(path, opt);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || 'Something went wrong.'), { status: res.status });
    return out;
  }
  function toast(msg, bad, extra) {
    const t = el('div', { class: `toast${bad ? ' bad' : ''}${extra ? ' note-toast' : ''}` }, extra ? [el('b', { text: msg }), extra] : msg);
    $('#toasts').append(t);
    setTimeout(() => t.remove(), bad ? 4500 : extra ? 7000 : 2400);
  }
  const fmt = (t) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const time = (t) => new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const dayName = (t) => new Date(t).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' });
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return fmt(t);
  };
  const short = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const initials = (name) => String(name || '?').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const errOf = (f) => $('.err', f);
  async function guard(form, fn) {
    errOf(form).textContent = '';
    const btns = $$('button', form);
    btns.forEach((b) => (b.disabled = true));
    try { await fn(); } catch (x) { errOf(form).textContent = x.message; }
    btns.forEach((b) => (b.disabled = false));
  }
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  let PUB = null;
  fetch('/api/public').then((r) => r.json()).then((p) => {
    PUB = p;
    if (!p.owner_signup) $('#setupMode [data-sm=email]').textContent = 'Registered without a card';
  }).catch(() => {});

  // ================= logged out =================
  const AUTH_VIEWS = ['login', 'setup', 'setupCode', 'forgot'];
  function showAuth(view) {
    stopLive();
    $('#app').hidden = true;
    $('#auth').hidden = false;
    for (const v of AUTH_VIEWS) $(`[data-view=${v}]`).hidden = v !== view;
    const first = $(`[data-view=${view}] input:not([hidden])`);
    if (first) setTimeout(() => first.focus(), 0);
  }
  function route() {
    if (!$('#app').hidden) return;
    const h = location.hash.slice(1);
    showAuth(AUTH_VIEWS.includes(h) && h !== 'setupCode' ? h : 'login');
  }
  window.addEventListener('hashchange', route);

  let setupMode = 'card';
  $$('#setupMode button').forEach((b) => b.addEventListener('click', () => {
    setupMode = b.dataset.sm;
    $$('#setupMode button').forEach((x) => x.classList.toggle('on', x === b));
    $$('[data-only=card]').forEach((x) => (x.hidden = setupMode !== 'card'));
    $$('[data-only=signup]').forEach((x) => (x.hidden = setupMode !== 'email' || !PUB?.owner_signup));
    $('#setupHint').textContent = setupMode === 'card' ? 'Card number and PIN are printed on your card.' : 'Use the email the desk registered you with. We email you a code.';
    $('#setupBtn').textContent = setupMode === 'card' ? 'Set up and log in' : 'Send me a code';
  }));
  const samePw = (f) => { if (f.password2 && f.password.value !== f.password2.value) throw new Error('The two passwords do not match.'); };

  let pendingEmail = '';
  $('#login').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      await api('/api/me/login', { login: f.login.value.trim(), password: f.password.value });
      f.password.value = '';
      await load();
    });
  });
  $('#setup').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      samePw(f);
      const data = { email: f.email.value.trim(), password: f.password.value, password2: f.password2.value };
      if (setupMode === 'card') { data.card = f.card.value.trim(); data.pin = f.pin.value.trim(); if (!data.card || !data.pin) throw new Error('Add the card number and PIN.'); }
      else data.name = f.name.value.trim();
      const r = await api('/api/me/setup/start', data);
      if (r.done) {
        f.reset();
        history.replaceState(null, '', '/me');
        await load();
        toast('You are in. Your card is linked to you.');
        return;
      }
      pendingEmail = data.email;
      $('#setupCode .to').textContent = r.to;
      $('#setupCode').code.value = r.dev || '';
      showAuth('setupCode');
    });
  });
  $('#setupCode').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      await api('/api/me/setup/verify', { email: pendingEmail, code: f.code.value.trim() });
      history.replaceState(null, '', '/me');
      await load();
      toast('You are in.');
    });
  });
  for (const b of $$('#forgot [data-fm]')) b.addEventListener('click', () => {
    $$('#forgot [data-fm]').forEach((x) => x.classList.toggle('on', x === b));
    $('#forgotEmail').hidden = b.dataset.fm !== 'email';
    $('#forgotEmailCode').hidden = true;
    $('#forgotPin').hidden = b.dataset.fm !== 'pin';
  });
  let forgotEmail = '';
  $('#forgotEmail').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      forgotEmail = f.email.value.trim();
      const r = await api('/api/me/forgot/start', { email: forgotEmail });
      f.hidden = true;
      $('#forgotEmailCode').hidden = false;
      $('#forgotEmailCode').code.value = r.dev || '';
    });
  });
  $('#forgotEmailCode').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      samePw(f);
      await api('/api/me/forgot/verify', { email: forgotEmail, code: f.code.value.trim(), password: f.password.value, password2: f.password2.value });
      history.replaceState(null, '', '/me');
      await load();
      toast('Password changed.');
    });
  });
  $('#forgotPin').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      samePw(f);
      await api('/api/me/pin-reset', { card: f.card.value.trim(), pin: f.pin.value.trim(), password: f.password.value, password2: f.password2.value });
      history.replaceState(null, '', '/me');
      await load();
      toast('Password changed.');
    });
  });

  // ================= alerts: ding + pop-ups =================
  let actx = null;
  const soundOn = () => store.get('bb-sound') !== 'off';
  function unlockAudio() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch {}
  }
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  function ding(urgent) {
    if (!soundOn()) return;
    try {
      unlockAudio();
      const t = actx.currentTime;
      const notes = urgent ? [988, 1319, 988, 1319] : [880, 1320];
      notes.forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain();
        const at = t + i * 0.13;
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.22, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
        o.connect(g).connect(actx.destination);
        o.start(at);
        o.stop(at + 0.6);
      });
    } catch {}
  }
  const canPop = () => 'Notification' in window;
  function popup(n) {
    if (!canPop() || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
    try {
      const p = new Notification(n.title, { body: n.body || '', icon: '/static/icon.png', tag: `bb-${n.id}`, requireInteraction: !!n.urgent });
      p.onclick = () => { window.focus(); tab('home'); p.close(); };
    } catch {}
  }
  async function turnOnAlerts() {
    store.set('bb-sound', 'on');
    unlockAudio();
    ding();
    if (canPop() && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
    renderAlerts();
    toast(canPop() && Notification.permission === 'granted' ? 'Alerts on. You\'ll hear a ding and get a pop-up.' : 'Dings on. Pop-ups are blocked in this browser.');
  }
  function renderAlerts() {
    const pop = canPop() ? Notification.permission : 'unsupported';
    const on = soundOn() && pop === 'granted';
    const btn = $('#alertBtn');
    btn.classList.toggle('on', on);
    btn.textContent = on ? 'Alerts on: ding + pop-ups' : soundOn() ? 'Dings on. Turn on pop-ups?' : 'Turn on alerts';
    $('#alertAsk').hidden = on || store.get('bb-asked') === 'done';
    $('#soundToggle').checked = soundOn();
    $('#notifState').textContent = pop === 'granted' ? 'Pop-ups are allowed. You get them when this tab is in the background.'
      : pop === 'denied' ? 'Pop-ups are blocked. Allow them from the lock icon next to the address bar.'
        : pop === 'unsupported' ? 'This browser can\'t show pop-ups. Dings still work while the page is open.'
          : 'Pop-ups are off.';
    $('#notifBtn').hidden = pop !== 'default';
  }
  $('#alertBtn').addEventListener('click', turnOnAlerts);
  $('#alertAskBtn').addEventListener('click', async () => { await turnOnAlerts(); store.set('bb-asked', 'done'); renderAlerts(); });
  $('#notifBtn').addEventListener('click', turnOnAlerts);
  $('#soundToggle').addEventListener('change', (e) => { store.set('bb-sound', e.target.checked ? 'on' : 'off'); if (e.target.checked) ding(); renderAlerts(); });

  // ================= live connection =================
  let es = null, pollT = null;
  function startLive() {
    stopLive();
    if (window.EventSource) {
      es = new EventSource('/api/me/stream');
      es.addEventListener('open', () => $('#liveDot').classList.add('on'));
      es.addEventListener('error', () => $('#liveDot').classList.remove('on'));
      es.addEventListener('notice', (e) => { try { gotNotice(JSON.parse(e.data)); } catch {} });
      es.addEventListener('refresh', () => load(true));
    }
    // safety net: catches anything the stream missed (and messages sent from the terminal)
    pollT = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 45000);
  }
  function stopLive() {
    if (es) { es.close(); es = null; }
    clearInterval(pollT);
    $('#liveDot')?.classList.remove('on');
  }
  const seen = new Set();
  function gotNotice(n) {
    if (!C || seen.has(n.id) || C.notices.some((x) => x.id === n.id)) return;
    seen.add(n.id);
    C.notices.unshift(n);
    C.unread++;
    renderNotices(n.id);
    renderUrgent();
    renderUnread();
    ding(n.urgent);
    popup(n);
    if (current !== 'home' || document.visibilityState !== 'visible') toast(n.title, false, n.body ? el('span', { text: n.body.slice(0, 140) }) : null);
    scheduleRead();
  }

  // ================= dashboard =================
  let C = null;
  let current = 'home';
  const WHY = { project: 'your project page', custom: 'your own link', override: 'organisers sent every card here for now', admin: 'organisers sent your card here for now' };

  function tab(name) {
    current = name;
    $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
    $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== name));
    store.set('me-tab', name);
    if (name === 'card' && C?.cards.length) loadStats();
    if (name === 'home') scheduleRead();
    window.scrollTo(0, 0);
  }
  $$('#nav button').forEach((b) => b.addEventListener('click', () => tab(b.dataset.page)));

  function qrSvg(url, cell = 5) {
    const q = window.qrcode(0, 'M');
    q.addData(url);
    q.make();
    const text = q.createSvgTag({ cellSize: cell, margin: 1, scalable: true });
    return { text, node: document.importNode(new DOMParser().parseFromString(text, 'image/svg+xml').documentElement, true) };
  }
  function cardVisual(big) {
    const k = C.cards[0];
    if (!k) return el('div', { class: 'bcard none' }, el('div', {}, el('span', { class: 'k', text: 'Boba Bash card' }), el('span', { class: 'num', text: 'No card yet' }), el('span', { class: 'nm', text: 'Grab one at the desk' })));
    return el('div', { class: `bcard${big ? ' big' : ''}${k.status === 'disabled' ? ' off' : ''}` },
      el('div', {},
        el('span', { class: 'k', text: `${C.public.event_name} · card` }),
        el('span', { class: 'num', text: `#${k.id}` }),
        el('span', { class: 'nm', text: C.name }),
        el('div', { class: 'to' }, k.status === 'disabled' ? 'This card is switched off.' : ['A tap opens ', el('a', { href: k.now_url, target: '_blank', rel: 'noopener', text: short(k.now_url) })])),
      el('div', { class: 'qr' }, qrSvg(k.url).node));
  }

  function schedItem(x, t = Date.now()) {
    const live = x.starts_at <= t && (x.ends_at ? x.ends_at > t : x.starts_at + 3600e3 > t);
    const past = (x.ends_at || x.starts_at + 3600e3) <= t;
    return el('div', { class: `item${live ? ' now' : ''}${past ? ' past' : ''}` },
      el('div', { class: 'when' }, time(x.starts_at), x.ends_at ? el('br') : null, x.ends_at ? `to ${time(x.ends_at)}` : null),
      el('div', {}, el('b', { text: x.title }), el('span', { text: [x.place, x.note].filter(Boolean).join(' · ') })));
  }

  function renderUnread() {
    const n = C.unread;
    for (const b of [$('#navUnread'), $('#unreadBadge')]) { b.hidden = !n; b.textContent = n; }
    document.title = `${n ? `(${n}) ` : ''}My ${C.public.event_name}`;
  }
  function renderUrgent() {
    fill($('#urgent'), C.notices.filter((n) => n.urgent && !n.read).slice(0, 2).map((n) => el('div', { class: 'urgent' },
      el('b', { text: n.title }), n.body ? el('p', { text: n.body }) : null,
      el('button', { class: 'btn sm ghost', type: 'button', text: 'Got it', onclick: async () => { await api('/api/me/notices/read', { ids: [n.id] }).catch(() => {}); n.read = true; C.unread = C.notices.filter((x) => !x.read).length; renderUrgent(); renderNotices(); renderUnread(); } }))));
  }
  function renderNotices(freshId) {
    const list = $('#noteList');
    if (!C.notices.length) { fill(list, el('div', { class: 'np-empty' }, el('p', { text: 'No messages yet.' }), el('p', { class: 'sub', text: 'Organisers\' announcements land here the moment they\'re sent.' }))); return; }
    fill(list, C.notices.map((n) => el('div', { class: `note${n.read ? '' : ' unread'}${n.urgent ? ' urgent' : ''}${n.id === freshId ? ' fresh' : ''}` },
      el('b', {}, n.title, n.urgent ? el('span', { class: 'tagn', text: 'urgent' }) : null),
      n.body ? el('p', { text: n.body }) : null,
      el('span', { class: 'when', text: ago(n.ts) }))));
  }
  // messages count as read once they've been on screen for a couple of seconds
  let readT = null;
  function scheduleRead() {
    clearTimeout(readT);
    readT = setTimeout(async () => {
      if (!C || current !== 'home' || document.visibilityState !== 'visible') return;
      const ids = C.notices.filter((n) => !n.read && !n.urgent).map((n) => n.id);
      if (!ids.length) return;
      await api('/api/me/notices/read', { ids }).catch(() => {});
      C.notices.forEach((n) => { if (ids.includes(n.id)) n.read = true; });
      C.unread = C.notices.filter((n) => !n.read).length;
      renderUnread();
      setTimeout(() => { if (current === 'home') renderNotices(); }, 4000);
    }, 2500);
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleRead(); });

  function render(c) {
    C = c;
    for (const n of c.notices) seen.add(n.id);
    const first = c.name.split(/\s+/)[0];
    fill($('#meBubble'), initials(c.name));
    $('#meName').textContent = c.name;
    $('#meSub').textContent = c.cards.length ? `Card #${c.cards.map((x) => x.id).join(', #')}` : 'No card yet';
    $('#hello').textContent = `Hey ${first}`;
    fill($('#statusChips'),
      el('span', { class: `chip ${c.checked_in_at ? 'yes' : 'no'}`, text: c.checked_in_at ? `Checked in at ${time(c.checked_in_at)}` : 'Not checked in yet' }),
      c.team ? el('span', { class: 'chip', text: c.team.name }) : null,
      el('span', { class: 'chip', text: `${c.points} points` }));
    const ann = $('#announce');
    ann.hidden = !c.public.announcement;
    ann.textContent = c.public.announcement || '';
    renderUrgent();
    renderUnread();
    renderNotices();

    // ---- home, left ----
    fill($('#cardVisual'), cardVisual(false));
    const hd = $('#hDest');
    if (c.cards.length) {
      const k = c.cards[0];
      fill(hd, el('h3', { text: 'Your card opens' }),
        el('p', { class: 'dest-now' }, el('a', { href: k.now_url, target: '_blank', rel: 'noopener', text: short(k.now_url) }), el('span', { class: 'sub', text: ` · ${k.now_reason.startsWith('tag:') ? 'organisers sent your group here for now' : WHY[k.now_reason] || ''}` })),
        el('div', { class: 'dest-quick' },
          el('button', { class: 'btn sm ghost', type: 'button', text: 'Change where it goes', onclick: () => tab('card') }),
          el('button', { class: 'btn sm ghost', type: 'button', text: 'Copy my card link', onclick: () => copy(k.url) })));
    } else fill(hd, el('h3', { text: 'Your card' }), el('p', { class: 'empty-note', text: 'No card yet. Grab one at the desk and it shows up here.' }));
    const t = Date.now();
    const nowItems = c.schedule.filter((x) => x.starts_at <= t && (x.ends_at ? x.ends_at > t : x.starts_at + 3600e3 > t));
    const nextItems = c.schedule.filter((x) => x.starts_at > t).slice(0, 2);
    fill($('#hNow'), nowItems.length ? nowItems.map((x) => el('p', {}, el('b', { text: x.title }), x.place ? ` · ${x.place}` : '')) : el('p', { class: 'empty-note', text: 'Nothing on right now.' }));
    fill($('#hNext'), nextItems.length ? nextItems.map((x) => el('p', {}, el('span', { class: 'when', text: `${time(x.starts_at)} ` }), el('b', { text: x.title }))) : el('p', { class: 'empty-note', text: 'Nothing scheduled.' }));
    const ht = $('#hTeam');
    if (c.team) {
      fill(ht, el('h3', { text: 'Your team' }),
        el('div', { class: 'team-h' }, el('span', { class: 'swatch', style: { background: c.team.color || '#f2c14e' } }), el('b', { text: c.team.name }), c.team.place ? el('span', { class: 'sub', text: `· ${c.team.place}` }) : null),
        el('div', { class: 'faces' }, c.team.members.slice(0, 8).map((m) => el('span', { class: 'bubble', title: m.name, text: initials(m.name) }))),
        el('div', { style: { marginTop: '10px' } }, el('button', { class: 'btn sm ghost', type: 'button', text: 'See team', onclick: () => tab('team') })));
    } else fill(ht, el('h3', { text: 'Your team' }), el('p', { class: 'empty-note', text: 'Not on a team yet. Organisers will put you on one.' }));
    $('#hPoints').textContent = c.points;
    fill($('#hItems'), c.items.length ? c.items.map((i) => el('span', { class: `pill${i.got ? ' got' : ''}`, text: `${i.got ? '✓ ' : ''}${i.name}` })) : el('span', { class: 'empty-note', text: 'Nothing to collect.' }));

    // ---- my card ----
    $('#noCard').hidden = c.cards.length > 0;
    $('#hasCard').hidden = !c.cards.length;
    if (c.cards.length) {
      const k = c.cards[0];
      fill($('#cardVisualBig'), cardVisual(true));
      fill($('#cardLinks'), c.cards.map((x) => cardLinkRow(x)));
      const lock = $('#lock');
      lock.hidden = !c.locked;
      lock.textContent = c.unlock_at ? `Locked during the event. You can change this from ${fmt(c.unlock_at)}. The loading line still saves.` : 'Locked during the event. The loading line still saves.';
      $('#choose').classList.toggle('locked', c.locked);
      $('#projUrl').textContent = short(k.project_url);
      $('#projUrl').href = k.project_url;
      for (const o of $$('[data-opt]')) o.classList.toggle('on', o.dataset.opt === (c.mode === 'custom' ? 'custom' : 'project'));
      const cu = $('#customForm').url;
      if (document.activeElement !== cu) cu.value = c.custom_url;
      const sm = $('#splashForm').msg;
      if (document.activeElement !== sm) sm.value = c.splash_msg;
      $('#dest').textContent = short(k.now_url);
      $('#dest').href = k.now_url;
      $('#why').textContent = `(${k.now_reason.startsWith('tag:') ? 'organisers sent your group here' : WHY[k.now_reason] || ''})`;
      const best = c.prs.find((p) => p.merged) || c.prs.find((p) => p.state === 'open') || c.prs[0];
      if (best) {
        const state = best.merged ? 'merged' : best.state;
        fill($('#prLine'), el('span', { class: `tag ${state}`, text: state === 'merged' ? 'live' : state === 'open' ? (best.approved ? 'approved' : 'in review') : 'closed' }), ' ',
          el('a', { href: best.url, target: '_blank', rel: 'noopener', text: `PR #${best.number}` }), ` ${best.title}`);
      } else fill($('#prLine'), 'No pull request yet.');
      fill($('#howTo'), c.sites_repo ? ['Build it in the ', el('code', { text: `${k.id}/` }), ' folder of ', el('a', { href: `https://github.com/${c.sites_repo}#readme`, target: '_blank', rel: 'noopener', text: c.sites_repo }), ' and open a pull request.'] : null);
    }

    // ---- team ----
    if (c.team) {
      fill($('#teamBox'), el('div', { class: 'panel' },
        el('div', { class: 'team-h' }, el('span', { class: 'swatch', style: { background: c.team.color || '#f2c14e' } }), el('h2', { text: c.team.name })),
        el('p', { class: 'sub', text: [c.team.place, `${c.team.members.length} people`, `${c.team.points} points`].filter(Boolean).join(' · ') }),
        c.team.note ? el('p', { class: 'bio', text: c.team.note }) : null,
        el('div', { class: 'members' }, c.team.members.map((m) => el('div', { class: `member${m.me ? ' me' : ''}` },
          el('span', { class: 'bubble', text: initials(m.name) }),
          el('span', {}, el('b', { text: `${m.name}${m.me ? ' (you)' : ''}` }), el('span', { class: 'meta', text: [m.cards.length ? `card #${m.cards.join(', #')}` : null, m.github ? `@${m.github}` : null, `${m.points} pts`].filter(Boolean).join(' · ') })))))));
    } else fill($('#teamBox'), el('div', { class: 'panel' }, el('p', { class: 'empty-note', text: 'You\'re not on a team yet. Organisers will put you on one.' })));

    // ---- schedule ----
    if (!c.schedule.length) fill($('#schedBox'), el('p', { class: 'empty-note', text: 'Nothing scheduled yet.' }));
    else {
      const out = [];
      let lastDay = '';
      for (const x of c.schedule) {
        const d = dayName(x.starts_at);
        if (d !== lastDay) { out.push(el('div', { class: 'day', text: d })); lastDay = d; }
        out.push(schedItem(x));
      }
      fill($('#schedBox'), el('div', { class: 'sched' }, out));
    }

    // ---- help ----
    $('#helpClosed').hidden = c.public.help_open;
    $$('#helpForm button, #helpForm textarea').forEach((x) => (x.disabled = !c.public.help_open));
    fill($('#helpList'), c.help.map((h) => el('div', { class: 'panel hreq' },
      el('div', {}, el('b', { text: KINDS[h.kind] || h.kind }), el('span', { class: 'when', text: ` · ${ago(h.ts)}` }), h.message ? el('p', { text: h.message }) : null, h.reply ? el('p', {}, el('b', { text: 'Organisers: ' }), h.reply) : null,
        h.status !== 'done' ? el('button', { class: 'link', type: 'button', text: 'Cancel', onclick: async () => { render(await api(`/api/me/help/${h.id}/cancel`, {})); } }) : null),
      el('span', { class: `state ${h.status}`, text: { open: 'waiting', claimed: 'on it', done: 'done' }[h.status] }))));

    // ---- guide + account ----
    const g = $('#guideBody');
    g.textContent = '';
    if (c.public.instructions_md.trim()) g.append(window.renderMarkdown(c.public.instructions_md));
    else g.append(el('p', { class: 'sub', text: 'No guide yet. Check back during the event.' }));
    fill($('#accInfo'), el('b', { text: c.name }), el('br'), c.email || '', c.github ? ` · @${c.github}` : '', c.tags.length ? el('br') : null, c.tags.length ? `Tags: ${c.tags.join(', ')}` : '');
    renderAlerts();
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied.'); } catch { toast('Couldn\'t copy. Select it by hand.', true); }
  }
  function cardLinkRow(x) {
    const q = qrSvg(x.url, 6);
    const dl = (name, blob) => { const a = el('a', { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    return el('div', { class: 'cardrow' },
      el('p', { class: 'mono', text: short(x.url) }),
      el('div', { class: 'inline wrap' },
        el('button', { class: 'btn sm ghost', type: 'button', text: 'Copy link', onclick: () => copy(x.url) }),
        el('button', { class: 'btn sm ghost', type: 'button', text: 'QR as PNG', onclick: () => {
          const img = new Image();
          img.onload = () => {
            const cv = el('canvas', { width: 1024, height: 1024 });
            const ctx = cv.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024);
            ctx.drawImage(img, 0, 0, 1024, 1024);
            cv.toBlob((b) => dl(`boba-bash-card-${x.id}.png`, b), 'image/png');
          };
          img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(q.text);
        } }),
        el('button', { class: 'btn sm ghost', type: 'button', text: 'QR as SVG', onclick: () => dl(`boba-bash-card-${x.id}.svg`, new Blob([q.text], { type: 'image/svg+xml' })) })));
  }

  // ---------- where the card goes ----------
  async function setDest(data, btn) {
    const box = $('#choose');
    errOf(box).textContent = '';
    btn.disabled = true;
    try { render(await api('/api/me/destination', data)); toast('Saved. Taps go there now.'); } catch (x) { errOf(box).textContent = x.message; }
    btn.disabled = false;
  }
  $$('[data-dest]').forEach((b) => b.addEventListener('click', () => setDest({ mode: b.dataset.dest }, b)));
  $('#customForm').addEventListener('submit', (e) => { e.preventDefault(); setDest({ mode: 'custom', url: e.currentTarget.url.value }, $('button', e.currentTarget)); });
  $('#splashForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => { render(await api('/api/me/splash', { msg: f.msg.value })); toast('Saved.'); });
  });

  async function loadStats() {
    const s = await api('/api/me/stats');
    $('#sTotal').textContent = s.total;
    const max = Math.max(1, ...s.days.map((d) => d.n));
    fill($('#sDays'), s.days.map((d) => el('div', { title: `${d.day}: ${d.n}` }, d.n ? el('b', { text: d.n }) : null, el('i', { class: d.n ? '' : 'zero', style: { height: `${Math.max(2, (d.n / max) * 90)}%` } }), el('span', { text: d.day.slice(8) }))));
    const list = (obj) => {
      const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      return rows.length ? rows.map(([k, n]) => el('div', {}, el('span', { text: k }), el('b', { text: n }))) : el('p', { class: 'sub', text: 'No taps yet.' });
    };
    fill($('#sDevices'), list(s.devices));
    fill($('#sCountries'), list(s.countries));
  }

  // ---------- help ----------
  const KINDS = { tech: 'Tech trouble', card: 'My card', food: 'Food', medical: 'Medical', lost: 'Lost something', other: 'Something else' };
  let helpKind = 'tech';
  fill($('#helpKinds'), Object.entries(KINDS).map(([k, label]) => el('button', { type: 'button', class: k === helpKind ? 'on' : '', text: label, onclick: (e) => { helpKind = k; $$('#helpKinds button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } })));
  $('#helpForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      render(await api('/api/me/help', { kind: helpKind, message: f.message.value }));
      f.message.value = '';
      toast('Sent. An organiser will come to you.');
    });
  });

  // ---------- account ----------
  $('#pwForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    guard(f, async () => {
      samePw(f);
      await api('/api/me/password', { current: f.current.value, password: f.password.value });
      f.reset();
      toast('Password changed.');
    });
  });
  async function logout() { await api('/api/me/logout', {}).catch(() => {}); C = null; showAuth('login'); }
  $('#logout').addEventListener('click', logout);
  $('#logout2').addEventListener('click', logout);
  $('#logoutAll').addEventListener('click', async () => {
    if (!confirm('Log out on every device?')) return;
    await api('/api/me/logout-all', {}).catch(() => {});
    C = null;
    showAuth('login');
  });

  // ---------- boot ----------
  async function load(quiet) {
    try {
      const c = await api('/api/me');
      const firstLoad = $('#app').hidden;
      // keep focus and half-typed text when a background refresh lands
      if (quiet && document.activeElement?.matches('input,textarea') && !$('#app').hidden) { C = { ...c }; renderUnread(); renderNotices(); return; }
      render(c);
      $('#auth').hidden = true;
      $('#app').hidden = false;
      if (firstLoad) {
        tab(store.get('me-tab') || 'home');
        startLive();
      }
    } catch (x) {
      if (quiet) { if (x.status === 401) showAuth('login'); return; }
      if (x.status && x.status !== 401) toast(x.message, true);
      route();
    }
  }
  load();
})();
