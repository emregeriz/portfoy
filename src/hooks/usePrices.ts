import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

export interface LatestPrice {
  asset_id: string
  date: string
  price: number
  currency: string
  source: string | null
}

export interface FetchSummary {
  ok: boolean
  fx: number
  prices: number
  log: string[]
  errors: string[]
}

/** load()/refresh() dönüşü — state'i beklemeden hemen kullanılabilir. */
export interface PriceData {
  bySymbol: Map<string, LatestPrice>
  byAssetId: Map<string, LatestPrice>
  fx: Record<string, number>
}

/**
 * En son fiyatları ve kurları okur; `refresh()` ile fetch-prices Edge
 * Function'ını tetikleyip kaynaklardan yeniden çekilmesini sağlar.
 *
 * load() ve refresh() taze veriyi döndürür — çağıran, state'in yeniden
 * render edilmesini beklemeden sonucu kullanabilir.
 */
export function usePrices() {
  const [prices, setPrices] = useState<LatestPrice[]>([])
  const [symbolById, setSymbolById] = useState<Record<string, string>>({})
  const [fx, setFx] = useState<Record<string, number>>({ TRY: 1 })
  const [fxDate, setFxDate] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<PriceData> => {
    const [priceRes, fxRes, assetRes] = await Promise.all([
      supabase.from('v_latest_prices').select('*'),
      supabase.from('v_latest_fx').select('*'),
      supabase.from('assets').select('id, symbol'),
    ])

    const rows = (priceRes.data ?? []) as LatestPrice[]
    setPrices(rows)

    const rates: Record<string, number> = { TRY: 1 }
    let newest: string | null = null
    for (const r of (fxRes.data ?? []) as { currency: string; rate_try: number; date: string }[]) {
      rates[r.currency] = Number(r.rate_try)
      if (!newest || r.date > newest) newest = r.date
    }
    setFx(rates)
    setFxDate(newest)

    const map: Record<string, string> = {}
    for (const a of (assetRes.data ?? []) as { id: string; symbol: string }[]) {
      map[a.id] = a.symbol.toUpperCase()
    }
    setSymbolById(map)
    setLoading(false)

    const bySymbol = new Map<string, LatestPrice>()
    const byAssetId = new Map<string, LatestPrice>()
    for (const p of rows) {
      byAssetId.set(p.asset_id, p)
      const sym = map[p.asset_id]
      if (sym) bySymbol.set(sym, p)
    }
    return { bySymbol, byAssetId, fx: rates }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Edge Function'ı çalıştırıp fiyatları tazeler, taze veriyi döndürür. */
  const refresh = useCallback(async (): Promise<{ summary: FetchSummary; data: PriceData } | null> => {
    setRefreshing(true)
    setError(null)
    try {
      const { data, error: fnErr } = await supabase.functions.invoke('fetch-prices', { body: {} })
      if (fnErr) throw new Error(fnErr.message)
      const fresh = await load()
      return { summary: data as FetchSummary, data: fresh }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const byAssetId = useMemo(() => {
    const m = new Map<string, LatestPrice>()
    for (const p of prices) m.set(p.asset_id, p)
    return m
  }, [prices])

  const bySymbol = useMemo(() => {
    const m = new Map<string, LatestPrice>()
    for (const p of prices) {
      const sym = symbolById[p.asset_id]
      if (sym) m.set(sym, p)
    }
    return m
  }, [prices, symbolById])

  /** Elimizdeki en taze fiyat tarihi — "en son ne zaman güncellendi" göstergesi. */
  const latestDate = useMemo(() => {
    let d: string | null = fxDate
    for (const p of prices) if (!d || p.date > d) d = p.date
    return d
  }, [prices, fxDate])

  return { prices, byAssetId, bySymbol, fx, fxDate, latestDate, loading, refreshing, error, refresh, reload: load }
}
