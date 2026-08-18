import type { Currency } from '../types/db'

export const CURRENCIES: Currency[] = ['TRY', 'USD', 'EUR', 'XAU', 'GBP']

const tryFmt = new Intl.NumberFormat('tr-TR', {
  style: 'currency',
  currency: 'TRY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const compactFmt = new Intl.NumberFormat('tr-TR', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

const numFmt = new Intl.NumberFormat('tr-TR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** ₺1.234.567,89 */
export function formatTRY(value: number | null | undefined): string {
  return tryFmt.format(Number(value ?? 0))
}

/** ₺1,2 Mn — grafik eksenleri için */
export function formatCompactTRY(value: number | null | undefined): string {
  return '₺' + compactFmt.format(Number(value ?? 0))
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  if (digits !== 2) {
    return new Intl.NumberFormat('tr-TR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(Number(value))
  }
  return numFmt.format(Number(value))
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—'
  const v = Number(value)
  const sign = v > 0 ? '+' : ''
  return `${sign}${new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 }).format(v)}%`
}

/** Yerel biçimde ("1.234,56" ya da "1234.56") yazılmış metni sayıya çevirir. */
export function parseAmount(input: string | number | null | undefined): number {
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0
  if (!input) return 0
  const s = String(input).trim().replace(/[₺$€\s]/g, '')
  if (!s) return 0
  const hasComma = s.includes(',')
  const hasDot = s.includes('.')
  let normalized = s
  if (hasComma && hasDot) {
    // "1.234,56" → nokta binlik, virgül ondalık
    normalized = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '')
  } else if (hasComma) {
    normalized = s.replace(',', '.')
  }
  const n = Number(normalized)
  return Number.isFinite(n) ? n : 0
}

/** Girilen tutarı TRY'ye çevirir. */
export function toTRY(amount: number, fxRate: number | null | undefined): number {
  return Number(amount || 0) * Number(fxRate ?? 1)
}

export const DEFAULT_FX: Record<string, number> = {
  TRY: 1, USD: 0, EUR: 0, XAU: 0, GBP: 0,
}

/**
 * Yazarken binlik ayracı uygular: "432423" → "432.423", "1234,56" → "1.234,56".
 * Nokta binlik, virgül ondalık (TR biçimi). Yarım yazılmış metni bozmaz ki
 * kullanıcı yazmaya devam edebilsin.
 */
export function formatTRInput(raw: string): string {
  if (!raw) return ''
  const cleaned = raw.replace(/[^\d.,]/g, '')
  const commaAt = cleaned.indexOf(',')
  const intRaw = (commaAt >= 0 ? cleaned.slice(0, commaAt) : cleaned).replace(/\D/g, '')
  const decRaw = commaAt >= 0 ? cleaned.slice(commaAt + 1).replace(/\D/g, '') : null
  // Number'a çevirmeden grupla — çok uzun sayılarda hassasiyet kaybolmasın
  const grouped = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  if (decRaw === null) return grouped
  return `${grouped || '0'},${decRaw}`
}

/**
 * formatTRInput çıktısını sayıya çevirir. Burada nokta her zaman binlik
 * ayracıdır — parseAmount'un tahmin yürütmesine gerek kalmaz.
 */
export function parseTRInput(text: string): number {
  if (!text) return 0
  const [int, dec] = text.split(',')
  const n = Number(int.replace(/\./g, '') + (dec ? `.${dec}` : ''))
  return Number.isFinite(n) ? n : 0
}

/** Sayıyı düzenlenebilir TR metnine çevirir: 1234.5 → "1.234,5" */
export function toTRInput(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return ''
  return formatTRInput(String(value).replace('.', ','))
}
