#!/usr/bin/env node
/**
 * Demo hesabı kurar: giriş bilgileri sabit, verisi sahte.
 *
 *   npm run seed:demo              → hesabı oluşturur / verisini tazeler
 *   npm run seed:demo -- --email x@y.z --password 123456
 *
 * Siteyi birine gösterirken kendi bakiyeni açmamak için. Veri tamamen
 * uydurma ama semboller gerçek katalogdan seçilir, böylece fiyatlar canlı
 * gelir ve sayfalar gerçek gibi çalışır.
 *
 * Tekrar çalıştırılabilir: demo kullanıcının eski verisi silinip yeniden
 * yazılır, başka kullanıcılara dokunulmaz.
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

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`)
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`)
const info = (m) => console.log(`  \x1b[90m${m}\x1b[0m`)

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}

const EMAIL = arg('email', 'test@hotmail.com')
// Not: 4 karakterlik şifre yalnızca hesabı ilk kurarken (admin createUser)
// kabul ediliyor; sonradan güncelleme "en az 6 karakter" diye reddediyor.
// Zaten kurulmuş hesapta şifre olduğu gibi kalır, sorun değil.
const PASSWORD = arg('password', 'test')
const DISPLAY = arg('name', 'Demo Hesap')

const url = process.env.VITE_SUPABASE_URL
const key = process.env.SUPABASE_SECRET_KEY
if (!url || !key) {
  bad('VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY gerekli (.env).')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

/** Insert eder, hata varsa süreci durdurur. */
async function put(table, rows) {
  if (!rows.length) return []
  const { data, error } = await db.from(table).insert(rows).select('id')
  if (error) {
    bad(`${table}: ${error.message}`)
    process.exit(1)
  }
  info(`${table}: ${data.length} kayıt`)
  return data
}

// =====================================================================
// 1. Kullanıcı
// =====================================================================
async function ensureUser() {
  const { data: list, error } = await db.auth.admin.listUsers({ perPage: 200 })
  if (error) {
    bad(`kullanıcı listesi: ${error.message}`)
    process.exit(1)
  }
  const found = list.users.find((u) => u.email?.toLowerCase() === EMAIL.toLowerCase())
  if (found) {
    // Şifre değişmiş olabilir — her koşuda sabitlensin
    const { error: updErr } = await db.auth.admin.updateUserById(found.id, {
      password: PASSWORD,
      email_confirm: true,
    })
    if (updErr && /at least/i.test(updErr.message)) info('şifre olduğu gibi bırakıldı (kurulumdaki değer geçerli)')
    else if (updErr) warn(`şifre güncellenemedi: ${updErr.message}`)
    ok(`Kullanıcı zaten var: ${EMAIL}`)
    return found.id
  }

  const { data, error: createErr } = await db.auth.admin.createUser({
    email: EMAIL,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: DISPLAY },
  })
  if (createErr) {
    bad(`kullanıcı oluşturulamadı: ${createErr.message}`)
    process.exit(1)
  }
  ok(`Kullanıcı oluşturuldu: ${EMAIL}`)
  return data.user.id
}

// =====================================================================
// 2. Eski demo verisini sil (başka kullanıcıya dokunmaz)
// =====================================================================
async function wipe(uid) {
  // Sıra önemli: çocuk tablolar önce
  const { data: snaps } = await db.from('snapshots').select('id').eq('user_id', uid)
  if (snaps?.length) {
    await db.from('positions').delete().in('snapshot_id', snaps.map((s) => s.id))
  }
  for (const t of [
    'positions', 'snapshots', 'ipo_entries', 'ipos', 'account_ledger', 'dividends',
    'corporate_actions', 'trades', 'liabilities', 'receivables', 'transactions',
    'gelir_gider', 'takip_entries', 'takip_items', 'reminders', 'accounts',
  ]) {
    const { error } = await db.from(t).delete().eq('user_id', uid)
    if (error && !/does not exist/i.test(error.message)) warn(`${t} temizlenemedi: ${error.message}`)
  }
  // Demo kendi sembolünü eklemiş olabilir — katalog (user_id null) korunur
  await db.from('assets').delete().eq('user_id', uid)
  ok('Eski demo verisi silindi')
}

// =====================================================================
// 3. Katalog sembollerini bul — fiyatları canlı gelsin diye gerçek olanlar
// =====================================================================
const SYMBOLS = ['THYAO', 'ASELS', 'EREGL', 'TUPRS', 'ENKAI', 'TP2', 'PHE', 'DFI', 'XAU', 'BTC']

async function assetIds() {
  const { data, error } = await db
    .from('assets')
    .select('id, symbol')
    .is('user_id', null)
    .in('symbol', SYMBOLS)
  if (error) {
    bad(`varlıklar okunamadı: ${error.message}`)
    process.exit(1)
  }
  const map = Object.fromEntries(data.map((a) => [a.symbol, a.id]))
  const eksik = SYMBOLS.filter((s) => !map[s])
  if (eksik.length) warn(`katalogda yok, atlanacak: ${eksik.join(', ')}`)
  return map
}

// =====================================================================
// 4. Veri
// =====================================================================
async function seed(uid) {
  const A = await assetIds()

  await db.from('profiles').update({ display_name: DISPLAY, color: '#22c55e' }).eq('id', uid)

  // ------------------------------------------------------------ hesaplar
  const accounts = [
    { name: 'Ziraat Bankası', type: 'banka', nema_rate: 0, is_ipo: false },
    { name: 'Midas', type: 'aracikurum', nema_rate: 34.5, nema_start: '2026-01-20', is_ipo: true },
    { name: 'Garanti Yatırım', type: 'aracikurum', nema_rate: 0, is_ipo: true },
    { name: 'Binance', type: 'kripto', nema_rate: 0, is_ipo: false },
    { name: 'Nakit Cüzdan', type: 'nakit', nema_rate: 0, is_ipo: false },
  ].map((a) => ({ user_id: uid, currency: 'TRY', is_active: true, ...a }))

  const { data: accRows, error: accErr } = await db.from('accounts').insert(accounts).select('id, name')
  if (accErr) {
    bad(`hesaplar: ${accErr.message}`)
    process.exit(1)
  }
  info(`accounts: ${accRows.length} kayıt`)
  const ACC = Object.fromEntries(accRows.map((a) => [a.name, a.id]))

  // ----------------------------------------------------- alım / satım
  // amount = adet × fiyat; küsurat farkı olsun diye bazıları elle yazıldı
  const T = (date, acc, sym, side, qty, price, amount) => ({
    user_id: uid,
    account_id: ACC[acc],
    asset_id: A[sym],
    side,
    trade_date: date,
    quantity: qty,
    unit_price: price,
    amount: amount ?? qty * price,
    currency: 'TRY',
    fx_rate: 1,
  })

  const trades = [
    T('2025-11-20', 'Ziraat Bankası', 'TP2', 'alis', 150000, 1.98, 297000),
    T('2026-01-08', 'Ziraat Bankası', 'PHE', 'alis', 40000, 3.55, 142000),
    T('2026-01-10', 'Garanti Yatırım', 'EREGL', 'alis', 1500, 34.2, 51300),
    T('2026-02-10', 'Midas', 'THYAO', 'alis', 200, 268.5, 53699.4),
    T('2026-02-28', 'Binance', 'BTC', 'alis', 0.15, 3180000, 477000),
    T('2026-03-05', 'Midas', 'ASELS', 'alis', 100, 352, 35200),
    T('2026-03-12', 'Ziraat Bankası', 'DFI', 'alis', 25000, 4.9, 122500),
    T('2026-04-02', 'Garanti Yatırım', 'TUPRS', 'alis', 80, 372.4, 29792),
    T('2026-05-14', 'Ziraat Bankası', 'XAU', 'alis', 30, 6240, 187200),
    T('2026-06-18', 'Midas', 'ENKAI', 'alis', 400, 76.8, 30720),
    // Satışlar — biri fon (stopaj hesabı görünsün), biri hisse
    T('2026-06-30', 'Ziraat Bankası', 'PHE', 'satis', 10000, 3.92, 39200),
    T('2026-07-22', 'Midas', 'THYAO', 'satis', 100, 295, 29500),
  ].filter((t) => t.asset_id)

  const tradeRows = await put('trades', trades)

  // ------------------------------------------------------- nakit defteri
  // Arz hesaplarında (is_ipo) alım/satım işleme trade_id ile bağlanır —
  // uygulama da böyle yazıyor. Banka/kripto hesabında nakit elle girilir,
  // o yüzden oradaki hareketler bağsız.
  const L = (acc, kind, amount, date, note, extra = {}) => ({
    user_id: uid,
    account_id: ACC[acc],
    kind,
    amount,
    date,
    note,
    ...extra,
  })

  const tradeIdAt = (i) => tradeRows[i]?.id ?? null
  const ledger = [
    // Ziraat — birikim, fon/altın alımları, bir satış, bir çekim
    L('Ziraat Bankası', 'giris', 900000, '2025-11-01', 'Birikim aktarımı'),
    L('Ziraat Bankası', 'alim', -297000, '2025-11-20', 'TP2 alışı'),
    L('Ziraat Bankası', 'alim', -142000, '2026-01-08', 'PHE alışı'),
    L('Ziraat Bankası', 'alim', -122500, '2026-03-12', 'DFI alışı'),
    L('Ziraat Bankası', 'giris', 45000, '2026-04-10', 'Maaş birikimi'),
    L('Ziraat Bankası', 'cikis', -60000, '2026-05-02', 'Ev tadilatı'),
    L('Ziraat Bankası', 'alim', -187200, '2026-05-14', 'Gram altın alışı'),
    L('Ziraat Bankası', 'satis', 39200, '2026-06-30', 'PHE satışı'),
    // Midas — arz hesabı, işlemler trade'e bağlı
    L('Midas', 'giris', 150000, '2026-01-20', 'Hesap açılışı'),
    L('Midas', 'alim', -53699.4, '2026-02-10', 'THYAO alışı', { trade_id: tradeIdAt(3) }),
    L('Midas', 'alim', -35200, '2026-03-05', 'ASELS alışı', { trade_id: tradeIdAt(5) }),
    L('Midas', 'alim', -30720, '2026-06-18', 'ENKAI alışı', { trade_id: tradeIdAt(9) }),
    L('Midas', 'satis', 29500, '2026-07-22', 'THYAO satışı', { trade_id: tradeIdAt(11) }),
    L('Midas', 'nema', 1847.32, '2026-06-30', 'Nema getirisi'),
    L('Midas', 'nema', 2140.66, '2026-07-31', 'Nema getirisi'),
    // Garanti Yatırım — arz hesabı
    L('Garanti Yatırım', 'giris', 140000, '2026-01-05', 'Hesap açılışı'),
    L('Garanti Yatırım', 'alim', -51300, '2026-01-10', 'EREGL alışı', { trade_id: tradeIdAt(2) }),
    L('Garanti Yatırım', 'alim', -29792, '2026-04-02', 'TUPRS alışı', { trade_id: tradeIdAt(7) }),
    // Binance
    L('Binance', 'giris', 500000, '2026-02-20', 'Kripto için transfer'),
    L('Binance', 'alim', -477000, '2026-02-28', 'BTC alışı'),
    // Cüzdan
    L('Nakit Cüzdan', 'giris', 15000, '2026-07-01', 'Elden nakit'),
    L('Nakit Cüzdan', 'cikis', -3500, '2026-08-03', 'Günlük harcama'),
  ]

  // ------------------------------------------- bedelsiz / bölünme, temettü
  // Bedelsiz olmadan bu pozisyon zararda görünürdü: adet iki katına
  // çıkmasına rağmen defter eski adedi biliyor olurdu.
  if (A.EREGL) {
    await put('corporate_actions', [
      { user_id: uid, asset_id: A.EREGL, action_date: '2026-05-20', kind: 'bedelsiz', ratio: 1.5, note: 'KAP: %50 bedelsiz' },
    ])
  }
  await put('dividends', [
    A.EREGL && { asset_id: A.EREGL, pay_date: '2026-04-18', quantity: 1500, gross_per_share: 2.85, gross_amount: 4275, tax_amount: 427.5, note: 'Nakit kâr payı' },
    A.TUPRS && { asset_id: A.TUPRS, pay_date: '2026-06-05', quantity: 80, gross_per_share: 21.4, gross_amount: 1712, tax_amount: 171.2, note: null },
    A.THYAO && { asset_id: A.THYAO, pay_date: '2026-03-28', quantity: 200, gross_per_share: 3.1, gross_amount: 620, tax_amount: 62, note: null },
  ].filter(Boolean).map((d) => ({ user_id: uid, account_id: ACC['Garanti Yatırım'], ...d })))

  // ------------------------------------------------------------ halka arz
  const ipos = [
    {
      user_id: uid, name: 'Kapeks Kimya Sanayi A.Ş.', bist_code: 'KPEKS',
      ipo_date: '2026-08-12', lot_price: 94, default_lot: 100, status: 'satildi',
      trade_start_date: '2026-08-19', sold_date: '2026-08-20', sold_price: 118.4,
      note: 'Gong günü satıldı',
    },
    {
      user_id: uid, name: 'Çitlekçi Mağazacılık Gıda A.Ş.', bist_code: 'CITAS',
      ipo_date: '2026-08-10', lot_price: 73.7, default_lot: 100, status: 'dagitildi',
      trade_start_date: '2026-08-18', note: 'Elde tutuluyor',
    },
    {
      user_id: uid, name: 'Teknika Plast Teknik Kalıp A.Ş.', bist_code: 'TKNKA',
      ipo_date: '2026-08-12', lot_price: 85.4, default_lot: 100, status: 'talep_verildi',
    },
  ]
  const { data: ipoRows, error: ipoErr } = await db.from('ipos').insert(ipos).select('id, bist_code')
  if (ipoErr) {
    bad(`ipos: ${ipoErr.message}`)
    process.exit(1)
  }
  info(`ipos: ${ipoRows.length} kayıt`)
  const IPO = Object.fromEntries(ipoRows.map((r) => [r.bist_code, r.id]))

  await put('ipo_entries', [
    { user_id: uid, ipo_id: IPO.KPEKS, account_id: ACC['Midas'], requested_lot: 100, participated: true, allocated_lot: 12, sold_lot: 12, sold_price: 118.4, sold_date: '2026-08-20' },
    { user_id: uid, ipo_id: IPO.KPEKS, account_id: ACC['Garanti Yatırım'], requested_lot: 100, participated: true, allocated_lot: 12, sold_lot: 12, sold_price: 118.4, sold_date: '2026-08-20' },
    { user_id: uid, ipo_id: IPO.CITAS, account_id: ACC['Midas'], requested_lot: 100, participated: true, allocated_lot: 9, sold_lot: 0 },
    { user_id: uid, ipo_id: IPO.CITAS, account_id: ACC['Garanti Yatırım'], requested_lot: 100, participated: true, allocated_lot: 9, sold_lot: 0 },
    { user_id: uid, ipo_id: IPO.TKNKA, account_id: ACC['Midas'], requested_lot: 100, participated: true, allocated_lot: 0, sold_lot: 0 },
  ])

  // Arz para hareketleri: talep bloke → dağıtılmayan iade → satış geliri
  ledger.push(
    L('Midas', 'cikis', -9400, '2026-08-12', 'KPEKS talep bloke', { ipo_id: IPO.KPEKS }),
    L('Midas', 'iade', 8272, '2026-08-15', 'KPEKS iade', { ipo_id: IPO.KPEKS }),
    L('Midas', 'satis', 1420.8, '2026-08-20', 'KPEKS satışı', { ipo_id: IPO.KPEKS }),
    L('Garanti Yatırım', 'cikis', -9400, '2026-08-12', 'KPEKS talep bloke', { ipo_id: IPO.KPEKS }),
    L('Garanti Yatırım', 'iade', 8272, '2026-08-15', 'KPEKS iade', { ipo_id: IPO.KPEKS }),
    L('Garanti Yatırım', 'satis', 1420.8, '2026-08-20', 'KPEKS satışı', { ipo_id: IPO.KPEKS }),
    L('Midas', 'cikis', -7370, '2026-08-10', 'CITAS talep bloke', { ipo_id: IPO.CITAS }),
    L('Midas', 'iade', 6707, '2026-08-14', 'CITAS iade', { ipo_id: IPO.CITAS }),
    L('Garanti Yatırım', 'cikis', -7370, '2026-08-10', 'CITAS talep bloke', { ipo_id: IPO.CITAS }),
    L('Garanti Yatırım', 'iade', 6707, '2026-08-14', 'CITAS iade', { ipo_id: IPO.CITAS }),
    L('Midas', 'cikis', -8540, '2026-08-12', 'TKNKA talep bloke', { ipo_id: IPO.TKNKA }),
  )
  await put('account_ledger', ledger)

  // ----------------------------------------------------- borç & alacak
  // Not: PostgREST toplu insert'te satırların anahtarlarını birleştirir ve
  // eksik kalanı NULL yazar — kolon varsayılanı devreye girmez. Bu yüzden
  // not-null alanlar her satırda açıkça bulunmalı.
  await put('liabilities', [
    { user_id: uid, title: 'Garanti Bonus ekstre', type: 'kredi_karti', counterparty: 'Garanti BBVA', amount: 42500, due_date: '2026-09-05' },
    { user_id: uid, title: 'Taşıt kredisi', type: 'kredi', counterparty: 'Ziraat Bankası', amount: 180000, due_date: '2026-12-01' },
    { user_id: uid, title: 'Elektrik faturası', type: 'fatura', counterparty: 'CK Enerji', amount: 1850, due_date: '2026-09-10', repeat_monthly: true },
    { user_id: uid, title: 'İnternet faturası', type: 'fatura', counterparty: 'Türk Telekom', amount: 749, due_date: '2026-09-15', repeat_monthly: true },
    { user_id: uid, title: 'Ahmet Bey borcu', type: 'kisisel_borc', counterparty: 'Ahmet Kaya', amount: 25000, due_date: '2026-10-01' },
    { user_id: uid, title: 'Kapanan kart borcu', type: 'kredi_karti', counterparty: 'Yapı Kredi', amount: 18400, due_date: '2026-07-05', is_settled: true },
  ].map((l) => ({
    currency: 'TRY', fx_rate: 1, is_settled: false, repeat_monthly: false,
    snapshot_id: null, series_id: null, last_reminded_on: null, note: null, ...l,
  })))

  await put('receivables', [
    { user_id: uid, person: 'Mehmet Yıldız', amount: 30000, given_date: '2026-06-15', expected_date: '2026-09-15', account_id: ACC['Ziraat Bankası'], note: 'Dükkân için verildi' },
    { user_id: uid, person: 'Ayşe Demir', amount: 12000, given_date: '2026-07-01', expected_date: '2026-08-01', is_collected: true, collected_date: '2026-08-05', account_id: ACC['Ziraat Bankası'], collected_account_id: ACC['Ziraat Bankası'] },
  ].map((r) => ({
    currency: 'TRY', fx_rate: 1, is_collected: false, collected_date: null,
    collected_account_id: null, expected_date: null, note: null, ...r,
  })))

  // -------------------------------------------------------- gelir / gider
  const tx = []
  for (const [i, ay] of ['05', '06', '07', '08'].entries()) {
    tx.push(
      { date: `2026-${ay}-05`, direction: 'gelir', category: 'maas', title: 'Maaş', amount: 78000 + i * 1500, account_id: ACC['Ziraat Bankası'] },
      { date: `2026-${ay}-08`, direction: 'gider', category: 'kira', title: 'Ev kirası', amount: 24000, account_id: ACC['Ziraat Bankası'] },
      { date: `2026-${ay}-12`, direction: 'gider', category: 'market', title: 'Market alışverişi', amount: 9400 + i * 320, account_id: ACC['Nakit Cüzdan'] },
      { date: `2026-${ay}-20`, direction: 'gider', category: 'fatura', title: 'Faturalar', amount: 3200 + i * 90, account_id: ACC['Ziraat Bankası'] },
    )
  }
  tx.push(
    { date: '2026-07-14', direction: 'gider', category: 'seyahat', title: 'Bodrum tatili', amount: 32000, account_id: ACC['Ziraat Bankası'] },
    { date: '2026-08-05', direction: 'gider', category: 'kk_odeme', title: 'Kredi kartı ödemesi', amount: 38200, account_id: ACC['Ziraat Bankası'] },
    { date: '2026-06-21', direction: 'gelir', category: 'diger', title: 'Freelance iş', amount: 22500, account_id: ACC['Ziraat Bankası'] },
  )
  await put('transactions', tx.map((t) => ({ user_id: uid, currency: 'TRY', fx_rate: 1, ...t })))

  await put('gelir_gider', [
    { entry_date: '2026-08-01', kind: 'gelir', title: 'Kira geliri', amount: 18000 },
    { entry_date: '2026-08-01', kind: 'gider', title: 'Aidat', amount: 2400 },
    { entry_date: '2026-07-01', kind: 'gelir', title: 'Kira geliri', amount: 18000 },
    { entry_date: '2026-07-01', kind: 'gider', title: 'Aidat', amount: 2400 },
  ].map((g) => ({ user_id: uid, ...g })))

  // ------------------------------------------------------------- takip
  const KALEMLER = ['Nakit', 'Fon', 'Hisse', 'Altın', 'Kripto']
  await put('takip_items', KALEMLER.map((name, i) => ({ user_id: uid, name, sort_order: i })))

  const takip = [
    { entry_date: '2026-05-01', items: { Nakit: 210000, Fon: 520000, Hisse: 148000, Altın: 195000, Kripto: 498000 }, debt: 240000 },
    { entry_date: '2026-06-01', items: { Nakit: 186000, Fon: 545000, Hisse: 162000, Altın: 202000, Kripto: 512000 }, debt: 236000 },
    { entry_date: '2026-07-01', items: { Nakit: 231000, Fon: 571000, Hisse: 178000, Altın: 208000, Kripto: 534000 }, debt: 252000 },
    { entry_date: '2026-08-01', items: { Nakit: 292000, Fon: 586000, Hisse: 193000, Altın: 212000, Kripto: 560000 }, debt: 250000 },
  ]
  await put('takip_entries', takip.map((t) => ({
    user_id: uid,
    ...t,
    expenses: [{ desc: 'Kira', amount: 24000 }, { desc: 'Faturalar', amount: 3200 }],
    note: 'Ay başı sayım',
  })))

  // ------------------------------------------------- anlık görüntü serisi
  // Net değer grafiği ve Geçmiş sayfası bu seriden besleniyor
  const AYLAR = [
    ['2026-01-31', 1_180_000], ['2026-02-28', 1_242_000], ['2026-03-31', 1_305_000],
    ['2026-04-30', 1_368_000], ['2026-05-31', 1_421_000], ['2026-06-30', 1_487_000],
    ['2026-07-31', 1_528_000], ['2026-08-20', 1_553_000],
  ]
  const { data: snapRows, error: snapErr } = await db
    .from('snapshots')
    .insert(AYLAR.map(([d]) => ({ user_id: uid, snapshot_date: d, note: 'Ay sonu sayımı' })))
    .select('id, snapshot_date')
  if (snapErr) {
    bad(`snapshots: ${snapErr.message}`)
    process.exit(1)
  }
  info(`snapshots: ${snapRows.length} kayıt`)

  // Toplamı türlere dağıt — oranlar sabit, tutar aydan aya büyüyor
  const DAGILIM = [
    ['TP2', 'Ziraat Bankası', 0.21], ['DFI', 'Ziraat Bankası', 0.09],
    ['PHE', 'Ziraat Bankası', 0.08], ['XAU', 'Ziraat Bankası', 0.14],
    ['BTC', 'Binance', 0.36], ['THYAO', 'Midas', 0.04],
    ['ASELS', 'Midas', 0.03], ['EREGL', 'Garanti Yatırım', 0.05],
  ]
  const positions = []
  for (const s of snapRows) {
    const toplam = AYLAR.find(([d]) => d === s.snapshot_date)[1]
    for (const [sym, acc, pay] of DAGILIM) {
      if (!A[sym]) continue
      positions.push({
        snapshot_id: s.id, user_id: uid, account_id: ACC[acc], asset_id: A[sym],
        amount: Math.round(toplam * pay), currency: 'TRY', fx_rate: 1,
      })
    }
  }
  await put('positions', positions)

  // -------------------------------------------------------- hatırlatıcılar
  // Tarihler bilerek ileride: demo hesabın gerçek adresi olmadığı için
  // hatırlatma tetiklenirse gönderim hata verir ve cron her 15 dakikada bir
  // yeniden dener. Biri de "gönderilmiş" halde ki sayfanın iki bölümü de
  // dolu görünsün.
  await put('reminders', [
    { user_id: uid, title: 'Kira ödemesi', body: 'Ev sahibine EFT yap, dekontu ilet.', next_date: '2027-09-08', send_time: '09:00', repeat_mode: 'monthly', is_active: true, last_sent_on: null },
    { user_id: uid, title: 'Kredi kartı ekstresi', body: 'Son ödeme tarihi yaklaşıyor.', next_date: '2027-09-03', send_time: '10:30', repeat_mode: 'monthly', is_active: true, last_sent_on: null },
    { user_id: uid, title: 'Vergi beyannamesi', body: 'Muhasebeciyi ara.', next_date: '2026-07-25', send_time: '14:00', repeat_mode: 'once', is_active: false, last_sent_on: '2026-07-25' },
  ])
}

// =====================================================================
const uid = await ensureUser()
await wipe(uid)
await seed(uid)
console.log()
ok('Demo hesabı hazır')
info(`e-posta : ${EMAIL}`)
info(`şifre   : ${PASSWORD}`)
