// =====================================================================
// ipo-deadline — halka arz talep toplamanın son günü yaklaşınca WhatsApp
//
//   supabase functions deploy ipo-deadline
//
// Cron 5 dakikada bir çağırır (cron.sql). Her koşuda ipo_feed'deki
// tarihi belli arzların kapanış anı hesaplanır (son gün + kapanış saati,
// "9-10-11 Eylül 2026 09:00-17:00" → 11 Eylül 17:00). Kapanışa
// LEAD_MINUTES (varsayılan 120) kala mesaj gider: 17:00 kapanış → 15:00,
// 13:00 kapanış → 11:00. Saat metinde yoksa 17:00 varsayılır ve mesajda
// belirtilir.
//
// Damga: ipo_feed.deadline_notified_at (bkz. supabase/arz-son-gun.sql).
// Kapanışı geçmiş ama hiç haber edilmemiş arz sessizce damgalanır —
// eski arzlar için "son gün" mesajı gitmez.
//
// Gövde (isteğe bağlı):
//   { leadMinutes: 90 }  → kaç dakika önce
//   { dry: true }        → mesaj atmadan ne yapacağını döndür
// =====================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DEFAULT_LEAD = 120
const DEFAULT_CLOSE = '17:00'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ------------------------------------------------------------ tarih
// src/lib/ipoDeadline.ts ile aynı mantık — fonksiyonlar kendi kendine
// yeter tutulduğu için kopya.
const MONTHS: Record<string, number> = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6,
  temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11,
  aralık: 12, aralik: 12,
}
const MONTH_RE =
  /(ocak|şubat|subat|mart|nisan|mayıs|mayis|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)/g

interface Deadline {
  date: string
  time: string
  timeKnown: boolean
}

function parseDeadline(text: string | null | undefined): Deadline | null {
  if (!text) return null
  const lower = text.toLocaleLowerCase('tr')
  const year = lower.match(/\b(20\d{2})\b/)?.[1]
  if (!year) return null

  let last: { day: number; month: number } | null = null
  let m: RegExpExecArray | null
  MONTH_RE.lastIndex = 0
  while ((m = MONTH_RE.exec(lower))) {
    const before = lower.slice(0, m.index)
    const tail = before.match(/((?:\b\d{1,2}\b\s*[-–,]?\s*)+)$/)?.[1] ?? ''
    const days = tail.match(/\d{1,2}/g)
    if (days?.length) last = { day: Number(days[days.length - 1]), month: MONTHS[m[1]] }
  }
  if (!last || !(last.day >= 1 && last.day <= 31)) return null

  const times = text.match(/\b\d{1,2}:\d{2}\b/g)
  const raw = times ? times[times.length - 1] : null
  return {
    date: `${year}-${String(last.month).padStart(2, '0')}-${String(last.day).padStart(2, '0')}`,
    time: raw ? raw.padStart(5, '0') : DEFAULT_CLOSE,
    timeKnown: !!raw,
  }
}

const deadlineAt = (d: Deadline) => new Date(`${d.date}T${d.time}:00+03:00`)

const trDay = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', timeZone: 'UTC' })

// -------------------------------------------------------------- WhatsApp
interface WaKey {
  phone: string
  apikey: string
}

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
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7E\n]/g, '')
}

/** CallMeBot hatada da 200 dönebiliyor; başarı "queued" ifadesinden anlaşılır. */
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

// ------------------------------------------------------------------ iş
interface FeedRow {
  slug: string
  name: string
  bist_code: string | null
  date_text: string | null
  price_text: string | null
  detail: { tarih?: string | null; fiyat?: string | null } | null
}

interface Due {
  row: FeedRow
  deadline: Deadline
  minutesLeft: number
}

function buildText(due: Due[]): string {
  const head = due.length === 1 ? '*Halka arz son gun!*' : `*${due.length} halka arzda son gun!*`
  const blocks = due.map(({ row, deadline, minutesLeft }) => {
    const kod = row.bist_code ? `${row.bist_code} - ` : ''
    const saat = deadline.timeKnown ? deadline.time : `${deadline.time} (saat varsayilan)`
    const kalan =
      minutesLeft >= 60 ? `${Math.round(minutesLeft / 60)} saat kaldi` : `${minutesLeft} dk kaldi`
    const fiyat = row.price_text ?? row.detail?.fiyat
    return [
      `${kod}${row.name}`,
      `Talep ${trDay(deadline.date)} ${saat}'de kapaniyor - ${kalan}`,
      fiyat ? `Fiyat: ${fiyat}` : null,
    ]
      .filter(Boolean)
      .join('\n')
  })
  return [head, ...blocks].join('\n\n')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const body = (await req.json().catch(() => ({}))) as { leadMinutes?: number; dry?: boolean }
  const lead = Math.min(Math.max(Number(body.leadMinutes ?? DEFAULT_LEAD), 5), 24 * 60)
  const dry = body.dry === true

  const errors: string[] = []
  const log: string[] = []
  const now = new Date()

  const { data, error } = await supabase
    .from('ipo_feed')
    .select('slug, name, bist_code, date_text, price_text, detail')
    .eq('is_draft', false)
    .is('deadline_notified_at', null)
    .order('sort_order')
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const due: Due[] = []
  const missed: string[] = []
  /** Tarihi okunmuş ama vakti gelmemiş arzlar — cevapta görünür, kontrol için */
  const upcoming: { slug: string; code: string | null; deadline: Deadline; minutesLeft: number }[] = []
  const unparsed: string[] = []
  for (const row of (data ?? []) as FeedRow[]) {
    // Detay sayfasındaki tarih saat de taşır; liste metni yalnızca gün
    const deadline = parseDeadline(row.detail?.tarih) ?? parseDeadline(row.date_text)
    if (!deadline) {
      unparsed.push(row.slug)
      continue
    }
    const minutesLeft = Math.round((deadlineAt(deadline).getTime() - now.getTime()) / 60000)
    if (minutesLeft <= 0) missed.push(row.slug)
    else if (minutesLeft <= lead) due.push({ row, deadline, minutesLeft })
    else upcoming.push({ slug: row.slug, code: row.bist_code, deadline, minutesLeft })
  }

  // Kapanışı geçmişler: mesaj yok, damga var — bir daha bakılmasın
  if (missed.length && !dry) {
    const { error: updErr } = await supabase
      .from('ipo_feed')
      .update({ deadline_notified_at: now.toISOString() })
      .in('slug', missed)
    if (updErr) errors.push('geçmiş damgalama: ' + updErr.message)
    else log.push(`${missed.length} arzın kapanışı geçmiş, sessizce damgalandı`)
  }

  let sent = 0
  if (due.length) {
    const text = buildText(due)
    if (dry) {
      log.push('DRY: ' + text)
    } else {
      const { data: alicilar } = await supabase.from('user_wa_keys').select('phone, apikey')
      const kime = (alicilar ?? []) as WaKey[]
      let ulasan = 0
      for (const a of kime) {
        try {
          await sendWhatsApp(a, text)
          ulasan++
        } catch (e) {
          errors.push(`WhatsApp ${a.phone}: ${msg(e)}`)
        }
      }
      // Kimseye ulaşılamadıysa damgalama — sonraki koşuda tekrar denenir.
      // Hiç alıcı yoksa damgala ki numara eklenince eski arzlar toplu gitmesin.
      if (ulasan > 0 || kime.length === 0) {
        const { error: updErr } = await supabase
          .from('ipo_feed')
          .update({ deadline_notified_at: now.toISOString() })
          .in('slug', due.map((d) => d.row.slug))
        if (updErr) errors.push('damgalama: ' + updErr.message)
        else sent = due.length
      }
      log.push(`${ulasan}/${kime.length} numaraya gitti: ${due.map((d) => d.row.bist_code ?? d.row.slug).join(', ')}`)
    }
  } else {
    log.push('Kapanışa yaklaşan arz yok.')
  }

  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      checked: data?.length ?? 0,
      due: due.map((d) => ({ slug: d.row.slug, deadline: d.deadline, minutesLeft: d.minutesLeft })),
      upcoming, unparsed,
      sent, missed: missed.length, log, errors,
    }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  )
})
