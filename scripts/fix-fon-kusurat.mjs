#!/usr/bin/env node
/**
 * Küsuratlı fon alımlarını tam paya oturtur.
 *   npm run fix:fon -- --user eposta@ornek.com            (kuru çalışma)
 *   npm run fix:fon -- --user eposta@ornek.com --apply    (yazar)
 *
 * Neden gerekli: serbest fonda küsuratlı pay yok. Emri TL cinsinden
 * verirsin, aracı kurum o tutarla alınabilen **tam pay** kadar alır, artan
 * parayı hesaba iade eder — 1,25 TLY istesen 1 adet verir. Uygulamaya işlem
 * emir günü girildiğinde adet `tutar ÷ o günün fiyatı` ile hesaplanıyor ve
 * küsuratlı çıkıyor. İki hata birden doğuruyor:
 *
 *   1. Elde olmayan pay portföyde duruyor — adet ve maliyet şişiyor.
 *   2. Fon **valörlü** çalışır: emri verdiğin günün fiyatından değil,
 *      valör günü fiyatından alırsın. Emir günü fiyatı yazıldığı için
 *      aradaki günlerde hiç sahip olmadığın paydan kâr yazılıyor.
 *
 * Betik her küsuratlı fon alışı için valör günü fiyatını `asset_prices`ten
 * okur, `floor(tutar ÷ valör fiyatı)` tam payı bulur, işlemi o adet/fiyat/
 * tarihe çeker ve işleme bağlı `alim` satırını da düzeltir. Artan para
 * hesapta nakit olarak kalır — iadenin ta kendisi.
 *
 * Valör varsayılan 2 fiyat günü (emir günü sayılmaz; hafta sonu atlanır).
 * Kurumun valörü farklıysa `--valor 1`, tarihi biliyorsan `--fiyat-tarihi`
 * ile doğrudan ver. Emir gününü korumak için `--tarih-koru` — o zaman adet
 * düzelir ama günlük kâr defterindeki sahte hareket kalır.
 *
 * Kuru çalışma sonunda fonun düzeltilmiş adedini ve ortalama maliyetini
 * yazar; aracı kurum ekranındaki değerle birebir tutuyorsa --apply ver.
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
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`)
const info = (m) => console.log(`  \x1b[90m${m}\x1b[0m`)
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`)

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}
const flag = (name) => argv.includes(`--${name}`)

const email = arg('user')
const apply = flag('apply')
/** Yazmak yerine SQL bas — Supabase SQL Editor'e yapıştırmak için */
const asSql = flag('sql')
const keepDate = flag('tarih-koru')
/** Emir gününden sonra kaçıncı fiyat gününde pay verilir */
const valor = Number(arg('valor') ?? 2)
/** Valör hesabını atlayıp fiyat gününü doğrudan vermek için */
const forcedDate = arg('fiyat-tarihi')
const onlySymbol = arg('sembol')?.toUpperCase() ?? null
/** Küsurat sayılmayacak tolerans — kayan nokta gürültüsü tam sayı sayılsın */
const EPS = 1e-9

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

const money = (n) =>
  `₺${Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n, d = 6) =>
  Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 0, maximumFractionDigits: d })
const round2 = (n) => Math.round(n * 100) / 100

// --------------------------------------------------------------------
// Veri
// --------------------------------------------------------------------
const [tradeRes, accRes, assetRes, ledRes] = await Promise.all([
  db
    .from('trades')
    .select('*')
    .eq('user_id', userId)
    .order('trade_date')
    .order('created_at'),
  db.from('accounts').select('id, name').eq('user_id', userId),
  db.from('assets').select('id, symbol, kind'),
  db.from('account_ledger').select('*').eq('user_id', userId).not('trade_id', 'is', null),
])
for (const r of [tradeRes, accRes, assetRes, ledRes]) {
  if (r.error) {
    bad(r.error.message)
    process.exit(1)
  }
}
const trades = tradeRes.data
const accName = new Map(accRes.data.map((a) => [a.id, a.name]))
const assetById = new Map(assetRes.data.map((a) => [a.id, a]))
const ledgerOfTrade = new Map(ledRes.data.map((l) => [l.trade_id, l]))
const sym = (t) => assetById.get(t.asset_id)?.symbol ?? '?'
const kindOf = (t) => assetById.get(t.asset_id)?.kind ?? 'diger'

/** Yalnız fonlar — kriptoda küsuratlı adet normaldir, dokunulmaz */
const broken = trades.filter(
  (t) =>
    kindOf(t) === 'fon' &&
    Math.abs(t.quantity - Math.round(t.quantity)) > EPS &&
    (!onlySymbol || sym(t).toUpperCase() === onlySymbol)
)

if (broken.length === 0) {
  ok('Küsuratlı fon işlemi yok — düzeltilecek bir şey bulunamadı.')
  process.exit(0)
}

// Düzeltilecek fonların fiyat geçmişi — valör günü fiyatı buradan gelir
const assetIds = [...new Set(broken.map((t) => t.asset_id))]
const { data: prices, error: priceErr } = await db
  .from('asset_prices')
  .select('asset_id, date, price')
  .in('asset_id', assetIds)
  .order('date')
if (priceErr) {
  bad(priceErr.message)
  process.exit(1)
}
const priceHistory = new Map()
for (const p of prices) {
  const list = priceHistory.get(p.asset_id) ?? []
  list.push({ date: p.date, price: Number(p.price) })
  priceHistory.set(p.asset_id, list)
}

/**
 * Emir günü + valör → payın gerçekten verildiği fiyat günü.
 * Takvim günü değil **fiyat günü** sayılır; hafta sonu ve tatil kendiliğinden
 * atlanır. `--fiyat-tarihi` verilmişse o gün (ya da sonraki ilk fiyat günü).
 */
function executionPrice(assetId, tradeDate) {
  const list = priceHistory.get(assetId) ?? []
  if (forcedDate) return list.find((p) => p.date >= forcedDate) ?? null
  const after = list.filter((p) => p.date > tradeDate)
  return after[valor - 1] ?? null
}

// --------------------------------------------------------------------
// Düzeltme planı
// --------------------------------------------------------------------
head(`${email} · ${broken.length} küsuratlı fon işlemi`)
info(
  forcedDate
    ? `Fiyat günü elle verildi: ${forcedDate}`
    : `Valör: emir gününden sonraki ${valor}. fiyat günü` +
        (keepDate ? ' · işlem tarihi korunacak' : '')
)

const plan = []
for (const t of broken) {
  const symbol = sym(t)
  const account = accName.get(t.account_id) ?? '—'
  const order = Number(t.amount)
  const px = executionPrice(t.asset_id, t.trade_date)

  console.log(
    `\n  ${t.trade_date}  ${symbol}  ${t.side}  ${account}\n` +
      `    şimdi : ${num(t.quantity)} adet × ${num(t.unit_price)} = ${money(order)}`
  )

  if (t.side === 'satis') {
    // Satışta emir adet üzerinden verilir; elde olmayan küsurat satılamaz
    const shares = Math.floor(t.quantity)
    if (shares <= 0) {
      warn('    tam paya inince adet sıfırlanıyor — elle bak, atlandı')
      continue
    }
    const amount = round2(shares * Number(t.unit_price))
    plan.push({ trade: t, symbol, shares, price: Number(t.unit_price), amount, date: t.trade_date })
    console.log(`    olacak: ${shares} adet × ${num(t.unit_price)} = ${money(amount)}`)
    continue
  }

  if (!px) {
    warn(`    ${t.trade_date} sonrası ${valor}. fiyat günü yok — fiyat çekilmemiş, atlandı`)
    continue
  }
  const shares = Math.floor(order / px.price)
  if (shares <= 0) {
    warn(`    emir tutarı bir tam paya yetmiyor (${money(order)} < ${num(px.price)}) — atlandı`)
    continue
  }
  const amount = round2(shares * px.price)
  const refund = round2(order - amount)
  const date = keepDate ? t.trade_date : px.date
  plan.push({ trade: t, symbol, shares, price: px.price, amount, date, refund })
  console.log(
    `    olacak: ${shares} adet × ${num(px.price)} = ${money(amount)}  (valör ${px.date})\n` +
      `    iade  : ${money(refund)} → ${account} hesabında nakit kalır` +
      (date === t.trade_date ? '' : `\n    tarih : ${t.trade_date} → ${date}`)
  )
}

if (plan.length === 0) {
  bad('Uygulanabilir düzeltme çıkmadı.')
  process.exit(1)
}

// --------------------------------------------------------------------
// Düzeltme sonrası pozisyon — aracı kurum ekranıyla karşılaştırmak için
// --------------------------------------------------------------------
head('Düzeltme sonrası pozisyon')
const fixedById = new Map(plan.map((p) => [p.trade.id, p]))
const bySymbol = new Map()
for (const t of trades) {
  if (kindOf(t) !== 'fon') continue
  const p = fixedById.get(t.id)
  const symbol = sym(t)
  const row = bySymbol.get(symbol) ?? { qty: 0, cost: 0, touched: false }
  const qty = p ? p.shares : Number(t.quantity)
  const amount = p ? p.amount : Number(t.amount)
  if (t.side === 'alis') {
    row.qty += qty
    row.cost += amount
  } else {
    // Hareketli ortalama: satışta maliyet adet oranında düşer
    const avg = row.qty > 0 ? row.cost / row.qty : 0
    row.qty -= qty
    row.cost = Math.max(0, row.cost - qty * avg)
  }
  if (p) row.touched = true
  bySymbol.set(symbol, row)
}
for (const [symbol, row] of bySymbol) {
  if (!row.touched || row.qty <= 0) continue
  const avg = row.cost / row.qty
  console.log(
    `  ${symbol.padEnd(5)} ${String(num(row.qty, 4)).padStart(10)} adet · ort. maliyet ${num(avg)} · maliyet ${money(row.cost)}`
  )
}
info('Aracı kurum ekranındaki adet ve ortalama maliyetle karşılaştır.')

const totalRefund = plan.reduce((s, p) => s + (p.refund ?? 0), 0)
if (totalRefund > 0) info(`Hesaba geri dönen toplam: ${money(totalRefund)}`)

// --------------------------------------------------------------------
// Yazma
// --------------------------------------------------------------------
if (asSql) {
  head('SQL — Supabase SQL Editor\'e yapıştır')
  console.log('begin;')
  for (const p of plan) {
    console.log(
      `update public.trades set quantity = ${p.shares}, unit_price = ${p.price}, ` +
        `amount = ${p.amount}, trade_date = '${p.date}' where id = '${p.trade.id}';  -- ${p.symbol}`
    )
    const led = ledgerOfTrade.get(p.trade.id)
    if (!led) {
      console.log(`-- ${p.symbol}: işleme bağlı nakit hareketi yok, atlandı`)
      continue
    }
    const signed = round2((p.trade.side === 'satis' ? 1 : -1) * p.amount * (Number(p.trade.fx_rate) || 1))
    console.log(
      `update public.account_ledger set amount = ${signed}, date = '${p.date}' ` +
        `where id = '${led.id}';  -- ${p.symbol} nakit`
    )
  }
  console.log('commit;')
  process.exit(0)
}

if (!apply) {
  head('Kuru çalışma — hiçbir şey yazılmadı')
  info(`Uygulamak için: npm run fix:fon -- --user ${email} --apply`)
  info(`SQL olarak almak için: npm run fix:fon -- --user ${email} --sql`)
  process.exit(0)
}

head('Yazılıyor')
for (const p of plan) {
  const { error } = await db
    .from('trades')
    .update({
      quantity: p.shares,
      unit_price: p.price,
      amount: p.amount,
      trade_date: p.date,
    })
    .eq('id', p.trade.id)
  if (error) {
    bad(`${p.symbol} işlemi yazılamadı: ${error.message}`)
    continue
  }
  ok(`${p.symbol} · ${p.shares} adet · ${money(p.amount)} · ${p.date}`)

  // İşleme bağlı nakit hareketi de aynı tutara ve güne çekilir; yoksa
  // hesapta emir tutarı kadar para düşülmüş görünmeye devam eder.
  const led = ledgerOfTrade.get(p.trade.id)
  if (!led) {
    warn(`  ${p.symbol} işleminin nakit hareketi yok — Alım/Satım formundan bağla`)
    continue
  }
  const signed = (p.trade.side === 'satis' ? 1 : -1) * p.amount * (Number(p.trade.fx_rate) || 1)
  const { error: ledErr } = await db
    .from('account_ledger')
    .update({ amount: signed, date: p.date })
    .eq('id', led.id)
  if (ledErr) bad(`  nakit hareketi yazılamadı: ${ledErr.message}`)
  else info(`  nakit: ${money(led.amount)} → ${money(signed)}`)
}
