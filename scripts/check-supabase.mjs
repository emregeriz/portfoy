#!/usr/bin/env node
/**
 * Supabase bağlantısını ve şemayı doğrular.
 *   npm run check:supabases
 * .env dosyasındaki VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY değerlerini kullanır.
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
const key = process.env.VITE_SUPABASE_ANON_KEY

const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`)
const bad = (m) => console.log(`\x1b[31m✗\x1b[0m ${m}`)
const info = (m) => console.log(`  \x1b[90m${m}\x1b[0m`)

if (!url || !key) {
  bad('.env eksik: VITE_SUPABASE_URL ve VITE_SUPABASE_ANON_KEY doldurulmalı.')
  process.exit(1)
}
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
  bad(`VITE_SUPABASE_URL beklenen formatta değil: ${url}`)
  info('Beklenen: https://xxxxxxxx.supabase.co')
  process.exit(1)
}
ok(`Proje URL: ${url}`)

const supabase = createClient(url, key)

const TABLES = [
  'profiles', 'accounts', 'assets', 'snapshots', 'positions',
  'liabilities', 'receivables', 'transactions', 'ipo_participations', 'fx_rates',
]
const VIEWS = ['v_snapshot_totals', 'v_net_worth']

let failed = false

// 1) Bağlantı + şema
for (const name of [...TABLES, ...VIEWS]) {
  const { error } = await supabase.from(name).select('*', { count: 'exact', head: true })
  if (error) {
    // RLS okuma politikası authenticated'a verildiği için anon 401/permission alabilir;
    // "relation does not exist" ise şema kurulmamış demektir.
    if (/does not exist|schema cache/i.test(error.message)) {
      bad(`${name} — bulunamadı. supabase/schema.sql çalıştırıldı mı?`)
      failed = true
    } else {
      ok(`${name} — var (anon erişimi RLS ile kapalı, beklenen)`)
    }
  } else {
    ok(`${name} — var`)
  }
}

// 2) Auth uç noktası
const { error: authError } = await supabase.auth.getSession()
if (authError) {
  bad(`Auth erişimi başarısız: ${authError.message}`)
  failed = true
} else {
  ok('Auth uç noktası yanıt veriyor')
}

// 3) Kayıt kapalı mı
const probeEmail = `probe_${Math.random().toString(36).slice(2)}@example.com`
const { error: signUpError } = await supabase.auth.signUp({
  email: probeEmail,
  password: 'Aa1!' + Math.random().toString(36).slice(2),
})
if (signUpError && /signup|disabled|not allowed/i.test(signUpError.message)) {
  ok('E-posta ile kayıt kapalı (doğru yapılandırma)')
} else if (signUpError) {
  info(`Kayıt denemesi hata verdi: ${signUpError.message}`)
} else {
  bad('DİKKAT: E-posta ile kayıt AÇIK. Authentication → Providers → Email → signup kapat.')
  info(`Oluşan test kullanıcısını sil: ${probeEmail}`)
  failed = true
}

console.log()
if (failed) {
  bad('Bazı kontroller başarısız. Yukarıdaki adımları tamamla.')
  process.exit(1)
}
ok('Supabase bağlantısı hazır. npm run dev ile giriş yapabilirsin.')
