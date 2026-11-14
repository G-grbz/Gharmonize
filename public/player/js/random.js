// Browser crypto works on both HTTPS and local HTTP player connections.
// Reject the incomplete upper bucket so every index has equal probability.
export function randomIndex(length) {
  if (!Number.isInteger(length) || length < 1 || length > 0x100000000) throw new RangeError('Invalid list length')
  const bucketSize = Math.floor(0x100000000 / length)
  const sample = new Uint32Array(1)
  let index
  do {
    globalThis.crypto.getRandomValues(sample)
    index = Math.floor(sample[0] / bucketSize)
  } while (index >= length)
  return index
}

export function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [list[i], list[j]] = [list[j], list[i]]
  }
  return list
}
