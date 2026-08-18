import { parseISO, startOfWeek, startOfMonth, startOfYear, isAfter, subMonths, subYears } from 'date-fns'
import type { NetWorthRow, PositionWithRefs, AssetKind } from '../types/db'

export type Period = 'haftalik' | 'aylik' | 'yillik' | 'tumu'

export const PERIOD_LABELS: Record<Period, string> = {
  haftalik: 'Haftalık',
  aylik: 'Aylık',
  yillik: 'Yıllık',
  tumu: 'Tümü',
}

export interface Change {
  absolute: number
  percent: number | null
}

export function change(current: number, previous: number | null | undefined): Change {
  if (previous === null || previous === undefined) return { absolute: 0, percent: null }
  const absolute = current - previous
  const percent = previous === 0 ? null : (absolute / Math.abs(previous)) * 100
  return { absolute, percent }
}

/**
 * Net değer serisini periyoda göre gruplar.
 * haftalik → her haftanın son snapshot'ı, aylik → her ayın sonu, vb.
 * "tumu" ham seriyi döner.
 */
export function bucketSeries(rows: NetWorthRow[], period: Period): NetWorthRow[] {
  const sorted = [...rows].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
  if (period === 'tumu') return sorted

  const keyOf = (d: Date) => {
    if (period === 'haftalik') return startOfWeek(d, { weekStartsOn: 1 }).toISOString().slice(0, 10)
    if (period === 'aylik') return startOfMonth(d).toISOString().slice(0, 10)
    return startOfYear(d).toISOString().slice(0, 10)
  }

  const map = new Map<string, NetWorthRow>()
  for (const row of sorted) {
    map.set(keyOf(parseISO(row.snapshot_date)), row) // sıralı olduğu için son kazanır
  }
  return [...map.values()].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
}

/** Periyoda göre görüntülenecek zaman aralığını kısıtlar. */
export function limitByPeriod(rows: NetWorthRow[], period: Period): NetWorthRow[] {
  if (period === 'tumu') return rows
  const now = new Date()
  const from =
    period === 'haftalik' ? subMonths(now, 6) : period === 'aylik' ? subYears(now, 2) : subYears(now, 10)
  return rows.filter((r) => isAfter(parseISO(r.snapshot_date), from))
}

/** Birden fazla kullanıcının serisini tarihe göre toplar. */
export function sumSeriesByDate(rows: NetWorthRow[]): NetWorthRow[] {
  const map = new Map<string, NetWorthRow>()
  for (const r of rows) {
    const existing = map.get(r.snapshot_date)
    if (existing) {
      existing.total_assets_try += Number(r.total_assets_try)
      existing.total_liabilities_try += Number(r.total_liabilities_try)
      existing.net_worth_try += Number(r.net_worth_try)
    } else {
      map.set(r.snapshot_date, {
        ...r,
        user_id: 'toplam',
        snapshot_id: r.snapshot_date,
        total_assets_try: Number(r.total_assets_try),
        total_liabilities_try: Number(r.total_liabilities_try),
        net_worth_try: Number(r.net_worth_try),
      })
    }
  }
  return [...map.values()].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date))
}

export const KIND_LABELS: Record<AssetKind, string> = {
  hisse: 'Hisse',
  fon: 'Fon',
  doviz: 'Döviz',
  altin: 'Altın',
  mevduat: 'Mevduat/Nakit',
  kripto: 'Kripto',
  diger: 'Diğer',
}

export interface Slice {
  key: string
  label: string
  value: number
}

/** Varlık türüne göre dağılım (pie). */
export function allocationByKind(positions: PositionWithRefs[]): Slice[] {
  const map = new Map<string, number>()
  for (const p of positions) {
    const kind = (p.assets?.kind ?? 'diger') as AssetKind
    map.set(kind, (map.get(kind) ?? 0) + Number(p.amount_try ?? 0))
  }
  return [...map.entries()]
    .map(([key, value]) => ({ key, label: KIND_LABELS[key as AssetKind] ?? key, value }))
    .filter((s) => s.value !== 0)
    .sort((a, b) => b.value - a.value)
}

/** Hesap bazlı dağılım (bar). */
export function allocationByAccount(positions: PositionWithRefs[]): Slice[] {
  const map = new Map<string, number>()
  for (const p of positions) {
    const name = p.accounts?.name ?? 'Belirtilmemiş'
    map.set(name, (map.get(name) ?? 0) + Number(p.amount_try ?? 0))
  }
  return [...map.entries()]
    .map(([key, value]) => ({ key, label: key, value }))
    .filter((s) => s.value !== 0)
    .sort((a, b) => b.value - a.value)
}

export const CHART_COLORS = [
  '#4f8cff', '#22c55e', '#f59e0b', '#a855f7',
  '#06b6d4', '#ef4444', '#eab308', '#14b8a6',
  '#f472b6', '#94a3b8',
]

export function colorAt(i: number): string {
  return CHART_COLORS[i % CHART_COLORS.length]
}

export function todayISO(): string {
  const d = new Date()
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}
