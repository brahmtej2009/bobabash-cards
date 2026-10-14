// Owner profile pages: validated input in, static HTML out. Published to the redirect repo at /p/<n>/
// so a profile keeps working even if the dashboard is gone.
const { fail, cleanText, cleanUrl, cleanGithub } = require('./util');

const THEMES = {
  boba: { bg: '#fbf6e8', card: '#fffdf7', ink: '#3d2b18', soft: '#6b5842', line: '#3d2b18', accent: '#f2c14e' },
  night: { bg: '#15171c', card: '#1d2027', ink: '#f2efe8', soft: '#a8acb5', line: '#33363f', accent: '#ff8fb1' },
  mint: { bg: '#e9f7ef', card: '#ffffff', ink: '#173b2a', soft: '#4f6e5f', line: '#173b2a', accent: '#7ed6a5' },
  grape: { bg: '#f1ecff', card: '#ffffff', ink: '#2d1f52', soft: '#62568a', line: '#2d1f52', accent: '#c4a5ff' },
  ocean: { bg: '#e6f3fa', card: '#ffffff', ink: '#163448', soft: '#4b6a80', line: '#163448', accent: '#8fcbe6' },
  paper: { bg: '#ffffff', card: '#ffffff', ink: '#111111', soft: '#666666', line: '#111111', accent: '#ec3750' },
};
const SOCIALS = [
  ['github', 'GitHub', (v) => `https://github.com/${v}`],
  ['instagram', 'Instagram', (v) => `https://instagram.com/${v}`],
  ['linkedin', 'LinkedIn', (v) => `https://www.linkedin.com/in/${v}`],
  ['x', 'X', (v) => `https://x.com/${v}`],
  ['youtube', 'YouTube', (v) => `https://youtube.com/@${v}`],
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const handle = (v) => {
  const s = String(v ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/[^/]+\/(in\/|@)?/i, '').replace(/[/?#].*$/, '');
  if (!s) return '';
  if (!/^[\w.-]{1,60}$/.test(s)) fail(400, 'A social handle looks off. Just the username, like riya_codes.');
  return s;
};

function cleanProfile(p, card) {
  p = p && typeof p === 'object' ? p : {};
  const links = Array.isArray(p.links) ? p.links.slice(0, 12) : [];
  const out = {
    name: cleanText(p.name, 60) || (card.name || card.owner_name) || '',
    tagline: cleanText(p.tagline, 80),
    bio: String(p.bio ?? '').replace(/\r/g, '').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').trim().slice(0, 600),
    theme: THEMES[p.theme] ? p.theme : 'boba',
    accent: /^#[0-9a-f]{6}$/i.test(p.accent || '') ? p.accent.toLowerCase() : '',
    avatar: /^[a-f0-9]{24}$/.test(p.avatar || '') ? p.avatar : '',
    show_project: p.show_project !== false,
    wall: p.wall !== false, // first name on the live wall
    contact: { email: !!p.contact?.email, phone: !!p.contact?.phone }, // what "Save my contact" includes
    links: links.map((l) => ({ label: cleanText(l?.label, 40), url: cleanUrl(l?.url) })).filter((l) => l.url).map((l) => ({ ...l, label: l.label || l.url.replace(/^https?:\/\//, '').replace(/\/$/, '') })),
    socials: {},
  };
  for (const [k] of SOCIALS) {
    const v = k === 'github' ? cleanGithub(p.socials?.[k]) : handle(p.socials?.[k]);
    if (v) out.socials[k] = v;
  }
  return out;
}

const hasContact = (p, card) => !!((p.contact?.email && card?.email) || (p.contact?.phone && card?.phone));

// vCard 3.0 for "Save my contact": only what the owner switched on
function vcard(id, p, card, url) {
  const v = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const name = p.name || (card.name || card.owner_name) || `Card ${id}`;
  const parts = name.trim().split(/\s+/);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${v(name)}`, `N:${v(parts.length > 1 ? parts.slice(-1)[0] : '')};${v(parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0])};;;`];
  if (p.tagline) lines.push(`TITLE:${v(p.tagline)}`);
  if (p.contact?.email && card.email) lines.push(`EMAIL;TYPE=INTERNET:${v(card.email)}`);
  if (p.contact?.phone && card.phone) lines.push(`TEL;TYPE=CELL:${v(card.phone)}`);
  if (url) lines.push(`URL:${v(url)}`);
  for (const [k, , link] of SOCIALS) if (p.socials?.[k]) lines.push(`X-SOCIALPROFILE;TYPE=${k}:${v(link(p.socials[k]))}`);
  lines.push(`NOTE:${v(`Met at Boba Bash Greater Noida, card ${id}`)}`, 'END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

// avatarSrc: where the page finds the avatar (relative file in the repo, or a dashboard URL for previews)
// contactHref: link to the vCard, only when the owner shares something
function renderProfile(id, p, { projectUrl, avatarSrc, contactHref } = {}) {
  const t = THEMES[p.theme] || THEMES.boba;
  const accent = p.accent || t.accent;
  const links = [...(p.show_project && projectUrl ? [{ label: 'My Boba Bash project', url: projectUrl }] : []), ...p.links];
  const socials = SOCIALS.filter(([k]) => p.socials?.[k]).map(([k, label, url]) => `<a href="${esc(url(p.socials[k]))}" rel="noopener">${label}</a>`);
  const initials = esc((p.name || `#${id}`).split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name || `Card ${id}`)}</title>
<meta name="description" content="${esc(p.tagline || 'Boba Bash Greater Noida')}">
<style>
*{box-sizing:border-box}html,body{margin:0}
body{min-height:100vh;background:${t.bg};color:${t.ink};font:15px/1.55 ui-rounded,"SF Pro Rounded",-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(460px,100% - 32px);margin:0 auto;padding:44px 0 36px;text-align:center}
.av{width:104px;height:104px;margin:0 auto 14px;border-radius:50%;border:3px solid ${t.line};background:${accent};display:grid;place-items:center;overflow:hidden;font-weight:800;font-size:34px;color:${t.ink}}
.av img{width:100%;height:100%;object-fit:cover}
h1{margin:0;font-size:26px;line-height:1.15;letter-spacing:-.01em}
.tag{margin:4px 0 0;color:${t.soft};font-size:14px}
.bio{margin:14px auto 0;max-width:38ch;white-space:pre-line;font-size:14.5px}
.links{display:grid;gap:10px;margin:24px 0 0}
.links a{display:block;padding:13px 16px;border:2px solid ${t.line};border-radius:14px;background:${t.card};color:${t.ink};font-weight:600;text-decoration:none;box-shadow:0 3px 0 ${t.line};transition:transform .12s}
.links a:hover{transform:translateY(-2px);background:${accent}}
.links a:first-child{background:${accent}}
.save{display:inline-block;margin-top:16px;padding:9px 18px;border:2px solid ${t.line};border-radius:999px;background:${accent};color:${t.ink};font-weight:700;font-size:14px;text-decoration:none;box-shadow:0 3px 0 ${t.line}}
.soc{display:flex;flex-wrap:wrap;justify-content:center;gap:6px 14px;margin:22px 0 0;font-size:13.5px}
.soc a{color:${t.soft}}
footer{margin-top:34px;font-size:11px;letter-spacing:.08em;color:${t.soft};text-transform:uppercase}
</style>
</head>
<body>
<main>
<div class="av">${p.avatar && avatarSrc ? `<img src="${esc(avatarSrc)}" alt="">` : initials}</div>
<h1>${esc(p.name || `Card ${id}`)}</h1>
${p.tagline ? `<p class="tag">${esc(p.tagline)}</p>` : ''}
${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
${contactHref ? `<a class="save" href="${esc(contactHref)}" download="contact.vcf">Save my contact</a>` : ''}
${links.length ? `<nav class="links">${links.map((l) => `<a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`).join('')}</nav>` : ''}
${socials.length ? `<div class="soc">${socials.join('')}</div>` : ''}
<footer>Boba Bash Greater Noida · card ${id}</footer>
</main>
</body>
</html>
`;
}

module.exports = { THEMES, SOCIALS: SOCIALS.map(([k, label]) => ({ key: k, label })), cleanProfile, renderProfile, vcard, hasContact };
