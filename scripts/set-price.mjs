#!/usr/bin/env node
/**
 * Bir varlığa elle fiyat yazar — eksik ya da yanlış günü düzeltmek için.
 *
 *   npm run price:set -- --symbol DFI --date 2026-08-19 --price 5,486123
 *   npm run price:set -- --symbol THF --date 2026-08-19 --price 2,50 --yes
 *   npm run price:set -- --symbol DFI,THF --date 2026-08-19 --price 5,48;2,50 --yes
 *
 * --yes verilmezse yalnızca ne yazılacağını gösterir (kuru çalışma).
 * Tutar TR biçiminde ("5,486123") ya da nokta ondalıklı yazılabilir.
 * Kaynak alanına 'manuel' yazılır; otomatik çekim aynı günü tazelerse
 * üzerine yazar.
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

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}
const commit = argv.includes('--yes')

const symbols = (arg('symbol') ?? '').split(/[,;]/).map((s) => s.trim().toUpperCase()).filter(Boolean)
const prices = (arg('price') ?? '').split(/[;]/).map((s) => s.trim()).filter(Boolean)
const date = arg('date')

if (!symbols.length || !prices.length || !date) {
  console.error('Kullanım: npm run price:set -- --symbol DFI --date 2026-08-19 --price 5,486123 [--yes]')
  process.exit(1)
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Tarih YYYY-AA-GG biçiminde olmalı.')
  process.exit(1)
}
if (prices.length !== 1 && prices.length !== symbols.length) {
  console.error('Fiyat sayısı sembol sayısıyla eşleşmeli (ya da tek fiyat ver).')
  process.exit(1)
}

/** "5.486,123" ve "5.486123" gibi girişleri sayıya çevirir. */
const parseTR = (text) => {
  const s = String(text).replace(/[^\d.,-]/g, '')
  const hasComma = s.includes(',')
  const hasDot = s.includes('.')
  let normalized = s
  if (hasComma && hasDot) {
    normalized = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '')
  } else if (hasComma) {
    normalized = s.replace(',', '.')
  }
  const n = Number(normalized)
  return Number.isFinite(n) ? n : NaN
}

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
if (!url || !key) {
  console.error('VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY gerekli (.env).')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

const { data: assets, error } = await db.from('assets').select('id, symbol, kind').in('symbol', symbols)
if (error) {
  console.error('assets okunamadı:', error.message)
  process.exit(1)
}

const rows = []
for (let i = 0; i < symbols.length; i++) {
  const symbol = symbols[i]
  const asset = (assets ?? []).find((a) => a.symbol.toUpperCase() === symbol)
  if (!asset) {
    console.error(`✗ ${symbol} — assets tablosunda yok, atlandı`)
    continue
  }
  const price = parseTR(prices.length === 1 ? prices[0] : prices[i])
  if (!(price > 0)) {
    console.error(`✗ ${symbol} — fiyat okunamadı: ${prices[i] ?? prices[0]}`)
    continue
  }
  rows.push({ asset_id: asset.id, date, price, currency: 'TRY', source: 'manuel', symbol })
}

if (!rows.length) {
  console.error('Yazılacak satır yok.')
  process.exit(1)
}

const show = (n) =>
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(n)

console.log(`\n${date} için ${rows.length} fiyat:`)
for (const r of rows) console.log(`  ${r.symbol.padEnd(8)} ${show(r.price)}`)

if (commit) {
  const { error: writeErr } = await db
    .from('asset_prices')
    .upsert(rows.map(({ symbol: _s, ...r }) => r), { onConflict: 'asset_id,date' })
  if (writeErr) {
    console.error('Yazılamadı:', writeErr.message)
    process.exitCode = 1
  } else {
    console.log('\n✓ Yazıldı. Kontrol: npm run check:prices\n')
  }
} else {
  console.log('\nKuru çalışma — hiçbir şey yazılmadı. Onaylamak için sonuna --yes ekle.\n')
}
