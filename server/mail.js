// Mail over Gmail SMTP. Without SMTP creds (local dev) mails are printed to the console instead.
const nodemailer = require('nodemailer');

let transport = null;
const ready = () => !!(process.env.SMTP_USER && process.env.SMTP_PASS);
function getTransport() {
  if (transport || !ready()) return transport;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: true,
    maxConnections: 2,
  });
  return transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FROM = () => ({ name: process.env.MAIL_FROM_NAME || 'Boba Bash Cards', address: process.env.SMTP_USER });

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

module.exports = { sendCode, sendNotice, ready };
