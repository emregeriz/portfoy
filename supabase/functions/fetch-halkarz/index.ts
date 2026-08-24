// =====================================================================
// halkarz.com arz takvimini çekip ipo_feed tablosuna yazar.
//
//   supabase functions deploy fetch-halkarz
//
// Gövde (hepsi isteğe bağlı):
//   { limit: 10 }            → bu koşuda en fazla kaç detay sayfası çekilsin
//   { slugs: ["kapeks-..."] } → yalnızca bu arzların detayını tazele
//
// Ana listeyi her koşuda tarar (tek istek); detay sayfalarını sıraya
// koyup azar azar çeker — siteye nazik davranır. Cron günde birkaç kez
// çağırır (cron.sql), arayüzdeki "Yenile" düğmesi de aynı işi yapar.
//
// Koşu sonunda tarihi açıklanmış yeni arzlar için WhatsApp bildirimi
// gönderilir (bkz. halkarz.sql → notified_at).
// =====================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BASE = 'https://halkarz.com'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) portfoy-kisisel-takip'

/** Tek mesajda en fazla kaç arz sayılsın — gerisi "+N tane daha" olur */
const BILDIRIM_LIMIT = 10

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** HTML entity'lerini çöz, etiketleri at, boşlukları topla */
function text(html: string): string {
  return html
    .replace(/<br\s*\/?\s*>/gi, '\n')
    // Gömülü tablolar düz metne dönerken hücreler birbirine yapışmasın:
    // satır sonu → yeni satır, hücre sınırı → ayraç
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' · ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

interface FeedItem {
  slug: string
  name: string
  bist_code: string | null
  badge: string | null
  is_draft: boolean
  date_text: string | null
  url: string
  image_url: string | null
  sort_order: number
}

/** Ana sayfadaki arz listesi — taslak sekmesi dahil */
function parseList(html: string): FeedItem[] {
  const draftAt = html.indexOf('halka-arz-list taslak')
  const out: FeedItem[] = []
  const seen = new Set<string>()
  const re = /<article class="index-list">([\s\S]*?)<\/article>/g
  let m: RegExpExecArray | null
  let order = 0
  while ((m = re.exec(html))) {
    const block = m[1]
    const url = block.match(/href="(https:\/\/halkarz\.com\/[^"]+)"/)?.[1]
    if (!url) continue
    const slug = url.replace(`${BASE}/`, '').replace(/\/+$/, '')
    if (!slug || seen.has(slug)) continue
    seen.add(slug)
    const name = text(block.match(/il-halka-arz-sirket[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '')
    if (!name) continue
    const code = text(block.match(/il-bist-kod">([\s\S]*?)<\//)?.[1] ?? '')
    out.push({
      slug,
      url,
      name,
      bist_code: /^[A-Z0-9.]{3,8}$/.test(code) ? code : null,
      badge: block.includes('il-new')
        ? 'yeni'
        : block.includes('il-gonk')
          ? 'gong'
          : block.includes('il-ert')
            ? 'ertelendi'
            : null,
      is_draft: draftAt >= 0 && m.index > draftAt,
      date_text: text(block.match(/<time datetime="([^"]*)"/)?.[1] ?? '') || null,
      image_url: block.match(/<img src="([^"]+)"/)?.[1] ?? null,
      sort_order: order++,
    })
  }
  return out
}

/** Detay sayfası — sp-table alanları + özet bilgiler + dağıtım sonuçları */
function parseDetail(html: string): Record<string, unknown> {
  const field = (label: string): string | null => {
    const re = new RegExp(`<em>\\s*${label}[^<]*</em>[\\s\\S]{0,200}?<td[^>]*>([\\s\\S]*?)</td>`, 'i')
    const v = html.match(re)?.[1]
    return v ? text(v) || null : null
  }

  // Aracı kurum hücresindeki konsorsiyum listesi
  const brokerCell =
    html.match(/<em>\s*Aracı Kurum[^<]*<\/em>[\s\S]{0,300}?<td[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? ''
  const consortium = [...brokerCell.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => text(x[1]))

  // Dağıtım sonuçları tablosu — satırlar ham metin dizisi olarak saklanır
  const resultRows: string[][] = []
  const resTable = html.match(/<table class="as-table">([\s\S]*?)<\/table>/)?.[1]
  if (resTable) {
    for (const tr of resTable.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
      const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]))
      if (cells.length) resultRows.push(cells)
    }
  }

  // Özet bilgiler (modal #ex4): başlık + metin çiftleri
  const ozet: { baslik: string; icerik: string }[] = []
  const ozetBlock = html.match(/<ul class="aex-in">([\s\S]*?)<\/ul>/)?.[1]
  if (ozetBlock) {
    for (const li of ozetBlock.match(/<li>[\s\S]*?<\/li>/g) ?? []) {
      const baslik = text(li.match(/<h5>([\s\S]*?)<\/h5>/)?.[1] ?? '')
      const icerik = text(li.match(/<p>([\s\S]*?)<\/p>/)?.[1] ?? '')
      if (baslik) ozet.push({ baslik, icerik })
    }
  }

  return {
    tarih: field('Halka Arz Tarihi'),
    fiyat: field('Halka Arz Fiyat'),
    dagitim: field('Dağıtım Yöntemi'),
    pay: field('Pay'),
    araci_kurum: text(brokerCell.split('<div')[0] ?? '') || null,
    konsorsiyum: consortium.length ? consortium : null,
    bist_kodu: field('Bist Kodu'),
    pazar: field('Pazar'),
    ilk_islem: field('Bist İlk İşlem Tarihi'),
    sonuclar: resultRows.length ? resultRows : null,
    ozet: ozet.length ? ozet : null,
    son_guncelleme: html.match(/last-modified[\s\S]{0,120}?<time datetime="([^"]+)"/)?.[1] ?? null,
  }
}

async function get(url: string): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`)
  return await r.text()
}

// =====================================================================
// Yeni arz bildirimi
//
// Aşağıdaki iki yardımcı custom-reminders'takinin aynısı. Edge Function'lar
// bu projede kendi kendine yeter halde duruyor (nextMonth, msg, CORS de
// öyle), ortak dosya açmak yerine kopya bırakıldı.
// =====================================================================

/** CallMeBot'ta apikey numaraya bağlıdır — ikisi birlikte anlam taşır. */
interface WaKey {
  phone: string
  apikey: string
}

/**
 * CallMeBot ASCII dışına çıkan hiçbir karakteri kabul etmiyor: Türkçe harf
 * içeren mesaj "invalid charecters" ile geri dönüyor, hiç gönderilmiyor.
 * Şirket adları Türkçe harf dolu olduğu için bu sadeleştirme şart.
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
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^\x20-\x7E\n]/g, '')
}

/** Hatada da HTTP 200 dönebildiği için başarı "queued" ifadesinden anlaşılır. */
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

interface IpoRow {
  slug: string
  name: string
  bist_code: string | null
  date_text: string | null
  price_text: string | null
}

const AYLAR: Record<string, number> = {
  ocak: 1, şubat: 2, subat: 2, mart: 3, nisan: 4, mayıs: 5, mayis: 5, haziran: 6,
  temmuz: 7, ağustos: 8, agustos: 8, eylül: 9, eylul: 9, ekim: 10, kasım: 11, kasim: 11, aralık: 12, aralik: 12,
}

/**
 * "12-13-14 Ağustos 2026" → 2026-08-12 (talep toplamanın ilk günü).
 * "30 Haziran, 1 Temmuz 2026" gibi ay atlayan yazımlarda da ilk gün alınır.
 * Ay ya da yıl okunamazsa null döner — uydurma tarih yazmaktansa boş kalsın.
 */
function parseIpoDate(text: string | null): string | null {
  if (!text) return null
  const gun = text.match(/\d{1,2}/)
  const yil = text.match(/\b(20\d{2})\b/)
  const ay = text.toLowerCase().match(/(ocak|şubat|subat|mart|nisan|mayıs|mayis|haziran|temmuz|ağustos|agustos|eylül|eylul|ekim|kasım|kasim|aralık|aralik)/)
  if (!gun || !yil || !ay) return null
  const d = Number(gun[0])
  const m = AYLAR[ay[1]]
  if (!(d >= 1 && d <= 31) || !m) return null
  return `${yil[1]}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** "73,70 TL" → 73.7 */
function parsePrice(text: string | null): number | null {
  if (!text) return null
  const m = text.replace(/\./g, '').match(/(\d+(?:,\d+)?)/)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Tarihi belli mi? Sitede tarih alanı üç halde olabiliyor: gerçek tarih
 * ("12-13-14 Ağustos 2026"), "Hazırlanıyor..." ya da "Ertelendi". Ay adı
 * aramak, ikinci ikisini dışarıda bırakmanın en dayanıklı yolu — yeni bir
 * bekleme ifadesi çıksa da yanlışlıkla bildirim gitmez.
 */
const AY_ADI =
  /(ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık)/iu

const tarihiBelli = (s: string | null): boolean => !!s && /\d/.test(s) && AY_ADI.test(s)

function buildIpoText(rows: IpoRow[]): string {
  const bas = rows.length === 1 ? '*Yeni halka arz*' : `*${rows.length} yeni halka arz*`
  const goster = rows.slice(0, BILDIRIM_LIMIT)
  const blok = goster.map((r) => {
    const kod = r.bist_code ? `${r.bist_code} - ` : ''
    const fiyat = r.price_text ? ` - ${r.price_text}` : ''
    return `${kod}${r.name}\n${r.date_text}${fiyat}`
  })
  const kalan = rows.length - goster.length
  if (kalan > 0) blok.push(`_+${kalan} arz daha_`)
  return [bas, ...blok].join('\n\n')
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const body = (await req.json().catch(() => ({}))) as { limit?: number; slugs?: string[] }
  const limit = Math.min(Math.max(body.limit ?? 10, 1), 25)
  const errors: string[] = []

  // ---------------------------------------------------------- ana liste
  let items: FeedItem[] = []
  try {
    items = parseList(await get(`${BASE}/`))
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'liste çekilemedi: ' + msg(e) }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
  if (items.length) {
    const { error } = await supabase.from('ipo_feed').upsert(
      items.map((i) => ({ ...i, updated_at: new Date().toISOString() })),
      { onConflict: 'slug' }
    )
    if (error) errors.push('upsert: ' + error.message)
  }

  // ------------------------------------------------------ detay sırası
  // Öncelik: istekle gelen sluglar → detayı hiç çekilmemiş ana liste
  // kayıtları → en eskiden tazelenen. Taslaklar (henüz bilgi yok) atlanır.
  let targets: { slug: string; url: string }[] = []
  if (body.slugs?.length) {
    targets = items.filter((i) => body.slugs!.includes(i.slug))
    if (!targets.length) {
      const { data } = await supabase.from('ipo_feed').select('slug, url').in('slug', body.slugs)
      targets = (data ?? []) as { slug: string; url: string }[]
    }
  } else {
    const { data } = await supabase
      .from('ipo_feed')
      .select('slug, url')
      .eq('is_draft', false)
      .order('detail_fetched_at', { ascending: true, nullsFirst: true })
      .limit(limit)
    targets = (data ?? []) as { slug: string; url: string }[]
  }

  let fetched = 0
  for (const t of targets.slice(0, limit)) {
    try {
      const detail = parseDetail(await get(t.url))
      const { error } = await supabase
        .from('ipo_feed')
        .update({
          detail,
          price_text: (detail.fiyat as string | null) ?? null,
          detail_fetched_at: new Date().toISOString(),
        })
        .eq('slug', t.slug)
      if (error) errors.push(`${t.slug}: ${error.message}`)
      else fetched++
    } catch (e) {
      errors.push(`${t.slug}: ${msg(e)}`)
    }
    // Siteye nazik: istekler arasında kısa bekleme
    await new Promise((r) => setTimeout(r, 400))
  }

  // -------------------------------------------------- yeni arz bildirimi
  // Damgasız (notified_at null) ve tarihi açıklanmış arzlar haber edilir.
  // Taslaklar ile "Hazırlanıyor..." kayıtları damgasız bekler; tarihleri
  // belli olduğu koşuda bildirime girerler. Detay çekimi bu adımdan önce
  // bittiği için fiyat da çoğu zaman hazır olur.
  let notified = 0
  let opened = 0
  try {
    const { data: bekleyen, error: selErr } = await supabase
      .from('ipo_feed')
      .select('slug, name, bist_code, date_text, price_text')
      .is('notified_at', null)
      .eq('is_draft', false)
      .order('sort_order')
    if (selErr) throw new Error(selErr.message)

    const yeni = ((bekleyen ?? []) as IpoRow[]).filter((r) => tarihiBelli(r.date_text))
    if (yeni.length) {
      const { data: alicilar } = await supabase.from('user_wa_keys').select('phone, apikey')
      const kime = (alicilar ?? []) as WaKey[]
      const metin = buildIpoText(yeni)

      let ulasan = 0
      for (const a of kime) {
        try {
          await sendWhatsApp(a, metin)
          ulasan++
        } catch (e) {
          errors.push(`WhatsApp ${a.phone}: ${msg(e)}`)
        }
      }

      // ------------------------------------------- arzları hesaba düşür
      // Halka arz hesabı olan her kullanıcının listesine otomatik açılır;
      // kullanıcı sonra yalnızca hangi hesaptan kaç lot istediğini girer.
      // feed_slug üzerindeki tekil indeks aynı arzın iki kez açılmasını
      // engelliyor, o yüzden ignoreDuplicates yeterli.
      try {
        const { data: ipoAccounts } = await supabase
          .from('accounts')
          .select('user_id')
          .eq('is_ipo', true)
          .eq('is_active', true)

        const users = [...new Set(((ipoAccounts ?? []) as { user_id: string }[]).map((a) => a.user_id))]
        if (users.length) {
          const rows = users.flatMap((uid) =>
            yeni.map((r) => ({
              user_id: uid,
              feed_slug: r.slug,
              source: 'takvim',
              name: r.name,
              bist_code: r.bist_code,
              ipo_date: parseIpoDate(r.date_text),
              lot_price: parsePrice(r.price_text),
              status: 'talep_verildi',
            }))
          )
          const { error: ipoErr } = await supabase
            .from('ipos')
            .upsert(rows, { onConflict: 'user_id,feed_slug', ignoreDuplicates: true })
          if (ipoErr) errors.push('arz açma: ' + ipoErr.message)
          else opened = rows.length
        }
      } catch (e) {
        errors.push('arz açma: ' + msg(e))
      }

      // Kimseye ulaşılamadıysa damgalama — haber kaybolmasın, sonraki
      // koşuda tekrar denensin. Hiç alıcı tanımlı değilse damgala ki
      // ileride numara eklendiğinde birikmiş arzlar toplu gitmesin.
      if (ulasan > 0 || kime.length === 0) {
        const { error: updErr } = await supabase
          .from('ipo_feed')
          .update({ notified_at: new Date().toISOString() })
          .in('slug', yeni.map((r) => r.slug))
        if (updErr) errors.push('damgalama: ' + updErr.message)
        else notified = yeni.length
      }
    }
  } catch (e) {
    errors.push('bildirim: ' + msg(e))
  }

  return new Response(
    JSON.stringify({
      ok: errors.length === 0, list: items.length, details: fetched, notified, opened, errors,
    }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
