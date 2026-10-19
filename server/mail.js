// Mail over SMTP (Zoho, Gmail, anything). Settings saved in Cards HQ → Setup win over /etc/cards.env.
// Without SMTP creds (local dev) mails are printed to the console instead.
const nodemailer = require('nodemailer');

let db = null, transport = null, key = '';
const use = (d) => { db = d; transport = null; };
function config() {
  let saved = null;
  try { saved = db && JSON.parse(db.prepare("SELECT v FROM secrets WHERE k = 'smtp'").get()?.v || 'null'); } catch {}
  if (saved?.user && saved?.pass) return { ...saved, source: 'dashboard' };
  const e = process.env;
  return { host: e.SMTP_HOST || 'smtp.gmail.com', port: Number(e.SMTP_PORT || 465), user: e.SMTP_USER || '', pass: e.SMTP_PASS || '', from_name: e.MAIL_FROM_NAME || '', source: e.SMTP_USER && e.SMTP_PASS ? 'env' : 'none' };
}
const ready = () => config().source !== 'none';
function getTransport() {
  const c = config();
  if (c.source === 'none') return null;
  const k = [c.host, c.port, c.user, c.pass].join('|');
  if (transport && k === key) return transport;
  if (transport) transport.close();
  key = k;
  const port = Number(c.port) || 465;
  transport = nodemailer.createTransport({
    host: c.host, port, secure: port === 465,
    auth: { user: c.user, pass: c.pass },
    pool: true, maxConnections: 2,
    connectionTimeout: 15000, greetingTimeout: 15000,
  });
  return transport;
}
// what the admin page may see: everything except the password
function status() {
  const c = config();
  return { ready: c.source !== 'none', source: c.source, host: c.host, port: Number(c.port) || 465, user: c.user, from_name: c.from_name || 'Boba Bash Cards', has_pass: !!c.pass };
}
function save(next) {
  const old = config();
  const keepPass = !next.pass && old.source === 'dashboard' ? old.pass : next.pass;
  db.prepare("INSERT INTO secrets (k, v) VALUES ('smtp', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(JSON.stringify({ host: next.host, port: next.port, user: next.user, pass: keepPass, from_name: next.from_name }));
}
const clear = () => db.prepare("DELETE FROM secrets WHERE k = 'smtp'").run();
async function verify() {
  const t = getTransport();
  if (!t) throw new Error('No SMTP settings yet.');
  await t.verify();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FROM = () => { const c = config(); return { name: c.from_name || 'Boba Bash Cards', address: c.user }; };

async function send(to, subject, text, html) {
  const t = getTransport();
  if (!t) {
    console.log(`[mail:dev] to ${to}: ${subject}\n${text}\n`);
    return;
  }
  await t.sendMail({ from: FROM(), to, subject, text, html });
}

function sendCode(to, code, what) {
  const text = `${code}\n\nThat's your ${what} code. It works for 10 minutes.\nDidn't ask for it? Ignore this mail, nothing happens.\n\nBoba Bash Greater Noida`;
  const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#3d2b18">
<p style="font-size:30px;font-weight:700;letter-spacing:6px;margin:0 0 12px">${code}</p>
<p style="margin:0">That's your ${esc(what)} code. It works for 10 minutes.</p>
<p style="margin:0;color:#6b5842">Didn't ask for it? Ignore this mail, nothing happens.</p>
<p style="margin:16px 0 0;color:#6b5842">Boba Bash Greater Noida</p></div>`;
  return send(to, `${code} is your Boba Bash code`, text, html);
}

function sendNotice(to, title, body, link) {
  const text = `${title}\n\n${body || ''}\n\n${link ? `Open your dashboard: ${link}\n\n` : ''}Boba Bash Greater Noida`;
  const html = `<div style="font:15px/1.55 -apple-system,Segoe UI,sans-serif;color:#3d2b18">
<p style="font-size:19px;font-weight:700;margin:0 0 10px">${esc(title)}</p>
${body ? `<p style="margin:0 0 14px;white-space:pre-line">${esc(body)}</p>` : ''}
${link ? `<p style="margin:0 0 14px"><a href="${esc(link)}" style="color:#3d2b18">Open your dashboard</a></p>` : ''}
<p style="margin:0;color:#6b5842">Boba Bash Greater Noida</p></div>`;
  return send(to, title, text, html);
}

module.exports = { use, sendCode, sendNotice, send, ready, status, save, clear, verify };
