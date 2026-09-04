#!/usr/bin/env node
/**
 * Fiyat geçmişinin sağlığını gösterir — salt okunur, hiçbir şey yazmaz.
 *   npm run check:prices
 *
 * "Bugünün getirisi" rozeti bir kalemi sayamıyorsa sebebi hemen hemen her
 * zaman burada görünür: sembolün önceki gün fiyatı yoktur ya da fiyatı
 * günlerdir güncellenmemiştir.
 *
 * Kâğıt listede hiç görünmüyorsa sebep fiyat değil defter olabilir: alışı
 * bir hesaba, satışı başka hesaba yazılan kâğıdın sembol toplamı sıfırlanır
 * ve her yerden düşer. Tablonun altındaki "eksik alım" uyarıları bunu yakalar.
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
const [{ data: trades }, { data: assets }, { data: ipos }, { data: entries }, { data: positions }] =
  await Promise.all([
    db.from('trades').select('asset_id, side, quantity'),
    db.from('assets').select('id, symbol, kind, auto_price'),
    db.from('ipos').select('id, bist_code, status, manual_price, lot_price'),
    db.from('ipo_entries').select('ipo_id, allocated_lot, sold_lot, participated'),
    db.from('positions').select('asset_id, quantity, snapshots:snapshot_id (snapshot_date)'),
  ])

// asset_prices tek istekte en fazla 1000 satır döner — sayfalanmazsa en taze
// günler sessizce düşer ve tablo bayat fiyat gösterir
const prices = []
for (let page = 0; ; page++) {
  const { data, error } = await db
    .from('asset_prices')
    .select('asset_id, date, price')
    .gte('date', since)
    .order('date')
    .range(page * 1000, page * 1000 + 999)
  if (error) {
    console.error(error.message)
    process.exit(1)
  }
  prices.push(...(data ?? []))
  if ((data ?? []).length < 1000) break
}

const held = new Map()
for (const t of trades ?? []) {
  if (!t.asset_id) continue
  const q = Number(t.quantity) * (t.side === 'alis' ? 1 : -1)
  held.set(t.asset_id, (held.get(t.asset_id) ?? 0) + q)
}

// Snapshot'tan bilinen pozisyonlar: alım/satım defterine hiç girmemiş kâğıt
// yalnızca snapshot'ta görünür — günlük kâr motoru bunları da sayar
const snapByDate = new Map()
for (const p of positions ?? []) {
  const snap = Array.isArray(p.snapshots) ? p.snapshots[0] : p.snapshots
  const q = Number(p.quantity ?? 0)
  if (!p.asset_id || !snap?.snapshot_date || held.has(p.asset_id) || !(q > 0)) continue
  const m = snapByDate.get(snap.snapshot_date) ?? new Map()
  m.set(p.asset_id, (m.get(p.asset_id) ?? 0) + q)
  snapByDate.set(snap.snapshot_date, m)
}
const lastSnap = [...snapByDate.keys()].sort().pop()
const snapHeld = lastSnap ? snapByDate.get(lastSnap) : new Map()

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
for (const [assetId, qty] of [...held, ...snapHeld, ...ipoHeld]) {
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

// ------------------------------------------------------ kitaptaki boşluklar
// Bir kâğıt günlük kâr listesinde hiç görünmüyorsa sebebi buradadır:
// ya defterde varlığa bağlanmamıştır, ya da hiç fiyat kaydı yoktur.
const symbolOf = (id) => (assets ?? []).find((a) => a.id === id)?.symbol ?? id
const nullTrades = (trades ?? []).filter((t) => !t.asset_id).length
if (nullTrades) {
  console.log(`!  ${nullTrades} işlem satırında asset_id boş — o kâğıtlar hiçbir yerde sayılmıyor`)
}
for (const i of ipos ?? []) {
  const code = i.bist_code?.trim().toUpperCase()
  if (!code) continue
  if (!bySymbol.has(code)) console.log(`!  ${code} — arz kaydı var, assets tablosunda karşılığı yok`)
  else if (!['dagitildi', 'islemde'].includes(i.status)) {
    console.log(`!  ${code} — arz durumu '${i.status}', elde sayılmıyor`)
  }
}
for (const [id, q] of [...held, ...snapHeld]) {
  if (!(q > 1e-9)) continue
  if (!(byAsset.get(id) ?? []).length) {
    console.log(`!  ${symbolOf(id)} — elde ${fmt(q)} adet var ama son ${DAYS} günde hiç fiyat kaydı yok`)
  }
}
console.log()

// Hesap bazında eksik alım: aynı kâğıdın alışı bir hesaba, satışı başka
// hesaba yazılırsa sembol toplamı sıfırlanır ve kalem listelerden düşer.
// Net sıfır olduğu için yukarıdaki tabloda görünmez — burada yakalanır.
const { data: accTrades } = await db.from('trades').select('asset_id, account_id, side, quantity')
const { data: accRows } = await db.from('accounts').select('id, name')
const accName = new Map((accRows ?? []).map((a) => [a.id, a.name]))
const perAccount = new Map()
for (const t of accTrades ?? []) {
  if (!t.asset_id) continue
  const k = `${t.asset_id}\u0000${t.account_id ?? '—'}`
  perAccount.set(k, (perAccount.get(k) ?? 0) + Number(t.quantity) * (t.side === 'alis' ? 1 : -1))
}
for (const [k, q] of perAccount) {
  if (q >= -1e-9) continue
  const [id, acc] = k.split('\u0000')
  console.log(
    `!  ${symbolOf(id)} — ${accName.get(acc) ?? 'hesapsız'} hesabında ${fmt(-q)} adet eksik alım ` +
      '(satış başka hesaba yazılmış olabilir)'
  )
}
