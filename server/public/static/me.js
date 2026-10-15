(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n) n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  }
  async function api(path, data, raw) {
    const opt = { credentials: 'same-origin' };
    if (raw) { opt.method = 'POST'; opt.body = raw.body; opt.headers = { 'content-type': raw.type, 'x-filename': encodeURIComponent(raw.name) }; }
    else if (data !== undefined) { opt.method = 'POST'; opt.headers = { 'content-type': 'application/json' }; opt.body = JSON.stringify(data); }
    const res = await fetch(path, opt);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(out.error || 'Something went wrong.'), { status: res.status });
    return out;
  }
  let toastT;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), bad ? 4000 : 2200);
  }
  const fmt = (t) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const time = (t) => new Date(t).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const dayName = (t) => new Date(t).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' });
  const ago = (t) => {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return fmt(t);
  };
  const short = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const errOf = (f) => $('.err', f);
  async function guard(form, fn) {
    errOf(form).textContent = '';
    const btns = $$('button', form);
    btns.forEach((b) => (b.disabled = true));
    try { await fn(); } catch (x) { errOf(form).textContent = x.message; }
    btns.forEach((b) => (b.disabled = false));
  }

  let PUB = null;
  fetch('/api/public').then((r) => r.json()).then((p) => {
    PUB = p;
    $('#eventName').textContent = p.event_name;
    document.title = `My ${p.event_name}`;
    if (!p.owner_signup) $('#setupMode [data-sm=email]').textContent = 'Registered without a card';
  }).catch(() => {});

  // ================= auth =================
  const AUTH_VIEWS = ['login', 'setup', 'setupCode', 'forgot'];
  function showAuth(view) {
    $('#dash').hidden = true;
    $('#auth').hidden = false;
    $('#who').hidden = true;
    for (const v of AUTH_VIEWS) $(`[data-view=${v}]`).hidden = v !== view;
    const first = $(`[data-view=${view}] input:not([hidden])`);
    if (first) setTimeout(() => first.focus(), 0);
  }
  function route() {
    if (!$('#dash').hidden) return;
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
    $('#setupHint').textContent = setupMode === 'card' ? 'Card number and PIN are printed on your card.' : PUB?.owner_signup ? 'Use the email the desk registered, or sign up fresh. We email you a code.' : 'Use the email the desk registered you with. We email you a code.';
    $('#setupBtn').textContent = setupMode === 'card' ? 'Set up and log in' : 'Send me a code';
  }));

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
      if (f.password2 && f.password.value !== f.password2.value) throw new Error('The two passwords do not match.');
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
      toast('You\'re in.');
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
      if (f.password2 && f.password.value !== f.password2.value) throw new Error('The two passwords do not match.');
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
      if (f.password2 && f.password.value !== f.password2.value) throw new Error('The two passwords do not match.');
      await api('/api/me/pin-reset', { card: f.card.value.trim(), pin: f.pin.value.trim(), password: f.password.value, password2: f.password2.value });
      history.replaceState(null, '', '/me');
      await load();
      toast('Password changed.');
    });
  });

  // ================= dashboard =================
  let C = null;
  let current = 'home';
  const WHY = {
    project: 'Your project page.', profile: 'Your profile page.', custom: 'Your own link.',
    override: 'Organisers pointed every card here for now.', admin: 'Organisers pointed your card here for now.',
  };
  function tab(name) {
    current = name;
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $$('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== name));
    try { localStorage.setItem('me-tab', name); } catch {}
    if (name === 'card' && C?.cards.length) loadStats();
    if (name === 'profile') refreshFrame();
    if (name === 'inbox') markRead();
  }
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => tab(b.dataset.tab)));

  function schedItem(x, t = Date.now()) {
    const live = x.starts_at <= t && (x.ends_at ? x.ends_at > t : x.starts_at + 3600e3 > t);
    const past = (x.ends_at || x.starts_at + 3600e3) <= t;
    return el('div', { class: `item${live ? ' now' : ''}${past ? ' past' : ''}` },
      el('div', { class: 'when' }, time(x.starts_at), x.ends_at ? el('br') : null, x.ends_at ? `to ${time(x.ends_at)}` : null),
      el('div', {}, el('b', { text: x.title }), x.place ? el('span', { text: x.place }) : null, x.note ? el('span', { text: ` · ${x.note}` }) : null));
  }

  function render(c) {
    C = c;
    const first = c.name.split(/\s+/)[0];
    $('#hello').textContent = `Hi ${first}`;
    $('#meta').textContent = [c.checked_in_at ? 'Checked in' : 'Not checked in yet', c.cards.length ? `card ${c.cards.map((x) => x.id).join(', ')}` : 'no card yet', c.team ? c.team.name : null].filter(Boolean).join(' · ');
    $('#who').textContent = c.email;
    $('#who').hidden = false;
    const ann = $('#announce');
    ann.hidden = !c.public.announcement;
    ann.textContent = c.public.announcement || '';
    $('#unread').hidden = !c.unread;
    $('#unread').textContent = c.unread;

    // urgent unread notices sit on top of every tab until read
    $('#urgent').replaceChildren(...c.notices.filter((n) => n.urgent && !n.read).slice(0, 2).map((n) => el('div', { class: 'urgent' },
      el('b', { text: n.title }), n.body ? el('p', { text: n.body }) : null,
      el('button', { class: 'btn sm ghost', type: 'button', text: 'Got it', onclick: async () => { await api('/api/me/notices/read', { ids: [n.id] }).catch(() => {}); load(true); } }))));

    // ---- home ----
    const t = Date.now();
    const nowItems = c.schedule.filter((x) => x.starts_at <= t && (x.ends_at ? x.ends_at > t : x.starts_at + 3600e3 > t));
    const nextItems = c.schedule.filter((x) => x.starts_at > t).slice(0, 2);
    $('#hNow').replaceChildren(...(nowItems.length ? nowItems.map((x) => el('p', {}, el('b', { text: x.title }), x.place ? ` · ${x.place}` : '')) : [el('p', { class: 'empty-note', text: 'Nothing on right now.' })]));
    $('#hNext').replaceChildren(...(nextItems.length ? nextItems.map((x) => el('p', {}, el('span', { class: 'when', text: `${time(x.starts_at)} ` }), el('b', { text: x.title }))) : [el('p', { class: 'empty-note', text: 'Nothing scheduled.' })]));
    const hc = $('#hCard');
    if (c.cards.length) {
      const k = c.cards[0];
      hc.replaceChildren(el('span', { class: 'k', text: 'Your card' }), el('p', {}, 'A tap on card ', el('b', { text: k.id }), ' opens ', el('a', { href: k.now_url, target: '_blank', rel: 'noopener', text: short(k.now_url) })),
        el('button', { class: 'btn sm ghost', type: 'button', text: 'Change it', onclick: () => tab('card') }));
    } else hc.replaceChildren(el('span', { class: 'k', text: 'Your card' }), el('p', { class: 'empty-note', text: 'No card yet. Grab one at the desk.' }));
    const ht = $('#hTeam');
    if (c.team) {
      const sw = el('span', { class: 'swatch' });
      sw.style.background = c.team.color || '#f2c14e';
      ht.replaceChildren(el('span', { class: 'k', text: 'Your team' }), el('div', { class: 'team-h' }, sw, el('b', { text: c.team.name }), c.team.place ? el('span', { class: 'sub', text: c.team.place }) : null),
        el('p', { class: 'sub', text: `${c.team.members.length} people · ${c.team.points} points` }), el('button', { class: 'btn sm ghost', type: 'button', text: 'See team', onclick: () => tab('team') }));
    } else ht.replaceChildren(el('span', { class: 'k', text: 'Your team' }), el('p', { class: 'empty-note', text: 'Not on a team yet.' }));
    $('#hPoints').textContent = c.points;
    $('#hItems').replaceChildren(...(c.items.length ? c.items.map((i) => el('span', { class: `chip${i.got ? ' got' : ''}`, text: `${i.got ? '✓ ' : ''}${i.name}` })) : [el('span', { class: 'empty-note', text: 'Nothing to collect.' })]));
    const latest = c.notices.slice(0, 2);
    $('#hInbox').replaceChildren(el('span', { class: 'k', text: `Inbox${c.unread ? ` · ${c.unread} new` : ''}` }),
      ...(latest.length ? latest.map((n) => el('p', {}, el('b', { text: n.title }), el('span', { class: 'when', text: ` ${ago(n.ts)}` }))) : [el('p', { class: 'empty-note', text: 'No messages yet.' })]),
      ...(latest.length ? [el('button', { class: 'btn sm ghost', type: 'button', text: 'Open inbox', onclick: () => tab('inbox') })] : []));

    // ---- card ----
    $('#noCard').hidden = c.cards.length > 0;
    $('#hasCard').hidden = !c.cards.length;
    if (c.cards.length) {
      const k = c.cards[0];
      $('#dest').textContent = short(k.now_url);
      $('#dest').href = k.now_url;
      $('#why').textContent = k.now_reason.startsWith('tag:') ? 'Organisers pointed your group here for now.' : WHY[k.now_reason] || '';
      const lock = $('#lock');
      lock.hidden = !c.locked;
      lock.textContent = c.unlock_at ? `Links are locked during the event. You can change yours from ${fmt(c.unlock_at)}. Your profile and splash line still save.` : 'Links are locked during the event. Your profile and splash line still save.';
      $('#choose').classList.toggle('locked', c.locked);
      $('#projUrl').textContent = short(k.project_url);
      $('#projUrl').href = k.project_url;
      $('#profUrl').textContent = c.profile ? short(c.profile_url) : 'Make one under Profile first.';
      $('[data-dest=profile]').disabled = !c.profile || !c.public.allow_profiles;
      $('[data-opt=profile]').hidden = !c.public.allow_profiles;
      for (const o of $$('[data-opt]')) o.classList.toggle('on', o.dataset.opt === c.mode);
      const cu = $('#customForm').url;
      if (document.activeElement !== cu) cu.value = c.custom_url;
      const sm = $('#splashForm').msg;
      if (document.activeElement !== sm) sm.value = c.splash_msg;
      $('#cardList').replaceChildren(el('div', { class: 'panel' }, el('span', { class: 'k', text: c.cards.length > 1 ? 'Your cards' : 'Your card' }), ...c.cards.map((x) => cardRow(x))));
      const pr = $('#prLine');
      pr.textContent = '';
      const best = c.prs.find((p) => p.merged) || c.prs.find((p) => p.state === 'open') || c.prs[0];
      if (best) {
        const state = best.merged ? 'merged' : best.state;
        pr.append(el('span', { class: `tag ${state}`, text: state === 'merged' ? 'live' : state === 'open' ? (best.approved ? 'approved' : 'in review') : 'closed' }), ' ',
          el('a', { href: best.url, target: '_blank', rel: 'noopener', text: `PR #${best.number}` }), ` ${best.title}`);
      } else pr.textContent = 'No pull request yet.';
      const how = $('#howTo');
      how.textContent = '';
      if (c.sites_repo) how.append('Build it in the ', el('code', { text: `${k.id}/` }), ' folder of ', el('a', { href: `https://github.com/${c.sites_repo}#readme`, target: '_blank', rel: 'noopener', text: c.sites_repo }), ' and open a pull request.');
    }

    // ---- team ----
    const tb = $('#teamBox');
    if (c.team) {
      const sw = el('span', { class: 'swatch' });
      sw.style.background = c.team.color || '#f2c14e';
      tb.replaceChildren(el('div', { class: 'panel' },
        el('div', { class: 'team-h' }, sw, el('h1', { text: c.team.name })),
        el('p', { class: 'sub', text: [c.team.place, `${c.team.members.length} people`, `${c.team.points} points`].filter(Boolean).join(' · ') }),
        c.team.note ? el('p', { class: 'bio', text: c.team.note }) : null,
        el('div', { class: 'members' }, c.team.members.map((m) => el('div', {},
          el('span', {}, el('b', { text: m.name }), m.me ? ' (you)' : '', el('br'), el('span', { class: 'meta', text: [m.cards.length ? `card ${m.cards.join(', ')}` : null, m.github ? `@${m.github}` : null, `${m.points} pts`].filter(Boolean).join(' · ') })),
          m.profile ? el('a', { class: 'btn sm ghost', href: m.profile, target: '_blank', rel: 'noopener', text: 'Profile' }) : null)))));
    } else tb.replaceChildren(el('div', { class: 'panel' }, el('span', { class: 'k', text: 'Team' }), el('p', { class: 'empty-note', text: 'You\'re not on a team yet. Organisers will put you on one.' })));

    // ---- schedule ----
    const sb = $('#schedBox');
    if (!c.schedule.length) sb.replaceChildren(el('span', { class: 'k', text: 'Schedule' }), el('p', { class: 'empty-note', text: 'Nothing scheduled yet.' }));
    else {
      const out = [];
      let lastDay = '';
      for (const x of c.schedule) {
        const d = dayName(x.starts_at);
        if (d !== lastDay) { out.push(el('div', { class: 'day', text: d })); lastDay = d; }
        out.push(schedItem(x));
      }
      sb.replaceChildren(el('div', { class: 'sched' }, out));
    }

    // ---- inbox ----
    $('#inboxBox').replaceChildren(...(c.notices.length ? c.notices.map((n) => el('div', { class: `panel notice${n.read ? '' : ' unread'}${n.urgent ? ' isurgent' : ''}` },
      el('span', { class: 'when', text: `${fmt(n.ts)}${n.urgent ? ' · urgent' : ''}` }), el('h3', { text: n.title }), n.body ? el('p', { text: n.body }) : null)) : [el('div', { class: 'panel' }, el('p', { class: 'empty-note', text: 'No messages yet.' }))]));

    // ---- help ----
    $('#helpForm').hidden = false;
    $('#helpClosed').hidden = c.public.help_open;
    $$('#helpForm button, #helpForm textarea').forEach((x) => (x.disabled = !c.public.help_open));
    $('#helpList').replaceChildren(...c.help.map((h) => el('div', { class: 'panel hreq' },
      el('div', {}, el('b', { text: KINDS[h.kind] || h.kind }), el('span', { class: 'when', text: ` ${ago(h.ts)}` }), h.message ? el('p', { text: h.message }) : null, h.reply ? el('p', {}, el('b', { text: 'Organisers: ' }), h.reply) : null,
        h.status !== 'done' ? el('button', { class: 'btn sm ghost', type: 'button', text: 'Cancel', onclick: async () => { render(await api(`/api/me/help/${h.id}/cancel`, {})); } }) : null),
      el('span', { class: `state ${h.status}`, text: { open: 'waiting', claimed: 'on it', done: 'done' }[h.status] }))));

    // ---- guide + account ----
    const g = $('#guideBody');
    g.textContent = '';
    if (c.public.instructions_md.trim()) g.append(window.renderMarkdown(c.public.instructions_md));
    else g.append(el('p', { class: 'sub', text: 'No instructions yet. Check back during the event.' }));
    $('#accInfo').replaceChildren(el('span', {}, el('b', { text: c.name }), el('br'), c.email || '', c.github ? ` · @${c.github}` : '', c.tags.length ? el('br') : null, c.tags.length ? `Tags: ${c.tags.join(', ')}` : ''));

    if (!profileDirty) fillProfile(c.profile);
    if (current === 'inbox') markRead();
  }

  function cardRow(x) {
    const q = window.qrcode(0, 'M');
    q.addData(x.url);
    q.make();
    const svgText = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    const svg = document.importNode(new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement, true);
    const dl = (name, blob) => { const a = el('a', { href: URL.createObjectURL(blob), download: name }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    return el('div', { class: 'cardrow' },
      el('div', { class: 'qrimg' }, svg),
      el('div', {},
        el('b', { text: `Card ${x.id}` }), x.status === 'disabled' ? el('span', { class: 'tag closed', text: ' switched off' }) : null,
        el('p', { class: 'mono', text: short(x.url) }),
        el('div', { class: 'inline wrap' },
          el('button', { class: 'btn sm ghost', type: 'button', text: 'Copy link', onclick: async () => { try { await navigator.clipboard.writeText(x.url); toast('Link copied.'); } catch { toast('Couldn\'t copy.', true); } } }),
          el('button', { class: 'btn sm ghost', type: 'button', text: 'QR as SVG', onclick: () => dl(`boba-bash-card-${x.id}.svg`, new Blob([svgText], { type: 'image/svg+xml' })) }),
          el('button', { class: 'btn sm ghost', type: 'button', text: 'QR as PNG', onclick: () => {
            const img = new Image();
            img.onload = () => {
              const cv = el('canvas', { width: 1024, height: 1024 });
              const ctx = cv.getContext('2d');
              ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1024, 1024);
              ctx.drawImage(img, 0, 0, 1024, 1024);
              cv.toBlob((b) => dl(`boba-bash-card-${x.id}.png`, b), 'image/png');
            };
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
          } }))));
  }

  async function markRead() {
    const ids = (C?.notices || []).filter((n) => !n.read).map((n) => n.id);
    if (!ids.length) return;
    await api('/api/me/notices/read', { ids }).catch(() => {});
    C.notices.forEach((n) => (n.read = true));
    C.unread = 0;
    $('#unread').hidden = true;
    $('#urgent').replaceChildren();
  }

  // ---------- destination + splash ----------
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

  // ---------- stats ----------
  async function loadStats() {
    const s = await api('/api/me/stats');
    $('#sTotal').textContent = s.total;
    const max = Math.max(1, ...s.days.map((d) => d.n));
    $('#sDays').replaceChildren(...s.days.map((d) => {
      const bar = el('i', { class: d.n ? '' : 'zero' });
      bar.style.height = `${Math.max(2, (d.n / max) * 90)}%`;
      return el('div', { title: `${d.day}: ${d.n}` }, d.n ? el('b', { text: d.n }) : null, bar, el('span', { text: d.day.slice(8) }));
    }));
    const list = (obj) => {
      const rows = Object.entries(obj).sort((a, b) => b[1] - a[1]);
      return rows.length ? rows.map(([k, n]) => el('div', {}, el('span', { text: k }), el('b', { text: n }))) : [el('p', { class: 'sub', text: 'No taps yet.' })];
    };
    $('#sDevices').replaceChildren(...list(s.devices));
    $('#sCountries').replaceChildren(...list(s.countries));
  }

  // ---------- profile ----------
  let profileDirty = false;
  let P = null;
  const pf = $('#profileForm');
  pf.addEventListener('input', () => (profileDirty = true));
  function fillProfile(p) {
    const pub = C.public;
    P = JSON.parse(JSON.stringify(p || { name: C.name, tagline: '', bio: '', theme: 'boba', accent: '', avatar: '', show_project: true, links: [], socials: {}, wall: true, contact: {} }));
    pf.name.value = P.name || '';
    pf.tagline.value = P.tagline || '';
    pf.bio.value = P.bio || '';
    pf.useAccent.checked = !!P.accent;
    pf.accent.value = P.accent || pub.themes[P.theme || 'boba'].accent;
    pf.show_project.checked = P.show_project !== false;
    pf.wall.checked = P.wall !== false;
    pf.c_email.checked = !!P.contact?.email;
    pf.c_phone.checked = !!P.contact?.phone;
    $('#themes').replaceChildren(...Object.entries(pub.themes).map(([k, t]) => {
      const b = el('button', { type: 'button', class: 'theme' + ((P.theme || 'boba') === k ? ' on' : ''), onclick: () => { P.theme = k; profileDirty = true; $$('.theme').forEach((x) => x.classList.toggle('on', x === b)); if (!pf.useAccent.checked) pf.accent.value = t.accent; } }, el('i'), k);
      b.firstChild.style.background = `linear-gradient(135deg, ${t.bg} 50%, ${t.accent} 50%)`;
      return b;
    }));
    renderLinks();
    $('#socials').replaceChildren(...pub.socials.map((s) => el('label', { class: 'f' }, el('span', { text: s.label }), el('input', { name: `soc_${s.key}`, value: P.socials?.[s.key] || '', placeholder: s.key === 'github' ? 'octocat' : 'username' }))));
    drawAvatar();
    $('#openProfile').href = C.preview_url;
    $('#profNote').textContent = p ? `Public page: ${short(C.profile_url)} (updates a minute or two after you save).` : 'Save once to create your page.';
    profileDirty = false;
  }
  function drawAvatar() {
    const box = $('#avPreview');
    box.textContent = '';
    if (P.avatar) box.append(el('img', { src: `/files/${P.avatar}`, alt: '' }));
    else box.textContent = (pf.name.value || C.name || '#').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    $('#avRemove').hidden = !P.avatar;
  }
  function renderLinks() {
    $('#links').replaceChildren(...P.links.map((l, i) => el('div', { class: 'link' },
      el('input', { value: l.label, placeholder: 'Label', maxLength: 40, oninput: (e) => (l.label = e.target.value) }),
      el('input', { value: l.url, placeholder: 'https://', inputMode: 'url', oninput: (e) => (l.url = e.target.value) }),
      el('span', { class: 'x' },
        el('button', { type: 'button', class: 'icon', title: 'Move up', text: '↑', disabled: i === 0, onclick: () => { P.links.splice(i - 1, 0, P.links.splice(i, 1)[0]); profileDirty = true; renderLinks(); } }),
        el('button', { type: 'button', class: 'icon', title: 'Remove', text: '✕', onclick: () => { P.links.splice(i, 1); profileDirty = true; renderLinks(); } })))));
    $('#addLink').disabled = P.links.length >= 12;
  }
  $('#addLink').addEventListener('click', () => { P.links.push({ label: '', url: '' }); profileDirty = true; renderLinks(); $('#links .link:last-child input').focus(); });
  $('#avFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) return toast('Keep the photo under 3 MB.', true);
    try {
      const f = await api('/api/me/avatar', undefined, { body: file, type: file.type || 'application/octet-stream', name: file.name });
      P.avatar = f.id;
      profileDirty = true;
      drawAvatar();
      toast('Photo added. Save the profile to keep it.');
    } catch (x) { toast(x.message, true); }
  });
  $('#avRemove').addEventListener('click', () => { P.avatar = ''; profileDirty = true; drawAvatar(); });
  pf.name.addEventListener('input', () => { if (!P.avatar) drawAvatar(); });
  pf.addEventListener('submit', (e) => {
    e.preventDefault();
    guard(pf, async () => {
      const profile = {
        ...P,
        name: pf.name.value, tagline: pf.tagline.value, bio: pf.bio.value,
        accent: pf.useAccent.checked ? pf.accent.value : '',
        show_project: pf.show_project.checked,
        wall: pf.wall.checked,
        contact: { email: pf.c_email.checked, phone: pf.c_phone.checked },
        links: P.links.filter((l) => l.url.trim()),
        socials: Object.fromEntries(C.public.socials.map((s) => [s.key, pf[`soc_${s.key}`].value.trim()])),
      };
      profileDirty = false;
      render(await api('/api/me/profile', { profile }));
      fillProfile(C.profile);
      refreshFrame();
      toast('Profile saved.');
    });
  });
  function refreshFrame() {
    const wrap = $('#profileFrame').parentNode;
    if (!C || !C.profile) { wrap.hidden = true; return; }
    wrap.hidden = false;
    $('#profileFrame').src = `${C.preview_url}?t=${Date.now()}`;
  }

  // ---------- help ----------
  const KINDS = { tech: 'Tech trouble', card: 'My card', food: 'Food', medical: 'Medical', lost: 'Lost something', other: 'Something else' };
  let helpKind = 'tech';
  $('#helpKinds').replaceChildren(...Object.entries(KINDS).map(([k, label]) => el('button', { type: 'button', class: k === helpKind ? 'on' : '', 'data-k': k, text: label, onclick: (e) => { helpKind = k; $$('#helpKinds button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } })));
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
      if (f.password2 && f.password.value !== f.password2.value) throw new Error('The two passwords do not match.');
      await api('/api/me/password', { current: f.current.value, password: f.password.value });
      f.reset();
      toast('Password changed.');
    });
  });
  $('#logout').addEventListener('click', async () => { await api('/api/me/logout', {}).catch(() => {}); C = null; showAuth('login'); });
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
      const firstLoad = $('#dash').hidden;
      render(c);
      $('#auth').hidden = true;
      $('#dash').hidden = false;
      if (firstLoad) {
        let t = 'home';
        try { t = localStorage.getItem('me-tab') || 'home'; } catch {}
        tab(t);
      }
    } catch (x) {
      if (quiet) return;
      if (x.status && x.status !== 401) toast(x.message, true);
      route();
    }
  }
  load();
  // new messages and schedule changes show up without a refresh
  setInterval(() => { if (C && document.visibilityState === 'visible' && !profileDirty && !document.activeElement?.matches('input,textarea')) load(true); }, 30000);
})();
