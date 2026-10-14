fetch('/api/public').then((r) => r.json()).then((p) => {
  if (p.announcement) {
    const a = document.getElementById('announce');
    a.textContent = p.announcement;
    a.hidden = false;
  }
  if (p.instructions_md && p.instructions_md.trim()) {
    document.getElementById('guideBody').append(window.renderMarkdown(p.instructions_md));
    document.getElementById('guide').hidden = false;
  }
}).catch(() => {});
