// Runs before first paint: apply the saved theme so there is no flash.
(() => {
  try {
    const saved = localStorage.getItem('theme')
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    const theme = saved === 'light' || saved === 'dark' ? saved : (prefersLight ? 'light' : 'dark')
    document.documentElement.setAttribute('data-theme', theme)
    const accent = localStorage.getItem('ghp.accent')
    if (['blue', 'violet', 'ocean', 'moss', 'amber', 'rose'].includes(accent)) document.documentElement.setAttribute('data-accent', accent)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f7f7fb' : '#0d1117')
  } catch {}
})()
