(() => {
  try {
    document.documentElement.setAttribute('data-i18n-pending', '');
    window.__gharmonizeI18nSafety = setTimeout(() => {
      document.documentElement.removeAttribute('data-i18n-pending');
    }, 2500);
    const saved = localStorage.getItem('theme');
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
  } catch {}
})();
