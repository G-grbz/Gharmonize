// Runs before first paint: apply the saved theme so there is no flash.
(() => {
  try {
    const saved = localStorage.getItem('theme')
    const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    const theme = saved === 'light' || saved === 'dark' ? saved : (prefersLight ? 'light' : 'dark')
    document.documentElement.setAttribute('data-theme', theme)
    const accent = localStorage.getItem('ghp.accent')
    if (['blue', 'violet', 'ocean', 'moss', 'amber', 'rose', 'indigo', 'coral', 'fuchsia', 'silver'].includes(accent)) document.documentElement.setAttribute('data-accent', accent)
    // Player colour remembered for this base theme; see theme.js PALETTES.
    const palettes = { oled: ['dark', '#000000'], deepsea: ['dark', '#061d25'], forest: ['dark', '#0a1a11'], plum: ['dark', '#1a1028'], mist: ['light', '#eef2f7'], sky: ['light', '#edf6f9'], mint: ['light', '#eef6f1'], lilac: ['light', '#f4f2fb'] }
    // One-time move of the earlier single setting to its base theme.
    const legacy = localStorage.getItem('ghp.palette')
    if (legacy !== null) {
      if (palettes[legacy] && !localStorage.getItem('ghp.palette.' + palettes[legacy][0])) localStorage.setItem('ghp.palette.' + palettes[legacy][0], legacy)
      localStorage.removeItem('ghp.palette')
    }
    const palette = localStorage.getItem('ghp.palette.' + theme)
    const active = palettes[palette] && palettes[palette][0] === theme ? palette : null
    if (active) document.documentElement.setAttribute('data-palette', active)
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', active ? palettes[active][1] : (theme === 'light' ? '#f7f7fb' : '#0d1117'))
  } catch {}
})()
