import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { todayISO } from '../lib/calc'
import { runNemaAccrual } from '../lib/cash'
import { addDay } from '../lib/nema'

export type MoverSource = 'portfoy' | 'ipo'

export interface TodayMover {
  symbol: string
  delta: number
  /** Birim fiyattaki yüzde değişim */
  pct: number | null
  source: MoverSource
  /** Değişimin ölçüldüğü fiyat günü */
  date: string
  /** İlk işlem günü — karşılaştırma halka arz fiyatına göre yapıldı */
  firstDay?: boolean
}

export interface TodayReturnData {
  /** Fon/hisse + halka arz + nema */
  total: number
  /** Fon ve hisse pozisyonlarının günlük değişimi */
  priceDelta: number
  /** Elde tutulan halka arz hisselerinin günlük değişimi */
  ipoDelta: number
  nema: number
  /** Elde tutulan halka arz lotu — kırılımda satırın görünüp görünmeyeceğini belirler */
  ipoLots: number
  /** Fiyatların ait olduğu en taze gün — hafta sonu bugünden eski olabilir */
  priceDate: string | null
  movers: TodayMover[]
  /** Önceki gün fiyatı bulunamadığı için ölçülemeyen kalem sayısı */
  unmeasured: number
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

/** Fiyat geçmişinde bu kadar geriye bakılır — ara günlerde fiyat gelmemiş olabilir. */
const LOOKBACK_DAYS = 45

/**
 * En taze fiyat gününden bu kadar geride kalan sembol sayılmaz. Hafta sonu
 * ve tatilleri tolere eder, ama fiyatı tamamen durmuş bir sembolün eski
 * hareketini her gün tekrar tekrar getiriye yazmasını engeller.
 */
const STALE_DAYS = 7

interface PriceRow {
  asset_id: string
  date: string
  price: number
}

/** Getiriye giren tek bir kalem: hangi varlıktan kaç adet, nereden geldi */
interface Position {
  assetId: string
  qty: number
  source: MoverSource
  /**
   * Önceki kapanış yoksa kullanılacak referans fiyat. Halka arzın ilk
   * işlem gününde borsada "dünkü kapanış" yoktur; para halka arz fiyatında
   * bağlıydı, o yüzden günün kazancı arz fiyatına göre ölçülür.
   */
  refPrice?: number | null
}

const empty = {
  total: 0,
  priceDelta: 0,
  ipoDelta: 0,
  nema: 0,
  ipoLots: 0,
  priceDate: null as string | null,
  movers: [] as TodayMover[],
  unmeasured: 0,
}

/**
 * "Bugün ne kazandım / kaybettim" — üst çubuktaki rozetin verisi.
 *
 * Üç kalemden oluşur:
 *   1. Fon ve hisse pozisyonları — adet × (son fiyat − bir önceki fiyat).
 *      Adetler alım/satım defterinden ve son snapshot'tan gelir; ikisinde
 *      birden geçen varlık, Dashboard'daki gibi bir kez sayılır.
 *   2. Elde tutulan halka arz hisseleri — düşen lot × fiyat farkı.
 *      Fiyatı elle girilen arzlar (manual_price) günlük değişim üretmez.
 *   3. O gün hesaplara işleyen nema geliri.
 *
 * Fiyatın yayınlanmadığı günlerde sembolün **son iki fiyat günü**
 * karşılaştırılır; borsa kapalıyken de son hareket görünür. Önceki fiyatı
 * hiç olmayan semboller `unmeasured` ile ayrıca raporlanır — sessizce
 * sıfır sayılmasınlar diye.
 */
export function useTodayReturn(userId?: string | null): TodayReturnData {
  const [state, setState] = useState(empty)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    const today = todayISO()
    try {
      // Nema satırları bugüne kadar tamamlanmadan toplamak eksik gösterir
      await runNemaAccrual(userId, today).catch(() => 0)

      const [nemaRes, tradeRes, snapRes, ipoRes, entryRes] = await Promise.all([
        supabase
          .from('account_ledger')
          .select('amount')
          .eq('user_id', userId)
          .eq('kind', 'nema')
          .eq('date', today),
        supabase.from('trades').select('asset_id, side, quantity').eq('user_id', userId),
        supabase
          .from('snapshots')
          .select('id')
          .eq('user_id', userId)
          .order('snapshot_date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('ipos')
          .select('id, bist_code, manual_price, lot_price')
          .eq('user_id', userId)
          .in('status', ['dagitildi', 'islemde']),
        supabase
          .from('ipo_entries')
          .select('ipo_id, allocated_lot, sold_lot, participated')
          .eq('user_id', userId),
      ])

      const nema = (nemaRes.data ?? []).reduce(
        (s: number, r: { amount: number }) => s + Number(r.amount),
        0
      )

      // ---------------------------------------------- fon / hisse adetleri
      const portfolio = new Map<string, number>()
      for (const t of (tradeRes.data ?? []) as {
        asset_id: string | null
        side: string
        quantity: number
      }[]) {
        if (!t.asset_id) continue
        const q = Number(t.quantity)
        if (!Number.isFinite(q)) continue
        portfolio.set(t.asset_id, (portfolio.get(t.asset_id) ?? 0) + (t.side === 'alis' ? q : -q))
      }

      if (snapRes.data?.id) {
        const { data: positions } = await supabase
          .from('positions')
          .select('asset_id, quantity')
          .eq('snapshot_id', snapRes.data.id)
        for (const p of (positions ?? []) as { asset_id: string | null; quantity: number | null }[]) {
          // Alım/satım defterinde geçen varlık orada sayıldı, tekrar eklenmez
          if (!p.asset_id || portfolio.has(p.asset_id)) continue
          const q = Number(p.quantity ?? 0)
          if (q > 0) portfolio.set(p.asset_id, q)
        }
      }

      // ------------------------------------------- halka arz hisse adetleri
      const lotByIpo = new Map<string, number>()
      for (const e of (entryRes.data ?? []) as {
        ipo_id: string
        allocated_lot: number
        sold_lot: number | null
        participated: boolean
      }[]) {
        if (!e.participated) continue
        // Satılan lot artık elinde değil; günlük değişimi onu etkilemez
        const lot = Number(e.allocated_lot) - Number(e.sold_lot ?? 0)
        if (lot > 0) lotByIpo.set(e.ipo_id, (lotByIpo.get(e.ipo_id) ?? 0) + lot)
      }

      // BIST kodu → toplam lot + halka arz fiyatı (ilk gün referansı)
      const ipoCodes = new Map<string, { lot: number; refPrice: number | null }>()
      for (const i of (ipoRes.data ?? []) as {
        id: string
        bist_code: string | null
        manual_price: number | null
        lot_price: number | null
      }[]) {
        const lot = lotByIpo.get(i.id) ?? 0
        const code = i.bist_code?.trim().toUpperCase()
        // Fiyatı elle girilen arzın günlük değişimi ölçülemez
        if (!code || lot <= 0 || i.manual_price != null) continue
        const cur = ipoCodes.get(code)
        ipoCodes.set(code, {
          lot: (cur?.lot ?? 0) + lot,
          refPrice: cur?.refPrice ?? (i.lot_price != null ? Number(i.lot_price) : null),
        })
      }

      // Arz kodları sembolden varlığa bağlanır (Halka Arz sayfası kodu
      // kaydederken assets satırını da açıyor — fiyat otomasyonu bunu kullanır)
      const ipoPositions: Position[] = []
      if (ipoCodes.size) {
        const { data: ipoAssets } = await supabase
          .from('assets')
          .select('id, symbol')
          .in('symbol', [...ipoCodes.keys()])
        for (const a of (ipoAssets ?? []) as { id: string; symbol: string }[]) {
          const hit = ipoCodes.get(a.symbol.toUpperCase())
          if (hit) {
            ipoPositions.push({ assetId: a.id, qty: hit.lot, source: 'ipo', refPrice: hit.refPrice })
          }
        }
      }

      const ipoLots = ipoPositions.reduce((sum, p) => sum + p.qty, 0)

      const items: Position[] = [
        ...[...portfolio.entries()]
          .filter(([, q]) => q > 1e-9)
          .map(([assetId, qty]) => ({ assetId, qty, source: 'portfoy' as const })),
        ...ipoPositions,
      ]

      if (!items.length) {
        setState({ ...empty, total: nema, nema })
        setError(null)
        return
      }

      // ------------------------------------------------------- fiyat farkı
      const ids = [...new Set(items.map((i) => i.assetId))]
      const [priceRes, assetRes] = await Promise.all([
        supabase
          .from('asset_prices')
          .select('asset_id, date, price')
          .in('asset_id', ids)
          .gte('date', addDay(today, -LOOKBACK_DAYS))
          .order('date', { ascending: true }),
        supabase.from('assets').select('id, symbol').in('id', ids),
      ])

      const symbolOf = new Map<string, string>()
      for (const a of (assetRes.data ?? []) as { id: string; symbol: string }[]) {
        symbolOf.set(a.id, a.symbol.toUpperCase())
      }

      const byAsset = new Map<string, PriceRow[]>()
      for (const p of (priceRes.data ?? []) as PriceRow[]) {
        const list = byAsset.get(p.asset_id)
        if (list) list.push(p)
        else byAsset.set(p.asset_id, [p])
      }

      // Bayatlık ölçüsü sabit bir tarih değil, elimizdeki en taze fiyat günü
      let newest: string | null = null
      for (const rows of byAsset.values()) {
        const d = rows[rows.length - 1]?.date
        if (d && (!newest || d > newest)) newest = d
      }
      const oldestAllowed = newest ? addDay(newest, -STALE_DAYS) : today

      let priceDelta = 0
      let ipoDelta = 0
      let priceDate: string | null = null
      let unmeasured = 0
      const movers: TodayMover[] = []

      for (const item of items) {
        const rows = byAsset.get(item.assetId) ?? []
        const latest = rows[rows.length - 1]
        const prev = rows[rows.length - 2]
        // Fiyat yoksa ya da bayatsa bugüne yazılmaz
        if (!latest || latest.date < oldestAllowed) {
          unmeasured++
          continue
        }
        // Önceki kapanış yoksa halka arz fiyatına düşülür: arzın ilk işlem
        // gününde kazancın tamamı o gün oluşur, para o zamana dek arz
        // fiyatında bağlıydı. Fon/hisse tarafında böyle bir referans yok.
        const firstDay = !prev
        const prevPrice = prev ? Number(prev.price) : (item.refPrice ?? null)
        if (prevPrice == null || !(prevPrice > 0)) {
          unmeasured++
          continue
        }
        const diff = Number(latest.price) - prevPrice
        const delta = diff * item.qty
        if (!Number.isFinite(delta)) {
          unmeasured++
          continue
        }
        if (item.source === 'ipo') ipoDelta += delta
        else priceDelta += delta
        if (!priceDate || latest.date > priceDate) priceDate = latest.date
        if (delta !== 0) {
          movers.push({
            symbol: symbolOf.get(item.assetId) ?? '—',
            delta,
            pct: (diff / prevPrice) * 100,
            source: item.source,
            date: latest.date,
            firstDay,
          })
        }
      }

      movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      setState({
        total: priceDelta + ipoDelta + nema,
        priceDelta,
        ipoDelta,
        nema,
        ipoLots,
        priceDate,
        movers: movers.slice(0, 8),
        unmeasured,
      })
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => {
    void load()
  }, [load])

  return { ...state, loading, error, reload: load }
}
