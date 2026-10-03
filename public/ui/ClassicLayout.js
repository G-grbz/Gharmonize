export function setupTitlePositioning() {
  const title = document.querySelector('.title-section');
  const container = document.querySelector('.container');
  const firstCard = document.querySelector('.card-grid .card:first-child');
  const logo = document.querySelector('.app-logo-large');
  if (!title || !container || !firstCard) return;

  let frame = null;
  let disposed = false;
  let attempts = 0;
  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(place);
  };
  const place = () => {
    frame = null;
    // Read before writing: resetting top/left before offsetHeight forced a
    // synchronous layout on every scroll, particularly costly in software mode.
    const cont = container.getBoundingClientRect();
    const card = firstCard.getBoundingClientRect();
    const height = title.offsetHeight;
    if (!(cont.width > 0 && card.width > 0 && height > 0)) {
      if (++attempts < 10) schedule();
      return;
    }
    attempts = 0;
    const left = `${card.left - cont.left}px`;
    const top = `${card.top - cont.top - height - 8}px`;
    if (title.style.left !== left) title.style.left = left;
    if (title.style.top !== top) title.style.top = top;
    if (title.style.visibility !== 'visible') title.style.visibility = 'visible';
  };

  // Scroll moves both rectangles together; their relative position is unchanged.
  window.addEventListener('resize', schedule, { passive: true });
  const observer = new ResizeObserver(schedule);
  for (const element of [container, firstCard, title]) observer.observe(element);
  schedule();
  Promise.resolve(document.fonts?.ready).then(schedule, schedule);
  if (logo?.decode) logo.decode().then(schedule, schedule);

  return () => {
    disposed = true;
    if (frame !== null) cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener('resize', schedule);
  };
}
