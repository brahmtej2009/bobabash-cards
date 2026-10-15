// A dashboard left open across a deploy keeps running old code. Every minute, compare this page's build
// (the ?v= on this script's own link) with the server's, and offer a reload when they differ.
(() => {
  const mine = new URL(document.currentScript.src).searchParams.get('v');
  if (!mine) return;
  let shown = false;
  async function check() {
    if (shown || document.visibilityState !== 'visible') return;
    try {
      const { build } = await (await fetch('/api/version', { cache: 'no-store' })).json();
      if (build && build !== mine) {
        if (location.pathname.startsWith('/wall')) return location.reload(); // nobody's at the projector to click
        shown = true;
        const bar = document.createElement('div');
        bar.setAttribute('role', 'alert');
        bar.style.cssText = 'position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:99;display:flex;gap:10px;align-items:center;padding:9px 14px;border-radius:10px;background:#16171a;color:#fff;font:500 13px Inter,system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25)';
        bar.textContent = 'A new version is out. ';
        const b = document.createElement('button');
        b.textContent = 'Reload';
        b.style.cssText = 'border:0;border-radius:7px;padding:5px 12px;background:#ec3750;color:#fff;font:600 12.5px Inter,system-ui,sans-serif;cursor:pointer';
        b.onclick = () => location.reload();
        bar.append(b);
        document.body.append(bar);
      }
    } catch {}
  }
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', check);
})();
