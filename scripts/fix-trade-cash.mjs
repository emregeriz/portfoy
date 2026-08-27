#!/usr/bin/env node
/**
 * Alım/satım işlemlerinin parasını nakit defterine geriye dönük işler.
 *   npm run fix:trade -- --user eposta@ornek.com            (kuru çalışma)
 *   npm run fix:trade -- --user eposta@ornek.com --apply    (yazar)
 *
 * Neden gerekli: nakit bağı bugüne kadar yalnızca halka arz hesaplarında
 * çalışıyordu. Kendi hesabında (Midas, Ziraat…) hisse ya da fon sattığında
 * para hiçbir yere yazılmıyor, satıştan gelen tutar kayboluyordu. Elle
 * "nakit girişi" yazmak da işi çözmüyor: o satır işleme bağlı olmadığı için
 * işlem silinse bile duruyor ve ileride otomatik hareket yazıldığında para
 * iki kez sayılıyor.
 *
 * Betik üç şey yapar:
 *
 *   1. İşlemin yerine elle yazılmış `giris` satırlarını tanır ve siler —
 *      yerine işleme bağlı `satis` satırı yazılacağı için ikisi bir arada
 *      kalırsa para iki kez sayılırdı. Eşleşme dar: aynı hesap, aynı tutar,
 *      satış gününe birkaç gün mesafede.
 *
 *   2. Nakde hiç işlenmemiş işlemlere hareket yazar; satış (+), alış (−).
 *      Para işlemin yapıldığı hesaba yazılır.
 *
 *   3. Alışlar düşülünce geçmişte eksiye düşen hesaplara, dibi kapatacak
 *      kadar `giris` satırı ekler — o para hesapta zaten vardı, sadece
 *      kayda geçmemişti. İstemiyorsan --no-acilis ile kapat.
 *
 * Yalnızca satışları işlemek için --no-alis ver; ama alışlar düşülmezse
 * hesaptaki nakit gerçekte olduğundan yüksek görünür.
 *
 * Tek bir işlemi düzeltmek için daralt:
 *   --sembol TP2 --tarih 2026-08-26   (ikisi de isteğe bağlı, birlikte çalışır)
 *   --hesap Midas
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
const flag = (name) => argv.includes(`--${name}`)

const email = arg('user')
const apply = flag('apply')
const withBuys = !flag('no-alis')
const openingBalance = !flag('no-acilis')
/** Elle yazılmış girişi satışla eşleştirirken kabul edilen gün farkı */
const DAY_WINDOW = Number(arg('gun') ?? 3)
/** Tek işlemi hedeflemek için daraltıcılar — verilmezse hepsi işlenir */
const onlySymbol = arg('sembol')?.toUpperCase() ?? null
const onlyDate = arg('tarih') ?? null
const onlyAccount = arg('hesap')?.toLocaleLowerCase('tr') ?? null
const EPS = 0.005

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
const round2 = (n) => Math.round(n * 100) / 100
const dayDiff = (a, b) => Math.abs((new Date(a) - new Date(b)) / 86_400_000)
const shiftDay = (d, n) => new Date(new Date(d).getTime() + n * 86_400_000).toISOString().slice(0, 10)

// --------------------------------------------------------------------
// Veri
// --------------------------------------------------------------------
const [tradeRes, accRes, assetRes, ledRes] = await Promise.all([
  db.from('trades').select('*').eq('user_id', userId).order('trade_date'),
  db.from('accounts').select('id, name').eq('user_id', userId),
  db.from('assets').select('id, symbol'),
  db.from('account_ledger').select('*').eq('user_id', userId).order('date'),
])
for (const r of [tradeRes, accRes, assetRes, ledRes]) {
  if (r.error) {
    bad(r.error.message)
    process.exit(1)
  }
}
const trades = tradeRes.data
const ledger = ledRes.data
const accName = new Map(accRes.data.map((a) => [a.id, a.name]))
const symbolOf = new Map(assetRes.data.map((a) => [a.id, a.symbol]))
const name = (id) => accName.get(id) ?? String(id).slice(0, 8)
const sym = (t) => symbolOf.get(t.asset_id) ?? 'hisse'

const linked = new Set(ledger.filter((l) => l.trade_id).map((l) => l.trade_id))
/** Nakde hiç işlenmemiş, hesabı belli ve daraltıcılara uyan işlemler */
const pending = trades.filter(
  (t) =>
    !linked.has(t.id) &&
    t.account_id &&
    (withBuys || t.side === 'satis') &&
    (!onlySymbol || sym(t).toUpperCase() === onlySymbol) &&
    (!onlyDate || t.trade_date === onlyDate) &&
    (!onlyAccount || name(t.account_id).toLocaleLowerCase('tr').includes(onlyAccount))
)

if (onlySymbol || onlyDate || onlyAccount) {
  const parts = [onlySymbol && `sembol=${onlySymbol}`, onlyDate && `tarih=${onlyDate}`, onlyAccount && `hesap~${onlyAccount}`]
  info(`Daraltıldı: ${parts.filter(Boolean).join(' · ')} → ${pending.length} işlem`)
}

// --------------------------------------------------------------------
// 1) İşlemin yerine elle yazılmış girişleri bul
//
// Bunlar silinmeli: yerine işleme bağlı `satis` satırı yazılacak. İkisi bir
// arada kalırsa aynı satış iki kez para yazar. Eşleşme bilerek dar tutuldu —
// aynı hesap, tutar kuruşu kuruşuna aynı, tarih satış gününe birkaç gün
// mesafede. Tutmayan hiçbir girişe dokunulmaz.
// --------------------------------------------------------------------
const dupes = []
const usedRows = new Set()
for (const t of pending) {
  if (t.side !== 'satis') continue
  const amountTry = round2(Number(t.amount_try ?? Number(t.amount) * Number(t.fx_rate || 1)))
  const match = ledger.find(
    (l) =>
      !usedRows.has(l.id) &&
      l.kind === 'giris' &&
      !l.trade_id &&
      !l.ipo_id &&
      l.account_id === t.account_id &&
      Math.abs(Number(l.amount) - amountTry) < EPS &&
      dayDiff(l.date, t.trade_date) <= DAY_WINDOW
  )
  if (!match) continue
  usedRows.add(match.id)
  dupes.push({ row: match, trade: t })
}

head('1) İşlemin yerine elle yazılmış girişler → silinecek')
if (!dupes.length) info('Elle yazılmış karşılık yok.')
for (const d of dupes) {
  console.log(
    `  ${d.row.date}  ${name(d.row.account_id).padEnd(16)} ${money(d.row.amount).padStart(14)}  ` +
      `«${d.row.note ?? ''}»  →  ${sym(d.trade)} satışına bağlanacak`
  )
}

// --------------------------------------------------------------------
// 2) Nakde işlenmemiş işlemler
// --------------------------------------------------------------------
const inserts = pending.map((t) => {
  const amountTry = round2(Number(t.amount_try ?? Number(t.amount) * Number(t.fx_rate || 1)))
  return {
    user_id: userId,
    account_id: t.account_id,
    trade_id: t.id,
    kind: t.side === 'satis' ? 'satis' : 'alim',
    amount: t.side === 'satis' ? amountTry : -amountTry,
    date: t.trade_date,
    note: `${sym(t)} ${t.side === 'satis' ? 'satışı' : 'alışı'}`,
  }
})

head(`2) Nakde işlenmemiş işlemler${withBuys ? '' : ' (yalnızca satışlar)'}`)
if (!inserts.length) info('Bütün işlemler zaten nakde işlenmiş.')
for (const r of inserts) {
  console.log(
    `  ${r.date}  ${name(r.account_id).padEnd(16)} ${money(r.amount).padStart(14)}  ${r.kind}  «${r.note}»`
  )
}

// --------------------------------------------------------------------
// 3) Eksiye düşen hesaplar — yürüyen bakiyenin dibi kadar açılış girişi
// --------------------------------------------------------------------
const perAccount = new Map()
const track = (accountId, row) => {
  const l = perAccount.get(accountId)
  if (l) l.push(row)
  else perAccount.set(accountId, [row])
}
for (const l of ledger) {
  if (usedRows.has(l.id)) continue // silinecek
  track(l.account_id, { date: l.date, amount: Number(l.amount) })
}
for (const r of inserts) track(r.account_id, { date: r.date, amount: r.amount })

const after = new Map()
const opens = []
for (const [accountId, rows] of perAccount) {
  // Aynı gün önce giren para sayılır — satış geldi, sonra alış yapıldı
  rows.sort((a, b) => (a.date === b.date ? b.amount - a.amount : a.date.localeCompare(b.date)))
  let running = 0
  let low = 0
  for (const r of rows) {
    running += r.amount
    if (running < low) low = running
  }
  after.set(accountId, round2(running))
  if (low >= -EPS) continue
  opens.push({
    user_id: userId,
    account_id: accountId,
    kind: 'giris',
    amount: round2(-low),
    date: shiftDay(rows[0].date, -1),
    note: 'Kayıt öncesi hesap bakiyesi',
  })
}
opens.sort((a, b) => name(a.account_id).localeCompare(name(b.account_id), 'tr'))

head('3) İşlemler düşülünce eksiye düşen hesaplar')
if (!opens.length) info('Hiçbir hesap eksiye düşmüyor.')
else if (!openingBalance) info('--no-acilis verildi; açılış girişi yazılmayacak, hesaplar eksi kalacak.')
for (const r of opens) {
  console.log(
    `  ${r.date}  ${name(r.account_id).padEnd(16)} ${money(r.amount).padStart(14)}  ` +
      `açılış bakiyesi${openingBalance ? '' : '  (yazılmayacak)'}`
  )
}

// --------------------------------------------------------------------
// Özet
// --------------------------------------------------------------------
head('Özet')
const sells = inserts.filter((r) => r.kind === 'satis')
const buys = inserts.filter((r) => r.kind === 'alim')
info(
  `${dupes.length} elle giriş silinecek · ${sells.length} satış (+${money(
    sells.reduce((s, r) => s + r.amount, 0)
  )}) · ${buys.length} alış (${money(buys.reduce((s, r) => s + r.amount, 0))})`
)
if (openingBalance && opens.length) {
  info(`${opens.length} hesaba toplam ${money(opens.reduce((s, r) => s + r.amount, 0))} açılış girişi`)
}

const before = new Map()
for (const l of ledger) before.set(l.account_id, (before.get(l.account_id) ?? 0) + Number(l.amount))
const touched = new Set([
  ...inserts.map((r) => r.account_id),
  ...dupes.map((d) => d.row.account_id),
  ...opens.map((r) => r.account_id),
])
if (touched.size) {
  head('Bakiye — önce → sonra')
  for (const id of [...touched].sort((a, b) => name(a).localeCompare(name(b), 'tr'))) {
    const now = round2(before.get(id) ?? 0)
    const opening = openingBalance ? opens.find((o) => o.account_id === id)?.amount ?? 0 : 0
    const next = round2((after.get(id) ?? 0) + opening)
    console.log(`  ${name(id).padEnd(18)} ${money(now).padStart(15)}  →  ${money(next).padStart(15)}`)
  }
}

if (!apply) {
  console.log('')
  info('Kuru çalışma — hiçbir şey yazılmadı. Uygulamak için --apply ekle.')
  process.exit(0)
}

console.log('')
if (dupes.length) {
  const { error } = await db
    .from('account_ledger')
    .delete()
    .in('id', dupes.map((d) => d.row.id))
  if (error) {
    bad(`Elle giriş silinemedi: ${error.message}`)
    process.exit(1)
  }
  ok(`${dupes.length} elle yazılmış giriş silindi`)
}

if (inserts.length) {
  const { error } = await db.from('account_ledger').insert(inserts)
  if (error) {
    bad(`Nakit hareketi yazılamadı: ${error.message}`)
    process.exit(1)
  }
  ok(`${inserts.length} işlem nakde işlendi`)
}

if (openingBalance && opens.length) {
  const { error } = await db.from('account_ledger').insert(opens)
  if (error) {
    bad(`Açılış girişi yazılamadı: ${error.message}`)
    process.exit(1)
  }
  ok(`${opens.length} hesaba açılış girişi yazıldı`)
}

ok('Tamam. Uygulamayı yenile.')
