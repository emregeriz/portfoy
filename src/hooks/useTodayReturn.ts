import { useMemo } from 'react'
import { useDailyReturns } from './useDailyReturns'
import { moversOf, type DailyItem, type DailyMover, type DailyRow } from '../lib/dailyReturn'

/**
 * "Bugün ne kazandım / kaybettim" — üst çubuktaki rozetin verisi.
 *
 * Hesabın tamamı `lib/dailyReturn` motorunda; burada yalnızca bugünün
 * satırı seçilip rozetin beklediği biçime çevrilir. Günlük Kâr sayfası da
 * aynı motordan beslendiği için iki ekran hiçbir zaman farklı sayı
 * göstermez.
 *
 * Kalemler:
 *   • Fon / hisse — elde tutulan pay fiyat farkından, o gün satılan pay
 *     gerçekleşen satış fiyatından, o gün alınan pay kendi maliyetinden.
 *   • Halka arz — elde tutulan lot fiyat farkından; o gün satılan lot ise
 *     hesap hesap kendi satış fiyatından (her hesap farklı fiyattan
 *     satılmış olabilir, arzın gün sonu fiyatı onları bağlamaz).
 *   • O gün hesaplara işleyen nema ve tahsil edilen net temettü.
 */

/** Rozet için kaç günlük defter kurulacak — "son fiyat günü" de buradan bulunur */
const WINDOW_DAYS = 21

export interface TodayReturnData {
  /** Fon/hisse + halka arz + nema + temettü */
  total: number
  /** Fon ve hisse pozisyonlarının günlük değişimi */
  priceDelta: number
  /** Halka arz hisselerinin günlük değişimi — satılanlar dahil */
  ipoDelta: number
  nema: number
  dividend: number
  /** Elde tutulan halka arz lotu */
  ipoLots: number
  /** Fiyatların ait olduğu en taze gün — hafta sonu bugünden eski olabilir */
  priceDate: string | null
  /** Sembol bazında toplanmış hareket listesi */
  movers: DailyMover[]
  /** Kalem kalem döküm — satış/alış/tutma ayrımıyla */
  items: DailyItem[]
  /** Bugün için fiyat yayınlandı mı */
  hasPricesToday: boolean
  /**
   * Bugün henüz fiyat gelmediyse (hafta sonu, tatil ya da güncelleme saati
   * gelmediyse) son fiyat gününün satırı — rozet "en son ne olmuştu"yu
   * gösterebilsin diye.
   */
  lastPriceDay: DailyRow | null
  /** Önceki gün fiyatı bulunamadığı için ölçülemeyen kalem sayısı */
  unmeasured: number
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

export function useTodayReturn(userId?: string | null): TodayReturnData {
  const { rows, today, priceDate, loading, error, reload } = useDailyReturns(userId, WINDOW_DAYS)

  const movers = useMemo(() => moversOf(today), [today])
  const lastPriceDay = useMemo(() => {
    if (today?.hasPrices) return null
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].hasPrices) return rows[i]
    return null
  }, [rows, today])

  return {
    total: today?.total ?? 0,
    priceDelta: today?.priceDelta ?? 0,
    ipoDelta: today?.ipoDelta ?? 0,
    nema: today?.nema ?? 0,
    dividend: today?.dividend ?? 0,
    ipoLots: today?.ipoLots ?? 0,
    priceDate,
    movers,
    items: today?.items ?? [],
    hasPricesToday: today?.hasPrices ?? false,
    lastPriceDay,
    unmeasured: today?.unmeasured ?? 0,
    loading,
    error,
    reload,
  }
}
