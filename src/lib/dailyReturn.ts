import type { AssetKind } from '../types/db'

/**
 * Günlük kâr motoru — "bugün ne kazandım" ve "her gün ne kazandım"
 * sorularının tek kaynağı.
 *
 * Bir günün kazancı üç ayrı kalemden toplanır; ikisi fiyat hareketi,
 * biri nakit gelir:
 *
 *   1. Gün boyu elde tutulan pay → adet × (o günün kapanışı − önceki kapanış)
 *   2. O gün SATILAN pay         → adet × (gerçekleşen satış fiyatı − önceki kapanış)
 *   3. O gün ALINAN pay          → adet × (o günün kapanışı − alış fiyatı)
 *
 * İkinci madde işin can alıcı yeri: satış gerçekleştiyse kâğıdın gün sonu
 * fiyatının bir önemi kalmaz — para hangi fiyattan çıktıysa o günün kazancı
 * odur. Halka arzda her hesap ayrı fiyattan satıldığı için satış kalemleri
 * hesap hesap ayrı tutulur. "Dünkü fiyat" da takvim günü değil **bir önceki
 * fiyat günü**dür; araya hafta sonu ya da tatil girse de doğru çalışır.
 *
 * Bu üçlü ayrıştırma toplamda şu kimliğe eşittir:
 *
 *   gün kârı = (gün sonu değer + gün içi satış geliri)
 *            − (gün başı değer + gün içi alış maliyeti)
 *
 * yani araya konan/çıkan para kâr sayılmaz. Bir kâğıdın ömrü boyunca günlük
 * kârları toplandığında gerçekleşen kâra birebir oturur.
 */

// --------------------------------------------------------------------
// Ham girdi satırları — hook bunları Supabase'ten olduğu gibi taşır
// --------------------------------------------------------------------

export interface RawTrade {
  asset_id: string | null
  side: string
  quantity: number
  unit_price: number | null
  amount_try: number | null
  trade_date: string
  created_at?: string
}

export interface RawPrice {
  asset_id: string
  date: string
  price: number
}

export interface RawAsset {
  id: string
  symbol: string
  kind: AssetKind
}

export interface RawAction {
  asset_id: string
  action_date: string
  ratio: number
}

export interface RawIpo {
  id: string
  bist_code: string | null
  lot_price: number | null
  manual_price: number | null
  trade_start_date: string | null
  ipo_date: string | null
  status: string
}

export interface RawEntry {
  ipo_id: string
  account_id: string
  allocated_lot: number
  sold_lot: number | null
  sold_price: number | null
  sold_date: string | null
  participated: boolean
}

/** Snapshot pozisyonu — alım/satım defterine girmemiş varlıklar için */
export interface RawSnapPosition {
  snapshot_date: string
  asset_id: string
  quantity: number
}

export interface RawIncome {
  date: string
  amount: number
}

export interface RawDividend {
  asset_id: string | null
  pay_date: string
  gross_amount: number
  tax_amount: number
}

// --------------------------------------------------------------------
// Çıktı
// --------------------------------------------------------------------

export type DailySource = 'portfoy' | 'ipo' | 'nema' | 'temettu'
/** tut = gün boyu elde · satis = o gün satıldı · alis = o gün alındı · gelir = nakit */
export type DailyPart = 'tut' | 'satis' | 'alis' | 'gelir'

export interface DailyItem {
  key: string
  symbol: string
  kind: AssetKind
  source: DailySource
  part: DailyPart
  /** Halka arz satışlarında hangi hesaptan satıldı */
  account: string | null
  qty: number
  /** Karşılaştırma fiyatı — önceki kapanış, alışta kendi alış fiyatı */
  from: number | null
  /** Ulaşılan fiyat — kapanış, satışta gerçekleşen satış fiyatı */
  to: number | null
  delta: number
  /** from üzerinden yüzde değişim */
  pct: number | null
  /** Referans önceki kapanış değil, halka arz fiyatı */
  vsIpoPrice?: boolean
  /** Aynı gün alınıp satıldı — referans kendi alış fiyatı */
  sameDay?: boolean
}

export interface DailyHolding {
  symbol: string
  kind: AssetKind
  source: 'portfoy' | 'ipo'
  qty: number
  price: number | null
  priceDate: string | null
  value: number | null
  /** O günün bu kalemden gelen kâr/zararı */
  delta: number
}

export interface DailyRow {
  date: string
  total: number
  /** Fon ve hisse pozisyonları */
  priceDelta: number
  /** Halka arz — elde tutulan + o gün satılan lotlar */
  ipoDelta: number
  nema: number
  dividend: number
  items: DailyItem[]
  /** Gün sonunda elde ne vardı */
  holdings: DailyHolding[]
  /** Gün sonu pozisyon değeri */
  value: number
  /** Gün başı pozisyon değeri — yüzde bunun üzerinden */
  base: number
  pct: number | null
  /** Önceki gün fiyatı bulunamadığı için ölçülemeyen kalem sayısı */
  unmeasured: number
  /** O gün hiç fiyat yayınlandı mı — borsa kapalıysa false */
  hasPrices: boolean
  /** Gün sonunda elde tutulan halka arz lotu */
  ipoLots: number
}

export interface DailyInput {
  /** Hesabın başlayacağı gün (dahil) */
  from: string
  /** Hesabın biteceği gün (dahil) */
  to: string
  trades: RawTrade[]
  prices: RawPrice[]
  assets: RawAsset[]
  actions: RawAction[]
  ipos: RawIpo[]
  entries: RawEntry[]
  accounts: { id: string; name: string }[]
  snapshots: RawSnapPosition[]
  nema: RawIncome[]
  dividends: RawDividend[]
}

/** Adet karşılaştırmalarında kayan nokta toleransı */
const EPS = 1e-9
/** Yarım kuruşun altındaki hareket kalem olarak listelenmez */
const MIN_ITEM = 0.005

interface Flow {
  buyQty: number
  buyCost: number
  sellQty: number
  sellProceeds: number
}

interface IpoLot {
  accountId: string
  alloc: number
  soldLot: number
  soldPrice: number | null
  soldDate: string | null
}

interface IpoPos {
  code: string
  assetId: string | null
  lotPrice: number
  manualPrice: number | null
  startDay: string | null
  lots: IpoLot[]
}

/** dates dizisinde `date`ten küçük (inclusive ise küçük-eşit) son indeks */
function lastIndex(dates: string[], date: string, inclusive: boolean): number {
  let lo = 0
  let hi = dates.length - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const ok = inclusive ? dates[mid] <= date : dates[mid] < date
    if (ok) {
      hit = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return hit
}

export function computeDailyReturns(input: DailyInput): DailyRow[] {
  const { from, to } = input

  const assetById = new Map<string, RawAsset>()
  const idBySymbol = new Map<string, string>()
  for (const a of input.assets) {
    assetById.set(a.id, a)
    idBySymbol.set(a.symbol.trim().toUpperCase(), a.id)
  }
  const accountName = new Map(input.accounts.map((a) => [a.id, a.name] as const))

  // ------------------------------------------------------ fiyat indeksi
  const series = new Map<string, { dates: string[]; prices: number[]; byDate: Map<string, number> }>()
  const pricedDays = new Set<string>()
  for (const p of [...input.prices].sort((a, b) => a.date.localeCompare(b.date))) {
    const price = Number(p.price)
    if (!Number.isFinite(price) || price <= 0) continue
    let s = series.get(p.asset_id)
    if (!s) {
      s = { dates: [], prices: [], byDate: new Map() }
      series.set(p.asset_id, s)
    }
    if (s.byDate.has(p.date)) continue
    s.dates.push(p.date)
    s.prices.push(price)
    s.byDate.set(p.date, price)
    pricedDays.add(p.date)
  }

  const priceOn = (id: string | null, date: string): number | null =>
    (id ? series.get(id)?.byDate.get(date) : null) ?? null

  /** `date`ten ÖNCEKİ son fiyat — hafta sonu araya girse de doğru günü bulur */
  const priceBefore = (id: string | null, date: string): number | null => {
    if (!id) return null
    const s = series.get(id)
    if (!s) return null
    const i = lastIndex(s.dates, date, false)
    return i >= 0 ? s.prices[i] : null
  }

  /** `date` dahil, o güne kadarki son fiyat — değerleme için */
  const priceAsOf = (id: string | null, date: string): { price: number; date: string } | null => {
    if (!id) return null
    const s = series.get(id)
    if (!s) return null
    const i = lastIndex(s.dates, date, true)
    return i >= 0 ? { price: s.prices[i], date: s.dates[i] } : null
  }

  // ------------------------------------------------- halka arz pozisyonları
  const entriesByIpo = new Map<string, RawEntry[]>()
  for (const e of input.entries) {
    if (!e.participated) continue
    const list = entriesByIpo.get(e.ipo_id)
    if (list) list.push(e)
    else entriesByIpo.set(e.ipo_id, [e])
  }

  const ipoByCode = new Map<string, IpoPos>()
  for (const ipo of input.ipos) {
    const code = ipo.bist_code?.trim().toUpperCase()
    // Talep aşamasındaki ve iptal olan arzda hisse yok
    if (!code || ipo.status === 'talep_verildi' || ipo.status === 'iptal') continue
    const lots: IpoLot[] = []
    for (const e of entriesByIpo.get(ipo.id) ?? []) {
      const alloc = Number(e.allocated_lot)
      if (!(alloc > 0)) continue
      lots.push({
        accountId: e.account_id,
        alloc,
        soldLot: Number(e.sold_lot ?? 0),
        soldPrice: e.sold_price != null ? Number(e.sold_price) : null,
        soldDate: e.sold_date,
      })
    }
    if (!lots.length) continue

    const assetId = idBySymbol.get(code) ?? null
    // İlk işlem günü: girilmişse o, yoksa fiyatın ilk göründüğü gün
    const start =
      ipo.trade_start_date ?? (assetId ? series.get(assetId)?.dates[0] : null) ?? ipo.ipo_date ?? null

    const cur = ipoByCode.get(code)
    if (cur) {
      cur.lots.push(...lots)
      if (start && (!cur.startDay || start < cur.startDay)) cur.startDay = start
      if (cur.manualPrice == null && ipo.manual_price != null) cur.manualPrice = Number(ipo.manual_price)
    } else {
      ipoByCode.set(code, {
        code,
        assetId,
        lotPrice: Number(ipo.lot_price ?? 0),
        manualPrice: ipo.manual_price != null ? Number(ipo.manual_price) : null,
        startDay: start,
        lots,
      })
    }
  }

  // ------------------------------------------------------- olay zaman çizgisi
  // Şirket işlemi aynı gün işlemden önce uygulanır (holdings.ts ile aynı sıra)
  interface Event {
    date: string
    rank: 0 | 1
    action?: RawAction
    trade?: RawTrade
  }
  const events: Event[] = []
  for (const a of input.actions) {
    if (a.asset_id && Number(a.ratio) > 0) events.push({ date: a.action_date, rank: 0, action: a })
  }
  for (const t of input.trades) {
    if (t.asset_id) events.push({ date: t.trade_date, rank: 1, trade: t })
  }
  events.sort(
    (x, y) =>
      x.date.localeCompare(y.date) ||
      x.rank - y.rank ||
      (x.trade?.created_at ?? '').localeCompare(y.trade?.created_at ?? '')
  )

  const tradedIds = new Set<string>()
  for (const t of input.trades) if (t.asset_id) tradedIds.add(t.asset_id)

  // --------------------------------------------------- snapshot pozisyonları
  // Alım/satım defterine hiç girmemiş varlık yalnızca snapshot'tan bilinir;
  // o günkü adet, o güne kadarki son snapshot'ın adedidir.
  const snapDates: string[] = []
  const snapByDate = new Map<string, Map<string, number>>()
  for (const p of input.snapshots) {
    if (!p.asset_id || tradedIds.has(p.asset_id)) continue
    const q = Number(p.quantity ?? 0)
    if (!(q > 0)) continue
    let m = snapByDate.get(p.snapshot_date)
    if (!m) {
      m = new Map()
      snapByDate.set(p.snapshot_date, m)
      snapDates.push(p.snapshot_date)
    }
    m.set(p.asset_id, (m.get(p.asset_id) ?? 0) + q)
  }
  snapDates.sort()
  const emptySnap = new Map<string, number>()
  const snapQtyAt = (day: string): Map<string, number> => {
    const i = lastIndex(snapDates, day, true)
    return i >= 0 ? (snapByDate.get(snapDates[i]) ?? emptySnap) : emptySnap
  }

  // ------------------------------------------------------------ gün listesi
  const nemaByDay = new Map<string, number>()
  for (const n of input.nema) {
    const amt = Number(n.amount)
    if (Number.isFinite(amt)) nemaByDay.set(n.date, (nemaByDay.get(n.date) ?? 0) + amt)
  }
  const divByDay = new Map<string, RawDividend[]>()
  for (const d of input.dividends) {
    const list = divByDay.get(d.pay_date)
    if (list) list.push(d)
    else divByDay.set(d.pay_date, [d])
  }

  const dayset = new Set<string>()
  const inRange = (d: string | null | undefined): boolean => !!d && d >= from && d <= to
  for (const d of pricedDays) if (inRange(d)) dayset.add(d)
  for (const t of input.trades) if (inRange(t.trade_date)) dayset.add(t.trade_date)
  for (const d of nemaByDay.keys()) if (inRange(d)) dayset.add(d)
  for (const d of divByDay.keys()) if (inRange(d)) dayset.add(d)
  for (const pos of ipoByCode.values()) {
    if (inRange(pos.startDay)) dayset.add(pos.startDay as string)
    for (const l of pos.lots) if (l.soldLot > 0 && inRange(l.soldDate)) dayset.add(l.soldDate as string)
  }
  const days = [...dayset].sort()

  // --------------------------------------------------------------- ana döngü
  const qty = new Map<string, number>()
  const ratioToday = new Map<string, number>()
  let ei = 0

  const applyEvent = (e: Event, sameDay: boolean) => {
    if (e.action) {
      const id = e.action.asset_id
      const held = qty.get(id) ?? 0
      const ratio = Number(e.action.ratio)
      if (held > EPS) {
        qty.set(id, held * ratio)
        if (sameDay) ratioToday.set(id, (ratioToday.get(id) ?? 1) * ratio)
      }
      return
    }
    const t = e.trade
    if (!t?.asset_id) return
    const q = Number(t.quantity)
    if (!Number.isFinite(q)) return
    qty.set(t.asset_id, (qty.get(t.asset_id) ?? 0) + (t.side === 'alis' ? q : -q))
  }

  const rows: DailyRow[] = []

  for (const day of days) {
    // 1) Bu günden önceki her şey uygulanır — gün başı adetler böyle oluşur
    while (ei < events.length && events[ei].date < day) applyEvent(events[ei++], false)

    const startQty = new Map(qty)
    ratioToday.clear()

    // 2) Günün kendi hareketleri
    const flows = new Map<string, Flow>()
    while (ei < events.length && events[ei].date === day) {
      const e = events[ei++]
      applyEvent(e, true)
      const t = e.trade
      if (!t?.asset_id) continue
      const q = Number(t.quantity)
      const amt = Number(t.amount_try ?? q * Number(t.unit_price ?? 0))
      if (!Number.isFinite(q) || !Number.isFinite(amt)) continue
      const f = flows.get(t.asset_id) ?? { buyQty: 0, buyCost: 0, sellQty: 0, sellProceeds: 0 }
      if (t.side === 'alis') {
        f.buyQty += q
        f.buyCost += amt
      } else {
        f.sellQty += q
        f.sellProceeds += amt
      }
      flows.set(t.asset_id, f)
    }

    const hasPrices = pricedDays.has(day)
    const items: DailyItem[] = []
    const deltaBySymbol = new Map<string, number>()
    let unmeasured = 0
    let base = 0

    const push = (it: DailyItem) => {
      const ref = it.from != null && it.qty > 0 ? Math.abs(it.from * it.qty) : 0
      items.push({ ...it, pct: ref > 0 ? (it.delta / ref) * 100 : null })
      const k = `${it.source}:${it.symbol}`
      deltaBySymbol.set(k, (deltaBySymbol.get(k) ?? 0) + it.delta)
    }

    // ----------------------------------------------- halka arz kalemleri
    /** Bu gün arz tarafında sayılan varlıklar — portföy tarafı iki kez saymasın */
    const ipoAssets = new Set<string>()
    const ipoHold: { pos: IpoPos; qty: number }[] = []
    let ipoLots = 0

    for (const pos of ipoByCode.values()) {
      if (!pos.startDay || day < pos.startDay) continue
      const first = day === pos.startDay

      let allocTotal = 0
      let soldBefore = 0
      const soldToday: IpoLot[] = []
      for (const l of pos.lots) {
        allocTotal += l.alloc
        if (l.soldLot > 0 && l.soldDate) {
          if (l.soldDate < day) soldBefore += l.soldLot
          else if (l.soldDate === day) soldToday.push(l)
        }
      }
      const dayStart = allocTotal - soldBefore
      if (dayStart <= EPS && !soldToday.length) continue

      if (pos.assetId) ipoAssets.add(pos.assetId)

      // İlk işlem gününde borsada "dünkü kapanış" yoktur: para halka arz
      // fiyatında bağlıydı, günün kazancı arz fiyatına göre ölçülür.
      const prevClose = first ? null : priceBefore(pos.assetId, day)
      const ref = prevClose ?? pos.lotPrice
      const vsIpo = prevClose == null
      const close = priceOn(pos.assetId, day)

      let soldQty = 0
      for (const l of soldToday) {
        soldQty += l.soldLot
        if (l.soldPrice == null || !(ref > 0)) {
          unmeasured++
          continue
        }
        const price = Number(l.soldPrice)
        push({
          key: `ipo:${pos.code}:satis:${l.accountId}`,
          symbol: pos.code,
          kind: 'hisse',
          source: 'ipo',
          part: 'satis',
          account: accountName.get(l.accountId) ?? null,
          qty: l.soldLot,
          from: ref,
          to: price,
          delta: l.soldLot * (price - ref),
          pct: null,
          vsIpoPrice: vsIpo,
        })
      }

      const held = dayStart - soldQty
      if (held > EPS) {
        if (ref > 0) base += held * ref
        ipoLots += held
        ipoHold.push({ pos, qty: held })
        if (pos.manualPrice != null) {
          // Fiyatı elle girilen arzın günlük değişimi ölçülmez
        } else if (close == null) {
          if (hasPrices) unmeasured++
        } else if (!(ref > 0)) {
          unmeasured++
        } else {
          push({
            key: `ipo:${pos.code}:tut`,
            symbol: pos.code,
            kind: 'hisse',
            source: 'ipo',
            part: 'tut',
            account: null,
            qty: held,
            from: ref,
            to: close,
            delta: held * (close - ref),
            pct: null,
            vsIpoPrice: vsIpo,
          })
        }
      }
    }

    // -------------------------------------------------- fon / hisse kalemleri
    const snapQty = snapQtyAt(day)
    const touched = new Set<string>([
      ...startQty.keys(),
      ...qty.keys(),
      ...flows.keys(),
      ...snapQty.keys(),
    ])

    for (const assetId of touched) {
      // Arz tarafında sayılan kâğıt burada tekrar sayılmaz
      if (ipoAssets.has(assetId)) continue
      const fromSnap = !tradedIds.has(assetId)
      const qs = fromSnap ? (snapQty.get(assetId) ?? 0) : (startQty.get(assetId) ?? 0)
      const qe = fromSnap ? qs : (qty.get(assetId) ?? 0)
      const f = flows.get(assetId)
      if (qs <= EPS && qe <= EPS && !f) continue

      const asset = assetById.get(assetId)
      const symbol = asset?.symbol.trim().toUpperCase() ?? '—'
      const kind: AssetKind = asset?.kind ?? 'diger'
      const close = priceOn(assetId, day)
      const prev = priceBefore(assetId, day)
      if (qs > EPS && prev != null) base += qs * prev

      const ratio = ratioToday.get(assetId) ?? 1
      if (ratio !== 1) {
        // Bedelsiz / bölünme günü: adet ve fiyat birlikte değişir, kalem
        // ayrıştırılmaz — gün toplu formülle ölçülür.
        if (close == null || prev == null) {
          unmeasured++
          continue
        }
        push({
          key: `p:${assetId}:tut`,
          symbol,
          kind,
          source: 'portfoy',
          part: 'tut',
          account: null,
          qty: qe,
          from: prev,
          to: close,
          delta: qe * close + (f?.sellProceeds ?? 0) - (qs * prev + (f?.buyCost ?? 0)),
          pct: null,
        })
        continue
      }

      const sellQty = f?.sellQty ?? 0
      const buyQty = f?.buyQty ?? 0
      const avgSell = f && sellQty > EPS ? f.sellProceeds / sellQty : null
      const avgBuy = f && buyQty > EPS ? f.buyCost / buyQty : null

      // Satış önce dünden gelen paydan karşılanır, kalanı gün içi alınandan
      const sellFromHeld = Math.min(sellQty, Math.max(qs, 0))
      const sellFromToday = sellQty - sellFromHeld
      const heldThrough = Math.max(qs - sellFromHeld, 0)
      const boughtKept = Math.max(buyQty - sellFromToday, 0)

      if (sellFromHeld > EPS && avgSell != null) {
        if (prev == null) unmeasured++
        else
          push({
            key: `p:${assetId}:satis`,
            symbol,
            kind,
            source: 'portfoy',
            part: 'satis',
            account: null,
            qty: sellFromHeld,
            from: prev,
            to: avgSell,
            delta: sellFromHeld * (avgSell - prev),
            pct: null,
          })
      }
      if (sellFromToday > EPS && avgSell != null && avgBuy != null) {
        push({
          key: `p:${assetId}:gunici`,
          symbol,
          kind,
          source: 'portfoy',
          part: 'satis',
          account: null,
          qty: sellFromToday,
          from: avgBuy,
          to: avgSell,
          delta: sellFromToday * (avgSell - avgBuy),
          pct: null,
          sameDay: true,
        })
      }
      if (heldThrough > EPS) {
        if (close == null) {
          if (hasPrices) unmeasured++
        } else if (prev == null) {
          unmeasured++
        } else {
          push({
            key: `p:${assetId}:tut`,
            symbol,
            kind,
            source: 'portfoy',
            part: 'tut',
            account: null,
            qty: heldThrough,
            from: prev,
            to: close,
            delta: heldThrough * (close - prev),
            pct: null,
          })
        }
      }
      if (boughtKept > EPS && avgBuy != null) {
        if (close == null) {
          if (hasPrices) unmeasured++
        } else {
          push({
            key: `p:${assetId}:alis`,
            symbol,
            kind,
            source: 'portfoy',
            part: 'alis',
            account: null,
            qty: boughtKept,
            from: avgBuy,
            to: close,
            delta: boughtKept * (close - avgBuy),
            pct: null,
          })
        }
      }
    }

    // ------------------------------------------------------- nakit gelirler
    const nema = nemaByDay.get(day) ?? 0
    if (nema !== 0) {
      push({
        key: 'nema',
        symbol: 'Nema',
        kind: 'mevduat',
        source: 'nema',
        part: 'gelir',
        account: null,
        qty: 0,
        from: null,
        to: null,
        delta: nema,
        pct: null,
      })
    }
    let dividend = 0
    for (const d of divByDay.get(day) ?? []) {
      const net = Number(d.gross_amount ?? 0) - Number(d.tax_amount ?? 0)
      if (!Number.isFinite(net) || net === 0) continue
      dividend += net
      const asset = d.asset_id ? assetById.get(d.asset_id) : null
      push({
        key: `div:${d.asset_id ?? 'x'}`,
        symbol: asset?.symbol.toUpperCase() ?? 'Temettü',
        kind: asset?.kind ?? 'hisse',
        source: 'temettu',
        part: 'gelir',
        account: null,
        qty: 0,
        from: null,
        to: null,
        delta: net,
        pct: null,
      })
    }

    // ------------------------------------------------------------- toplamlar
    let priceDelta = 0
    let ipoDelta = 0
    for (const it of items) {
      if (it.source === 'portfoy') priceDelta += it.delta
      else if (it.source === 'ipo') ipoDelta += it.delta
    }
    const total = priceDelta + ipoDelta + nema + dividend

    // O günün sonunda elde ne vardı
    const holdings: DailyHolding[] = []
    let value = 0
    for (const assetId of new Set<string>([...qty.keys(), ...snapQty.keys()])) {
      if (ipoAssets.has(assetId)) continue
      const fromSnap = !tradedIds.has(assetId)
      const q = fromSnap ? (snapQty.get(assetId) ?? 0) : (qty.get(assetId) ?? 0)
      if (q <= EPS) continue
      const asset = assetById.get(assetId)
      const symbol = asset?.symbol.trim().toUpperCase() ?? '—'
      const p = priceAsOf(assetId, day)
      const v = p ? q * p.price : null
      value += v ?? 0
      holdings.push({
        symbol,
        kind: asset?.kind ?? 'diger',
        source: 'portfoy',
        qty: q,
        price: p?.price ?? null,
        priceDate: p?.date ?? null,
        value: v,
        delta: deltaBySymbol.get(`portfoy:${symbol}`) ?? 0,
      })
    }
    for (const hold of ipoHold) {
      const p = priceAsOf(hold.pos.assetId, day)
      const unit = hold.pos.manualPrice ?? p?.price ?? hold.pos.lotPrice
      const v = unit > 0 ? hold.qty * unit : null
      value += v ?? 0
      holdings.push({
        symbol: hold.pos.code,
        kind: 'hisse',
        source: 'ipo',
        qty: hold.qty,
        price: unit > 0 ? unit : null,
        priceDate: hold.pos.manualPrice != null ? null : (p?.date ?? null),
        value: v,
        delta: deltaBySymbol.get(`ipo:${hold.pos.code}`) ?? 0,
      })
    }
    holdings.sort((a, b) => (b.value ?? 0) - (a.value ?? 0))

    // Ölçülebilir hiçbir şeyin olmadığı gün (hafta sonu aynı fiyatın tekrar
    // yazılması, borsa kapalıyken girilmiş işlem) grafiğe boş çubuk koymasın
    const measurable = items.some((i) => Math.abs(i.delta) >= MIN_ITEM)
    if (Math.abs(total) < MIN_ITEM && !measurable) continue

    rows.push({
      date: day,
      total,
      priceDelta,
      ipoDelta,
      nema,
      dividend,
      // Kuruşun altındaki hareketler listeyi şişirmesin — toplamlar tam
      items: items
        .filter((i) => Math.abs(i.delta) >= MIN_ITEM)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)),
      holdings,
      value,
      base,
      pct: base > 0 ? (total / base) * 100 : null,
      unmeasured,
      hasPrices,
      ipoLots,
    })
  }

  return rows
}

/** Bir günün kalemlerini sembol bazında toplar — "en çok oynayan" listesi */
export interface DailyMover {
  symbol: string
  source: DailySource
  delta: number
  pct: number | null
  /** Referans halka arz fiyatı — ilk işlem günü */
  vsIpoPrice: boolean
}

export function moversOf(row: DailyRow | null | undefined): DailyMover[] {
  if (!row) return []
  const map = new Map<
    string,
    { delta: number; base: number; vsIpo: boolean; source: DailySource; symbol: string }
  >()
  for (const it of row.items) {
    const key = `${it.source}:${it.symbol}`
    const cur = map.get(key) ?? {
      delta: 0,
      base: 0,
      vsIpo: false,
      source: it.source,
      symbol: it.symbol,
    }
    cur.delta += it.delta
    cur.base += it.from != null ? Math.abs(it.from * it.qty) : 0
    cur.vsIpo = cur.vsIpo || !!it.vsIpoPrice
    map.set(key, cur)
  }
  return [...map.values()]
    .map((m) => ({
      symbol: m.symbol,
      source: m.source,
      delta: m.delta,
      pct: m.base > 0 ? (m.delta / m.base) * 100 : null,
      vsIpoPrice: m.vsIpo,
    }))
    .filter((m) => Math.abs(m.delta) >= MIN_ITEM)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}
