// Tiny markdown → DOM. Builds nodes directly (no innerHTML), so organiser text can't inject anything.
// Supports: # headings, paragraphs, - / 1. lists, > quotes, ``` code, **bold**, *italic*, `code`, [links](url), ![images](url), ---
(function () {
  const safeUrl = (u) => (/^(https?:\/\/|\/files\/|\/|#|mailto:)/i.test(u) ? u : null);

  function inline(text, parent) {
    const re = /(!\[([^\]]*)\]\(([^)\s]+)\))|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(`([^`]+)`)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.append(text.slice(last, m.index));
      if (m[1]) {
        const u = safeUrl(m[3]);
        if (u) { const img = document.createElement('img'); img.src = u; img.alt = m[2]; img.loading = 'lazy'; parent.append(img); } else parent.append(m[0]);
      } else if (m[4]) {
        const u = safeUrl(m[6]);
        if (u) {
          const a = document.createElement('a');
          a.href = u; a.textContent = m[5];
          if (/^https?:/i.test(u) || u.startsWith('/files/')) { a.target = '_blank'; a.rel = 'noopener'; }
          parent.append(a);
        } else parent.append(m[5]);
      } else if (m[7]) { const b = document.createElement('strong'); b.textContent = m[8]; parent.append(b); }
      else if (m[9]) { const i = document.createElement('em'); i.textContent = m[10]; parent.append(i); }
      else if (m[11]) { const c = document.createElement('code'); c.textContent = m[12]; parent.append(c); }
      last = re.lastIndex;
    }
    if (last < text.length) parent.append(text.slice(last));
  }

  function render(src) {
    const root = document.createDocumentFragment();
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (line.startsWith('```')) {
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
        i++;
        code.textContent = buf.join('\n');
        pre.append(code);
        root.append(pre);
        continue;
      }
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { const el = document.createElement(`h${Math.min(h[1].length + 1, 5)}`); inline(h[2], el); root.append(el); i++; continue; }
      if (/^-{3,}\s*$/.test(line)) { root.append(document.createElement('hr')); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
          const li = document.createElement('li');
          const t = lines[i].replace(/^\s*([-*]|\d+\.)\s+/, '');
          const task = /^\[( |x)\]\s+/i.exec(t);
          if (task) {
            const box = document.createElement('input');
            box.type = 'checkbox'; box.disabled = true; box.checked = task[1].toLowerCase() === 'x';
            li.append(box, ' ');
            inline(t.slice(task[0].length), li);
          } else inline(t, li);
          list.append(li);
          i++;
        }
        root.append(list);
        continue;
      }
      if (line.startsWith('>')) {
        const q = document.createElement('blockquote');
        const buf = [];
        while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
        inline(buf.join(' '), q);
        root.append(q);
        continue;
      }
      const p = document.createElement('p');
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s+|-{3,}\s*$)/.test(lines[i])) buf.push(lines[i++]);
      buf.forEach((b, k) => { if (k) p.append(document.createElement('br')); inline(b, p); });
      root.append(p);
    }
    return root;
  }

  window.renderMarkdown = render;
})();
