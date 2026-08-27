#!/usr/bin/env node
/**
 * Halka arz talep blokelerini deftere geriye dönük yazar.
 *   npm run fix:ipo -- --user eposta@ornek.com            (kuru çalışma, hiçbir şey yazmaz)
 *   npm run fix:ipo -- --user eposta@ornek.com --apply    (yazar)
 *
 * Neden gerekli: defter bu sürümden önce arzın yalnızca dönüş tarafını
 * tutuyordu. Dağıtımda geri yatan tutar "iade" olarak (+) yazılıyor, ama
 * talebi verirken hesaptan bloke edilen para hiçbir yere yazılmıyordu.
 * Sonuç: hesapta zaten duran parayla arza girdiğinde iade yoktan var olmuş
 * yeni para gibi görünüyor ve bakiye iade kadar şişiyordu.
 *
 * Betik üç şey yapar:
 *
 *   1. Elle yazılmış blokeleri tanır. "CITAS talep bloke" gibi notlarla ya da
 *      düpedüz "Dışarı çıkış" olarak girilmiş `cikis` satırlarını, tutarı ve
 *      tarihi arzın talebiyle örtüşüyorsa `talep` türüne çevirip arza bağlar.
 *      Tutar değişmez — yalnızca tür değişir, böylece o para "kayboldu"
 *      değil "arzda bloke" sayılır ve net varlıktan düşmez.
 *
 *   2. Hiç blokesi olmayan arzlara `talep` satırı yazar (istenen lot × lot
 *      fiyatı, eksi olarak).
 *
 *   3. Bloke yazılınca bakiyesi eksiye düşen hesaplara, açık kadar `giris`
 *      satırı ekler — "hesapta kayda geçmemiş para varmış" varsayımı.
 *      İstemiyorsan --no-acilis ile kapat, hesap eksi bakiyede kalır ve
 *      doğru kaynağı uygulamadaki "Talep karşılığı" ekranından seçersin.
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
const openingBalance = !flag('no-acilis')
/** Tutar eşleşmesinde kabul edilen kuruş farkı */
const EPS = 0.005
/** Elle yazılmış blokeyi arzla eşleştirirken kabul edilen gün farkı */
const DAY_WINDOW = Number(arg('gun') ?? 7)

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
const [ipoRes, entryRes, accRes, ledRes] = await Promise.all([
  db.from('ipos').select('*').eq('user_id', userId),
  db.from('ipo_entries').select('*').eq('user_id', userId),
  db.from('accounts').select('id, name').eq('user_id', userId),
  db.from('account_ledger').select('*').eq('user_id', userId).order('date'),
])
for (const r of [ipoRes, entryRes, accRes, ledRes]) {
  if (r.error) {
    bad(r.error.message)
    process.exit(1)
  }
}
const ipos = ipoRes.data
const entries = entryRes.data
const ledger = ledRes.data
const accName = new Map(accRes.data.map((a) => [a.id, a.name]))
const name = (id) => accName.get(id) ?? id.slice(0, 8)

/** Arz × hesap → bu arzın o hesaba yazdığı talep satırı */
const talepKey = (ipoId, accountId) => `${ipoId}:${accountId}`
const existingTalep = new Map()
for (const l of ledger) {
  if (l.kind === 'talep' && l.ipo_id) existingTalep.set(talepKey(l.ipo_id, l.account_id), l)
}

// --------------------------------------------------------------------
// 1) Elle yazılmış blokeleri tanı ve `talep`e çevir
//
// İki tür aday var:
//
//   • Arza zaten bağlı `cikis` satırı. Uygulamanın "dışarı çıkış" akışıyla
//     arz seçiliyken yazılmış — bağ zaten kurulmuş, tür yanlış. Bunda tarih
//     penceresi aranmaz, bağ yeterli. Bunları atlamak tehlikeli olurdu:
//     aynı talep için ikinci bir bloke daha yazılır, para iki kez düşerdi.
//
//   • Arza bağlanmamış `cikis` satırı. Burada eşleşme bilerek dar: aynı
//     hesap, tutar kuruşu kuruşuna talebin tutarı ve tarih arzın talep
//     gününe en fazla birkaç gün uzak. Üçü birden tutmuyorsa dokunulmaz —
//     yanlış satırı arza bağlamaktansa elde bırakmak yeğdir.
//
// Bağlı ama tutarı tutmayan satır çevrilir, tutarına dokunulmaz ve uyarı
// basılır; o hesaba ikinci bloke yazılmaz.
// --------------------------------------------------------------------
const converts = []
const usedRows = new Set()

for (const ipo of ipos) {
  const lotPrice = Number(ipo.lot_price ?? 0)
  if (!(lotPrice > 0) || !ipo.ipo_date) continue
  for (const e of entries.filter((x) => x.ipo_id === ipo.id && x.participated)) {
    if (existingTalep.has(talepKey(ipo.id, e.account_id))) continue
    const required = round2(Number(e.requested_lot) * lotPrice)
    if (!(required > EPS)) continue

    const candidates = ledger.filter(
      (l) =>
        !usedRows.has(l.id) &&
        l.kind === 'cikis' &&
        l.account_id === e.account_id &&
        (l.ipo_id === ipo.id ||
          (!l.ipo_id &&
            Math.abs(Math.abs(Number(l.amount)) - required) < EPS &&
            dayDiff(l.date, ipo.ipo_date) <= DAY_WINDOW))
    )
    // Tutarı tutan aday varsa o seçilir; yoksa arza bağlı olan alınır
    const match =
      candidates.find((l) => Math.abs(Math.abs(Number(l.amount)) - required) < EPS) ?? candidates[0]
    if (!match) continue
    usedRows.add(match.id)
    converts.push({
      row: match,
      ipo,
      required,
      mismatch: Math.abs(Math.abs(Number(match.amount)) - required) >= EPS,
    })
    existingTalep.set(talepKey(ipo.id, e.account_id), { ...match, kind: 'talep', ipo_id: ipo.id })
  }
}

head('1) Elle yazılmış blokeler → talep')
if (!converts.length) info('Çevrilecek satır yok.')
for (const c of converts) {
  console.log(
    `  ${c.row.date}  ${name(c.row.account_id).padEnd(16)} ${money(c.row.amount).padStart(14)}  ` +
      `cikis → talep  (${c.ipo.bist_code ?? c.ipo.name})  «${c.row.note ?? ''}»`
  )
  if (c.mismatch) {
    info(`  ↑ tutar talebe uymuyor (talep ${money(c.required)}) — tutara dokunulmuyor, elle kontrol et`)
  }
}

// Arza bağlı kalmış ama hiçbir talebe eşleşmeyen çıkışlar — sessizce
// bırakmak yerine göster, çünkü büyük ihtimalle onlar da bloke.
const orphans = ledger.filter((l) => l.kind === 'cikis' && l.ipo_id && !usedRows.has(l.id))
if (orphans.length) {
  console.log('')
  info('Arza bağlı olup eşleşmeyen çıkışlar (elle bak):')
  for (const l of orphans) {
    const ipo = ipos.find((i) => i.id === l.ipo_id)
    console.log(
      `  ${l.date}  ${name(l.account_id).padEnd(16)} ${money(l.amount).padStart(14)}  ` +
        `(${ipo?.bist_code ?? ipo?.name ?? l.ipo_id.slice(0, 8)})  «${l.note ?? ''}»`
    )
  }
}

// --------------------------------------------------------------------
// 2) Hiç blokesi olmayan katılımlara `talep` yaz
// --------------------------------------------------------------------
const inserts = []
for (const ipo of ipos) {
  const lotPrice = Number(ipo.lot_price ?? 0)
  if (!(lotPrice > 0)) continue
  for (const e of entries.filter((x) => x.ipo_id === ipo.id && x.participated)) {
    if (existingTalep.has(talepKey(ipo.id, e.account_id))) continue
    const required = round2(Number(e.requested_lot) * lotPrice)
    if (!(required > EPS)) continue
    inserts.push({
      user_id: userId,
      account_id: e.account_id,
      ipo_id: ipo.id,
      kind: 'talep',
      amount: -required,
      date: ipo.ipo_date ?? new Date().toISOString().slice(0, 10),
      note: `${ipo.name} — talep bloke`,
    })
  }
}

head('2) Eksik talep blokeleri')
if (!inserts.length) info('Eksik bloke yok.')
for (const r of inserts) {
  const ipo = ipos.find((i) => i.id === r.ipo_id)
  console.log(
    `  ${r.date}  ${name(r.account_id).padEnd(16)} ${money(r.amount).padStart(14)}  ` +
      `yeni talep  (${ipo?.bist_code ?? ipo?.name})`
  )
}

// --------------------------------------------------------------------
// 3) Bloke yazılınca eksiye düşen hesaplar
//
// Talep, hesapta o gün gerçekten duran paradan karşılanmış olmalı. Bakiye
// yetmiyorsa defterde eksik bir giriş var demektir.
//
// Bakılan şey son bakiye değil, yürüyen bakiyenin **en dip noktası**: hesap
// yalnızca bugün değil geçmişte de hiçbir gün eksiye düşmemeli. Furkan'ın
// defteri bunun neden önemli olduğunu gösteriyor — CITAS satışı geldiğinde
// bakiyesi artıya dönüyor ama satıştan önceki talebi karşılayacak parası
// görünmüyor. Açılış girişi dibin kapatacağı kadar, ilk hareketten bir gün
// önceye yazılır; hesapta o para zaten vardı, sadece kayda geçmemişti.
//
// Aynı gün içinde önce giren para sayılır (satış geldi, sonra talep bloke
// edildi) — hem fiziksel olarak doğru sıralama bu, hem de gün içindeki
// geçici dip uydurma açık yaratmaz.
// --------------------------------------------------------------------
const perAccount = new Map()
const track = (accountId, row) => {
  const list = perAccount.get(accountId)
  if (list) list.push(row)
  else perAccount.set(accountId, [row])
}
for (const l of ledger) track(l.account_id, { date: l.date, amount: Number(l.amount) })
for (const r of inserts) track(r.account_id, { date: r.date, amount: r.amount })
// converts yalnızca tür değiştirir, tutar aynı kalır — bakiyeyi etkilemez

const after = new Map()
const opens = []
for (const [accountId, rows] of perAccount) {
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

head('3) Bloke yazılınca eksiye düşen hesaplar')
if (!opens.length) info('Bütün hesaplarda talep kendi parasından karşılanıyor.')
else if (!openingBalance) info('--no-acilis verildi; açılış girişi yazılmayacak, hesaplar eksi kalacak.')
for (const r of opens) {
  console.log(
    `  ${r.date}  ${name(r.account_id).padEnd(16)} ${money(r.amount).padStart(14)}  ` +
      `açılış bakiyesi${openingBalance ? '' : '  (yazılmayacak)'}`
  )
}

// --------------------------------------------------------------------
// Özet ve yazma
// --------------------------------------------------------------------
head('Özet')
const totalTalep = round2(
  inserts.reduce((s, r) => s + -r.amount, 0) + converts.reduce((s, c) => s + c.required, 0)
)
info(`${converts.length} satır çevrilecek · ${inserts.length} bloke yazılacak · toplam ${money(totalTalep)}`)
if (openingBalance && opens.length) {
  info(`${opens.length} hesaba toplam ${money(opens.reduce((s, r) => s + r.amount, 0))} açılış girişi`)
}

const before = new Map()
for (const l of ledger) before.set(l.account_id, (before.get(l.account_id) ?? 0) + Number(l.amount))
const touched = new Set([
  ...inserts.map((r) => r.account_id),
  ...converts.map((c) => c.row.account_id),
  ...opens.map((r) => r.account_id),
])
if (touched.size) {
  head('Bakiye — önce → sonra')
  for (const id of [...touched].sort((a, b) => name(a).localeCompare(name(b), 'tr'))) {
    const now = round2(before.get(id) ?? 0)
    const opening = openingBalance ? opens.find((o) => o.account_id === id)?.amount ?? 0 : 0
    const next = round2((after.get(id) ?? 0) + opening)
    console.log(`  ${name(id).padEnd(16)} ${money(now).padStart(14)}  →  ${money(next).padStart(14)}`)
  }
}

if (!apply) {
  console.log('')
  info('Kuru çalışma — hiçbir şey yazılmadı. Uygulamak için --apply ekle.')
  process.exit(0)
}

console.log('')
for (const c of converts) {
  const { error } = await db
    .from('account_ledger')
    .update({ kind: 'talep', ipo_id: c.ipo.id, note: `${c.ipo.name} — talep bloke` })
    .eq('id', c.row.id)
  if (error) {
    bad(`${name(c.row.account_id)} çevrilemedi: ${error.message}`)
    process.exit(1)
  }
}
if (converts.length) ok(`${converts.length} satır talep türüne çevrildi`)

if (inserts.length) {
  const { error } = await db.from('account_ledger').insert(inserts)
  if (error) {
    bad(`Bloke yazılamadı: ${error.message}`)
    process.exit(1)
  }
  ok(`${inserts.length} talep blokesi yazıldı`)
}

if (openingBalance && opens.length) {
  const { error } = await db.from('account_ledger').insert(opens)
  if (error) {
    bad(`Açılış girişi yazılamadı: ${error.message}`)
    process.exit(1)
  }
  ok(`${opens.length} hesaba açılış girişi yazıldı`)
}

ok('Tamam. Uygulamayı yenile — bakiyeler ve net varlık düzelmiş olmalı.')
