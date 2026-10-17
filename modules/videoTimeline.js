// A container can express gaps/overlaps and different stream starts. Raw
// elementary tracks cannot: reconstructing them relies on frame/sample counts.
// Materialize that timeline during video re-encoding, not by independently
// resetting each stream's PTS (which would erase intentional A/V offsets).
export function safeFrameRate(value) {
  const token = String(value ?? '').trim();
  if (!/^\d{1,9}(?:\.\d{1,6}|\/\d{1,9})?$/.test(token)) return null;
  const [numerator, denominator = '1'] = token.split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate >= 0.1 && rate <= 240 ? token : null;
}

export function videoTimelineFilters({ isVideo, videoTranscoded, sourceFps, targetFps, audioCodec }) {
  if (!isVideo) return { video: null, audio: null };
  const rate = safeFrameRate(targetFps) || safeFrameRate(sourceFps);
  const video = videoTranscoded && rate ? `fps=fps=${rate}:start_time=0` : null;
  // async=1 fills/trims timestamp discontinuities without changing pitch or
  // stretching audio. Ignore sub-10ms timestamp rounding jitter.
  // Pad delayed tracks to the same zero origin only when video is normalized
  // too. Video-copy conversions retain their original stream start offsets.
  const audio = String(audioCodec || 'copy').toLowerCase() !== 'copy'
    ? `aresample=async=1:min_hard_comp=0.01${video ? ':first_pts=0' : ''}`
    : null;
  return { video, audio };
}
