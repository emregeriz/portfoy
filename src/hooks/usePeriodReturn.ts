import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { todayISO } from '../lib/calc'
import { addDay } from '../lib/nema'
import { summarizeDailyRows, type PeriodSummary } from '../lib/dailyReturn'
import { useDailyReturns } from './useDailyReturns'

export type ReturnPeriod = 'hafta' | 'ay' | 'uc_ay' | 'yil'

/** Seçici çipindeki kısa ad — rozetin üstünde de bu yazar */
export const PERIOD_LABEL: Record<ReturnPeriod, string> = {
  hafta: 'Son 7 gün',
  ay: 'Son 30 gün',
  uc_ay: '3 Ay',
  yil: 'Yıl',
}

/** Açılır pencerenin başlığı */
export const PERIOD_TITLE: Record<ReturnPeriod, string> = {
  hafta: 'Son 7 günün getirisi',
  ay: 'Son 30 günün getirisi',
  uc_ay: 'Son 3 ayın getirisi',
  yil: 'Son 1 yılın getirisi',
}

/** Kaç takvim günü geriye bakılır — bugün dahil, takvim haftası/ayı değil */
export const PERIOD_DAYS: Record<ReturnPeriod, number> = {
  hafta: 7,
  ay: 30,
  uc_ay: 90,
  yil: 365,
}

export const PERIODS: ReturnPeriod[] = ['hafta', 'ay', 'uc_ay', 'yil']

/** Kur serisinde pencere başından önceki son değeri bulmak için pay */
const FX_PAD = 14

export interface PeriodResult extends PeriodSummary {
  period: ReturnPeriod
  /** Sayılan ilk gün (dahil) */
  from: string
  /** Sayılan son gün — bugün */
  to: string
  /** Penceredeki takvim günü sayısı */
  windowDays: number
  /**
   * Dolar bazında getiri. TL kazancı kur artışının gerisinde kaldıysa
   * burası eksi çıkar — nominal kârın ne kadarının gerçek olduğunu söyler.
   */
  realPct: number | null
  /** Dönem içinde USD/TRY ne kadar arttı */
  fxPct: number | null
}

export interface PeriodReturnData {
  results: Record<ReturnPeriod, PeriodResult> | null
  loading: boolean
  error: string | null
  /** Elimizdeki en taze fiyat günü */
  priceDate: string | null
  reload: () => Promise<void>
}

interface FxRow {
  date: string
  rate_try: number
}

/**
 * Son 7 gün / 30 gün / 3 ay / 1 yıl kârı.
 *
 * Ayrı bir değerleme yapılmaz: günlük kâr motorunun (lib/dailyReturn) her
 * gün için ürettiği satırlar pencereye göre toplanır. Böylece "son 7 gün"
 * tam olarak Günlük Kâr sayfasındaki son yedi günün toplamıdır — rozet ile
 * sayfa hiçbir zaman farklı sayı göstermez ve halka arz, snapshot'tan
 * bilinen pozisyon, gün içi al-sat gibi motorun bildiği her şey burada da
 * doğru sayılır.
 *
 * Pencere takvime bağlı değildir: "ay" bu ayın başı değil, bugün dahil
 * geriye 30 gündür. Yüzde, penceredeki ilk hareketli günün gün başı
 * pozisyon değeri üzerinden verilir.
 */
export function usePeriodReturn(userId?: string | null): PeriodReturnData {
  const daily = useDailyReturns(userId, PERIOD_DAYS.yil)
  const [fx, setFx] = useState<FxRow[]>([])
  const today = todayISO()

  // Kur serisi motorun girdisi değil; dolar bazlı satır için ayrı çekilir
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      const { data } = await supabase
        .from('fx_rates')
        .select('date, rate_try')
        .eq('currency', 'USD')
        .gte('date', addDay(today, -(PERIOD_DAYS.yil + FX_PAD)))
        .lte('date', today)
        .order('date', { ascending: true })
      if (!cancelled) setFx((data ?? []) as FxRow[])
    })()
    return () => {
      cancelled = true
    }
  }, [userId, today])

  const results = useMemo(() => {
    if (!userId) return null

    /** Verilen güne kadarki (dahil) son kur */
    const fxAt = (date: string): number | null => {
      let hit: number | null = null
      for (const r of fx) {
        if (r.date > date) break
        hit = Number(r.rate_try)
      }
      return hit
    }

    const out = {} as Record<ReturnPeriod, PeriodResult>
    for (const period of PERIODS) {
      const windowDays = PERIOD_DAYS[period]
      const from = addDay(today, -(windowDays - 1))
      const sum = summarizeDailyRows(daily.rows.filter((r) => r.date >= from && r.date <= today))

      // Pencerenin ilk günü, bir önceki günün kapanışından ölçülür; kur da öyle
      const fxNow = fxAt(today)
      const fxThen = fxAt(addDay(from, -1))
      const fxPct = fxNow && fxThen && fxThen > 0 ? (fxNow / fxThen - 1) * 100 : null
      const realPct =
        sum.pct != null && fxPct != null
          ? ((1 + sum.pct / 100) / (1 + fxPct / 100) - 1) * 100
          : null

      out[period] = { ...sum, period, from, to: today, windowDays, realPct, fxPct }
    }
    return out
  }, [userId, daily.rows, fx, today])

  return {
    results,
    loading: daily.loading,
    error: daily.error,
    priceDate: daily.priceDate,
    reload: daily.reload,
  }
}
