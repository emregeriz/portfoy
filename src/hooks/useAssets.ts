import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { Asset, AssetKind } from '../types/db'

export function useAssets() {
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const { data } = await supabase.from('assets').select('*').order('symbol')
    setAssets((data ?? []) as Asset[])
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Sembolü olan varlığı bulur, yoksa oluşturur. */
  const ensureAsset = useCallback(
    async (symbol: string, kind: AssetKind, userId: string, name?: string) => {
      const clean = symbol.trim().toUpperCase()
      if (!clean) return null
      const existing = assets.find((a) => a.symbol.toUpperCase() === clean)
      if (existing) return existing
      const { data, error } = await supabase
        .from('assets')
        .insert({ symbol: clean, kind, name: name ?? clean, user_id: userId })
        .select()
        .single()
      if (error) throw new Error(error.message)
      const created = data as Asset
      setAssets((prev) => [...prev, created].sort((a, b) => a.symbol.localeCompare(b.symbol)))
      return created
    },
    [assets]
  )

  return { assets, loading, reload: load, ensureAsset }
}
