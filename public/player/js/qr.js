// Minimal QR Code generator (ISO/IEC 18004): byte mode, error correction
// level M, versions 1–40, automatic mask. No dependencies, CSP-friendly.
// Based on the well-known reference algorithm (Project Nayuki, MIT).

const ECC_CODEWORDS_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
const NUM_ERROR_CORRECTION_BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
const FORMAT_BITS_M = 0

function numRawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2
    result -= (25 * numAlign - 10) * numAlign - 55
    if (ver >= 7) result -= 36
  }
  return result
}

function numDataCodewords(ver) {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK_M[ver] * NUM_ERROR_CORRECTION_BLOCKS_M[ver]
}

function gfMul(x, y) {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root)
      if (j + 1 < result.length) result[j] ^= result[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return result
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ result.shift()
    result.push(0)
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor) })
  }
  return result
}

const getBit = (x, i) => ((x >>> i) & 1) !== 0

function encodeData(bytes) {
  for (let ver = 1; ver <= 40; ver++) {
    const capacityBits = numDataCodewords(ver) * 8
    const countBits = ver <= 9 ? 8 : 16
    const usedBits = 4 + countBits + bytes.length * 8
    if (usedBits > capacityBits) continue
    const bits = []
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1) }
    push(0x4, 4)
    push(bytes.length, countBits)
    for (const b of bytes) push(b, 8)
    push(0, Math.min(4, capacityBits - bits.length))
    push(0, (8 - (bits.length % 8)) % 8)
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8)
    const codewords = []
    for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0))
    return { ver, codewords }
  }
  throw new Error('Data too long for a QR code')
}

function addEccAndInterleave(ver, data) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS_M[ver]
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK_M[ver]
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8)
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks)
  const shortBlockLen = Math.floor(rawCodewords / numBlocks)
  const divisor = rsDivisor(blockEccLen)
  const blocks = []
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < numShortBlocks) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const result = []
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i])
    })
  }
  return result
}

function alignmentPositions(ver, size) {
  if (ver === 1) return []
  const numAlign = Math.floor(ver / 7) + 2
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2
  const result = [6]
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos)
  return result
}

class Matrix {
  constructor(ver) {
    this.ver = ver
    this.size = ver * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array(this.size).fill(false))
    this.isFunction = Array.from({ length: this.size }, () => new Array(this.size).fill(false))
  }

  set(x, y, dark) {
    this.modules[y][x] = dark
    this.isFunction[y][x] = true
  }

  drawFunctionPatterns() {
    const { size } = this
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(size - 4, 3)
    this.drawFinder(3, size - 4)
    const pos = alignmentPositions(this.ver, size)
    const n = pos.length
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
        this.drawAlignment(pos[i], pos[j])
      }
    }
    this.drawFormatBits(0)
    this.drawVersion()
  }

  drawFinder(x, y) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.set(xx, yy, dist !== 2 && dist !== 4)
      }
    }
  }

  drawAlignment(x, y) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }

  drawFormatBits(mask) {
    const data = (FORMAT_BITS_M << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    const { size } = this
    for (let i = 0; i <= 5; i++) this.set(8, i, getBit(bits, i))
    this.set(8, 7, getBit(bits, 6))
    this.set(8, 8, getBit(bits, 7))
    this.set(7, 8, getBit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, getBit(bits, i))
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, getBit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, getBit(bits, i))
    this.set(8, size - 8, true)
  }

  drawVersion() {
    if (this.ver < 7) return
    let rem = this.ver
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (this.ver << 12) | rem
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.set(a, b, bit)
      this.set(b, a, bit)
    }
  }

  drawCodewords(data) {
    const { size } = this
    let i = 0
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? size - 1 - vert : vert
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7))
            i++
          }
        }
      }
    }
  }

  applyMask(mask) {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x]
      }
    }
  }

  // Simplified penalty (runs, 2x2 blocks, finder-like patterns, balance).
  penalty() {
    const { size, modules } = this
    let score = 0
    const line = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 1
        for (let b = 1; b <= size; b++) {
          if (b < size && get(a, b) === get(a, b - 1)) { run++; continue }
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
        for (let b = 0; b + 10 < size; b++) {
          const seq = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('')
          if (seq === '10111010000' || seq === '00001011101') score += 40
        }
      }
    }
    line((a, b) => modules[a][b])
    line((a, b) => modules[b][a])
    let dark = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++
        if (x < size - 1 && y < size - 1) {
          const c = modules[y][x]
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3
        }
      }
    }
    const total = size * size
    score += Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return score
  }
}

// Returns a boolean matrix (true = dark module).
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(String(text)))
  const { ver, codewords } = encodeData(bytes)
  const all = addEccAndInterleave(ver, codewords)
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(ver)
    m.drawFunctionPatterns()
    m.drawCodewords(all)
    m.applyMask(mask)
    m.drawFormatBits(mask)
    const score = m.penalty()
    if (!best || score < best.score) best = { score, matrix: m }
  }
  return best.matrix.modules
}

// SVG element (black on white, 4-module quiet zone) for the given text.
export function qrSvg(text, { label = 'QR code', document: doc = globalThis.document } = {}) {
  const modules = qrMatrix(text)
  const size = modules.length
  const border = 4
  const dim = size + border * 2
  let d = ''
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) if (modules[y][x]) d += `M${x + border},${y + border}h1v1h-1z`
  }
  const NS = 'http://www.w3.org/2000/svg'
  const svg = doc.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${dim} ${dim}`)
  svg.setAttribute('shape-rendering', 'crispEdges')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  const bg = doc.createElementNS(NS, 'rect')
  bg.setAttribute('width', dim)
  bg.setAttribute('height', dim)
  bg.setAttribute('fill', '#fff')
  const path = doc.createElementNS(NS, 'path')
  path.setAttribute('d', d)
  path.setAttribute('fill', '#000')
  svg.append(bg, path)
  return svg
}
