#!/usr/bin/env node
/**
 * Toplu girilen halka arz hisselerinin alış tarihini ilk işlem gününe çeker.
 *   npm run fix:ipodate -- --user eposta@ornek.com                 (kuru çalışma)
 *   npm run fix:ipodate -- --user eposta@ornek.com --apply         (yazar)
 *   npm run fix:ipodate -- --user eposta@ornek.com --date 2026-08-20
 *
 * Neden gerekli: ekstre görselinden içe aktarılan arz payları, hepsi aynı
 * gün girildiği için o günün alışı gibi görünüyordu. Alış fiyatı arz
 * fiyatı, kapanış ise aylar sonrasının fiyatı olduğundan aylara yayılmış
 * kâr tek güne yığılıyor ve günlük kâr grafiğini ölçeksiz bırakıyordu.
 *
 * Pay aslında arzın işlem görmeye başladığı gün portföye girmiştir. Betik
 * her sembol için Yahoo'dan **ilk işlem gününü** okur, fiyat geçmişini o
 * güne kadar geriye doldurur ve alış tarihini oraya taşır. Kâr böylece
 * kaybolmaz; gerçekte kazanıldığı günlere dağılır.
 *
 * Yalnızca şu koşulları sağlayan alışlar taşınır:
 *   1. Halka arz hesabında (accounts.is_ipo) yapılmış olmalı — normal
 *      hesaptaki gerçek alış (ör. Midas'tan limitli TEHOL) yerinde kalır.
 *   2. Sembolün ilk işlem günü son 18 ay içinde olmalı — yeni arz demektir.
 *   3. İlk işlem günü, kayıtlı alış tarihinden önce olmalı.
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

const bad = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`)
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const info = (m) => console.log(`  \x1b[90m${m}\x1b[0m`)
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`)

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}
const apply = argv.includes('--apply')

const email = arg('user')
/** Toplu girişin yapıldığı gün — bu gündeki alışlar incelenir */
const entryDate = arg('date') ?? '2026-08-20'
/** Yahoo'dan istenecek geçmiş; arz ne kadar eskiyse o kadar uzun olmalı */
const range = arg('range') ?? '2y'
/** Bundan eski listelenmiş sembol "yeni arz" sayılmaz, dokunulmaz */
const MAX_AGE_DAYS = 550

const url = process.env.VITE_SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY
if (!email) {
  bad('Kullanıcı belirtilmedi.  --user eposta@ornek.com')
  process.exit(1)
}
if (!url || !secret) {
  bad('.env eksik: VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY gerekli.')
  process.exit(1)
}

const db = createClient(url, secret, { auth: { persistSession: false } })

const { data: list, error: listErr } = await db.auth.admin.listUsers({ perPage: 1000 })
if (listErr) {
  bad(listErr.message)
  process.exit(1)
}
const target = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
if (!target) {
  bad(`Kullanıcı bulunamadı: ${email}`)
  info(`Mevcut: ${list.users.map((u) => u.email).join(', ')}`)
  process.exit(1)
}
const userId = target.id

// ------------------------------------------------------------------ veri
const [tradeRes, accRes, assetRes] = await Promise.all([
  db.from('trades').select('*').eq('user_id', userId).eq('trade_date', entryDate).eq('side', 'alis'),
  db.from('accounts').select('id, name, is_ipo').eq('user_id', userId),
  db.from('assets').select('id, symbol, kind, price_ref'),
])
const readErr = tradeRes.error ?? accRes.error ?? assetRes.error
if (readErr) {
  bad(readErr.message)
  process.exit(1)
}

const accountById = new Map((accRes.data ?? []).map((a) => [a.id, a]))
const assetById = new Map((assetRes.data ?? []).map((a) => [a.id, a]))
const trades = tradeRes.data ?? []

console.log(`\n${target.email} · ${entryDate} günündeki ${trades.length} alış inceleniyor`)

// --------------------------------------------------------------- Yahoo
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

/** Sembolün ilk işlem günü + günlük kapanış serisi */
async function history(asset) {
  const sym = asset.price_ref?.trim() || `${asset.symbol.toUpperCase()}.IS`
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`,
    { headers: { 'User-Agent': UA } }
  )
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} (${sym})`)
  const j = await res.json()
  const result = j?.chart?.result?.[0]
  if (!result) throw new Error(`Yahoo veri döndürmedi (${sym})`)
  const meta = result.meta
  if (meta?.currency && meta.currency !== 'TRY') throw new Error(`${sym} TL değil (${meta.currency})`)

  const stamps = result.timestamp ?? []
  const closes = result.indicators?.quote?.[0]?.close ?? []
  const rows = []
  for (let i = 0; i < stamps.length; i++) {
    const c = closes[i]
    if (typeof c !== 'number' || !(c > 0)) continue
    rows.push({ date: new Date(stamps[i] * 1000).toISOString().slice(0, 10), price: c })
  }
  const firstTrade = meta?.firstTradeDate
    ? new Date(meta.firstTradeDate * 1000).toISOString().slice(0, 10)
    : rows[0]?.date
  return { firstTrade, rows }
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

// --------------------------------------------------------- sembol taraması
head('Semboller')

/** symbol → { asset, firstTrade, rows } */
const plan = new Map()
const skipped = []

for (const t of trades) {
  const asset = assetById.get(t.asset_id)
  const account = accountById.get(t.account_id)
  const label = asset?.symbol ?? '—'

  if (!asset) {
    skipped.push([label, 'varlık kaydı yok'])
    continue
  }
  if (!account?.is_ipo) {
    skipped.push([label, `${account?.name ?? 'hesapsız'} — halka arz hesabı değil, gerçek alış`])
    continue
  }
  if (plan.has(asset.symbol) || skipped.some(([s]) => s === asset.symbol)) continue

  try {
    const h = await history(asset)
    if (!h.firstTrade || !h.rows.length) {
      skipped.push([label, 'fiyat geçmişi alınamadı'])
      continue
    }
    if (daysBetween(h.firstTrade, entryDate) > MAX_AGE_DAYS) {
      skipped.push([label, `ilk işlem günü ${h.firstTrade} — yeni arz değil`])
      continue
    }
    if (h.firstTrade >= entryDate) {
      skipped.push([label, `ilk işlem günü ${h.firstTrade} — tarih zaten doğru`])
      continue
    }
    plan.set(asset.symbol, { asset, ...h })
  } catch (e) {
    skipped.push([label, e.message])
  }
}

for (const [symbol, p] of plan) {
  const lots = trades.filter((t) => assetById.get(t.asset_id)?.symbol === symbol)
  const qty = lots.reduce((s, t) => s + Number(t.quantity), 0)
  const first = p.rows.find((r) => r.date === p.firstTrade) ?? p.rows[0]
  const buy = Number(lots[0]?.unit_price ?? 0)
  const pop = buy > 0 ? ((first.price - buy) / buy) * 100 : 0
  console.log(
    `  ${symbol.padEnd(7)} ${entryDate} → \x1b[1m${p.firstTrade}\x1b[0m  ` +
      `${String(lots.length).padStart(2)} kayıt · ${String(qty).padStart(5)} adet · ` +
      `arz ${buy.toFixed(2)} → ilk kapanış ${first.price.toFixed(2)} (%${pop.toFixed(0)}) · ` +
      `${p.rows.length} günlük fiyat`
  )
}
for (const [symbol, why] of skipped) info(`${symbol.padEnd(7)} atlandı — ${why}`)

if (!plan.size) {
  console.log('\nTaşınacak alış yok.')
  process.exit(0)
}

const moving = trades.filter((t) => plan.has(assetById.get(t.asset_id)?.symbol ?? ''))
console.log(`\n${moving.length} alış kaydı, ${plan.size} sembol taşınacak.`)

if (!apply) {
  console.log('\nKuru çalışma — hiçbir şey yazılmadı. Yazmak için --apply ekle.')
  process.exit(0)
}

// ------------------------------------------------------- fiyat geçmişi
head('Fiyat geçmişi dolduruluyor')
let written = 0
for (const [symbol, p] of plan) {
  const rows = p.rows.map((r) => ({
    asset_id: p.asset.id,
    date: r.date,
    price: r.price,
    currency: 'TRY',
    source: 'yahoo-history',
  }))
  // Var olan gün korunur — elle düzeltilmiş fiyatın üstüne yazılmasın
  const { error } = await db
    .from('asset_prices')
    .upsert(rows, { onConflict: 'asset_id,date', ignoreDuplicates: true })
  if (error) {
    bad(`${symbol}: ${error.message}`)
    continue
  }
  written += rows.length
  info(`${symbol.padEnd(7)} ${p.firstTrade} → bugün, ${rows.length} gün`)
}
ok(`${written} fiyat satırı gönderildi (var olan günler korundu).`)

// --------------------------------------------------------- alış tarihleri
head('Alış tarihleri taşınıyor')
let moved = 0
for (const t of moving) {
  const symbol = assetById.get(t.asset_id).symbol
  const { firstTrade } = plan.get(symbol)
  const { error } = await db.from('trades').update({ trade_date: firstTrade }).eq('id', t.id)
  if (error) {
    bad(`${symbol} ${t.id.slice(0, 8)}: ${error.message}`)
    continue
  }
  moved++
}
ok(`${moved}/${moving.length} alış kaydı ilk işlem gününe taşındı.`)
info('Günlük Kâr sayfasını yenile — kâr artık kazanıldığı günlere dağılmış olmalı.')
