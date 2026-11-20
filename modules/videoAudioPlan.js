// Audio handling of a video conversion when the user did NOT turn on
// "Change Audio Codec": the source audio is kept. Without volume/loudnorm/
// tempo it is copied as is; with them it is re-encoded with the SAME codec,
// channels and sample rate (filters cannot run on copied audio). Sources that
// cannot be re-encoded without loss of channels or format (TrueHD, DTS-HD,
// 7.1 E-AC3…) are copied and the filters are skipped; the probe tells the UI
// beforehand so the user can pick a codec instead.

// Audio codecs each container accepts as a copy (kept conservative: older
// FFmpeg builds reject some pairs newer ones allow).
const CONTAINER_AUDIO = {
  mp4: new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'dts']),
  mov: new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_s16be', 'pcm_s24be']),
  webm: new Set(['opus', 'vorbis']),
  mkv: null // anything
};

// Codec → FFmpeg encoder that re-creates it, with the most channels the
// encoder keeps (beyond that it silently downmixes).
const KEEP_ENCODERS = {
  aac: { encoder: 'aac', maxChannels: 8 },
  mp3: { encoder: 'libmp3lame', maxChannels: 2 },
  ac3: { encoder: 'ac3', maxChannels: 6 },
  eac3: { encoder: 'eac3', maxChannels: 6 },
  opus: { encoder: 'libopus', maxChannels: 8 },
  vorbis: { encoder: 'libvorbis', maxChannels: 8 },
  flac: { encoder: 'flac', maxChannels: 8, lossless: true },
  alac: { encoder: 'alac', maxChannels: 8, lossless: true },
  dts: { encoder: 'dca', maxChannels: 6, experimental: true }
};

// Highest bitrate (bit/s) an encoder takes; the source rate is clamped to it.
const MAX_BITRATE = { aac: 1536000, libmp3lame: 320000, ac3: 640000, eac3: 6144000, libopus: 512000, libvorbis: 1000000 };

// Container fallback when a source cannot be stored there at all.
const FALLBACK_CODEC = { mp4: 'aac', mov: 'aac', webm: 'libopus', mkv: 'aac' };

function normCodec(codec) {
  const c = String(codec || '').trim().toLowerCase();
  if (c === 'dca') return 'dts';
  return c;
}

function isPcm(codec) {
  return /^pcm_/.test(codec);
}

// DTS-HD MA / HRA / DTS:X carry more than the lossy core FFmpeg can write.
function isHdDts(source) {
  return normCodec(source?.codec) === 'dts' && /hd|ma|x|express/i.test(String(source?.profile || ''));
}

function sourceBitrate(source) {
  const direct = Number(source?.bit_rate ?? source?.bitRate);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const tag = Number(source?.tags?.BPS ?? source?.tags?.['BPS-eng']);
  return Number.isFinite(tag) && tag > 0 ? tag : 0;
}

// Bitrate for a re-encode in the source's codec: the source rate (clamped to
// what the encoder takes), else a sensible rate for its channel count.
function keepBitrate(encoder, source) {
  if (encoder === 'flac' || encoder === 'alac' || encoder === 'dca' || isPcm(encoder)) return null;
  const channels = Math.max(1, Number(source?.channels) || 2);
  const fallback = {
    aac: Math.min(512000, Math.max(128000, 64000 * channels)),
    libmp3lame: 320000,
    ac3: channels > 2 ? 640000 : 192000,
    eac3: channels > 2 ? 768000 : 224000,
    libopus: Math.min(512000, Math.max(96000, 48000 * channels)),
    libvorbis: Math.min(1000000, Math.max(128000, 64000 * channels))
  }[encoder] || 192000;
  const wanted = sourceBitrate(source) || fallback;
  const max = MAX_BITRATE[encoder] || wanted;
  return `${Math.round(Math.min(wanted, max) / 1000)}k`;
}

// Output rate of a re-encode: the source rate (loudnorm would otherwise leave
// 192 kHz behind); Opus only encodes 48 kHz.
function outputSampleRate(encoder, source) {
  if (encoder === 'libopus') return 48000;
  const rate = Number(source?.sample_rate ?? source?.sampleRate);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function canCopyAudioInto(format, codec) {
  const allowed = CONTAINER_AUDIO[String(format || '').toLowerCase()];
  if (allowed === undefined) return false;
  if (allowed === null) return true;
  return allowed.has(normCodec(codec));
}

// Whether volume/loudnorm/tempo can be applied while keeping this source's
// codec and channels. reason: why not (for the UI message).
export function keepWithFiltersInfo(source) {
  const codec = normCodec(source?.codec);
  if (!codec) return { ok: false, reason: 'unknown' };
  if (isPcm(codec)) return { ok: true, encoder: codec };
  if (isHdDts(source)) return { ok: false, reason: 'hd' };
  const keep = KEEP_ENCODERS[codec];
  if (!keep) return { ok: false, reason: 'codec' };
  const channels = Number(source?.channels) || 0;
  if (channels > keep.maxChannels) return { ok: false, reason: 'channels', maxChannels: keep.maxChannels };
  return { ok: true, encoder: keep.encoder, experimental: !!keep.experimental };
}

// Per-stream facts for the UI (returned with the probe): can it be copied into
// each container, can filters run while keeping it.
export function describeAudioStreamForUi(source) {
  const keep = keepWithFiltersInfo(source);
  return {
    copyInto: Object.fromEntries(Object.keys(CONTAINER_AUDIO).map((f) => [f, canCopyAudioInto(f, source?.codec)])),
    keepWithFilters: keep.ok,
    keepBlockedReason: keep.ok ? null : keep.reason,
    keepMaxChannels: keep.maxChannels || null
  };
}

// The plan when "Change Audio Codec" is off.
// Returns { mode: 'copy' | 'keep' | 'fallback', encoder, bitrate,
//           applyFilters, warning } (warning: null or a short code).
export function planKeptVideoAudio({ format, source, filtersRequested }) {
  const fmt = String(format || '').toLowerCase();
  const fallbackEncoder = FALLBACK_CODEC[fmt] || 'aac';
  const fallback = (warning) => ({
    mode: 'fallback',
    encoder: fallbackEncoder,
    bitrate: keepBitrate(fallbackEncoder, source),
    sampleRate: outputSampleRate(fallbackEncoder, source),
    applyFilters: !!filtersRequested,
    warning
  });

  // Source unknown (probe failed): copying is the safe "keep" choice; with
  // filters there is nothing to keep it in, so the container default is used.
  if (!source?.codec) {
    if (!filtersRequested) return { mode: 'copy', encoder: 'copy', bitrate: null, applyFilters: false, warning: null };
    return fallback('source-unknown');
  }

  const fits = canCopyAudioInto(fmt, source.codec);
  if (!filtersRequested) {
    if (fits) return { mode: 'copy', encoder: 'copy', bitrate: null, applyFilters: false, warning: null };
    return fallback('container');
  }

  const keep = keepWithFiltersInfo(source);
  if (keep.ok && fits) {
    return {
      mode: 'keep',
      encoder: keep.encoder,
      bitrate: keepBitrate(keep.encoder, source),
      sampleRate: outputSampleRate(keep.encoder, source),
      experimental: !!keep.experimental,
      applyFilters: true,
      warning: null
    };
  }
  if (!fits) return fallback('container');
  // Cannot re-create this audio: keep it untouched, skip the filters.
  return { mode: 'copy', encoder: 'copy', bitrate: null, applyFilters: false, warning: `filters-skipped:${keep.reason}` };
}

// Plans every selected audio stream. Volume/loudnorm run on all audio
// outputs and a copied stream cannot be filtered, so when one selected
// stream cannot be re-created in its own codec, all of them stay untouched.
export function planKeptVideoAudioStreams({ format, sources = [], filtersRequested = false }) {
  const list = sources.length ? sources : [null];
  const first = list.map((source) => planKeptVideoAudio({ format, source, filtersRequested }));
  const blocked = filtersRequested && first.some((plan) => plan.mode === 'copy');
  const streams = blocked
    ? list.map((source) => planKeptVideoAudio({ format, source, filtersRequested: false }))
    : first;
  const warnings = [...new Set([...first, ...streams].map((plan) => plan.warning).filter(Boolean))];
  return {
    streams,
    applyFilters: !!filtersRequested && !blocked && streams.every((plan) => plan.applyFilters),
    allCopy: streams.every((plan) => plan.mode === 'copy'),
    warnings
  };
}
