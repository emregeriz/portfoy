#!/usr/bin/env node
/**
 * PWA ikonlarını üretir: public/pwa-192.png, pwa-512.png, apple-touch-icon.png
 *
 *   npm run icons
 *
 * Android'in "ana ekrana ekle" akışı PNG istiyor, mevcut favicon SVG.
 * Bağımlılık eklememek için PNG burada elle kodlanıyor (zlib Node'da var).
 *
 * Tasarım: accent renkli zemin üzerine yükselen üç çubuk. Maskeli
 * ikonlarda Android kenarları kırptığı için çizim ortadaki %80'lik
 * güvenli alanda duruyor.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const BG = [0x4f, 0x8c, 0xff] // --accent
const FG = [0xff, 0xff, 0xff]

const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** pixels: (x, y) → [r,g,b] */
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  let o = 0
  for (let y = 0; y < size; y++) {
    raw[o++] = 0 // filtre: yok
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x, y)
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit derinliği
  ihdr[9] = 2 // renk tipi: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Üç yükselen çubuk + zemin çizgisi. Ölçüler oransal, her boyutta aynı
 * görünsün diye.
 */
function draw(size) {
  const u = size / 100 // yüzde birimi
  const bars = [
    { x: 26, w: 12, top: 62 },
    { x: 44, w: 12, top: 46 },
    { x: 62, w: 12, top: 30 },
  ]
  const baseTop = 74
  const baseBottom = 78
  return (px, py) => {
    const x = px / u
    const y = py / u
    if (x >= 24 && x <= 76 && y >= baseTop && y <= baseBottom) return FG
    for (const b of bars) {
      if (x >= b.x && x <= b.x + b.w && y >= b.top && y <= baseTop) return FG
    }
    return BG
  }
}

for (const [name, size] of [
  ['public/pwa-192.png', 192],
  ['public/pwa-512.png', 512],
  ['public/apple-touch-icon.png', 180],
]) {
  writeFileSync(new URL('../' + name, import.meta.url), png(size, draw(size)))
  console.log(`\x1b[32m✓\x1b[0m ${name} (${size}×${size})`)
}
