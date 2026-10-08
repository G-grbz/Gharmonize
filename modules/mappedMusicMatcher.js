import { cleanCatalogTitleForSearch } from './catalogSearchText.js';
import { normalizeMusicDisplayText } from './musicDisplayText.js';

const CATALOG_MUSIC_PROVIDERS = new Set([
  'spotify',
  'apple',
  'apple_music',
  'deezer',
  'tidal',
  'text'
]);

export const MAPPED_MUSIC_YT_SEARCH_RESULTS = Math.max(
  3,
  Math.min(10, Number(process.env.MAPPED_MUSIC_YT_SEARCH_RESULTS || 5))
);
export const MAPPED_MUSIC_YT_MIN_MATCH_SCORE = Math.max(
  1,
  Number(process.env.MAPPED_MUSIC_YT_MIN_MATCH_SCORE || 4)
);
export const MAPPED_MUSIC_YT_STRICT_MATCH_SCORE = Math.max(
  MAPPED_MUSIC_YT_MIN_MATCH_SCORE,
  Number(process.env.MAPPED_MUSIC_YT_STRICT_MATCH_SCORE || 6)
);
export const MAPPED_MUSIC_YT_SEARCH_RETRIES = Math.max(
  0,
  Math.min(1, Number(process.env.MAPPED_MUSIC_YT_SEARCH_RETRIES ?? 1))
);
export const MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS = Math.max(
  0,
  Number(process.env.MAPPED_MUSIC_YT_SEARCH_RETRY_BACKOFF_MS || 600)
);
export const MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS = Math.max(
  1000,
  Number(process.env.MAPPED_MUSIC_YT_RATE_LIMIT_BACKOFF_MS || 15000)
);
export const MAPPED_MUSIC_YT_SEARCH_STAGGER_MS = Math.max(
  0,
  Number(process.env.MAPPED_MUSIC_YT_SEARCH_STAGGER_MS || 220)
);
export const MAPPED_MUSIC_YT_DURATION_BASE_TOLERANCE_SEC = Math.max(
  10,
  Number(process.env.MAPPED_MUSIC_YT_DURATION_BASE_TOLERANCE_SEC || 45)
);
export const MAPPED_MUSIC_YT_DURATION_RATIO_TOLERANCE = Math.max(
  0.05,
  Math.min(0.50, Number(process.env.MAPPED_MUSIC_YT_DURATION_RATIO_TOLERANCE || 0.22))
);
export const MAPPED_MUSIC_YT_DURATION_MIN_RATIO = Math.max(
  0.1,
  Math.min(1, Number(process.env.MAPPED_MUSIC_YT_DURATION_MIN_RATIO || 0.65))
);
export const MAPPED_MUSIC_YT_DURATION_MAX_RATIO = Math.max(
  1,
  Number(process.env.MAPPED_MUSIC_YT_DURATION_MAX_RATIO || 1.45)
);
export const MAPPED_MUSIC_YT_TIGHT_DURATION_BASE_SEC = Math.max(
  3,
  Number(process.env.MAPPED_MUSIC_YT_TIGHT_DURATION_BASE_SEC || 12)
);
export const MAPPED_MUSIC_YT_TIGHT_DURATION_RATIO = Math.max(
  0.01,
  Math.min(0.20, Number(process.env.MAPPED_MUSIC_YT_TIGHT_DURATION_RATIO || 0.06))
);

function norm(value = '') {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    // YouTube metadata is frequently ASCII-normalized even when the source
    // title uses Turkish dotless-i. Treat those spellings as equivalent for
    // identity matching, not as a reason to reject an otherwise exact track.
    .replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    // Common Turkish catalogue spelling variant. This remains deliberately
    // narrow: we only canonicalize a known orthographic alias instead of
    // relaxing the matcher enough to accept a different song.
    .replace(/\bcafe\b/g, 'kafe')
    .replace(/\s+/g, ' ')
    .trim();
}



function searchQueryNorm(value = '') {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactNorm(value = '') {
  return norm(value).replace(/\s+/g, '');
}

function identityTitleKey(value) {
  return norm(value).replace(/\bakustik\b/g, 'acoustic').replace(/\s+/g, '');
}

function artistNames(value = '') {
  return String(value || '').split(/\s*(?:[,;]|&|\s+(?:feat\.?|ft\.?|featuring|with|and|x)\s+)\s*/i)
    .map(norm).filter(Boolean);
}

function hasName(text, name) {
  return !!name && ` ${norm(text)} `.includes(` ${name} `);
}

function isArtistCredit(text, artist) {
  const names = artistNames(artist);
  if (norm(text) === norm(artist)) return !!names.length;
  // Credit separators may differ, but no unrelated words may be discarded.
  let remaining = ` ${norm(text)} `;
  let matchedName = false;
  for (const name of names) {
    if (remaining.includes(` ${name} `)) matchedName = true;
    remaining = remaining.replace(` ${name} `, ' ');
  }
  return matchedName && !remaining.replace(/\b(?:feat|ft|featuring|with|and|x)\b/g, '').trim();
}

function titleWithoutCredits(value, artist) {
  let title = cleanCatalogTitleForSearch(normalizeMusicDisplayText(value));
  const parts = title.split(/\s+[-–—|]\s+/);
  if (parts.length > 1 && isArtistCredit(parts[0], artist)) title = parts.slice(1).join(' - ');
  return title.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (label, round, square) =>
    isArtistCredit(round ?? square, artist) ? ' ' : label).replace(/\s+/g, ' ').trim();
}

function musicalVersions(value) {
  const text = norm(value);
  const versions = ['live', 'acoustic', 'akustik', 'remix', 'cover', 'instrumental', 'karaoke', 'slowed', 'reverb', 'sped up', 'radio edit', 'extended'];
  const found = versions.filter((version) => ` ${text} `.includes(` ${version} `));
  // Keep numbered versions such as 2.0 distinct; do not treat project Vol.1
  // or promotional 4K labels as a musical version number.
  for (const version of String(value).matchAll(/\b\d+\.\d+\b/g)) found.push(version[0]);
  return [...new Set(found.map((version) => version === 'akustik' ? 'acoustic' : version))].sort().join('|');
}

function titleIdentity(value, artist) {
  const title = titleWithoutCredits(value, artist);
  const project = /\b(?:orijinal\s+proje(?:\s+muzikleri)?|original\s+project(?:\s+music)?|original\s+(?:motion\s+picture\s+)?soundtrack)\b/;
  const withoutProjectLabels = title.replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (label, round, square) => {
    const text = round ?? square;
    return project.test(norm(text)) && musicalVersions(text) === '' ? ' ' : label;
  }).replace(/\s+/g, ' ').trim();
  // Keep the project marker for finding the full trailing context, e.g.
  // "Song - Project name - Original Project Music Vol.1".
  const parts = title.split(/\s+[-–—|]\s+/);
  const context = parts.slice(1).join(' ');
  // Movement/part identifiers are musical identity, even if a soundtrack
  // annotation follows them. Do not collapse two different movements.
  const musicalQualifier = /\b(?:movement|mvt|part|pt|act|scene|no|op|allegro|adagio|andante|largo|presto|moderato)\b/;
  // Explicit release/project annotations may include a project name before
  // the label. Only ignore that context when no musical version is lost.
  const core = parts.length > 1 && parts.slice(1).some((part) => project.test(norm(part)))
    && musicalVersions(context) === '' && !musicalQualifier.test(norm(context)) ? parts[0] : withoutProjectLabels;
  return { title: core, versions: musicalVersions(title) };
}

export function scoreCatalogMusicCandidateText(
  artist = '',
  title = '',
  candidateTitle = '',
  candidateChannel = ''
) {
  const aNorm = norm(artist);
  const tNorm = norm(title);
  const et = norm(candidateTitle);
  const ch = norm(candidateChannel);
  const tCompact = compactNorm(title);
  const etCompact = compactNorm(candidateTitle);
  const sourceIdentity = titleIdentity(title, artist);
  const candidateIdentity = titleIdentity(candidateTitle, artist);
  if (sourceIdentity.versions !== candidateIdentity.versions) return 0;

  let score = 0;
  let titleMatched = false;

  if (tNorm) {
    if (et === tNorm) {
      score += 6;
      titleMatched = true;
    } else {
      const directContains = et.includes(tNorm) || tNorm.includes(et);
      const compactContains = tCompact.length >= 5 && (
        etCompact.includes(tCompact) || tCompact.includes(etCompact)
      );

      if (directContains || compactContains) {
        score += 4;
        titleMatched = true;

        // Prefer concise titles that stay close to the source metadata. This
        // makes harmless spacing variants such as "yerdeyimki" / "yerdeyim ki"
        // equivalent without rewarding noisy TV/series/compilation titles.
        const minLen = Math.min(tCompact.length, etCompact.length);
        const maxLen = Math.max(tCompact.length, etCompact.length);
        const closeness = maxLen > 0 ? minLen / maxLen : 0;
        if (closeness >= 0.75) score += 3;
        else if (closeness >= 0.55) score += 2;
        else if (closeness >= 0.40) score += 1;

        if (tCompact && etCompact.includes(tCompact)) {
          const expansion = etCompact.length / tCompact.length;
          if (expansion >= 2.5) score -= 2;
          else if (expansion >= 1.9) score -= 1;
        }
      }
    }
  }

  let artistMatched = false;
  if (aNorm) {
    if (ch === aNorm) {
      score += 4;
      artistMatched = true;
    } else if (ch.includes(aNorm)) {
      score += 3;
      artistMatched = true;
    } else if (et.includes(aNorm)) {
      score += 2;
      artistMatched = true;
    }
  }

  // Artist lists are credits, not one literal channel name. A channel owned by
  // the lead artist, or a title crediting all collaborators, establishes identity.
  if (!artistMatched) {
    const names = artistNames(artist);
    if (names.length > 1 && hasName(candidateChannel, names[0])) {
      score += 3;
      artistMatched = true;
    } else if (names.length > 1 && names.every((name) => hasName(candidateTitle, name))) {
      score += 2;
      artistMatched = true;
    }
  }

  // Clean identity comparisons require artist evidence. Do not boost a generic
  // short title on an unrelated artist's video merely because its duration fits.
  if (artistMatched && identityTitleKey(sourceIdentity.title)
    && identityTitleKey(sourceIdentity.title) === identityTitleKey(candidateIdentity.title)) {
    score = Math.max(score, 8);
    titleMatched = true;
  }

  if (!titleMatched) return 0;
  if (artistMatched) score += 2;
  if (/\btopic\b/.test(ch)) score += 1;

  return Math.max(0, score);
}

function uniqueQueries(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const query = String(value || '').replace(/\s+/g, ' ').trim();
    const key = searchQueryNorm(query);
    if (!query || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(query);
  }
  return out;
}

export function isCatalogMusicProvider(provider = '') {
  return CATALOG_MUSIC_PROVIDERS.has(String(provider || '').trim().toLowerCase());
}

export function buildCatalogMusicSearchQueries(artist = '', title = '') {
  const rawTitle = normalizeMusicDisplayText(title).trim();
  const kafeTitle = rawTitle.replace(/\bcafe\b/gi, 'kafe');
  const cafeTitle = rawTitle.replace(/\bkafe\b/gi, 'cafe');
  const coreTitle = titleIdentity(rawTitle, artist).title;
  const primaryArtist = String(artist || '').split(/\s*(?:[,;]|&|\s+(?:feat\.?|ft\.?|featuring|with|and|x)\s+)\s*/i)[0].trim();
  return uniqueQueries([
    `${artist || ''} ${rawTitle}`,
    rawTitle,
    `${artist || ''} ${kafeTitle}`,
    kafeTitle,
    `${artist || ''} ${cafeTitle}`,
    cafeTitle,
    ...(coreTitle !== rawTitle ? [`${artist || ''} ${coreTitle}`, coreTitle] : []),
    ...(primaryArtist && primaryArtist !== String(artist || '').trim() ? [`${primaryArtist} ${coreTitle}`] : [])
  ]);
}

export function isMappedMusicDurationCompatible(sourceMs, candidateSeconds, {
  baseToleranceSec = MAPPED_MUSIC_YT_DURATION_BASE_TOLERANCE_SEC,
  ratioTolerance = MAPPED_MUSIC_YT_DURATION_RATIO_TOLERANCE,
  minRatio = MAPPED_MUSIC_YT_DURATION_MIN_RATIO,
  maxRatio = MAPPED_MUSIC_YT_DURATION_MAX_RATIO
} = {}) {
  const sourceSeconds = Number(sourceMs) / 1000;
  const candidate = Number(candidateSeconds);
  if (!(sourceSeconds > 0) || !(candidate > 0)) return true;

  const ratio = candidate / sourceSeconds;
  if (ratio < minRatio || ratio > maxRatio) return false;

  const tolerance = Math.max(
    Number(baseToleranceSec) || 0,
    sourceSeconds * (Number(ratioTolerance) || 0)
  );
  return Math.abs(candidate - sourceSeconds) <= tolerance;
}

export function isMappedMusicDurationTight(sourceMs, candidateSeconds) {
  const sourceSeconds = Number(sourceMs) / 1000;
  const candidate = Number(candidateSeconds);
  if (!(sourceSeconds > 0) || !(candidate > 0)) return false;

  const tolerance = Math.max(
    MAPPED_MUSIC_YT_TIGHT_DURATION_BASE_SEC,
    sourceSeconds * MAPPED_MUSIC_YT_TIGHT_DURATION_RATIO
  );
  return Math.abs(candidate - sourceSeconds) <= tolerance;
}

export function isCatalogTextDurationMatch(score, sourceMs, candidateSeconds) {
  const value = Number(score) || 0;
  if (value >= MAPPED_MUSIC_YT_STRICT_MATCH_SCORE) return true;
  if (value < MAPPED_MUSIC_YT_MIN_MATCH_SCORE) return false;
  return isMappedMusicDurationTight(sourceMs, candidateSeconds);
}
