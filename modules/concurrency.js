export function parseConcurrency(value, fallback = 4) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(16, Math.max(1, Math.round(n)));
}

export function resolveSpotifyConcurrency(...inputs) {
  const explicit = inputs.find((value) => value != null && value !== "");
  return parseConcurrency(explicit, 4);
}
