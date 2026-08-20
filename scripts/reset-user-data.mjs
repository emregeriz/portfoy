#!/usr/bin/env node
/**
 * Bir kullanıcının tüm portföy verisini siler.
 *   npm run reset:user -- --user eposta@ornek.com          → kuru çalışma (sadece sayar)
 *   npm run reset:user -- --user eposta@ornek.com --yes    → gerçekten siler
 *   ... --keep-definitions   → hesaplar, varlıklar ve takip kalemleri korunur
 *
 * .env dosyasındaki VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY kullanılır.
 * SUPABASE_SECRET_KEY'e VITE_ öneki KOYMA — Vite onu tarayıcı paketine gömer.
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
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : null
}
const has = (name) => argv.includes(`--${name}`)

const email = arg('user')
const commit = has('yes')
const keepDefs = has('keep-definitions')

const url = process.env.VITE_SUPABASE_URL
const secret = process.env.SUPABASE_SECRET_KEY

if (!email) {
  bad('Kullanıcı belirtilmedi.  --user eposta@ornek.com')
  process.exit(1)
}
if (!url || !secret) {
  bad('.env eksik: VITE_SUPABASE_URL ve SUPABASE_SECRET_KEY gerekli.')
  info('SUPABASE_SECRET_KEY = Supabase panelindeki secret / service_role anahtarı.')
  info('VITE_ öneki kullanma; o anahtar tarayıcıya gitmemeli.')
  process.exit(1)
}

/** Hareket kayıtları — FK sırasına göre, çocuklar önce */
const DATA_TABLES = [
  'positions', 'liabilities', 'receivables', 'transactions',
  'ipo_participations', 'ipo_entries', 'account_ledger', 'ipos',
  'snapshots', 'takip_entries', 'gelir_gider', 'reminders',
]
/** Tanım kayıtları — --keep-definitions ile atlanır */
const DEF_TABLES = ['takip_items', 'accounts', 'assets']

const tables = keepDefs ? DATA_TABLES : [...DATA_TABLES, ...DEF_TABLES]

const supabase = createClient(url, secret, { auth: { persistSession: false } })

// --- Kullanıcıyı bul ---------------------------------------------------
const { data: list, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 })
if (listErr) {
  bad(`Kullanıcı listesi alınamadı: ${listErr.message}`)
  info('Anahtar secret/service_role değilse bu adım başarısız olur.')
  process.exit(1)
}
const target = list.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
if (!target) {
  bad(`Kullanıcı bulunamadı: ${email}`)
  info(`Mevcut kullanıcılar: ${list.users.map((u) => u.email).join(', ')}`)
  process.exit(1)
}
ok(`Hedef kullanıcı: ${target.email}`)
info(`id: ${target.id}`)
info(keepDefs ? 'Tanımlar korunacak (hesaplar, varlıklar, takip kalemleri)' : 'Tanımlar dahil tam temizlik')
console.log()

// --- Sayım ------------------------------------------------------------
let total = 0
const counts = {}
for (const t of tables) {
  const { count, error } = await supabase
    .from(t)
    .select('id', { count: 'exact', head: true })
    .eq('user_id', target.id)
  if (error) {
    warn(`${t} — sayılamadı: ${error.message}`)
    counts[t] = null
    continue
  }
  counts[t] = count ?? 0
  total += count ?? 0
  console.log(`  ${t.padEnd(20)} ${String(count ?? 0).padStart(5)}`)
}
console.log()

if (total === 0) {
  ok('Silinecek kayıt yok — kullanıcı zaten temiz.')
  process.exit(0)
}

if (!commit) {
  warn(`Kuru çalışma. Toplam ${total} kayıt silinecek.`)
  info('Gerçekten silmek için komuta --yes ekle.')
  process.exit(0)
}

// --- Silme ------------------------------------------------------------
console.log('Siliniyor...\n')
let deleted = 0
for (const t of tables) {
  if (!counts[t]) continue
  const { error } = await supabase.from(t).delete().eq('user_id', target.id)
  if (error) {
    bad(`${t} — ${error.message}`)
    continue
  }
  deleted += counts[t]
  ok(`${t.padEnd(20)} ${counts[t]} kayıt silindi`)
}

console.log()
ok(`Bitti — ${deleted} kayıt silindi. Giriş bilgileri ve profil korundu.`)
