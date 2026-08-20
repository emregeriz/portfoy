// =====================================================================
// fetch-prices — güncel fiyatları toplayıp veritabanına yazar
//
//   TCMB      → döviz kurları           (fx_rates)
//   Truncgil  → altın & gümüş           (asset_prices + fx_rates.XAU)
//   CoinGecko → kripto                  (asset_prices)
//   Yahoo     → BIST hissesi            (asset_prices)
//   Fonoloji  → yatırım fonu (TEFAS)    (asset_prices)
//
// Tarayıcı bu kaynaklara CORS yüzünden doğrudan erişemez; çekme işi
// bu yüzden sunucu tarafında yapılır.
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const UA = 'Mozilla/5.0 (compatible; PortfoyBot/1.0)'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface Asset {
  id: string
  symbol: string
  kind: string
  price_ref: string | null
  auto_price: boolean
}

// Sembol → kaynak kimliği varsayılanları (assets.price_ref doluysa o kazanır)
const GOLD_MAP: Record<string, string> = {
  XAU: 'GRA', ALTIN: 'GRA', GRAM: 'GRA', GRAMALTIN: 'GRA',
  CEYREK: 'CEYREKALTIN', YARIM: 'YARIMALTIN', TAM: 'TAMALTIN',
  CUMHURIYET: 'CUMHURIYETALTINI', ATA: 'ATAALTIN',
  GUMUS: 'GUMUS', XAG: 'GUMUS', ONS: 'ONS', HAS: 'HAS',
}
const CRYPTO_MAP: Record<string, string> = {
  BTC: 'bitcoin', ETH: 'ethereum', USDT: 'tether', BNB: 'binancecoin',
  SOL: 'solana', XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin',
  AVAX: 'avalanche-2', TRX: 'tron', DOT: 'polkadot', LTC: 'litecoin',
  LINK: 'chainlink', MATIC: 'matic-network', SHIB: 'shiba-inu',
}

const today = (): string => new Date().toISOString().slice(0, 10)
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Dış kaynaklar ara sıra bağlantıyı yarıda kesiyor ("error reading a body
 * from connection"). Tek denemede pes etmek günlük güncellemeyi boşa
 * düşürdüğü için kısa aralıklarla yeniden dener.
 */
async function tryFetch(url: string, init: RequestInit = {}, attempts = 3): Promise<Response> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init)
      // 5xx geçici olabilir; son denemede olduğu gibi döndür
      if (res.status >= 500 && i < attempts - 1) {
        lastError = new Error('HTTP ' + res.status)
      } else {
        return res
      }
    } catch (e) {
      lastError = e
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)))
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** "17.08.2026" → "2026-08-17" */
function trDate(s: string): string | null {
  const m = s.match(/(\d{2})\.(\d{2})\.(\d{4})/)
  return m ? m[3] + '-' + m[2] + '-' + m[1] : null
}

// ------------------------------------------------------------------ TCMB
async function tcmb(): Promise<{ date: string; rates: Record<string, number> }> {
  const res = await tryFetch('https://www.tcmb.gov.tr/kurlar/today.xml', { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error('TCMB HTTP ' + res.status)
  const xml = await res.text()
  const date = trDate(xml.match(/Tarih="([\d.]+)"/)?.[1] ?? '') ?? today()
  const rates: Record<string, number> = { TRY: 1 }
  const re = /<Currency[^>]*Kod="([A-Z]{3})"[\s\S]*?<Unit>(\d+)<\/Unit>[\s\S]*?<ForexSelling>([\d.]*)<\/ForexSelling>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const value = Number(m[3])
    const unit = Number(m[2]) || 1
    if (Number.isFinite(value) && value > 0) rates[m[1]] = value / unit
  }
  if (Object.keys(rates).length < 2) throw new Error('TCMB yanıtı ayrıştırılamadı')
  return { date, rates }
}

// -------------------------------------------------------------- Truncgil
async function truncgil(): Promise<{ date: string; values: Record<string, number> }> {
  const res = await tryFetch('https://finans.truncgil.com/v4/today.json', { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error('Truncgil HTTP ' + res.status)
  const j = await res.json()
  const date = String(j.Update_Date ?? '').slice(0, 10) || today()
  const values: Record<string, number> = {}
  for (const [k, v] of Object.entries(j)) {
    const sell = (v as { Selling?: number })?.Selling
    if (typeof sell === 'number' && sell > 0) values[k] = sell
  }
  return { date, values }
}

// ------------------------------------------------------------- CoinGecko
async function coingecko(ids: string[]): Promise<Record<string, number>> {
  if (!ids.length) return {}
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids.join(',') + '&vs_currencies=try'
  const res = await tryFetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error('CoinGecko HTTP ' + res.status)
  const j = await res.json()
  const out: Record<string, number> = {}
  for (const [id, v] of Object.entries(j)) {
    const p = (v as { try?: number })?.try
    if (typeof p === 'number') out[id] = p
  }
  return out
}

// ----------------------------------------------------------------- Yahoo
/**
 * Son fiyat + günlük kapanış serisi.
 *
 * Yahoo zaten 5 günlük seriyi aynı yanıtta veriyor; sadece son fiyatı alıp
 * gerisini atmak yerine günleri de yazıyoruz. Yeni eklenen bir hisse
 * (özellikle yeni halka arz) böylece ilk günden "bugün ne kadar oynadı"
 * hesabına girebiliyor.
 */
async function yahoo(
  symbol: string,
): Promise<{ price: number; currency: string; history: { date: string; price: number }[] } | null> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(symbol) + '?interval=1d&range=1mo'
  const res = await tryFetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return null
  const j = await res.json()
  const result = j?.chart?.result?.[0]
  const meta = result?.meta
  const price = meta?.regularMarketPrice
  if (typeof price !== 'number') return null

  const stamps: number[] = result?.timestamp ?? []
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? []
  const history: { date: string; price: number }[] = []
  for (let i = 0; i < stamps.length; i++) {
    const c = closes[i]
    if (typeof c !== 'number' || !(c > 0)) continue
    history.push({ date: new Date(stamps[i] * 1000).toISOString().slice(0, 10), price: c })
  }
  return { price, currency: meta?.currency ?? 'TRY', history }
}

// -------------------------------------------------------------- Fonoloji
async function fonoloji(code: string, key: string): Promise<{ price: number; date: string } | null> {
  // 2 deneme: bağlantı koparsa fonu kaybetmeyelim, ama kotayı da yakmayalım
  const res = await tryFetch('https://fonoloji.com/v1/funds/' + encodeURIComponent(code), {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
  }, 2)
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(j?.error ?? 'Fonoloji HTTP ' + res.status)
  const f = j?.fund ?? j
  const price = Number(f?.current_price ?? f?.price)
  if (!Number.isFinite(price) || price <= 0) return null
  return { price, date: String(f?.current_date ?? '').slice(0, 10) || today() }
}

/**
 * Fonun geçmiş fiyat serisi.
 *
 * Yeni eklenen bir fonun tek günlük fiyatı olur; "bugünkü getiri" için
 * önceki günün fiyatı da gerekir. Bu uç nokta geçmişi tek çağrıda getirir.
 * Dönüş biçimi sürüme göre dizi ya da sarmalanmış olabildiği için birkaç
 * olası alan denenir.
 */
async function fonolojiHistory(
  code: string,
  key: string,
  period = '1m',
): Promise<{ date: string; price: number }[]> {
  const res = await tryFetch(
    'https://fonoloji.com/v1/funds/' + encodeURIComponent(code) + '/history?period=' + period,
    { headers: { 'X-API-Key': key, Accept: 'application/json' } },
    2,
  )
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(j?.error ?? 'Fonoloji history HTTP ' + res.status)
  const arr = Array.isArray(j) ? j : (j?.history ?? j?.data ?? j?.points ?? j?.nav ?? [])
  if (!Array.isArray(arr)) return []
  return arr
    .map((p: Record<string, unknown>) => ({
      date: String(p?.date ?? '').slice(0, 10),
      price: Number(p?.price ?? p?.value ?? p?.nav),
    }))
    .filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && Number.isFinite(p.price) && p.price > 0)
}

// ================================================================== main
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )
  const fonKey = Deno.env.get('FONOLOJI_API_KEY') ?? ''

  // { backfill: true } → geçmişi olsun olmasın bütün fonların serisi çekilir
  // { backfillPeriod: '3m' } → çekilecek aralık (1w | 1m | 3m | 1y | ytd)
  const body = (await req.json().catch(() => ({}))) as {
    backfill?: boolean
    backfillPeriod?: string
  }

  const log: string[] = []
  const errors: string[] = []
  const fxRows: { date: string; currency: string; rate_try: number }[] = []
  const priceRows: { asset_id: string; date: string; price: number; currency: string; source: string }[] = []

  const { data: assetData, error: assetErr } = await supabase
    .from('assets')
    .select('id, symbol, kind, price_ref, auto_price')
  if (assetErr) {
    return new Response(JSON.stringify({ ok: false, error: assetErr.message }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
  const assets = ((assetData ?? []) as Asset[]).filter((a) => a.auto_price !== false)
  const ref = (a: Asset): string => (a.price_ref?.trim() || a.symbol).toUpperCase()

  // --- döviz ---------------------------------------------------------
  let fx: Record<string, number> = {}
  try {
    const r = await tcmb()
    fx = r.rates
    for (const c of ['USD', 'EUR', 'GBP', 'CHF']) {
      if (r.rates[c]) fxRows.push({ date: r.date, currency: c, rate_try: r.rates[c] })
    }
    for (const a of assets.filter((x) => x.kind === 'doviz')) {
      const p = r.rates[ref(a)]
      if (p) priceRows.push({ asset_id: a.id, date: r.date, price: p, currency: 'TRY', source: 'tcmb' })
    }
    log.push('TCMB: ' + (Object.keys(r.rates).length - 1) + ' kur (' + r.date + ')')
  } catch (e) {
    errors.push('TCMB: ' + msg(e))
  }

  // --- altın & gümüş --------------------------------------------------
  try {
    const r = await truncgil()
    if (r.values.GRA) fxRows.push({ date: r.date, currency: 'XAU', rate_try: r.values.GRA })
    let n = 0
    for (const a of assets.filter((x) => x.kind === 'altin')) {
      const p = r.values[GOLD_MAP[ref(a)] ?? ref(a)]
      if (p) {
        priceRows.push({ asset_id: a.id, date: r.date, price: p, currency: 'TRY', source: 'truncgil' })
        n++
      }
    }
    log.push('Altın: gram ' + (r.values.GRA ?? '?') + ' TL, ' + n + ' varlık (' + r.date + ')')
  } catch (e) {
    errors.push('Altın: ' + msg(e))
  }

  // --- kripto ---------------------------------------------------------
  try {
    const cryptos = assets.filter((x) => x.kind === 'kripto')
    const idOf = (a: Asset): string => a.price_ref?.trim() || CRYPTO_MAP[ref(a)] || ref(a).toLowerCase()
    const prices = await coingecko([...new Set(cryptos.map(idOf))])
    let n = 0
    for (const a of cryptos) {
      const p = prices[idOf(a)]
      if (p) {
        priceRows.push({ asset_id: a.id, date: today(), price: p, currency: 'TRY', source: 'coingecko' })
        n++
      }
    }
    if (cryptos.length) log.push('Kripto: ' + n + '/' + cryptos.length + ' varlık')
  } catch (e) {
    errors.push('Kripto: ' + msg(e))
  }

  // --- BIST hissesi ----------------------------------------------------
  try {
    const stocks = assets.filter((x) => x.kind === 'hisse')
    let n = 0
    for (const a of stocks) {
      const sym = a.price_ref?.trim() || a.symbol.toUpperCase() + '.IS'
      const q = await yahoo(sym)
      if (q) {
        const rate = q.currency === 'TRY' ? 1 : (fx[q.currency] ?? 1)
        priceRows.push({ asset_id: a.id, date: today(), price: q.price * rate, currency: 'TRY', source: 'yahoo' })
        // Geçmiş günler; bugünün satırı zaten yazıldığı için tekilleştirmede elenir
        for (const h of q.history) {
          priceRows.push({
            asset_id: a.id,
            date: h.date,
            price: h.price * rate,
            currency: 'TRY',
            source: 'yahoo-history',
          })
        }
        n++
      }
    }
    if (stocks.length) log.push('Hisse: ' + n + '/' + stocks.length + ' varlık')
  } catch (e) {
    errors.push('Hisse: ' + msg(e))
  }

  // --- fonlar ----------------------------------------------------------
  try {
    const funds = assets.filter((x) => x.kind === 'fon')
    if (funds.length && !fonKey) throw new Error('FONOLOJI_API_KEY tanımlı değil')
    let n = 0
    for (const a of funds) {
      const q = await fonoloji(a.price_ref?.trim() || a.symbol.toUpperCase(), fonKey)
      if (q) {
        priceRows.push({ asset_id: a.id, date: q.date, price: q.price, currency: 'TRY', source: 'fonoloji' })
        n++
      }
    }
    if (funds.length) log.push('Fon: ' + n + '/' + funds.length + ' varlık')

    // --- eksik geçmişi tamamla ---------------------------------------
    // Yeni eklenen fonun tek günlük fiyatı olur; günlük değişim
    // hesaplanamaz. Elinde iki günden az fiyat olan fonların serisi bir
    // kez çekilir, sonraki günlerde bu blok kendiliğinden atlanır.
    if (funds.length) {
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const { data: known } = await supabase
        .from('asset_prices')
        .select('asset_id, date')
        .in('asset_id', funds.map((f) => f.id))
        .gte('date', since)

      const dates = new Map<string, Set<string>>()
      for (const r of (known ?? []) as { asset_id: string; date: string }[]) {
        const set = dates.get(r.asset_id) ?? new Set<string>()
        set.add(r.date)
        dates.set(r.asset_id, set)
      }

      // Geçmişi eksik olan fon: hiç karşılaştırma yapılamayacak kadar az
      // fiyatı var ya da serisinde boşluk kalmış (günlük çekim birkaç gün
      // çalışmamış). İkisi de "dünkü fiyat yok" demek.
      const gapLimit = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10)
      const needy = body.backfill
        ? funds
        : funds.filter((f) => {
          const set = dates.get(f.id)
          if (!set || set.size < 2) return true
          let newest = ''
          for (const d of set) if (d > newest) newest = d
          return newest < gapLimit
        })

      let filled = 0
      for (const a of needy) {
        try {
          const hist = await fonolojiHistory(
            a.price_ref?.trim() || a.symbol.toUpperCase(),
            fonKey,
            body.backfillPeriod ?? '1m',
          )
          for (const h of hist) {
            priceRows.push({
              asset_id: a.id,
              date: h.date,
              price: h.price,
              currency: 'TRY',
              source: 'fonoloji-history',
            })
            filled++
          }
        } catch (e) {
          // Geçmiş çekilemezse günlük fiyat yine de yazılsın
          errors.push('Fon geçmişi (' + a.symbol + '): ' + msg(e))
        }
      }
      if (needy.length) log.push('Fon geçmişi: ' + needy.length + ' fon, ' + filled + ' gün')
    }
  } catch (e) {
    errors.push('Fon: ' + msg(e))
  }

  // --- yaz --------------------------------------------------------------
  if (fxRows.length) {
    const { error } = await supabase.from('fx_rates').upsert(fxRows, { onConflict: 'date,currency' })
    if (error) errors.push('fx_rates yazılamadı: ' + error.message)
  }
  // Geçmiş serisi bugünü de kapsayabildiği için aynı (varlık, gün) iki kez
  // listeye girebilir. Postgres tek upsert'te aynı satıra iki kez dokunmayı
  // reddettiği için önce tekilleştirilir; ilk yazan (güncel fiyat) kazanır.
  const seen = new Set<string>()
  const uniqueRows = priceRows.filter((r) => {
    const k = r.asset_id + '|' + r.date
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  if (uniqueRows.length) {
    const { error } = await supabase.from('asset_prices').upsert(uniqueRows, { onConflict: 'asset_id,date' })
    if (error) errors.push('asset_prices yazılamadı: ' + error.message)
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, fx: fxRows.length, prices: uniqueRows.length, log, errors }),
    { headers: { ...CORS, 'Content-Type': 'application/json' } },
  )
})
