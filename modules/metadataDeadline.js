// Optional enrichment must not indefinitely delay an already downloaded track.
// A shared parent signal keeps retries and provider fallbacks inside one budget.
export function metadataDeadline(signal, timeoutMs = 8000) {
  const milliseconds = Math.max(1, Math.min(30000, Math.round(Number(timeoutMs) || 8000)));
  const deadline = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
