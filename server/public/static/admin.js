(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  // Safe DOM builder: strings become text nodes, never HTML.
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k in n && k !== 'list') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : String(k));
    return n;
  }

  async function api(path, method = 'GET', data, raw) {
    const opt = { method, credentials: 'same-origin' };
    if (raw) { opt.body = raw.body; opt.headers = { 'content-type': raw.type, 'x-filename': encodeURIComponent(raw.name) }; }
    else if (data !== undefined) { opt.headers = { 'content-type': 'application/json' }; opt.body = JSON.stringify(data); }
    const res = await fetch(path, opt);
    const out = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/api/admin/login') { showLogin(); throw new Error('Log in again.'); }
    if (!res.ok) throw new Error(out.error || 'Something went wrong.');
    return out;
  }

  let toastT;
  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), bad ? 4500 : 2200);
  }
  const run = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

  const fmt = (t) => (t ? new Date(Number(t)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
  const hm = (t) => new Date(Number(t)).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const ago = (t) => {
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return fmt(t);
  };
  const short = (u) => String(u || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const toLocal = (ms) => {
    if (!ms) return '';
    const d = new Date(Number(ms));
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const fromLocal = (v) => (v ? new Date(v).getTime() : '');
  // schedule times are India time regardless of the organiser's laptop clock
  const istMs = (day, t) => Date.parse(`${day}T${t}:00+05:30`);
  const istParts = (ms) => {
    const d = new Date(Number(ms) + 19800000).toISOString();
    return { day: d.slice(0, 10), time: d.slice(11, 16) };
  };
  const REASON = { project: 'project', profile: 'profile', custom: 'own link', override: 'all-cards link', admin: 'organiser link', inactive: 'blank', disabled: 'off', missing: 'missing' };
  const reasonText = (r) => (r && r.startsWith('tag:') ? `tag route: ${r.slice(4)}` : REASON[r] || r || '');
  const HELP_KIND = { tech: 'Tech', card: 'Card', food: 'Food', medical: 'Medical', lost: 'Lost item', other: 'Other' };

  let S = null; // /api/admin/state
  let PEOPLE = []; // /api/admin/people
  let CARDS = []; // /api/admin/cards
  const isAdmin = () => S && S.me.role === 'admin';
  const personById = (id) => PEOPLE.find((p) => p.id === id);
  const teamById = (id) => S?.teams.find((t) => t.id === id);
  const cardUrl = (id) => `${S.settings.card_base.replace(/\/$/, '')}/${id}`;

  function pchip(id, label) {
    const p = personById(id);
    return el('button', { class: 'pid', type: 'button', 'data-person': id, title: p ? [p.email, p.phone].filter(Boolean).join(' · ') : '' }, label || p?.name || `#${id}`);
  }
  function cchip(id) {
    return el('button', { class: 'cid', type: 'button', 'data-card': id }, `#${id}`);
  }
  function tchip(id) {
    const t = teamById(id);
    if (!t) return el('span', { class: 'muted', text: '—' });
    return el('span', { class: 'tagchip', style: { background: (t.color || '#888') + '22', color: t.color || 'var(--muted)' } }, t.name);
  }
  document.addEventListener('click', (e) => {
    const p = e.target.closest('[data-person]');
    if (p) { e.stopPropagation(); openPerson(Number(p.dataset.person)); return; }
    const c = e.target.closest('[data-card]');
    if (c) { e.stopPropagation(); openCard(Number(c.dataset.card)); return; }
    const g = e.target.closest('[data-go]');
    if (g) go(g.dataset.go);
  });

  function qrSvg(text, cell = 4) {
    const q = window.qrcode(0, 'M');
    q.addData(text);
    q.make();
    return document.importNode(new DOMParser().parseFromString(q.createSvgTag({ cellSize: cell, margin: 0, scalable: true }), 'image/svg+xml').documentElement, true);
  }

  // ================= login =================
  function showLogin() {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#loginForm').email.focus();
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    $('.err', f).textContent = '';
    try {
      await api('/api/admin/login', 'POST', { email: f.email.value.trim(), password: f.password.value });
      f.password.value = '';
      boot();
    } catch (x) { $('.err', f).textContent = x.message; }
  });
  $('#logout').addEventListener('click', run(async () => { await api('/api/admin/logout', 'POST', {}); showLogin(); }));

  // ================= nav + data =================
  let view = 'desk';
  const PAGES = {
    desk: () => renderDesk(), people: () => renderPeople(), teams: () => loadTeams(), notify: () => loadNotices(),
    schedule: () => loadSchedule(), help: () => loadHelp(), handouts: () => renderHandouts(), cards: () => renderCards(),
    control: () => renderControl(), print: () => {}, prs: () => loadPrs(), guide: () => loadGuide(), stats: () => loadStats(),
    log: () => loadLog(true), admins: () => renderAdmins(), setup: () => renderSetup(),
  };
  function go(v) {
    if (!PAGES[v] || $(`#nav [data-view=${v}]`)?.hidden) v = 'desk';
    view = v;
    for (const b of $$('#nav button')) b.classList.toggle('on', b.dataset.view === v);
    for (const s of $$('[data-page]')) s.hidden = s.dataset.page !== v;
    try { localStorage.setItem('hq-view', v); } catch {}
    run(PAGES[v])();
  }
  for (const b of $$('#nav button')) b.addEventListener('click', () => go(b.dataset.view));

  async function refresh() {
    const [s, p, c] = await Promise.all([api('/api/admin/state'), api('/api/admin/people'), api('/api/admin/cards')]);
    S = s; PEOPLE = p.people; CARDS = c.cards;
    $('#meEmail').textContent = `${S.me.email} · ${S.me.role}`;
    for (const x of $$('[data-admin]')) x.hidden = !isAdmin();
    renderSide();
    fillSelects();
  }
  const quiet = () => !$('#drawer').hidden || document.activeElement?.matches('input:not([type=checkbox]):not([type=radio]),textarea,select');
  async function refreshView() {
    await refresh();
    if (!quiet() || ['people', 'cards'].includes(view)) run(PAGES[view])();
  }

  function renderSide() {
    const s = S.settings;
    const dot = (cls) => el('span', { class: `dot ${cls || ''}` });
    $('#sideStatus').replaceChildren(
      el('div', {}, dot(), `${S.counts.here} here of ${S.counts.people}`),
      el('div', {}, dot(), `${S.counts.claimed} set up · ${S.counts.cards} cards`),
      el('div', {}, dot(S.counts.help_open ? 'bad' : ''), S.counts.help_open ? `${S.counts.help_open} help requests` : 'No help requests'),
      el('div', {}, dot(S.override_active ? 'bad' : ''), S.override_active ? 'All-cards link ON' : s.override_on === '1' ? 'All-cards link scheduled' : 'No all-cards link'),
      el('div', {}, dot(S.global_locked ? 'warn' : ''), S.global_locked ? 'Owner links locked' : 'Owner links open'),
      el('div', {}, dot(S.github.token && !S.github.problem ? '' : 'warn'), S.github.token ? (S.github.problem ? 'GitHub: needs a look' : `GitHub synced ${ago(S.github.last_sync)}`) : 'GitHub token missing'),
      el('div', {}, dot(S.smtp ? '' : 'warn'), S.smtp ? 'Mail ready' : 'Mail not set up'),
      el('div', {}, `${S.counts.taps_24h} taps in 24h`),
    );
    $('#helpBadge').hidden = !S.counts.help_open;
    $('#helpBadge').textContent = S.counts.help_open;
    const banner = $('#overrideBanner');
    banner.hidden = !S.override_active;
    if (S.override_active) banner.replaceChildren('Every card is going to ', el('a', { href: s.override_url, target: '_blank', rel: 'noopener', text: short(s.override_url) }), s.override_until ? ` until ${fmt(s.override_until)}` : '', '. Change it under Control.');
  }

  function teamOptions(blank = 'No team') {
    return [el('option', { value: '', text: blank }), ...S.teams.map((t) => el('option', { value: t.id, text: t.name }))];
  }
  const allTags = () => [...new Set(PEOPLE.flatMap((p) => p.tags))].sort();
  function fillSelects() {
    const keep = (sel, opts) => { const v = sel.value; sel.replaceChildren(...opts); sel.value = v; };
    keep($('#pTeam'), [el('option', { value: '', text: 'Any team' }), el('option', { value: 'none', text: 'No team' }), ...S.teams.map((t) => el('option', { value: t.id, text: t.name }))]);
    keep($('#pTag'), [el('option', { value: '', text: 'Any tag' }), ...allTags().map((t) => el('option', { value: t, text: t }))]);
    keep($('#autoScope'), [el('option', { value: 'unassigned', text: 'Everyone without a team' }), el('option', { value: 'checked_in', text: 'Checked in, without a team' }), ...allTags().map((t) => el('option', { value: `tag:${t}`, text: `Tagged ${t}, without a team` }))]);
    keep($('#iPick'), S.items.map((i) => el('option', { value: i.id, text: i.name })));
    $('#regItems').replaceChildren(...(S.items.length ? [el('span', { class: 'lbl', text: 'Hand out now' })] : []), ...S.items.map((i) => el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'item', value: i.id }), i.name)));
  }

  // ================= global search =================
  const gs = $('#gsearch');
  let gsT;
  gs.addEventListener('input', () => {
    clearTimeout(gsT);
    gsT = setTimeout(run(async () => {
      const q = gs.value.trim();
      const box = $('#gresults');
      if (!q) { box.hidden = true; return; }
      const r = await api(`/api/admin/search?q=${encodeURIComponent(q)}`);
      const rows = [
        ...r.cards.map((c) => el('button', { type: 'button', onclick: () => { box.hidden = true; gs.value = ''; c.person_id ? openPerson(c.person_id) : openCard(c.id); } }, el('b', { text: `Card ${c.id}` }), el('span', { class: 'muted', text: c.name || 'blank' }))),
        ...r.people.map((p) => el('button', { type: 'button', onclick: () => { box.hidden = true; gs.value = ''; openPerson(p.id); } }, el('b', { text: p.name }), el('span', { class: 'muted', text: [p.email, `#${p.id}`].filter(Boolean).join(' · ') }))),
      ];
      box.replaceChildren(...(rows.length ? rows : [el('button', { type: 'button', disabled: true, text: 'Nobody matches.' })]));
      box.hidden = false;
    }), 150);
  });
  gs.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#gresults button')?.click(); if (e.key === 'Escape') { gs.value = ''; $('#gresults').hidden = true; } });
  document.addEventListener('click', (e) => { if (!e.target.closest('.gsearch')) $('#gresults').hidden = true; });

  // ================= desk =================
  const reg = $('#reg');
  const QUICK = ['attendee', 'volunteer', 'organiser', 'speaker', 'sponsor', 'mentor'];
  $('#quickTags').replaceChildren(...QUICK.map((t) => el('button', { type: 'button', text: `+ ${t}`, onclick: () => {
    const cur = reg.tags.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (!cur.includes(t)) cur.push(t);
    reg.tags.value = cur.join(', ');
  } })));
  // The cards are printed already (number + PIN). The desk gets the next free number filled in (or types the one
  // in their hand) and types the PIN printed on it. "No card for now": give one later from their panel.
  let cardTouched = false;
  function fillNextCard(force) {
    if (S && (force || !cardTouched)) { reg.card.value = S.next_card; cardTouched = false; }
  }
  function renderCardMode() {
    const mode = reg.cardmode.value;
    $('#cardFields').hidden = mode === 'none';
    const hint = $('#regHint');
    if (mode === 'none') { hint.textContent = 'They can set up later by email, and you can give a card any time from their panel.'; return; }
    fillNextCard(false);
    const id = Number(reg.card.value);
    const c = id && CARDS.find((x) => x.id === id);
    hint.textContent = !id ? 'Type the card number.'
      : c?.person ? `Card ${id} already belongs to ${c.person.name}. Pick another.`
        : c?.status === 'disabled' ? `Card ${id} is switched off. Pick another.`
          : 'Type the PIN printed on the card. You can change the number or PIN later from their panel.';
  }
  for (const r of $$('[name=cardmode]', reg)) r.addEventListener('change', renderCardMode);
  reg.card.addEventListener('input', () => { cardTouched = true; renderCardMode(); });
  $('#useNext').addEventListener('click', () => { fillNextCard(true); renderCardMode(); reg.pin.focus(); });
  let lastReg = null;
  reg.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    $('.err', reg).textContent = '';
    const fd = new FormData(reg);
    const mode = fd.get('cardmode');
    const data = {
      name: fd.get('name'), email: fd.get('email'), phone: fd.get('phone'), github: fd.get('github'), tags: fd.get('tags'), note: fd.get('note'),
      card: mode === 'none' ? 'none' : fd.get('card').trim(),
      pin: mode === 'none' ? '' : fd.get('pin').trim(),
      checkin: reg.checkin.checked, allow_dupes: reg.allow_dupes.checked,
      items: fd.getAll('item').map(Number),
    };
    if (mode !== 'none') {
      if (!/^\d+$/.test(data.card)) { $('.err', reg).textContent = 'Type the card number.'; return; }
      const c = CARDS.find((x) => x.id === Number(data.card));
      if (c?.person) { $('.err', reg).textContent = `Card ${data.card} already belongs to ${c.person.name}.`; return; }
      if (!/^\d{4,8}$/.test(data.pin)) { $('.err', reg).textContent = 'Type the PIN printed on the card (4 to 8 digits).'; reg.pin.focus(); return; }
    }
    let r;
    try { r = await api('/api/admin/people', 'POST', data); } catch (x) { $('.err', reg).textContent = x.message; return; }
    lastReg = { ...r, name: data.name };
    showResult(lastReg);
    reg.reset();
    cardTouched = false;
    await refresh();
    renderDesk();
    renderCardMode();
    reg.name.focus();
  }));
  function showResult(r) {
    $('#regResult').hidden = false;
    $('#rName').textContent = `${r.name} is in (#${r.person_id})`;
    $('#rCardBox').hidden = !r.card;
    $('#rQr').hidden = !r.card;
    $('#rPrint').hidden = !r.card;
    $('#rErr').textContent = r.card_error ? `Card not given: ${r.card_error}` : '';
    if (r.card) {
      $('#rId').textContent = r.card.id;
      $('#rPin').textContent = r.card.pin || 'on file';
      $('#rQr').replaceChildren(qrSvg(r.card.url));
      $('#rUrl').textContent = `Flash ${short(r.card.url)}`;
    } else $('#rUrl').textContent = r.card_error ? '' : 'No card. They can set up with their email.';
    $('#rTell').textContent = `Tell them: set up at ${short(S.settings.dashboard_url || location.origin)}/me${r.card ? ' with the card number and PIN' : ' with this email'}.`;
  }
  $('#rNext').addEventListener('click', () => { $('#regResult').hidden = true; reg.name.focus(); });
  $('#rOpen').addEventListener('click', () => lastReg && openPerson(lastReg.person_id));
  $('#rPrint').addEventListener('click', () => lastReg?.card && printTags([{ id: lastReg.card.id, pin: lastReg.card.pin, name: lastReg.name }]));
  function renderDesk() {
    renderCardMode();
    const rows = [...PEOPLE].sort((a, b) => b.created_at - a.created_at).slice(0, 8);
    $('#recent').replaceChildren(...(rows.length ? rows.map((p) => el('div', {},
      el('span', { class: 'row-main' }, pchip(p.id), p.cards.map(cchip), p.tags.map((t) => el('span', { class: 'tagchip', text: t }))),
      el('span', { class: 'muted small', text: `${p.checked_in_at ? 'here' : 'not checked in'} · ${p.claimed ? 'set up' : 'not set up yet'} · ${ago(p.created_at)}` }))) : [el('div', {}, el('span', { class: 'muted', text: 'Nobody yet.' }))]));
    renderCheckin();
  }
  function renderCheckin() {
    const q = $('#ciSearch').value.trim().toLowerCase().replace(/^#/, '');
    const box = $('#ciList');
    if (!q) { box.replaceChildren(el('p', { class: 'muted small', text: `${S.counts.here} of ${S.counts.people} checked in.` })); return; }
    const rows = PEOPLE.filter((p) => p.cards.includes(Number(q)) || [p.name, p.email, p.phone, p.github].some((v) => v && v.toLowerCase().includes(q))).slice(0, 8);
    box.replaceChildren(...(rows.length ? rows.map((p) => el('div', {},
      el('span', { class: 'row-main' }, pchip(p.id), p.cards.map(cchip), p.checked_in_at ? el('span', { class: 'pill here', text: `here ${hm(p.checked_in_at)}` }) : null),
      el('button', { class: `btn sm ${p.checked_in_at ? 'ghost' : 'accent'}`, type: 'button', text: p.checked_in_at ? 'Undo' : 'Check in', onclick: run(async () => {
        await api(`/api/admin/people/${p.id}/checkin`, 'POST', { on: !p.checked_in_at });
        toast(p.checked_in_at ? 'Check-in undone' : `${p.name} checked in`);
        await refresh();
        renderCheckin();
      }) }))) : [el('p', { class: 'muted small', text: 'Nobody matches. Register them on the left.' })]));
  }
  $('#ciSearch').addEventListener('input', renderCheckin);

  // ================= people =================
  let pFilter = 'all';
  const pSel = new Set();
  for (const b of $$('#pFilter button')) b.addEventListener('click', () => { pFilter = b.dataset.f; $$('#pFilter button').forEach((x) => x.classList.toggle('on', x === b)); renderPeople(); });
  for (const id of ['#pSearch', '#pTeam', '#pTag']) $(id).addEventListener(id === '#pSearch' ? 'input' : 'change', () => renderPeople());
  function visiblePeople() {
    const q = $('#pSearch').value.trim().toLowerCase().replace(/^#/, '');
    const team = $('#pTeam').value, tag = $('#pTag').value;
    return PEOPLE.filter((p) => {
      if (pFilter === 'here' && !p.checked_in_at) return false;
      if (pFilter === 'away' && p.checked_in_at) return false;
      if (pFilter === 'nocard' && p.cards.length) return false;
      if (pFilter === 'unclaimed' && p.claimed) return false;
      if (pFilter === 'help' && !p.help_open) return false;
      if (pFilter === 'disabled' ? !p.disabled : p.disabled && pFilter !== 'all') return false;
      if (team === 'none' && p.team_id) return false;
      if (team && team !== 'none' && String(p.team_id) !== team) return false;
      if (tag && !p.tags.includes(tag)) return false;
      if (q && !(String(p.id) === q || p.cards.includes(Number(q)) || [p.name, p.email, p.phone, p.github, p.tags.join(' ')].some((v) => v && v.toLowerCase().includes(q)))) return false;
      return true;
    });
  }
  function renderPeople() {
    const rows = visiblePeople();
    $('#pCount').textContent = `${rows.length} ${rows.length === 1 ? 'person' : 'people'}`;
    $('#pEmpty').hidden = PEOPLE.length > 0;
    for (const id of [...pSel]) if (!personById(id)) pSel.delete(id);
    $('#pTable tbody').replaceChildren(...rows.map((p) => el('tr', { class: 'click', onclick: () => openPerson(p.id) },
      el('td', { class: 'cb', onclick: (e) => e.stopPropagation() }, el('input', { type: 'checkbox', checked: pSel.has(p.id), onchange: (e) => { e.target.checked ? pSel.add(p.id) : pSel.delete(p.id); renderPBulk(); } })),
      el('td', { class: 'muted' }, String(p.id)),
      el('td', {}, el('b', { text: p.name }), p.github ? el('span', { class: 'reason', text: `@${p.github}` }) : null, p.email ? el('div', { class: 'muted small', text: p.email }) : null),
      el('td', {}, p.cards.length ? p.cards.map(cchip) : el('span', { class: 'muted', text: '—' })),
      el('td', {}, p.team_id ? tchip(p.team_id) : el('span', { class: 'muted', text: '—' })),
      el('td', {}, p.tags.map((t) => el('span', { class: 'tagchip', text: t }))),
      el('td', {},
        p.checked_in_at ? el('span', { class: 'pill here', text: 'here' }) : null, ' ',
        !p.claimed ? el('span', { class: 'pill warn', text: 'not set up' }) : null, ' ',
        p.help_open ? el('span', { class: 'pill bad', text: 'help' }) : null,
        p.locked_out ? el('span', { class: 'pill bad', text: 'locked out' }) : null,
        p.disabled ? el('span', { class: 'pill disabled', text: 'disabled' }) : null),
      el('td', { class: 'r' }, String(p.points)),
      el('td', { class: 'r' }, String(p.scans)),
    )));
    $('#pAll').checked = rows.length > 0 && rows.every((p) => pSel.has(p.id));
    renderPBulk();
  }
  $('#pAll').addEventListener('change', (e) => { for (const p of visiblePeople()) e.target.checked ? pSel.add(p.id) : pSel.delete(p.id); renderPeople(); });
  const P_ACTIONS = [
    ['checkin', 'Check in', false], ['checkout', 'Undo check-in', false], ['item', 'Hand out', false],
    ['team', 'Set team', true], ['tag_add', 'Add tag', true], ['tag_remove', 'Remove tag', true], ['points', 'Give points', true],
    ['mode_project', 'Reset destination to project', true], ['disable', 'Disable', true], ['enable', 'Enable', true],
  ];
  $('#pBulkAction').replaceChildren(...P_ACTIONS.map(([v, l]) => el('option', { value: v, text: l })));
  function renderPBulk() {
    $('#pBulk').hidden = !pSel.size;
    $('#pBulkCount').textContent = `${pSel.size} selected`;
    for (const o of $$('#pBulkAction option')) o.hidden = P_ACTIONS.find((a) => a[0] === o.value)[2] && !isAdmin();
    const a = $('#pBulkAction').value;
    const box = $('#pBulkValue');
    if (box.dataset.a === a) return;
    box.dataset.a = a;
    if (a === 'team') box.replaceChildren(el('select', {}, teamOptions()));
    else if (a === 'item') box.replaceChildren(el('select', {}, S.items.map((i) => el('option', { value: i.id, text: i.name }))));
    else if (a === 'tag_add' || a === 'tag_remove') box.replaceChildren(el('input', { placeholder: 'tag' }));
    else if (a === 'points') box.replaceChildren(el('input', { type: 'number', placeholder: '+10', class: 'w-id' }), el('input', { placeholder: 'reason' }));
    else box.replaceChildren();
  }
  $('#pBulkAction').addEventListener('change', renderPBulk);
  $('#pBulkClear').addEventListener('click', () => { pSel.clear(); renderPeople(); });
  $('#pBulkNotify').addEventListener('click', () => { notifyPeople = [...pSel]; go('notify'); $('#nKind').value = 'people'; renderNotifyTarget(); });
  $('#pBulkGo').addEventListener('click', run(async () => {
    const action = $('#pBulkAction').value;
    const inputs = $$('#pBulkValue input, #pBulkValue select');
    const value = inputs[0]?.value ?? null;
    const reason = inputs[1]?.value;
    if (['tag_add', 'tag_remove', 'points'].includes(action) && !value) throw new Error('Fill in the value.');
    if (!confirm(`${$('#pBulkAction').selectedOptions[0].text} for ${pSel.size} ${pSel.size === 1 ? 'person' : 'people'}?`)) return;
    const r = await api('/api/admin/people/bulk', 'POST', { ids: [...pSel], action, value, reason });
    toast(`Done for ${r.count}`);
    await refresh();
    renderPeople();
  }));

  // ================= drawer =================
  let drawerFor = null;
  function closeDrawer() { $('#drawer').hidden = true; $('#scrim').hidden = true; drawerFor = null; }
  $('#dClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerFor) closeDrawer(); });
  function showDrawer(title, pills, body) {
    $('#dTitle').textContent = title;
    $('#dPills').replaceChildren(...pills);
    $('#dBody').replaceChildren(...body);
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
  }
  const sec = (title, ...kids) => el('div', { class: 'sec' }, el('h3', { text: title }), ...kids);
  const mini = (rows) => el('div', { class: 'mini' }, rows.length ? rows : el('span', { class: 'muted', text: 'Nothing yet.' }));
  function miniBars(days) {
    const max = Math.max(1, ...days.map((d) => d.n));
    return el('div', { class: 'bars' }, days.map((d) => {
      const i = el('i', { class: d.n ? '' : 'zero', style: { height: `${Math.max(2, (d.n / max) * 85)}%` } });
      return el('div', { title: `${d.day}: ${d.n}` }, d.n ? el('b', { text: d.n }) : null, i, el('span', { text: d.day.slice(8) }));
    }));
  }

  // ---------- person ----------
  const openPerson = run(async (id) => {
    const d = await api(`/api/admin/people/${id}`);
    drawerFor = { kind: 'person', id };
    renderPersonDrawer(d);
  });
  async function reopenPerson(id, d) {
    await refresh();
    if (drawerFor?.kind === 'person' && drawerFor.id === id) renderPersonDrawer(d || (await api(`/api/admin/people/${id}`)));
    if (!quiet() || ['people', 'desk'].includes(view)) run(PAGES[view])();
  }
  function renderPersonDrawer(d) {
    const p = d.person;
    const admin = isAdmin();
    const pills = [
      p.checked_in_at ? el('span', { class: 'pill here', text: 'here' }) : el('span', { class: 'pill', text: 'not here' }),
      p.claimed ? el('span', { class: 'pill blue', text: 'set up' }) : el('span', { class: 'pill warn', text: 'not set up' }),
      p.disabled ? el('span', { class: 'pill bad', text: 'disabled' }) : null,
    ];

    const quick = el('div', { class: 'quick' },
      el('button', { class: `btn ${p.checked_in_at ? '' : 'accent'}`, type: 'button', text: p.checked_in_at ? `Here since ${hm(p.checked_in_at)} · undo` : 'Check in', onclick: run(async () => reopenPerson(p.id, await api(`/api/admin/people/${p.id}/checkin`, 'POST', { on: !p.checked_in_at }))) }),
      admin ? el('button', { class: 'btn', type: 'button', text: 'Message', onclick: () => { notifyPeople = [p.id]; closeDrawer(); go('notify'); $('#nKind').value = 'people'; renderNotifyTarget(); $('#nForm').title.focus(); } }) : null,
      d.profile_url ? el('a', { class: 'btn', href: `/p/${p.id}`, target: '_blank', rel: 'noopener', text: 'Profile' }) : null,
    );

    const f = (name, label, value, attrs = {}) => el('label', { class: 'field' }, el('span', { text: label }), el('input', { name, value: value ?? '', disabled: !admin, ...attrs }));
    const teamSel = el('select', { name: 'team_id', disabled: !admin }, teamOptions());
    teamSel.value = p.team_id || '';
    const dup = el('input', { type: 'checkbox', name: 'allow_dupes' });
    const details = el('form', { class: 'grid two' },
      f('name', 'Name', p.name),
      f('email', p.email ? (p.email_verified ? 'Email · verified' : 'Email · not verified') : 'Email', p.email, { type: 'email' }),
      f('phone', 'Phone', p.phone),
      f('github', 'GitHub', p.github),
      el('label', { class: 'field' }, el('span', { text: 'Team' }), teamSel),
      f('tags', 'Tags', p.tags.join(', ')),
      el('label', { class: 'field span2' }, el('span', { text: 'Note (organisers only)' }), el('textarea', { name: 'note', value: p.note || '', disabled: !admin })),
      admin ? el('label', { class: 'check span2' }, dup, 'Allow duplicate phone / GitHub') : null,
      admin ? el('div', { class: 'span2' }, el('button', { class: 'btn primary', type: 'submit', text: 'Save details' })) : null,
    );
    details.addEventListener('submit', run(async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(details));
      data.allow_dupes = dup.checked;
      reopenPerson(p.id, await api(`/api/admin/people/${p.id}`, 'PATCH', data));
      toast('Saved');
    }));

    const reveal = el('div');
    const giveNo = el('input', { placeholder: `Card ID (empty = #${S.next_card})`, class: 'w-tag', inputMode: 'numeric' });
    const givePin = el('input', { placeholder: 'PIN on it', class: 'w-id', inputMode: 'numeric', maxLength: 8 });
    const gNew = el('input', { type: 'checkbox' }), gSecond = el('input', { type: 'checkbox' }), gReplace = el('input', { type: 'checkbox' });
    const cards = el('div', {},
      mini(d.cards.map((c) => el('div', {},
        el('span', {}, cchip(c.id), ' ', el('a', { href: c.now_url, target: '_blank', rel: 'noopener', text: short(c.now_url) || c.now_reason }), el('span', { class: 'reason', text: reasonText(c.now_reason) })),
        el('span', {}, c.status === 'disabled' ? 'off · ' : '', `${c.scans} taps`)))),
      el('div', { class: 'inline wrap', style: { marginTop: '8px' } },
        giveNo, givePin,
        el('button', { class: 'btn', type: 'button', text: d.cards.length ? 'Give another card' : 'Give card', onclick: run(async () => {
          const r = await api(`/api/admin/people/${p.id}/card`, 'POST', { card: giveNo.value.trim() || null, pin: givePin.value.trim(), new_pin: gNew.checked, allow_second: gSecond.checked, replace: gReplace.checked });
          reveal.replaceChildren(el('div', { class: 'reveal' }, `Card ${r.id}: `, r.pin ? el('b', { text: r.pin }) : 'printed PIN', ` · flash ${short(r.url)}`,
            el('button', { class: 'btn sm', type: 'button', text: 'Print', style: { marginLeft: '8px' }, onclick: () => printTags([{ id: r.id, pin: r.pin, name: p.name }]) })));
          renderPersonDrawer(r.full);
          await refresh();
          $('#dBody').prepend(reveal);
        }) })),
      el('div', { class: 'inline wrap opts' },
        el('label', { class: 'check' }, gNew, 'Make up a new PIN (if PIN is empty)'),
        admin ? el('label', { class: 'check' }, gSecond, 'Allow a second card') : null,
        admin ? el('label', { class: 'check' }, gReplace, 'Take it from its holder') : null),
    );
    // wrong card handed out, or a lost one: move them to another card number
    if (d.cards.length) {
      const from = el('select', { class: 'w-tag' }, d.cards.map((c) => el('option', { value: c.id, text: `card ${c.id}` })));
      const to = el('input', { placeholder: 'New card number', inputMode: 'numeric', class: 'w-tag' });
      const toPin = el('input', { placeholder: 'PIN on it', inputMode: 'numeric', maxLength: 8, class: 'w-id' });
      cards.append(el('div', { class: 'swaprow' },
        el('span', { class: 'lbl', text: 'Change card number:' }), from, el('span', { class: 'lbl', text: 'to' }), to, toPin,
        el('button', { class: 'btn', type: 'button', text: 'Change', onclick: run(async () => {
          if (!/^\d+$/.test(to.value.trim())) throw new Error('Type the new card number.');
          const known = CARDS.find((x) => x.id === Number(to.value));
          if (!known && !/^\d{4,8}$/.test(toPin.value.trim())) throw new Error('That card is new here. Type the PIN printed on it.');
          if (!confirm(`Move ${p.name} from card ${from.value} to card ${to.value}? Card ${from.value} goes back to blank.`)) return;
          const r = await api(`/api/admin/people/${p.id}/swap`, 'POST', { from: Number(from.value), to: Number(to.value), pin: toPin.value.trim() });
          toast(`${p.name} now has card ${r.id}`);
          renderPersonDrawer(r.full);
          await refresh();
        }) })));
    }

    const mode = el('select', { disabled: !admin }, ['project', 'profile', 'custom'].map((m) => el('option', { value: m, text: { project: 'Project page', profile: 'Profile page', custom: 'Own link' }[m], selected: p.mode === m })));
    const custom = el('input', { value: p.custom_url || '', placeholder: 'Their own link', disabled: !admin });
    const splash = el('input', { value: p.splash_msg || '', maxLength: 60, placeholder: 'Line under the logo', disabled: !admin });
    const routing = el('div', { class: 'grid two' },
      el('label', { class: 'field' }, el('span', { text: 'They picked' }), mode),
      el('label', { class: 'field' }, el('span', { text: 'Splash line' }), splash),
      el('label', { class: 'field span2' }, el('span', { text: 'Own link' }), custom),
      admin ? el('div', { class: 'span2' }, el('button', { class: 'btn', type: 'button', text: 'Save routing', onclick: run(async () => { reopenPerson(p.id, await api(`/api/admin/people/${p.id}`, 'PATCH', { mode: mode.value, custom_url: custom.value, splash_msg: splash.value })); toast('Saved'); }) })) : null,
    );

    const items = el('div', { class: 'secline' }, d.items.length ? d.items.map((i) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: !!i.ts, onchange: run(async (e) => reopenPerson(p.id, await api(`/api/admin/people/${p.id}/items/${i.id}`, 'POST', { on: e.target.checked }))) }),
      i.name, i.ts ? el('span', { class: 'muted small', text: ` ${hm(i.ts)}` }) : null)) : el('span', { class: 'muted', text: 'No handout items. Add them under Handouts.' }));

    const ptsIn = el('input', { type: 'number', placeholder: '+10', class: 'w-id' });
    const ptsWhy = el('input', { placeholder: 'reason' });
    const points = el('div', {},
      el('p', {}, el('b', { text: `${p.points} points` })),
      admin ? el('div', { class: 'inline' }, ptsIn, ptsWhy, el('button', { class: 'btn', type: 'button', text: 'Give', onclick: run(async () => {
        reopenPerson(p.id, await api(`/api/admin/people/${p.id}/points`, 'POST', { delta: ptsIn.value, reason: ptsWhy.value }));
        toast('Points given');
      }) })) : null,
      mini(d.points.map((x) => el('div', {}, el('span', { text: `${x.delta > 0 ? '+' : ''}${x.delta} ${x.reason || ''}` }), el('span', { text: `${x.by.replace(/^(admin|cli):/, '')} · ${fmt(x.ts)}` })))));

    // set their password for them (forgot it at the desk, no email access)
    const pwIn = el('input', { type: 'text', placeholder: 'New password (empty = make one up)', autocomplete: 'off', class: 'grow' });
    const pwRow = el('div', { class: 'inline wrap', style: { marginBottom: '8px' } }, pwIn,
      el('button', { class: 'btn', type: 'button', text: p.claimed ? 'Reset password' : 'Set password', onclick: run(async () => {
        const v = pwIn.value;
        if (v && v.length < 8) throw new Error('Passwords need at least 8 characters.');
        if (!confirm(`Set a new password for ${p.name}? They get logged out everywhere and log in with the new one.`)) return;
        const r = await api(`/api/admin/people/${p.id}/password`, 'POST', { password: v });
        pwIn.value = '';
        renderPersonDrawer(r.full);
        $('#dBody').querySelector('.pwreveal')?.replaceChildren(el('div', { class: 'reveal' },
          r.password ? [`New password for ${p.name}: `, el('b', { text: r.password }), ' · shown once. They log in with ', p.email || `card ${d.cards[0]?.id || ''}`, ' and this.'] : 'Password changed.'));
        toast('Password set');
      }) }));
    const account = el('div', { class: 'inline wrap' },
      p.locked_out ? el('button', { class: 'btn', type: 'button', text: 'Clear login lockout', onclick: run(async () => reopenPerson(p.id, await api(`/api/admin/people/${p.id}/unlock`, 'POST', {}))) }) : null,
      admin && p.claimed ? el('button', { class: 'btn', type: 'button', text: 'Reset account', onclick: run(async () => { if (!confirm(`Clear ${p.name}'s password? They set up again with their card PIN or email.`)) return; reopenPerson(p.id, await api(`/api/admin/people/${p.id}/reset-account`, 'POST', {})); }) }) : null,
      admin ? el('button', { class: 'btn', type: 'button', text: 'Log out', onclick: run(async () => { await api(`/api/admin/people/${p.id}/kick`, 'POST', {}); toast('Logged out'); }) }) : null,
      admin ? el('button', { class: 'btn', type: 'button', text: p.disabled ? 'Enable' : 'Disable', onclick: run(async () => reopenPerson(p.id, await api(`/api/admin/people/${p.id}`, 'PATCH', { disabled: !p.disabled }))) }) : null,
      admin && p.profile ? el('button', { class: 'btn', type: 'button', text: 'Remove profile', onclick: run(async () => { if (!confirm('Remove their profile page?')) return; reopenPerson(p.id, await api(`/api/admin/people/${p.id}`, 'PATCH', { clear_profile: true, mode: 'project' })); }) }) : null,
      admin ? el('button', { class: 'btn danger', type: 'button', text: 'Delete person', onclick: run(async () => {
        if (!confirm(`Delete ${p.name}? Their cards go back to blank. This can't be undone.`)) return;
        await api(`/api/admin/people/${p.id}`, 'DELETE');
        closeDrawer();
        toast('Deleted');
        await refresh();
        run(PAGES[view])();
      }) }) : null,
    );

    showDrawer(`${p.name}`, [el('span', { class: 'muted small', text: `#${p.id} ` }), ...pills], [
      quick,
      sec('Details', el('p', { class: 'small muted', text: `Added ${fmt(p.created_at)} by ${String(p.created_by || '').replace(/^(admin|cli):/, '')}${p.claimed_at ? ` · set up ${fmt(p.claimed_at)}` : ''}` }), details),
      sec('Cards', cards),
      d.team ? sec('Team', el('p', {}, tchip(d.team.id), d.team.place ? ` · ${d.team.place}` : '')) : null,
      sec('Where their card goes', routing),
      sec('Handouts', items),
      sec('Points', points),
      d.help.length ? sec('Help requests', mini(d.help.map((h) => el('div', {}, el('span', { text: `${HELP_KIND[h.kind] || h.kind}: ${h.message || ''}` }), el('span', { text: `${h.status} · ${ago(h.ts)}` }))))) : null,
      sec(`Taps · ${d.stats.total}`, miniBars(d.stats.days)),
      sec('Messages they got', mini(d.notices.map((n) => el('div', {}, el('span', { text: n.title }), el('span', { text: n.read_at ? `read ${ago(n.read_at)}` : 'unread' }))))),
      sec('Account', el('p', { class: 'small muted', text: p.claimed ? `Set up ${fmt(p.claimed_at)}. Logs in with ${p.email || 'their card number'}.` : 'Not set up yet. They can set up at /me, or you can set a password here.' }), pwRow, el('div', { class: 'pwreveal' }), account),
      sec('History', mini(d.log.map((l) => el('div', {}, el('span', { text: l.action }), el('span', { title: l.detail || '', text: `${l.actor.replace(/^(admin|cli|owner):/, '')} · ${fmt(l.ts)}` }))))),
    ]);
  }

  // ---------- card ----------
  const openCard = run(async (id) => {
    const d = await api(`/api/admin/cards/${id}`);
    drawerFor = { kind: 'card', id };
    renderCardDrawer(d);
  });
  async function reopenCard(id) {
    await refresh();
    if (drawerFor?.kind === 'card' && drawerFor.id === id) renderCardDrawer(await api(`/api/admin/cards/${id}`));
    if (view === 'cards') renderCards();
  }
  function renderCardDrawer({ card: c, stats, scans, log, prs }) {
    const admin = isAdmin();
    const adminUrl = el('input', { value: c.admin_url || '', placeholder: 'Send only this card somewhere', disabled: !admin });
    const lock = el('select', { disabled: !admin },
      el('option', { value: 'global', text: 'Follow the global lock', selected: c.lock_mode === 'global' }),
      el('option', { value: 'locked', text: 'Always locked', selected: c.lock_mode === 'locked' }),
      el('option', { value: 'open', text: 'Always open', selected: c.lock_mode === 'open' }));
    const skip = el('input', { type: 'checkbox', checked: !!c.skip_override, disabled: !admin });
    const reveal = el('div');
    const patch = async (data, msg) => { await api(`/api/admin/cards/${c.id}`, 'PATCH', data); toast(msg || 'Saved'); reopenCard(c.id); };

    // give to someone: search people, pick, optional PIN on the card
    const giveSearch = el('input', { placeholder: 'Find a person: name, email, phone', autocomplete: 'off' });
    const giveResults = el('div', { class: 'gresults inline-results', hidden: true });
    const givePin = el('input', { placeholder: 'PIN (empty = keep)', inputMode: 'numeric', maxLength: 8, class: 'w-tag' });
    const gSecond = el('input', { type: 'checkbox' });
    giveSearch.addEventListener('input', () => {
      const q = giveSearch.value.trim().toLowerCase();
      if (!q) { giveResults.hidden = true; return; }
      const rows = PEOPLE.filter((p) => [p.name, p.email, p.phone, p.github].some((v) => v && v.toLowerCase().includes(q))).slice(0, 8);
      giveResults.replaceChildren(...rows.map((p) => el('button', { type: 'button', onclick: run(async () => {
        if (p.cards.length && !gSecond.checked) throw new Error(`${p.name} already has card ${p.cards.join(', ')}. Tick "allow a second card" first.`);
        if (!confirm(`Give card ${c.id} to ${p.name}?${c.person ? ` It's taken from ${c.person.name}.` : ''}`)) return;
        await api(`/api/admin/cards/${c.id}/give`, 'POST', { person_id: p.id, pin: givePin.value.trim(), allow_second: gSecond.checked, replace: !!c.person });
        toast(`Card ${c.id} → ${p.name}`);
        reopenCard(c.id);
      }) }, el('b', { text: p.name }), el('span', { class: 'muted', text: [p.email, p.cards.length ? `has #${p.cards.join(', #')}` : 'no card'].filter(Boolean).join(' · ') }))));
      giveResults.hidden = !rows.length;
    });
    const holder = el('div', {},
      c.person ? el('p', {}, pchip(c.person.id, c.person.name), c.linked_at ? el('span', { class: 'muted small', text: ` since ${fmt(c.linked_at)}` }) : null) : el('p', { class: 'muted', text: 'Nobody yet.' }),
      el('div', { class: 'inline wrap' }, giveSearch, givePin), giveResults,
      admin ? el('label', { class: 'check' }, gSecond, 'Allow a second card for that person') : null,
      c.person ? el('p', { class: 'muted small', text: 'Picking someone moves the card to them.' }) : null);

    // PIN: type one (what's printed, or anything 4-8 digits) or make one up
    const pinIn = el('input', { placeholder: 'New PIN, 4-8 digits', inputMode: 'numeric', maxLength: 8, class: 'w-tag' });
    const setPin = (pin) => run(async () => {
      if (pin !== null && !/^\d{4,8}$/.test(pin)) throw new Error('A PIN is 4 to 8 digits.');
      if (!confirm(`Change card ${c.id}'s PIN? ${c.person ? `${c.person.name}'s` : 'The'} old PIN stops working.`)) return;
      const r = await api(`/api/admin/cards/${c.id}/pin`, 'POST', pin === null ? {} : { pin });
      pinIn.value = '';
      reveal.replaceChildren(el('div', { class: 'reveal' }, `Card ${c.id} PIN is now `, el('b', { text: r.pin }), '.'));
      toast('PIN changed');
    });
    const pinBox = admin ? el('div', { class: 'inline wrap' }, pinIn,
      el('button', { class: 'btn', type: 'button', text: 'Set this PIN', onclick: () => setPin(pinIn.value.trim())() }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Make one up', onclick: setPin(null) })) : el('p', { class: 'muted small', text: 'Only admins change PINs.' });

    showDrawer(`Card ${c.id}`, [el('span', { class: `pill ${c.status === 'active' ? 'active' : 'disabled'}`, text: c.status === 'active' ? 'on' : 'off' }), c.person ? null : el('span', { class: 'pill', text: 'blank' })], [
      sec('Holder', holder),
      sec('PIN', pinBox, reveal),
      sec('Where a tap goes',
        el('div', { class: 'now' }, c.now_url ? el('a', { href: c.now_url, target: '_blank', rel: 'noopener', text: short(c.now_url) }) : el('span', { class: 'muted', text: 'Shows a status page' }), el('span', { class: 'reason', text: reasonText(c.now_reason) })),
        el('label', { class: 'field' }, el('span', { text: 'Organiser override for this card' }), el('div', { class: 'inline' }, adminUrl,
          admin ? el('button', { class: 'btn', type: 'button', text: 'Set', onclick: run(() => patch({ admin_url: adminUrl.value }, 'Override set')) }) : null,
          admin && c.admin_url ? el('button', { class: 'btn ghost', type: 'button', text: 'Clear', onclick: run(() => patch({ admin_url: '' }, 'Override cleared')) }) : null)),
        el('div', { class: 'grid two' }, el('label', { class: 'field' }, el('span', { text: 'Owner can change their link' }), lock), el('label', { class: 'check self-end' }, skip, 'Ignore the all-cards link')),
        admin ? el('div', {}, el('button', { class: 'btn primary', type: 'button', text: 'Save', onclick: run(() => patch({ lock_mode: lock.value, skip_override: skip.checked })) })) : null),
      sec('Card', el('div', { class: 'inline wrap' },
        admin ? el('button', { class: `btn ${c.status === 'active' ? 'danger' : 'accent'}`, type: 'button', text: c.status === 'active' ? 'Switch off' : 'Switch on', onclick: run(() => (c.status === 'active' && !confirm(`Switch off card ${c.id}? Taps show "switched off".`) ? null : patch({ status: c.status === 'active' ? 'disabled' : 'active' }))) }) : null,
        el('a', { class: 'btn', href: cardUrl(c.id), target: '_blank', rel: 'noopener', text: 'Test tap' }),
        el('button', { class: 'btn', type: 'button', text: 'Print', onclick: () => printTags([{ id: c.id, name: c.person?.name }]) }),
        c.locked_out ? el('button', { class: 'btn', type: 'button', text: 'Clear PIN lockout', onclick: run(async () => { await api(`/api/admin/cards/${c.id}/unlock`, 'POST', {}); toast('Cleared'); reopenCard(c.id); }) }) : null,
        admin && c.person ? el('button', { class: 'btn danger', type: 'button', text: 'Take back', onclick: run(async () => {
          if (!confirm(`Take card ${c.id} back from ${c.person.name}? It goes blank.`)) return;
          await api(`/api/admin/cards/${c.id}/unlink`, 'POST', {});
          toast('Card is blank');
          reopenCard(c.id);
        }) }) : null)),
      sec(`Taps · ${stats.total}`, miniBars(stats.days)),
      sec('Site PRs', mini(prs.map((p) => el('div', {}, el('span', {}, el('a', { href: p.url, target: '_blank', rel: 'noopener', text: `#${p.number}` }), ` ${p.title}`), el('span', { text: `@${p.author} · ${p.merged ? 'merged' : p.state}` }))))),
      sec('Recent taps', mini(scans.map((s) => el('div', {}, el('span', { text: fmt(s.ts) }), el('span', { title: s.ua || '', text: [s.device, s.country, reasonText(s.reason)].filter(Boolean).join(' · ') }))))),
      sec('History', mini(log.map((l) => el('div', {}, el('span', { text: l.action }), el('span', { title: l.detail || '', text: `${l.actor.replace(/^(admin|cli|owner):/, '')} · ${fmt(l.ts)}` }))))),
    ]);
  }

  // ================= cards =================
  let cFilter = 'all';
  const cSel = new Set();
  for (const b of $$('#cFilter button')) b.addEventListener('click', () => { cFilter = b.dataset.f; $$('#cFilter button').forEach((x) => x.classList.toggle('on', x === b)); renderCards(); });
  $('#cSearch').addEventListener('input', () => renderCards());
  function visibleCards() {
    const q = $('#cSearch').value.trim().toLowerCase().replace(/^#/, '');
    return CARDS.filter((c) => (cFilter === 'all' || (cFilter === 'held' && c.person) || (cFilter === 'blank' && !c.person) || (cFilter === 'off' && c.status === 'disabled'))
      && (!q || String(c.id) === q || (c.person && c.person.name.toLowerCase().includes(q))));
  }
  function prPill(pr) {
    if (!pr) return el('span', { class: 'muted', text: '—' });
    const label = pr.state === 'merged' ? 'merged' : pr.state === 'open' ? (pr.approved ? 'approved' : 'PR open') : 'closed';
    return el('a', { class: `pill ${pr.state === 'merged' ? 'merged' : pr.state === 'open' ? (pr.approved ? 'blue' : 'open') : ''}`, href: pr.url, target: '_blank', rel: 'noopener', text: label, onclick: (e) => e.stopPropagation() });
  }
  function renderCards() {
    const rows = visibleCards();
    $('#cCount').textContent = `${rows.length} card${rows.length === 1 ? '' : 's'}`;
    $('#cEmpty').hidden = CARDS.length > 0;
    $('#cTable tbody').replaceChildren(...rows.map((c) => el('tr', { class: 'click', onclick: () => openCard(c.id) },
      el('td', { class: 'cb', onclick: (e) => e.stopPropagation() }, el('input', { type: 'checkbox', checked: cSel.has(c.id), onchange: (e) => { e.target.checked ? cSel.add(c.id) : cSel.delete(c.id); renderCBulk(); } })),
      el('td', {}, cchip(c.id)),
      el('td', {}, c.person ? pchip(c.person.id, c.person.name) : el('span', { class: 'muted', text: 'blank' })),
      el('td', {}, el('span', { class: `pill ${c.status === 'active' ? 'active' : 'disabled'}`, text: c.status === 'active' ? 'on' : 'off' }), c.locked_out ? el('span', { class: 'pill bad', text: 'locked out' }) : null),
      el('td', { class: 'dest' }, c.now_url ? [short(c.now_url), el('span', { class: 'reason', text: reasonText(c.now_reason) })] : el('span', { class: 'muted', text: reasonText(c.now_reason) })),
      el('td', {}, prPill(c.pr)),
      el('td', { class: 'r' }, String(c.scans)),
      el('td', { class: 'muted' }, ago(c.last_scan_at)),
    )));
    $('#cAll').checked = rows.length > 0 && rows.every((c) => cSel.has(c.id));
    renderCBulk();
  }
  $('#cAll').addEventListener('change', (e) => { for (const c of visibleCards()) e.target.checked ? cSel.add(c.id) : cSel.delete(c.id); renderCards(); });
  function renderCBulk() {
    $('#cBulk').hidden = !cSel.size || !isAdmin();
    $('#cBulkCount').textContent = `${cSel.size} selected`;
    $('#cBulkValue').hidden = $('#cBulkAction').value !== 'admin_url';
  }
  $('#cBulkAction').addEventListener('change', renderCBulk);
  $('#cBulkClear').addEventListener('click', () => { cSel.clear(); renderCards(); });
  $('#cBulkGo').addEventListener('click', run(async () => {
    let [action, value] = $('#cBulkAction').value.split(':');
    if (value === undefined) value = $('#cBulkValue').value.trim();
    if (action === 'skip_override') value = value === '1';
    if (!confirm(`Apply to ${cSel.size} card${cSel.size === 1 ? '' : 's'}?`)) return;
    const r = await api('/api/admin/cards/bulk', 'POST', { ids: [...cSel], action, value });
    toast(`Updated ${r.count} cards`);
    await refresh();
    renderCards();
  }));

  $('#cardAdd').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    if (!/^\d{4,8}$/.test(f.pin.value.trim())) throw new Error('A PIN is 4 to 8 digits.');
    const r = await api('/api/admin/cards', 'POST', { id: f.id.value.trim(), pin: f.pin.value.trim() });
    toast(`Card ${r.id} added`);
    f.reset();
    f.id.focus();
    await refresh();
    renderCards();
  }));
  $('#cardImport').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const r = await api('/api/admin/cards/import', 'POST', { text: f.text.value, overwrite: f.overwrite.checked });
    const bits = [`${r.added.length} added`, r.updated.length ? `${r.updated.length} PINs updated` : '', r.skipped.length ? `${r.skipped.length} already existed (${r.skipped.slice(0, 8).join(', ')}${r.skipped.length > 8 ? '…' : ''})` : '', r.errors.length ? `${r.errors.length} lines not understood: ${r.errors.slice(0, 3).join(' | ')}` : ''].filter(Boolean);
    toast(bits.join(' · '), r.errors.length > 0);
    if (!r.errors.length) f.reset();
    await refresh();
    renderCards();
  }));

  // ================= teams =================
  const loadTeams = run(async () => {
    const r = await api('/api/admin/teams');
    $('#teamsSummary').textContent = `${r.teams.length} teams · ${r.unassigned} people without a team`;
    $('#teamList').replaceChildren(...(r.teams.length ? r.teams.map((t) => {
      const total = t.points + t.members.reduce((a, m) => a + m.points, 0);
      return el('div', { class: 'team-row click', style: { borderLeftColor: t.color || 'var(--line2)' }, onclick: () => openTeam(t.id) },
        el('div', { class: 'th' }, el('h3', { text: t.name }), t.place ? el('span', { class: 'muted', text: t.place }) : null,
          el('span', { class: 'pill', text: `${t.members.length} people` }), el('span', { class: 'pill blue', text: `${total} pts` }),
          el('span', { class: 'muted small', text: `${t.members.filter((m) => m.checked_in_at).length} here${t.notes ? ` · ${t.notes} notes` : ''}` }),
          el('button', { class: 'btn sm', type: 'button', text: 'Open', style: { marginLeft: 'auto' }, onclick: (e) => { e.stopPropagation(); openTeam(t.id); } })),
        el('div', { class: 'members-list' }, t.members.length ? t.members.map((m) => pchip(m.id, `${m.name}${m.checked_in_at ? '' : ' (away)'}`)) : el('span', { class: 'muted small', text: 'No members yet. Open the team to add people.' })));
    }) : [el('p', { class: 'empty', text: 'No teams yet.' })]));
  });

  // ---------- one team: members, message, notes, points, history, edit ----------
  const openTeam = run(async (id) => {
    const d = await api(`/api/admin/teams/${id}`);
    drawerFor = { kind: 'team', id };
    renderTeamDrawer(d);
  });
  async function reopenTeam(id) {
    await refresh();
    if (drawerFor?.kind === 'team' && drawerFor.id === id) renderTeamDrawer(await api(`/api/admin/teams/${id}`));
    if (view === 'teams') loadTeams();
  }
  function renderTeamDrawer({ team: t, members, notes, history, notices, points }) {
    const admin = isAdmin();
    const total = t.points + members.reduce((a, m) => a + m.points, 0);

    // members: list with remove, add by search
    const addSearch = el('input', { placeholder: 'Add someone: name, email, card number', autocomplete: 'off' });
    const addResults = el('div', { class: 'gresults inline-results', hidden: true });
    addSearch.addEventListener('input', () => {
      const q = addSearch.value.trim().toLowerCase().replace(/^#/, '');
      if (!q) { addResults.hidden = true; return; }
      const rows = PEOPLE.filter((p) => p.team_id !== t.id && (p.cards.includes(Number(q)) || [p.name, p.email, p.github].some((v) => v && v.toLowerCase().includes(q)))).slice(0, 8);
      addResults.replaceChildren(...rows.map((p) => el('button', { type: 'button', onclick: run(async () => {
        if (p.team_id && !confirm(`${p.name} is on ${teamById(p.team_id)?.name || 'another team'}. Move them to ${t.name}?`)) return;
        await api(`/api/admin/teams/${t.id}/members`, 'POST', { ids: [p.id] });
        toast(`${p.name} joined ${t.name}`);
        reopenTeam(t.id);
      }) }, el('b', { text: p.name }), el('span', { class: 'muted', text: p.team_id ? `on ${teamById(p.team_id)?.name || 'a team'}` : 'no team' }))));
      addResults.hidden = !rows.length;
    });
    const memberList = el('div', { class: 'mini' }, members.length ? members.map((m) => el('div', {},
      el('span', {}, pchip(m.id, m.name), ' ', m.cards.map(cchip), m.checked_in_at ? el('span', { class: 'pill here', text: 'here' }) : null),
      el('span', { class: 'inline' }, el('span', { text: `${m.points} pts` }),
        admin ? el('button', { class: 'btn sm ghost', type: 'button', text: 'Remove', onclick: run(async () => {
          if (!confirm(`Take ${m.name} off ${t.name}?`)) return;
          await api(`/api/admin/teams/${t.id}/members/${m.id}`, 'DELETE');
          reopenTeam(t.id);
        }) }) : null))) : el('span', { class: 'muted', text: 'Nobody yet.' }));

    // message just this team
    const mTitle = el('input', { placeholder: 'Title', maxLength: 140 });
    const mBody = el('textarea', { placeholder: 'Message (optional)', rows: 3, maxLength: 3000 });
    const mUrgent = el('input', { type: 'checkbox' }), mEmail = el('input', { type: 'checkbox' });
    const message = el('div', { class: 'grid' }, mTitle, mBody,
      el('div', { class: 'inline wrap' }, el('label', { class: 'check' }, mUrgent, 'Urgent'), el('label', { class: 'check' }, mEmail, 'Also email'),
        el('button', { class: 'btn accent', type: 'button', text: `Send to ${members.length} ${members.length === 1 ? 'person' : 'people'}`, disabled: !members.length, onclick: run(async () => {
          if (!mTitle.value.trim()) throw new Error('Give it a title.');
          const r = await api('/api/admin/notices', 'POST', { title: mTitle.value, body: mBody.value, target_kind: 'team', target: t.id, urgent: mUrgent.checked, email: mEmail.checked });
          toast(`Sent to ${r.count}${r.emailing ? `, emailing ${r.emailing}` : ''}`);
          reopenTeam(t.id);
        }) })),
      mini(notices.map((n) => el('div', {}, el('span', {}, n.urgent ? el('span', { class: 'pill bad', text: 'urgent' }) : null, ' ', n.title), el('span', { text: `read ${n.reads}/${members.length} · ${fmt(n.ts)}` })))));

    // organiser notes
    const noteIn = el('textarea', { placeholder: 'Note for organisers (members don\'t see these)', rows: 2, maxLength: 2000 });
    const noteBox = el('div', { class: 'grid' }, noteIn,
      el('div', {}, el('button', { class: 'btn', type: 'button', text: 'Add note', onclick: run(async () => {
        if (!noteIn.value.trim()) throw new Error('Write the note first.');
        await api(`/api/admin/teams/${t.id}/notes`, 'POST', { text: noteIn.value });
        reopenTeam(t.id);
      }) })),
      el('div', { class: 'notes' }, notes.length ? notes.map((n) => el('div', { class: 'note' },
        el('p', { text: n.text }),
        el('span', { class: 'muted small' }, `${n.by || ''} · ${fmt(n.ts)} `, admin ? el('button', { class: 'linkbtn', type: 'button', text: 'delete', onclick: run(async () => { if (!confirm('Delete this note?')) return; await api(`/api/admin/teams/${t.id}/notes/${n.id}`, 'DELETE'); reopenTeam(t.id); }) }) : null))) : el('p', { class: 'muted small', text: 'No notes yet.' })));

    // points
    const ptsIn = el('input', { type: 'number', placeholder: '+10', class: 'w-id' });
    const ptsWhy = el('input', { placeholder: 'reason' });
    const pointsBox = el('div', {},
      el('p', {}, el('b', { text: `${total} points` }), el('span', { class: 'muted small', text: ` (${t.points} team + ${total - t.points} from members)` })),
      admin ? el('div', { class: 'inline' }, ptsIn, ptsWhy, el('button', { class: 'btn', type: 'button', text: 'Give', onclick: run(async () => {
        await api(`/api/admin/teams/${t.id}/points`, 'POST', { delta: ptsIn.value, reason: ptsWhy.value });
        toast('Points given');
        reopenTeam(t.id);
      }) })) : null,
      mini(points.map((x) => el('div', {}, el('span', { text: `${x.delta > 0 ? '+' : ''}${x.delta} ${x.reason || ''}` }), el('span', { text: fmt(x.ts) })))));

    // edit
    const edit = el('form', { class: 'grid two' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), el('input', { name: 'name', value: t.name, disabled: !admin })),
      el('label', { class: 'field' }, el('span', { text: 'Colour' }), el('input', { name: 'color', type: 'color', value: t.color || '#888888', disabled: !admin })),
      el('label', { class: 'field' }, el('span', { text: 'Table / room' }), el('input', { name: 'place', value: t.place || '', disabled: !admin })),
      el('label', { class: 'field span2' }, el('span', { text: 'Note for members (they see this)' }), el('textarea', { name: 'note', value: t.note || '', rows: 2, disabled: !admin })),
      admin ? el('div', { class: 'span2 inline wrap' },
        el('button', { class: 'btn primary', type: 'submit', text: 'Save' }),
        el('button', { class: 'btn danger', type: 'button', text: 'Delete team', onclick: run(async () => {
          if (!confirm(`Delete ${t.name}? Its ${members.length} members become teamless. Notes and history go too.`)) return;
          await api(`/api/admin/teams/${t.id}`, 'DELETE');
          closeDrawer();
          toast('Team deleted');
          await refresh();
          loadTeams();
        }) })) : null);
    edit.addEventListener('submit', run(async (e) => { e.preventDefault(); await api(`/api/admin/teams/${t.id}`, 'PATCH', Object.fromEntries(new FormData(edit))); toast('Saved'); reopenTeam(t.id); }));

    const sw = el('span', { class: 'swatch-dot', style: { background: t.color || '#888' } });
    showDrawer(t.name, [sw, el('span', { class: 'muted small', text: `${members.length} people${t.place ? ` · ${t.place}` : ''}` })], [
      sec(`Members · ${members.length}`, memberList, admin ? el('div', { style: { marginTop: '8px' } }, addSearch, addResults) : null),
      admin ? sec('Message this team', message) : null,
      sec('Organiser notes', noteBox),
      sec('Points', pointsBox),
      sec('Team details', edit),
      sec('History', mini(history.map((h) => el('div', {},
        el('span', {}, h.action, h.detail && !h.detail.startsWith('{') ? el('span', { class: 'muted small', text: ` · ${h.detail}` }) : null),
        el('span', { text: `${h.actor.replace(/^(admin|cli|owner):/, '')} · ${fmt(h.ts)}` }))))),
    ]);
  }

  $('#clearTeams').addEventListener('click', run(async () => {
    const n = PEOPLE.filter((p) => p.team_id).length;
    if (!n) throw new Error('Nobody is on a team.');
    const typed = prompt(`Take all ${n} people off their teams? The teams, notes and points stay.\n\nType CLEAR TEAMS to confirm.`);
    if (typed === null) return;
    const r = await api('/api/admin/teams/clear-members', 'POST', { confirm: typed.trim() });
    toast(`${r.count} people are teamless now`);
    await refresh();
    loadTeams();
  }));
  $('#teamNew').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    await api('/api/admin/teams', 'POST', Object.fromEntries(new FormData(e.currentTarget)));
    e.currentTarget.reset();
    toast('Team made');
    await refresh();
    loadTeams();
  }));
  $('#teamAuto').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget));
    if (d.count) delete d.size;
    if (!confirm('Split now? This creates teams and assigns people at random.')) return;
    const r = await api('/api/admin/teams/auto', 'POST', d);
    toast(`${r.people} people into ${r.teams} teams`);
    await refresh();
    loadTeams();
  }));

  // ================= notify =================
  let notifyPeople = [];
  function renderNotifyTarget() {
    const k = $('#nKind').value;
    $('#nTargetWrap').hidden = !['team', 'tag'].includes(k);
    $('#nPeopleWrap').hidden = k !== 'people';
    if (k === 'team') { $('#nTargetLabel').textContent = 'Team'; $('#nTargetSel').replaceChildren(...S.teams.map((t) => el('option', { value: t.id, text: `${t.name} (${t.members})` }))); }
    if (k === 'tag') { $('#nTargetLabel').textContent = 'Tag'; $('#nTargetSel').replaceChildren(...allTags().map((t) => el('option', { value: t, text: t }))); }
    $('#nPeople').replaceChildren(...notifyPeople.map((id) => el('span', { class: 'chip' }, personById(id)?.name || `#${id}`, el('button', { type: 'button', text: '✕', onclick: () => { notifyPeople = notifyPeople.filter((x) => x !== id); renderNotifyTarget(); } }))));
    updatePreview();
  }
  function notifyTarget() {
    const k = $('#nKind').value;
    return { target_kind: k, target: k === 'people' ? notifyPeople : ['team', 'tag'].includes(k) ? $('#nTargetSel').value : null };
  }
  let prevT;
  function updatePreview() {
    clearTimeout(prevT);
    prevT = setTimeout(async () => {
      try {
        const r = await api('/api/admin/notices/preview', 'POST', notifyTarget());
        $('#nPreview').textContent = `Reaches ${r.count} ${r.count === 1 ? 'person' : 'people'} (${r.with_email} with email)`;
      } catch { $('#nPreview').textContent = ''; }
    }, 200);
  }
  $('#nKind').addEventListener('change', renderNotifyTarget);
  $('#nTargetSel').addEventListener('change', updatePreview);
  $('#nPeopleSearch').addEventListener('input', () => {
    const q = $('#nPeopleSearch').value.trim().toLowerCase().replace(/^#/, '');
    const box = $('#nPeopleResults');
    if (!q) { box.hidden = true; return; }
    const rows = PEOPLE.filter((p) => !notifyPeople.includes(p.id) && (p.cards.includes(Number(q)) || [p.name, p.email].some((v) => v && v.toLowerCase().includes(q)))).slice(0, 8);
    box.replaceChildren(...rows.map((p) => el('button', { type: 'button', onclick: () => { notifyPeople.push(p.id); $('#nPeopleSearch').value = ''; box.hidden = true; renderNotifyTarget(); } }, el('b', { text: p.name }), el('span', { class: 'muted', text: p.email || '' }))));
    box.hidden = !rows.length;
  });
  $('#nForm').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    $('.err', f).textContent = '';
    const data = { title: f.title.value, body: f.body.value, urgent: f.urgent.checked, email: f.email.checked, ...notifyTarget() };
    let r;
    try { r = await api('/api/admin/notices', 'POST', data); } catch (x) { $('.err', f).textContent = x.message; return; }
    toast(`Sent to ${r.count}${r.emailing ? `, emailing ${r.emailing}` : ''}`);
    f.reset();
    notifyPeople = [];
    renderNotifyTarget();
    loadNotices();
  }));
  const loadNotices = run(async () => {
    renderNotifyTarget();
    const r = await api('/api/admin/notices');
    const label = (n) => ({ all: 'Everyone', checked_in: 'Checked in', not_checked_in: 'Not checked in', team: `Team ${n.target_label}`, tag: `Tag ${n.target}`, people: n.target_label })[n.target_kind];
    $('#nTable tbody').replaceChildren(...(r.notices.length ? r.notices.map((n) => el('tr', {},
      el('td', { class: 'muted' }, fmt(n.ts)),
      el('td', { class: 'wrap' }, n.urgent ? el('span', { class: 'pill bad', text: 'urgent' }) : null, ' ', el('b', { text: n.title }), n.body ? el('div', { class: 'muted small', text: n.body.slice(0, 140) }) : null),
      el('td', {}, label(n)),
      el('td', { class: 'r' }, String(n.audience)),
      el('td', { class: 'r' }, `${n.reads}`),
      el('td', { class: 'r' }, n.emailed ? String(n.emailed) : '—'),
      el('td', { class: 'muted' }, String(n.by || '').replace(/^(admin|cli):/, '')),
      el('td', {}, isAdmin() ? el('button', { class: 'btn sm ghost', type: 'button', text: 'Delete', onclick: run(async () => { if (!confirm('Delete this notification for everyone?')) return; await api(`/api/admin/notices/${n.id}`, 'DELETE'); loadNotices(); }) }) : null),
    )) : [el('tr', {}, el('td', { colSpan: 8, class: 'muted', text: 'Nothing sent yet.' }))]));
  });

  // ================= schedule =================
  const sForm = $('#sForm');
  const loadSchedule = run(async () => {
    const r = await api('/api/admin/schedule');
    if (!sForm.day.value) sForm.day.value = istParts(Date.now()).day;
    const t = Date.now();
    const out = [];
    let last = '';
    for (const x of r.schedule) {
      const d = new Date(x.starts_at).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' });
      if (d !== last) { out.push(el('div', { class: 'sday', text: d })); last = d; }
      const live = x.starts_at <= t && (x.ends_at ? x.ends_at > t : x.starts_at + 3600e3 > t);
      const past = (x.ends_at || x.starts_at + 3600e3) <= t;
      out.push(el('div', { class: `srow${live ? ' live' : ''}${past ? ' past' : ''}` },
        el('span', { class: 'when', text: `${hm(x.starts_at)}${x.ends_at ? ` to ${hm(x.ends_at)}` : ''}` }),
        el('span', {}, el('b', { text: x.title }), x.place ? el('span', { class: 'muted', text: ` · ${x.place}` }) : null, x.note ? el('div', { class: 'muted small', text: x.note }) : null),
        isAdmin() ? el('span', { class: 'inline' },
          el('button', { class: 'btn sm ghost', type: 'button', text: 'Edit', onclick: () => {
            const a = istParts(x.starts_at);
            sForm.id.value = x.id; sForm.day.value = a.day; sForm.start.value = a.time; sForm.end.value = x.ends_at ? istParts(x.ends_at).time : '';
            sForm.title.value = x.title; sForm.place.value = x.place || ''; sForm.note.value = x.note || '';
            $('#sSave').textContent = 'Save'; $('#sCancel').hidden = false; sForm.title.focus();
          } }),
          el('button', { class: 'btn sm danger', type: 'button', text: 'Delete', onclick: run(async () => { if (!confirm(`Remove "${x.title}"?`)) return; await api(`/api/admin/schedule/${x.id}`, 'DELETE'); loadSchedule(); }) })) : el('span')));
    }
    $('#sList').replaceChildren(...(out.length ? out : [el('p', { class: 'empty', text: 'Nothing scheduled.' })]));
  });
  function resetSchedForm() { const day = sForm.day.value; sForm.reset(); sForm.id.value = ''; sForm.day.value = day; $('#sSave').textContent = 'Add'; $('#sCancel').hidden = true; }
  $('#sCancel').addEventListener('click', resetSchedForm);
  sForm.addEventListener('submit', run(async (e) => {
    e.preventDefault();
    $('.err', sForm).textContent = '';
    const starts = istMs(sForm.day.value, sForm.start.value);
    let ends = sForm.end.value ? istMs(sForm.day.value, sForm.end.value) : null;
    if (ends && ends <= starts) ends += 86400e3; // ends after midnight
    const data = { starts_at: starts, ends_at: ends, title: sForm.title.value, place: sForm.place.value, note: sForm.note.value };
    try {
      if (sForm.id.value) await api(`/api/admin/schedule/${sForm.id.value}`, 'PATCH', data);
      else await api('/api/admin/schedule', 'POST', data);
    } catch (x) { $('.err', sForm).textContent = x.message; return; }
    resetSchedForm();
    loadSchedule();
  }));

  // ================= help desk =================
  let hFilter = 'active';
  for (const b of $$('#hFilter button')) b.addEventListener('click', () => { hFilter = b.dataset.f; $$('#hFilter button').forEach((x) => x.classList.toggle('on', x === b)); loadHelp(); });
  $('#helpOpenToggle').addEventListener('change', run(async (e) => { await saveSettings({ help_open: e.target.checked }, e.target.checked ? 'Help desk open' : 'Help desk closed'); }));
  const loadHelp = run(async () => {
    $('#helpOpenToggle').checked = S.settings.help_open === '1';
    const r = await api('/api/admin/help');
    const rows = r.help.filter((h) => hFilter === 'all' || (hFilter === 'done' ? h.status === 'done' : h.status !== 'done'));
    $('#hList').replaceChildren(...(rows.length ? rows.map((h) => {
      const reply = el('input', { value: h.reply || '', placeholder: 'Reply they see (optional)' });
      const set = (status) => run(async () => { await api(`/api/admin/help/${h.id}`, 'PATCH', { status, reply: reply.value }); await refresh(); loadHelp(); });
      return el('div', { class: `hcard ${h.status}` },
        el('div', {},
          el('span', { class: `kind ${h.kind}`, text: HELP_KIND[h.kind] || h.kind }), ' ',
          h.person_id ? pchip(h.person_id, h.name) : null, ' ',
          h.cards ? String(h.cards).split(',').map((c) => cchip(Number(c))) : null,
          h.team_id ? [' ', tchip(h.team_id)] : null,
          el('span', { class: 'muted small', text: ` · ${ago(h.ts)}${h.claimed_by ? ` · ${h.status === 'done' ? 'closed' : 'taken'} by ${h.claimed_by}` : ''}` }),
          h.message ? el('p', { class: 'msg', text: h.message }) : null),
        el('div', { class: 'acts' },
          h.status === 'open' ? el('button', { class: 'btn sm accent', type: 'button', text: 'I\'m on it', onclick: set('claimed') }) : null,
          h.status !== 'done' ? el('button', { class: 'btn sm', type: 'button', text: 'Done', onclick: set('done') }) : el('button', { class: 'btn sm ghost', type: 'button', text: 'Reopen', onclick: set('open') })),
        el('div', { class: 'reply' }, reply, el('button', { class: 'btn sm ghost', type: 'button', text: 'Send reply', onclick: set(h.status) })));
    }) : [el('p', { class: 'empty', text: hFilter === 'done' ? 'Nothing closed yet.' : 'No open requests. Nice.' })]));
  });

  // ================= handouts =================
  function renderHandouts() {
    $('#iList').replaceChildren(...(S.items.length ? S.items.map((i) => el('div', {},
      el('span', { class: 'row-main' }, el('b', { text: i.name }), el('span', { class: 'muted', text: `${i.given} given${i.stock != null ? ` of ${i.stock}` : ''}` }),
        i.stock != null && i.given >= i.stock ? el('span', { class: 'pill bad', text: 'out' }) : null),
      isAdmin() ? el('span', { class: 'inline' },
        el('button', { class: 'btn sm ghost', type: 'button', text: 'Rename', onclick: run(async () => { const n = prompt('New name', i.name); if (!n) return; const st = prompt('Stock (empty for none)', i.stock ?? ''); await api(`/api/admin/items/${i.id}`, 'PATCH', { name: n, stock: st }); await refresh(); renderHandouts(); }) }),
        el('button', { class: 'btn sm danger', type: 'button', text: 'Delete', onclick: run(async () => { if (!confirm(`Delete ${i.name}? Who-got-it records go too.`)) return; await api(`/api/admin/items/${i.id}`, 'DELETE'); await refresh(); renderHandouts(); }) })) : null)) : [el('div', {}, el('span', { class: 'muted', text: 'No items yet.' }))]));
    $('#iQueue').hidden = !S.items.length;
    renderMissing();
  }
  function renderMissing() {
    const item = Number($('#iPick').value);
    if (!item) return;
    const q = $('#iSearch').value.trim().toLowerCase().replace(/^#/, '');
    const rows = PEOPLE.filter((p) => !p.disabled && !p.items.includes(item) && (!$('#iHereOnly').checked || p.checked_in_at)
      && (!q || p.cards.includes(Number(q)) || p.name.toLowerCase().includes(q)));
    $('#iMissing').replaceChildren(el('p', { class: 'muted small', text: `${rows.length} still to get it` }), ...rows.slice(0, 60).map((p) => el('div', {},
      el('span', { class: 'row-main' }, pchip(p.id), p.cards.map(cchip)),
      el('button', { class: 'btn sm accent', type: 'button', text: 'Given', onclick: run(async () => { await api(`/api/admin/people/${p.id}/items/${item}`, 'POST', { on: true }); await refresh(); renderHandouts(); }) }))));
  }
  for (const id of ['#iPick', '#iHereOnly']) $(id).addEventListener('change', renderMissing);
  $('#iSearch').addEventListener('input', renderMissing);
  $('#iForm').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    await api('/api/admin/items', 'POST', Object.fromEntries(new FormData(e.currentTarget)));
    e.currentTarget.reset();
    await refresh();
    renderHandouts();
  }));

  // ================= control =================
  async function saveSettings(patch, msg) {
    await api('/api/admin/settings', 'PATCH', patch);
    toast(msg || 'Saved');
    await refresh();
    if (view === 'control') renderControl();
    if (view === 'setup') renderSetup();
  }
  const ctl = (name) => $(`[data-page=control] [name=${name}]`);
  function renderControl() {
    const s = S.settings;
    $('#ctlOverride').classList.toggle('hot', S.override_active);
    ctl('override_on').checked = s.override_on === '1';
    ctl('override_url').value = s.override_url;
    ctl('override_from').value = toLocal(s.override_from);
    ctl('override_until').value = toLocal(s.override_until);
    $('#overrideState').textContent = S.override_active ? `ON now${s.override_until ? `, ends ${fmt(s.override_until)}` : ''}.` : s.override_on === '1' ? `Switched on but outside its window (${fmt(s.override_from) || 'now'} to ${fmt(s.override_until) || 'forever'}).` : 'Off.';
    ctl('lock_on').checked = s.lock_on === '1';
    ctl('unlock_at').value = toLocal(s.unlock_at);
    $('#lockState').textContent = s.lock_on !== '1' ? 'Owners can change their links now.' : S.global_locked ? (s.unlock_at ? `Locked. Opens ${fmt(s.unlock_at)}.` : 'Locked until you switch it off.') : `The unlock time (${fmt(s.unlock_at)}) has passed, so links are open.`;
    const routes = JSON.parse(s.tag_overrides || '{}');
    $('#tagRoutes').replaceChildren(...(Object.keys(routes).length ? Object.entries(routes).map(([t, u]) => el('div', {},
      el('span', { class: 'row-main' }, el('span', { class: 'tagchip', text: t }), `→ ${short(u)}`, el('span', { class: 'muted small', text: `${PEOPLE.filter((p) => p.tags.includes(t)).length} people` })),
      el('button', { class: 'btn danger sm', type: 'button', text: 'Remove', onclick: run(() => { const r = { ...routes }; delete r[t]; return saveSettings({ tag_overrides: r }, 'Route removed'); }) }))) : [el('div', {}, el('span', { class: 'muted', text: 'No tag routes.' }))]));
    $('#announcement').value = s.announcement;
    $('#wallNote').value = s.wall_note;
    for (const k of ['event_name', 'splash_ms', 'inactive_url']) ctl(k).value = s[k];
    for (const k of ['allow_profiles', 'help_open', 'owner_signup']) ctl(k).checked = s[k] === '1';
  }
  ctl('override_on').addEventListener('change', run(async (e) => {
    const on = e.target.checked;
    const url = ctl('override_url').value.trim();
    if (on && !confirm(`Send every card to ${url || '(no link set)'}?`)) { e.target.checked = false; return; }
    try { await saveSettings({ override_on: on, override_url: url, override_from: fromLocal(ctl('override_from').value), override_until: fromLocal(ctl('override_until').value) }, on ? 'All-cards link on' : 'All-cards link off'); }
    catch (x) { e.target.checked = !on; throw x; }
  }));
  $('#saveOverride').addEventListener('click', run(() => saveSettings({ override_url: ctl('override_url').value, override_from: fromLocal(ctl('override_from').value), override_until: fromLocal(ctl('override_until').value) })));
  ctl('lock_on').addEventListener('change', run(async (e) => {
    try { await saveSettings({ lock_on: e.target.checked }, e.target.checked ? 'Owner links locked' : 'Owner links open'); }
    catch (x) { e.target.checked = !e.target.checked; throw x; }
  }));
  $('#saveUnlock').addEventListener('click', run(() => saveSettings({ unlock_at: fromLocal(ctl('unlock_at').value) })));
  $('#clearUnlock').addEventListener('click', run(() => saveSettings({ unlock_at: '' })));
  $('#tagRouteForm').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const routes = JSON.parse(S.settings.tag_overrides || '{}');
    routes[f.tag.value.trim().toLowerCase()] = f.url.value.trim();
    await saveSettings({ tag_overrides: routes }, 'Route added');
    f.reset();
  }));
  $('#saveMessages').addEventListener('click', run(() => saveSettings({ announcement: $('#announcement').value, wall_note: $('#wallNote').value })));
  $('#saveBehaviour').addEventListener('click', run(() => saveSettings({
    event_name: ctl('event_name').value, splash_ms: ctl('splash_ms').value, inactive_url: ctl('inactive_url').value,
    allow_profiles: ctl('allow_profiles').checked, help_open: ctl('help_open').checked, owner_signup: ctl('owner_signup').checked,
  })));

  // ================= setup =================
  const SETUP_KEYS = ['card_base', 'redirect_repo', 'repo', 'project_template', 'dashboard_url'];
  function renderSetup() {
    for (const k of SETUP_KEYS) $(`[data-page=setup] [name=${k}]`).value = S.settings[k] || '';
    $('#ghState').textContent = !S.github.token ? 'No GITHUB_TOKEN on the server. Add it to /etc/cards.env and restart.'
      : S.github.problem ? `Last sync ${ago(S.github.last_sync)}. ${S.github.problem}` : S.github.last_sync ? `Last synced ${ago(S.github.last_sync)}. All good.` : 'Not synced yet.';
  }
  $('#saveSetup').addEventListener('click', run(() => saveSettings(Object.fromEntries(SETUP_KEYS.map((k) => [k, $(`[data-page=setup] [name=${k}]`).value])))));
  $('#syncNow').addEventListener('click', run(async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const r = await api('/api/admin/github/sync', 'POST', {});
      const bad = r.error || r.errors?.length;
      toast(bad ? `Sync problem: ${r.error || r.errors.join(' ')}` : `Synced: ${r.redirect?.changed ?? 0} redirect files, ${r.sites?.changed ?? 0} new site folders`, !!bad);
      await refresh();
      renderSetup();
    } finally { b.disabled = false; }
  }));

  // ================= start fresh =================
  let resetToken = null, resetTimerI = null;
  function resetCancel() {
    resetToken = null;
    clearInterval(resetTimerI);
    $('#resetStep2').reset();
    $('#resetStep2').hidden = true;
    $('#resetStep1').hidden = false;
  }
  $('#resetCancel').addEventListener('click', resetCancel);
  $('#resetStep1').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const r = await api('/api/admin/reset/prepare', 'POST', { password: f.password.value });
    f.reset();
    resetToken = r.token;
    const c = r.counts;
    $('#resetCounts').textContent = `This erases ${c.people} people, ${c.cards} cards, ${c.teams} teams, ${c.messages} messages, ${c.schedule} schedule items, ${c.help} help requests, ${c.handout_items} handout items, ${c.taps} taps, ${c.uploads} uploads and ${c.log_entries} log entries.`;
    $('#resetPhrase').textContent = r.phrase;
    $('#resetStep2').github.disabled = !r.github;
    $('#resetStep2').github.parentNode.title = r.github ? '' : 'No GitHub token on the server';
    $('#resetStep1').hidden = true;
    $('#resetStep2').hidden = false;
    let left = r.expires_in;
    clearInterval(resetTimerI);
    resetTimerI = setInterval(() => {
      left--;
      $('#resetTimer').textContent = `Expires in ${left}s`;
      if (left <= 0) { resetCancel(); toast('Reset expired. Start again if you meant it.', true); }
    }, 1000);
  }));
  $('#resetStep2').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    $('.err', f).textContent = '';
    if (!f.confirm_backup.checked) { $('.err', f).textContent = 'Tick the backup box first.'; return; }
    if (f.phrase.value.trim() !== $('#resetPhrase').textContent) { $('.err', f).textContent = `Type ${$('#resetPhrase').textContent} exactly.`; return; }
    if (!confirm('Last check. Erase all people, cards and event data now? This can\'t be undone from the dashboard.')) return;
    if (f.github.checked && !confirm('And delete every card page, profile and card folder from both GitHub repos?')) return;
    let r;
    try {
      r = await api('/api/admin/reset', 'POST', { token: resetToken, password: f.password.value, phrase: f.phrase.value, confirm_backup: true, github: f.github.checked, keep_settings: f.keep_settings.checked });
    } catch (x) { $('.err', f).textContent = x.message; return; }
    resetCancel();
    const gh = r.github ? Object.values(r.github).map((x) => x.error ? `${x.repo}: ${x.error}` : `${x.repo}: ${x.removed} files removed`).join(' · ') : 'GitHub left as it was';
    toast('Everything is fresh.');
    $('#resetCounts').textContent = '';
    $('#resetBox').append(el('p', { class: 'reveal', text: `Done. Backup saved on the server as ${r.backup}. ${gh}.` }));
    await refresh();
  }));

  // ================= stats =================
  const bars = (box, rows, label, key) => {
    const max = Math.max(1, ...rows.map((r) => r.n));
    box.replaceChildren(...rows.map((r) => el('div', { title: `${label(r)}: ${r.n}` }, r.n ? el('b', { text: r.n }) : null, el('i', { class: r.n ? '' : 'zero', style: { height: `${Math.max(2, (r.n / max) * 88)}%` } }), el('span', { text: key(r) }))));
  };
  const loadStats = run(async () => {
    const s = await api('/api/admin/stats');
    const t = s.totals;
    $('#totals').replaceChildren(...[
      [t.people, 'people'], [t.here, 'here'], [t.set_up, 'set up'], [t.with_card, 'with a card'], [t.cards, 'cards'], [t.free_cards, 'blank cards'],
      [t.teams, 'teams'], [t.profiles, 'profiles'], [t.sites_merged, 'sites merged'], [t.help_open, 'help open'], [t.taps_30d, 'taps, 30 days'], [t.taps_all, 'taps, all time'],
    ].map(([n, l]) => el('div', {}, el('b', { text: n }), el('span', { text: l }))));
    bars($('#statDays'), s.days, (r) => r.day, (r) => r.day.slice(8));
    bars($('#statHours'), s.hours, (r) => `${r.hour}:00`, (r) => (r.hour % 3 === 0 ? r.hour : ''));
    bars($('#statArrivals'), s.arrivals, (r) => `${r.hour}:00`, (r) => (r.hour % 3 === 0 ? r.hour : ''));
    const list = (rows) => (rows.length ? rows : [el('span', { class: 'muted', text: 'Nothing yet.' })]);
    $('#statTop').replaceChildren(...list(s.top.map((r) => el('div', {}, el('span', {}, cchip(r.card), ' ', r.name), el('span', { text: r.n })))));
    $('#statDevices').replaceChildren(...list(Object.entries(s.devices).sort((a, b) => b[1] - a[1]).map(([k, n]) => el('div', {}, el('span', { text: k }), el('span', { text: n })))));
    $('#statItems').replaceChildren(...list(s.items.map((i) => el('div', {}, el('span', { text: i.name }), el('span', { text: `${i.given}${i.stock != null ? ` / ${i.stock}` : ''}` })))));
  });
  $('#statsReload').addEventListener('click', loadStats);

  // ================= prs =================
  const loadPrs = run(async () => {
    const r = await api('/api/admin/prs');
    $('#prSync').textContent = r.last_sync ? `Synced ${ago(r.last_sync)}` : 'Never synced';
    $('#prEmpty').hidden = r.prs.length > 0;
    $('#prTable tbody').replaceChildren(...r.prs.map((p) => el('tr', {},
      el('td', {}, el('a', { href: p.url, target: '_blank', rel: 'noopener', text: `#${p.number}` })),
      el('td', {}, p.card_id ? cchip(p.card_id) : p.folders.length ? p.folders.map(cchip) : el('span', { class: 'muted', text: '—' }), p.person_id ? [' ', pchip(p.person_id, p.owner_name)] : null),
      el('td', {}, `@${p.author}`),
      el('td', {}, el('span', { class: `pill ${p.merged ? 'merged' : p.state === 'open' ? (p.approved ? 'blue' : 'open') : ''}`, text: p.merged ? 'merged' : p.state === 'open' ? (p.approved ? 'approved' : 'open') : 'closed' })),
      el('td', { class: 'wrap' }, p.title),
      el('td', { class: 'wrap' }, p.flags.map((f) => el('span', { class: 'pill bad', text: f }))),
      el('td', {}, isAdmin() && p.state === 'open' && !p.merged ? el('span', { class: 'inline' },
        el('button', { class: 'btn sm accent', type: 'button', text: 'Merge', disabled: p.flags.some((f) => f.includes('outside') || f.includes('touches')), onclick: run(async () => {
          if (!confirm(`Merge PR #${p.number} into ${S.settings.repo}? It goes live in a minute or two.`)) return;
          await api(`/api/admin/prs/${p.number}/merge`, 'POST', {});
          toast(`Merged #${p.number}`);
          await refresh(); loadPrs();
        }) }),
        el('button', { class: 'btn sm ghost', type: 'button', text: 'Close', onclick: run(async () => {
          if (!confirm(`Close PR #${p.number} without merging?`)) return;
          await api(`/api/admin/prs/${p.number}/close`, 'POST', {});
          toast(`Closed #${p.number}`);
          loadPrs();
        }) })) : null),
    )));
  });
  $('#syncPrs').addEventListener('click', run(async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api('/api/admin/prs/sync', 'POST', {});
      toast(`${r.total} PRs, ${r.changed} updated`);
      await refresh(); loadPrs();
    } finally { $('#syncPrs').disabled = false; }
  }));

  // ================= instructions =================
  const gt = $('#guideText');
  const preview = () => $('#guidePreview').replaceChildren(gt.value.trim() ? window.renderMarkdown(gt.value) : el('p', { class: 'muted', text: 'Preview shows here.' }));
  let guideDirty = false;
  gt.addEventListener('input', () => { guideDirty = true; preview(); });
  function loadGuide() {
    if (!guideDirty) gt.value = S.settings.instructions_md || '';
    gt.readOnly = !isAdmin();
    preview();
    loadFiles();
  }
  $('#saveGuide').addEventListener('click', run(async () => { await saveSettings({ instructions_md: gt.value }, 'Instructions saved'); guideDirty = false; }));
  const loadFiles = run(async () => {
    const r = await api('/api/admin/files');
    $('#fileList').replaceChildren(...(r.files.length ? r.files.map((f) => {
      const snippet = f.mime.startsWith('image/') ? `![${f.name}](/files/${f.id})` : `[${f.name}](/files/${f.id})`;
      return el('div', {},
        el('span', { class: 'row-main' }, el('a', { href: `/files/${f.id}`, target: '_blank', rel: 'noopener', text: f.name }), el('span', { class: 'muted small', text: `${Math.ceil(f.size / 1024)} KB · ${ago(f.created_at)}` })),
        isAdmin() ? el('span', { class: 'inline' },
          el('button', { class: 'btn sm', type: 'button', text: 'Insert', onclick: () => insertAtCursor(snippet) }),
          el('button', { class: 'btn sm danger', type: 'button', text: 'Delete', onclick: run(async () => { if (!confirm(`Delete ${f.name}? Links to it stop working.`)) return; await api(`/api/admin/files/${f.id}`, 'DELETE'); loadFiles(); }) })) : null);
    }) : [el('div', {}, el('span', { class: 'muted', text: 'No files yet.' }))]));
  });
  function insertAtCursor(text) {
    const { selectionStart: a, selectionEnd: b, value } = gt;
    gt.value = value.slice(0, a) + text + value.slice(b);
    gt.focus();
    gt.selectionStart = gt.selectionEnd = a + text.length;
    guideDirty = true;
    preview();
  }
  $('#guideFile').addEventListener('change', run(async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error('Files up to 10 MB.');
    const f = await api('/api/admin/files', 'POST', undefined, { body: file, type: file.type || 'application/octet-stream', name: file.name });
    insertAtCursor(f.mime.startsWith('image/') ? `![${f.name}](${f.url})` : `[${f.name}](${f.url})`);
    toast('Uploaded and inserted. Save to publish.');
    loadFiles();
  }));

  // ================= print =================
  let made = [];
  $('#gen').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const r = await api('/api/admin/cards/generate', 'POST', { count: e.currentTarget.count.value });
    made = r.made;
    $('#genOut').hidden = false;
    $('#genTitle').textContent = `Cards ${made[0].id} to ${made[made.length - 1].id}. Save these PINs now.`;
    $('#genList').replaceChildren(...made.map((m) => el('div', {}, el('span', { text: `#${m.id}` }), el('b', { text: m.pin }))));
    await refresh();
  }));
  window.addEventListener('beforeunload', (e) => { if (made.length) { e.preventDefault(); e.returnValue = ''; } });
  $('#genCsv').addEventListener('click', () => {
    const csv = 'card,pin,url\n' + made.map((m) => `${m.id},${m.pin},${cardUrl(m.id)}`).join('\n');
    const a = el('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `card-pins-${made[0].id}-${made[made.length - 1].id}.csv` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    made = [];
  });
  $('#genPrint').addEventListener('click', () => printTags(made));
  $('#qrForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const ids = CARDS.map((c) => c.id).filter((id) => id >= Number(f.from.value) && id <= Number(f.to.value));
    if (!ids.length) return toast('No cards in that range.', true);
    printTags(ids.map((id) => ({ id, name: CARDS.find((c) => c.id === id)?.person?.name })));
  });
  function printTags(list) {
    const dash = short(S.settings.dashboard_url || location.origin);
    $('#printArea').replaceChildren(...list.map((m) => el('div', { class: 'tag' },
      el('div', { class: 'l' },
        el('span', { class: 'k', text: 'Card' }), el('span', { class: 'n', text: String(m.id) }),
        m.pin ? el('span', { class: 'k', text: 'PIN' }) : null, m.pin ? el('span', { class: 'pin', text: m.pin }) : null,
        m.name ? el('span', { class: 'k', text: m.name }) : null,
        el('span', { class: 'u', text: `${short(cardUrl(m.id))} · set up at ${dash}/me` })),
      qrSvg(cardUrl(m.id)))));
    window.print();
  }

  // ================= log =================
  let logOldest = null;
  async function loadLog(reset) {
    if (reset) { logOldest = null; $('#logList').replaceChildren(); }
    const r = await api(`/api/admin/log${logOldest ? `?before=${logOldest}` : ''}`);
    if (r.log.length) logOldest = r.log[r.log.length - 1].ts;
    $('#logMore').hidden = r.log.length < 100;
    $('#logList').append(...r.log.map((l) => el('div', { class: 'log-row' },
      el('time', { text: fmt(l.ts) }),
      el('div', {}, l.person_id ? [pchip(l.person_id, l.person_name || `#${l.person_id}`), ' '] : null, l.card_id ? [cchip(l.card_id), ' '] : null,
        l.action, ' ', el('span', { class: 'who', text: `by ${l.actor.replace(/^(admin|cli|owner):/, '')}` }),
        l.detail ? el('span', { class: 'det', text: l.detail }) : null))));
    if (!r.log.length && reset) $('#logList').append(el('p', { class: 'empty', text: 'Nothing yet.' }));
  }
  $('#logMore').addEventListener('click', run(() => loadLog(false)));

  // ================= organisers =================
  function showPassword(email, pw) {
    const r = $('#adminReveal');
    r.hidden = false;
    r.replaceChildren(`Password for ${email}: `, el('b', { text: pw }), ' · shown once. They change it under Organisers after logging in.');
  }
  function renderAdmins() {
    $('#adminList').replaceChildren(...S.admins.map((a) => el('div', {},
      el('span', { class: 'row-main' }, el('b', { text: a.email }), a.name ? el('span', { class: 'muted', text: a.name }) : null, el('span', { class: `pill ${a.role === 'admin' ? 'blue' : ''}`, text: a.role }), a.email === S.me.email ? el('span', { class: 'muted small', text: 'you' }) : null),
      isAdmin() && a.email !== S.me.email ? el('span', { class: 'inline' },
        el('select', { class: 'w-role', onchange: run(async (e) => { await api(`/api/admin/admins/${encodeURIComponent(a.email)}`, 'PATCH', { role: e.target.value }); toast('Role changed'); await refresh(); renderAdmins(); }) },
          el('option', { text: 'admin', selected: a.role === 'admin' }), el('option', { text: 'desk', selected: a.role === 'desk' })),
        el('button', { class: 'btn sm', type: 'button', text: 'New password', onclick: run(async () => {
          if (!confirm(`Make a new password for ${a.email}? Their old one stops working.`)) return;
          showPassword(a.email, (await api(`/api/admin/admins/${encodeURIComponent(a.email)}/reset`, 'POST', {})).password);
        }) }),
        el('button', { class: 'btn danger sm', type: 'button', text: 'Remove', onclick: run(async () => {
          if (!confirm(`Remove ${a.email}?`)) return;
          await api(`/api/admin/admins/${encodeURIComponent(a.email)}`, 'DELETE');
          await refresh(); renderAdmins();
        }) })) : null)));
  }
  $('#addAdmin').addEventListener('submit', run(async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const r = await api('/api/admin/admins', 'POST', { email: f.email.value, name: f.name.value, role: f.role.value });
    showPassword(r.email, r.password);
    f.reset();
    await refresh(); renderAdmins();
  }));
  $('#myPw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    $('.err', f).textContent = '';
    try {
      await api('/api/admin/password', 'POST', { current: f.current.value, password: f.password.value });
      toast('Password changed. Log in again.');
      showLogin();
    } catch (x) { $('.err', f).textContent = x.message; }
  });

  // ================= boot =================
  async function boot() {
    try { await api('/api/admin/me'); } catch { return showLogin(); }
    $('#login').hidden = true;
    $('#app').hidden = false;
    await refresh();
    let v = 'desk';
    try { v = localStorage.getItem('hq-view') || v; } catch {}
    go(v);
  }
  boot();
  setInterval(() => { if (!$('#app').hidden && document.visibilityState === 'visible') refreshView().catch(() => {}); }, 15000);
})();
