// =====================================================================
// fetch-fund-breakdown — fonların içeriğini Fonoloji'den çekip saklar
//
//   supabase functions deploy fetch-fund-breakdown
//
// Gövde (isteğe bağlı):
//   { codes: ["TP2","PHE"] } → yalnızca bu fonlar
//   { all: true }            → katalogdaki tüm fonlar (varsayılan: portföyde
//                              gerçekten tutulanlar)
//
// Neden gerekiyor: portföyde "fon" diye duran kalemin içinde hisse, tahvil
// ve döviz var. İçerik bilinmeden dağılım grafiği gerçek hisse maruziyetini
// gizliyor — 500 bin TL'lik hisse fonu "fon" görünüyor.
//
// Fon içeriği aylık yayımlandığı için haftada bir çalışması yeterli.
// TEFAS'ın açık API'si kapatıldı (BindHistoryAllocation → 404); veri
// Fonoloji üzerinden geliyor, fiyatlarda da aynı kaynak kullanılıyor.
// =====================================================================
import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Fonoloji kotasını yakmamak için koşu başına üst sınır */
const MAX_FUNDS = 40

/** İstekler arası nefes payı — kaynağa nazik davran */
const GAP_MS = 250

interface Holding {
  name: string
  company: string | null
  type: string
  weight: number
}

interface Portfolio {
  /** Varlık türü → yüzde. Kalemlerin tür bazında toplanmasıyla türetilir */
  allocation: Record<string, number>
  holdings: Holding[]
  as_of: string | null
  name: string | null
}

const AYLAR: Record<string, number> = {
  ocak: 1, şubat: 2, mart: 3, nisan: 4, mayıs: 5, haziran: 6,
  temmuz: 7, ağustos: 8, eylül: 9, ekim: 10, kasım: 11, aralık: 12,
}

/** "Temmuz 2026" → 2026-07-01 (fon içeriği ay bazında yayımlanıyor) */
function parsePeriod(text: unknown): string | null {
  const s = String(text ?? '').toLowerCase()
  const yil = s.match(/\b(20\d{2})\b/)
  const ay = Object.keys(AYLAR).find((a) => s.includes(a))
  if (!yil || !ay) return null
  return `${yil[1]}-${String(AYLAR[ay]).padStart(2, '0')}-01`
}

/**
 * Fonoloji yanıtı: { code, blocks, allocation: { fund: { …, holdings: [] } } }
 *
 * Yüzdesel dağılım ayrı bir alan olarak gelmiyor; kalemler tür bazında
 * toplanarak üretiliyor. Kalemlerdeki logoDataUrl base64 bir PNG —
 * kaydı şişirmemesi için atılıyor.
 */
function pickPortfolio(j: unknown): Portfolio | null {
  const root = (j ?? {}) as Record<string, unknown>
  const alloc = (root.allocation ?? {}) as Record<string, unknown>
  const fund = (alloc.fund ?? root.fund ?? root) as Record<string, unknown>
  const raw = fund?.holdings
  if (!Array.isArray(raw) || !raw.length) return null

  const holdings: Holding[] = []
  const allocation: Record<string, number> = {}
  for (const h of raw as Record<string, unknown>[]) {
    const weight = Number(h?.weight)
    const type = String(h?.type ?? 'Diğer').trim() || 'Diğer'
    if (!Number.isFinite(weight)) continue
    holdings.push({
      name: String(h?.name ?? '').trim(),
      company: h?.companyName ? String(h.companyName).trim() : null,
      type,
      weight,
    })
    allocation[type] = (allocation[type] ?? 0) + weight
  }
  if (!holdings.length) return null

  // Ağırlığı büyükten küçüğe — arayüz ilk kalemleri gösteriyor
  holdings.sort((a, b) => b.weight - a.weight)

  return {
    allocation,
    holdings,
    as_of: parsePeriod(fund?.period),
    name: fund?.name ? String(fund.name) : null,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const key = Deno.env.get('FONOLOJI_API_KEY') ?? ''
  if (!key) {
    return new Response(JSON.stringify({ ok: false, error: 'FONOLOJI_API_KEY tanımlı değil' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const body = (await req.json().catch(() => ({}))) as {
    codes?: string[]
    all?: boolean
    /** Ham yanıtı geri döner — kaynak biçimi değişirse ayrıştırıcıyı buna bakarak düzelt */
    debug?: boolean
  }
  const errors: string[] = []

  if (body.debug) {
    const code = (body.codes?.[0] ?? 'TP2').toUpperCase()
    const res = await fetch(
      `https://fonoloji.com/v1/funds/${encodeURIComponent(code)}/portfolio?include=allocation,holdings`,
      { headers: { 'X-API-Key': key, Accept: 'application/json' } }
    )
    const raw = await res.text()
    // holdings dizisi çok uzun; yapıyı görmek için özetlenir
    let ozet = raw.slice(0, 2500)
    try {
      ozet = JSON.stringify(
        JSON.parse(raw),
        (k, v) => (k === 'holdings' && Array.isArray(v) ? `[${v.length} kalem] ${JSON.stringify(v[0] ?? {})}` : v),
        1
      ).slice(0, 3000)
    } catch { /* ham metin kalsın */ }
    return new Response(
      JSON.stringify({ ok: res.ok, status: res.status, raw: ozet }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }

  // ------------------------------------------------- hangi fonlar çekilecek
  let codes: string[] = (body.codes ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean)

  if (!codes.length) {
    const { data: fonlar, error } = await supabase
      .from('assets')
      .select('id, symbol')
      .eq('kind', 'fon')
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: error.message }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }
    const hepsi = (fonlar ?? []) as { id: string; symbol: string }[]

    if (body.all) {
      codes = hepsi.map((a) => a.symbol.toUpperCase())
    } else {
      // Yalnızca birinin defterinde geçen fonlar — katalogda durup
      // kimsenin tutmadığı fon için kota harcanmasın
      const { data: kullanilan } = await supabase
        .from('trades')
        .select('asset_id')
        .in('asset_id', hepsi.map((a) => a.id))
      const idSet = new Set(((kullanilan ?? []) as { asset_id: string }[]).map((t) => t.asset_id))
      codes = hepsi.filter((a) => idSet.has(a.id)).map((a) => a.symbol.toUpperCase())
    }
  }

  codes = [...new Set(codes)].slice(0, MAX_FUNDS)
  if (!codes.length) {
    return new Response(JSON.stringify({ ok: true, fetched: 0, log: ['Çekilecek fon yok.'] }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  let fetched = 0
  const rows: Record<string, unknown>[] = []
  for (const code of codes) {
    try {
      const res = await fetch(
        `https://fonoloji.com/v1/funds/${encodeURIComponent(code)}/portfolio?include=allocation,holdings`,
        { headers: { 'X-API-Key': key, Accept: 'application/json' } }
      )
      const j = await res.json().catch(() => null)
      if (!res.ok) throw new Error(j?.error ?? `Fonoloji HTTP ${res.status}`)

      const p = pickPortfolio(j)
      if (!p) {
        errors.push(`${code}: içerik alanı okunamadı`)
        continue
      }
      rows.push({
        code,
        name: p.name ?? null,
        allocation: p.allocation,
        holdings: p.holdings ?? null,
        as_of: p.as_of,
        fetched_at: new Date().toISOString(),
      })
      fetched++
    } catch (e) {
      errors.push(`${code}: ${msg(e)}`)
    }
    await new Promise((r) => setTimeout(r, GAP_MS))
  }

  if (rows.length) {
    const { error } = await supabase.from('fund_breakdown').upsert(rows, { onConflict: 'code' })
    if (error) errors.push('upsert: ' + error.message)
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, asked: codes.length, fetched, errors }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } }
  )
})
