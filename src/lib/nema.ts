/**
 * Nemalandırma matematiği — nakit bakiyeye işleyen günlük faiz.
 *
 * Bu dosya veritabanına dokunmaz; hesabı yapar, satırları `cash.ts` yazar.
 */
import { todayISO } from './calc'
import type { LedgerKind } from '../types/db'

/**
 * Midas'ın nakit nemalandırma oranı — yıllık brüt yüzde.
 * Hesap bazlı `accounts.nema_rate` boşsa arayüzde bu değer önerilir.
 */
export const DEFAULT_NEMA_RATE = 34.5

/** Faizin bölündüğü gün sayısı — bankalar 365 gün üzerinden işletir. */
export const YEAR_DAYS = 365

/** Oranı ekranda yazar: 34.5 → "34,5" (gereksiz sıfır yazmaz) */
export function formatRate(pct: number | null | undefined): string {
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(Number(pct ?? 0))
}

/** ISO tarihe gün ekler / çıkarır: addDay('2026-08-20', -1) → '2026-08-19' */
export function addDay(iso: string, n = 1): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** İki ISO tarih arasındaki gün farkı */
export function daysBetween(from: string, to: string): number {
  const ms = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((ms(to) - ms(from)) / 86_400_000)
}

/** Yıllık yüzdeyi günlük orana çevirir: %34,5 → 0,000945… */
export function dailyRate(annualPct: number | null | undefined): number {
  const v = Number(annualPct ?? 0)
  return Number.isFinite(v) && v > 0 ? v / 100 / YEAR_DAYS : 0
}

/** Bakiye bugünkü oranla n gün beklerse ne kazandırır (bileşik) */
export function projectNema(balance: number, annualPct: number, days: number): number {
  const r = dailyRate(annualPct)
  if (r <= 0 || balance <= 0) return 0
  return balance * (Math.pow(1 + r, days) - 1)
}

const round2 = (n: number) => Math.round(n * 100) / 100

export interface NemaDay {
  date: string
  /** O gün işleyen faiz */
  amount: number
  /** Faizin işlediği bakiye */
  base: number
}

export interface CashMove {
  date: string
  amount: number
  kind: LedgerKind | string
}

/** Tek seferde en fazla bu kadar günlük faiz üretilir — sonsuz döngü frenidir. */
const MAX_DAYS = 1500

/**
 * Bir hesabın defterinden eksik kalan günlük nema satırlarını çıkarır.
 *
 * Faiz her gün, **o günün kapanış bakiyesi** üzerinden işler ve bakiyeye
 * eklenir; ertesi gün üzerine faiz yürüdüğü için bileşiktir. Aynı gün
 * yatan para o gün de kazanır — banka uygulamasıyla küçük bir gün farkı
 * doğurabilir, ama tutar mertebesi aynıdır.
 *
 * Son nema satırının ertesi gününden bugüne kadar üretir; daha önce
 * işlenmiş günlere ikinci kez dokunmaz. Bakiye sıfır ya da eksiyse o gün
 * faiz yazılmaz.
 */
export function planNema(opts: {
  moves: CashMove[]
  annualPct: number
  today?: string
  /** Nemalandırmanın başladığı gün; yoksa ilk para hareketi */
  startFrom?: string | null
}): NemaDay[] {
  const today = opts.today ?? todayISO()
  const rate = dailyRate(opts.annualPct)
  if (rate <= 0 || !opts.moves.length) return []

  const sorted = [...opts.moves].sort((a, b) => a.date.localeCompare(b.date))
  const lastNema = [...sorted].reverse().find((m) => m.kind === 'nema')?.date ?? null
  const firstMove = sorted[0].date
  const startFrom = opts.startFrom || null
  const begin = lastNema
    ? addDay(lastNema)
    : startFrom && startFrom > firstMove
      ? startFrom
      : firstMove
  if (begin > today) return []

  // Başlangıç gününden önceki bakiye tek seferde toplanır
  let balance = sorted
    .filter((m) => m.date < begin)
    .reduce((s, m) => s + Number(m.amount), 0)

  const byDate = new Map<string, number>()
  for (const m of sorted) {
    if (m.date < begin) continue
    byDate.set(m.date, (byDate.get(m.date) ?? 0) + Number(m.amount))
  }

  const out: NemaDay[] = []
  let cursor = begin
  for (let i = 0; i < MAX_DAYS && cursor <= today; i++) {
    balance += byDate.get(cursor) ?? 0
    if (balance > 0) {
      const amount = round2(balance * rate)
      if (amount > 0) {
        out.push({ date: cursor, amount, base: round2(balance) })
        balance += amount
      }
    }
    cursor = addDay(cursor)
  }
  return out
}
