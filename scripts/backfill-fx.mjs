#!/usr/bin/env node
/**
 * fx_rates tablosuna geçmiş kur serisi doldurur.
 *
 *   npm run backfill:fx                → USD, son 2 yıl
 *   npm run backfill:fx -- --range 5y --currencies USD,EUR
 *
 * Neden gerekiyor: fetch-prices her gün TCMB'den o günün kurunu yazıyor,
 * ama geçmiş yok. Reel getiri (TL kazancının kaç dolar ettiği) geçmiş kur
 * olmadan hesaplanamıyor. Yahoo tek çağrıda yılların serisini veriyor.
 *
 * Tekrar çalıştırılabilir: aynı gün + para birimi için upsert edilir.
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
    // .env yoksa ortam değişkenleri
  }
}
loadEnv()

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`)
const info = (m) => console.log(`  \x1b[90m${m}\x1b[0m`)

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 ? argv[i + 1] : d
}

const RANGE = arg('range', '2y')
const CURRENCIES = arg('currencies', 'USD').split(',').map((s) => s.trim().toUpperCase())

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
if (!url || !key) {
  bad('VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY gerekli (.env).')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

/** Yahoo sembolü: USD → USDTRY=X */
const yahooSymbol = (cur) => `${cur}TRY=X`

async function seriesFor(cur) {
  const res = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol(cur)}?range=${RANGE}&interval=1d`,
    { headers: { 'User-Agent': 'Mozilla/5.0 portfoy-kisisel-takip' } }
  )
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`)
  const j = await res.json()
  const r = j?.chart?.result?.[0]
  const stamps = r?.timestamp ?? []
  const closes = r?.indicators?.quote?.[0]?.close ?? []
  const rows = []
  for (let i = 0; i < stamps.length; i++) {
    const v = closes[i]
    if (typeof v !== 'number' || !(v > 0)) continue
    rows.push({
      date: new Date(stamps[i] * 1000).toISOString().slice(0, 10),
      currency: cur,
      rate_try: v,
    })
  }
  return rows
}

let toplam = 0
for (const cur of CURRENCIES) {
  try {
    const rows = await seriesFor(cur)
    if (!rows.length) {
      bad(`${cur}: veri gelmedi`)
      continue
    }
    // Tek seferde büyük gövde göndermemek için parça parça
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db
        .from('fx_rates')
        .upsert(rows.slice(i, i + 500), { onConflict: 'date,currency' })
      if (error) throw new Error(error.message)
    }
    toplam += rows.length
    ok(`${cur}: ${rows.length} gün (${rows[0].date} → ${rows[rows.length - 1].date})`)
  } catch (e) {
    bad(`${cur}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

info(`toplam ${toplam} satır yazıldı`)
