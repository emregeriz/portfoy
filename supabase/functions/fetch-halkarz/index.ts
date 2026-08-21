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
// =====================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const BASE = 'https://halkarz.com'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) portfoy-kisisel-takip'

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

  return new Response(
    JSON.stringify({ ok: errors.length === 0, list: items.length, details: fetched, errors }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
