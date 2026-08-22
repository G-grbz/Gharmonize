(() => {
  try {
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const theme = saved || (prefersDark ? 'dark' : 'light');
    const docEl = document.documentElement;
    docEl.setAttribute('data-theme', theme);
    docEl.classList.add('no-theme-transition');
    const meta = document.createElement('meta');
    meta.name = 'color-scheme';
    meta.content = 'light dark';
    document.head.appendChild(meta);
    requestAnimationFrame(() => docEl.classList.remove('no-theme-transition'));
  } catch {}
})();
