import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { todayISO } from '../lib/calc'
import { addDay } from '../lib/nema'
import { runNemaAccrual } from '../lib/cash'
import {
  computeDailyReturns,
  type DailyInput,
  type DailyRow,
  type RawAction,
  type RawAsset,
  type RawDividend,
  type RawEntry,
  type RawIncome,
  type RawIpo,
  type RawPrice,
  type RawSnapPosition,
  type RawTrade,
} from '../lib/dailyReturn'

/**
 * Günlük kâr defterini kurar: ham satırları çeker, motoru çalıştırır.
 *
 * Kayıt tutmak yerine her seferinde defterden **türetilir** — fiyat geçmişi,
 * işlem defteri ve halka arz kayıtları zaten günlük çözünürlükte duruyor.
 * Böylece uygulamayı her gün açmasan da geçmiş eksiksiz çıkar, geriye dönük
 * bir düzeltme (yanlış girilmiş satış fiyatı gibi) o günün kârına anında
 * yansır. Kaydedilmiş bir kopya olsaydı ikisi birbirinden ayrı düşerdi.
 *
 * Aynı hook hem üst çubuktaki "bugün" rozetini hem Günlük Kâr sayfasını
 * besler; ikisi tanım gereği aynı sayıyı gösterir.
 */

/** Önceki kapanışı bulmak için aralığın öncesinden bu kadar gün fiyat çekilir */
const PRICE_PAD = 30
/** PostgREST tek istekte en fazla bu kadar satır döner */
const PAGE = 1000

export interface DailyReturnsData {
  /** Tarihe göre eskiden yeniye */
  rows: DailyRow[]
  byDate: Map<string, DailyRow>
  /** Bugünün satırı — bugün hiç hareket yoksa null */
  today: DailyRow | null
  /** Elimizdeki en taze fiyat günü */
  priceDate: string | null
  from: string
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

/** 1000 satır sınırını aşan tabloları sayfa sayfa okur */
async function fetchPaged<T>(
  build: (fromRow: number, toRow: number) => PromiseLike<{ data: unknown; error: unknown }>
): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; ; page++) {
    const { data, error } = await build(page * PAGE, page * PAGE + PAGE - 1)
    if (error) throw new Error((error as { message?: string }).message ?? String(error))
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

export function useDailyReturns(userId?: string | null, days = 90): DailyReturnsData {
  const [rows, setRows] = useState<DailyRow[]>([])
  const [priceDate, setPriceDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const today = todayISO()
  const from = addDay(today, -days)

  const load = useCallback(async () => {
    if (!userId) {
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      // Nema satırları bugüne kadar işlenmeden toplam eksik çıkar
      await runNemaAccrual(userId, today).catch(() => 0)

      const [tradeRes, ipoRes, entryRes, accRes, actionRes, nemaRes, divRes, posRes, assetRes] =
        await Promise.all([
          supabase
            .from('trades')
            .select('asset_id, side, quantity, unit_price, amount_try, trade_date, created_at')
            .eq('user_id', userId),
          supabase
            .from('ipos')
            .select('id, bist_code, lot_price, manual_price, trade_start_date, ipo_date, status')
            .eq('user_id', userId),
          supabase
            .from('ipo_entries')
            .select('ipo_id, account_id, allocated_lot, sold_lot, sold_price, sold_date, participated')
            .eq('user_id', userId),
          supabase.from('accounts').select('id, name').eq('user_id', userId),
          supabase
            .from('corporate_actions')
            .select('asset_id, action_date, ratio')
            .eq('user_id', userId),
          supabase
            .from('account_ledger')
            .select('date, amount')
            .eq('user_id', userId)
            .eq('kind', 'nema')
            .gte('date', from),
          supabase
            .from('dividends')
            .select('asset_id, pay_date, gross_amount, tax_amount')
            .eq('user_id', userId)
            .gte('pay_date', from),
          supabase
            .from('positions')
            .select('asset_id, quantity, snapshots:snapshot_id (snapshot_date)')
            .eq('user_id', userId),
          supabase.from('assets').select('id, symbol, kind'),
        ])

      const trades = (tradeRes.data ?? []) as RawTrade[]
      const ipos = (ipoRes.data ?? []) as RawIpo[]
      const entries = (entryRes.data ?? []) as RawEntry[]
      const accounts = (accRes.data ?? []) as { id: string; name: string }[]
      const actions = (actionRes.data ?? []) as RawAction[]
      const nema = (nemaRes.data ?? []) as RawIncome[]
      const dividends = (divRes.data ?? []) as RawDividend[]
      const assets = (assetRes.data ?? []) as RawAsset[]

      const snapshots: RawSnapPosition[] = []
      for (const p of (posRes.data ?? []) as {
        asset_id: string | null
        quantity: number | null
        snapshots: { snapshot_date: string } | { snapshot_date: string }[] | null
      }[]) {
        const snap = Array.isArray(p.snapshots) ? p.snapshots[0] : p.snapshots
        if (!p.asset_id || !snap?.snapshot_date) continue
        snapshots.push({
          snapshot_date: snap.snapshot_date,
          asset_id: p.asset_id,
          quantity: Number(p.quantity ?? 0),
        })
      }

      // Fiyat yalnızca ilgili kâğıtlar için çekilir — tüm tablo çok büyük
      const idBySymbol = new Map(assets.map((a) => [a.symbol.trim().toUpperCase(), a.id] as const))
      const ids = new Set<string>()
      for (const t of trades) if (t.asset_id) ids.add(t.asset_id)
      for (const s of snapshots) ids.add(s.asset_id)
      for (const d of dividends) if (d.asset_id) ids.add(d.asset_id)
      for (const i of ipos) {
        const id = idBySymbol.get(i.bist_code?.trim().toUpperCase() ?? '')
        if (id) ids.add(id)
      }

      let prices: RawPrice[] = []
      if (ids.size) {
        prices = await fetchPaged<RawPrice>((a, b) =>
          supabase
            .from('asset_prices')
            .select('asset_id, date, price')
            .in('asset_id', [...ids])
            .gte('date', addDay(from, -PRICE_PAD))
            .lte('date', today)
            .order('date', { ascending: true })
            .range(a, b)
        )
      }

      let newest: string | null = null
      for (const p of prices) if (!newest || p.date > newest) newest = p.date
      setPriceDate(newest)

      const input: DailyInput = {
        from,
        to: today,
        trades,
        prices,
        assets,
        actions,
        ipos,
        entries,
        accounts,
        snapshots,
        nema,
        dividends,
      }
      setRows(computeDailyReturns(input))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [userId, from, today])

  useEffect(() => {
    void load()
  }, [load])

  const byDate = useMemo(() => new Map(rows.map((r) => [r.date, r] as const)), [rows])

  return {
    rows,
    byDate,
    today: byDate.get(today) ?? null,
    priceDate,
    from,
    loading,
    error,
    reload: load,
  }
}
