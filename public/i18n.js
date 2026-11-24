(function () {
  const DEFAULT_LANG = 'en';
  const SUPPORTED = ['en', 'tr', 'de', 'fr', 'es'];
  const COOKIE_NAME = 'lang';
  const COOKIE_DOMAIN = '.grbzhome.com';

  function setLangCookie(lang) {
    try {
      const maxAge = 60 * 60 * 24 * 365;
      document.cookie =
        `${COOKIE_NAME}=${encodeURIComponent(lang)}; ` +
        `Max-Age=${maxAge}; Path=/; Domain=${COOKIE_DOMAIN}; SameSite=Lax`;
    } catch {}
  }

  function getLangCookie() {
    try {
      const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]*)`));
      return m ? decodeURIComponent(m[1]) : '';
    } catch {
      return '';
    }
  }
  const ATTR_MAP = [
    ['data-i18n', 'textContent'],
    ['data-i18n-title', 'title'],
    ['data-i18n-ph', 'placeholder'],
    ['data-i18n-aria', 'aria-label'],
  ];

  async function fetchDict(lang) {
    const res = await fetch(`/lang/${lang}.json`);
    if (!res.ok) throw new Error('dict fetch failed');
    return res.json();
  }

  // One retry: a request cut off by a quick reload or a network blip must
  // not cost the user their language.
  async function loadDict(lang) {
    try {
      return await fetchDict(lang);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return fetchDict(lang);
    }
  }

  // The chosen language is saved only when the user picks one (or a
  // ?lang= link does), never because a dictionary failed to load: a page
  // left while loading (Ctrl+Shift+R pressed again) used to save "en".
  function rememberLang(lang) {
    try { localStorage.setItem('lang', lang); } catch {}
    setLangCookie(lang);
  }

  function detectLang() {
  try {
    const u = new URL(window.location.href);
    const q = (u.searchParams.get('lang') || '').toLowerCase();
    if (SUPPORTED.includes(q)) {
      rememberLang(q);
      return q;
    }
  } catch {}

  const fromCookie = (getLangCookie() || '').toLowerCase();
  if (SUPPORTED.includes(fromCookie)) return fromCookie;

  const fromLs = (localStorage.getItem('lang') || '').toLowerCase();
  if (SUPPORTED.includes(fromLs)) return fromLs;

  const nav = (navigator.language || navigator.userLanguage || '').toLowerCase().slice(0,2);
  if (SUPPORTED.includes(nav)) return nav;

  const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase().slice(0,2);
  if (SUPPORTED.includes(htmlLang)) return htmlLang;

  return DEFAULT_LANG;
}

  function applyDict(dict, root = document) {
    ATTR_MAP.forEach(([attr, target]) => {
      root.querySelectorAll(`[${attr}]`).forEach(el => {
        const key = el.getAttribute(attr);
        const val = dict[key];
        if (val != null) {
          if (target === 'textContent') el.textContent = val;
          else if (target === 'ariaLabel') el.setAttribute('aria-label', val);
          else el.setAttribute(target, val);
        }
      });
    });
  }

  function createT(dict, fallback) {
    return function t(key, vars = {}) {
      let str = (dict?.[key] ?? fallback?.[key] ?? key);
      for (const [k, v] of Object.entries(vars)) {
        str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
      return str;
    };
  }

  async function init() {
    const html = document.documentElement;
    const prevVis = html.style.visibility;
    html.style.visibility = 'hidden';

    const safety = setTimeout(() => {
      if (html.style.visibility === 'hidden')
        html.style.visibility = prevVis || '';
    }, 1500);

    try {
      const wanted = detectLang();
      let lang = wanted;
      let fallback = {};
      let dict = null;

      // Both dictionaries at once; English fills keys a language lacks.
      const [en, own] = await Promise.allSettled([
        loadDict(DEFAULT_LANG),
        wanted === DEFAULT_LANG ? null : loadDict(wanted),
      ]);
      if (en.status === 'fulfilled' && en.value) fallback = en.value;
      if (wanted === DEFAULT_LANG) dict = fallback;
      else if (own.status === 'fulfilled' && own.value) dict = own.value;

      // Not loaded: English for this page view only; the saved choice stays.
      if (!dict) {
        lang = DEFAULT_LANG;
        dict = fallback;
      }

      applyDict(dict);
      html.lang = lang;
      // Keep the shared cookie in step with a choice that loaded fine.
      if (lang === wanted) setLangCookie(lang);

      const api = {
        lang,
        dict,
        t: createT(dict, fallback),
        apply(root) { applyDict(api.dict, root || document); },
        async setLang(next) {
          const safeNext = SUPPORTED.includes(next) ? next : DEFAULT_LANG;
          let newDict = null;
          try {
            newDict = safeNext === DEFAULT_LANG ? fallback : await loadDict(safeNext);
          } catch {
            // Keep the current language rather than saving one not chosen.
            return;
          }
          rememberLang(safeNext);
          applyDict(newDict);
          api.lang = safeNext;
          api.dict = newDict;
          api.t = createT(newDict, fallback);
          html.lang = safeNext;
          document.dispatchEvent(new CustomEvent('i18n:applied', { detail: { lang: safeNext } }));
        }
      };
      window.i18n = api;
      const langSelect = document.getElementById('langSelect');
      if (langSelect) {
        langSelect.value = api.lang;

        langSelect.addEventListener('change', (e) => {
          const nextLang = e.target.value;
          api.setLang(nextLang);
        });
      }
      return api;
    } finally {
      clearTimeout(safety);
      try { clearTimeout(window.__gharmonizeI18nSafety); } catch {}
      html.removeAttribute('data-i18n-pending');
      html.style.visibility = prevVis || '';
    }
  }

  window.i18nInit = init;
})();
