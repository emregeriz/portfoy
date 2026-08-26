#!/usr/bin/env node
/**
 * Günlük kâr defterini terminalde dökër — salt okunur, hiçbir şey yazmaz.
 *   npm run check:daily -- --user eposta@ornek.com
 *   npm run check:daily -- --user eposta@ornek.com --days 30 --day 2026-08-24
 *
 * Uygulamadaki Günlük Kâr sayfasıyla **aynı motoru** (src/lib/dailyReturn.ts)
 * çalıştırır; ekranda gördüğün sayı burada da aynı çıkmalı. Bir gün şüpheli
 * görünüyorsa `--day` ile o günün kalemlerini tek tek görürsün.
 *
 * .env dosyasındaki VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY kullanılır.
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { createJiti } from 'jiti'

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
const info = (m) => console.log(`  \x1b[90m${m}\x1b[0m`)

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}

const email = arg('user')
const days = Number(arg('days') ?? 45)
const onlyDay = arg('day')

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

const iso = (d) => new Date(d).toISOString().slice(0, 10)
const today = iso(Date.now())
const from = iso(Date.now() - days * 86_400_000)
const padded = iso(Date.now() - (days + 30) * 86_400_000)

const [trades, ipos, entries, accounts, actions, nema, dividends, positions, assets] =
  await Promise.all([
    db.from('trades').select('asset_id, side, quantity, unit_price, amount_try, trade_date, created_at').eq('user_id', userId),
    db.from('ipos').select('id, bist_code, lot_price, manual_price, trade_start_date, ipo_date, status').eq('user_id', userId),
    db.from('ipo_entries').select('ipo_id, account_id, allocated_lot, sold_lot, sold_price, sold_date, participated').eq('user_id', userId),
    db.from('accounts').select('id, name').eq('user_id', userId),
    db.from('corporate_actions').select('asset_id, action_date, ratio').eq('user_id', userId),
    db.from('account_ledger').select('date, amount').eq('user_id', userId).eq('kind', 'nema').gte('date', from),
    db.from('dividends').select('asset_id, pay_date, gross_amount, tax_amount').eq('user_id', userId).gte('pay_date', from),
    db.from('positions').select('asset_id, quantity, snapshots:snapshot_id (snapshot_date)').eq('user_id', userId),
    db.from('assets').select('id, symbol, kind'),
  ])

const assetRows = assets.data ?? []
const idBySymbol = new Map(assetRows.map((a) => [a.symbol.trim().toUpperCase(), a.id]))
const snapshots = []
for (const p of positions.data ?? []) {
  const snap = Array.isArray(p.snapshots) ? p.snapshots[0] : p.snapshots
  if (!p.asset_id || !snap?.snapshot_date) continue
  snapshots.push({ snapshot_date: snap.snapshot_date, asset_id: p.asset_id, quantity: Number(p.quantity ?? 0) })
}

const ids = new Set()
for (const t of trades.data ?? []) if (t.asset_id) ids.add(t.asset_id)
for (const s of snapshots) ids.add(s.asset_id)
for (const d of dividends.data ?? []) if (d.asset_id) ids.add(d.asset_id)
for (const i of ipos.data ?? []) {
  const id = idBySymbol.get((i.bist_code ?? '').trim().toUpperCase())
  if (id) ids.add(id)
}

// asset_prices tek istekte en fazla 1000 satır döner
const prices = []
for (let page = 0; ids.size; page++) {
  const { data, error } = await db
    .from('asset_prices')
    .select('asset_id, date, price')
    .in('asset_id', [...ids])
    .gte('date', padded)
    .lte('date', today)
    .order('date', { ascending: true })
    .range(page * 1000, page * 1000 + 999)
  if (error) {
    bad(error.message)
    process.exit(1)
  }
  prices.push(...(data ?? []))
  if ((data ?? []).length < 1000) break
}

const jiti = createJiti(import.meta.url)
const { computeDailyReturns } = await jiti.import('../src/lib/dailyReturn.ts')

const rows = computeDailyReturns({
  from,
  to: today,
  trades: trades.data ?? [],
  prices,
  assets: assetRows,
  actions: actions.data ?? [],
  ipos: ipos.data ?? [],
  entries: entries.data ?? [],
  accounts: accounts.data ?? [],
  snapshots,
  nema: nema.data ?? [],
  dividends: dividends.data ?? [],
})

const money = (n) =>
  (n >= 0 ? '+' : '−') +
  new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(n))
const pad = (s, n) => String(s).padStart(n)

console.log(`\n${target.email} · ${from} → ${today}\n`)

if (onlyDay) {
  const row = rows.find((r) => r.date === onlyDay)
  if (!row) {
    bad(`${onlyDay} gününde hareket yok.`)
    process.exit(0)
  }
  console.log(`${row.date}  toplam ${money(row.total)}`)
  info(`fon/hisse ${money(row.priceDelta)} · arz ${money(row.ipoDelta)} · nema ${money(row.nema)} · temettü ${money(row.dividend)}`)
  console.log('')
  for (const it of row.items) {
    const ref = it.from != null ? `${it.from.toFixed(2)} → ${it.to.toFixed(2)}` : ''
    console.log(
      `  ${it.symbol.padEnd(8)} ${it.part.padEnd(6)} ${(it.account ?? '').padEnd(10)} ` +
        `${pad(it.qty ? it.qty.toFixed(0) : '', 8)}  ${ref.padEnd(22)} ${pad(money(it.delta), 14)}`
    )
  }
  console.log('\n  gün sonu pozisyonlar:')
  for (const h of row.holdings) {
    console.log(
      `  ${h.symbol.padEnd(8)} ${pad(h.qty.toFixed(2), 12)} × ${pad(h.price?.toFixed(4) ?? '—', 12)} = ${pad((h.value ?? 0).toFixed(2), 14)}  (o gün ${money(h.delta)})`
    )
  }
} else {
  let acc = 0
  for (const r of rows) {
    acc += r.total
    console.log(
      `${r.date}  ${pad(money(r.total), 14)}  birikimli ${pad(money(acc), 14)}  ` +
        `[fon/hisse ${money(r.priceDelta)} · arz ${money(r.ipoDelta)} · nema ${money(r.nema)}]` +
        (r.unmeasured ? `  ${r.unmeasured} kalem ölçülemedi` : '')
    )
  }
  console.log(`\n${rows.length} hareketli gün · toplam ${money(acc)}`)
  info('Bir günün dökümü için:  --day 2026-08-24')
}
