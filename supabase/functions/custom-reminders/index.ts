// =====================================================================
// custom-reminders — kullanıcının kendi yazdığı hatırlatmaları gönderir
//
// 5 dakikada bir çalışır; tarihi VE saati gelmiş aktif hatırlatmalar için
// ayrı ayrı mesaj gönderir: başlık mesajın başlığı, açıklama gövdesi.
// Saat çözünürlüğü cron aralığı kadardır — 14:32'ye kurulan hatırlatma
// 14:35'te gider.
//
// Kanal hatırlatma başına seçilir (reminders.channel, bkz.
// supabase/reminder-kanal.sql):
//   wa    → yalnızca WhatsApp (CallMeBot). Numara tanımlı değilse ya da
//           istek hata verirse hatırlatma kaybolmasın diye mail'e düşülür.
//   mail  → yalnızca e-posta (Resend)
//   both  → ikisi birden; biri gitmese diğeri ulaşır
//
// Hiçbir kanaldan gidemeyen hatırlatma olduğu gibi bırakılır: gönderildi
// damgası vurulmaz, bir sonraki koşuda yeniden denenir.
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

type ReminderChannel = 'wa' | 'mail' | 'both'

interface Reminder {
  id: string
  user_id: string
  title: string
  body: string | null
  next_date: string
  send_time: string
  repeat_mode: 'once' | 'monthly'
  channel: ReminderChannel | null
  last_sent_on: string | null
}

/** CallMeBot'ta apikey numaraya bağlıdır — ikisi birlikte anlam taşır. */
interface WaKey {
  phone: string
  apikey: string
}

interface Channel {
  to: string
  key: string
  wa: WaKey | null
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

/** WhatsApp HTML anlamaz; *kalın* ve _italik_ kendi işaretlemesidir. */
function buildText(r: Reminder): string {
  const parts = [`*${r.title}*`, `${trDay(r.next_date)} tarihli hatırlatma`]
  if (r.body?.trim()) parts.push('', r.body.trim())
  if (r.repeat_mode === 'monthly') {
    parts.push('', `_Her ay tekrarlanıyor · sonraki: ${trDay(nextMonth(r.next_date))}_`)
  }
  return parts.join('\n')
}

/**
 * CallMeBot ASCII dışına çıkan hiçbir karakteri kabul etmiyor: Türkçe harf
 * içeren mesaj "invalid charecters" ile geri dönüyor, hiç gönderilmiyor.
 * Metin bu yüzden gönderim anında sadeleştirilir — "Kira ödemesi" mesaja
 * "Kira odemesi" olarak düşer. Satır sonu ve *kalın* işaretlemesi geçerli.
 */
const ASCII_MAP: Record<string, string> = {
  'ç': 'c', 'Ç': 'C', 'ğ': 'g', 'Ğ': 'G', 'ı': 'i', 'İ': 'I',
  'ö': 'o', 'Ö': 'O', 'ş': 's', 'Ş': 'S', 'ü': 'u', 'Ü': 'U',
  '₺': 'TL', '€': 'EUR', '£': 'GBP',
  '—': '-', '–': '-', '·': '-', '…': '...',
  '’': "'", '‘': "'", '“': '"', '”': '"',
}

function toAscii(s: string): string {
  return s
    .replace(/[çÇğĞıİöÖşŞüÜ₺€£—–·…’‘“”]/g, (c) => ASCII_MAP[c] ?? c)
    // kalan aksanlı latin harfler taban harfine iner: â → a, é → e
    .normalize('NFD').replace(/\p{M}/gu, '')
    // emoji, kontrol karakterleri ve geri kalan ASCII dışı her şey atılır
    // (satır sonu korunur — WhatsApp'ta gerçek satır sonu oluyor)
    .replace(/[^\x20-\x7E\n]/g, '')
}

/**
 * CallMeBot'un ücretsiz WhatsApp ucu — resmi API değil, kişinin kendi
 * numarasına gönderim yapar. Hatada da HTTP 200 dönebildiği için başarı
 * yalnızca gövdedeki "queued" ifadesinden anlaşılır; emin olunamayan her
 * durum hata sayılır ki çağıran mail'e düşebilsin.
 */
async function sendWhatsApp(wa: WaKey, text: string): Promise<void> {
  const ascii = toAscii(text).trim()
  if (!ascii) throw new Error('mesaj ASCII sadeleştirmesinden sonra boş kaldı')

  const url =
    'https://api.callmebot.com/whatsapp.php' +
    `?phone=${encodeURIComponent(wa.phone)}` +
    `&text=${encodeURIComponent(ascii)}` +
    `&apikey=${encodeURIComponent(wa.apikey)}`

  const res = await fetch(url)
  const body = await res.text().catch(() => '')
  if (!res.ok || !/queued/i.test(body)) {
    const detail = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    throw new Error(detail || `CallMeBot HTTP ${res.status}`)
  }
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

  const due = (cols: string) =>
    supabase
      .from('reminders')
      .select(cols)
      .eq('is_active', true)
      .lte('next_date', today)
      .or(`last_sent_on.is.null,last_sent_on.lt.${today}`)

  const BASE = 'id, user_id, title, body, next_date, send_time, repeat_mode, last_sent_on'
  let { data, error } = await due(`${BASE}, channel`)
  // reminder-kanal.sql henüz çalıştırılmadıysa kolon yoktur; fonksiyon
  // deploy sırasına takılmasın diye eski şemayla bir kez daha denenir.
  if (error && /channel/i.test(error.message)) {
    ;({ data, error } = await due(BASE))
  }

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  // Bugüne kurulanlarda saat de gelmiş olmalı; geçmiş tarihliler beklemez
  const rows = ((data ?? []) as unknown as Reminder[]).filter(
    (r) => r.next_date < today || (r.send_time ?? '09:00').slice(0, 5) <= now
  )
  if (!rows.length) {
    return new Response(JSON.stringify({ ok: true, sent: 0, log: ['Gönderilecek hatırlatma yok.'] }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  // Kanal kullanıcı başına bir kez çözülsün
  const cache = new Map<string, Channel>()
  const channelFor = async (userId: string): Promise<Channel> => {
    const hit = cache.get(userId)
    if (hit) return hit

    // Tablo hiç kurulmamışsa sorgu hata verir, waRow null gelir ve geriye
    // yalnızca mail yolu kalır.
    const { data: waRow } = await supabase
      .from('user_wa_keys')
      .select('phone, apikey')
      .eq('user_id', userId)
      .maybeSingle()

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

    const result: Channel = {
      to,
      key: keyRow?.resend_key ?? resendKey,
      wa: waRow?.phone && waRow?.apikey ? { phone: waRow.phone, apikey: waRow.apikey } : null,
    }
    cache.set(userId, result)
    return result
  }

  const sendMail = async (ch: Channel, r: Reminder): Promise<void> => {
    if (!ch.to) throw new Error('e-posta adresi bulunamadı')
    if (!ch.key) throw new Error('Resend anahtarı tanımlı değil')
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ch.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: sender, to: [ch.to], subject: r.title, html: buildHtml(r) }),
    })
    const payload = await res.json().catch(() => null)
    if (!res.ok) throw new Error(payload?.message ?? `Resend HTTP ${res.status}`)
  }

  let sent = 0
  for (const r of rows) {
    try {
      const ch = await channelFor(r.user_id)
      // Kolon eklenmeden önce kurulmuş kayıtlar eski davranışı sürdürsün
      const want: ReminderChannel = r.channel ?? 'wa'
      const via: string[] = []
      const fails: string[] = []

      if (want !== 'mail') {
        if (!ch.wa) fails.push('WhatsApp numarası tanımlı değil')
        else {
          try {
            await sendWhatsApp(ch.wa, buildText(r))
            via.push(`WhatsApp ${ch.wa.phone}`)
          } catch (e) {
            fails.push(`WhatsApp gitmedi (${msg(e)})`)
          }
        }
      }

      // 'mail' ve 'both' zaten mail ister; yalnız 'wa' seçiliyken de
      // WhatsApp gidemediyse hatırlatma kaybolmasın diye mail'e düşülür.
      if (want !== 'wa' || !via.length) {
        try {
          await sendMail(ch, r)
          via.push(ch.to)
        } catch (e) {
          fails.push(`Mail gitmedi (${msg(e)})`)
        }
      }

      for (const f of fails) errors.push(`${r.title}: ${f}`)

      // Hiçbiri gitmediyse kayda dokunulmaz — sonraki koşuda tekrar denenir
      if (!via.length) continue

      // Tekrarlıysa bir sonraki aya taşı, tek seferlikse kapat
      const patch =
        r.repeat_mode === 'monthly'
          ? { last_sent_on: today, next_date: nextMonth(r.next_date) }
          : { last_sent_on: today, is_active: false }
      const { error: updErr } = await supabase.from('reminders').update(patch).eq('id', r.id)
      if (updErr) errors.push(`${r.title} güncellenemedi: ${updErr.message}`)

      sent++
      log.push(`${via.join(' + ')} → ${r.title}`)
    } catch (e) {
      errors.push(`${r.title}: ${msg(e)}`)
    }
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, sent, checked: rows.length, log, errors }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  )
})
