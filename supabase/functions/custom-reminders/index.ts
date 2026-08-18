// =====================================================================
// custom-reminders — kullanıcının kendi yazdığı hatırlatmaları maille
//
// 15 dakikada bir çalışır; tarihi VE saati gelmiş aktif hatırlatmalar için
// ayrı ayrı mail gönderir: başlık mailin konusu, açıklama gövdesi.
// Saat çözünürlüğü cron aralığı kadardır — 14:30'a kurulan hatırlatma
// 14:30-14:45 arasında gider.
//
// Gönderim sonrası:
//   once    → hatırlatma pasife çekilir
//   monthly → bir sonraki ayın aynı gününe taşınır
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Reminder {
  id: string
  user_id: string
  title: string
  body: string | null
  next_date: string
  send_time: string
  repeat_mode: 'once' | 'monthly'
  last_sent_on: string | null
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Türkiye saatine göre tarih ve saat (sunucu UTC çalışıyor). */
function istanbulNow(): { date: string; time: string } {
  const tr = new Date(Date.now() + 3 * 60 * 60 * 1000)
  return { date: tr.toISOString().slice(0, 10), time: tr.toISOString().slice(11, 16) }
}

/**
 * Bir sonraki ayın aynı günü. Ay sonuna sığmayan günler kırpılır:
 * 31 Ocak → 28 Şubat.
 */
function nextMonth(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const year = m === 12 ? y + 1 : y
  const month = m === 12 ? 1 : m + 1
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const trDay = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })

/** Kullanıcının yazdığı metin maile gömüleceği için HTML'i kaçırılır. */
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function buildHtml(r: Reminder): string {
  const body = r.body?.trim()
    ? `<p style="font-size:15px;line-height:1.6;white-space:pre-wrap;margin:0 0 16px">${esc(r.body)}</p>`
    : ''
  const tekrar =
    r.repeat_mode === 'monthly'
      ? `<p style="color:#999;font-size:12px">Bu hatırlatma her ay tekrarlanıyor. Sonraki: ${trDay(nextMonth(r.next_date))}</p>`
      : ''
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
    <h2 style="margin:0 0 4px">${esc(r.title)}</h2>
    <p style="color:#666;margin:0 0 16px">${trDay(r.next_date)} tarihli hatırlatma</p>
    ${body}
    ${tekrar}
    <p style="color:#999;font-size:12px;margin-top:16px">
      Portföy takip uygulamasından otomatik gönderildi.
    </p>
  </div>`
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const resendKey = Deno.env.get('RESEND_API_KEY') ?? ''
  const sender = Deno.env.get('REMINDER_FROM') ?? 'Portföy <onboarding@resend.dev>'

  const { date: today, time: now } = istanbulNow()
  const errors: string[] = []
  const log: string[] = []

  const { data, error } = await supabase
    .from('reminders')
    .select('id, user_id, title, body, next_date, send_time, repeat_mode, last_sent_on')
    .eq('is_active', true)
    .lte('next_date', today)
    .or(`last_sent_on.is.null,last_sent_on.lt.${today}`)

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  // Bugüne kurulanlarda saat de gelmiş olmalı; geçmiş tarihliler beklemez
  const rows = ((data ?? []) as Reminder[]).filter(
    (r) => r.next_date < today || (r.send_time ?? '09:00').slice(0, 5) <= now
  )
  if (!rows.length) {
    return new Response(JSON.stringify({ ok: true, sent: 0, log: ['Gönderilecek hatırlatma yok.'] }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  // Adres ve anahtar kullanıcı başına bir kez çözülsün
  const cache = new Map<string, { to: string; key: string }>()
  const mailerFor = async (userId: string): Promise<{ to: string; key: string }> => {
    const hit = cache.get(userId)
    if (hit) return hit

    const { data: profile } = await supabase
      .from('profiles')
      .select('reminder_email')
      .eq('id', userId)
      .maybeSingle()
    let to = profile?.reminder_email ?? ''
    if (!to) {
      const { data: authUser } = await supabase.auth.admin.getUserById(userId)
      to = authUser?.user?.email ?? ''
    }

    // Kullanıcının kendi Resend anahtarı varsa onunla gönder; Resend
    // doğrulanmamış hesapta yalnızca kendi adresine izin verdiği için
    // herkesin kendi adresine ulaşmasının yolu bu.
    const { data: keyRow } = await supabase
      .from('user_mail_keys')
      .select('resend_key')
      .eq('user_id', userId)
      .maybeSingle()

    const result = { to, key: keyRow?.resend_key ?? resendKey }
    cache.set(userId, result)
    return result
  }

  let sent = 0
  for (const r of rows) {
    try {
      const { to, key } = await mailerFor(r.user_id)
      if (!to) {
        errors.push(`${r.title}: e-posta adresi bulunamadı`)
        continue
      }
      if (!key) throw new Error('Resend anahtarı tanımlı değil')

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: sender, to: [to], subject: r.title, html: buildHtml(r) }),
      })
      const payload = await res.json().catch(() => null)
      if (!res.ok) throw new Error(payload?.message ?? `Resend HTTP ${res.status}`)

      // Tekrarlıysa bir sonraki aya taşı, tek seferlikse kapat
      const patch =
        r.repeat_mode === 'monthly'
          ? { last_sent_on: today, next_date: nextMonth(r.next_date) }
          : { last_sent_on: today, is_active: false }
      const { error: updErr } = await supabase.from('reminders').update(patch).eq('id', r.id)
      if (updErr) errors.push(`${r.title} güncellenemedi: ${updErr.message}`)

      sent++
      log.push(`${to} → ${r.title}`)
    } catch (e) {
      errors.push(`${r.title}: ${msg(e)}`)
    }
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, sent, checked: rows.length, log, errors }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  )
})
