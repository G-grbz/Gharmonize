// Shows the "Gharmonize Player" entry points only while the player is enabled
// (and reachable from this network). One tiny status request per page load.
(() => {
  const refresh = () => {
    fetch('/api/player/status', { credentials: 'same-origin', cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((status) => {
        const enabled = Boolean(status && status.enabled)
        document.querySelectorAll('[data-player-link]').forEach((el) => {
          el.style.display = enabled ? '' : 'none'
        })
      })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh)
  else refresh()
  window.addEventListener('gharmonize:player-toggle', refresh)
})()
