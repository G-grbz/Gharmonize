// These are video presentation labels, not musical versions. Preserve titles
// containing Live, Acoustic, Remix, Cover, etc. when querying catalogues.
const PROMO_LABEL = /^(?:(?:official|officiel(?:le)?)\s+(?:(?:4k|hd|1080p|720p)\s+)?(?:music\s+)?(?:video|audio|clip|lyrics?(?:\s+video)?)|(?:video|clip)\s+(?:official|officiel(?:le)?)|(?:official\s+)?lyrics?(?:\s+video)?|4k|hd|1080p|720p)(?:\s+(?:4k|hd|1080p|720p))*$/i;

export function cleanCatalogTitleForSearch(value = '') {
  const original = String(value || '').normalize('NFC').trim();
  const cleaned = original
    .replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (label, round, square) =>
      PROMO_LABEL.test((round ?? square).trim()) ? ' ' : label)
    .replace(/\s+[-–—|]\s*([^–—|]+)$/, (suffix, label) =>
      PROMO_LABEL.test(label.trim()) ? '' : suffix)
    .replace(/\s+/g, ' ').trim();
  return cleaned || original;
}

const LATIN_FOLD = { 'ı': 'i', 'ß': 'ss', 'Æ': 'AE', 'æ': 'ae', 'Œ': 'OE', 'œ': 'oe', 'Ø': 'O', 'ø': 'o', 'Ł': 'L', 'ł': 'l' };
export function catalogSearchTextVariants(value = '') {
  const original = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!original) return [];
  const folded = original.replace(/[ıßÆæŒœØøŁł]/g, (character) => LATIN_FOLD[character])
    .normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC');
  return original === folded ? [original] : [original, folded];
}

// Request deduplication must retain accented and accent-free alternatives.
// Identity scoring can fold accents; query deduplication must not do so.
export function catalogQueryKey(value = '') {
  return String(value || '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}
