// Some catalogue responses contain lowercase i followed by a redundant dot
// above. NFC alone cannot compose this pair. Preserve case and every other
// accent; do not transliterate names or apply a language-dependent case change.
export function normalizeMusicDisplayText(value = '') {
  return String(value || '').normalize('NFC').replace(/i\u0307+/g, 'i');
}
