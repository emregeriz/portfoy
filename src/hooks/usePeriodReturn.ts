import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { todayISO } from '../lib/calc'
import { addDay } from '../lib/nema'
import type { CorporateAction } from '../lib/holdings'

export type ReturnPeriod = 'hafta' | 'ay' | 'uc_ay' | 'yil'

export const PERIOD_LABEL: Record<ReturnPeriod, string> = {
  hafta: 'Hafta',
  ay: 'Ay',
  uc_ay: '3 Ay',
  yil: 'Yıl',
}

/** Kaç gün geriye bakılacak */
const PERIOD_DAYS: Record<ReturnPeriod, number> = {
  hafta: 7,
  ay: 30,
  uc_ay: 90,
  yil: 365,
}

export const PERIODS: ReturnPeriod[] = ['hafta', 'ay', 'uc_ay', 'yil']

export interface PeriodResult {
  period: ReturnPeriod
  /** Ölçümün başladığı gün */
  from: string
  /** Fon + hisse fiyat hareketi */
  priceDelta: number
  /** Dönem içinde işleyen nema */
  nema: number
  /** Dönem içinde tahsil edilen net temettü */
  dividend: number
  /** Üçünün toplamı */
  total: number
  /** Dönem başındaki portföy değeri — yüzde bunun üzerinden */
  base: number
  /** Nominal getiri yüzdesi */
  pct: number | null
  /**
   * Dolar bazında getiri. TL kazancı enflasyon/kur karşısında eridiyse
   * burası eksi çıkar — nominal kârın ne kadarının gerçek olduğunu söyler.
   */
  realPct: number | null
  /** Dönem içinde USD/TRY ne kadar arttı */
  fxPct: number | null
  /** Fiyat geçmişi yetmediği için ölçülemeyen sembol sayısı */
  unmeasured: number
}

export interface PeriodReturnData {
  results: Record<ReturnPeriod, PeriodResult> | null
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

interface PriceRow {
  asset_id: string
  date: string
  price: number
}

/**
 * Haftalık / aylık / 3 aylık / yıllık kâr.
 *
 * Yöntem "bugünün getirisi" ile aynı, yalnızca başlangıç günü geriye
 * çekilmiş: bir dönemin kârı, dönem sonu değerine dönem içindeki satış
 * gelirleri eklenip, dönem başı değeri ile dönem içindeki alım maliyetleri
 * çıkarılarak bulunur. Böylece araya para koymak kâr gibi görünmez.
 *
 *   kâr = (bugünkü değer + dönem içi satışlar)
 *       − (dönem başı değer + dönem içi alımlar)
 *
 * Üzerine o dönemde işleyen nema ve tahsil edilen net temettü eklenir.
 * Halka arz pozisyonları bu hesaba girmez — onların değeri Halka Arz
 * sayfasında ayrı izleniyor.
 */
export function usePeriodReturn(userId?: string | null): PeriodReturnData {
  const [results, setResults] = useState<Record<ReturnPeriod, PeriodResult> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    const today = todayISO()
    // En uzun dönem + fiyat boşlukları için pay
    const earliest = addDay(today, -(PERIOD_DAYS.yil + 30))

    try {
      const [tradeRes, actionRes, nemaRes, divRes, fxRes] = await Promise.all([
        supabase
          .from('trades')
          .select('asset_id, side, quantity, amount_try, trade_date, assets(symbol)')
          .eq('user_id', userId)
          .order('trade_date', { ascending: true }),
        supabase
          .from('corporate_actions')
          .select('asset_id, action_date, ratio')
          .eq('user_id', userId),
        supabase
          .from('account_ledger')
          .select('amount, date')
          .eq('user_id', userId)
          .eq('kind', 'nema')
          .gte('date', earliest),
        supabase
          .from('dividends')
          .select('pay_date, gross_amount, tax_amount')
          .eq('user_id', userId)
          .gte('pay_date', earliest),
        supabase
          .from('fx_rates')
          .select('date, rate_try')
          .eq('currency', 'USD')
          .gte('date', earliest)
          .order('date', { ascending: true }),
      ])

      const trades = (tradeRes.data ?? []) as {
        asset_id: string | null
        side: string
        quantity: number
        amount_try: number | null
        trade_date: string
      }[]

      const actions = ((actionRes.data ?? []) as CorporateAction[])
        .slice()
        .sort((a, b) => a.action_date.localeCompare(b.action_date))

      const assetIds = [...new Set(trades.map((t) => t.asset_id).filter(Boolean))] as string[]
      const priceRows: PriceRow[] = []
      if (assetIds.length) {
        const { data } = await supabase
          .from('asset_prices')
          .select('asset_id, date, price')
          .in('asset_id', assetIds)
          .gte('date', earliest)
          .order('date', { ascending: true })
        priceRows.push(...((data ?? []) as PriceRow[]))
      }

      const byAsset = new Map<string, PriceRow[]>()
      for (const p of priceRows) {
        const l = byAsset.get(p.asset_id)
        if (l) l.push(p)
        else byAsset.set(p.asset_id, [p])
      }
      /** Verilen güne kadarki (dahil) son fiyat */
      const priceAt = (assetId: string, date: string): number | null => {
        const rows = byAsset.get(assetId)
        if (!rows?.length) return null
        let hit: number | null = null
        for (const r of rows) {
          if (r.date > date) break
          hit = Number(r.price)
        }
        return hit
      }

      /** Verilen güne kadar elde kalan adet — bedelsiz/bölünme uygulanmış */
      const qtyAt = (assetId: string, date: string): number => {
        let q = 0
        const own = actions.filter((a) => a.asset_id === assetId && a.action_date <= date)
        let ai = 0
        for (const t of trades) {
          if (t.asset_id !== assetId || t.trade_date > date) continue
          while (ai < own.length && own[ai].action_date <= t.trade_date) {
            if (q > 1e-9) q *= Number(own[ai].ratio)
            ai++
          }
          const n = Number(t.quantity)
          if (!Number.isFinite(n)) continue
          q += t.side === 'alis' ? n : -n
        }
        while (ai < own.length) {
          if (q > 1e-9) q *= Number(own[ai].ratio)
          ai++
        }
        return Math.max(q, 0)
      }

      const fx = (fxRes.data ?? []) as { date: string; rate_try: number }[]
      const fxAt = (date: string): number | null => {
        let hit: number | null = null
        for (const r of fx) {
          if (r.date > date) break
          hit = Number(r.rate_try)
        }
        return hit
      }

      const nemaRows = (nemaRes.data ?? []) as { amount: number; date: string }[]
      const divRows = (divRes.data ?? []) as {
        pay_date: string
        gross_amount: number
        tax_amount: number
      }[]

      const out = {} as Record<ReturnPeriod, PeriodResult>
      for (const period of PERIODS) {
        const from = addDay(today, -PERIOD_DAYS[period])
        let base = 0
        let now = 0
        let bought = 0
        let sold = 0
        let unmeasured = 0

        // Ölçülebilen kalemler — akışları da yalnızca bunlardan sayılır
        const measured = new Set<string>()

        for (const assetId of assetIds) {
          const qNow = qtyAt(assetId, today)
          const qThen = qtyAt(assetId, from)
          if (qNow <= 1e-9 && qThen <= 1e-9) continue

          const pNow = priceAt(assetId, today)
          const pThen = priceAt(assetId, from)
          // Dönem başı fiyatı yoksa bu kalem ölçülemez; sıfır sayıp
          // kârı şişirmektense dışarıda bırakılır
          if (pNow == null || (qThen > 1e-9 && pThen == null)) {
            unmeasured++
            continue
          }
          measured.add(assetId)
          now += qNow * pNow
          base += qThen * (pThen ?? 0)
        }

        // Değerlemeye girmeyen kâğıdın alımını maliyete yazmak kârı
        // olduğundan düşük gösterirdi — akış da kalem de aynı kümeden
        for (const t of trades) {
          if (!t.asset_id || !measured.has(t.asset_id)) continue
          if (t.trade_date <= from || t.trade_date > today) continue
          const amt = Number(t.amount_try ?? 0)
          if (!Number.isFinite(amt)) continue
          if (t.side === 'alis') bought += amt
          else sold += amt
        }

        const nema = nemaRows
          .filter((r) => r.date > from && r.date <= today)
          .reduce((s, r) => s + Number(r.amount), 0)
        const dividend = divRows
          .filter((r) => r.pay_date > from && r.pay_date <= today)
          .reduce((s, r) => s + Number(r.gross_amount) - Number(r.tax_amount), 0)

        const priceDelta = now + sold - (base + bought)
        const total = priceDelta + nema + dividend
        const pct = base > 0 ? (total / base) * 100 : null

        const fxNow = fxAt(today)
        const fxThen = fxAt(from)
        const fxPct = fxNow && fxThen && fxThen > 0 ? (fxNow / fxThen - 1) * 100 : null
        // Dolar bazında getiri: TL kazancı kur artışıyla oranlanır
        const realPct =
          pct != null && fxPct != null ? ((1 + pct / 100) / (1 + fxPct / 100) - 1) * 100 : null

        out[period] = {
          period, from, priceDelta, nema, dividend, total, base, pct, realPct, fxPct, unmeasured,
        }
      }

      setResults(out)
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

  return { results, loading, error, reload: load }
}
