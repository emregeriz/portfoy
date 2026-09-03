import type { AssetKind, TradeWithRefs } from '../types/db'

/**
 * Serbest fon satış kazancından kesilen stopaj oranı. Kazanç oluşan her
 * satışta ayrı ayrı uygulanır; zararlı satış vergi doğurmaz. Zararın
 * kârdan mahsubu (netleştirme) hesaba katılmaz — kesinti işlem bazlıdır.
 *
 * Stopaj yalnızca **fon** türündeki varlıklara uygulanır: BIST hissesi
 * satış kazancından bireysel yatırımcı için stopaj kesilmez.
 */
export const DEFAULT_TAX_RATE = 0.175

/** Bu türlerin satış kazancından stopaj kesilir */
const isTaxable = (kind: AssetKind) => kind === 'fon'

/**
 * Kalemin stopaj oranı. Varlığa oran yazılmışsa o geçerli; yazılmamışsa
 * türün varsayılanı kullanılır. Hisse senedi yoğun fon TEFAS'ta fon
 * görünür ama satış kazancından stopaj kesilmez — assets.tax_rate = 0
 * yazılarak ayrılır (bkz. supabase/fon-stopaj.sql).
 */
function rateOf(kind: AssetKind, assetRate: number | null | undefined, fallback: number) {
  const own = assetRate == null ? null : Number(assetRate)
  if (own != null && Number.isFinite(own)) return own
  return isTaxable(kind) ? fallback : 0
}

export interface Holding {
  symbol: string
  /**
   * Hesap bazında gruplandığında hesabın adı; sembol bazında null.
   * Aynı kâğıdı iki aracı kurumda tutuyorsan pozisyonlar ayrı satır olur,
   * çünkü maliyet ve vergi kurum bazında takip edilir.
   */
  account: string | null
  name: string | null
  kind: AssetKind
  /** Elde kalan net adet */
  quantity: number
  /** Ağırlıklı ortalama birim maliyet */
  avgCost: number
  /** Elde kalan payların maliyeti = quantity × avgCost */
  costBasis: number
  /** Satışlardan kalıcılaşan kâr/zarar — vergi öncesi */
  realized: number
  /** Kârlı satışlardan ödenen toplam vergi */
  realizedTax: number
  /** Vergi düşüldükten sonra cebe kalan gerçekleşen kâr */
  realizedNet: number
  /** Elde kalan paylar bugün satılsa ödenecek vergi */
  potentialTax: number | null
  /** Güncel değer − ödenecek vergi */
  netValue: number | null
  /** Güncel birim fiyat — fiyat yoksa null */
  price: number | null
  priceDate: string | null
  /** Güncel değer; fiyat yoksa null */
  value: number | null
  /** Henüz satılmamış payların kâr/zararı */
  unrealized: number | null
  /** Açık kârın maliyete oranı — yüzde olarak (0,0654 değil 6,54) */
  unrealizedPct: number | null
  buyCount: number
  sellCount: number
  firstDate: string
  lastDate: string
  /** Satış adedi eldekini aştıysa true — veri girişinde eksik alım var demektir */
  oversold: boolean
  /** Bu kâğıttan tahsil edilen brüt temettü */
  dividendGross: number
  /** Temettüden kesilen stopaj */
  dividendTax: number
  /** Cebe giren net temettü */
  dividendNet: number
  /** Bu kâğıda uygulanmış bedelsiz / bölünme sayısı */
  actionCount: number
}

/** Bedelsiz, bölünme, birleşme — adedi ve birim maliyeti değiştiren olaylar */
export interface CorporateAction {
  asset_id: string
  action_date: string
  kind: 'bedelsiz' | 'bolunme' | 'birlesme'
  /** Adet çarpanı: %100 bedelsiz → 2, 1 lot 5 lot olacaksa → 5 */
  ratio: number
  /** Sembol eşleştirmesi için — sorgu assets ile join edilerek doldurulur */
  symbol?: string | null
}

/** Tahsil edilmiş temettü kaydı */
export interface DividendRecord {
  asset_id: string
  account_id: string | null
  pay_date: string
  gross_amount: number
  tax_amount: number
  symbol?: string | null
  account_name?: string | null
}

interface PriceLookup {
  get(symbol: string): { price: number; date: string } | undefined
}

/**
 * İşlem defterinden sembol bazlı pozisyon ve kâr/zarar çıkarır.
 *
 * Maliyet yöntemi **hareketli ağırlıklı ortalama**: her alımda ortalama
 * maliyet yeniden hesaplanır, satışta o anki ortalama maliyet üzerinden
 * kâr/zarar kalıcılaşır. Fonlarda ve BIST'te yaygın olan yöntem budur.
 *
 * İşlemler tarihe göre sıralanarak işlenir — aynı gün birden fazla işlem
 * varsa kayıt sırası (created_at) belirleyicidir.
 */
export interface HoldingOptions {
  taxRate?: number
  /** true ise her hesap ayrı pozisyon sayılır (aynı sembol iki satır olabilir) */
  byAccount?: boolean
  /** Bedelsiz / bölünme kayıtları — sembol bazında uygulanır */
  actions?: CorporateAction[]
  /** Tahsil edilmiş temettüler */
  dividends?: DividendRecord[]
}

export function computeHoldings(
  trades: TradeWithRefs[],
  prices: PriceLookup,
  opts: HoldingOptions = {}
): Holding[] {
  const { taxRate = DEFAULT_TAX_RATE, byAccount = false, actions = [], dividends = [] } = opts

  // Sembol → o kâğıda ait şirket işlemleri (tarihe göre sıralı)
  const actionsBySymbol = new Map<string, CorporateAction[]>()
  for (const a of actions) {
    const sym = a.symbol?.trim().toUpperCase()
    const ratio = Number(a.ratio)
    if (!sym || !Number.isFinite(ratio) || ratio <= 0) continue
    const list = actionsBySymbol.get(sym)
    if (list) list.push(a)
    else actionsBySymbol.set(sym, [a])
  }
  for (const list of actionsBySymbol.values()) {
    list.sort((a, b) => a.action_date.localeCompare(b.action_date))
  }

  // Temettüler sembol → hesap kırılımında toplanır
  const divBySymbol = new Map<string, Map<string, { gross: number; tax: number }>>()
  for (const d of dividends) {
    const sym = d.symbol?.trim().toUpperCase()
    if (!sym) continue
    const acc = byAccount ? (d.account_name ?? 'Belirtilmemiş') : ''
    const inner = divBySymbol.get(sym) ?? new Map<string, { gross: number; tax: number }>()
    const cur = inner.get(acc) ?? { gross: 0, tax: 0 }
    cur.gross += Number(d.gross_amount ?? 0)
    cur.tax += Number(d.tax_amount ?? 0)
    inner.set(acc, cur)
    divBySymbol.set(sym, inner)
  }

  // Gruplama anahtarı: sembol, hesap bazlı istendiğinde sembol + hesap
  const groups = new Map<string, { symbol: string; account: string | null; rows: TradeWithRefs[] }>()
  for (const t of trades) {
    const sym = t.assets?.symbol?.trim().toUpperCase()
    if (!sym) continue
    const account = byAccount ? (t.accounts?.name ?? 'Belirtilmemiş') : null
    const key = account ? `${sym}\u0000${account}` : sym
    const g = groups.get(key)
    if (g) g.rows.push(t)
    else groups.set(key, { symbol: sym, account, rows: [t] })
  }

  const out: Holding[] = []
  for (const { symbol, account, list } of [...groups.values()].map((g) => ({ ...g, list: g.rows }))) {
    const sorted = [...list].sort(
      (a, b) => a.trade_date.localeCompare(b.trade_date) || a.created_at.localeCompare(b.created_at)
    )
    const kind = (sorted[0].assets?.kind ?? 'diger') as AssetKind
    // Hisse satışından stopaj kesilmez; fonda kalemin kendi oranı varsa o geçerli
    const rate = rateOf(kind, sorted[0].assets?.tax_rate, taxRate)

    let qty = 0
    let costBasis = 0
    let realized = 0
    let realizedTax = 0
    let buyCount = 0
    let sellCount = 0
    let oversold = false
    let actionCount = 0

    /**
     * Bedelsiz ve bölünme, işlemlerle aynı zaman çizelgesinde işlenir.
     * Olay anında eldeki adet çarpanla çarpılır, TOPLAM MALİYET DEĞİŞMEZ —
     * bedelsiz pay bedava gelir, birim maliyet kendiliğinden düşer. Geçmiş
     * alışları geriye dönük yeniden yazmaya gerek kalmaz; olaydan sonraki
     * alımlar da doğal olarak yeni fiyat düzeyinden girer.
     */
    const pending = [...(actionsBySymbol.get(symbol) ?? [])]
    const applyActionsUntil = (date: string) => {
      while (pending.length && pending[0].action_date <= date) {
        const a = pending.shift()!
        if (qty > 1e-9) {
          qty *= Number(a.ratio)
          actionCount++
        }
      }
    }

    for (const t of sorted) {
      const tradeQty = Number(t.quantity)
      const tradeAmount = Number(t.amount_try ?? Number(t.amount) * Number(t.fx_rate ?? 1))
      if (!Number.isFinite(tradeQty) || tradeQty <= 0) continue

      // İşlemden önceki tarihli olaylar önce uygulanır
      applyActionsUntil(t.trade_date)

      if (t.side === 'alis') {
        qty += tradeQty
        costBasis += tradeAmount
        buyCount++
      } else {
        sellCount++
        // Elde olandan fazlası satılamaz; fazlasını maliyetsiz kabul et
        const sellQty = Math.min(tradeQty, qty)
        if (tradeQty > qty + 1e-9) oversold = true
        const avg = qty > 0 ? costBasis / qty : 0
        // Kısmi satışta gelirin de aynı oranı dikkate alınır
        const proceeds = tradeQty > 0 ? tradeAmount * (sellQty / tradeQty) : 0
        const gain = proceeds - sellQty * avg
        realized += gain
        // Zararlı satıştan vergi kesilmez
        if (gain > 0) realizedTax += gain * rate
        qty -= sellQty
        costBasis -= sellQty * avg
        if (qty <= 1e-9) {
          qty = 0
          costBasis = 0
        }
      }
    }

    // Son işlemden sonra gelen bedelsizler de sayılsın
    applyActionsUntil('9999-12-31')

    const div = divBySymbol.get(symbol)?.get(byAccount ? (account ?? 'Belirtilmemiş') : '')
    const dividendGross = div?.gross ?? 0
    const dividendTax = div?.tax ?? 0

    const avgCost = qty > 0 ? costBasis / qty : 0
    const latest = prices.get(symbol)
    const price = latest ? Number(latest.price) : null
    const value = price != null ? qty * price : null
    const unrealized = value != null ? value - costBasis : null
    const potentialTax = unrealized != null ? Math.max(0, unrealized) * rate : null
    const netValue = value != null && potentialTax != null ? value - potentialTax : null

    out.push({
      symbol,
      account,
      name: sorted[0].assets?.name ?? null,
      kind,
      quantity: qty,
      avgCost,
      costBasis,
      realized,
      realizedTax,
      realizedNet: realized - realizedTax,
      potentialTax,
      netValue,
      price,
      priceDate: latest?.date ?? null,
      value,
      unrealized,
      unrealizedPct: unrealized != null && costBasis > 0 ? (unrealized / costBasis) * 100 : null,
      buyCount,
      sellCount,
      firstDate: sorted[0].trade_date,
      lastDate: sorted[sorted.length - 1].trade_date,
      oversold,
      dividendGross,
      dividendTax,
      dividendNet: dividendGross - dividendTax,
      actionCount,
    })
  }

  // Açık pozisyonlar önce, sonra kapanmışlar; her grup değere göre azalan
  return out.sort((a, b) => {
    if ((a.quantity > 0) !== (b.quantity > 0)) return a.quantity > 0 ? -1 : 1
    const byValue = (b.value ?? b.costBasis) - (a.value ?? a.costBasis)
    if (byValue !== 0) return byValue
    return (a.account ?? '').localeCompare(b.account ?? '', 'tr')
  })
}

export interface HoldingTotals {
  costBasis: number
  value: number
  unrealized: number
  /** Gerçekleşen kâr — vergi öncesi */
  realized: number
  /** Satışlarda ödenmiş vergi */
  realizedTax: number
  /** Vergi sonrası gerçekleşen kâr */
  realizedNet: number
  /** Elde kalanlar bugün satılsa ödenecek vergi */
  potentialTax: number
  /** Güncel değer − ödenecek vergi */
  netValue: number
  /** Vergiler düşüldükten sonra toplam kâr (gerçekleşen + açık) */
  netProfit: number
  /** Ödenmiş + ödenecek toplam vergi */
  totalTax: number
  /** Güncel fiyatı bulunamayan sembol sayısı */
  unpriced: number
  /** Tahsil edilen brüt temettü */
  dividendGross: number
  /** Temettüden kesilen stopaj */
  dividendTax: number
  /** Cebe giren net temettü */
  dividendNet: number
  /**
   * Toplam getiri: alım satım kârı + açık kâr + temettü, vergiler düşülmüş.
   * netProfit'ten farkı temettüyü de içermesi — fiyat farkı tek başına
   * hisse getirisini eksik anlatıyor.
   */
  totalReturn: number
}

export function holdingTotals(holdings: Holding[]): HoldingTotals {
  let costBasis = 0
  let value = 0
  let realized = 0
  let realizedTax = 0
  let potentialTax = 0
  let unpriced = 0
  let dividendGross = 0
  let dividendTax = 0
  for (const h of holdings) {
    realized += h.realized
    realizedTax += h.realizedTax
    // Temettü kapanmış pozisyonlarda da cepte kalır — adet şartı yok
    dividendGross += h.dividendGross
    dividendTax += h.dividendTax
    if (h.quantity <= 0) continue
    costBasis += h.costBasis
    // Fiyatı olmayan kalem maliyetiyle sayılır ki toplam değer düşük görünmesin
    value += h.value ?? h.costBasis
    potentialTax += h.potentialTax ?? 0
    if (h.price == null) unpriced++
  }
  const unrealized = value - costBasis
  const realizedNet = realized - realizedTax
  const dividendNet = dividendGross - dividendTax
  const netProfit = realizedNet + (unrealized - potentialTax)
  return {
    costBasis,
    value,
    unrealized,
    realized,
    realizedTax,
    realizedNet,
    potentialTax,
    netValue: value - potentialTax,
    netProfit,
    totalTax: realizedTax + potentialTax,
    unpriced,
    dividendGross,
    dividendTax,
    dividendNet,
    totalReturn: netProfit + dividendNet,
  }
}

export interface ValuePoint {
  date: string
  /** O tarihe kadarki net maliyet */
  cost: number
  /** O tarihteki bilinen fiyatlarla değer */
  value: number
  /** O gün satılsa vergi düşüldükten sonra kalacak tutar */
  netValue: number
}

/**
 * İşlem defterinden değer zaman serisi çıkarır.
 *
 * Her işlem tarihinde portföy yeniden değerlenir. Geçmiş fiyat tablosu
 * tutulmadığı için o tarihteki fiyat olarak **işlemin kendi birim fiyatı**
 * kullanılır; fiyatı bilinmeyen semboller son bilinen fiyatlarını korur.
 * Son nokta bugünkü güncel fiyatlarla eklenir. Yani seri gerçek günlük
 * değer eğrisi değil, işlem anlarından geçen bir yaklaşımdır.
 */
export function holdingsSeries(
  trades: TradeWithRefs[],
  prices: PriceLookup,
  todayISO: string,
  taxRate = DEFAULT_TAX_RATE,
  actions: CorporateAction[] = []
): ValuePoint[] {
  const sorted = [...trades]
    .filter((t) => t.assets?.symbol)
    .sort(
      (a, b) => a.trade_date.localeCompare(b.trade_date) || a.created_at.localeCompare(b.created_at)
    )
  if (!sorted.length) return []

  const qty = new Map<string, number>()
  const cost = new Map<string, number>()
  const lastPrice = new Map<string, number>()
  /** Sembol → stopaj oranı; kaleme oran yazılmışsa türün varsayılanını ezer */
  const rateOfSymbol = new Map<string, number>()
  const points: ValuePoint[] = []

  const snapshot = (date: string) => {
    let totalCost = 0
    let totalValue = 0
    let tax = 0
    for (const [sym, q] of qty) {
      if (q <= 0) continue
      const c = cost.get(sym) ?? 0
      const p = lastPrice.get(sym)
      const v = p != null ? q * p : c
      totalCost += c
      totalValue += v
      // Stopaj sembol bazında: kaleme oran yazılmışsa o, yoksa türün varsayılanı
      tax += Math.max(0, v - c) * (rateOfSymbol.get(sym) ?? 0)
    }
    const netValue = totalValue - tax
    // Aynı güne birden fazla işlem düşerse tek nokta kalsın
    const prev = points[points.length - 1]
    if (prev && prev.date === date) {
      prev.cost = totalCost
      prev.value = totalValue
      prev.netValue = netValue
    } else {
      points.push({ date, cost: totalCost, value: totalValue, netValue })
    }
  }

  // Bedelsiz / bölünme — tarihi gelen olay o güne kadarki adedi çarpar
  const timeline = [...actions]
    .filter((a) => a.symbol && Number(a.ratio) > 0)
    .sort((a, b) => a.action_date.localeCompare(b.action_date))
  const applyActionsUntil = (date: string) => {
    while (timeline.length && timeline[0].action_date <= date) {
      const a = timeline.shift()!
      const sym = a.symbol!.trim().toUpperCase()
      const q = qty.get(sym) ?? 0
      if (q > 1e-9) qty.set(sym, q * Number(a.ratio))
    }
  }

  for (const t of sorted) {
    const sym = t.assets!.symbol.trim().toUpperCase()
    const rate = Number(t.fx_rate ?? 1)
    const tradeQty = Number(t.quantity)
    const tradeAmount = Number(t.amount_try ?? Number(t.amount) * rate)
    if (!Number.isFinite(tradeQty) || tradeQty <= 0) continue

    applyActionsUntil(t.trade_date)
    lastPrice.set(sym, Number(t.unit_price) * rate)
    rateOfSymbol.set(
      sym,
      rateOf((t.assets?.kind ?? 'diger') as AssetKind, t.assets?.tax_rate, taxRate)
    )
    const q = qty.get(sym) ?? 0
    const c = cost.get(sym) ?? 0

    if (t.side === 'alis') {
      qty.set(sym, q + tradeQty)
      cost.set(sym, c + tradeAmount)
    } else {
      const sellQty = Math.min(tradeQty, q)
      const avg = q > 0 ? c / q : 0
      qty.set(sym, q - sellQty)
      cost.set(sym, Math.max(0, c - sellQty * avg))
    }
    snapshot(t.trade_date)
  }

  // Son işlemden sonraki olaylar da uygulanmalı
  applyActionsUntil(todayISO)

  // Bugünkü güncel fiyatlarla son nokta
  for (const [sym] of qty) {
    const latest = prices.get(sym)
    if (latest) lastPrice.set(sym, Number(latest.price))
  }
  snapshot(todayISO)

  return points
}

/** Sembol türüne göre güncel değer dağılımı */
export function holdingsByKind(holdings: Holding[]): { key: string; value: number }[] {
  const map = new Map<string, number>()
  for (const h of holdings) {
    if (h.quantity <= 0) continue
    map.set(h.kind, (map.get(h.kind) ?? 0) + (h.value ?? h.costBasis))
  }
  return [...map.entries()].map(([key, value]) => ({ key, value }))
}

/**
 * Hesap bazlı değer dağılımı. Satışta hangi hesabın payının satıldığı
 * kayıtlı olmadığı için sembolün güncel değeri, hesapların net alım
 * adedi oranında paylaştırılır.
 */
export function holdingsByAccount(
  trades: TradeWithRefs[],
  holdings: Holding[]
): { key: string; value: number }[] {
  const bySymbol = new Map<string, Map<string, number>>()
  for (const t of trades) {
    const sym = t.assets?.symbol?.trim().toUpperCase()
    if (!sym) continue
    const name = t.accounts?.name ?? 'Belirtilmemiş'
    const inner = bySymbol.get(sym) ?? new Map<string, number>()
    const signed = t.side === 'alis' ? Number(t.quantity) : -Number(t.quantity)
    inner.set(name, (inner.get(name) ?? 0) + signed)
    bySymbol.set(sym, inner)
  }

  const out = new Map<string, number>()
  for (const h of holdings) {
    if (h.quantity <= 0) continue
    const inner = bySymbol.get(h.symbol)
    const total = h.value ?? h.costBasis
    if (!inner) {
      out.set('Belirtilmemiş', (out.get('Belirtilmemiş') ?? 0) + total)
      continue
    }
    const positive = [...inner.entries()].filter(([, q]) => q > 0)
    const sum = positive.reduce((s, [, q]) => s + q, 0)
    if (sum <= 0) continue
    for (const [name, q] of positive) {
      out.set(name, (out.get(name) ?? 0) + (total * q) / sum)
    }
  }
  return [...out.entries()].map(([key, value]) => ({ key, value }))
}
