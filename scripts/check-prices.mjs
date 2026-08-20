#!/usr/bin/env node
/**
 * Fiyat geçmişinin sağlığını gösterir — salt okunur, hiçbir şey yazmaz.
 *   npm run check:prices
 *
 * "Bugünün getirisi" rozeti bir kalemi sayamıyorsa sebebi hemen hemen her
 * zaman burada görünür: sembolün önceki gün fiyatı yoktur ya da fiyatı
 * günlerdir güncellenmemiştir.
 *
 * .env dosyasındaki VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY kullanılır.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  try {
    const raw = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // .env yoksa ortam değişkenlerine bak
  }
}
loadEnv()

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
if (!url || !key) {
  console.error('VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY gerekli (.env).')
  process.exit(1)
}

const db = createClient(url, key, { auth: { persistSession: false } })

const DAYS = 45
const iso = (d) => d.toISOString().slice(0, 10)
const today = iso(new Date())
const since = iso(new Date(Date.now() - DAYS * 86_400_000))
const fmt = (n) =>
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n)

// Elde tutulan adetler: alım/satım defteri + halka arz dağıtımları
const [{ data: trades }, { data: assets }, { data: prices }, { data: ipos }, { data: entries }] =
  await Promise.all([
    db.from('trades').select('asset_id, side, quantity'),
    db.from('assets').select('id, symbol, kind, auto_price'),
    db.from('asset_prices').select('asset_id, date, price').gte('date', since).order('date'),
    db.from('ipos').select('id, bist_code, status, manual_price, lot_price'),
    db.from('ipo_entries').select('ipo_id, allocated_lot, sold_lot, participated'),
  ])

const held = new Map()
for (const t of trades ?? []) {
  if (!t.asset_id) continue
  const q = Number(t.quantity) * (t.side === 'alis' ? 1 : -1)
  held.set(t.asset_id, (held.get(t.asset_id) ?? 0) + q)
}

const lotByIpo = new Map()
for (const e of entries ?? []) {
  if (!e.participated) continue
  // Satılan lot artık elde değil, günlük değişime girmez
  const open = Number(e.allocated_lot) - Number(e.sold_lot ?? 0)
  if (open > 0) lotByIpo.set(e.ipo_id, (lotByIpo.get(e.ipo_id) ?? 0) + open)
}
const bySymbol = new Map((assets ?? []).map((a) => [a.symbol.toUpperCase(), a]))
const ipoHeld = new Map()
const ipoRef = new Map()
for (const i of ipos ?? []) {
  if (!['dagitildi', 'islemde'].includes(i.status)) continue
  const lot = lotByIpo.get(i.id) ?? 0
  const code = i.bist_code?.trim().toUpperCase()
  if (!code || lot <= 0) continue
  const asset = bySymbol.get(code)
  if (!asset) {
    console.log(`!  ${code} — arzda kod var ama assets tablosunda karşılığı yok, fiyat çekilmiyor`)
    continue
  }
  if (i.manual_price != null) {
    console.log(`!  ${code} — fiyatı elle girilmiş (manual_price), günlük değişim ölçülmez`)
    continue
  }
  ipoHeld.set(asset.id, (ipoHeld.get(asset.id) ?? 0) + lot)
  // İlk işlem gününde önceki kapanış yoktur; referans halka arz fiyatıdır
  if (i.lot_price != null) ipoRef.set(asset.id, Number(i.lot_price))
}

const byAsset = new Map()
for (const p of prices ?? []) {
  const list = byAsset.get(p.asset_id) ?? []
  list.push(p)
  byAsset.set(p.asset_id, list)
}

const rows = []
for (const [assetId, qty] of [...held, ...ipoHeld]) {
  if (!(qty > 1e-9)) continue
  const asset = (assets ?? []).find((a) => a.id === assetId)
  const list = byAsset.get(assetId) ?? []
  const latest = list[list.length - 1]
  const prevRow = list[list.length - 2]
  const prevPrice = prevRow ? Number(prevRow.price) : (ipoRef.get(assetId) ?? null)
  rows.push({
    symbol: asset?.symbol ?? '?',
    kind: asset?.kind ?? '?',
    auto: asset?.auto_price !== false,
    qty,
    count: list.length,
    latest,
    prev: prevRow ?? (prevPrice != null ? { price: prevPrice, date: 'arz fiyatı' } : null),
    firstDay: !prevRow && prevPrice != null,
    delta: latest && prevPrice != null ? (Number(latest.price) - prevPrice) * qty : null,
  })
}

let newest = null
for (const r of rows) if (r.latest && (!newest || r.latest.date > newest)) newest = r.latest.date

console.log(`\nBugün: ${today} · en taze fiyat günü: ${newest ?? '—'} · pencere: son ${DAYS} gün\n`)
console.log('SEMBOL   ADET          GÜN  SON FİYAT (tarih)            ÖNCEKİ (tarih)               GÜNLÜK FARK')
console.log('-'.repeat(108))

let total = 0
let missing = 0
for (const r of rows.sort((a, b) => (b.delta ?? -1e12) - (a.delta ?? -1e12))) {
  const last = r.latest ? `${fmt(r.latest.price)} (${r.latest.date})` : '—'
  const before = r.prev ? `${fmt(r.prev.price)} (${r.prev.date})` : '—'
  let note = ''
  if (r.firstDay) {
    note = '  ← ilk işlem günü, halka arz fiyatına göre'
    total += r.delta ?? 0
  } else if (r.count < 2) {
    note = '  ← önceki gün fiyatı yok, sayılamaz'
    missing++
  } else if (newest && r.latest.date < iso(new Date(Date.parse(newest) - 7 * 86_400_000))) {
    note = '  ← fiyat bayat, sayılmaz'
    missing++
  } else {
    total += r.delta ?? 0
  }
  console.log(
    `${r.symbol.padEnd(8)} ${fmt(r.qty).padStart(12)}  ${String(r.count).padStart(3)}  ` +
      `${last.padEnd(28)} ${before.padEnd(28)} ${(r.delta != null ? fmt(r.delta) : '—').padStart(12)}${note}`
  )
}

console.log('-'.repeat(108))
console.log(`Fiyat değişiminden bugünkü getiri: ${fmt(total)} TL`)
if (missing) {
  console.log(
    `${missing} kalem sayılamadı. Fiyat çekimi çalıştıkça geçmiş birikir; ` +
      'Dashboard → "↻ Fiyatları güncelle" ya da cron (supabase/cron.sql) bunu her gün yapar.'
  )
}
console.log()
