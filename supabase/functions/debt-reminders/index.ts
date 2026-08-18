// =====================================================================
// debt-reminders — vadesi yaklaşan borç ve faturaları e-postayla hatırlatır
//
// Günde bir kez çalışır (pg_cron). Vadesi bugün ya da yarın olan,
// kapatılmamış borçları kullanıcı bazında toplayıp tek mail gönderir.
// Aynı borç için günde birden fazla mail gitmemesi last_reminded_on ile
// engellenir.
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const TYPE_LABEL: Record<string, string> = {
  kredi_karti: 'Kredi Kartı',
  kredi: 'Kredi',
  kisisel_borc: 'Kişisel Borç',
  fatura: 'Fatura',
  diger: 'Diğer',
}

interface Liability {
  id: string
  user_id: string
  title: string
  type: string
  counterparty: string | null
  amount: number
  currency: string
  fx_rate: number
  due_date: string
  last_reminded_on: string | null
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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

/** Türkiye saatine göre YYYY-MM-DD (sunucu UTC çalışıyor). */
function istanbulDate(offsetDays = 0): string {
  const now = new Date()
  const tr = new Date(now.getTime() + 3 * 60 * 60 * 1000 + offsetDays * 86400000)
  return tr.toISOString().slice(0, 10)
}

const tl = (n: number) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY' }).format(n)

const trDay = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('tr-TR', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  })

function buildHtml(today: string, tomorrow: string, rows: Liability[]): string {
  const line = (l: Liability) => {
    const tutar = tl(Number(l.amount) * Number(l.fx_rate ?? 1))
    const ne = l.due_date === today ? 'BUGÜN son gün' : 'yarın'
    const kime = l.counterparty ? ` · ${l.counterparty}` : ''
    return `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee">
        <strong>${l.title}</strong><br>
        <span style="color:#666;font-size:13px">${TYPE_LABEL[l.type] ?? l.type}${kime}</span>
      </td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">
        <strong>${tutar}</strong><br>
        <span style="color:${l.due_date === today ? '#c00' : '#666'};font-size:13px">${ne} · ${trDay(l.due_date)}</span>
      </td>
    </tr>`
  }

  const total = rows.reduce((s, l) => s + Number(l.amount) * Number(l.fx_rate ?? 1), 0)

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px">
    <h2 style="margin:0 0 4px">Ödeme hatırlatması</h2>
    <p style="color:#666;margin:0 0 16px">${rows.length} ödemenin vadesi geldi ya da yarın doluyor.</p>
    <table style="width:100%;border-collapse:collapse;border:1px solid #eee">
      ${rows.map(line).join('')}
      <tr>
        <td style="padding:10px 12px"><strong>Toplam</strong></td>
        <td style="padding:10px 12px;text-align:right"><strong>${tl(total)}</strong></td>
      </tr>
    </table>
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

  const today = istanbulDate(0)
  const tomorrow = istanbulDate(1)
  const errors: string[] = []
  const log: string[] = []

  // --- aylık tekrarlayan faturaların bir sonraki ayını üret ----------
  // Her seride en ileri tarihli kayda bakılır ve vadesi geçmişse bugünün
  // ötesine geçene kadar yeni aylar açılır. Aynı gün iki kez çalışsa da
  // ikinci seferde üretecek bir şey kalmaz.
  try {
    const { data: rec } = await supabase
      .from('liabilities')
      .select('id, user_id, series_id, title, type, counterparty, amount, currency, fx_rate, due_date, note')
      .eq('repeat_monthly', true)
      .not('due_date', 'is', null)

    const latestOf = new Map<string, Record<string, unknown> & { id: string; due_date: string; series_id: string | null }>()
    for (const r of (rec ?? []) as (Record<string, unknown> & { id: string; due_date: string; series_id: string | null })[]) {
      const key = r.series_id ?? r.id
      const cur = latestOf.get(key)
      if (!cur || r.due_date > cur.due_date) latestOf.set(key, r)
    }

    const fresh: Record<string, unknown>[] = []
    for (const [seriesId, latest] of latestOf) {
      // Seri kimliği yoksa kaydın kendisi seriyi başlatsın
      if (!latest.series_id) {
        await supabase.from('liabilities').update({ series_id: seriesId }).eq('id', latest.id)
      }
      let due = latest.due_date
      let guard = 0
      while (due <= today && guard++ < 12) {
        due = nextMonth(due)
        fresh.push({
          user_id: latest.user_id,
          series_id: seriesId,
          title: latest.title,
          type: latest.type,
          counterparty: latest.counterparty,
          amount: latest.amount,
          currency: latest.currency,
          fx_rate: latest.fx_rate,
          note: latest.note,
          due_date: due,
          repeat_monthly: true,
          is_settled: false,
        })
      }
    }

    if (fresh.length) {
      const { error: insErr } = await supabase.from('liabilities').insert(fresh)
      if (insErr) errors.push(`tekrarlayan fatura: ${insErr.message}`)
      else log.push(`${fresh.length} tekrarlayan fatura açıldı`)
    }
  } catch (e) {
    errors.push(`tekrarlayan fatura: ${msg(e)}`)
  }

  // Vadesi bugün ya da yarın olan, kapatılmamış, bugün hatırlatılmamış borçlar
  const { data, error } = await supabase
    .from('liabilities')
    .select('id, user_id, title, type, counterparty, amount, currency, fx_rate, due_date, last_reminded_on')
    .eq('is_settled', false)
    .in('due_date', [today, tomorrow])
    .or(`last_reminded_on.is.null,last_reminded_on.lt.${today}`)

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const rows = (data ?? []) as Liability[]
  if (!rows.length) {
    log.push('Hatırlatılacak ödeme yok.')
    return new Response(
      JSON.stringify({ ok: errors.length === 0, sent: 0, checked: 0, log, errors }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } },
    )
  }

  // Kullanıcı bazında grupla — kişiye tek mail gitsin
  const byUser = new Map<string, Liability[]>()
  for (const l of rows) {
    const list = byUser.get(l.user_id) ?? []
    list.push(l)
    byUser.set(l.user_id, list)
  }

  let sent = 0
  for (const [userId, list] of byUser) {
    try {
      // Adres: profiles.reminder_email, yoksa giriş e-postası
      const { data: profile } = await supabase
        .from('profiles')
        .select('reminder_email, display_name')
        .eq('id', userId)
        .maybeSingle()

      let to = profile?.reminder_email ?? ''
      if (!to) {
        const { data: authUser } = await supabase.auth.admin.getUserById(userId)
        to = authUser?.user?.email ?? ''
      }
      if (!to) {
        errors.push(`${userId}: e-posta adresi bulunamadı`)
        continue
      }

      // Kullanıcının kendi Resend anahtarı varsa onunla gönder; Resend
      // doğrulanmamış hesapta yalnızca kendi adresine izin verdiği için
      // herkesin kendi adresine ulaşmasının yolu bu.
      const { data: keyRow } = await supabase
        .from('user_mail_keys')
        .select('resend_key')
        .eq('user_id', userId)
        .maybeSingle()
      const key = keyRow?.resend_key ?? resendKey
      if (!key) throw new Error('Resend anahtarı tanımlı değil')

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: sender,
          to: [to],
          subject: `Ödeme hatırlatması — ${list.length} ödeme`,
          html: buildHtml(today, tomorrow, list),
        }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.message ?? `Resend HTTP ${res.status}`)

      // Aynı gün tekrar gitmesin
      const { error: markErr } = await supabase
        .from('liabilities')
        .update({ last_reminded_on: today })
        .in('id', list.map((l) => l.id))
      if (markErr) errors.push(`işaretleme: ${markErr.message}`)

      sent++
      log.push(`${to} → ${list.length} ödeme`)
    } catch (e) {
      errors.push(`${userId}: ${msg(e)}`)
    }
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, sent, checked: rows.length, log, errors }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  )
})
