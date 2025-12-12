function normalizeMarketCode(code) {
  if (!code) return null;
  const s = String(code).trim();
  if (!s) return null;
  const up = s.toUpperCase();
  return /^[A-Z]{2}$/.test(up) ? up : null;
}

export function resolveMarket(preferred, opts = {}) {
  const { allowEnv = true } = opts || {};

  const p = normalizeMarketCode(preferred);
  if (p) return p;

  if (allowEnv) {
    const envRaw = (process.env.SPOTIFY_MARKET || "").trim();
    const env = normalizeMarketCode(envRaw);
    if (env) return env;
  }

  return undefined;
}

export function getFallbackMarkets(opts = {}) {
  const { includeEnv = true, includeDefault = true } = opts || {};
  const seen = new Set();
  const out = [];
  const pushUnique = (code) => {
    const n = normalizeMarketCode(code);
    if (!n) return;
    if (seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };

  if (includeEnv) {
    const raw = process.env.SPOTIFY_FALLBACK_MARKETS || "";
    if (raw) {
      for (const part of raw.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        pushUnique(trimmed);
      }
    }
  }

  if (includeDefault) {
    const DEFAULTS = ["US", "GB", "DE", "FR"];
    for (const d of DEFAULTS) {
      pushUnique(d);
    }
  }

  return out.length ? out : ["US", "GB", "DE", "FR"];
}

export async function withMarketFallback(
  callFn,
  preferred,
  opts = {}
) {
  if (typeof callFn !== "function") {
    throw new Error("withMarketFallback: callFn must be a function");
  }

  const {
    includeUndefined = true,
    maxAttempts = null,
    debug = process.env.SPOTIFY_DEBUG_MARKET === "1"
  } = opts || {};

  const tried = new Set();
  const seq = [];
  const resolved = resolveMarket(preferred);
  if (resolved) seq.push(resolved);

  if (includeUndefined) {
    seq.push(undefined);
  }

  const fallbacks = getFallbackMarkets();
  for (const f of fallbacks) {
    if (!seq.includes(f)) {
      seq.push(f);
    }
  }

  if (debug) {
    console.log("[spotify-market] sequence:", seq);
  }

  let attempt = 0;

  for (const market of seq) {
    if (tried.has(market)) continue;
    tried.add(market);

    if (maxAttempts != null && Number.isFinite(maxAttempts)) {
      if (attempt >= maxAttempts) {
        if (debug) {
          console.log(
            "[spotify-market] maxAttempts reached, stopping at attempt",
            attempt
          );
        }
        break;
      }
    }
    attempt++;

    try {
      const res = await callFn(market);
      if (debug) {
        console.log(
          "[spotify-market] try",
          market === undefined ? "<default>" : market,
          "→",
          res ? "HIT" : "MISS"
        );
      }
      if (res) return res;
    } catch (e) {
      if (debug) {
        console.warn(
          "[spotify-market] error for market",
          market === undefined ? "<default>" : market,
          "-",
          e?.message || e
        );
      }
      continue;
    }
  }

  if (debug) {
    console.log("[spotify-market] all markets exhausted, no match found");
  }
  return null;
}
